#!/usr/bin/env node
// Publishes all products tagged "Coleccion:2026" to the "Outlet general"
// B2B catalog publication. Idempotent — already-published products are skipped.
//
// Run this AFTER:
//   1. Tagging the 743 SKUs with tag "Coleccion:2026"
//   2. scripts/setup-b2b-catalog.mjs (creates catalog + publication)
//
// Usage:
//   SHOPIFY_STORE_DOMAIN=... SHOPIFY_ADMIN_TOKEN=... \
//   node scripts/publish-catalog-products.mjs [--dry-run]

const API_VERSION = process.env.SHOPIFY_API_VERSION ?? '2025-10';
const DRY_RUN = process.argv.includes('--dry-run');
const { SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN } = process.env;

const CATALOG_TITLE = 'Outlet general';
const COLLECTION_TAG = 'Coleccion:2026';
const BATCH_SIZE = 50; // products per publishablePublish call
const PAGE_SIZE = 100; // products per paged query

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
  console.error('Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars.');
  process.exit(1);
}

const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

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

async function findCatalogPublication() {
  const q = `query($q: String!) {
    catalogs(first: 50, query: $q) {
      edges {
        node {
          id title
          ... on CompanyLocationCatalog { publication { id } }
        }
      }
    }
  }`;
  const data = await gql(q, { q: `title:${CATALOG_TITLE}` });
  const node = data.catalogs.edges.find((e) => e.node.title === CATALOG_TITLE)?.node;
  if (!node) throw new Error(`Catalog "${CATALOG_TITLE}" not found. Run setup-b2b-catalog.mjs first.`);
  if (!node.publication?.id) throw new Error(`Catalog exists but has no publication. Run setup-b2b-catalog.mjs to create one.`);
  return { catalogId: node.id, publicationId: node.publication.id };
}

async function* iterTaggedProducts(publicationId) {
  const q = `query($query: String!, $cursor: String, $pubId: ID!) {
    products(first: ${PAGE_SIZE}, after: $cursor, query: $query) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id title
          publishedOnPublication(publicationId: $pubId)
        }
      }
    }
  }`;
  let cursor = null;
  do {
    const data = await gql(q, {
      query: `tag:"${COLLECTION_TAG}"`,
      cursor,
      pubId: publicationId,
    });
    for (const { node } of data.products.edges) yield node;
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
}

async function publishBatch(productIds, publicationId) {
  const m = `mutation($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }`;
  // publishablePublish takes one publishable id at a time, so loop.
  // (Bulk flow exists via publicationUpdate but is heavier; per-product stays clear.)
  let ok = 0;
  let errs = 0;
  for (const id of productIds) {
    const data = await gql(m, { id, input: [{ publicationId }] });
    const userErrors = data.publishablePublish.userErrors ?? [];
    if (userErrors.length) {
      console.error(`[error] publish ${id}:`, userErrors);
      errs++;
    } else {
      ok++;
    }
  }
  return { ok, errs };
}

async function main() {
  const target = SHOPIFY_STORE_DOMAIN;
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Publishing tag:"${COLLECTION_TAG}" products to catalog "${CATALOG_TITLE}" on ${target}`);

  const { catalogId, publicationId } = await findCatalogPublication();
  console.log(`catalog=${catalogId} publication=${publicationId}`);

  const toPublish = [];
  let totalMatching = 0;
  let alreadyPublished = 0;

  for await (const p of iterTaggedProducts(publicationId)) {
    totalMatching++;
    if (p.publishedOnPublication) {
      alreadyPublished++;
    } else {
      toPublish.push(p.id);
    }
  }

  console.log(`matched=${totalMatching} alreadyPublished=${alreadyPublished} toPublish=${toPublish.length}`);

  if (DRY_RUN) {
    console.log(`[dry-run] Would publish ${toPublish.length} products to publication ${publicationId}`);
    return;
  }

  let publishedOK = 0;
  let publishedErr = 0;
  for (let i = 0; i < toPublish.length; i += BATCH_SIZE) {
    const batch = toPublish.slice(i, i + BATCH_SIZE);
    const { ok, errs } = await publishBatch(batch, publicationId);
    publishedOK += ok;
    publishedErr += errs;
    console.log(`  batch ${i / BATCH_SIZE + 1}: ok=${ok} err=${errs} (total ok=${publishedOK})`);
  }

  console.log(`\nDone. published=${publishedOK} errors=${publishedErr} alreadyPublished=${alreadyPublished}`);
  process.exit(publishedErr > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
