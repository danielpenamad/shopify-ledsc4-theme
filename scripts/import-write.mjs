#!/usr/bin/env node
// Shopify writer for the LedsC4 B2B Outlet import pipeline (Fase I3).
//
// Pipeline: samples → parser → mapper → writer → Shopify Admin API.
//
// Per SKU with would_publish=true, executes 3 mutations in order:
//   1. productSet — creates or updates the canonical product (ES primary).
//      Idempotent by handle = sku.toLowerCase().
//   2. translationsRegister — registers translations for en/fr/de/it/pt-PT.
//      Only translates fields that the shop exposes as translatableContent
//      (title, body_html in this phase; metafield translations require enabling
//      capabilities.translatable on each definition — out of scope for I3).
//   3. publishablePublish — publishes to "Tienda online" publication.
//
// Usage:
//   node scripts/import-write.mjs                  # dry-run
//   node scripts/import-write.mjs --apply          # write to shop
//   node scripts/import-write.mjs --apply --limit 5
//   node scripts/import-write.mjs --apply --sku 05-6396-21-M1
//   node scripts/import-write.mjs --samples-dir=samples
//
// Convention with .env: prefix the command with --env-file:
//   node --env-file=shopify-ledsc4-theme.env scripts/import-write.mjs --apply
//
// Reports: reports/import-write-{ISO timestamp}/
//   - summary.txt
//   - changes.csv (1 row per processed SKU)
//
// Idempotency: re-running with the same inputs is safe.
//   - productSet uses handle as identifier → no duplicates.
//   - Files use duplicateResolutionMode=REPLACE → no duplicate media on re-run.
//   - translationsRegister with fresh digest is upsert by (resourceId, locale, key).
//   - publishablePublish on already-published resource is a no-op.

import { readFile } from 'node:fs/promises';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { parseSurtido, parseStock, parsePrecios } from './import-parse.mjs';
import { buildShopifyModel } from './import-map.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY_RUN = !APPLY;
const samplesArg = args.find((a) => a.startsWith('--samples-dir='));
const SAMPLES_DIR = samplesArg
  ? resolve(REPO_ROOT, samplesArg.slice('--samples-dir='.length))
  : resolve(REPO_ROOT, 'samples');
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.slice('--limit='.length), 10) : null;
const skuArg = args.find((a) => a.startsWith('--sku='));
const SINGLE_SKU = skuArg ? skuArg.slice('--sku='.length) : null;

const API_VERSION = process.env.SHOPIFY_API_VERSION ?? '2025-10';
const { SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN } = process.env;
const HAS_CREDENTIALS = Boolean(SHOPIFY_STORE_DOMAIN && SHOPIFY_ADMIN_TOKEN);

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
    // Single-variant product: declare a single option ("Title") with one
    // value ("Default Title"). Required by productSet when variants are
    // included (see PRODUCT_OPTIONS_INPUT_MISSING). Mirrors the variant's
    // optionValues entry below.
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

// Build the list of TranslationInput entries to register for the product.
// Matches the model's per-locale translations against the shop's
// translatableContent for the resource (which exposes title, body_html,
// and any metafields whose definitions have translatable capability enabled).
//
// Returns: [{ locale, key, value, translatableContentDigest }, ...].
// Silently skips:
//   - locales not in TRANSLATION_LOCALES,
//   - keys absent from translatableContent (e.g. metafield translations
//     when the metafield definition doesn't have translatable enabled),
//   - empty / null translation values.
export function buildTranslations(model, translatableContent) {
  // Index translatable content by key for O(1) lookup.
  const byKey = new Map();
  for (const tc of translatableContent) byKey.set(tc.key, tc);

  const out = [];
  for (const locale of TRANSLATION_LOCALES) {
    const t = model.translations[locale];
    if (!t) continue;

    // Title.
    if (t.title) {
      const tc = byKey.get('title');
      if (tc) out.push({ locale, key: 'title', value: String(t.title), translatableContentDigest: tc.digest });
    }

    // Body HTML.
    if (t.body_html) {
      const tc = byKey.get('body_html');
      if (tc) out.push({ locale, key: 'body_html', value: String(t.body_html), translatableContentDigest: tc.digest });
    }

    // Metafield translations: keyed by metafield_id in translatableContent
    // (e.g. "5439213895687"). Without enabling translatable capability on
    // each metafield definition, these keys are absent — translations are
    // simply not registered. See report for skipped count.
    // For now, the mapper produces metafield translations keyed by the
    // metafield's own (namespace, key); we look for a matching key in
    // translatableContent. In API 2025-10 the format is the metafield id,
    // not "metafields.<ns>.<key>", so this loop is a no-op until we wire
    // the metafield-id lookup. Documented as a follow-up.
    // (Loop intentionally kept here to make the no-op explicit.)
    for (const _mf of t.metafields ?? []) {
      void _mf;
    }
  }
  return out;
}

// ----- API client --------------------------------------------------------

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

const PRODUCT_SET_MUTATION = `
  mutation productSet($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
    productSet(input: $input, synchronous: true, identifier: $identifier) {
      product {
        id
        handle
        variants(first: 5) { nodes { id sku } }
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

async function fetchShopContext() {
  // Note: the Custom App's token doesn't have `read_locations` scope, so
  // Location.name and Location.isActive are not queryable. We just request
  // `id` and pick the first one — the shop has a single location.
  // (If you ever add multi-location support, request the scope and filter
  // by isActive.)
  const data = await gql(`
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

async function productSet(input) {
  const data = await gql(PRODUCT_SET_MUTATION, {
    input,
    identifier: { handle: input.handle },
  });
  const errors = data.productSet.userErrors ?? [];
  return { product: data.productSet.product, errors };
}

async function fetchTranslatable(productId) {
  const data = await gql(TRANSLATABLE_QUERY, { id: productId });
  return data.translatableResource?.translatableContent ?? [];
}

async function registerTranslations(productId, translations) {
  if (translations.length === 0) return { registered: 0, errors: [] };
  const data = await gql(TRANSLATIONS_REGISTER, { resourceId: productId, translations });
  const errors = data.translationsRegister.userErrors ?? [];
  return { registered: data.translationsRegister.translations.length, errors };
}

async function publishProduct(productId, publicationId) {
  const data = await gql(PUBLISHABLE_PUBLISH, {
    id: productId,
    input: [{ publicationId }],
  });
  const errors = data.publishablePublish.userErrors ?? [];
  return { errors };
}

// ----- main --------------------------------------------------------------

async function loadMapping() {
  const text = await readFile(resolve(REPO_ROOT, 'scripts', 'mapping.json'), 'utf8');
  return JSON.parse(text);
}

async function buildModelFromSamples() {
  const mapping = await loadMapping();
  const surtidoPaths = LOCALES.map((loc) => ({
    locale: loc,
    path: join(SAMPLES_DIR, 'productos', `listado_productos_${loc}.csv`),
  }));
  const [surtidoResults, stockResult, preciosResult] = await Promise.all([
    Promise.all(surtidoPaths.map((p) => parseSurtido(p.path, p.locale).then((r) => ({ ...r, locale: p.locale })))),
    parseStock(join(SAMPLES_DIR, 'stock', 'stock.csv')),
    parsePrecios(join(SAMPLES_DIR, 'precios', 'precios_productos.csv')),
  ]);
  const surtidoByLocale = new Map();
  for (const sr of surtidoResults) surtidoByLocale.set(sr.locale, sr);
  return buildShopifyModel({ surtidoByLocale, stock: stockResult, precios: preciosResult, mapping });
}

async function main() {
  const t0 = Date.now();

  if (APPLY && !HAS_CREDENTIALS) {
    console.error('Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars.');
    console.error('Either set them or omit --apply for a dry-run.');
    process.exit(1);
  }

  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Reading samples from: ${SAMPLES_DIR}`);
  const { products } = await buildModelFromSamples();

  // Filter to publishable; optionally restrict via --limit / --sku.
  let publishables = [];
  for (const [sku, m] of products) if (m.publish) publishables.push({ sku, model: m });
  let hidden = 0;
  for (const [, m] of products) if (!m.publish) hidden++;
  if (SINGLE_SKU) publishables = publishables.filter((p) => p.sku === SINGLE_SKU);
  else if (LIMIT != null) publishables = publishables.slice(0, LIMIT);

  console.log(`${publishables.length} SKUs to write (${hidden} hidden, skipped).`);

  // Resolve shop context once (locations + publications).
  let onlineStorePublicationId = null;
  let locationId = null;
  if (APPLY) {
    const ctx = await fetchShopContext();
    onlineStorePublicationId = ctx.onlineStorePublicationId;
    locationId = ctx.locationId;
    console.log(`Publication: ${onlineStorePublicationId}; Location: ${locationId}`);
  } else {
    // Use placeholders so buildProductSetInput works in dry-run.
    locationId = 'gid://shopify/Location/PLACEHOLDER';
    onlineStorePublicationId = 'gid://shopify/Publication/PLACEHOLDER';
  }

  // Reports.
  const ts = nowIsoStamp();
  const reportDir = resolve(REPO_ROOT, 'reports', `import-write-${ts}`);
  await mkdir(reportDir, { recursive: true });

  let changesCsv = csvRow([
    'sku', 'handle', 'product_id', 'product_set_status', 'product_set_errors',
    'translations_registered', 'translation_errors',
    'publish_status', 'publish_errors',
    'overall',
  ]);

  // Emit one row per hidden SKU so the report covers the full mapper output
  // (publishables + hidden = 733 in the current samples). Hidden SKUs are
  // not touched in Shopify; they appear here for traceability only.
  for (const [sku, m] of products) {
    if (m.publish) continue;
    const limited = (SINGLE_SKU && sku !== SINGLE_SKU);
    if (limited) continue;
    changesCsv += csvRow([
      sku, skuToHandle(sku), '', `SKIPPED:${m.publish_reason ?? 'unknown'}`, '',
      '', '', 'SKIPPED', '', 'HIDDEN',
    ]);
  }

  let counts = {
    productSet: { ok: 0, failed: 0 },
    translations: { ok: 0, failed: 0, skipped: 0 },
    publish: { ok: 0, failed: 0, skipped: 0 },
    skus: { ok: 0, failed: 0 },
  };

  let sampleProductIds = [];

  for (let i = 0; i < publishables.length; i++) {
    const { sku, model } = publishables[i];
    const handle = skuToHandle(sku);
    const input = buildProductSetInput(model, { locationId });

    if (DRY_RUN) {
      const wouldRegister = TRANSLATION_LOCALES.length;
      changesCsv += csvRow([
        sku, handle, '', 'WOULD_CREATE_OR_UPDATE', '',
        `would_register_for_${wouldRegister}_locales`, '',
        'WOULD_PUBLISH_TIENDA_ONLINE', '',
        'DRY_RUN',
      ]);
      counts.skus.ok++;
      if ((i + 1) % 100 === 0 || i === publishables.length - 1) {
        console.log(`[${i + 1}/${publishables.length}] (dry-run) ${sku}`);
      }
      continue;
    }

    // 1. productSet
    let productId = null;
    let psErrors = [];
    try {
      const r = await productSet(input);
      psErrors = r.errors;
      productId = r.product?.id ?? null;
      if (psErrors.length > 0 || !productId) {
        counts.productSet.failed++;
        counts.skus.failed++;
        changesCsv += csvRow([
          sku, handle, productId ?? '', 'FAILED',
          psErrors.map((e) => `[${e.code ?? ''}] ${e.field?.join('.') ?? ''}: ${e.message}`).join('; '),
          '', '', 'SKIPPED', '', 'FAILED',
        ]);
        console.log(`[${i + 1}/${publishables.length}] ${sku} — productSet FAILED`);
        continue;
      }
      counts.productSet.ok++;
      if (sampleProductIds.length < 5) sampleProductIds.push({ sku, productId });
    } catch (err) {
      counts.productSet.failed++;
      counts.skus.failed++;
      changesCsv += csvRow([sku, handle, '', 'FAILED', err.message, '', '', 'SKIPPED', '', 'FAILED']);
      console.log(`[${i + 1}/${publishables.length}] ${sku} — productSet THROW: ${err.message}`);
      continue;
    }

    // 2. translationsRegister
    let translationsRegistered = 0;
    let trErrors = [];
    try {
      const tc = await fetchTranslatable(productId);
      const trs = buildTranslations(model, tc);
      const r = await registerTranslations(productId, trs);
      translationsRegistered = r.registered;
      trErrors = r.errors;
      if (trErrors.length > 0) counts.translations.failed++;
      else if (trs.length === 0) counts.translations.skipped++;
      else counts.translations.ok++;
    } catch (err) {
      counts.translations.failed++;
      trErrors = [{ message: err.message }];
    }

    // 3. publishablePublish
    let pubErrors = [];
    try {
      const r = await publishProduct(productId, onlineStorePublicationId);
      pubErrors = r.errors;
      if (pubErrors.length > 0) counts.publish.failed++;
      else counts.publish.ok++;
    } catch (err) {
      counts.publish.failed++;
      pubErrors = [{ message: err.message }];
    }

    counts.skus.ok++;
    changesCsv += csvRow([
      sku, handle, productId, 'OK', '',
      String(translationsRegistered),
      trErrors.map((e) => `[${e.code ?? ''}] ${e.message}`).join('; '),
      pubErrors.length === 0 ? 'OK' : 'FAILED',
      pubErrors.map((e) => `[${e.code ?? ''}] ${e.message}`).join('; '),
      'OK',
    ]);

    if ((i + 1) % 25 === 0 || i === publishables.length - 1) {
      console.log(`[${i + 1}/${publishables.length}] ${sku}`);
    }
  }

  await writeFile(join(reportDir, 'changes.csv'), changesCsv, 'utf8');

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  const summary =
    `LedsC4 B2B Outlet — Import Writer Report (I3)\n` +
    `Generated: ${new Date().toISOString()}\n` +
    `Mode:      ${DRY_RUN ? 'dry-run' : 'apply'}\n` +
    `Samples:   ${SAMPLES_DIR}\n` +
    `Target:    ${SHOPIFY_STORE_DOMAIN ?? '(no creds)'}\n` +
    `\n` +
    `INPUT\n` +
    `- Total SKUs in mapper output:  ${products.size}\n` +
    `- Hidden (skipped):             ${hidden}\n` +
    `- Publishable to process:       ${publishables.length}` +
    (LIMIT != null ? ` (--limit=${LIMIT})` : '') +
    (SINGLE_SKU ? ` (--sku=${SINGLE_SKU})` : '') +
    `\n` +
    `\n` +
    `RESULTS\n` +
    `- productSet:        ok=${counts.productSet.ok} failed=${counts.productSet.failed}\n` +
    `- translations:      ok=${counts.translations.ok} skipped=${counts.translations.skipped} failed=${counts.translations.failed}\n` +
    `- publishablePublish: ok=${counts.publish.ok} failed=${counts.publish.failed} skipped=${counts.publish.skipped}\n` +
    `- SKUs overall:      ok=${counts.skus.ok} failed=${counts.skus.failed}\n` +
    `\n` +
    (sampleProductIds.length > 0
      ? `SAMPLE PRODUCTS (for spot check in admin)\n` +
        sampleProductIds.map((s) => `- ${s.sku}: ${s.productId}`).join('\n') + `\n\n`
      : '') +
    `Elapsed: ${elapsed}s\n` +
    `Report:  ${reportDir}\n`;

  await writeFile(join(reportDir, 'summary.txt'), summary, 'utf8');
  console.log('\n' + summary);
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
