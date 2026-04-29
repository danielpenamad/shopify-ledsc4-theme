#!/usr/bin/env node
// Idempotent backfill of product.catalogo = "Otros" for the LedsC4 B2B outlet.
//
// What it does:
//   For every product with tag "Coleccion:2026", set product.catalogo = "Otros"
//   when its current value is in {missing, "Ecommerce", "Emergency"}.
//   Skips anything already set to "Otros" or to one of the 5 main catalogs
//   (Forlight, Architectural, Decorative, Outdoor, DIY).
//
// Why:
//   Smart collection navigation buckets {missing, Ecommerce, Emergency} into
//   a single category called "Otros". Smart collection rules can't OR three
//   disjoint conditions while AND-ing the Coleccion:2026 tag, so we
//   normalize the metafield value instead of inventing tags.
//
// When to re-run:
//   Whenever new products land in the outlet (tag Coleccion:2026 added) or
//   any product loses its catalogo. The script is idempotent and safe to
//   run from cron / on every restock.
//
// Output:
//   reports/backfill-otros-<timestamp>.json — full backup of previous values
//   for every mutated product. Reversible via metafieldsSet with that file.
//
// Usage:
//   SHOPIFY_STORE_DOMAIN=... SHOPIFY_ADMIN_TOKEN=... \
//   node scripts/backfill-otros-catalogo.mjs [--dry-run]

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gql, requireEnv, chunk } from './_shopify.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
if (!DRY_RUN) requireEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = resolve(__dirname, '..', 'reports');

const TAG = 'Coleccion:2026';
const KEEP = new Set(['Forlight', 'Architectural', 'Decorative', 'Outdoor', 'DIY', 'Otros']);
const TARGET = 'Otros';
const NAMESPACE = 'product';
const KEY = 'catalogo';

async function fetchOutletProducts() {
  const out = [];
  let cursor = null;
  while (true) {
    const q = `query($after: String) {
      products(first: 100, after: $after, query: "tag:${TAG}") {
        edges {
          cursor
          node {
            id title handle
            mf: metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    const data = await gql(q, { after: cursor }, { requestedCost: 200 });
    for (const e of data.products.edges) out.push(e.node);
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  return out;
}

async function metafieldsSetBatch(items) {
  // items: [{ ownerId, value }]
  const m = `mutation($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key namespace ownerType }
      userErrors { field message code }
    }
  }`;
  const metafields = items.map((it) => ({
    ownerId: it.ownerId,
    namespace: NAMESPACE,
    key: KEY,
    type: 'single_line_text_field',
    value: it.value,
  }));
  const data = await gql(m, { metafields }, { requestedCost: 100 });
  const errs = data.metafieldsSet.userErrors ?? [];
  if (errs.length) throw new Error(`metafieldsSet: ${JSON.stringify(errs)}`);
  return data.metafieldsSet.metafields;
}

async function main() {
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Backfill product.catalogo = "${TARGET}" for tag "${TAG}"`);
  const products = await fetchOutletProducts();
  console.log(`Fetched ${products.length} products with tag ${TAG}`);

  const toUpdate = [];
  const counters = { missing: 0, ecommerce: 0, emergency: 0, alreadyOtros: 0, mainCat: 0, other: 0 };
  for (const p of products) {
    const cur = p.mf?.value ?? null;
    if (cur === 'Otros') { counters.alreadyOtros++; continue; }
    if (cur === 'Ecommerce') { counters.ecommerce++; toUpdate.push({ ownerId: p.id, prev: cur, handle: p.handle }); continue; }
    if (cur === 'Emergency') { counters.emergency++; toUpdate.push({ ownerId: p.id, prev: cur, handle: p.handle }); continue; }
    if (cur === null) { counters.missing++; toUpdate.push({ ownerId: p.id, prev: cur, handle: p.handle }); continue; }
    if (KEEP.has(cur)) { counters.mainCat++; continue; }
    counters.other++;
    console.warn(`[warn] unexpected catalogo value on ${p.handle}: "${cur}" — skipping`);
  }

  console.log(`\nClassification (${products.length} total):`);
  for (const [k, v] of Object.entries(counters)) console.log(`  ${k.padEnd(15)} ${v}`);
  console.log(`\nWill set catalogo="Otros" on ${toUpdate.length} product(s)`);

  if (toUpdate.length === 0) {
    console.log('Nothing to do. Exit clean.');
    return;
  }

  // Always write backup (even on dry-run) so user can compare.
  await mkdir(REPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = resolve(REPORTS_DIR, `backfill-otros-${ts}.json`);
  await writeFile(backupPath, JSON.stringify({ runAt: new Date().toISOString(), namespace: NAMESPACE, key: KEY, target: TARGET, items: toUpdate }, null, 2));
  console.log(`Backup written: ${backupPath}`);

  if (DRY_RUN) {
    console.log('\n[dry-run] No mutations executed.');
    return;
  }

  const batches = chunk(toUpdate, 25);
  let done = 0;
  for (const batch of batches) {
    const items = batch.map((it) => ({ ownerId: it.ownerId, value: TARGET }));
    await metafieldsSetBatch(items);
    done += batch.length;
    console.log(`  applied ${done}/${toUpdate.length}`);
  }
  console.log(`\nDone. ${done} product(s) updated. Backup at ${backupPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
