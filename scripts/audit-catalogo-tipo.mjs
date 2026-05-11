#!/usr/bin/env node
// Read-only audit: cobertura y crosstab de product.catalogo × product.tipo
// para los productos con tag "Coleccion:2026" (el outlet B2B).
//
// Reporta:
//   1. Valores únicos de product.catalogo con conteo (lista completa)
//   2. Cobertura + valores únicos de product.tipo con conteo (lista completa)
//   3. Crosstab catalogo × tipo, marcando combinaciones con >= MIN_SUBNIVEL
//      como candidatas a subcoleccion
//   4. Productos sin product.catalogo y/o sin product.tipo (lista de SKUs)
//
// Output:
//   - Console: tablas legibles
//   - reports/audit-catalogo-tipo-<ts>.json: dump completo
//
// Usage:
//   SHOPIFY_STORE_DOMAIN=ledsc4-b2b-outlet.myshopify.com \
//   SHOPIFY_ADMIN_TOKEN=shpat_xxx \
//   node scripts/audit-catalogo-tipo.mjs
//
//   o:  node --env-file=shopify-ledsc4-theme.env scripts/audit-catalogo-tipo.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gql, requireEnv } from './_shopify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = resolve(__dirname, '..', 'reports');
const COLLECTION_TAG = 'Coleccion:2026';
const MIN_SUBNIVEL = 3;

requireEnv();

async function* iterProducts() {
  const q = `query($cursor: String) {
    products(first: 100, after: $cursor, query: "tag:\\"${COLLECTION_TAG}\\"") {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id handle title
          variants(first: 1) { edges { node { sku } } }
          catalogo: metafield(namespace: "product", key: "catalogo") { value }
          tipo: metafield(namespace: "product", key: "tipo") { value }
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

function bump(map, key) { map.set(key, (map.get(key) ?? 0) + 1); }
function sortedEntries(map) { return [...map.entries()].sort((a, b) => b[1] - a[1]); }

async function main() {
  console.log(`Auditing product.catalogo × product.tipo for tag:"${COLLECTION_TAG}" — ${process.env.SHOPIFY_STORE_DOMAIN}\n`);
  await mkdir(REPORTS_DIR, { recursive: true });

  const catalogoVals = new Map(); // catalogo -> count
  const tipoVals = new Map();     // tipo -> count
  const crosstab = new Map();     // catalogo -> Map(tipo -> count)
  const missingCatalogo = [];
  const missingTipo = [];
  const missingBoth = [];
  const perSku = [];

  let total = 0;
  let withCatalogo = 0;
  let withTipo = 0;

  for await (const p of iterProducts()) {
    total++;
    const sku = p.variants?.edges?.[0]?.node?.sku ?? null;
    const cat = p.catalogo?.value ?? null;
    const tipo = p.tipo?.value ?? null;
    const row = { id: p.id, handle: p.handle, title: p.title, sku, catalogo: cat, tipo };
    perSku.push(row);

    if (cat) { withCatalogo++; bump(catalogoVals, cat); }
    if (tipo) { withTipo++; bump(tipoVals, tipo); }

    if (cat && tipo) {
      if (!crosstab.has(cat)) crosstab.set(cat, new Map());
      bump(crosstab.get(cat), tipo);
    }

    if (!cat && !tipo) missingBoth.push(row);
    else if (!cat) missingCatalogo.push(row);
    else if (!tipo) missingTipo.push(row);
  }

  // ── Section 1: product.catalogo
  const pct = (n) => (total ? (100 * n / total).toFixed(1) : '0');
  console.log(`Total products with tag "${COLLECTION_TAG}": ${total}\n`);
  console.log(`── product.catalogo (cobertura ${withCatalogo}/${total} = ${pct(withCatalogo)}%, valores únicos = ${catalogoVals.size}) ──`);
  for (const [v, n] of sortedEntries(catalogoVals)) {
    console.log(`  ${String(n).padStart(4)}  ${v}`);
  }

  // ── Section 2: product.tipo
  console.log(`\n── product.tipo (cobertura ${withTipo}/${total} = ${pct(withTipo)}%, valores únicos = ${tipoVals.size}) ──`);
  for (const [v, n] of sortedEntries(tipoVals)) {
    console.log(`  ${String(n).padStart(4)}  ${v}`);
  }

  // ── Section 3: crosstab
  console.log(`\n── Crosstab catalogo × tipo (▶ marca subcoleccion: count >= ${MIN_SUBNIVEL}) ──`);
  const crossEntries = [...crosstab.entries()].sort((a, b) => {
    const sumA = [...a[1].values()].reduce((x, y) => x + y, 0);
    const sumB = [...b[1].values()].reduce((x, y) => x + y, 0);
    return sumB - sumA;
  });
  const crossJson = {};
  for (const [cat, subs] of crossEntries) {
    const subsSorted = sortedEntries(subs);
    const catTotal = subsSorted.reduce((a, [, n]) => a + n, 0);
    console.log(`\n  ${cat}  (total ${catTotal})`);
    crossJson[cat] = { total: catTotal, byTipo: {} };
    for (const [tipo, n] of subsSorted) {
      const flag = n >= MIN_SUBNIVEL ? '▶' : ' ';
      console.log(`    ${flag} ${String(n).padStart(4)}  ${tipo}`);
      crossJson[cat].byTipo[tipo] = { count: n, subcoleccion: n >= MIN_SUBNIVEL };
    }
  }

  // ── Section 4: productos sin metafields
  console.log(`\n── Productos sin metafields ──`);
  console.log(`  Sin catalogo (solo):        ${missingCatalogo.length}`);
  console.log(`  Sin tipo (solo):            ${missingTipo.length}`);
  console.log(`  Sin catalogo y sin tipo:    ${missingBoth.length}`);
  const printRows = (label, rows) => {
    if (!rows.length) return;
    console.log(`\n  ${label}:`);
    for (const r of rows) {
      console.log(`    SKU=${r.sku ?? '(none)'}  handle=${r.handle}  title="${r.title}"`);
    }
  };
  printRows('Sin catalogo', missingCatalogo);
  printRows('Sin tipo', missingTipo);
  printRows('Sin catalogo y sin tipo', missingBoth);

  // ── JSON dump
  const summary = {
    storeDomain: process.env.SHOPIFY_STORE_DOMAIN,
    runAt: new Date().toISOString(),
    collectionTag: COLLECTION_TAG,
    minSubnivel: MIN_SUBNIVEL,
    totalProducts: total,
    coverage: {
      catalogo: { count: withCatalogo, percent: total ? +pct(withCatalogo) : 0 },
      tipo:     { count: withTipo,     percent: total ? +pct(withTipo)     : 0 },
    },
    catalogoValues: Object.fromEntries(sortedEntries(catalogoVals)),
    tipoValues:     Object.fromEntries(sortedEntries(tipoVals)),
    crosstab: crossJson,
    missing: {
      catalogo: missingCatalogo.map(({ id, handle, sku, title }) => ({ id, handle, sku, title })),
      tipo:     missingTipo.map(({ id, handle, sku, title }) => ({ id, handle, sku, title })),
      both:     missingBoth.map(({ id, handle, sku, title }) => ({ id, handle, sku, title })),
    },
  };

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = resolve(REPORTS_DIR, `audit-catalogo-tipo-${ts}.json`);
  await writeFile(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nDetailed report → ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
