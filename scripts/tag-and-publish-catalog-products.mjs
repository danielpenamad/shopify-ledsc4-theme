#!/usr/bin/env node
// Taggea con "Coleccion:2026" y publica a Online Store todos los products
// de la tienda. Idempotente (salta si ya tiene el tag o ya está publicado).
//
// Necesario porque el smart collection "coleccion-2026" depende de ese
// tag para poblar, y los productos necesitan estar publicados al Online
// Store publication para que /collections/coleccion-2026 funcione.
//
// Usage:
//   SHOPIFY_STORE_DOMAIN=... SHOPIFY_ADMIN_TOKEN=... \
//   node scripts/tag-and-publish-catalog-products.mjs [--dry-run]

const TAG = 'Coleccion:2026';
const ONLINE_STORE_PUBLICATION = 'gid://shopify/Publication/299734270279';

const API_VERSION = process.env.SHOPIFY_API_VERSION ?? '2025-10';
const DRY_RUN = process.argv.includes('--dry-run');
const { SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN } = process.env;

if (!DRY_RUN && (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN)) {
  console.error('Missing env vars');
  process.exit(1);
}

const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

async function gql(query, variables = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function listProducts() {
  const out = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($c: String) {
        products(first: 100, after: $c) {
          pageInfo { hasNextPage endCursor }
          edges { node { id handle tags resourcePublications(first: 10) { edges { node { publication { id } } } } } }
        }
      }`,
      { c: cursor }
    );
    for (const e of data.products.edges) {
      const pubs = new Set(e.node.resourcePublications.edges.map((p) => p.node.publication.id));
      out.push({
        id: e.node.id,
        handle: e.node.handle,
        hasTag: e.node.tags.includes(TAG),
        publishedToOnlineStore: pubs.has(ONLINE_STORE_PUBLICATION),
      });
    }
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

async function addTag(id) {
  const data = await gql(
    `mutation($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) { userErrors { message } }
    }`,
    { id, tags: [TAG] }
  );
  const errs = data.tagsAdd.userErrors;
  if (errs.length) throw new Error(JSON.stringify(errs));
}

async function publishToOnlineStore(id) {
  const data = await gql(
    `mutation($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) { userErrors { message } }
    }`,
    { id, input: [{ publicationId: ONLINE_STORE_PUBLICATION }] }
  );
  const errs = data.publishablePublish.userErrors;
  if (errs.length) throw new Error(JSON.stringify(errs));
}

async function main() {
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Fetching products…`);
  const products = await listProducts();
  console.log(`Total products: ${products.length}`);

  const needTag = products.filter((p) => !p.hasTag);
  const needPublish = products.filter((p) => !p.publishedToOnlineStore);

  console.log(`Need tag '${TAG}': ${needTag.length}`);
  console.log(`Need publish to Online Store: ${needPublish.length}`);

  if (DRY_RUN) {
    return;
  }

  let tagged = 0;
  for (const p of needTag) {
    try {
      await addTag(p.id);
      tagged++;
      if (tagged % 50 === 0) console.log(`  tagged ${tagged}/${needTag.length}`);
    } catch (e) {
      console.error(`[tag-error] ${p.handle}: ${e.message}`);
    }
  }
  console.log(`[done] tagged ${tagged}`);

  let published = 0;
  for (const p of needPublish) {
    try {
      await publishToOnlineStore(p.id);
      published++;
      if (published % 50 === 0) console.log(`  published ${published}/${needPublish.length}`);
    } catch (e) {
      console.error(`[publish-error] ${p.handle}: ${e.message}`);
    }
  }
  console.log(`[done] published ${published}`);

  console.log('\nSummary: taggear', tagged, '· publicar', published);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
