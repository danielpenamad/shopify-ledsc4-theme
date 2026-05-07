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
//   - **CLI (unchanged from I3.5)**:
//       node scripts/import-write.mjs                  # dry-run
//       node scripts/import-write.mjs --apply          # write to shop
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
//   - **Library (PR-X)**: import `runFullImport(options)` and call it
//     from another Node script (GitHub Actions cron). Returns
//     { counts, sampleProductIds, fingerprints, reportPaths, elapsedMs }.
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
import { buildSkuFingerprint, sortPayloadForFingerprint } from './fingerprint.mjs';

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
// opts: { locationId } where locationId is a gid://shopify/Location/* string.
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

  // Files (images) — REPLACE on filename collision so re-runs don't duplicate
  // the media. REPLACE mode requires an explicit filename for matching.
  // We namespace each file by SKU + position to keep filenames stable across
  // runs and unique per (product, image slot): "{sku}-{position}-{originalName}".
  const files = product.images.map((img, idx) => ({
    contentType: 'IMAGE',
    originalSource: img.src,
    filename: makeStableFilename(sku, img.position ?? idx, img.src),
    duplicateResolutionMode: 'REPLACE',
  }));

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

// ----- per-SKU processor -------------------------------------------------

// The full 3-mutation flow + fingerprint computation for one SKU. Designed to
// run inside runWithConcurrency. Returns a shape that the orchestrator
// converts to a CSV row + accumulates into counts.
async function processSku({ ctx, model, locationId, publicationId }) {
  const sku = model.sku;
  const handle = skuToHandle(sku);
  const productSetInput = buildProductSetInput(model, { locationId });

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

  // 4. Fingerprint — only computed if all 3 stages succeeded (a partial run
  // produced a partial state; we don't want to record it as the canonical
  // fingerprint until the next successful run).
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
 * @param {object} [options.dbConnection]      Optional postgres.js connection. If set, fingerprints are upserted into private.sku_state.
 * @param {string|null} [options.runId]        Optional uuid stored as last_run_id in sku_state.
 * @param {{capacity:number, refillPerSec:number}} [options.rateLimit]   Rate limiter config. Default {capacity:50, refillPerSec:10} — matches Shopify Admin GraphQL Basic cost-point restore (100/s, ~10 ops/s for typical mutations). The 10/s default is safe because gql() retries 429/THROTTLED with backoff.
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
  } else {
    locationId = 'gid://shopify/Location/PLACEHOLDER';
    publicationId = 'gid://shopify/Publication/PLACEHOLDER';
  }

  // Reports dir.
  const ts = nowIsoStamp();
  const reportDir = join(reportRoot, `import-write-${ts}`);
  await mkdir(reportDir, { recursive: true });

  // Build CSV header + hidden rows up-front (those don't need work).
  let changesCsv = csvRow([
    'sku', 'handle', 'product_id', 'product_set_status', 'product_set_errors',
    'product_translations_registered', 'metafield_translations_registered',
    'translation_errors',
    'publish_status', 'publish_errors',
    'overall',
  ]);
  for (const [sku, m] of products) {
    if (m.publish) continue;
    if (skuFilter && sku !== skuFilter) continue;
    changesCsv += csvRow([
      sku, skuToHandle(sku), '', `SKIPPED:${m.publish_reason ?? 'unknown'}`, '',
      '', '', '', 'SKIPPED', '', 'HIDDEN',
    ]);
  }

  const counts = {
    productSet: { ok: 0, failed: 0 },
    translations: { ok: 0, failed: 0, skipped: 0 },
    metafield_translations: { entries_written: 0, batches_ok: 0, batches_failed: 0 },
    publish: { ok: 0, failed: 0, skipped: 0 },
    skus: { ok: 0, failed: 0 },
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
        const r = await processSku({ ctx: it.ctx, model: it.model, locationId: it.locationId, publicationId: it.publicationId });
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
        changesCsv += csvRow([sku, skuToHandle(sku), '', 'FAILED', `worker error: ${r.error?.message ?? r.error}`, '', '', '', 'SKIPPED', '', 'FAILED']);
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
          '', '', '', 'SKIPPED', '', 'FAILED',
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

      counts.skus.ok++;

      const allTrErrors = [...trs.errors, ...mfs.errors];
      changesCsv += csvRow([
        v.sku, v.handle, v.productId, 'OK', '',
        String(trs.registered),
        String(mfs.entries),
        allTrErrors.map((e) => `[${e.code ?? ''}] ${e.message}`).join('; '),
        pub.ok ? 'OK' : 'FAILED',
        pub.errors.map((e) => `[${e.code ?? ''}] ${e.message}`).join('; '),
        'OK',
      ]);

      // Fingerprint accumulation + optional DB upsert.
      if (v.fingerprint) {
        fingerprints[v.sku] = { fingerprint: v.fingerprint, last_published: pub.ok };
        if (options.dbConnection) {
          try {
            const sql = options.dbConnection;
            await sql`
              insert into private.sku_state (sku, fingerprint, last_run_id, last_seen_at, last_published)
              values (${v.sku}, ${v.fingerprint}, ${options.runId ?? null}, now(), ${pub.ok})
              on conflict (sku) do update set
                fingerprint = excluded.fingerprint,
                last_run_id = excluded.last_run_id,
                last_seen_at = excluded.last_seen_at,
                last_published = excluded.last_published
            `;
          } catch (err) {
            onProgress(`[warn] sku_state upsert failed for ${v.sku}: ${err.message}`);
          }
        }
      }
    }

    // Stash sample product ids for the summary.
    counts._sampleProductIds = sampleProductIds;
  }

  // Write reports.
  const changesPath = join(reportDir, 'changes.csv');
  await writeFile(changesPath, changesCsv, 'utf8');
  // Fingerprints are also written as a JSON file so re-runs can be diffed
  // against previous reports without needing the DB. Empty in dry-run.
  const fingerprintsPath = join(reportDir, 'fingerprints.json');
  await writeFile(fingerprintsPath, JSON.stringify(fingerprints, null, 2), 'utf8');

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
    `- SKUs overall:                 ok=${counts.skus.ok} failed=${counts.skus.failed}\n` +
    `- Fingerprints computed:        ${Object.keys(fingerprints).length}` +
    (options.dbConnection ? ' (upserted to private.sku_state)' : ' (in-memory only)') + `\n` +
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
    reportPaths: { summary: summaryPath, changes: changesPath, fingerprints: fingerprintsPath },
    elapsedMs,
    reportDir,
  };
}

// ----- main (CLI argv wrapper) ------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { applyMode: false, samplesDir: null, limit: null, skuFilter: null, concurrency: null, rateLimit: null, withDb: false };
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
  return opts;
}

async function main() {
  const cli = parseArgs(process.argv);

  // Optional DB connection: only if user passed --with-db. We dynamic-import
  // postgres so the dependency isn't required for default CLI runs.
  let dbConnection = null;
  if (cli.withDb) {
    if (!process.env.SUPABASE_DB_URL) {
      console.error('--with-db requires SUPABASE_DB_URL env var.');
      process.exit(1);
    }
    try {
      const pgMod = await import('postgres');
      const pg = pgMod.default;
      dbConnection = pg(process.env.SUPABASE_DB_URL, { max: 1, idle_timeout: 5, connect_timeout: 10 });
    } catch (err) {
      console.error(`--with-db requires the 'postgres' npm package. Install it: npm install postgres@3.4.4`);
      console.error(`(import error: ${err.message})`);
      process.exit(1);
    }
  }

  try {
    await runFullImport({
      samplesDir: cli.samplesDir ?? undefined,
      reportDir: undefined, // default <repoRoot>/reports
      applyMode: cli.applyMode,
      skuFilter: cli.skuFilter,
      limit: cli.limit,
      concurrency: cli.concurrency ?? undefined,
      rateLimit: cli.rateLimit ?? undefined,
      dbConnection,
    });
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
