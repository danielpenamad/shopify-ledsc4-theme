#!/usr/bin/env node
/**
 * scripts/register-cat-translations.mjs
 *
 * One-shot, idempotent script to register title translations for the 44 cat-*
 * outlet collections of the LedsC4 B2B shop.
 *
 * Source of truth:
 *   - Padres + hijos (43): derived in runtime from the metafield translations
 *     of the products that belong to each collection (product.catalogo,
 *     product.tipo), which the daily pipeline writer keeps in sync with the
 *     SFTP CSVs. This makes the script a pure projection of the
 *     pipeline-managed product translations onto the collection.title.
 *   - cat-otros (1, custom): no derivable from product metafields because the
 *     bucket groups Emergency + Ecommerce catalogos. Title comes from
 *     OTROS_TITLES hardcoded below.
 *
 * Locales: es, en, fr, de, it, pt-PT (all six the shop manages, regardless of
 *   storefront publication state). ES is the primary locale: applied via
 *   `collectionUpdate` (overwriting Collection.title). The other five are
 *   applied via `translationsRegister` (Translate & Adapt-style entries).
 *
 * Idempotency: re-running with the same inputs is a no-op. The diff loop only
 *   writes when the computed value differs from the current one.
 *
 * Modes:
 *   - DRY_RUN=true (default): prints the diff per (collection, locale) and a
 *     summary. Writes the plan to translations-cat-plan.json for inspection.
 *   - DRY_RUN=false: executes the mutations after writing the plan.
 *
 * Requirements:
 *   - Env: SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN, SHOPIFY_API_VERSION
 *     (optional, default 2025-10). Same contract as
 *     scripts/apply-metafield-definitions.mjs and scripts/fix-translations.mjs.
 *
 * Usage:
 *   node --env-file=shopify-ledsc4-theme.env scripts/register-cat-translations.mjs              # dry run
 *   DRY_RUN=false node --env-file=shopify-ledsc4-theme.env scripts/register-cat-translations.mjs   # execute
 */

import { writeFile } from 'node:fs/promises';

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION ?? '2025-10';
const DRY_RUN = process.env.DRY_RUN !== 'false';
const PLAN_FILE = 'translations-cat-plan.json';

// All 6 locales the shop manages. ES is primary (handled with collectionUpdate);
// the other 5 use translationsRegister. The list order matters only for
// readability in the dry-run output.
const TARGET_LOCALES = ['es', 'en', 'fr', 'de', 'it', 'pt-PT'];
const PRIMARY_LOCALE = 'es';
const NON_PRIMARY_LOCALES = TARGET_LOCALES.filter((l) => l !== PRIMARY_LOCALE);

// Em-dash U+2014 with one space on each side. Mirrors the separator already
// hardcoded in setup-cat-collections.mjs line 115 so the script produces
// titles that match the existing pattern (e.g. "Decorative — Colgante").
const SEPARATOR = ' — ';

// The 5 known padre handles. Used to classify by handle alone (1-segment
// handles that ARE padres) without inferring catalogo from the slug.
const PADRE_HANDLES = new Set([
  'cat-forlight',
  'cat-architectural',
  'cat-decorative',
  'cat-diy',
  'cat-outdoor',
]);

// cat-otros is the only CUSTOM collection in the cat-* set. It groups
// products with metafield product.catalogo ∈ {Emergency, Ecommerce}, which
// don't map to a translatable "Otros" string in the CSV — so the title must
// come from a hardcoded override per locale. If/when the schema adopts a
// proper "Otros" catalogo value the CSV exposes per locale, this override
// can be removed and cat-otros joins the data-driven path.
const OTROS_TITLES = {
  es: 'Otros',
  en: 'Others',
  fr: 'Autres',
  de: 'Andere',
  it: 'Altri',
  'pt-PT': 'Outros',
};

// How many products to sample per collection for consistency check.
// 3 is enough to catch cross-product disagreements without blowing up the
// API budget on shops with hundreds of products per collection.
const PRODUCT_SAMPLE_SIZE = 3;

if (!SHOPIFY_STORE_DOMAIN || !TOKEN) {
  console.error('Missing env vars: SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN are required.');
  console.error('Tip: invoke with `node --env-file=shopify-ledsc4-theme.env scripts/register-cat-translations.mjs`.');
  process.exit(1);
}

const ENDPOINT = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

// -----------------------------------------------------------------------------
// GraphQL client with cost-aware throttling (same pattern as fix-translations.mjs)
// -----------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const throttled = json.errors.some((e) => e.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 5) {
      const wait = 2000 * (attempt + 1);
      console.warn(`THROTTLED. Waiting ${wait}ms…`);
      await sleep(wait);
      return gql(query, variables, attempt + 1);
    }
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

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

// -----------------------------------------------------------------------------
// Step 1 — Discover all cat-* collections
// -----------------------------------------------------------------------------

// Shopify search syntax: bare `handle:cat-*` doesn't work. Need a prefix
// wildcard per known padre slug. Listing all six known prefixes catches the
// 5 padres + their 38 children + cat-otros (matched verbatim).
const COLLECTIONS_QUERY = /* GraphQL */ `
  query catCollections {
    collections(
      first: 50
      query: "handle:cat-forlight* OR handle:cat-architectural* OR handle:cat-decorative* OR handle:cat-diy* OR handle:cat-outdoor* OR handle:cat-otros"
    ) {
      edges {
        node {
          id
          handle
          title
          productsCount { count }
        }
      }
    }
  }
`;

async function discoverCollections() {
  const data = await gql(COLLECTIONS_QUERY);
  return data.collections.edges.map((e) => e.node);
}

function classify(handle) {
  if (handle === 'cat-otros') return 'otros';
  if (PADRE_HANDLES.has(handle)) return 'padre';
  return 'hijo';
}

// -----------------------------------------------------------------------------
// Step 2 — For each collection, sample products with their metafields
// -----------------------------------------------------------------------------

const COLLECTION_PRODUCTS_QUERY = /* GraphQL */ `
  query collProducts($id: ID!, $first: Int!) {
    collection(id: $id) {
      products(first: $first) {
        nodes {
          id
          metaCatalogo: metafield(namespace: "product", key: "catalogo") {
            id
            value
            type
          }
          metaTipo: metafield(namespace: "product", key: "tipo") {
            id
            value
            type
          }
        }
      }
    }
  }
`;

async function sampleProducts(collectionId) {
  const data = await gql(COLLECTION_PRODUCTS_QUERY, { id: collectionId, first: PRODUCT_SAMPLE_SIZE });
  return data.collection?.products?.nodes ?? [];
}

// -----------------------------------------------------------------------------
// Step 3 — Fetch metafield translations in batch
// -----------------------------------------------------------------------------

const MF_TRANSLATIONS_QUERY = /* GraphQL */ `
  query mfTranslations($ids: [ID!]!) {
    translatableResourcesByIds(resourceIds: $ids, first: 50) {
      edges {
        node {
          resourceId
          en: translations(locale: "en") { locale key value outdated }
          fr: translations(locale: "fr") { locale key value outdated }
          de: translations(locale: "de") { locale key value outdated }
          it: translations(locale: "it") { locale key value outdated }
          ptPT: translations(locale: "pt-PT") { locale key value outdated }
        }
      }
    }
  }
`;

// Returns Map<metafieldGid, { en?, fr?, de?, it?, 'pt-PT'? }> with the value
// of the "value"-keyed translation for each locale, or undefined if missing.
async function fetchMetafieldTranslations(metafieldIds) {
  if (metafieldIds.length === 0) return new Map();
  const out = new Map();
  // Batch in chunks of 50 (max for translatableResourcesByIds).
  const CHUNK = 50;
  for (let i = 0; i < metafieldIds.length; i += CHUNK) {
    const chunk = metafieldIds.slice(i, i + CHUNK);
    const data = await gql(MF_TRANSLATIONS_QUERY, { ids: chunk });
    for (const { node } of data.translatableResourcesByIds.edges) {
      const byLocale = {};
      for (const [outKey, localeKey] of [
        ['en', 'en'],
        ['fr', 'fr'],
        ['de', 'de'],
        ['it', 'it'],
        ['pt-PT', 'ptPT'],
      ]) {
        const entry = (node[localeKey] ?? []).find((t) => t.key === 'value');
        if (entry?.value) byLocale[outKey] = entry.value;
      }
      out.set(node.resourceId, byLocale);
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Step 4 — Fetch the collection's title translatableContent (digest + existing
//          translations for diff display)
// -----------------------------------------------------------------------------

const COLLECTION_TRANS_QUERY = /* GraphQL */ `
  query collTrans($ids: [ID!]!) {
    translatableResourcesByIds(resourceIds: $ids, first: 50) {
      edges {
        node {
          resourceId
          translatableContent { key value locale digest type }
          en: translations(locale: "en") { locale key value outdated }
          fr: translations(locale: "fr") { locale key value outdated }
          de: translations(locale: "de") { locale key value outdated }
          it: translations(locale: "it") { locale key value outdated }
          ptPT: translations(locale: "pt-PT") { locale key value outdated }
        }
      }
    }
  }
`;

// Returns Map<collectionGid, { titleDigest, existingByLocale: {locale: value} }>.
async function fetchCollectionTranslatables(collectionIds) {
  if (collectionIds.length === 0) return new Map();
  const out = new Map();
  const CHUNK = 50;
  for (let i = 0; i < collectionIds.length; i += CHUNK) {
    const chunk = collectionIds.slice(i, i + CHUNK);
    const data = await gql(COLLECTION_TRANS_QUERY, { ids: chunk });
    for (const { node } of data.translatableResourcesByIds.edges) {
      const titleContent = (node.translatableContent ?? []).find((c) => c.key === 'title');
      const titleDigest = titleContent?.digest ?? null;
      const existing = {};
      for (const [outKey, localeKey] of [
        ['en', 'en'],
        ['fr', 'fr'],
        ['de', 'de'],
        ['it', 'it'],
        ['pt-PT', 'ptPT'],
      ]) {
        const entry = (node[localeKey] ?? []).find((t) => t.key === 'title');
        if (entry?.value != null) existing[outKey] = entry.value;
      }
      out.set(node.resourceId, { titleDigest, existing });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Pick the most frequent value in `values`. If tie, the first one wins.
// Reports whether there was any disagreement (for the consistency log).
function pickMode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return { value: best, distinct: [...counts.keys()] };
}

// -----------------------------------------------------------------------------
// Step 5 — Build the plan: for each (collection, locale), compute new title
// -----------------------------------------------------------------------------

async function buildPlan() {
  console.log('Step 1/4: discover cat-* collections…');
  const collections = await discoverCollections();
  console.log(`  Found ${collections.length} cat-* collections.`);
  console.log('');

  // Bucket by kind for clarity in dry-run
  const buckets = { padre: [], hijo: [], otros: [] };
  for (const c of collections) buckets[classify(c.handle)].push(c);
  console.log(`  Breakdown: padres=${buckets.padre.length}, hijos=${buckets.hijo.length}, otros=${buckets.otros.length}`);
  console.log('');

  console.log('Step 2/4: sample products + fetch metafield translations…');
  const productMetafieldsByCollection = new Map(); // collId -> Array<{ metaCatalogo, metaTipo }>
  const allMetafieldIds = new Set();
  let productsSampled = 0;

  for (const coll of collections) {
    if (classify(coll.handle) === 'otros') continue; // skip cat-otros
    const products = await sampleProducts(coll.id);
    productMetafieldsByCollection.set(coll.id, products);
    productsSampled += products.length;
    for (const p of products) {
      if (p.metaCatalogo?.id) allMetafieldIds.add(p.metaCatalogo.id);
      if (p.metaTipo?.id) allMetafieldIds.add(p.metaTipo.id);
    }
  }
  console.log(`  Sampled ${productsSampled} products across ${productMetafieldsByCollection.size} non-otros collections.`);
  console.log(`  Unique metafields to translate-fetch: ${allMetafieldIds.size}.`);
  console.log('');

  const mfTranslations = await fetchMetafieldTranslations([...allMetafieldIds]);
  console.log(`  Fetched translations for ${mfTranslations.size} metafields.`);
  console.log('');

  console.log('Step 3/4: fetch existing collection title translations…');
  const collTranslatables = await fetchCollectionTranslatables(collections.map((c) => c.id));
  console.log(`  Fetched translatableContent for ${collTranslatables.size} collections.`);
  console.log('');

  console.log('Step 4/4: compute plan…');
  const plan = []; // Array<{handle, collectionId, locale, oldValue, newValue, changes, digest, kind}>
  const issues = {
    emptyCollections: [],     // productsCount=0
    missingLocaleData: [],    // can't compute new value for some locale
    inconsistencies: [],      // cross-product disagreement
  };

  for (const coll of collections) {
    const kind = classify(coll.handle);
    const trans = collTranslatables.get(coll.id);
    const titleDigest = trans?.titleDigest ?? null;
    const existingByLocale = trans?.existing ?? {};

    // Build titlePerLocale for this collection
    const titlePerLocale = {};

    if (kind === 'otros') {
      Object.assign(titlePerLocale, OTROS_TITLES);
    } else {
      const products = productMetafieldsByCollection.get(coll.id) ?? [];
      if (products.length === 0) {
        issues.emptyCollections.push(coll.handle);
        continue;
      }

      // Per-locale value collection across the sampled products.
      // For each locale, collect (catalogo, tipo) pairs and pick mode.
      for (const locale of TARGET_LOCALES) {
        const catValues = [];
        const tipoValues = [];

        for (const p of products) {
          if (locale === PRIMARY_LOCALE) {
            // ES is the base value of the metafield, not a translation.
            if (p.metaCatalogo?.value) catValues.push(p.metaCatalogo.value);
            if (kind === 'hijo' && p.metaTipo?.value) tipoValues.push(p.metaTipo.value);
          } else {
            const catTrans = mfTranslations.get(p.metaCatalogo?.id)?.[locale];
            if (catTrans) catValues.push(catTrans);
            if (kind === 'hijo') {
              const tipoTrans = mfTranslations.get(p.metaTipo?.id)?.[locale];
              if (tipoTrans) tipoValues.push(tipoTrans);
            }
          }
        }

        if (catValues.length === 0) {
          issues.missingLocaleData.push(`${coll.handle} [${locale}] catalogo`);
          continue;
        }
        if (kind === 'hijo' && tipoValues.length === 0) {
          issues.missingLocaleData.push(`${coll.handle} [${locale}] tipo`);
          continue;
        }

        const catMode = pickMode(catValues);
        if (catMode.distinct.length > 1) {
          issues.inconsistencies.push(`${coll.handle} [${locale}] catalogo: ${catMode.distinct.map((v) => JSON.stringify(v)).join(' | ')} → chose ${JSON.stringify(catMode.value)}`);
        }

        if (kind === 'padre') {
          titlePerLocale[locale] = catMode.value;
        } else {
          const tipoMode = pickMode(tipoValues);
          if (tipoMode.distinct.length > 1) {
            issues.inconsistencies.push(`${coll.handle} [${locale}] tipo: ${tipoMode.distinct.map((v) => JSON.stringify(v)).join(' | ')} → chose ${JSON.stringify(tipoMode.value)}`);
          }
          titlePerLocale[locale] = `${catMode.value}${SEPARATOR}${tipoMode.value}`;
        }
      }
    }

    // Now diff against current state
    for (const locale of TARGET_LOCALES) {
      const newValue = titlePerLocale[locale];
      if (newValue == null) continue; // skipped due to missing data
      const oldValue = locale === PRIMARY_LOCALE ? coll.title : (existingByLocale[locale] ?? null);
      plan.push({
        handle: coll.handle,
        collectionId: coll.id,
        kind,
        locale,
        oldValue,
        newValue,
        changes: oldValue !== newValue,
        digest: titleDigest, // null is OK for ES (collectionUpdate doesn't need a digest)
      });
    }
  }

  return { plan, issues };
}

// -----------------------------------------------------------------------------
// Step 6 — Execute plan
// -----------------------------------------------------------------------------

const COLLECTION_UPDATE_MUTATION = /* GraphQL */ `
  mutation collectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id title }
      userErrors { field message code }
    }
  }
`;

const TRANSLATIONS_REGISTER_MUTATION = /* GraphQL */ `
  mutation translationsRegister($resourceId: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $resourceId, translations: $translations) {
      translations { locale key value }
      userErrors { field message code }
    }
  }
`;

const COLLECTION_DIGEST_REFRESH = /* GraphQL */ `
  query digestRefresh($id: ID!) {
    translatableResource(resourceId: $id) {
      translatableContent { key value digest }
    }
  }
`;

async function refreshTitleDigest(collectionId) {
  const data = await gql(COLLECTION_DIGEST_REFRESH, { id: collectionId });
  const titleContent = (data.translatableResource?.translatableContent ?? []).find((c) => c.key === 'title');
  return titleContent?.digest ?? null;
}

async function executePlan(plan) {
  // Group by collectionId so we can batch translationsRegister per resource
  // (one call per collection for the 5 non-primary locales that change).
  const byCollection = new Map();
  for (const item of plan) {
    if (!item.changes) continue;
    if (!byCollection.has(item.collectionId)) byCollection.set(item.collectionId, []);
    byCollection.get(item.collectionId).push(item);
  }

  let updates = 0;
  let registers = 0;
  let errors = 0;
  let i = 0;
  const total = byCollection.size;

  for (const [collectionId, items] of byCollection) {
    i++;
    const handle = items[0].handle;

    // 1) ES first — collectionUpdate sets the primary title.
    const esItem = items.find((it) => it.locale === PRIMARY_LOCALE);
    if (esItem) {
      try {
        const data = await gql(COLLECTION_UPDATE_MUTATION, {
          input: { id: collectionId, title: esItem.newValue },
        });
        const ue = data.collectionUpdate.userErrors;
        if (ue && ue.length > 0) {
          errors++;
          console.error(`\n  ERR ${handle} [es collectionUpdate]: ${JSON.stringify(ue)}`);
        } else {
          updates++;
        }
      } catch (e) {
        errors++;
        console.error(`\n  THROW ${handle} [es collectionUpdate]: ${e.message}`);
      }
    }

    // 2) Non-ES locales — batch as one translationsRegister call per collection.
    const nonEsItems = items.filter((it) => it.locale !== PRIMARY_LOCALE);
    if (nonEsItems.length > 0) {
      // If we just touched the ES title via collectionUpdate, the digest of the
      // title's translatableContent has rotated. Refetch before registering.
      let digest = nonEsItems[0].digest;
      if (esItem) {
        digest = await refreshTitleDigest(collectionId);
      }

      const translations = nonEsItems.map((it) => ({
        locale: it.locale,
        key: 'title',
        value: it.newValue,
        translatableContentDigest: digest,
      }));

      try {
        const data = await gql(TRANSLATIONS_REGISTER_MUTATION, {
          resourceId: collectionId,
          translations,
        });
        const ue = data.translationsRegister.userErrors;
        if (ue && ue.length > 0) {
          // Digest stale: refresh once and retry.
          const isDigestStale = ue.some((e) =>
            String(e.message || '').toLowerCase().includes('digest')
          );
          if (isDigestStale) {
            console.warn(`\n  ${handle}: digest stale, refreshing and retrying…`);
            digest = await refreshTitleDigest(collectionId);
            const retryTranslations = translations.map((t) => ({ ...t, translatableContentDigest: digest }));
            const retry = await gql(TRANSLATIONS_REGISTER_MUTATION, {
              resourceId: collectionId,
              translations: retryTranslations,
            });
            const retryUe = retry.translationsRegister.userErrors;
            if (retryUe && retryUe.length > 0) {
              errors++;
              console.error(`\n  ERR ${handle} [translationsRegister retry]: ${JSON.stringify(retryUe)}`);
            } else {
              registers += retry.translationsRegister.translations.length;
            }
          } else {
            errors++;
            console.error(`\n  ERR ${handle} [translationsRegister]: ${JSON.stringify(ue)}`);
          }
        } else {
          registers += data.translationsRegister.translations.length;
        }
      } catch (e) {
        errors++;
        console.error(`\n  THROW ${handle} [translationsRegister]: ${e.message}`);
      }
    }

    if (i % 10 === 0 || i === total) {
      process.stdout.write(`\rExecuting: ${i}/${total} collections  (updates=${updates}, registers=${registers}, errors=${errors})`);
    }
  }
  process.stdout.write('\n');
  return { updates, registers, errors };
}

// -----------------------------------------------------------------------------
// Step 7 — Dry-run rendering
// -----------------------------------------------------------------------------

function renderDryRun(plan, issues) {
  const totalEntries = plan.length;
  const changes = plan.filter((it) => it.changes);
  const noChange = plan.filter((it) => !it.changes);

  // Group changes by handle for a compact diff
  const byHandle = new Map();
  for (const it of changes) {
    if (!byHandle.has(it.handle)) byHandle.set(it.handle, []);
    byHandle.get(it.handle).push(it);
  }

  console.log('── Diff (changes only) ──');
  if (changes.length === 0) {
    console.log('  (nothing to change — already in target state)');
  } else {
    // Sort by handle for stable output
    const handles = [...byHandle.keys()].sort();
    for (const handle of handles) {
      const items = byHandle.get(handle).sort((a, b) =>
        TARGET_LOCALES.indexOf(a.locale) - TARGET_LOCALES.indexOf(b.locale)
      );
      console.log(`\n[${handle}]`);
      for (const it of items) {
        const before = it.oldValue == null ? '(vacío)' : JSON.stringify(it.oldValue);
        const after = JSON.stringify(it.newValue);
        console.log(`  ${it.locale.padEnd(6)}  ${before}  →  ${after}`);
      }
    }
  }

  console.log('\n── Summary ──');
  console.log(`  Total plan entries:       ${totalEntries}`);
  console.log(`  Changes (would write):    ${changes.length}`);
  console.log(`  No-change (idempotent):   ${noChange.length}`);
  if (issues.emptyCollections.length > 0) {
    console.log(`  Empty collections (skipped, productsCount=0): ${issues.emptyCollections.length}`);
    for (const h of issues.emptyCollections) console.log(`    - ${h}`);
  }
  if (issues.missingLocaleData.length > 0) {
    console.log(`  Missing locale data (skipped): ${issues.missingLocaleData.length}`);
    for (const m of issues.missingLocaleData) console.log(`    - ${m}`);
  }
  if (issues.inconsistencies.length > 0) {
    console.log(`  Cross-product inconsistencies (mode chosen): ${issues.inconsistencies.length}`);
    for (const m of issues.inconsistencies) console.log(`    - ${m}`);
  }
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

(async () => {
  console.log(`Shop:    ${SHOPIFY_STORE_DOMAIN}`);
  console.log(`API:     ${API_VERSION}`);
  console.log(`Mode:    ${DRY_RUN ? 'DRY RUN (no changes)' : 'EXECUTE'}`);
  console.log('');

  const { plan, issues } = await buildPlan();

  await writeFile(PLAN_FILE, JSON.stringify({ issues, plan }, null, 2));
  console.log(`Plan written to ${PLAN_FILE}.`);
  console.log('');

  renderDryRun(plan, issues);

  if (DRY_RUN) {
    console.log('\nDRY RUN — no mutations executed. Review the plan and re-run with DRY_RUN=false.');
    return;
  }

  console.log('\n── Executing mutations ──');
  const result = await executePlan(plan);
  console.log('');
  console.log(`Done.`);
  console.log(`  collectionUpdate calls (es):       ${result.updates}`);
  console.log(`  translationsRegister entries:      ${result.registers}`);
  console.log(`  Errors:                            ${result.errors}`);
  if (result.errors > 0) process.exit(1);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
