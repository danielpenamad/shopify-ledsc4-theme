#!/usr/bin/env node
/**
 * scripts/fix-translations.mjs
 *
 * One-shot cleanup script (PR-PIPELINE-A companion).
 *
 * Purpose:
 *   Remove ALL contaminated translations from PRODUCT metafields in the LedsC4
 *   shop. The pipeline writer had a bug that left holes in product metafield
 *   translations, which Translate & Adapt then auto-filled with garbage like
 *   "IN APRIL" for "NA EPREL", "Décoratif" for "Decorative", etc.
 *
 *   After PR-PIPELINE-A (writer fix) was deployed and the deploy is confirmed
 *   live in origin/main, this script wipes the slate clean for product
 *   metafields so the next full cron (UTC 02:00) regenerates only legitimate
 *   translations.
 *
 * Scope (what we delete):
 *   - Translations whose owner resource is a Metafield AND
 *   - The metafield's ownerType is PRODUCT
 *   - The metafield is of type SINGLE_LINE_TEXT_FIELD or MULTI_LINE_TEXT_FIELD
 *   - Locale is one of: en, fr, de, it, pt-PT  (es is the source, never touched)
 *
 * What we preserve (never touched):
 *   - Customer metafields (B2B fields: sector, NIF, empresa, etc.)
 *   - Collection / product / page resource translations themselves (this script
 *     only targets the Metafield resourceType)
 *   - URL-type metafields (they don't have translations anyway)
 *
 * Safety:
 *   - DRY RUN by default. Set DRY_RUN=false to actually delete.
 *   - Writes a plan file `translations-removal-plan.json` you can inspect
 *     before flipping DRY_RUN off.
 *   - Idempotent. Running twice is safe (second run finds nothing to do).
 *
 * Requirements:
 *   - Env: SHOPIFY_STORE_DOMAIN (full domain, e.g. "ledsc4-b2b-outlet.myshopify.com"),
 *          SHOPIFY_ADMIN_TOKEN, SHOPIFY_API_VERSION (optional, defaults to 2025-10).
 *   - Matches the env contract used by scripts/apply-metafield-definitions.mjs and
 *     scripts/_shopify.mjs (NOT the {SHOP_SLUG}.myshopify.com pattern).
 *
 * Usage:
 *   node --env-file=shopify-ledsc4-theme.env scripts/fix-translations.mjs                 # dry run
 *   DRY_RUN=false node --env-file=shopify-ledsc4-theme.env scripts/fix-translations.mjs   # execute
 */

import { writeFile } from 'node:fs/promises';

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION ?? '2025-10';
const DRY_RUN = process.env.DRY_RUN !== 'false';
const PAGE_SIZE = 250;
const REMOVE_BATCH_SIZE = 100; // translationsRemove supports up to ~100 keys per call
const PLAN_FILE = 'translations-removal-plan.json';

const TARGET_LOCALES = ['en', 'fr', 'de', 'it', 'pt-PT'];
const TARGET_METAFIELD_TYPES = new Set([
  'SINGLE_LINE_TEXT_FIELD',
  'MULTI_LINE_TEXT_FIELD',
]);

if (!SHOPIFY_STORE_DOMAIN || !TOKEN) {
  console.error('Missing env vars: SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN are required.');
  console.error('Tip: invoke with `node --env-file=shopify-ledsc4-theme.env scripts/fix-translations.mjs`.');
  process.exit(1);
}

const ENDPOINT = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

// -----------------------------------------------------------------------------
// GraphQL client with cost-aware throttling
// -----------------------------------------------------------------------------

async function gql(query, variables = {}, attempt = 0) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    if (res.status === 429 && attempt < 5) {
      const wait = 2000 * (attempt + 1);
      console.warn(`429 rate limited. Waiting ${wait}ms…`);
      await sleep(wait);
      return gql(query, variables, attempt + 1);
    }
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();

  if (json.errors) {
    // Throttled error from Shopify (different from HTTP 429)
    const throttled = json.errors.some(e => e.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 5) {
      const wait = 2000 * (attempt + 1);
      console.warn(`THROTTLED. Waiting ${wait}ms…`);
      await sleep(wait);
      return gql(query, variables, attempt + 1);
    }
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  // Cost-aware pacing: if we have less than 200 points available, slow down.
  const status = json.extensions?.cost?.throttleStatus;
  if (status && status.currentlyAvailable < 200) {
    const restoreNeeded = 500 - status.currentlyAvailable;
    const waitMs = Math.ceil((restoreNeeded / status.restoreRate) * 1000);
    if (waitMs > 0) {
      console.warn(`Low budget (${status.currentlyAvailable}/${status.maximumAvailable}). Waiting ${waitMs}ms…`);
      await sleep(waitMs);
    }
  }

  return json.data;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// -----------------------------------------------------------------------------
// Step 1: Collect all metafield translatable resources with translations
// -----------------------------------------------------------------------------

const LIST_QUERY = /* GraphQL */ `
  query allMetafieldTranslations($cursor: String) {
    translatableResources(first: ${PAGE_SIZE}, resourceType: METAFIELD, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          resourceId
          translatableContent { key value locale digest type }
          en: translations(locale: "en") { locale key }
          fr: translations(locale: "fr") { locale key }
          de: translations(locale: "de") { locale key }
          it: translations(locale: "it") { locale key }
          ptPT: translations(locale: "pt-PT") { locale key }
        }
      }
    }
  }
`;

async function collectCandidates() {
  const candidates = []; // { resourceId, type, locales: [...] }
  let cursor = null;
  let page = 0;

  while (true) {
    page++;
    const data = await gql(LIST_QUERY, { cursor });
    const conn = data.translatableResources;

    for (const { node } of conn.edges) {
      // We only care about value-key text translations
      const valueEntry = node.translatableContent.find(c => c.key === 'value');
      if (!valueEntry) continue;
      if (!TARGET_METAFIELD_TYPES.has(valueEntry.type)) continue;

      // Which target locales have translations?
      const localesWithTranslations = [];
      for (const [loc, list] of [
        ['en', node.en],
        ['fr', node.fr],
        ['de', node.de],
        ['it', node.it],
        ['pt-PT', node.ptPT],
      ]) {
        if (list.some(t => t.key === 'value')) {
          localesWithTranslations.push(loc);
        }
      }

      if (localesWithTranslations.length === 0) continue;

      candidates.push({
        resourceId: node.resourceId,
        type: valueEntry.type,
        locales: localesWithTranslations,
      });
    }

    process.stdout.write(`\rListing page ${page}, candidates so far: ${candidates.length}`);

    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  process.stdout.write('\n');
  return candidates;
}

// -----------------------------------------------------------------------------
// Step 2: Resolve owner type for each metafield (PRODUCT / CUSTOMER / etc.)
// -----------------------------------------------------------------------------

const NODES_OWNER_QUERY = /* GraphQL */ `
  query metafieldOwners($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Metafield {
        id
        namespace
        key
        ownerType
      }
    }
  }
`;

async function resolveOwnerTypes(candidates) {
  const idToOwner = new Map();
  const ids = candidates.map(c => c.resourceId);
  const CHUNK = 250; // nodes(ids:) accepts up to 250

  let done = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const data = await gql(NODES_OWNER_QUERY, { ids: chunk });
    for (const n of data.nodes) {
      if (n && n.id && n.ownerType) {
        idToOwner.set(n.id, {
          ownerType: n.ownerType,
          namespace: n.namespace,
          key: n.key,
        });
      }
    }
    done += chunk.length;
    process.stdout.write(`\rResolving owners: ${done}/${ids.length}`);
  }
  process.stdout.write('\n');
  return idToOwner;
}

// -----------------------------------------------------------------------------
// Step 3: Build removal plan
// -----------------------------------------------------------------------------

function buildPlan(candidates, ownerMap) {
  const plan = []; // { resourceId, locales, namespace, key }
  const stats = {
    total: candidates.length,
    productMetafields: 0,
    skippedNonProduct: {},
    skippedNoOwner: 0,
  };

  for (const c of candidates) {
    const owner = ownerMap.get(c.resourceId);
    if (!owner) {
      stats.skippedNoOwner++;
      continue;
    }
    if (owner.ownerType !== 'PRODUCT') {
      stats.skippedNonProduct[owner.ownerType] = (stats.skippedNonProduct[owner.ownerType] || 0) + 1;
      continue;
    }
    stats.productMetafields++;
    plan.push({
      resourceId: c.resourceId,
      namespace: owner.namespace,
      key: owner.key,
      locales: c.locales,
    });
  }

  return { plan, stats };
}

// -----------------------------------------------------------------------------
// Step 4: Execute translationsRemove in batches
// -----------------------------------------------------------------------------

const REMOVE_MUTATION = /* GraphQL */ `
  mutation translationsRemove(
    $resourceId: ID!
    $translationKeys: [String!]!
    $locales: [String!]!
  ) {
    translationsRemove(
      resourceId: $resourceId
      translationKeys: $translationKeys
      locales: $locales
    ) {
      translations { locale key }
      userErrors { message field code }
    }
  }
`;

async function executePlan(plan) {
  let removed = 0;
  let errors = 0;
  let i = 0;

  for (const item of plan) {
    i++;
    try {
      const data = await gql(REMOVE_MUTATION, {
        resourceId: item.resourceId,
        translationKeys: ['value'],
        locales: item.locales,
      });
      const ue = data.translationsRemove.userErrors;
      if (ue && ue.length > 0) {
        errors++;
        console.error(`\n  ERR ${item.resourceId}: ${JSON.stringify(ue)}`);
      } else {
        removed += data.translationsRemove.translations?.length || item.locales.length;
      }
    } catch (e) {
      errors++;
      console.error(`\n  THROW ${item.resourceId}: ${e.message}`);
    }
    if (i % 25 === 0 || i === plan.length) {
      process.stdout.write(`\rRemoving: ${i}/${plan.length}  (removed=${removed}, errors=${errors})`);
    }
  }
  process.stdout.write('\n');
  return { removed, errors };
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

(async () => {
  console.log(`Shop:    ${SHOPIFY_STORE_DOMAIN}`);
  console.log(`API:     ${API_VERSION}`);
  console.log(`Mode:    ${DRY_RUN ? 'DRY RUN (no changes)' : 'EXECUTE'}`);
  console.log('');

  console.log('Step 1/3: Collecting metafield translations…');
  const candidates = await collectCandidates();
  console.log(`  Total text-metafields with translations: ${candidates.length}`);
  console.log('');

  console.log('Step 2/3: Resolving owner types…');
  const ownerMap = await resolveOwnerTypes(candidates);
  const { plan, stats } = buildPlan(candidates, ownerMap);
  console.log(`  Product metafield translations to remove: ${stats.productMetafields}`);
  console.log(`  Skipped (no owner resolvable):           ${stats.skippedNoOwner}`);
  console.log(`  Skipped (non-PRODUCT owner):`);
  for (const [k, v] of Object.entries(stats.skippedNonProduct)) {
    console.log(`    - ${k}: ${v}`);
  }
  console.log('');

  // Always write the plan for inspection
  await writeFile(PLAN_FILE, JSON.stringify({ stats, plan }, null, 2));
  console.log(`  Plan written to ${PLAN_FILE} (inspect before running with DRY_RUN=false)`);
  console.log('');

  if (plan.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (DRY_RUN) {
    console.log('DRY RUN — no mutations executed. Review the plan and re-run with DRY_RUN=false.');
    console.log('');
    console.log('Sample of first 5 items:');
    for (const item of plan.slice(0, 5)) {
      console.log(`  ${item.namespace}.${item.key}  ${item.resourceId}  locales=${item.locales.join(',')}`);
    }
    return;
  }

  console.log('Step 3/3: Executing translationsRemove…');
  const result = await executePlan(plan);
  console.log('');
  console.log('Done.');
  console.log(`  Translations removed: ${result.removed}`);
  console.log(`  Errors:               ${result.errors}`);
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
