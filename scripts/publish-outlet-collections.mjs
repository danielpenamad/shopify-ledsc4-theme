#!/usr/bin/env node
// Idempotent publisher: publishes every collection whose handle starts with
// "outlet-" to the Online Store publication.
//
// Why: smart collections created via collectionCreate are NOT published by
// default — they're invisible in the storefront until publishablePublish.
// Re-run safely after setup-outlet-smart-collections.mjs adds new ones.
//
// Idempotency: skips collections already published on Online Store
// (publishedOnPublication check before mutating).
//
// Usage:
//   SHOPIFY_STORE_DOMAIN=... SHOPIFY_ADMIN_TOKEN=... \
//   node scripts/publish-outlet-collections.mjs [--dry-run]

import { gql, requireEnv } from './_shopify.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
if (!DRY_RUN) requireEnv();

const HANDLE_PREFIX = 'outlet-';
const ONLINE_STORE_PUB = 'gid://shopify/Publication/299734270279';

async function listOutletCollections() {
  const out = [];
  let cursor = null;
  while (true) {
    const q = `query($after: String) {
      collections(first: 100, after: $after, query: "handle:${HANDLE_PREFIX}*") {
        edges { cursor node { id handle title } }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    const d = await gql(q, { after: cursor }, { requestedCost: 200 });
    for (const e of d.collections.edges) {
      // Defensive: query returns substring matches sometimes — re-filter on prefix
      if (e.node.handle.startsWith(HANDLE_PREFIX)) out.push(e.node);
    }
    if (!d.collections.pageInfo.hasNextPage) break;
    cursor = d.collections.pageInfo.endCursor;
  }
  return out;
}

async function isPublished(id) {
  const q = `query($id: ID!, $pub: ID!) {
    collection(id: $id) { publishedOnPublication(publicationId: $pub) }
  }`;
  const d = await gql(q, { id, pub: ONLINE_STORE_PUB }, { requestedCost: 10 });
  return d.collection?.publishedOnPublication === true;
}

async function publish(id) {
  const m = `mutation($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) { userErrors { field message } }
  }`;
  const d = await gql(m, { id, input: [{ publicationId: ONLINE_STORE_PUB }] }, { requestedCost: 30 });
  const errs = d.publishablePublish.userErrors ?? [];
  if (errs.length) throw new Error(`publish ${id}: ${JSON.stringify(errs)}`);
}

async function main() {
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Publishing collections handle:${HANDLE_PREFIX}* to Online Store`);
  const cols = await listOutletCollections();
  console.log(`Found ${cols.length} matching collections`);

  const summary = { published: 0, alreadyPublished: 0, errors: 0 };
  for (const c of cols) {
    try {
      if (await isPublished(c.id)) {
        console.log(`[skip ✓] ${c.handle} — already on Online Store`);
        summary.alreadyPublished++;
        continue;
      }
      if (DRY_RUN) {
        console.log(`[dry-run] would publish ${c.handle}`);
        summary.published++;
        continue;
      }
      await publish(c.id);
      console.log(`[ok] ${c.handle} published`);
      summary.published++;
    } catch (err) {
      console.error(`[error] ${c.handle}: ${err.message}`);
      summary.errors++;
    }
  }
  console.log(`\nSummary: ${JSON.stringify(summary)}`);
  process.exit(summary.errors > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
