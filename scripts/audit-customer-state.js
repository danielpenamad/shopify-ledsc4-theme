#!/usr/bin/env node
// Audits B2B customer state invariants and writes a CSV report.
//
// Flags three conditions (per LedsC4 data model):
//   1. no_state_tag            — missing one of pendiente | aprobado | rechazado
//   2. multiple_state_tags     — two or more state tags (HARD error, exits non-zero)
//   3. approved_without_company — tagged "aprobado" but not linked to any Company
//
// Usage:
//   SHOPIFY_STORE_DOMAIN=ledsc4-b2b-outlet.myshopify.com \
//   SHOPIFY_ADMIN_TOKEN=shpat_xxx \
//   node scripts/audit-customer-state.js

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = resolve(__dirname, '..', 'reports');
const API_VERSION = process.env.SHOPIFY_API_VERSION ?? '2025-10';
const { SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN } = process.env;

const STATE_TAGS = new Set(['pendiente', 'aprobado', 'rechazado']);

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
  console.error('Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars.');
  process.exit(1);
}

const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

const QUERY = `
  query customersPage($cursor: String) {
    customers(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          email
          tags
          companyContactProfiles { id company { id name } }
        }
      }
    }
  }
`;

async function gql(query, variables) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${body}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

function classify(customer) {
  const stateTags = (customer.tags ?? []).filter((t) => STATE_TAGS.has(t));
  const hasCompany = (customer.companyContactProfiles ?? []).length > 0;
  const issues = [];

  if (stateTags.length === 0) issues.push('no_state_tag');
  if (stateTags.length > 1) issues.push('multiple_state_tags');
  if (stateTags.includes('aprobado') && !hasCompany) issues.push('approved_without_company');

  return { stateTags, hasCompany, issues };
}

function csvEscape(value) {
  const s = String(value ?? '');
  return `"${s.replace(/"/g, '""')}"`;
}

async function main() {
  await mkdir(REPORTS_DIR, { recursive: true });

  console.log(`Auditing customers on ${SHOPIFY_STORE_DOMAIN}...`);

  let cursor = null;
  let total = 0;
  const rows = [];

  do {
    const data = await gql(QUERY, { cursor });
    const page = data.customers;
    for (const { node } of page.edges) {
      total++;
      const { stateTags, hasCompany, issues } = classify(node);
      if (issues.length > 0) {
        rows.push({
          id: node.id,
          email: node.email ?? '',
          stateTags: stateTags.join('|'),
          hasCompany,
          issues: issues.join(','),
        });
      }
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  console.log(`\nChecked ${total} customers. Issues: ${rows.length}`);
  if (rows.length > 0) console.table(rows);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const csvPath = resolve(REPORTS_DIR, `customer-state-audit-${ts}.csv`);
  const header = 'id,email,stateTags,hasCompany,issues\n';
  const body = rows
    .map((r) => [r.id, r.email, r.stateTags, r.hasCompany, r.issues].map(csvEscape).join(','))
    .join('\n');
  await writeFile(csvPath, header + body + (rows.length ? '\n' : ''));
  console.log(`CSV report: ${csvPath}`);

  const hardError = rows.some((r) => r.issues.includes('multiple_state_tags'));
  process.exit(hardError ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
