#!/usr/bin/env node
// Crea/actualiza las páginas B2B del storefront (gate Fase C) en Shopify.
//
// Páginas gestionadas (ver scripts/pages-manifest.json):
//   - cuenta-en-revision    (template: b2b-cuenta-en-revision)
//   - cuenta-rechazada      (template: b2b-cuenta-rechazada)
//   - aviso-legal
//   - politica-de-privacidad
//   - condiciones-de-uso
//   - canal-de-denuncias
//
// Usage:
//   SHOPIFY_STORE_DOMAIN=ledsc4-b2b-outlet.myshopify.com \
//   SHOPIFY_ADMIN_TOKEN=shpat_xxx \
//   node scripts/create-b2b-pages.mjs [--dry-run]
//
// Idempotente: si la page con ese handle ya existe, hace update. Si no,
// create. REST Admin API (pageCreate GraphQL no existía en 2025-10).

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const MANIFEST_PATH = resolve(__dirname, 'pages-manifest.json');

const API_VERSION = process.env.SHOPIFY_API_VERSION ?? '2025-10';
const DRY_RUN = process.argv.includes('--dry-run');
const { SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN } = process.env;

if (!DRY_RUN && (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN)) {
  console.error('Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars.');
  process.exit(1);
}

const baseUrl = SHOPIFY_STORE_DOMAIN
  ? `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}`
  : null;

async function rest(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function findPageByHandle(handle) {
  const res = await rest('GET', `/pages.json?handle=${encodeURIComponent(handle)}&limit=1`);
  const page = res?.pages?.[0];
  return page ?? null;
}

async function upsertPage(spec) {
  const title = spec.title;
  const handle = spec.handle;
  const body = spec.body_file
    ? await readFile(resolve(REPO_ROOT, spec.body_file), 'utf8')
    : (spec.body_html ?? '');
  const template_suffix = spec.template_suffix ?? null;
  const published = spec.published !== false;

  if (DRY_RUN) {
    console.log(`[dry-run] upsert page: ${handle} (title="${title}", template_suffix=${template_suffix ?? 'default'}, body=${body.length} chars)`);
    return { status: 'dry-run', handle };
  }

  const existing = await findPageByHandle(handle);

  const payload = {
    page: {
      title,
      handle,
      body_html: body,
      template_suffix,
      published,
    },
  };

  if (existing) {
    // Check if any meaningful change. If same, skip.
    const same =
      existing.title === title &&
      (existing.body_html ?? '') === body &&
      (existing.template_suffix ?? null) === template_suffix;
    if (same) {
      console.log(`[skip] page unchanged: ${handle} (id=${existing.id})`);
      return { status: 'unchanged', handle, id: existing.id };
    }
    const updated = await rest('PUT', `/pages/${existing.id}.json`, payload);
    console.log(`[updated] ${handle} (id=${updated.page.id})`);
    return { status: 'updated', handle, id: updated.page.id };
  }

  const created = await rest('POST', '/pages.json', payload);
  console.log(`[created] ${handle} (id=${created.page.id})`);
  return { status: 'created', handle, id: created.page.id };
}

async function main() {
  const target = SHOPIFY_STORE_DOMAIN ?? '(not set — dry run)';
  const manifestRaw = await readFile(MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(manifestRaw);

  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Upserting ${manifest.length} page(s) on ${target}`);

  const results = [];
  for (const spec of manifest) {
    try {
      const r = await upsertPage(spec);
      results.push(r);
    } catch (e) {
      console.error(`[error] ${spec.handle}: ${e.message}`);
      results.push({ status: 'error', handle: spec.handle, error: e.message });
    }
  }

  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`\nSummary:`, counts);
  process.exit(results.some((r) => r.status === 'error') ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
