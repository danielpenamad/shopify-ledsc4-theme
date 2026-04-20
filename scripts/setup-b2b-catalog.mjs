#!/usr/bin/env node
// Idempotent bootstrap for the B2B outlet catalog.
//
// Creates (in order, skipping any that already exist):
//   1. Smart collection "coleccion-2026" with rule: product_tag = "Coleccion:2026"
//   2. Price list "Outlet general — precios actuales" at 0% over shop prices (EUR)
//   3. Catalog "Outlet general" (ACTIVE, company-location context, empty)
//   4. Publishes the collection to the catalog's publication
//
// Usage:
//   SHOPIFY_STORE_DOMAIN=ledsc4-b2b-outlet.myshopify.com \
//   SHOPIFY_ADMIN_TOKEN=shpat_xxx \
//   node scripts/setup-b2b-catalog.mjs [--dry-run]

const API_VERSION = process.env.SHOPIFY_API_VERSION ?? '2025-10';
const DRY_RUN = process.argv.includes('--dry-run');
const { SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN } = process.env;

const COLLECTION_HANDLE = 'coleccion-2026';
const COLLECTION_TITLE = 'Colección 2026 (Outlet B2B)';
const COLLECTION_TAG = 'Coleccion:2026';
const CATALOG_TITLE = 'Outlet general';
const PRICE_LIST_NAME = 'Outlet general — precios actuales';

if (!DRY_RUN && (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN)) {
  console.error('Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars.');
  console.error('Either set them or run with --dry-run to preview.');
  process.exit(1);
}

const endpoint = SHOPIFY_STORE_DOMAIN
  ? `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`
  : null;

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

async function findCollection() {
  const q = `query($h: String!) {
    collectionByHandle(handle: $h) {
      id title handle productsCount { count }
    }
  }`;
  const data = await gql(q, { h: COLLECTION_HANDLE });
  return data.collectionByHandle;
}

async function createCollection() {
  const existing = await findCollection();
  if (existing) {
    console.log(`[skip] collection exists: ${existing.handle} (${existing.id}), products=${existing.productsCount?.count ?? '?'}`);
    return existing.id;
  }
  const m = `mutation($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id title handle }
      userErrors { field message }
    }
  }`;
  const input = {
    title: COLLECTION_TITLE,
    handle: COLLECTION_HANDLE,
    ruleSet: {
      appliedDisjunctively: false,
      rules: [{ column: 'TAG', relation: 'EQUALS', condition: COLLECTION_TAG }],
    },
  };
  const data = await gql(m, { input });
  const errs = data.collectionCreate.userErrors;
  if (errs.length) throw new Error(`collectionCreate: ${JSON.stringify(errs)}`);
  const { id } = data.collectionCreate.collection;
  console.log(`[ok] created collection: ${COLLECTION_HANDLE} (${id})`);
  return id;
}

async function findPriceList() {
  const q = `query { priceLists(first: 50) { edges { node { id name } } } }`;
  const data = await gql(q, {});
  const edge = data.priceLists.edges.find((e) => e.node.name === PRICE_LIST_NAME);
  return edge?.node;
}

async function createPriceList() {
  const existing = await findPriceList();
  if (existing) {
    console.log(`[skip] price list exists: ${existing.name} (${existing.id})`);
    return existing.id;
  }
  const m = `mutation($input: PriceListCreateInput!) {
    priceListCreate(input: $input) {
      priceList { id name }
      userErrors { field message }
    }
  }`;
  const input = {
    name: PRICE_LIST_NAME,
    currency: 'EUR',
    parent: { adjustment: { type: 'PERCENTAGE_DECREASE', value: 0.0 } },
  };
  const data = await gql(m, { input });
  const errs = data.priceListCreate.userErrors;
  if (errs.length) throw new Error(`priceListCreate: ${JSON.stringify(errs)}`);
  const { id } = data.priceListCreate.priceList;
  console.log(`[ok] created price list: ${PRICE_LIST_NAME} (${id})`);
  return id;
}

async function findCatalog() {
  const q = `query($q: String!) {
    catalogs(first: 50, query: $q) {
      edges { node { id title status ... on CompanyLocationCatalog { publication { id } } } }
    }
  }`;
  const data = await gql(q, { q: `title:${CATALOG_TITLE}` });
  const edge = data.catalogs.edges.find((e) => e.node.title === CATALOG_TITLE);
  return edge?.node;
}

async function createCatalog(priceListId) {
  const existing = await findCatalog();
  if (existing) {
    console.log(`[skip] catalog exists: ${existing.title} (${existing.id})`);
    return existing;
  }
  const m = `mutation($input: CatalogCreateInput!) {
    catalogCreate(input: $input) {
      catalog {
        id title status
        ... on CompanyLocationCatalog { publication { id } }
      }
      userErrors { field message }
    }
  }`;
  const input = {
    title: CATALOG_TITLE,
    status: 'ACTIVE',
    context: { companyLocationIds: [] },
    priceListId,
  };
  const data = await gql(m, { input });
  const errs = data.catalogCreate.userErrors;
  if (errs.length) throw new Error(`catalogCreate: ${JSON.stringify(errs)}`);
  const catalog = data.catalogCreate.catalog;
  console.log(`[ok] created catalog: ${CATALOG_TITLE} (${catalog.id})`);
  return catalog;
}

async function ensureCatalogPublication(catalog) {
  if (catalog.publication?.id) {
    console.log(`[skip] catalog publication exists: ${catalog.publication.id}`);
    return catalog.publication.id;
  }
  // Re-query in case the catalogCreate response didn't populate it
  const re = await gql(
    `query($id: ID!) { catalog(id: $id) { ... on CompanyLocationCatalog { publication { id } } } }`,
    { id: catalog.id }
  );
  const existing = re.catalog?.publication?.id;
  if (existing) {
    console.log(`[skip] catalog publication exists: ${existing}`);
    return existing;
  }
  const m = `mutation($input: PublicationCreateInput!) {
    publicationCreate(input: $input) {
      publication { id catalog { id } }
      userErrors { field message code }
    }
  }`;
  const data = await gql(m, { input: { catalogId: catalog.id, autoPublish: false } });
  const errs = data.publicationCreate.userErrors;
  if (errs.length) throw new Error(`publicationCreate: ${JSON.stringify(errs)}`);
  const pubId = data.publicationCreate.publication.id;
  console.log(`[ok] created catalog publication: ${pubId}`);
  return pubId;
}

async function main() {
  const target = SHOPIFY_STORE_DOMAIN ?? '(not set — dry run)';
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Bootstrapping B2B catalog on ${target}`);

  if (DRY_RUN) {
    console.log(`[dry-run] smart collection: handle=${COLLECTION_HANDLE} rule=tag EQUALS "${COLLECTION_TAG}"`);
    console.log(`[dry-run] price list: "${PRICE_LIST_NAME}" currency=EUR parent=shop adjustment=0%`);
    console.log(`[dry-run] catalog: "${CATALOG_TITLE}" status=ACTIVE context=companyLocation`);
    console.log(`[dry-run] ensure catalog publication exists`);
    return;
  }

  const collectionId = await createCollection();
  const priceListId = await createPriceList();
  const catalog = await createCatalog(priceListId);
  const publicationId = await ensureCatalogPublication(catalog);

  console.log(`\nDone. collection=${collectionId} priceList=${priceListId} catalog=${catalog.id} publication=${publicationId}`);
  console.log(`\nNote: B2B catalog publications don't accept collections. To make products`);
  console.log(`visible in the catalog, tag the 743 SKUs with "${COLLECTION_TAG}" and then`);
  console.log(`run: node scripts/publish-catalog-products.mjs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
