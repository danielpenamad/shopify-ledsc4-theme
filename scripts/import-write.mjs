#!/usr/bin/env node
// Shopify writer for the LedsC4 B2B Outlet import pipeline (Fase I3 / I3.5 / PR-X).
//
// Pipeline: samples → parser → mapper → writer → Shopify Admin API.
//
// Per SKU with would_publish=true, executes 3 mutations in order:
//   1. productSet — creates or updates the canonical product (ES primary).
//      Idempotent by handle = sku.toLowerCase().
//   2. translationsRegister — at the product resource (title, body_html) and
//      one call per translatable metafield (resourceId = metafield GID).
//   3. publishablePublish — publishes to "Tienda online" publication.
//
// Two callable surfaces:
//
//   - **CLI**:
//       node scripts/import-write.mjs                  # dry-run, full path
//       node scripts/import-write.mjs --apply          # full: products + translations + publish
//       node scripts/import-write.mjs --apply --stock-only        # only inventory levels
//       node scripts/import-write.mjs --apply --limit 5
//       node scripts/import-write.mjs --apply --sku 05-6396-21-M1
//       node scripts/import-write.mjs --samples-dir=samples
//       node scripts/import-write.mjs --apply --concurrency=4 --rate-cap=50 --rate-refill=10
//       node scripts/import-write.mjs --apply --with-db        # also upsert sku_state
//
//     Defaults: concurrency=4, rate-cap=50, rate-refill=10. The 10/sec
//     default matches Shopify Admin GraphQL on Basic (100 cost points/sec
//     restore, typical mutation costs ~10 points → ~10 ops/sec sustained
//     headroom). NOT the same as Shopify REST's 2 req/sec — that's a
//     separate API surface we don't use. The retry logic in gql() handles
//     the rare THROTTLED responses that may still slip through, so 10
//     is safe at default. Override with --rate-refill if your shop has
//     stricter limits or you're seeing sustained throttling.
//
//   - **Library**: import `runFullImport(options)` (PR-X) for the full
//     daily cron, OR `runStockOnly(options)` (PR-Y) for the 6h stock cron.
//     Both return { counts, fingerprints, reportPaths, elapsedMs, ... }.
//     Stock-only path: parses stock.csv only, resolves each SKU's
//     inventoryItem.id via productVariants(query: "sku:X"), then mutates
//     inventorySetQuantities. Skips SKUs not yet in Shopify with a warning.
//
// Convention with .env: prefix the command with --env-file:
//   node --env-file=shopify-ledsc4-theme.env scripts/import-write.mjs --apply
//
// Reports: <reportDir>/import-write-{ISO timestamp}/  (default <repo>/reports/)
//   - summary.txt
//   - changes.csv (1 row per processed SKU)
//
// Idempotency: re-running with the same inputs is safe.
//   - productSet uses handle as identifier → no duplicates.
//   - Files use duplicateResolutionMode=REPLACE → no duplicate media on re-run.
//   - translationsRegister with fresh digest is upsert by (resourceId, locale, key).
//   - publishablePublish on already-published resource is a no-op.
//   - Fingerprint upsert is by primary key (sku) → idempotent.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { parseSurtido, parseStock, parsePrecios } from './import-parse.mjs';
import { buildShopifyModel } from './import-map.mjs';
import { createTokenBucket, runWithConcurrency } from './rate-limiter.mjs';
import { buildSkuFingerprint, sortPayloadForFingerprint, buildStockFingerprint } from './fingerprint.mjs';
import { resolveImageToShopifyFileId } from './lib/image-upload.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const LOCALES = ['ES', 'EN', 'IT', 'DE', 'FR', 'PT'];
// Locales we register translations for (every non-primary locale that the
// shop accepts, regardless of storefront-published state — translations
// are stored even for unpublished locales).
const TRANSLATION_LOCALES = ['en', 'fr', 'de', 'it', 'pt-PT'];

// ----- helpers -----------------------------------------------------------

function nowIsoStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(arr) {
  return arr.map(csvEscape).join(',') + '\n';
}

function skuToHandle(sku) {
  // Shopify handles must be lowercase letters, numbers, hyphens.
  // Our SKUs are already URL-safe (verified via samples) so a lowercase
  // is sufficient.
  return String(sku).toLowerCase();
}

// Build a stable filename for a product image so re-runs match the existing
// file (REPLACE mode is keyed by filename).
//
// LedsC4 image URLs (https://files.ledsc4.com/main-photo/<SKU>) have no
// file extension. Shopify validates that "filename extension must match
// source": when the source URL has no extension, we omit the extension
// from the filename too. Format: "{sku}-{position}".
export function makeStableFilename(sku, position, url) {
  let ext = null;
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.([a-zA-Z0-9]{1,5})(?:[?#]|$)/);
    if (m) ext = m[1].toLowerCase();
  } catch {
    // URL parse failed — leave ext null.
  }
  const base = `${skuToHandle(sku)}-${position}`;
  return ext ? `${base}.${ext}` : base;
}

// ----- pure transformations (exported for unit tests) --------------------

// Build the ProductSetInput payload from a ProductModel produced by the mapper.
// Pure function: no I/O, no API calls.
//
// model: as returned by buildShopifyModel().products.get(sku) — must have publish=true.
// opts:
//   - locationId: gid://shopify/Location/* string (required).
//   - resolvedImages?: array aligned with model.product.images. Each entry is
//     either { fileId } (the helper successfully pre-uploaded the binary —
//     productSet should reuse the existing Shopify File via FileSetInput.id)
//     or null/undefined (the resolve failed — the slot is skipped to keep
//     productSet's userErrors clean; the writer logs a warning separately).
//     If absent, falls back to the legacy URL-based path (passes the CDN
//     URL straight to Shopify via originalSource — this only happens in
//     dry-run / tests now that PR-IMG-2 is in).
export function buildProductSetInput(model, opts) {
  if (!opts?.locationId) throw new Error('buildProductSetInput: opts.locationId is required');
  const { sku, product } = model;
  const handle = skuToHandle(sku);

  // Variant: the mapper produces exactly 1 variant per product.
  const v = product.variants[0];
  const variant = {
    sku: v.sku,
    optionValues: [{ optionName: 'Title', name: 'Default Title' }],
  };
  if (v.barcode != null && v.barcode !== '') variant.barcode = String(v.barcode);
  if (v.price != null) variant.price = String(v.price);
  if (v.inventory_quantity != null && Number.isFinite(v.inventory_quantity)) {
    variant.inventoryQuantities = [{
      locationId: opts.locationId,
      name: 'available',
      quantity: v.inventory_quantity,
    }];
  }
  variant.inventoryItem = { tracked: true };

  // Files (images). Two construction modes, decided per slot:
  //   - resolvedImages[idx].fileId set → use FileSetInput.id to reference an
  //     existing Shopify File (uploaded by lib/image-upload.mjs). productSet
  //     re-uses the file across products; idempotent on re-run because
  //     duplicateResolutionMode + the stable filename match the prior run.
  //   - resolvedImages[idx] missing or null → skip the slot. The pre-upload
  //     failed and we'd rather publish the product without that image than
  //     fall back to the CDN URL (which is what triggered the FAILED-by-429
  //     mess in the first place).
  //   - resolvedImages absent entirely (legacy / dry-run / unit tests) →
  //     pass the CDN URL via originalSource. This path is preserved so the
  //     existing buildProductSetInput tests stay valid without mocking the
  //     pre-upload helper.
  const resolvedImages = opts.resolvedImages;
  const files = [];
  for (let idx = 0; idx < product.images.length; idx++) {
    const img = product.images[idx];
    const filename = makeStableFilename(sku, img.position ?? idx, img.src);
    if (resolvedImages !== undefined) {
      const r = resolvedImages[idx];
      if (!r || !r.fileId) continue; // skip failed slot
      files.push({
        id: r.fileId,
        filename,
        duplicateResolutionMode: 'REPLACE',
      });
    } else {
      files.push({
        contentType: 'IMAGE',
        originalSource: img.src,
        filename,
        duplicateResolutionMode: 'REPLACE',
      });
    }
  }

  // Metafields — passed through as-is from the mapper, which already
  // serialized values to GraphQL-friendly strings.
  const metafields = product.metafields.map((mf) => ({
    namespace: mf.namespace,
    key: mf.key,
    type: mf.type,
    value: mf.value,
  }));

  const input = {
    handle,
    title: product.title,
    vendor: product.vendor,
    tags: product.tags,
    status: 'ACTIVE',
    productOptions: [{
      name: 'Title',
      values: [{ name: 'Default Title' }],
    }],
    variants: [variant],
    metafields,
  };
  if (product.body_html) input.descriptionHtml = String(product.body_html);
  if (files.length > 0) input.files = files;
  return input;
}

export function buildTranslations(model, translatableContent) {
  const byKey = new Map();
  for (const tc of translatableContent) byKey.set(tc.key, tc);

  const out = [];
  for (const locale of TRANSLATION_LOCALES) {
    const t = model.translations[locale];
    if (!t) continue;
    if (t.title) {
      const tc = byKey.get('title');
      if (tc) out.push({ locale, key: 'title', value: String(t.title), translatableContentDigest: tc.digest });
    }
    if (t.body_html) {
      const tc = byKey.get('body_html');
      if (tc) out.push({ locale, key: 'body_html', value: String(t.body_html), translatableContentDigest: tc.digest });
    }
  }
  return out;
}

export function buildMetafieldTranslationBatches(model, productMetafields, digestByResourceId) {
  const gidByKey = new Map();
  for (const mf of productMetafields) {
    if (mf.namespace === 'product') gidByKey.set(mf.key, mf.id);
  }

  const esValueByKey = new Map();
  for (const mf of model.product.metafields) {
    if (mf.namespace === 'product') esValueByKey.set(mf.key, String(mf.value ?? ''));
  }

  const translatableKeys = new Set();
  for (const locale of TRANSLATION_LOCALES) {
    const t = model.translations[locale];
    if (!t || !t.metafields) continue;
    for (const mf of t.metafields) translatableKeys.add(mf.key);
  }

  const batches = [];
  for (const key of translatableKeys) {
    const gid = gidByKey.get(key);
    if (!gid) continue;
    const digest = digestByResourceId.get(gid);
    if (!digest) continue;
    const esValue = esValueByKey.get(key) ?? '';

    const translations = [];
    for (const locale of TRANSLATION_LOCALES) {
      const t = model.translations[locale];
      if (!t || !t.metafields) continue;
      const mf = t.metafields.find((m) => m.key === key);
      if (!mf) continue;
      const value = String(mf.value ?? '').trim();
      if (value === '') continue;
      if (value === esValue.trim()) continue;
      translations.push({
        locale,
        key: 'value',
        value,
        translatableContentDigest: digest,
      });
    }

    if (translations.length > 0) {
      // Note: metafieldKey added to enable fingerprint composition by stable
      // namespace.key (resourceId is Shopify-assigned, can vary on re-create).
      batches.push({ resourceId: gid, metafieldKey: `product.${key}`, translations });
    }
  }

  return batches;
}

// ----- API client (parameterized via ctx) --------------------------------

// ctx shape: { endpoint, token, fetch, bucket } where bucket is the rate
// limiter token bucket (see rate-limiter.mjs).
//
// Throttling: Shopify expresses cost-bucket exhaustion two ways:
//   - HTTP 429 with optional `Retry-After` header (REST-style fallback).
//   - HTTP 200 with errors[].extensions.code === 'THROTTLED' (the GraphQL
//     way — the body parses fine, the throttle is just signalled inside).
// On either, we pause the shared bucket so ALL workers back off in unison,
// then RETRY the same call up to MAX_RETRIES with exponential backoff.
// Without retry, a single throttle would lose that SKU's run; with it, the
// caller doesn't see the bump.
const MAX_RETRIES = 4;

async function gql(ctx, query, variables) {
  let attempt = 0;
  while (true) {
    // Acquire a rate-limit token before each attempt. We treat queries and
    // mutations as 1 token each (conservative — a real cost-aware limiter
    // would weight mutations heavier, but the bucket params are tunable so
    // operators can dial in for their plan).
    if (ctx.bucket) await ctx.bucket.acquire(1);

    let res;
    try {
      res = await ctx.fetch(ctx.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': ctx.token,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      // Network errors get one retry too.
      if (attempt < MAX_RETRIES) {
        const backoff = 500 * Math.pow(2, attempt) + Math.random() * 250;
        if (ctx.bucket) ctx.bucket.pause(backoff);
        attempt++;
        continue;
      }
      throw new Error(`network error after ${attempt} retries: ${err.message ?? err}`);
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After');
      const ms = retryAfter
        ? Math.max(1000, Math.ceil(parseFloat(retryAfter) * 1000))
        : 2000 * Math.pow(2, attempt);
      if (ctx.bucket) ctx.bucket.pause(ms + 250); // small jitter
      if (attempt < MAX_RETRIES) {
        attempt++;
        continue;
      }
      throw new Error(`HTTP 429 — exhausted ${MAX_RETRIES} retries`);
    }

    // Transient 5xx (502 bad gateway, 503 service unavailable, 504 gateway
    // timeout) — Shopify's edge / CDN can hiccup. Retry with backoff.
    if (res.status >= 500 && res.status < 600) {
      if (attempt < MAX_RETRIES) {
        const backoff = 1000 * Math.pow(2, attempt) + Math.random() * 500;
        if (ctx.bucket) ctx.bucket.pause(backoff);
        attempt++;
        continue;
      }
      const body = await res.text();
      throw new Error(`HTTP ${res.status} ${res.statusText} after ${MAX_RETRIES} retries — ${body.slice(0, 200)}`);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${body}`);
    }
    const json = await res.json();
    if (json.errors) {
      const throttled = (json.errors ?? []).find((e) => e?.extensions?.code === 'THROTTLED');
      if (throttled) {
        const backoff = 1500 * Math.pow(2, attempt) + Math.random() * 500;
        if (ctx.bucket) ctx.bucket.pause(backoff);
        if (attempt < MAX_RETRIES) {
          attempt++;
          continue;
        }
        throw new Error(`THROTTLED — exhausted ${MAX_RETRIES} retries`);
      }
      throw new Error(JSON.stringify(json.errors));
    }
    return json.data;
  }
}

const PRODUCT_SET_MUTATION = `
  mutation productSet($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
    productSet(input: $input, synchronous: true, identifier: $identifier) {
      product {
        id
        handle
        variants(first: 5) { nodes { id sku } }
        metafields(first: 50) { nodes { id namespace key } }
      }
      userErrors { field message code }
    }
  }
`;

const TRANSLATABLE_QUERY = `
  query TranslatableContent($id: ID!) {
    translatableResource(resourceId: $id) {
      translatableContent { key digest }
    }
  }
`;

const TRANSLATABLE_BY_IDS_QUERY = `
  query TranslatableByIds($ids: [ID!]!) {
    translatableResourcesByIds(resourceIds: $ids, first: 50) {
      nodes {
        resourceId
        translatableContent { key digest }
      }
    }
  }
`;

const TRANSLATIONS_REGISTER = `
  mutation translationsRegister($resourceId: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $resourceId, translations: $translations) {
      translations { locale key value }
      userErrors { field message code }
    }
  }
`;

const PUBLISHABLE_PUBLISH = `
  mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

async function fetchShopContext(ctx) {
  const data = await gql(ctx, `
    query ShopContext {
      publications(first: 20) { nodes { id name } }
      locations(first: 5) { nodes { id } }
    }
  `);
  const onlineStore = data.publications.nodes.find((p) => p.name === 'Tienda online' || p.name === 'Online Store');
  if (!onlineStore) throw new Error(`Could not find "Tienda online" publication. Available: ${data.publications.nodes.map((p) => p.name).join(', ')}`);
  const firstLoc = data.locations.nodes[0];
  if (!firstLoc) throw new Error('No location found.');
  return { onlineStorePublicationId: onlineStore.id, locationId: firstLoc.id };
}

async function productSet(ctx, input) {
  const data = await gql(ctx, PRODUCT_SET_MUTATION, {
    input,
    identifier: { handle: input.handle },
  });
  const errors = data.productSet.userErrors ?? [];
  return { product: data.productSet.product, errors };
}

async function fetchTranslatable(ctx, productId) {
  const data = await gql(ctx, TRANSLATABLE_QUERY, { id: productId });
  return data.translatableResource?.translatableContent ?? [];
}

async function fetchMetafieldDigests(ctx, metafieldIds) {
  if (metafieldIds.length === 0) return new Map();
  const data = await gql(ctx, TRANSLATABLE_BY_IDS_QUERY, { ids: metafieldIds });
  const out = new Map();
  for (const node of data.translatableResourcesByIds?.nodes ?? []) {
    const tc = node.translatableContent?.[0];
    if (tc?.digest) out.set(node.resourceId, tc.digest);
  }
  return out;
}

async function registerTranslations(ctx, resourceId, translations) {
  if (translations.length === 0) return { registered: 0, errors: [] };
  const data = await gql(ctx, TRANSLATIONS_REGISTER, { resourceId, translations });
  const errors = data.translationsRegister.userErrors ?? [];
  return { registered: data.translationsRegister.translations.length, errors };
}

async function publishProduct(ctx, productId, publicationId) {
  const data = await gql(ctx, PUBLISHABLE_PUBLISH, {
    id: productId,
    input: [{ publicationId }],
  });
  const errors = data.publishablePublish.userErrors ?? [];
  return { errors };
}

// ----- API client: I3.6 unpublish-orphans path --------------------------

// Lookup product GID + status from a SKU. Used by the unpublish-orphans
// phase to resolve which Shopify product to flip to DRAFT for SKUs that
// exist in private.sku_state with last_published=true but are no longer
// in the current run's publishables. The `node.sku !== sku` exact-match
// check defends against Shopify's fuzzy variant search.
const ORPHAN_LOOKUP_QUERY = `
  query OrphanLookup($q: String!) {
    productVariants(first: 1, query: $q) {
      nodes {
        sku
        product { id status }
      }
    }
  }
`;

// productUpdate returns `UserError` (only `field` + `message`), NOT
// `ProductUserError` (which has `code`). Selecting `code` here makes
// GraphQL reject the mutation with `undefinedField`. productSet's
// userErrors are `ProductUserError` and DO have `code` — the asymmetry
// is intentional in Shopify's API.
const PRODUCT_UPDATE_STATUS_MUTATION = `
  mutation productUpdateStatus($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id status }
      userErrors { field message }
    }
  }
`;

// Compute SKUs that need unpublishing: rows in sku_state whose
// last_published=true that are NOT in the current run's publishables.
//
// Inputs:
//   publishableSkus:    Iterable<string> — SKUs the writer will publish this run.
//   priorPublishedSkus: Iterable<string> — SKUs from sku_state where last_published=true.
//                       Caller is responsible for filtering on last_published=true
//                       before passing in (so a SKU currently in publishables that
//                       was previously NOT published is correctly excluded — it'll
//                       be turned ACTIVE by the regular productSet path, not by us).
//
// Returns: sorted array of SKU strings.
//
// Pure: testable in isolation. No I/O, no side effects.
export function buildOrphansToUnpublish(publishableSkus, priorPublishedSkus) {
  const pub = new Set(publishableSkus);
  const out = [];
  for (const sku of priorPublishedSkus) {
    if (!pub.has(sku)) out.push(sku);
  }
  out.sort();
  return out;
}

async function fetchProductIdBySku(ctx, sku) {
  const data = await gql(ctx, ORPHAN_LOOKUP_QUERY, { q: `sku:${sku}` });
  const node = data.productVariants?.nodes?.[0];
  if (!node || node.sku !== sku) return null;
  return node.product?.id ?? null;
}

async function productUpdateStatus(ctx, productId, status) {
  const data = await gql(ctx, PRODUCT_UPDATE_STATUS_MUTATION, {
    input: { id: productId, status },
  });
  return {
    errors: data.productUpdate.userErrors ?? [],
    product: data.productUpdate.product,
  };
}

// Process one orphan SKU: resolve its product GID, flip status to DRAFT.
// Returns one of:
//   { sku, status: 'ok',        productId, errors: [] }
//   { sku, status: 'failed',    productId, errors: [...] }     // unexpected/userErrors
//   { sku, status: 'not_found', productId: null, errors: [] }  // SKU no longer in shop
async function processUnpublishOrphan(ctx, sku) {
  let productId = null;
  try {
    productId = await fetchProductIdBySku(ctx, sku);
  } catch (err) {
    return { sku, status: 'failed', productId: null, errors: [{ message: err.message }] };
  }
  if (!productId) return { sku, status: 'not_found', productId: null, errors: [] };
  try {
    const r = await productUpdateStatus(ctx, productId, 'DRAFT');
    if (r.errors.length > 0) return { sku, status: 'failed', productId, errors: r.errors };
    return { sku, status: 'ok', productId, errors: [] };
  } catch (err) {
    return { sku, status: 'failed', productId, errors: [{ message: err.message }] };
  }
}

// ----- API client: stock-only path --------------------------------------

const VARIANT_BY_SKU_QUERY = `
  query VariantBySku($q: String!) {
    productVariants(first: 1, query: $q) {
      nodes {
        id
        sku
        inventoryItem { id }
      }
    }
  }
`;

const INVENTORY_SET_QUANTITIES_MUTATION = `
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup { id reason }
      userErrors { field message code }
    }
  }
`;

// Resolve a SKU to its inventoryItem GID via productVariants(query). Returns
// null if no variant matches (SKU not yet in Shopify) — caller skips with a
// warning. Shopify SKU search uses query syntax: `sku:<value>`. SKUs with
// special chars need quoting; ours are URL-safe so simple interpolation is OK.
async function fetchInventoryItemBySku(ctx, sku) {
  const data = await gql(ctx, VARIANT_BY_SKU_QUERY, { q: `sku:${sku}` });
  const node = data.productVariants?.nodes?.[0];
  if (!node) return null;
  // Shopify's variant query is fuzzy-ish; verify exact SKU match before trusting.
  if (node.sku !== sku) return null;
  return node.inventoryItem?.id ?? null;
}

async function setInventoryQuantity(ctx, inventoryItemId, locationId, quantity, reason = 'correction') {
  // API version note: Shopify renamed the CAS field over time.
  // - 2025-10 (current pin): `ignoreCompareQuantity: true` at top level skips
  //   the compare-and-set check.
  // - Later versions (>=2026-01): per-item `changeFromQuantity: null` instead.
  // We're the source of truth for inventory in this app — skip the CAS check.
  const data = await gql(ctx, INVENTORY_SET_QUANTITIES_MUTATION, {
    input: {
      reason,
      name: 'available',
      ignoreCompareQuantity: true,
      referenceDocumentUri: 'gid://ledsc4-importer/StockSync/cron',
      quantities: [{
        inventoryItemId,
        locationId,
        quantity,
      }],
    },
  });
  const errors = data.inventorySetQuantities.userErrors ?? [];
  return { errors, group: data.inventorySetQuantities.inventoryAdjustmentGroup };
}

// ----- model loading -----------------------------------------------------

async function loadMapping(mappingPath) {
  const text = await readFile(mappingPath, 'utf8');
  return JSON.parse(text);
}

async function buildModelFromSamples({ samplesDir, mappingPath }) {
  const mapping = await loadMapping(mappingPath);
  const surtidoPaths = LOCALES.map((loc) => ({
    locale: loc,
    path: join(samplesDir, 'productos', `listado_productos_${loc}.csv`),
  }));
  const [surtidoResults, stockResult, preciosResult] = await Promise.all([
    Promise.all(surtidoPaths.map((p) => parseSurtido(p.path, p.locale).then((r) => ({ ...r, locale: p.locale })))),
    parseStock(join(samplesDir, 'stock', 'stock.csv')),
    parsePrecios(join(samplesDir, 'precios', 'precios_productos.csv')),
  ]);
  const surtidoByLocale = new Map();
  for (const sr of surtidoResults) surtidoByLocale.set(sr.locale, sr);
  return buildShopifyModel({ surtidoByLocale, stock: stockResult, precios: preciosResult, mapping });
}

// ----- pre-upload + media polling (PR-IMG-2) ----------------------------

// Resolve every image of a SKU to a Shopify File GID via the pre-upload
// helper, in parallel. The CDN bucket inside resolveImageToShopifyFileId
// serializes ALL fetches against files.ledsc4.com globally (across all
// SKUs and all workers in this run) — Promise.all here just lets the
// helper exploit the bucket between waiters without artificial fanout.
//
// Returns { resolved, warnings }:
//   - resolved[i]: { fileId, fromCache, sha256, mimeType } | null
//   - warnings: array of { kind, message, position, url } for each failure.
//
// Never throws; failures are downgraded to null entries + warnings.
export async function resolveImagesForSku({ model, ctx, cdnBucket, dbConnection, fetchImpl, pollMs, pollMaxMs }) {
  const images = model.product.images ?? [];
  if (images.length === 0) return { resolved: [], warnings: [] };

  const results = await Promise.all(images.map((img) =>
    resolveImageToShopifyFileId({
      url: img.src,
      ctx,
      cdnBucket,
      dbConnection,
      fetchImpl,
      pollMs,
      pollMaxMs,
    })
  ));

  const resolved = [];
  const warnings = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const img = images[i];
    if (r.ok) {
      resolved.push({
        fileId: r.fileId,
        fromCache: r.fromCache,
        sha256: r.sha256,
        mimeType: r.mimeType,
      });
    } else {
      resolved.push(null);
      warnings.push({
        kind: 'image_resolve_failed',
        position: img.position ?? i,
        url: img.src,
        resolveKind: r.kind,
        message: r.message,
      });
    }
  }
  return { resolved, warnings };
}

// Truncate to 200 chars (per PR-IMG-2 contract for media_first_error).
function truncate200(s) {
  if (!s) return '';
  const str = String(s);
  return str.length > 200 ? str.slice(0, 200) : str;
}

const PRODUCT_MEDIA_QUERY = `
  query ProductMedia($id: ID!) {
    product(id: $id) {
      media(first: 50) {
        nodes {
          ... on MediaImage { status mediaErrors { code details message } }
          ... on Video { status: mediaContentType }
          ... on Model3d { status: mediaContentType }
        }
      }
    }
  }
`;

// We only ever attach IMAGE media in this writer, but query non-image
// types defensively so the polling never crashes if a stray Video/Model3d
// shows up (manual upload by staff, future content types, …). Treat
// non-image media as READY for our purposes — they are not the failure
// mode we're tracking.
const PRODUCT_MEDIA_QUERY_SAFE = `
  query ProductMediaSafe($id: ID!) {
    product(id: $id) {
      media(first: 50) {
        nodes {
          __typename
          ... on MediaImage { status mediaErrors { code details message } }
        }
      }
    }
  }
`;

// Poll product.media[*].status after productSet returns OK. PR-IMG-2:
// because image binaries are pre-uploaded as READY Shopify Files BEFORE
// productSet runs, the cloned MediaImage on the product should also be
// READY almost immediately — the polling exists as defense-in-depth and
// to surface the rare Shopify-side failures we already saw in diagnosis
// (e.g. pixel-limit exceeded on PX-0504-ANT). 15s ceiling matches
// pollMaxMs default; pollMs=500 gives a fast-enough first reading without
// hammering the API. Both tunable per call.
//
// Returns { ready, failed, processing, firstError } where firstError is
// the first FAILED node's mediaErrors[0].details (truncated to 200 chars).
// firstError is '' when failed=0.
export async function pollProductMediaStatus(ctx, productId, { pollMs, pollMaxMs }) {
  const deadline = Date.now() + pollMaxMs;
  let lastSnapshot = { ready: 0, failed: 0, processing: 0, firstError: '' };
  while (true) {
    const data = await gql(ctx, PRODUCT_MEDIA_QUERY_SAFE, { id: productId });
    const nodes = data.product?.media?.nodes ?? [];
    let ready = 0, failed = 0, processing = 0;
    let firstError = '';
    for (const n of nodes) {
      if (n.__typename !== 'MediaImage') {
        // Non-image: count as ready (out of scope for this metric).
        ready++;
        continue;
      }
      if (n.status === 'READY') ready++;
      else if (n.status === 'FAILED') {
        failed++;
        if (!firstError) {
          const e = n.mediaErrors?.[0];
          firstError = truncate200(e?.details ?? e?.message ?? 'unknown');
        }
      } else processing++; // UPLOADED / PROCESSING
    }
    lastSnapshot = { ready, failed, processing, firstError };
    if (processing === 0) return lastSnapshot;
    if (Date.now() >= deadline) return lastSnapshot;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ----- per-SKU processor -------------------------------------------------

// The full flow for one SKU:
//   0. resolveImagesForSku — pre-upload images to Shopify Files (PR-IMG-2).
//   1. productSet — create/update product + link the pre-uploaded Files.
//   2. translationsRegister at PRODUCT and at METAFIELD level.
//   3. publishablePublish.
//   4. pollProductMediaStatus — defense-in-depth (PR-IMG-2).
//
// Designed to run inside runWithConcurrency. Returns a shape that the
// orchestrator converts to a CSV row + accumulates into counts.
async function processSku({ ctx, model, locationId, publicationId, cdnBucket, dbConnection, fetchImpl, mediaPollMs, mediaPollMaxMs, imageFetchTimeoutMs, imageFilePollMs, imageFilePollMaxMs }) {
  const sku = model.sku;
  const handle = skuToHandle(sku);

  // 0. Pre-upload images. Resolve failures are non-fatal — we still create
  //    the product without the failed slots and surface the warning.
  const imageResolution = await resolveImagesForSku({
    model,
    ctx,
    cdnBucket,
    dbConnection,
    fetchImpl,
    pollMs: imageFilePollMs,
    pollMaxMs: imageFilePollMaxMs,
  });

  const productSetInput = buildProductSetInput(model, {
    locationId,
    resolvedImages: imageResolution.resolved,
  });

  // 1. productSet
  let productId = null;
  let productMetafields = [];
  let psErrors = [];
  try {
    const r = await productSet(ctx, productSetInput);
    psErrors = r.errors;
    productId = r.product?.id ?? null;
    productMetafields = r.product?.metafields?.nodes ?? [];
    if (psErrors.length > 0 || !productId) {
      return {
        sku, handle, productId,
        productSet: { ok: false, errors: psErrors },
        productTranslations: { registered: 0, errors: [] },
        metafieldTranslations: { entries: 0, batches_ok: 0, batches_failed: 0, errors: [] },
        publish: { ok: false, skipped: true, errors: [] },
        media: { ready: 0, failed: 0, processing: 0, firstError: '' },
        imageResolution,
        fingerprint: null,
      };
    }
  } catch (err) {
    return {
      sku, handle, productId,
      productSet: { ok: false, errors: [{ message: err.message }] },
      productTranslations: { registered: 0, errors: [] },
      metafieldTranslations: { entries: 0, batches_ok: 0, batches_failed: 0, errors: [] },
      publish: { ok: false, skipped: true, errors: [] },
      media: { ready: 0, failed: 0, processing: 0, firstError: '' },
      imageResolution,
      fingerprint: null,
    };
  }

  // 2. translationsRegister at PRODUCT (title, body_html)
  let productTranslations = [];
  let productTranslationsRegistered = 0;
  let trErrors = [];
  try {
    const tc = await fetchTranslatable(ctx, productId);
    productTranslations = buildTranslations(model, tc);
    const r = await registerTranslations(ctx, productId, productTranslations);
    productTranslationsRegistered = r.registered;
    trErrors = r.errors;
  } catch (err) {
    trErrors = [{ message: err.message }];
  }

  // 2b. translationsRegister at METAFIELD resources
  let mfBatches = [];
  let mfRegistered = 0;
  let mfBatchesOk = 0;
  let mfBatchesFailed = 0;
  let mfErrors = [];
  try {
    const translatableKeys = new Set();
    for (const locale of TRANSLATION_LOCALES) {
      const t = model.translations[locale];
      for (const mf of (t?.metafields ?? [])) translatableKeys.add(mf.key);
    }
    const translatableGids = productMetafields
      .filter((mf) => mf.namespace === 'product' && translatableKeys.has(mf.key))
      .map((mf) => mf.id);
    const digestByResourceId = await fetchMetafieldDigests(ctx, translatableGids);

    mfBatches = buildMetafieldTranslationBatches(model, productMetafields, digestByResourceId);
    for (const batch of mfBatches) {
      try {
        const r = await registerTranslations(ctx, batch.resourceId, batch.translations);
        if (r.errors.length > 0) {
          mfBatchesFailed++;
          mfErrors.push(...r.errors);
        } else {
          mfBatchesOk++;
          mfRegistered += r.registered;
        }
      } catch (err) {
        mfBatchesFailed++;
        mfErrors.push({ message: err.message });
      }
    }
  } catch (err) {
    mfErrors.push({ message: err.message });
  }

  // 3. publishablePublish
  let pubOk = false;
  let pubErrors = [];
  try {
    const r = await publishProduct(ctx, productId, publicationId);
    pubErrors = r.errors;
    pubOk = pubErrors.length === 0;
  } catch (err) {
    pubErrors = [{ message: err.message }];
  }

  // 4. Poll product.media[*].status (PR-IMG-2). Defense-in-depth: with
  //    pre-uploaded Files this should be near-instant READY for every
  //    image. We still poll because Shopify can FAIL the cloned media
  //    post-association (e.g. pixel-limit, format edge cases) and we
  //    want that visible in changes.csv. Errors here are downgraded to
  //    a snapshot of zeros — a polling glitch shouldn't block the run.
  //
  //    Skip when we didn't successfully send any image to productSet:
  //    productSet with an empty files[] does NOT touch existing media
  //    (declarative semantics omit the field), so polling would just
  //    surface stale state from previous runs that this run didn't act
  //    on. Resolve-side warnings still feed WARN status via the
  //    imageResolution check below.
  let mediaSnapshot = { ready: 0, failed: 0, processing: 0, firstError: '' };
  const sentAnyImage = imageResolution.resolved.some((r) => r && r.fileId);
  if (sentAnyImage) {
    try {
      mediaSnapshot = await pollProductMediaStatus(ctx, productId, {
        pollMs: mediaPollMs,
        pollMaxMs: mediaPollMaxMs,
      });
    } catch (err) {
      mediaSnapshot = { ready: 0, failed: 0, processing: 0, firstError: truncate200(`poll error: ${err?.message ?? err}`) };
    }
  }

  // 5. Fingerprint — only computed if all 3 stages succeeded (a partial
  //    run produced a partial state; we don't want to record it as the
  //    canonical fingerprint until the next successful run). Note: we
  //    do NOT include mediaSnapshot in this gate. WARN states (READY
  //    + FAILED mix or stuck PROCESSING) still produce a fingerprint
  //    because the product itself is correctly created/translated/
  //    published; the next cron will retry the FAILED slots via the
  //    normal pre-upload path (cache hits for the OK ones, fresh attempt
  //    for the failures).
  let fingerprint = null;
  const fullSuccess =
    psErrors.length === 0 &&
    trErrors.length === 0 &&
    mfBatchesFailed === 0 &&
    pubOk;
  if (fullSuccess) {
    const sortedInput = sortPayloadForFingerprint({ ...productSetInput });
    fingerprint = buildSkuFingerprint({
      sku,
      productSetInput: sortedInput,
      productTranslations,
      metafieldTranslationBatches: mfBatches,
      publicationId,
    });
  }

  return {
    sku, handle, productId,
    productSet: { ok: psErrors.length === 0, errors: psErrors },
    productTranslations: { registered: productTranslationsRegistered, errors: trErrors },
    metafieldTranslations: { entries: mfRegistered, batches_ok: mfBatchesOk, batches_failed: mfBatchesFailed, errors: mfErrors },
    publish: { ok: pubOk, skipped: false, errors: pubErrors },
    media: mediaSnapshot,
    imageResolution,
    fingerprint,
  };
}

// ----- runFullImport (exported library entrypoint) ----------------------

/**
 * Orchestrates a full import over publishable SKUs.
 *
 * @param {object} options
 * @param {string} options.samplesDir          Path to dir with the 8 CSVs.
 * @param {string} [options.mappingPath]       Path to mapping.json. Default: <repoRoot>/scripts/mapping.json
 * @param {string} options.reportDir           Directory where reports/ go. New dated subdir created inside.
 * @param {boolean} options.applyMode          false → dry-run, no Shopify calls.
 * @param {string|null} [options.skuFilter]    If set, only process this SKU.
 * @param {number|null} [options.limit]        If set, only process the first N SKUs.
 * @param {(msg:string)=>void} [options.onProgress]   Optional progress logger.
 * @param {object} [options.dbConnection]      Optional open pg.Client (or any { query(sql, params) → Promise } shape). If set, fingerprints are upserted into private.sku_state. Caller manages connect/end.
 * @param {string|null} [options.runId]        Optional uuid stored as last_run_id in sku_state.
 * @param {{capacity:number, refillPerSec:number}} [options.rateLimit]   Rate limiter config. Default {capacity:50, refillPerSec:10} — matches Shopify Admin GraphQL Basic cost-point restore (100/s, ~10 ops/s for typical mutations). The 10/s default is safe because gql() retries 429/THROTTLED with backoff.
 * @param {{capacity:number, refillPerSec:number}} [options.cdnRateLimit]   Rate limiter config for fetches against the supplier CDN (files.ledsc4.com). Default {capacity:1, refillPerSec: 1/1.5} — i.e. 1 request per 1.5s, which the diagnostic on 2026-05-10 proved keeps the CDN's anti-flood from triggering (336 sequential HEADs at this pace = 0 × 429). Tunable down to make backfills faster once the CDN stops biting.
 * @param {number} [options.mediaPollMs]       Poll interval for product.media[*].status after productSet (PR-IMG-2). Default 500ms.
 * @param {number} [options.mediaPollMaxMs]    Ceiling for product-media polling. Default 15_000ms (per PR-IMG-2 contract). With pre-uploaded Files this is overkill — the cloned MediaImage is usually READY on the first poll — but it absorbs Shopify-side post-association failures (pixel limit, format edge cases) without making us wait on stuck PROCESSING.
 * @param {number} [options.concurrency]       Worker pool size. Default 4.
 * @param {string} [options.shopifyDomain]     Override SHOPIFY_STORE_DOMAIN.
 * @param {string} [options.shopifyToken]      Override SHOPIFY_ADMIN_TOKEN.
 * @param {string} [options.apiVersion]        Override SHOPIFY_API_VERSION. Default '2025-10'.
 * @param {typeof fetch} [options.fetch]       Override fetch (used by tests to mock).
 *
 * @returns {Promise<{
 *   counts: object,
 *   sampleProductIds: Array<{sku:string, productId:string}>,
 *   fingerprints: Record<string, {fingerprint:string, last_published:boolean}>,
 *   reportPaths: { summary:string, changes:string },
 *   elapsedMs: number,
 *   reportDir: string,
 * }>}
 */
export async function runFullImport(options = {}) {
  const t0 = Date.now();

  const samplesDir = options.samplesDir ?? resolve(REPO_ROOT, 'samples');
  const mappingPath = options.mappingPath ?? resolve(REPO_ROOT, 'scripts', 'mapping.json');
  const reportRoot = options.reportDir ?? resolve(REPO_ROOT, 'reports');
  const applyMode = options.applyMode === true;
  const skuFilter = options.skuFilter ?? null;
  const limit = Number.isFinite(options.limit) ? options.limit : null;
  const onProgress = options.onProgress ?? ((msg) => console.log(msg));
  const concurrency = Number.isFinite(options.concurrency) ? options.concurrency : 4;
  const rateLimit = options.rateLimit ?? { capacity: 50, refillPerSec: 10 };
  // PR-IMG-2: 1 request every 1.5s is the politeness SLA proven safe by
  // the diagnostic. Override via options.cdnRateLimit to speed up once
  // we have telemetry confirming the CDN tolerates more.
  const cdnRateLimit = options.cdnRateLimit ?? { capacity: 1, refillPerSec: 1 / 1.5 };
  const mediaPollMs = Number.isFinite(options.mediaPollMs) ? options.mediaPollMs : 500;
  const mediaPollMaxMs = Number.isFinite(options.mediaPollMaxMs) ? options.mediaPollMaxMs : 15_000;

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const shopifyDomain = options.shopifyDomain ?? process.env.SHOPIFY_STORE_DOMAIN;
  const shopifyToken = options.shopifyToken ?? process.env.SHOPIFY_ADMIN_TOKEN;
  const apiVersion = options.apiVersion ?? process.env.SHOPIFY_API_VERSION ?? '2025-10';

  if (applyMode && (!shopifyDomain || !shopifyToken)) {
    throw new Error('applyMode=true requires shopifyDomain + shopifyToken (or SHOPIFY_STORE_DOMAIN + SHOPIFY_ADMIN_TOKEN env)');
  }

  onProgress(`${applyMode ? '' : '[dry-run] '}Reading samples from: ${samplesDir}`);
  const { products } = await buildModelFromSamples({ samplesDir, mappingPath });

  // Filter to publishable; optionally restrict via limit / skuFilter.
  let publishables = [];
  for (const [sku, m] of products) if (m.publish) publishables.push({ sku, model: m });
  let hidden = 0;
  for (const [, m] of products) if (!m.publish) hidden++;
  if (skuFilter) publishables = publishables.filter((p) => p.sku === skuFilter);
  else if (limit != null) publishables = publishables.slice(0, limit);

  onProgress(`${publishables.length} SKUs to write (${hidden} hidden, skipped).`);

  // Resolve shop context once.
  let publicationId = null;
  let locationId = null;
  let ctx = null;
  // CDN bucket is shared across all SKUs/workers in this run. Created
  // outside the applyMode branch only because it's safe to construct
  // unconditionally (cheap, no I/O); only used in applyMode.
  const cdnBucket = createTokenBucket(cdnRateLimit);
  if (applyMode) {
    const bucket = createTokenBucket(rateLimit);
    ctx = {
      endpoint: `https://${shopifyDomain}/admin/api/${apiVersion}/graphql.json`,
      token: shopifyToken,
      fetch: fetchImpl,
      bucket,
    };
    const shopCtx = await fetchShopContext(ctx);
    publicationId = shopCtx.onlineStorePublicationId;
    locationId = shopCtx.locationId;
    onProgress(`Publication: ${publicationId}; Location: ${locationId}`);
    onProgress(`Rate limit: capacity=${rateLimit.capacity}, refill=${rateLimit.refillPerSec}/sec, concurrency=${concurrency}`);
    onProgress(`CDN limit: capacity=${cdnRateLimit.capacity}, refill=${cdnRateLimit.refillPerSec.toFixed(3)}/sec (files.ledsc4.com)`);
    onProgress(`Media polling: every ${mediaPollMs}ms up to ${mediaPollMaxMs}ms per SKU`);
  } else {
    locationId = 'gid://shopify/Location/PLACEHOLDER';
    publicationId = 'gid://shopify/Publication/PLACEHOLDER';
  }

  // Reports dir.
  const ts = nowIsoStamp();
  const reportDir = join(reportRoot, `import-write-${ts}`);
  await mkdir(reportDir, { recursive: true });

  // Build CSV header + hidden rows up-front (those don't need work).
  // PR-IMG-2: 4 new columns sit between publish_errors and overall, with
  // counts of MediaImage nodes by status after polling and the first
  // failure detail (truncated to 200 chars). HIDDEN/SKIPPED rows leave
  // them blank — those SKUs were never sent to Shopify so there's no
  // media to count.
  let changesCsv = csvRow([
    'sku', 'handle', 'product_id', 'product_set_status', 'product_set_errors',
    'product_translations_registered', 'metafield_translations_registered',
    'translation_errors',
    'publish_status', 'publish_errors',
    'media_ready_count', 'media_failed_count', 'media_processing_count', 'media_first_error',
    'overall',
  ]);
  for (const [sku, m] of products) {
    if (m.publish) continue;
    if (skuFilter && sku !== skuFilter) continue;
    changesCsv += csvRow([
      sku, skuToHandle(sku), '', `SKIPPED:${m.publish_reason ?? 'unknown'}`, '',
      '', '', '', 'SKIPPED', '',
      '', '', '', '',
      'HIDDEN',
    ]);
  }

  const counts = {
    productSet: { ok: 0, failed: 0 },
    translations: { ok: 0, failed: 0, skipped: 0 },
    metafield_translations: { entries_written: 0, batches_ok: 0, batches_failed: 0 },
    publish: { ok: 0, failed: 0, skipped: 0 },
    skus: { ok: 0, warn: 0, failed: 0 },
    // PR-IMG-2: aggregate media-status counts across the run, plus pre-
    // upload resolution stats. media.warn = SKUs whose all-other-stages
    // are OK but at least one MediaImage ended FAILED or stuck PROCESSING
    // — surfaced separately because that's exactly the recoverable state
    // the next cron heals via cache-driven re-tries.
    media: { ready: 0, failed: 0, processing: 0, warn_skus: 0 },
    image_resolution: { resolved_ok: 0, from_cache: 0, freshly_uploaded: 0, failed_slots: 0 },
    // Tracks DB upserts (PR-Y fix). Only meaningful when options.dbConnection
    // is set; otherwise both stay 0.
    sku_state: { upserted_ok: 0, upsert_failed: 0 },
    // I3.6: SKUs that we've previously published but aren't in this run's
    // publishables (descatalogados, sin stock, sin precio…). They get
    // status:DRAFT in Shopify and last_published=false in sku_state.
    // Only populated when options.dbConnection is set.
    unpublished_orphans: { ok: 0, failed: 0, not_found: 0 },
  };
  const fingerprints = {};

  // ---- DRY-RUN path: no Shopify calls, build CSV from model alone ----
  if (!applyMode) {
    for (let i = 0; i < publishables.length; i++) {
      const { sku, model } = publishables[i];
      const handle = skuToHandle(sku);
      let wouldMfEntries = 0;
      for (const locale of TRANSLATION_LOCALES) {
        for (const _mf of (model.translations[locale]?.metafields ?? [])) wouldMfEntries++;
      }
      changesCsv += csvRow([
        sku, handle, '', 'WOULD_CREATE_OR_UPDATE', '',
        `would_register_for_${TRANSLATION_LOCALES.length}_locales`,
        `would_register_${wouldMfEntries}_mf_entries_pre_dedup`,
        '',
        'WOULD_PUBLISH_TIENDA_ONLINE', '',
        '', '', '', '',
        'DRY_RUN',
      ]);
      counts.skus.ok++;
      if ((i + 1) % 100 === 0 || i === publishables.length - 1) {
        onProgress(`[${i + 1}/${publishables.length}] (dry-run) ${sku}`);
      }
    }
  } else {
    // ---- APPLY path: parallel worker pool with rate limiter ----
    const items = publishables.map((p) => ({ ...p, locationId, publicationId, ctx }));
    let progressCounter = 0;
    const results = await runWithConcurrency({
      items,
      concurrency,
      work: async (it) => {
        const r = await processSku({
          ctx: it.ctx,
          model: it.model,
          locationId: it.locationId,
          publicationId: it.publicationId,
          // PR-IMG-2: pre-upload + media polling dependencies threaded
          // from runFullImport's closure. cdnBucket is shared across
          // workers (singleton-per-run); dbConnection is the pg.Client
          // already used for sku_state upserts.
          cdnBucket,
          dbConnection: options.dbConnection ?? null,
          fetchImpl,
          mediaPollMs,
          mediaPollMaxMs,
        });
        progressCounter++;
        if (progressCounter % 25 === 0 || progressCounter === items.length) {
          onProgress(`[${progressCounter}/${items.length}] ${r.sku}`);
        }
        return r;
      },
    });

    // Process results in original order to keep the CSV stable.
    const sampleProductIds = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r.ok) {
        // Worker threw something completely unexpected (shouldn't happen —
        // processSku catches everything internally).
        const sku = items[i].sku;
        counts.productSet.failed++;
        counts.skus.failed++;
        changesCsv += csvRow([
          sku, skuToHandle(sku), '', 'FAILED', `worker error: ${r.error?.message ?? r.error}`,
          '', '', '', 'SKIPPED', '',
          '', '', '', '',
          'FAILED',
        ]);
        continue;
      }
      const v = r.value;

      // Counts
      if (v.productSet.ok) counts.productSet.ok++; else counts.productSet.failed++;
      if (!v.productSet.ok) {
        counts.skus.failed++;
        changesCsv += csvRow([
          v.sku, v.handle, v.productId ?? '', 'FAILED',
          v.productSet.errors.map((e) => `[${e.code ?? ''}] ${e.field?.join?.('.') ?? ''}: ${e.message}`).join('; '),
          '', '', '', 'SKIPPED', '',
          '', '', '', '',
          'FAILED',
        ]);
        continue;
      }

      if (sampleProductIds.length < 5) sampleProductIds.push({ sku: v.sku, productId: v.productId });

      const trs = v.productTranslations;
      if (trs.errors.length > 0) counts.translations.failed++;
      else if (trs.registered === 0) counts.translations.skipped++;
      else counts.translations.ok++;

      const mfs = v.metafieldTranslations;
      counts.metafield_translations.batches_ok += mfs.batches_ok;
      counts.metafield_translations.batches_failed += mfs.batches_failed;
      counts.metafield_translations.entries_written += mfs.entries;

      const pub = v.publish;
      if (pub.ok) counts.publish.ok++;
      else counts.publish.failed++;

      // PR-IMG-2: media + image-resolution counts.
      const media = v.media ?? { ready: 0, failed: 0, processing: 0, firstError: '' };
      counts.media.ready += media.ready;
      counts.media.failed += media.failed;
      counts.media.processing += media.processing;
      const ir = v.imageResolution ?? { resolved: [], warnings: [] };
      for (const slot of ir.resolved) {
        if (slot && slot.fileId) {
          counts.image_resolution.resolved_ok++;
          if (slot.fromCache) counts.image_resolution.from_cache++;
          else counts.image_resolution.freshly_uploaded++;
        }
      }
      counts.image_resolution.failed_slots += ir.warnings.length;

      // PR-IMG-2: WARN reserved for "product is fine, but at least one
      // image isn't" — image-resolve failure (CDN unreachable etc.) OR
      // a Shopify-side MediaImage in FAILED/PROCESSING after the polling
      // ceiling. FAIL stays scoped to synchronous productSet/translations/
      // publish userErrors as before. Both states still count toward
      // counts.skus.ok (the product is in Shopify and discoverable).
      const allOtherStagesOk = pub.ok && trs.errors.length === 0 && mfs.batches_failed === 0;
      const hasResolveFailures = ir.warnings.length > 0;
      const hasMediaIssues = media.failed > 0 || media.processing > 0;
      const isWarn = allOtherStagesOk && (hasResolveFailures || hasMediaIssues);
      if (isWarn) counts.media.warn_skus++;
      counts.skus.ok++;

      const allTrErrors = [...trs.errors, ...mfs.errors];
      // First error reported in the CSV: prefer the Shopify-side mediaError
      // (more diagnostic), fall back to the first resolve warning.
      const csvFirstError = media.firstError || (ir.warnings[0]
        ? truncate200(`[${ir.warnings[0].resolveKind}] pos=${ir.warnings[0].position} ${ir.warnings[0].message}`)
        : '');
      changesCsv += csvRow([
        v.sku, v.handle, v.productId, 'OK', '',
        String(trs.registered),
        String(mfs.entries),
        allTrErrors.map((e) => `[${e.code ?? ''}] ${e.message}`).join('; '),
        pub.ok ? 'OK' : 'FAILED',
        pub.errors.map((e) => `[${e.code ?? ''}] ${e.message}`).join('; '),
        String(media.ready), String(media.failed), String(media.processing), csvFirstError,
        isWarn ? 'WARN' : 'OK',
      ]);

      // Fingerprint accumulation + optional DB upsert.
      // dbConnection is expected to be an open `pg.Client` (or any object
      // with a `.query(sql, params)` method that returns a Promise).
      // Caller is responsible for opening and closing it. The CLI's main()
      // does this when --with-db is passed; library callers (GHA) pass
      // their own open client.
      if (v.fingerprint) {
        fingerprints[v.sku] = { fingerprint: v.fingerprint, last_published: pub.ok };
        if (options.dbConnection) {
          try {
            await options.dbConnection.query(
              `insert into private.sku_state (sku, fingerprint, last_run_id, last_seen_at, last_published)
               values ($1, $2, $3, now(), $4)
               on conflict (sku) do update set
                 fingerprint = excluded.fingerprint,
                 last_run_id = excluded.last_run_id,
                 last_seen_at = excluded.last_seen_at,
                 last_published = excluded.last_published`,
              [v.sku, v.fingerprint, options.runId ?? null, pub.ok],
            );
            counts.sku_state.upserted_ok++;
          } catch (err) {
            counts.sku_state.upsert_failed++;
            onProgress(`[warn] sku_state upsert failed for ${v.sku}: ${err.message}`);
          }
        }
      }
    }

    // Stash sample product ids for the summary.
    counts._sampleProductIds = sampleProductIds;
  }

  // ---- I3.6: Unpublish orphans ----
  //
  // After the regular publish path, look up which SKUs we've already
  // published in past runs (sku_state.last_published=true) and that are
  // NOT in this run's publishables. They're descatalogados / sin stock /
  // sin precio, so the writer flips them to status:DRAFT in Shopify and
  // updates sku_state.last_published=false.
  //
  // Constraints:
  //   - Only runs in apply mode AND when dbConnection is provided.
  //     Without sku_state we have no source of truth for "previously
  //     published SKUs"; iterating the shop blindly is out of scope by
  //     design (the writer ignores products it didn't create).
  //   - On failure, sku_state.last_published stays true so the next run
  //     retries. On not_found (SKU no longer exists in shop), we still
  //     flip it to false so we don't keep retrying a deleted product.
  //   - Reuses ctx (same rate limiter + concurrency) as the publish path.
  let orphansCsv = '';
  if (applyMode && options.dbConnection) {
    let priorPublished = [];
    try {
      const r = await options.dbConnection.query(
        `select sku from private.sku_state where last_published = true`
      );
      priorPublished = r.rows.map((row) => row.sku);
    } catch (err) {
      onProgress(`[warn] could not read sku_state for orphan detection: ${err.message}; skipping unpublish phase`);
      priorPublished = null;
    }

    if (priorPublished !== null) {
      const publishablesSkus = publishables.map((p) => p.sku);
      const orphans = buildOrphansToUnpublish(publishablesSkus, priorPublished);
      onProgress(`Unpublish phase: ${orphans.length} orphan SKU${orphans.length === 1 ? '' : 's'} (in sku_state.last_published, not in current publishables)`);
      orphansCsv = csvRow(['sku', 'product_id', 'status', 'errors']);

      if (orphans.length > 0) {
        const orphanItems = orphans.map((sku) => ({ sku }));
        let orphanCounter = 0;
        const orphanResults = await runWithConcurrency({
          items: orphanItems,
          concurrency,
          work: async (it) => {
            const r = await processUnpublishOrphan(ctx, it.sku);
            orphanCounter++;
            if (orphanCounter % 25 === 0 || orphanCounter === orphanItems.length) {
              onProgress(`[orphan ${orphanCounter}/${orphanItems.length}] ${r.sku} → ${r.status}`);
            }
            return r;
          },
        });

        for (let i = 0; i < orphanResults.length; i++) {
          const r = orphanResults[i];
          if (!r.ok) {
            counts.unpublished_orphans.failed++;
            orphansCsv += csvRow([
              orphanItems[i].sku, '', 'WORKER_ERROR', String(r.error?.message ?? r.error),
            ]);
            continue;
          }
          const v = r.value;
          counts.unpublished_orphans[v.status]++;
          orphansCsv += csvRow([
            v.sku, v.productId ?? '', v.status.toUpperCase(),
            v.errors.map((e) => `[${e.code ?? ''}] ${e.message}`).join('; '),
          ]);

          // Persist sku_state. Skip on 'failed' so the next run retries.
          // Both 'ok' and 'not_found' should flip last_published=false.
          if (v.status === 'ok' || v.status === 'not_found') {
            try {
              await options.dbConnection.query(
                `update private.sku_state
                    set last_published = false,
                        last_run_id = $1,
                        last_seen_at = now()
                  where sku = $2`,
                [options.runId ?? null, v.sku],
              );
            } catch (err) {
              onProgress(`[warn] sku_state unpublish-state update failed for ${v.sku}: ${err.message}`);
            }
          }
        }
      }
    }
  }

  // Write reports.
  const changesPath = join(reportDir, 'changes.csv');
  await writeFile(changesPath, changesCsv, 'utf8');
  // Fingerprints are also written as a JSON file so re-runs can be diffed
  // against previous reports without needing the DB. Empty in dry-run.
  const fingerprintsPath = join(reportDir, 'fingerprints.json');
  await writeFile(fingerprintsPath, JSON.stringify(fingerprints, null, 2), 'utf8');

  // I3.6 orphans report. Only present when the unpublish phase ran.
  let orphansPath = null;
  if (orphansCsv) {
    orphansPath = join(reportDir, 'orphans.csv');
    await writeFile(orphansPath, orphansCsv, 'utf8');
  }

  const elapsedMs = Date.now() - t0;
  const elapsedSec = (elapsedMs / 1000).toFixed(2);
  const sampleProductIds = counts._sampleProductIds ?? [];
  delete counts._sampleProductIds;

  const summary =
    `LedsC4 B2B Outlet — Import Writer Report (PR-X)\n` +
    `Generated: ${new Date().toISOString()}\n` +
    `Mode:      ${applyMode ? 'apply' : 'dry-run'}\n` +
    `Samples:   ${samplesDir}\n` +
    `Target:    ${shopifyDomain ?? '(no creds)'}\n` +
    (applyMode ? `Concurrency=${concurrency}, rate=${rateLimit.capacity}/${rateLimit.refillPerSec} (capacity/refillPerSec)\n` : '') +
    `\n` +
    `INPUT\n` +
    `- Total SKUs in mapper output:  ${products.size}\n` +
    `- Hidden (skipped):             ${hidden}\n` +
    `- Publishable to process:       ${publishables.length}` +
    (limit != null ? ` (limit=${limit})` : '') +
    (skuFilter ? ` (sku=${skuFilter})` : '') +
    `\n` +
    `\n` +
    `RESULTS\n` +
    `- productSet:                   ok=${counts.productSet.ok} failed=${counts.productSet.failed}\n` +
    `- translations (product):       ok=${counts.translations.ok} skipped=${counts.translations.skipped} failed=${counts.translations.failed}\n` +
    `- translations (metafields):    batches_ok=${counts.metafield_translations.batches_ok} batches_failed=${counts.metafield_translations.batches_failed} entries_written=${counts.metafield_translations.entries_written}\n` +
    `- publishablePublish:           ok=${counts.publish.ok} failed=${counts.publish.failed} skipped=${counts.publish.skipped}\n` +
    `- image pre-upload (CDN):       resolved=${counts.image_resolution.resolved_ok} (cache_hit=${counts.image_resolution.from_cache} fresh=${counts.image_resolution.freshly_uploaded}) failed_slots=${counts.image_resolution.failed_slots}\n` +
    `- product media (post-poll):    ready=${counts.media.ready} failed=${counts.media.failed} processing=${counts.media.processing}\n` +
    `- Unpublished orphans:          ok=${counts.unpublished_orphans.ok} failed=${counts.unpublished_orphans.failed} not_found=${counts.unpublished_orphans.not_found}\n` +
    `- SKUs overall:                 ok=${counts.skus.ok} (warn=${counts.media.warn_skus}) failed=${counts.skus.failed}\n` +
    `- Fingerprints computed:        ${Object.keys(fingerprints).length}` +
    (options.dbConnection
      ? ` (sku_state: upserted=${counts.sku_state.upserted_ok}/${Object.keys(fingerprints).length}, failed=${counts.sku_state.upsert_failed})`
      : ' (in-memory only)') + `\n` +
    `\n` +
    (sampleProductIds.length > 0
      ? `SAMPLE PRODUCTS (for spot check in admin)\n` +
        sampleProductIds.map((s) => `- ${s.sku}: ${s.productId}`).join('\n') + `\n\n`
      : '') +
    `Elapsed: ${elapsedSec}s\n` +
    `Report:  ${reportDir}\n`;

  const summaryPath = join(reportDir, 'summary.txt');
  await writeFile(summaryPath, summary, 'utf8');
  onProgress('\n' + summary);

  return {
    counts,
    sampleProductIds,
    fingerprints,
    reportPaths: { summary: summaryPath, changes: changesPath, fingerprints: fingerprintsPath, orphans: orphansPath },
    elapsedMs,
    reportDir,
  };
}

// ----- runStockOnly (PR-Y: lightweight stock-only path for cron 6h) ------

/**
 * Stock-only import: parse stock.csv and update inventory levels in Shopify
 * for SKUs that already exist there. Does NOT touch products, translations,
 * publish state, or metafields. Designed for the 6h-cadence cron in Fase A.
 *
 * Flow per SKU:
 *   1. Query Shopify: productVariants(query: "sku:X") → inventoryItem.id.
 *      If no exact match, log warning + skip (SKU not yet imported via full).
 *   2. Mutate: inventorySetQuantities with { reason='correction',
 *      name='available', quantities: [{inventoryItemId, locationId, quantity}] }.
 *   3. Compute fingerprint = sha256({sku, locationId, quantity}).
 *   4. If dbConnection set: UPDATE-only on private.sku_state
 *      (fingerprint_stock + stock_last_seen_at). If row doesn't exist
 *      (SKU never went through a full run), warn and skip the upsert.
 *
 * @param {object} options                Same shape as runFullImport, except
 *                                        no productSet-related options.
 * @param {string} options.samplesDir
 * @param {string} [options.reportDir]
 * @param {boolean} options.applyMode
 * @param {string|null} [options.skuFilter]
 * @param {number|null} [options.limit]
 * @param {(msg:string)=>void} [options.onProgress]
 * @param {object} [options.dbConnection]
 * @param {string|null} [options.runId]
 * @param {{capacity:number, refillPerSec:number}} [options.rateLimit]
 * @param {number} [options.concurrency]
 * @param {string} [options.shopifyDomain]
 * @param {string} [options.shopifyToken]
 * @param {string} [options.apiVersion]
 * @param {typeof fetch} [options.fetch]
 *
 * @returns {Promise<{
 *   counts: object,
 *   fingerprints: Record<string, {fingerprint:string, quantity:number}>,
 *   reportPaths: { summary:string, changes:string, fingerprints:string },
 *   elapsedMs: number,
 *   reportDir: string,
 * }>}
 */
export async function runStockOnly(options = {}) {
  const t0 = Date.now();

  const samplesDir = options.samplesDir ?? resolve(REPO_ROOT, 'samples');
  const reportRoot = options.reportDir ?? resolve(REPO_ROOT, 'reports');
  const applyMode = options.applyMode === true;
  const skuFilter = options.skuFilter ?? null;
  const limit = Number.isFinite(options.limit) ? options.limit : null;
  const onProgress = options.onProgress ?? ((msg) => console.log(msg));
  const concurrency = Number.isFinite(options.concurrency) ? options.concurrency : 4;
  const rateLimit = options.rateLimit ?? { capacity: 50, refillPerSec: 10 };

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const shopifyDomain = options.shopifyDomain ?? process.env.SHOPIFY_STORE_DOMAIN;
  const shopifyToken = options.shopifyToken ?? process.env.SHOPIFY_ADMIN_TOKEN;
  const apiVersion = options.apiVersion ?? process.env.SHOPIFY_API_VERSION ?? '2025-10';

  if (applyMode && (!shopifyDomain || !shopifyToken)) {
    throw new Error('applyMode=true requires shopifyDomain + shopifyToken');
  }

  // Parse just stock.csv. No surtido, no precios.
  onProgress(`${applyMode ? '' : '[dry-run] '}Reading stock from: ${samplesDir}/stock/stock.csv`);
  const stockResult = await parseStock(join(samplesDir, 'stock', 'stock.csv'));

  // Apply skuFilter / limit. SKUs with non-numeric or invalid inventario are
  // dropped by parseStock already (warnings emitted there).
  let records = stockResult.records;
  if (skuFilter) records = records.filter((r) => r.sku === skuFilter);
  else if (limit != null) records = records.slice(0, limit);

  onProgress(`${records.length} SKUs to sync (stock-only).`);

  // Resolve shop context once.
  let locationId = null;
  let ctx = null;
  if (applyMode) {
    const bucket = createTokenBucket(rateLimit);
    ctx = {
      endpoint: `https://${shopifyDomain}/admin/api/${apiVersion}/graphql.json`,
      token: shopifyToken,
      fetch: fetchImpl,
      bucket,
    };
    const shopCtx = await fetchShopContext(ctx);
    locationId = shopCtx.locationId;
    onProgress(`Location: ${locationId}`);
    onProgress(`Rate limit: capacity=${rateLimit.capacity}, refill=${rateLimit.refillPerSec}/sec, concurrency=${concurrency}`);
  } else {
    locationId = 'gid://shopify/Location/PLACEHOLDER';
  }

  // Reports dir.
  const ts = nowIsoStamp();
  const reportDir = join(reportRoot, `import-write-stock-${ts}`);
  await mkdir(reportDir, { recursive: true });

  let changesCsv = csvRow([
    'sku', 'inventory_item_id', 'quantity_target',
    'resolve_status', 'mutation_status',
    'sku_state_status', 'errors',
  ]);

  const counts = {
    resolved: { ok: 0, not_found: 0, failed: 0 },
    mutation: { ok: 0, failed: 0, skipped: 0 },
    sku_state: { upserted_ok: 0, upsert_failed: 0, skipped_no_row: 0, skipped_no_db: 0 },
    // SKUs not in Shopify (resolved=NOT_FOUND) are NOT counted as failed —
    // the cron's job is to sync inventory for SKUs that exist; ones not yet
    // imported by a full run are out of scope for this run.
    skus: { ok: 0, failed: 0, skipped: 0 },
  };
  const fingerprints = {};

  if (!applyMode) {
    // Dry-run: write a row per SKU showing the intended quantity. No Shopify
    // calls. Useful to confirm parsing + filter behaviour.
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const qty = parseInt(String(r.inventario).trim(), 10);
      changesCsv += csvRow([
        r.sku, '', String(Number.isNaN(qty) ? '' : qty),
        'WOULD_RESOLVE', 'WOULD_SET',
        options.dbConnection ? 'WOULD_UPDATE_FINGERPRINT_STOCK' : 'NO_DB',
        '',
      ]);
      counts.skus.ok++;
      if ((i + 1) % 100 === 0 || i === records.length - 1) {
        onProgress(`[${i + 1}/${records.length}] (dry-run) ${r.sku}`);
      }
    }
  } else {
    // Apply path: parallel worker pool with rate limiter (same machinery as
    // runFullImport).
    const items = records.map((r) => ({ sku: r.sku, quantity: parseInt(String(r.inventario).trim(), 10) }));
    let progressCounter = 0;
    const results = await runWithConcurrency({
      items,
      concurrency,
      work: async (it) => {
        const out = { sku: it.sku, quantity: it.quantity };
        // Skip SKUs whose stock didn't parse to a non-negative integer.
        if (!Number.isInteger(it.quantity) || it.quantity < 0) {
          out.resolveStatus = 'SKIP_BAD_QTY';
          out.mutationStatus = 'SKIPPED';
          out.error = `quantity="${it.quantity}" not a non-negative integer`;
          return out;
        }

        // 1. Resolve inventoryItem.id
        let inventoryItemId = null;
        try {
          inventoryItemId = await fetchInventoryItemBySku(ctx, it.sku);
        } catch (err) {
          out.resolveStatus = 'FAILED';
          out.error = err.message;
          return out;
        }
        if (!inventoryItemId) {
          out.resolveStatus = 'NOT_FOUND';
          out.mutationStatus = 'SKIPPED';
          return out;
        }
        out.resolveStatus = 'OK';
        out.inventoryItemId = inventoryItemId;

        // 2. Mutate
        try {
          const r = await setInventoryQuantity(ctx, inventoryItemId, locationId, it.quantity);
          if (r.errors.length > 0) {
            out.mutationStatus = 'FAILED';
            out.error = r.errors.map((e) => `[${e.code ?? ''}] ${e.message}`).join('; ');
            return out;
          }
          out.mutationStatus = 'OK';
        } catch (err) {
          out.mutationStatus = 'FAILED';
          out.error = err.message;
          return out;
        }

        // 3. Fingerprint
        out.fingerprint = buildStockFingerprint({ sku: it.sku, locationId, quantity: it.quantity });
        return out;
      },
    });

    progressCounter = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      progressCounter++;
      if (progressCounter % 50 === 0 || progressCounter === results.length) {
        onProgress(`[${progressCounter}/${results.length}] ${results[i].ok ? results[i].value.sku : items[i].sku}`);
      }
      if (!r.ok) {
        const sku = items[i].sku;
        counts.skus.failed++;
        counts.resolved.failed++;
        changesCsv += csvRow([sku, '', String(items[i].quantity), 'FAILED', 'SKIPPED', 'SKIPPED', `worker error: ${r.error?.message ?? r.error}`]);
        continue;
      }
      const v = r.value;

      // Counts: resolve
      if (v.resolveStatus === 'OK') counts.resolved.ok++;
      else if (v.resolveStatus === 'NOT_FOUND') counts.resolved.not_found++;
      else counts.resolved.failed++;

      // Counts: mutation
      if (v.mutationStatus === 'OK') counts.mutation.ok++;
      else if (v.mutationStatus === 'SKIPPED') counts.mutation.skipped++;
      else counts.mutation.failed++;

      // Overall sku tally:
      //   ok      = mutation succeeded
      //   skipped = SKU not in Shopify (NOT_FOUND), or quantity invalid
      //   failed  = real error (resolve threw, mutation returned userErrors)
      if (v.mutationStatus === 'OK') counts.skus.ok++;
      else if (v.mutationStatus === 'SKIPPED') counts.skus.skipped++;
      else counts.skus.failed++;

      // Fingerprint + optional UPDATE-only sku_state
      let skuStateStatus = '';
      if (v.fingerprint && v.mutationStatus === 'OK') {
        fingerprints[v.sku] = { fingerprint: v.fingerprint, quantity: v.quantity };
        if (options.dbConnection) {
          try {
            const upd = await options.dbConnection.query(
              `update private.sku_state
               set fingerprint_stock = $1,
                   stock_last_seen_at = now(),
                   last_run_id = $2
               where sku = $3`,
              [v.fingerprint, options.runId ?? null, v.sku],
            );
            if (upd.rowCount === 0) {
              counts.sku_state.skipped_no_row++;
              skuStateStatus = 'NO_ROW';
              onProgress(`[warn] sku_state has no row for ${v.sku}; stock fingerprint not persisted (run a full import first)`);
            } else {
              counts.sku_state.upserted_ok++;
              skuStateStatus = 'UPDATED';
            }
          } catch (err) {
            counts.sku_state.upsert_failed++;
            skuStateStatus = 'FAILED';
            onProgress(`[warn] sku_state update failed for ${v.sku}: ${err.message}`);
          }
        } else {
          counts.sku_state.skipped_no_db++;
          skuStateStatus = 'NO_DB';
        }
      }

      changesCsv += csvRow([
        v.sku, v.inventoryItemId ?? '', String(v.quantity),
        v.resolveStatus,
        v.mutationStatus,
        skuStateStatus,
        v.error ?? '',
      ]);
    }
  }

  // Write reports.
  const changesPath = join(reportDir, 'changes.csv');
  await writeFile(changesPath, changesCsv, 'utf8');
  const fingerprintsPath = join(reportDir, 'fingerprints.json');
  await writeFile(fingerprintsPath, JSON.stringify(fingerprints, null, 2), 'utf8');

  const elapsedMs = Date.now() - t0;
  const elapsedSec = (elapsedMs / 1000).toFixed(2);

  const summary =
    `LedsC4 B2B Outlet — Stock-only Import Report (PR-Y)\n` +
    `Generated: ${new Date().toISOString()}\n` +
    `Mode:      ${applyMode ? 'apply' : 'dry-run'}\n` +
    `Samples:   ${samplesDir}\n` +
    `Target:    ${shopifyDomain ?? '(no creds)'}\n` +
    (applyMode ? `Concurrency=${concurrency}, rate=${rateLimit.capacity}/${rateLimit.refillPerSec} (capacity/refillPerSec)\n` : '') +
    `\n` +
    `INPUT\n` +
    `- Stock records to sync:        ${records.length}` +
    (limit != null ? ` (limit=${limit})` : '') +
    (skuFilter ? ` (sku=${skuFilter})` : '') + `\n` +
    `\n` +
    `RESULTS\n` +
    `- Resolve (variant by SKU):     ok=${counts.resolved.ok} not_found=${counts.resolved.not_found} failed=${counts.resolved.failed}\n` +
    `- inventorySetQuantities:       ok=${counts.mutation.ok} failed=${counts.mutation.failed} skipped=${counts.mutation.skipped}\n` +
    `- SKUs overall:                 ok=${counts.skus.ok} skipped=${counts.skus.skipped} failed=${counts.skus.failed}\n` +
    `- Fingerprints computed:        ${Object.keys(fingerprints).length}` +
    (options.dbConnection
      ? ` (sku_state: updated=${counts.sku_state.upserted_ok}/${Object.keys(fingerprints).length}, no_row=${counts.sku_state.skipped_no_row}, failed=${counts.sku_state.upsert_failed})`
      : ' (in-memory only)') + `\n` +
    `\n` +
    `Elapsed: ${elapsedSec}s\n` +
    `Report:  ${reportDir}\n`;

  const summaryPath = join(reportDir, 'summary.txt');
  await writeFile(summaryPath, summary, 'utf8');
  onProgress('\n' + summary);

  return {
    counts,
    fingerprints,
    reportPaths: { summary: summaryPath, changes: changesPath, fingerprints: fingerprintsPath },
    elapsedMs,
    reportDir,
  };
}

// ----- main (CLI argv wrapper) ------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { applyMode: false, samplesDir: null, limit: null, skuFilter: null, concurrency: null, rateLimit: null, withDb: false, stockOnly: false };
  if (args.includes('--apply')) opts.applyMode = true;
  const samplesArg = args.find((a) => a.startsWith('--samples-dir='));
  if (samplesArg) opts.samplesDir = resolve(REPO_ROOT, samplesArg.slice('--samples-dir='.length));
  const limitArg = args.find((a) => a.startsWith('--limit='));
  if (limitArg) opts.limit = parseInt(limitArg.slice('--limit='.length), 10);
  const skuArg = args.find((a) => a.startsWith('--sku='));
  if (skuArg) opts.skuFilter = skuArg.slice('--sku='.length);
  const concArg = args.find((a) => a.startsWith('--concurrency='));
  if (concArg) opts.concurrency = parseInt(concArg.slice('--concurrency='.length), 10);
  const capArg = args.find((a) => a.startsWith('--rate-cap='));
  const refArg = args.find((a) => a.startsWith('--rate-refill='));
  if (capArg || refArg) {
    opts.rateLimit = {
      capacity: capArg ? parseInt(capArg.slice('--rate-cap='.length), 10) : 50,
      refillPerSec: refArg ? parseFloat(refArg.slice('--rate-refill='.length)) : 10,
    };
  }
  if (args.includes('--with-db')) opts.withDb = true;
  if (args.includes('--stock-only')) opts.stockOnly = true;
  return opts;
}

async function main() {
  const cli = parseArgs(process.argv);

  // Optional DB connection: only if user passed --with-db. We dynamic-import
  // pg so the dependency isn't required for default CLI runs.
  //
  // Why pg and not postgres.js: postgres@3.4.4 has a SCRAM-SHA-256 bug
  // against Supabase's Session pooler — auth fails with 28P01 even though
  // pg with the same URL/credentials connects fine. Confirmed empirically
  // 2026-05-07 with 4 successive auth attempts and 3 password rotations.
  let dbConnection = null;
  if (cli.withDb) {
    if (!process.env.SUPABASE_DB_URL) {
      console.error('--with-db requires SUPABASE_DB_URL env var.');
      process.exit(1);
    }
    try {
      const pgMod = await import('pg');
      const { Client } = pgMod.default;
      dbConnection = new Client({
        connectionString: process.env.SUPABASE_DB_URL,
        // Supabase's pooler cert isn't in Node's CA bundle — accept it.
        ssl: { rejectUnauthorized: false },
        // Match the pool sizing/timeouts we used with postgres.js.
        connectionTimeoutMillis: 10_000,
      });
      await dbConnection.connect();
    } catch (err) {
      console.error(`--with-db requires the 'pg' npm package. Install it: npm install pg`);
      console.error(`(connect error: ${err.message})`);
      process.exit(1);
    }
  }

  try {
    const opts = {
      samplesDir: cli.samplesDir ?? undefined,
      reportDir: undefined, // default <repoRoot>/reports
      applyMode: cli.applyMode,
      skuFilter: cli.skuFilter,
      limit: cli.limit,
      concurrency: cli.concurrency ?? undefined,
      rateLimit: cli.rateLimit ?? undefined,
      dbConnection,
    };
    if (cli.stockOnly) {
      await runStockOnly(opts);
    } else {
      await runFullImport(opts);
    }
  } finally {
    if (dbConnection) {
      try { await dbConnection.end(); } catch (_e) { /* ignore */ }
    }
  }
}

// Guard so the module can be imported (e.g. by the unit tests) without
// auto-running main(). main() only runs when invoked as a script.
const isMain = (() => {
  try {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error('FATAL:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
