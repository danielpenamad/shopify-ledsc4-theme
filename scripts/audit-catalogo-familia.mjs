#!/usr/bin/env node
// Discovery script: ¿dónde viven "Catálogo" y "Familia" en cada producto
// del outlet (tag:"Coleccion:2026")? Read-only.
//
// Probes en este orden:
//   1. productType (campo nativo)
//   2. vendor (campo nativo)
//   3. Tags con prefijos comunes (Catalogo:, Catalog:, Catálogo:, Familia:,
//      Family:, Família:)
//   4. Metafields con key "catalog"/"catalogo"/"catálogo"/"familia"/"family"
//      (en cualquier namespace) — pulled via metafields(first: 50) y
//      filtered en cliente.
//
// Output:
//   - Console: tabla de fuentes con #productos y #valores únicos
//   - reports/audit-catalogo-familia-<ts>.json: dump completo por SKU
//   - reports/audit-catalogo-familia-<ts>-summary.json: agregados
//
// Usage:
//   SHOPIFY_STORE_DOMAIN=ledsc4-b2b-outlet.myshopify.com \
//   SHOPIFY_ADMIN_TOKEN=shpat_xxx \
//   node scripts/audit-catalogo-familia.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gql, requireEnv } from './_shopify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = resolve(__dirname, '..', 'reports');
const COLLECTION_TAG = 'Coleccion:2026';

requireEnv();

const TAG_CAT_PREFIXES = ['catalogo:', 'catálogo:', 'catalog:'];
const TAG_FAM_PREFIXES = ['familia:', 'família:', 'family:'];
const MF_KEY_CAT = ['catalog', 'catalogo', 'catálogo'];
const MF_KEY_FAM = ['familia', 'família', 'family'];

function lowerStartsAny(s, prefixes) {
  const l = s.toLowerCase();
  return prefixes.some((p) => l.startsWith(p));
}
function keyMatches(key, list) {
  const l = key.toLowerCase();
  return list.includes(l);
}

async function* iterProducts() {
  const q = `query($cursor: String) {
    products(first: 50, after: $cursor, query: "tag:\\"${COLLECTION_TAG}\\"") {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id handle title productType vendor tags
          metafields(first: 50) {
            edges { node { namespace key value type } }
          }
        }
      }
    }
  }`;
  let cursor = null;
  do {
    const data = await gql(q, { cursor }, { requestedCost: 350 });
    for (const { node } of data.products.edges) yield node;
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
}

function bump(map, k) { map.set(k, (map.get(k) ?? 0) + 1); }

async function main() {
  console.log(`Probing source of "Catálogo" + "Familia" on tag:"${COLLECTION_TAG}" — ${process.env.SHOPIFY_STORE_DOMAIN}\n`);
  await mkdir(REPORTS_DIR, { recursive: true });

  const productTypeVals = new Map();
  const vendorVals = new Map();
  const tagCatVals = new Map(); // {tag-prefix-stripped value -> count}
  const tagFamVals = new Map();
  const mfCatKeyToVals = new Map(); // {namespace.key -> Map(value->count)}
  const mfFamKeyToVals = new Map();

  let total = 0;
  let withProductType = 0, withVendor = 0;
  let withTagCat = 0, withTagFam = 0, withMfCat = 0, withMfFam = 0;

  const perSku = [];

  for await (const p of iterProducts()) {
    total++;
    const row = { id: p.id, handle: p.handle, sku: null, productType: p.productType ?? '', vendor: p.vendor ?? '', tagCat: [], tagFam: [], mfCat: [], mfFam: [] };

    if (p.productType) { withProductType++; bump(productTypeVals, p.productType); }
    if (p.vendor) { withVendor++; bump(vendorVals, p.vendor); }

    for (const t of p.tags ?? []) {
      if (lowerStartsAny(t, TAG_CAT_PREFIXES)) {
        const v = t.split(':').slice(1).join(':').trim();
        bump(tagCatVals, v); row.tagCat.push(t);
      }
      if (lowerStartsAny(t, TAG_FAM_PREFIXES)) {
        const v = t.split(':').slice(1).join(':').trim();
        bump(tagFamVals, v); row.tagFam.push(t);
      }
    }
    if (row.tagCat.length) withTagCat++;
    if (row.tagFam.length) withTagFam++;

    for (const { node: mf } of p.metafields?.edges ?? []) {
      const fqk = `${mf.namespace}.${mf.key}`;
      if (keyMatches(mf.key, MF_KEY_CAT)) {
        const m = mfCatKeyToVals.get(fqk) ?? new Map();
        bump(m, mf.value);
        mfCatKeyToVals.set(fqk, m);
        row.mfCat.push({ key: fqk, value: mf.value });
      }
      if (keyMatches(mf.key, MF_KEY_FAM)) {
        const m = mfFamKeyToVals.get(fqk) ?? new Map();
        bump(m, mf.value);
        mfFamKeyToVals.set(fqk, m);
        row.mfFam.push({ key: fqk, value: mf.value });
      }
    }
    if (row.mfCat.length) withMfCat++;
    if (row.mfFam.length) withMfFam++;
    perSku.push(row);
  }

  function topN(m, n = 15) {
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  const summary = {
    storeDomain: process.env.SHOPIFY_STORE_DOMAIN,
    runAt: new Date().toISOString(),
    totalProducts: total,
    sources: {
      productType: { coverage: withProductType, percent: total ? +(100 * withProductType / total).toFixed(1) : 0, uniqueValues: productTypeVals.size, top: topN(productTypeVals) },
      vendor: { coverage: withVendor, percent: total ? +(100 * withVendor / total).toFixed(1) : 0, uniqueValues: vendorVals.size, top: topN(vendorVals) },
      tagCatalog: { coverage: withTagCat, percent: total ? +(100 * withTagCat / total).toFixed(1) : 0, uniqueValues: tagCatVals.size, top: topN(tagCatVals) },
      tagFamilia: { coverage: withTagFam, percent: total ? +(100 * withTagFam / total).toFixed(1) : 0, uniqueValues: tagFamVals.size, top: topN(tagFamVals) },
      metafieldCatalogByKey: Object.fromEntries(
        [...mfCatKeyToVals.entries()].map(([k, m]) => [k, { coverage: [...m.values()].reduce((a, b) => a + b, 0), uniqueValues: m.size, top: topN(m) }])
      ),
      metafieldFamiliaByKey: Object.fromEntries(
        [...mfFamKeyToVals.entries()].map(([k, m]) => [k, { coverage: [...m.values()].reduce((a, b) => a + b, 0), uniqueValues: m.size, top: topN(m) }])
      ),
    },
  };

  console.log(`Total products with tag "${COLLECTION_TAG}": ${total}\n`);
  console.log(`Source           Coverage    Unique  Top values`);
  console.log(`---------------  ----------  ------  -----------`);
  const printSrc = (label, s) => {
    if (!s.uniqueValues) {
      console.log(`${label.padEnd(15)}  ${('0/' + total).padEnd(10)}  ${'0'.padEnd(6)}  (no data)`);
      return;
    }
    const top = s.top.slice(0, 5).map(([k, v]) => `${k}(${v})`).join(', ');
    console.log(`${label.padEnd(15)}  ${(s.coverage + '/' + total + ' ' + s.percent + '%').padEnd(10)}  ${String(s.uniqueValues).padEnd(6)}  ${top}`);
  };
  printSrc('productType', summary.sources.productType);
  printSrc('vendor', summary.sources.vendor);
  printSrc('tag Catalogo:*', summary.sources.tagCatalog);
  printSrc('tag Familia:*', summary.sources.tagFamilia);
  for (const [k, v] of Object.entries(summary.sources.metafieldCatalogByKey)) {
    printSrc(`mf ${k}`, { ...v, percent: total ? +(100 * v.coverage / total).toFixed(1) : 0 });
  }
  for (const [k, v] of Object.entries(summary.sources.metafieldFamiliaByKey)) {
    printSrc(`mf ${k}`, { ...v, percent: total ? +(100 * v.coverage / total).toFixed(1) : 0 });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const sumPath = resolve(REPORTS_DIR, `audit-catalogo-familia-${ts}-summary.json`);
  const detailPath = resolve(REPORTS_DIR, `audit-catalogo-familia-${ts}.json`);
  await writeFile(sumPath, JSON.stringify(summary, null, 2));
  await writeFile(detailPath, JSON.stringify(perSku, null, 2));
  console.log(`\nSummary: ${sumPath}`);
  console.log(`Per-SKU dump: ${detailPath}`);

  // Decision hint
  console.log(`\nDecision:`);
  function pick(label, candidates) {
    const win = candidates
      .filter((c) => c.coverage > 0)
      .sort((a, b) => b.coverage - a.coverage)[0];
    if (!win) {
      console.log(`  ${label}: NO source found above coverage threshold. Field probably not loaded into Shopify yet.`);
      return null;
    }
    console.log(`  ${label}: ${win.source} (coverage ${win.coverage}/${total}, ${win.uniqueValues} unique values)`);
    return win;
  }
  pick('Catálogo', [
    { source: 'productType', ...summary.sources.productType },
    { source: 'vendor', ...summary.sources.vendor },
    { source: 'tag Catalogo:*', ...summary.sources.tagCatalog },
    ...Object.entries(summary.sources.metafieldCatalogByKey).map(([k, v]) => ({ source: `metafield ${k}`, ...v })),
  ]);
  pick('Familia', [
    { source: 'tag Familia:*', ...summary.sources.tagFamilia },
    ...Object.entries(summary.sources.metafieldFamiliaByKey).map(([k, v]) => ({ source: `metafield ${k}`, ...v })),
  ]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
