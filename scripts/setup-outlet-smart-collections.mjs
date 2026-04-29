#!/usr/bin/env node
// Idempotent smart collection creator for the LedsC4 B2B outlet.
//
// Builds — for products tagged "Coleccion:2026":
//   - 6 padres: outlet-<slug(catalogo)> with rules
//        TAG = "Coleccion:2026"  AND  product.catalogo = <Catalogo>
//   - N hijos: outlet-<slug(catalogo)>-<slug(productType)> for each
//        (catalogo × productType) combo with >= MIN_SUBNIVEL products. Rules:
//        TAG = "Coleccion:2026" AND product.catalogo = <Cat> AND TYPE = <PT>
//
// Catalog values are read live from Shopify (after backfill-otros script
// has run), so re-running is safe when products land or change catalogo.
//
// Idempotency:
//   - findCollection(handle): if exists with matching ruleSet, skip.
//   - If exists with different ruleSet, warn and skip (don't overwrite —
//     manual collections / older smart collections must be cleaned up by
//     hand).
//
// Usage:
//   SHOPIFY_STORE_DOMAIN=... SHOPIFY_ADMIN_TOKEN=... \
//   node scripts/setup-outlet-smart-collections.mjs [--dry-run] [--only=HANDLE]

import { gql, requireEnv, slug } from './_shopify.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length) || null;
if (!DRY_RUN) requireEnv();

const TAG = 'Coleccion:2026';
const CATALOGO_DEF_ID = 'gid://shopify/MetafieldDefinition/379919106375';
const MIN_SUBNIVEL = 3;

async function fetchOutletProducts() {
  const out = [];
  let cursor = null;
  while (true) {
    const q = `query($after: String) {
      products(first: 100, after: $after, query: "tag:${TAG}") {
        edges {
          cursor
          node {
            id productType
            mf: metafield(namespace: "product", key: "catalogo") { value }
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

function buildSpecs(products) {
  // Cross-tab catalogo × productType
  const catTotals = new Map();
  const xtab = new Map(); // cat -> Map(pt -> count)
  for (const p of products) {
    const cat = p.mf?.value;
    if (!cat) continue;
    catTotals.set(cat, (catTotals.get(cat) ?? 0) + 1);
    if (!xtab.has(cat)) xtab.set(cat, new Map());
    if (p.productType) {
      const sub = xtab.get(cat);
      sub.set(p.productType, (sub.get(p.productType) ?? 0) + 1);
    }
  }

  const specs = [];
  // Padres
  for (const [cat, total] of catTotals) {
    specs.push({
      kind: 'padre',
      handle: `outlet-${slug(cat)}`,
      title: cat,
      catalogo: cat,
      productType: null,
      expected: total,
    });
  }
  // Hijos (>= MIN_SUBNIVEL)
  for (const [cat, subs] of xtab) {
    for (const [pt, n] of subs) {
      if (n < MIN_SUBNIVEL) continue;
      specs.push({
        kind: 'hijo',
        handle: `outlet-${slug(cat)}-${slug(pt)}`,
        title: `${cat} — ${pt}`,
        catalogo: cat,
        productType: pt,
        expected: n,
      });
    }
  }
  return specs;
}

function buildRuleSet(spec) {
  const rules = [
    { column: 'TAG', relation: 'EQUALS', condition: TAG },
    {
      column: 'PRODUCT_METAFIELD_DEFINITION',
      relation: 'EQUALS',
      condition: spec.catalogo,
      conditionObjectId: CATALOGO_DEF_ID,
    },
  ];
  if (spec.productType) {
    rules.push({ column: 'TYPE', relation: 'EQUALS', condition: spec.productType });
  }
  return { appliedDisjunctively: false, rules };
}

function ruleSetMatches(existing, expected) {
  if (!existing) return false;
  if (existing.appliedDisjunctively !== expected.appliedDisjunctively) return false;
  if ((existing.rules?.length ?? 0) !== expected.rules.length) return false;
  // Order-insensitive comparison on (column, relation, condition)
  const norm = (r) => `${r.column}|${r.relation}|${r.condition}`;
  const a = new Set(existing.rules.map(norm));
  const b = new Set(expected.rules.map(norm));
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

async function findCollection(handle) {
  const q = `query($h: String!) {
    collectionByHandle(handle: $h) {
      id title handle productsCount { count }
      ruleSet { appliedDisjunctively rules { column relation condition } }
    }
  }`;
  const d = await gql(q, { h: handle }, { requestedCost: 20 });
  return d.collectionByHandle;
}

async function createCollection(spec, ruleSet) {
  const m = `mutation($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id handle title productsCount { count }
        ruleSet { appliedDisjunctively rules { column relation condition } } }
      userErrors { field message }
    }
  }`;
  const input = { title: spec.title, handle: spec.handle, ruleSet };
  const d = await gql(m, { input }, { requestedCost: 50 });
  const errs = d.collectionCreate.userErrors ?? [];
  if (errs.length) throw new Error(`collectionCreate ${spec.handle}: ${JSON.stringify(errs)}`);
  return d.collectionCreate.collection;
}

async function main() {
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Building outlet smart collections (min subnivel = ${MIN_SUBNIVEL})${ONLY ? ` — ONLY ${ONLY}` : ''}`);
  const products = await fetchOutletProducts();
  console.log(`Fetched ${products.length} outlet products`);

  let specs = buildSpecs(products);
  console.log(`Computed ${specs.length} collection specs (padres + hijos>=${MIN_SUBNIVEL})`);
  if (ONLY) specs = specs.filter((s) => s.handle === ONLY);
  if (specs.length === 0) {
    console.error(`No specs match ${ONLY ? `--only=${ONLY}` : 'criteria'}`);
    process.exit(1);
  }

  const summary = { created: 0, exists_match: 0, exists_diff: 0, errors: 0 };
  for (const spec of specs) {
    const ruleSet = buildRuleSet(spec);
    const existing = await findCollection(spec.handle);

    if (existing) {
      if (ruleSetMatches(existing.ruleSet, ruleSet)) {
        console.log(`[skip ✓] ${spec.handle} — exists with matching ruleSet (products=${existing.productsCount?.count})`);
        summary.exists_match++;
        continue;
      }
      console.warn(`[skip ⚠] ${spec.handle} — exists with DIFFERENT ruleSet, leaving untouched`);
      summary.exists_diff++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`[dry-run] would create ${spec.kind.padEnd(5)} ${spec.handle} expected=${spec.expected} title="${spec.title}"`);
      console.log(`             rules: ${JSON.stringify(ruleSet.rules)}`);
      summary.created++;
      continue;
    }

    try {
      const c = await createCollection(spec, ruleSet);
      const got = c.productsCount?.count;
      const ok = got === spec.expected ? '✓' : `⚠ expected ${spec.expected}`;
      console.log(`[ok] ${spec.handle} created ${c.id} products=${got} ${ok}`);
      summary.created++;
    } catch (err) {
      console.error(`[error] ${spec.handle}: ${err.message}`);
      summary.errors++;
    }
  }

  console.log(`\nSummary: ${JSON.stringify(summary)}`);
  process.exit(summary.errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
