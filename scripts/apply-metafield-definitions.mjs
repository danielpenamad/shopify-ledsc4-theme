#!/usr/bin/env node
// Idempotent metafield definition creator for the LedsC4 B2B project.
//
// Usage:
//   SHOPIFY_STORE_DOMAIN=ledsc4-b2b-outlet.myshopify.com \
//   SHOPIFY_ADMIN_TOKEN=shpat_xxx \
//   node scripts/apply-metafield-definitions.mjs [--dry-run]
//
// Reads scripts/metafield-definitions.json and calls
// metafieldDefinitionCreate for each entry. Definitions that already exist
// (userErrors.code === "TAKEN") are skipped — the script is safe to re-run.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, 'metafield-definitions.json');
const API_VERSION = process.env.SHOPIFY_API_VERSION ?? '2025-10';
const DRY_RUN = process.argv.includes('--dry-run');

const { SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN } = process.env;

if (!DRY_RUN && (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN)) {
  console.error('Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars.');
  console.error('Either set them or run with --dry-run to preview.');
  process.exit(1);
}

const endpoint = SHOPIFY_STORE_DOMAIN
  ? `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`
  : null;

const CREATE_MUTATION = `
  mutation metafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id namespace key name ownerType }
      userErrors { field message code }
    }
  }
`;

const PIN_MUTATION = `
  mutation metafieldDefinitionPin($id: ID!) {
    metafieldDefinitionPin(definitionId: $id) {
      pinnedDefinition { id }
      userErrors { field message code }
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

async function applyDefinition(def) {
  const input = {
    ownerType: def.ownerType,
    namespace: def.namespace,
    key: def.key,
    name: def.name,
    description: def.description,
    type: def.type,
    access: def.access,
  };

  if (DRY_RUN) {
    console.log(`[dry-run] create ${def.ownerType} ${def.namespace}.${def.key} (${def.type})${def.pin ? ' [pinned]' : ''}`);
    return { status: 'dry-run' };
  }

  const data = await gql(CREATE_MUTATION, { definition: input });
  const errors = data.metafieldDefinitionCreate.userErrors ?? [];
  const taken = errors.find((e) => e.code === 'TAKEN');

  if (taken) {
    console.log(`[skip] already exists: ${def.namespace}.${def.key}`);
    return { status: 'exists' };
  }

  if (errors.length > 0) {
    console.error(`[error] ${def.namespace}.${def.key}:`, errors);
    return { status: 'error', errors };
  }

  const created = data.metafieldDefinitionCreate.createdDefinition;
  console.log(`[ok] created: ${def.namespace}.${def.key} (${created.id})`);

  if (def.pin && created?.id) {
    const pinData = await gql(PIN_MUTATION, { id: created.id });
    const pinErrors = pinData.metafieldDefinitionPin.userErrors ?? [];
    const benignCodes = new Set(['TAKEN', 'PINNED_LIMIT_REACHED']);
    const nonBenign = pinErrors.filter((e) => !benignCodes.has(e.code));
    if (nonBenign.length > 0) {
      console.warn(`[warn] pin failed for ${def.namespace}.${def.key}:`, nonBenign);
    }
  }

  return { status: 'created', id: created?.id };
}

async function main() {
  const raw = await readFile(CONFIG_PATH, 'utf8');
  const definitions = JSON.parse(raw);

  const target = SHOPIFY_STORE_DOMAIN ?? '(not set — dry run)';
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Applying ${definitions.length} metafield definitions to ${target}`);

  const results = [];
  for (const def of definitions) {
    try {
      const r = await applyDefinition(def);
      results.push({ def, ...r });
    } catch (err) {
      console.error(`[error] ${def.namespace}.${def.key}:`, err.message);
      results.push({ def, status: 'error', error: err.message });
    }
  }

  const created = results.filter((r) => r.status === 'created').length;
  const existed = results.filter((r) => r.status === 'exists').length;
  const failed = results.filter((r) => r.status === 'error').length;
  const dry = results.filter((r) => r.status === 'dry-run').length;

  console.log(`\nSummary: created=${created} existed=${existed} failed=${failed} dryRun=${dry}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
