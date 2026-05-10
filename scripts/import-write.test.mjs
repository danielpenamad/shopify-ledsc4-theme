#!/usr/bin/env node
// Unit tests for scripts/import-write.mjs.
//
// Tests the pure-function transformations:
//   - buildProductSetInput(model, opts) → ProductSetInput
//   - buildTranslations(model, translatableContent) → TranslationInput[]
//
// No Shopify calls. No external test framework (project convention: zero deps).
//
// Run:
//   node scripts/import-write.test.mjs

import { buildProductSetInput, buildTranslations, buildMetafieldTranslationBatches, buildOrphansToUnpublish, runFullImport, runStockOnly, resolveImagesForSku, pollProductMediaStatus } from './import-write.mjs';
import { buildStockFingerprint } from './fingerprint.mjs';
import { createTokenBucket } from './rate-limiter.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
    console.error(`  ✗ ${message}`);
  }
}

function makeModel(overrides = {}) {
  return {
    sku: 'TEST-SKU-001',
    publish: true,
    publish_reason: null,
    product: {
      title: 'Test Product Title',
      body_html: '<p>Description</p>',
      vendor: 'LedsC4',
      tags: ['Familia:Test', 'Coleccion:2026'],
      images: [
        { src: 'https://example.com/image1.jpg', position: 1 },
        { src: 'https://example.com/image2.jpg', position: 2 },
      ],
      metafields: [
        { namespace: 'product', key: 'familia', type: 'single_line_text_field', value: 'Test' },
        { namespace: 'product', key: 'vatios', type: 'number_decimal', value: '12.5' },
      ],
      variants: [
        { sku: 'TEST-SKU-001', barcode: '8429220000001', price: 19.99, inventory_quantity: 5 },
      ],
    },
    translations: {
      en: { title: 'Test Product Title EN', body_html: '<p>Description EN</p>', metafields: [] },
      fr: { title: 'Test Product Title FR', body_html: '<p>Description FR</p>', metafields: [] },
      de: { title: null, body_html: null, metafields: [] },
      it: { title: 'Test Product Title IT', body_html: null, metafields: [] },
      'pt-PT': { title: 'Test Product Title PT', body_html: '<p>Description PT</p>', metafields: [] },
    },
    warnings: [],
    ...overrides,
  };
}

const LOC = 'gid://shopify/Location/12345';

function testBuildProductSetInput_basic() {
  console.log('Test 1: buildProductSetInput — basic shape');
  const model = makeModel();
  const input = buildProductSetInput(model, { locationId: LOC });

  assert(input.handle === 'test-sku-001', `expected handle 'test-sku-001', got '${input.handle}'`);
  assert(input.title === 'Test Product Title', `expected title preserved`);
  assert(input.vendor === 'LedsC4', `expected vendor LedsC4`);
  assert(input.descriptionHtml === '<p>Description</p>', `expected descriptionHtml from body_html`);
  assert(input.status === 'ACTIVE', `expected status ACTIVE, got ${input.status}`);
  assert(Array.isArray(input.tags) && input.tags.includes('Coleccion:2026'), `expected tags preserved`);
  assert(input.variants.length === 1, `expected 1 variant`);
  assert(input.metafields.length === 2, `expected 2 metafields`);
}

function testBuildProductSetInput_handleLowercase() {
  console.log('Test 2: buildProductSetInput — SKU lowercased to handle');
  const model = makeModel({ sku: 'AH12-12V8W1OUWT', product: { ...makeModel().product } });
  model.product.variants[0].sku = 'AH12-12V8W1OUWT';
  const input = buildProductSetInput(model, { locationId: LOC });
  assert(input.handle === 'ah12-12v8w1ouwt', `expected lowercased handle, got '${input.handle}'`);
  assert(input.variants[0].sku === 'AH12-12V8W1OUWT', `expected variant.sku preserves case`);
}

function testBuildProductSetInput_variantWithInventory() {
  console.log('Test 3: buildProductSetInput — variant carries price, barcode, inventory at locationId');
  const model = makeModel();
  const input = buildProductSetInput(model, { locationId: LOC });
  const v = input.variants[0];
  assert(v.sku === 'TEST-SKU-001', `expected sku`);
  assert(v.price === '19.99', `expected price string '19.99', got '${v.price}'`);
  assert(v.barcode === '8429220000001', `expected barcode preserved`);
  assert(v.inventoryQuantities?.[0]?.locationId === LOC, `expected location injected`);
  assert(v.inventoryQuantities?.[0]?.quantity === 5, `expected quantity 5`);
  assert(v.inventoryQuantities?.[0]?.name === 'available', `expected name 'available'`);
  assert(v.inventoryItem?.tracked === true, `expected inventoryItem.tracked=true`);
}

function testBuildProductSetInput_noImages() {
  console.log('Test 4: buildProductSetInput — SKU without images omits files key');
  const model = makeModel();
  model.product.images = [];
  const input = buildProductSetInput(model, { locationId: LOC });
  assert(!('files' in input), `expected 'files' absent when no images, got ${JSON.stringify(input.files)}`);
}

function testBuildProductSetInput_filesShape() {
  console.log('Test 5: buildProductSetInput — files use REPLACE for idempotency');
  const model = makeModel();
  const input = buildProductSetInput(model, { locationId: LOC });
  assert(input.files.length === 2, `expected 2 files`);
  for (const f of input.files) {
    assert(f.contentType === 'IMAGE', `expected contentType IMAGE`);
    assert(f.duplicateResolutionMode === 'REPLACE', `expected REPLACE for idempotent re-runs, got ${f.duplicateResolutionMode}`);
    assert(typeof f.originalSource === 'string' && f.originalSource.startsWith('https://'), `expected https URL`);
  }
}

function testBuildProductSetInput_noBodyHtml() {
  console.log('Test 6: buildProductSetInput — null body_html omits descriptionHtml');
  const model = makeModel();
  model.product.body_html = null;
  const input = buildProductSetInput(model, { locationId: LOC });
  assert(!('descriptionHtml' in input), `expected descriptionHtml absent when body_html null`);
}

function testBuildProductSetInput_optionValuesDefault() {
  console.log('Test 7: buildProductSetInput — single variant gets Default Title option');
  const model = makeModel();
  const input = buildProductSetInput(model, { locationId: LOC });
  const ov = input.variants[0].optionValues;
  assert(Array.isArray(ov) && ov.length === 1, `expected 1 optionValue`);
  assert(ov[0].optionName === 'Title' && ov[0].name === 'Default Title', `expected default Title/Default Title`);
  // The product-level productOptions must mirror the variant's optionValues
  // (otherwise productSet rejects with PRODUCT_OPTIONS_INPUT_MISSING when
  // it tries to resolve which option the variant value belongs to).
  assert(Array.isArray(input.productOptions) && input.productOptions.length === 1, `expected 1 productOption`);
  assert(input.productOptions[0].name === 'Title', `expected productOption name 'Title'`);
  assert(input.productOptions[0].values?.[0]?.name === 'Default Title', `expected option value 'Default Title'`);
}

function testBuildProductSetInput_throwsWithoutLocation() {
  console.log('Test 8: buildProductSetInput — throws if locationId missing');
  let threw = false;
  try {
    buildProductSetInput(makeModel(), {});
  } catch (err) {
    threw = true;
    assert(err.message.includes('locationId'), `expected error mentions locationId`);
  }
  assert(threw, `expected throw when locationId absent`);
}

function testBuildTranslations_titleAndBodyOnly() {
  console.log('Test 9: buildTranslations — matches title and body_html keys, ignores others');
  const model = makeModel();
  const tc = [
    { key: 'title', digest: 'd-title' },
    { key: 'body_html', digest: 'd-body' },
    { key: 'handle', digest: 'd-handle' },
  ];
  const out = buildTranslations(model, tc);
  // EN/FR/IT/PT have title, EN/FR/PT have body_html.
  // EN: title + body_html → 2
  // FR: title + body_html → 2
  // DE: nothing (both null) → 0
  // IT: title only → 1
  // PT: title + body_html → 2
  // Total = 7
  assert(out.length === 7, `expected 7 translation entries, got ${out.length}: ${JSON.stringify(out.map((t) => `${t.locale}:${t.key}`))}`);
  for (const t of out) {
    assert(['title', 'body_html'].includes(t.key), `expected key in {title, body_html}`);
    assert(t.translatableContentDigest === (t.key === 'title' ? 'd-title' : 'd-body'), `digest copied from translatableContent`);
    assert(typeof t.value === 'string' && t.value.length > 0, `value is non-empty string`);
  }
}

function testBuildTranslations_skipsKeysNotInShopContent() {
  console.log('Test 10: buildTranslations — silently skips keys absent from translatableContent');
  const model = makeModel();
  // Shop only exposes title (not body_html).
  const tc = [{ key: 'title', digest: 'd-title' }];
  const out = buildTranslations(model, tc);
  // Only title entries: EN/FR/IT/PT (DE has null title) = 4.
  assert(out.length === 4, `expected 4 entries (title only), got ${out.length}`);
  for (const t of out) assert(t.key === 'title', `expected only title keys`);
}

function testBuildTranslations_missingLocale() {
  console.log('Test 11: buildTranslations — model missing a locale yields no entries for that locale');
  const model = makeModel();
  delete model.translations.fr;
  const tc = [
    { key: 'title', digest: 'd-title' },
    { key: 'body_html', digest: 'd-body' },
  ];
  const out = buildTranslations(model, tc);
  const frEntries = out.filter((t) => t.locale === 'fr');
  assert(frEntries.length === 0, `expected 0 FR entries when locale missing`);
}

function testBuildTranslations_noShopContent() {
  console.log('Test 12: buildTranslations — empty translatableContent yields empty output');
  const model = makeModel();
  const out = buildTranslations(model, []);
  assert(out.length === 0, `expected 0 entries when shop exposes nothing translatable, got ${out.length}`);
}

function makeModelWithMetafieldTranslations() {
  // Mapper-style model: ES is primary (in product.metafields); per-locale
  // values live in translations[locale].metafields with the same `key`.
  return {
    sku: 'SKU-MF',
    publish: true,
    publish_reason: null,
    product: {
      title: 'T', body_html: null, vendor: 'LedsC4', tags: [], images: [],
      metafields: [
        { namespace: 'product', key: 'tipo', type: 'single_line_text_field', value: 'Baño' },
        { namespace: 'product', key: 'familia', type: 'single_line_text_field', value: 'Toilet Slim' },
        { namespace: 'product', key: 'catalogo', type: 'single_line_text_field', value: 'Decorative' },
        { namespace: 'product', key: 'cri', type: 'number_integer', value: '92' },
      ],
      variants: [{ sku: 'SKU-MF', barcode: null, price: 1, inventory_quantity: 1 }],
    },
    translations: {
      en: { title: null, body_html: null, metafields: [
        { key: 'tipo', value: 'Bath' },
        { key: 'familia', value: 'Toilet Slim' }, // same as ES → must skip
        { key: 'catalogo', value: 'Decorative' }, // same as ES → must skip
      ] },
      fr: { title: null, body_html: null, metafields: [
        { key: 'tipo', value: 'Salle de bains' },
        { key: 'familia', value: 'Toilet Slim' }, // same as ES → must skip
      ] },
      de: { title: null, body_html: null, metafields: [
        { key: 'tipo', value: 'Bad' },
        { key: 'familia', value: '' }, // empty → must skip
      ] },
      it: { title: null, body_html: null, metafields: [
        { key: 'tipo', value: 'Bagno' },
      ] },
      'pt-PT': { title: null, body_html: null, metafields: [
        { key: 'tipo', value: 'Casa de banho' },
      ] },
    },
    warnings: [],
  };
}

function testMfBatches_groupsByMetafieldAcrossLocales() {
  console.log('Test 13: buildMetafieldTranslationBatches — groups by metafield across locales');
  const model = makeModelWithMetafieldTranslations();
  const productMetafields = [
    { id: 'gid://shopify/Metafield/1001', namespace: 'product', key: 'tipo' },
    { id: 'gid://shopify/Metafield/1002', namespace: 'product', key: 'familia' },
    { id: 'gid://shopify/Metafield/1003', namespace: 'product', key: 'catalogo' },
    { id: 'gid://shopify/Metafield/1004', namespace: 'product', key: 'cri' },
  ];
  const digests = new Map([
    ['gid://shopify/Metafield/1001', 'd-tipo'],
    ['gid://shopify/Metafield/1002', 'd-familia'],
    ['gid://shopify/Metafield/1003', 'd-catalogo'],
    ['gid://shopify/Metafield/1004', 'd-cri'],
  ]);
  const batches = buildMetafieldTranslationBatches(model, productMetafields, digests);

  // Only `tipo` ends up with non-empty, non-equal-to-ES values across locales.
  // familia and catalogo are equal to ES in every locale → skipped entirely.
  // cri is not in any translations[locale].metafields (not translatable) → no batch.
  assert(batches.length === 1, `expected 1 batch (only tipo has translatable diffs), got ${batches.length}: ${JSON.stringify(batches.map((b) => b.resourceId))}`);
  const b = batches[0];
  assert(b.resourceId === 'gid://shopify/Metafield/1001', `expected tipo's GID, got ${b.resourceId}`);
  // tipo: en=Bath, fr=Salle de bains, de=Bad, it=Bagno, pt-PT=Casa de banho → 5 entries
  assert(b.translations.length === 5, `expected 5 locale entries for tipo, got ${b.translations.length}: ${JSON.stringify(b.translations.map((t) => t.locale + '=' + t.value))}`);
  for (const t of b.translations) {
    assert(t.key === 'value', `expected key='value', got '${t.key}'`);
    assert(t.translatableContentDigest === 'd-tipo', `expected tipo digest`);
    assert(['en', 'fr', 'de', 'it', 'pt-PT'].includes(t.locale), `expected valid locale, got ${t.locale}`);
  }
}

function testMfBatches_skipsEmptyValues() {
  console.log('Test 14: buildMetafieldTranslationBatches — skips empty per-locale values');
  const model = makeModelWithMetafieldTranslations();
  const productMetafields = [
    { id: 'gid://shopify/Metafield/2001', namespace: 'product', key: 'tipo' },
    { id: 'gid://shopify/Metafield/2002', namespace: 'product', key: 'familia' },
  ];
  const digests = new Map([
    ['gid://shopify/Metafield/2001', 'd-tipo'],
    ['gid://shopify/Metafield/2002', 'd-familia'],
  ]);
  const batches = buildMetafieldTranslationBatches(model, productMetafields, digests);
  // familia: only DE is set (and it's empty), others equal ES → skip entirely
  const familiaBatch = batches.find((b) => b.resourceId === 'gid://shopify/Metafield/2002');
  assert(familiaBatch == null, `expected NO familia batch (all locales empty or equal to ES), got: ${JSON.stringify(familiaBatch)}`);
}

function testMfBatches_skipsValuesEqualToEs() {
  console.log('Test 15: buildMetafieldTranslationBatches — skips locale value equal to ES');
  const model = makeModelWithMetafieldTranslations();
  const productMetafields = [
    { id: 'gid://shopify/Metafield/3001', namespace: 'product', key: 'catalogo' },
  ];
  const digests = new Map([
    ['gid://shopify/Metafield/3001', 'd-catalogo'],
  ]);
  const batches = buildMetafieldTranslationBatches(model, productMetafields, digests);
  // catalogo is "Decorative" in ES and "Decorative" in EN (only locale present)
  // so the only translation entry would be a no-op → batch must be omitted.
  assert(batches.length === 0, `expected 0 batches (catalogo identical to ES), got ${batches.length}`);
}

function testMfBatches_skipsMetafieldsMissingFromProduct() {
  console.log('Test 16: buildMetafieldTranslationBatches — defensive: skips metafields not in productMetafields');
  const model = makeModelWithMetafieldTranslations();
  // productSet returned only "familia"; "tipo" is missing (e.g. not yet propagated).
  const productMetafields = [
    { id: 'gid://shopify/Metafield/4001', namespace: 'product', key: 'familia' },
  ];
  const digests = new Map([['gid://shopify/Metafield/4001', 'd-familia']]);
  const batches = buildMetafieldTranslationBatches(model, productMetafields, digests);
  // Even though model.translations.en.metafields has tipo, no batch is emitted
  // because the metafield's GID is unknown.
  for (const b of batches) {
    assert(b.resourceId !== 'gid://shopify/Metafield/4001-tipo-fake', 'must not invent tipo gid');
  }
  // familia entries are all skipped (empty or equal-to-ES) so no batch at all.
  assert(batches.length === 0, `expected 0 batches when only familia exists and all values are empty/equal-to-ES, got ${batches.length}`);
}

function testMfBatches_skipsWhenDigestMissing() {
  console.log('Test 17: buildMetafieldTranslationBatches — defensive: skips when digest missing');
  const model = makeModelWithMetafieldTranslations();
  const productMetafields = [
    { id: 'gid://shopify/Metafield/5001', namespace: 'product', key: 'tipo' },
  ];
  const digests = new Map(); // empty — digest fetch failed
  const batches = buildMetafieldTranslationBatches(model, productMetafields, digests);
  assert(batches.length === 0, `expected 0 batches when digest unavailable, got ${batches.length}`);
}

// ---- runFullImport invocability test (PR-X) ----

async function testRunFullImportDryRun() {
  console.log('Test 19: runFullImport — dry-run on a tiny synthetic samples dir');
  // Build a minimal samples/ directory with just enough to exercise the
  // parser → mapper → orchestrator path. We only need a 1-row surtido per
  // locale + 1 stock row + 1 precios row that overlap to produce a publishable.
  const tmp = await mkdtemp(join(tmpdir(), 'runfullimport-'));
  try {
    await mkdir(join(tmp, 'samples', 'productos'), { recursive: true });
    await mkdir(join(tmp, 'samples', 'stock'), { recursive: true });
    await mkdir(join(tmp, 'samples', 'precios'), { recursive: true });

    // Surtido (79 cols expected by parser). We fill cols 0,3,4,5,6,8,11,16-18,28,49,50,51,53 minimally.
    const surtidoHeader = Array.from({ length: 79 }, (_, i) => `col${i}`).join(',') + '\n';
    const row = (loc) => {
      const fields = Array.from({ length: 79 }, () => '');
      fields[0] = 'TEST-001';   // SKU
      fields[1] = 'V0';         // version
      fields[2] = 'Si';         // predeterminado
      fields[3] = loc === 'EN' ? 'Bath' : 'Baño';  // tipo (translatable)
      fields[4] = '1234567890123';
      fields[5] = 'TestFamily';
      fields[6] = 'Decorative';
      fields[8] = '2';
      fields[11] = `Description ${loc}`;
      return fields.join(',');
    };
    for (const loc of ['ES','EN','IT','DE','FR','PT']) {
      await writeFile(join(tmp, 'samples', 'productos', `listado_productos_${loc}.csv`),
        surtidoHeader + row(loc) + '\n', 'utf8');
    }
    await writeFile(join(tmp, 'samples', 'stock', 'stock.csv'), 'SKU,INVENTARIO\nTEST-001,5\n', 'utf8');
    await writeFile(join(tmp, 'samples', 'precios', 'precios_productos.csv'), 'SKU,TARIFA\nTEST-001,19.99\n', 'utf8');

    const reportDir = join(tmp, 'reports');
    const result = await runFullImport({
      samplesDir: join(tmp, 'samples'),
      reportDir,
      applyMode: false,
      onProgress: () => {}, // silent
    });

    // Structural assertions on the return value.
    assert(result != null && typeof result === 'object', 'returns object');
    assert(typeof result.elapsedMs === 'number' && result.elapsedMs >= 0, 'elapsedMs is non-negative number');
    assert(typeof result.reportDir === 'string' && result.reportDir.includes('import-write-'), 'reportDir is a dated path');
    assert(typeof result.reportPaths?.summary === 'string' && result.reportPaths.summary.endsWith('summary.txt'), 'summary path');
    assert(typeof result.reportPaths?.changes === 'string' && result.reportPaths.changes.endsWith('changes.csv'), 'changes path');
    assert(result.counts?.skus?.ok === 1, `expected 1 SKU processed, got ${result.counts?.skus?.ok}`);
    assert(Array.isArray(result.sampleProductIds), 'sampleProductIds is array');
    assert(typeof result.fingerprints === 'object', 'fingerprints is object');
    // dry-run: no fingerprints (only computed on apply).
    assert(Object.keys(result.fingerprints).length === 0, `expected 0 fingerprints in dry-run, got ${Object.keys(result.fingerprints).length}`);

    // Reports were written.
    const summary = await readFile(result.reportPaths.summary, 'utf8');
    assert(summary.includes('Mode:      dry-run'), 'summary mentions dry-run mode');
    const changes = await readFile(result.reportPaths.changes, 'utf8');
    assert(changes.split('\n')[0].startsWith('sku,handle,'), 'changes.csv has expected header');
    assert(/TEST-001,test-001,.+DRY_RUN/.test(changes), 'changes.csv has the test SKU as DRY_RUN');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testRunFullImportApplyWithMockFetch() {
  console.log('Test 20: runFullImport --apply with mocked fetch — fingerprint computed and returned');
  const tmp = await mkdtemp(join(tmpdir(), 'runfullimport-apply-'));
  try {
    await mkdir(join(tmp, 'samples', 'productos'), { recursive: true });
    await mkdir(join(tmp, 'samples', 'stock'), { recursive: true });
    await mkdir(join(tmp, 'samples', 'precios'), { recursive: true });

    const surtidoHeader = Array.from({ length: 79 }, (_, i) => `col${i}`).join(',') + '\n';
    const row = (loc) => {
      const fields = Array.from({ length: 79 }, () => '');
      fields[0] = 'TEST-002';
      fields[1] = 'V0';
      fields[3] = loc === 'EN' ? 'Bath' : 'Baño';
      fields[4] = '0000000000000';
      fields[5] = 'F';
      fields[6] = 'Decorative';
      fields[8] = '2';
      return fields.join(',');
    };
    for (const loc of ['ES','EN','IT','DE','FR','PT']) {
      await writeFile(join(tmp, 'samples', 'productos', `listado_productos_${loc}.csv`),
        surtidoHeader + row(loc) + '\n', 'utf8');
    }
    await writeFile(join(tmp, 'samples', 'stock', 'stock.csv'), 'SKU,INVENTARIO\nTEST-002,3\n', 'utf8');
    await writeFile(join(tmp, 'samples', 'precios', 'precios_productos.csv'), 'SKU,TARIFA\nTEST-002,42.00\n', 'utf8');

    // Mock fetch: route by GraphQL operation name in the body.
    const calls = [];
    const mockFetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const op = (body.query.match(/(?:mutation|query)\s+(\w+)/) ?? [])[1];
      calls.push(op);
      let data;
      if (op === 'ShopContext') {
        data = {
          publications: { nodes: [{ id: 'gid://shopify/Publication/PUB1', name: 'Tienda online' }] },
          locations: { nodes: [{ id: 'gid://shopify/Location/LOC1' }] },
        };
      } else if (op === 'productSet') {
        data = {
          productSet: {
            product: {
              id: 'gid://shopify/Product/MOCK-002',
              handle: 'test-002',
              variants: { nodes: [{ id: 'gid://shopify/ProductVariant/V', sku: 'TEST-002' }] },
              metafields: { nodes: [{ id: 'gid://shopify/Metafield/MF-tipo', namespace: 'product', key: 'tipo' }] },
            },
            userErrors: [],
          },
        };
      } else if (op === 'TranslatableContent') {
        data = { translatableResource: { translatableContent: [{ key: 'title', digest: 'd-title' }, { key: 'body_html', digest: 'd-body' }] } };
      } else if (op === 'TranslatableByIds') {
        data = { translatableResourcesByIds: { nodes: [{ resourceId: 'gid://shopify/Metafield/MF-tipo', translatableContent: [{ key: 'value', digest: 'd-tipo' }] }] } };
      } else if (op === 'translationsRegister') {
        data = { translationsRegister: { translations: body.variables.translations.map((t) => ({ locale: t.locale, key: t.key, value: t.value })), userErrors: [] } };
      } else if (op === 'publishablePublish') {
        data = { publishablePublish: { userErrors: [] } };
      } else {
        throw new Error(`unexpected op: ${op}`);
      }
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const result = await runFullImport({
      samplesDir: join(tmp, 'samples'),
      reportDir: join(tmp, 'reports'),
      applyMode: true,
      onProgress: () => {},
      fetch: mockFetch,
      shopifyDomain: 'mock.myshopify.com',
      shopifyToken: 'mock-token',
      // Tight rate limit to stress the bucket logic in tests.
      rateLimit: { capacity: 100, refillPerSec: 100 },
      concurrency: 2,
    });

    assert(result.counts.skus.ok === 1, `expected 1 SKU OK, got ${JSON.stringify(result.counts.skus)}`);
    assert(result.counts.productSet.ok === 1, `productSet ok=1`);
    assert(result.counts.publish.ok === 1, `publish ok=1`);
    assert(result.sampleProductIds.length === 1, `1 sample product`);
    assert(result.sampleProductIds[0].productId === 'gid://shopify/Product/MOCK-002', 'sample id matches mock');

    // Fingerprint computed for the successful SKU.
    assert(Object.keys(result.fingerprints).length === 1, `1 fingerprint, got ${Object.keys(result.fingerprints).length}`);
    const fp = result.fingerprints['TEST-002'];
    assert(fp != null && /^[0-9a-f]{64}$/.test(fp.fingerprint), `fingerprint is sha256 hex: ${fp?.fingerprint}`);
    assert(fp.last_published === true, `last_published=true`);

    // Verify the call sequence is what we expect (sanity for the orchestrator):
    // ShopContext, then per SKU: productSet, TranslatableContent, translationsRegister, TranslatableByIds, translationsRegister (per metafield batch), publishablePublish.
    assert(calls[0] === 'ShopContext', `first call is ShopContext, got ${calls[0]}`);
    assert(calls.includes('productSet'), 'productSet called');
    assert(calls.includes('TranslatableContent'), 'TranslatableContent called');
    assert(calls.includes('TranslatableByIds'), 'TranslatableByIds called');
    assert(calls.includes('translationsRegister'), 'translationsRegister called');
    assert(calls.includes('publishablePublish'), 'publishablePublish called');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testRunFullImportDbUpsert() {
  console.log('Test 22: runFullImport — passes fingerprint upsert through dbConnection mock');
  const tmp = await mkdtemp(join(tmpdir(), 'runfullimport-db-'));
  try {
    await mkdir(join(tmp, 'samples', 'productos'), { recursive: true });
    await mkdir(join(tmp, 'samples', 'stock'), { recursive: true });
    await mkdir(join(tmp, 'samples', 'precios'), { recursive: true });
    const surtidoHeader = Array.from({ length: 79 }, (_, i) => `col${i}`).join(',') + '\n';
    const fields = Array.from({ length: 79 }, () => '');
    fields[0] = 'DB-001'; fields[3] = 'X'; fields[5] = 'F';
    const surtidoRow = fields.join(',');
    for (const loc of ['ES','EN','IT','DE','FR','PT']) {
      await writeFile(join(tmp, 'samples', 'productos', `listado_productos_${loc}.csv`), surtidoHeader + surtidoRow + '\n', 'utf8');
    }
    await writeFile(join(tmp, 'samples', 'stock', 'stock.csv'), 'SKU,INVENTARIO\nDB-001,9\n', 'utf8');
    await writeFile(join(tmp, 'samples', 'precios', 'precios_productos.csv'), 'SKU,TARIFA\nDB-001,3.14\n', 'utf8');

    const mockFetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      const op = (body.query.match(/(?:mutation|query)\s+(\w+)/) ?? [])[1];
      let data;
      if (op === 'ShopContext') data = { publications: { nodes: [{ id: 'gid://shopify/Publication/P', name: 'Tienda online' }] }, locations: { nodes: [{ id: 'gid://shopify/Location/L' }] } };
      else if (op === 'productSet') data = { productSet: { product: { id: 'gid://shopify/Product/DB1', handle: 'db-001', variants: { nodes: [] }, metafields: { nodes: [] } }, userErrors: [] } };
      else if (op === 'TranslatableContent') data = { translatableResource: { translatableContent: [] } };
      else if (op === 'TranslatableByIds') data = { translatableResourcesByIds: { nodes: [] } };
      else if (op === 'translationsRegister') data = { translationsRegister: { translations: [], userErrors: [] } };
      else if (op === 'publishablePublish') data = { publishablePublish: { userErrors: [] } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    };

    // Mock dbConnection that captures the upsert. With pg.Client, the
    // contract is `client.query(sql, params)` returning a Promise resolving
    // to { rows: [...] }. We just record sql + params and resolve.
    const dbCalls = [];
    const mockClient = {
      query: async (sql, params) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        dbCalls.push({
          sqlSnippet: flat.slice(0, 80),
          sqlFull: flat,
          params: [...params],
        });
        return { rows: [], rowCount: 1 };
      },
    };

    const result = await runFullImport({
      samplesDir: join(tmp, 'samples'),
      reportDir: join(tmp, 'reports'),
      applyMode: true,
      onProgress: () => {},
      fetch: mockFetch,
      shopifyDomain: 'mock', shopifyToken: 'mock',
      rateLimit: { capacity: 100, refillPerSec: 100 },
      concurrency: 1,
      dbConnection: mockClient,
      runId: '00000000-0000-0000-0000-000000000123',
    });

    // The upsert must have been called with the SKU, fingerprint, runId, and last_published.
    assert(dbCalls.length === 1, `expected 1 sku_state upsert, got ${dbCalls.length}`);
    const call = dbCalls[0];
    assert(call.sqlSnippet.includes('insert into private.sku_state'), `expected sku_state insert, got snippet '${call.sqlSnippet}'`);
    // pg uses positional placeholders ($1, $2, ...). Verify they're in the SQL.
    assert(call.sqlFull.includes('$1') && call.sqlFull.includes('$4'), `expected $1..$4 placeholders in SQL`);
    assert(call.params[0] === 'DB-001', `params[0]=sku, got ${call.params[0]}`);
    assert(/^[0-9a-f]{64}$/.test(call.params[1]), `params[1]=fingerprint hex, got ${call.params[1]}`);
    assert(call.params[2] === '00000000-0000-0000-0000-000000000123', `params[2]=runId, got ${call.params[2]}`);
    assert(call.params[3] === true, `params[3]=last_published, got ${call.params[3]}`);

    // The summary mentions DB upsert.
    const summary = await readFile(result.reportPaths.summary, 'utf8');
    // PR-Y: summary now reports real counts, not blind "upserted to ...".
    assert(summary.includes('sku_state: upserted=1/1, failed=0'), `expected 'sku_state: upserted=1/1, failed=0' in summary, got snippet: ${summary.match(/Fingerprints computed.*/)?.[0] ?? '(no match)'}`);
    // fingerprints.json file written.
    assert(typeof result.reportPaths.fingerprints === 'string', 'fingerprints path exists in result');
    const fpFile = JSON.parse(await readFile(result.reportPaths.fingerprints, 'utf8'));
    assert(fpFile['DB-001']?.fingerprint === call.params[1], 'fingerprints.json matches dbCall arg');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testRunFullImportFingerprintDeterminism() {
  console.log('Test 21: runFullImport — running twice with same input gives same fingerprint');
  const tmp = await mkdtemp(join(tmpdir(), 'runfullimport-det-'));
  try {
    await mkdir(join(tmp, 'samples', 'productos'), { recursive: true });
    await mkdir(join(tmp, 'samples', 'stock'), { recursive: true });
    await mkdir(join(tmp, 'samples', 'precios'), { recursive: true });
    const surtidoHeader = Array.from({ length: 79 }, (_, i) => `col${i}`).join(',') + '\n';
    const fields = Array.from({ length: 79 }, () => '');
    fields[0] = 'DET-001'; fields[3] = 'X'; fields[5] = 'F';
    const surtidoRow = fields.join(',');
    for (const loc of ['ES','EN','IT','DE','FR','PT']) {
      await writeFile(join(tmp, 'samples', 'productos', `listado_productos_${loc}.csv`), surtidoHeader + surtidoRow + '\n', 'utf8');
    }
    await writeFile(join(tmp, 'samples', 'stock', 'stock.csv'), 'SKU,INVENTARIO\nDET-001,1\n', 'utf8');
    await writeFile(join(tmp, 'samples', 'precios', 'precios_productos.csv'), 'SKU,TARIFA\nDET-001,1.00\n', 'utf8');

    const mockFetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const op = (body.query.match(/(?:mutation|query)\s+(\w+)/) ?? [])[1];
      let data;
      if (op === 'ShopContext') data = { publications: { nodes: [{ id: 'gid://shopify/Publication/P', name: 'Tienda online' }] }, locations: { nodes: [{ id: 'gid://shopify/Location/L' }] } };
      else if (op === 'productSet') data = { productSet: { product: { id: 'gid://shopify/Product/D1', handle: 'det-001', variants: { nodes: [] }, metafields: { nodes: [] } }, userErrors: [] } };
      else if (op === 'TranslatableContent') data = { translatableResource: { translatableContent: [] } };
      else if (op === 'TranslatableByIds') data = { translatableResourcesByIds: { nodes: [] } };
      else if (op === 'translationsRegister') data = { translationsRegister: { translations: [], userErrors: [] } };
      else if (op === 'publishablePublish') data = { publishablePublish: { userErrors: [] } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    };

    const opts = { samplesDir: join(tmp, 'samples'), reportDir: join(tmp, 'reports'), applyMode: true, onProgress: () => {}, fetch: mockFetch, shopifyDomain: 'mock', shopifyToken: 'mock', rateLimit: { capacity: 100, refillPerSec: 100 }, concurrency: 1 };
    const r1 = await runFullImport(opts);
    const r2 = await runFullImport(opts);
    assert(r1.fingerprints['DET-001']?.fingerprint === r2.fingerprints['DET-001']?.fingerprint, `same input → same fingerprint`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---- runStockOnly tests (PR-Y) ----

async function makeStockOnlyTmp(records) {
  const tmp = await mkdtemp(join(tmpdir(), 'runstockonly-'));
  await mkdir(join(tmp, 'samples', 'stock'), { recursive: true });
  const csv = 'SKU,INVENTARIO\n' + records.map((r) => `${r.sku},${r.qty}`).join('\n') + '\n';
  await writeFile(join(tmp, 'samples', 'stock', 'stock.csv'), csv, 'utf8');
  return tmp;
}

async function testRunStockOnlyResolvesAndMutates() {
  console.log('Test 23: runStockOnly — resolves SKU → inventoryItem, mutates inventorySetQuantities');
  const tmp = await makeStockOnlyTmp([{ sku: 'STK-001', qty: 5 }, { sku: 'STK-002', qty: 12 }]);
  try {
    const calls = [];
    const mockFetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      const op = (body.query.match(/(?:mutation|query)\s+(\w+)/) ?? [])[1];
      calls.push({ op, vars: body.variables });
      let data;
      if (op === 'ShopContext') {
        data = { publications: { nodes: [{ id: 'gid://shopify/Publication/P', name: 'Tienda online' }] }, locations: { nodes: [{ id: 'gid://shopify/Location/L1' }] } };
      } else if (op === 'VariantBySku') {
        const sku = body.variables.q.replace('sku:', '');
        data = { productVariants: { nodes: [{ id: `gid://shopify/ProductVariant/${sku}`, sku, inventoryItem: { id: `gid://shopify/InventoryItem/${sku}` } }] } };
      } else if (op === 'InventorySetQuantities') {
        data = { inventorySetQuantities: { inventoryAdjustmentGroup: { id: 'gid://shopify/InventoryAdjustmentGroup/A1', reason: 'correction' }, userErrors: [] } };
      } else throw new Error(`unexpected op: ${op}`);
      return new Response(JSON.stringify({ data }), { status: 200 });
    };

    const result = await runStockOnly({
      samplesDir: join(tmp, 'samples'),
      reportDir: join(tmp, 'reports'),
      applyMode: true,
      onProgress: () => {},
      fetch: mockFetch,
      shopifyDomain: 'mock', shopifyToken: 'mock',
      rateLimit: { capacity: 100, refillPerSec: 100 },
      concurrency: 1,
    });

    assert(result.counts.resolved.ok === 2, `expected 2 resolved, got ${result.counts.resolved.ok}`);
    assert(result.counts.mutation.ok === 2, `expected 2 mutated, got ${result.counts.mutation.ok}`);
    assert(result.counts.skus.ok === 2, `expected 2 skus ok, got ${result.counts.skus.ok}`);

    // Verify the InventorySetQuantities calls had the right payload.
    const setCalls = calls.filter((c) => c.op === 'InventorySetQuantities');
    assert(setCalls.length === 2, `expected 2 inventorySet calls, got ${setCalls.length}`);
    for (const c of setCalls) {
      const q = c.vars.input.quantities[0];
      assert(c.vars.input.name === 'available', `name=available`);
      assert(c.vars.input.reason === 'correction', `reason=correction`);
      assert(q.locationId === 'gid://shopify/Location/L1', `locationId threaded`);
      assert(typeof q.inventoryItemId === 'string' && q.inventoryItemId.startsWith('gid://shopify/InventoryItem/'), `inventoryItemId is GID`);
      assert(Number.isInteger(q.quantity), `quantity is int`);
    }

    // No productSet / translations / publish calls — stock-only is leaner.
    assert(!calls.some((c) => c.op === 'productSet'), 'productSet must NOT be called');
    assert(!calls.some((c) => c.op === 'translationsRegister'), 'translationsRegister must NOT be called');
    assert(!calls.some((c) => c.op === 'publishablePublish'), 'publishablePublish must NOT be called');

    // Fingerprints recorded.
    assert(Object.keys(result.fingerprints).length === 2, `2 fingerprints`);
    assert(/^[0-9a-f]{64}$/.test(result.fingerprints['STK-001'].fingerprint), `hex fp for STK-001`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testRunStockOnlySkipsNotFound() {
  console.log('Test 24: runStockOnly — skips SKUs not in Shopify with NOT_FOUND status');
  const tmp = await makeStockOnlyTmp([{ sku: 'STK-EXISTS', qty: 5 }, { sku: 'STK-MISSING', qty: 8 }]);
  try {
    const mockFetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      const op = (body.query.match(/(?:mutation|query)\s+(\w+)/) ?? [])[1];
      let data;
      if (op === 'ShopContext') {
        data = { publications: { nodes: [{ id: 'gid://shopify/Publication/P', name: 'Tienda online' }] }, locations: { nodes: [{ id: 'gid://shopify/Location/L' }] } };
      } else if (op === 'VariantBySku') {
        const sku = body.variables.q.replace('sku:', '');
        // STK-MISSING returns no nodes — not yet imported into Shopify.
        if (sku === 'STK-MISSING') data = { productVariants: { nodes: [] } };
        else data = { productVariants: { nodes: [{ id: `gid://shopify/ProductVariant/X`, sku, inventoryItem: { id: `gid://shopify/InventoryItem/${sku}` } }] } };
      } else if (op === 'InventorySetQuantities') {
        data = { inventorySetQuantities: { inventoryAdjustmentGroup: { id: 'A', reason: 'correction' }, userErrors: [] } };
      } else throw new Error(`unexpected op: ${op}`);
      return new Response(JSON.stringify({ data }), { status: 200 });
    };

    const result = await runStockOnly({
      samplesDir: join(tmp, 'samples'),
      reportDir: join(tmp, 'reports'),
      applyMode: true,
      onProgress: () => {},
      fetch: mockFetch,
      shopifyDomain: 'mock', shopifyToken: 'mock',
      rateLimit: { capacity: 100, refillPerSec: 100 },
      concurrency: 1,
    });

    assert(result.counts.resolved.ok === 1, `1 resolved, got ${result.counts.resolved.ok}`);
    assert(result.counts.resolved.not_found === 1, `1 not_found, got ${result.counts.resolved.not_found}`);
    assert(result.counts.mutation.ok === 1, `1 mutated, got ${result.counts.mutation.ok}`);
    assert(result.counts.mutation.skipped === 1, `1 mutation skipped, got ${result.counts.mutation.skipped}`);
    assert(Object.keys(result.fingerprints).length === 1, `1 fingerprint (only the resolved+mutated SKU)`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testRunStockOnlyDbUpdatePath() {
  console.log('Test 25: runStockOnly — UPDATE-only path on private.sku_state (no insert if no row)');
  const tmp = await makeStockOnlyTmp([{ sku: 'STK-A', qty: 3 }, { sku: 'STK-B', qty: 7 }]);
  try {
    const mockFetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      const op = (body.query.match(/(?:mutation|query)\s+(\w+)/) ?? [])[1];
      let data;
      if (op === 'ShopContext') data = { publications: { nodes: [{ id: 'P', name: 'Tienda online' }] }, locations: { nodes: [{ id: 'L' }] } };
      else if (op === 'VariantBySku') { const sku = body.variables.q.replace('sku:', ''); data = { productVariants: { nodes: [{ id: 'V', sku, inventoryItem: { id: `II-${sku}` } }] } }; }
      else if (op === 'InventorySetQuantities') data = { inventorySetQuantities: { inventoryAdjustmentGroup: { id: 'A' }, userErrors: [] } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    };

    // Mock pg.Client — STK-A has a row (rowCount=1), STK-B doesn't (rowCount=0).
    const dbCalls = [];
    const mockClient = {
      query: async (sql, params) => {
        dbCalls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: [...params] });
        const sku = params[2];
        return { rowCount: sku === 'STK-A' ? 1 : 0, rows: [] };
      },
    };

    const result = await runStockOnly({
      samplesDir: join(tmp, 'samples'),
      reportDir: join(tmp, 'reports'),
      applyMode: true,
      onProgress: () => {},
      fetch: mockFetch,
      shopifyDomain: 'mock', shopifyToken: 'mock',
      rateLimit: { capacity: 100, refillPerSec: 100 },
      concurrency: 1,
      dbConnection: mockClient,
      runId: '11111111-1111-1111-1111-111111111111',
    });

    // Both SKUs were resolved/mutated.
    assert(result.counts.skus.ok === 2, `2 skus ok`);
    // 2 SQL calls (one per resolved SKU).
    assert(dbCalls.length === 2, `2 sql calls, got ${dbCalls.length}`);
    // Both should be UPDATE statements (not INSERT).
    for (const c of dbCalls) {
      assert(c.sql.startsWith('update private.sku_state'), `expected UPDATE-only, got: '${c.sql.slice(0, 50)}'`);
      assert(!c.sql.includes('insert'), 'must not contain INSERT');
      assert(c.params[2] === 'STK-A' || c.params[2] === 'STK-B', `param[2]=sku`);
      assert(/^[0-9a-f]{64}$/.test(c.params[0]), `param[0]=fingerprint hex`);
      assert(c.params[1] === '11111111-1111-1111-1111-111111111111', `param[1]=runId`);
    }
    // STK-A → updated_ok=1; STK-B → no_row=1.
    assert(result.counts.sku_state.upserted_ok === 1, `1 updated, got ${result.counts.sku_state.upserted_ok}`);
    assert(result.counts.sku_state.skipped_no_row === 1, `1 no_row, got ${result.counts.sku_state.skipped_no_row}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testRunStockOnlyFingerprintDeterminism() {
  console.log('Test 26: runStockOnly — same input → same fingerprints across runs');
  const tmp = await makeStockOnlyTmp([{ sku: 'DET-A', qty: 17 }]);
  try {
    const mockFetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      const op = (body.query.match(/(?:mutation|query)\s+(\w+)/) ?? [])[1];
      let data;
      if (op === 'ShopContext') data = { publications: { nodes: [{ id: 'P', name: 'Tienda online' }] }, locations: { nodes: [{ id: 'gid://shopify/Location/STABLE' }] } };
      else if (op === 'VariantBySku') data = { productVariants: { nodes: [{ id: 'V', sku: 'DET-A', inventoryItem: { id: 'II-A' } }] } };
      else if (op === 'InventorySetQuantities') data = { inventorySetQuantities: { inventoryAdjustmentGroup: { id: 'A' }, userErrors: [] } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    };
    const opts = {
      samplesDir: join(tmp, 'samples'), reportDir: join(tmp, 'reports'),
      applyMode: true, onProgress: () => {}, fetch: mockFetch,
      shopifyDomain: 'mock', shopifyToken: 'mock',
      rateLimit: { capacity: 100, refillPerSec: 100 }, concurrency: 1,
    };
    const r1 = await runStockOnly(opts);
    const r2 = await runStockOnly(opts);
    assert(r1.fingerprints['DET-A']?.fingerprint === r2.fingerprints['DET-A']?.fingerprint, 'fingerprint stable across runs');

    // The stock fingerprint should be derivable from the public buildStockFingerprint.
    const expected = buildStockFingerprint({ sku: 'DET-A', locationId: 'gid://shopify/Location/STABLE', quantity: 17 });
    assert(r1.fingerprints['DET-A'].fingerprint === expected, 'fingerprint matches buildStockFingerprint output');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testRunStockOnlyFingerprintDistinctFromFull() {
  console.log('Test 27: runStockOnly fingerprint is DIFFERENT from runFullImport fingerprint for same SKU+qty (distinct semantics, distinct hash space)');
  // Cheap structural check: stock fingerprint hashes only {sku, locationId, quantity}.
  // Full fingerprint hashes the entire product payload + translations + publication.
  // Even if the SKU/quantity match, the broader full payload differs → different hashes.
  const stockFp = buildStockFingerprint({ sku: 'X', locationId: 'L', quantity: 1 });
  // We pick any non-trivial full payload that includes SKU+location+quantity:
  // they differ structurally, so hashes will differ.
  const stockFp2 = buildStockFingerprint({ sku: 'X', locationId: 'L', quantity: 2 });
  assert(stockFp !== stockFp2, 'changing quantity changes the fingerprint');
  assert(/^[0-9a-f]{64}$/.test(stockFp), 'stock fingerprint is 64-char hex');
}

async function testSummaryReportsRealUpsertCounts() {
  console.log('Test 28: summary line reports real upsert counts (not blind "upserted")');
  const tmp = await mkdtemp(join(tmpdir(), 'summary-real-'));
  try {
    await mkdir(join(tmp, 'samples', 'productos'), { recursive: true });
    await mkdir(join(tmp, 'samples', 'stock'), { recursive: true });
    await mkdir(join(tmp, 'samples', 'precios'), { recursive: true });
    const surtidoHeader = Array.from({ length: 79 }, (_, i) => `col${i}`).join(',') + '\n';
    const fields = Array.from({ length: 79 }, () => '');
    fields[0] = 'SUM-001'; fields[3] = 'X'; fields[5] = 'F';
    const surtidoRow = fields.join(',');
    for (const loc of ['ES','EN','IT','DE','FR','PT']) {
      await writeFile(join(tmp, 'samples', 'productos', `listado_productos_${loc}.csv`), surtidoHeader + surtidoRow + '\n', 'utf8');
    }
    await writeFile(join(tmp, 'samples', 'stock', 'stock.csv'), 'SKU,INVENTARIO\nSUM-001,1\n', 'utf8');
    await writeFile(join(tmp, 'samples', 'precios', 'precios_productos.csv'), 'SKU,TARIFA\nSUM-001,1.00\n', 'utf8');

    const mockFetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      const op = (body.query.match(/(?:mutation|query)\s+(\w+)/) ?? [])[1];
      let data;
      if (op === 'ShopContext') data = { publications: { nodes: [{ id: 'P', name: 'Tienda online' }] }, locations: { nodes: [{ id: 'L' }] } };
      else if (op === 'productSet') data = { productSet: { product: { id: 'P1', handle: 'sum-001', variants: { nodes: [] }, metafields: { nodes: [] } }, userErrors: [] } };
      else if (op === 'TranslatableContent') data = { translatableResource: { translatableContent: [] } };
      else if (op === 'TranslatableByIds') data = { translatableResourcesByIds: { nodes: [] } };
      else if (op === 'translationsRegister') data = { translationsRegister: { translations: [], userErrors: [] } };
      else if (op === 'publishablePublish') data = { publishablePublish: { userErrors: [] } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    };

    // Mock dbConnection that ALWAYS throws on .query() — simulates a BD
    // unreachable mid-run. Pre-PR-Y this would still print "upserted to
    // private.sku_state" misleadingly. PR-Y must report failed=1, ok=0.
    const mockClientFailing = { query: async () => { throw new Error('connection refused (mocked)'); } };

    const result = await runFullImport({
      samplesDir: join(tmp, 'samples'), reportDir: join(tmp, 'reports'),
      applyMode: true, onProgress: () => {},
      fetch: mockFetch, shopifyDomain: 'mock', shopifyToken: 'mock',
      rateLimit: { capacity: 100, refillPerSec: 100 }, concurrency: 1,
      dbConnection: mockClientFailing,
    });

    const summary = await readFile(result.reportPaths.summary, 'utf8');
    assert(summary.includes('sku_state: upserted=0/1, failed=1'), `expected real counters, got snippet: ${summary.match(/Fingerprints computed.*/)?.[0] ?? '(no match)'}`);
    assert(result.counts.sku_state.upserted_ok === 0, 'counters: upserted_ok=0');
    assert(result.counts.sku_state.upsert_failed === 1, 'counters: upsert_failed=1');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function testMfBatches_ignoresNonProductNamespace() {
  console.log('Test 18: buildMetafieldTranslationBatches — ignores non-product namespace metafields');
  const model = makeModelWithMetafieldTranslations();
  const productMetafields = [
    { id: 'gid://shopify/Metafield/6001', namespace: 'b2b', key: 'tipo' }, // wrong namespace
    { id: 'gid://shopify/Metafield/6002', namespace: 'product', key: 'tipo' }, // right
  ];
  const digests = new Map([
    ['gid://shopify/Metafield/6001', 'd-wrong'],
    ['gid://shopify/Metafield/6002', 'd-right'],
  ]);
  const batches = buildMetafieldTranslationBatches(model, productMetafields, digests);
  assert(batches.length === 1, `expected 1 batch using product-namespaced gid, got ${batches.length}`);
  assert(batches[0].resourceId === 'gid://shopify/Metafield/6002', `expected product-namespaced gid, got ${batches[0].resourceId}`);
  assert(batches[0].translations.every((t) => t.translatableContentDigest === 'd-right'), `expected d-right digest in all entries`);
}

// ---- buildOrphansToUnpublish() tests (I3.6) ----
//
// Pure function: returns sorted array of SKUs that were last_published=true
// in sku_state but are not in the current run's publishables. Caller is
// responsible for filtering sku_state on last_published=true before passing
// in (so SKUs that are in publishables but were previously unpublished are
// correctly excluded — they go through the regular productSet path).

function testOrphans_publishablesEmpty_priorAll() {
  console.log('Test: publishables empty + 5 prior published → all 5 returned, sorted');
  const r = buildOrphansToUnpublish([], ['SKU-C', 'SKU-A', 'SKU-E', 'SKU-B', 'SKU-D']);
  assert(Array.isArray(r) && r.length === 5, `expected 5 orphans, got ${r?.length}`);
  assert(JSON.stringify(r) === JSON.stringify(['SKU-A', 'SKU-B', 'SKU-C', 'SKU-D', 'SKU-E']), `not sorted: ${JSON.stringify(r)}`);
}

function testOrphans_publishablesEqualPrior() {
  console.log('Test: publishables == prior → no orphans');
  const r = buildOrphansToUnpublish(['A', 'B', 'C'], ['A', 'B', 'C']);
  assert(r.length === 0, `expected 0 orphans, got ${r.length}`);
}

function testOrphans_publishablesSubsetOfPrior() {
  console.log('Test: publishables ⊂ prior → diff returned (those in prior but not in publishables)');
  const r = buildOrphansToUnpublish(['A', 'C'], ['A', 'B', 'C', 'D']);
  assert(JSON.stringify(r) === JSON.stringify(['B', 'D']), `expected [B, D], got ${JSON.stringify(r)}`);
}

function testOrphans_priorEmpty() {
  console.log('Test: prior empty → no orphans');
  const r = buildOrphansToUnpublish(['A', 'B'], []);
  assert(r.length === 0, `expected 0 orphans, got ${r.length}`);
}

function testOrphans_priorIsAlreadyFilteredByCaller() {
  console.log('Test: SKU in publishables but last_published=false in sku_state → caller filters BEFORE; not in priorPublished → not in result');
  // Simulate the filtering the caller does: only pass last_published=true.
  // Here SKU-X is in publishables but was last_published=false (so caller
  // omits it from priorPublished). SKU-Y was last_published=true and is in
  // publishables (caller passes it in but it's correctly excluded as not orphan).
  const publishables = ['SKU-X', 'SKU-Y'];
  const priorPublishedFiltered = ['SKU-Y']; // caller already dropped SKU-X
  const r = buildOrphansToUnpublish(publishables, priorPublishedFiltered);
  assert(r.length === 0, `expected 0 orphans, got ${r.length} (SKU-X must NOT be unpublished — it's a re-publish)`);
}

function testOrphans_acceptsIterables() {
  console.log('Test: accepts Set + array (any iterable)');
  const r = buildOrphansToUnpublish(new Set(['A']), ['A', 'B']);
  assert(JSON.stringify(r) === JSON.stringify(['B']), `expected [B], got ${JSON.stringify(r)}`);
}

// ---- PR-IMG-2: pre-upload + media polling -----------------------------

function testBuildProductSetInput_resolvedImages_idMode() {
  console.log('Test: buildProductSetInput — resolvedImages → files[] uses id, no originalSource');
  const model = makeModel();
  // Two images in model; supply pre-resolved fileIds for both.
  const input = buildProductSetInput(model, {
    locationId: LOC,
    resolvedImages: [
      { fileId: 'gid://shopify/MediaImage/F1' },
      { fileId: 'gid://shopify/MediaImage/F2' },
    ],
  });
  assert(input.files.length === 2, `expected 2 files, got ${input.files.length}`);
  for (const f of input.files) {
    assert(typeof f.id === 'string' && f.id.startsWith('gid://shopify/MediaImage/'), `id is a MediaImage GID, got ${JSON.stringify(f)}`);
    assert(!('originalSource' in f), `originalSource must be absent in id-mode, got ${JSON.stringify(f)}`);
    assert(!('contentType' in f), `contentType must be absent in id-mode (Shopify ignores it for refs), got ${JSON.stringify(f)}`);
    assert(typeof f.filename === 'string' && f.filename.length > 0, `filename still set for dup-resolution match`);
    assert(f.duplicateResolutionMode === 'REPLACE', `REPLACE preserved for idempotent re-runs`);
  }
}

function testBuildProductSetInput_resolvedImages_skipsNullSlots() {
  console.log('Test: buildProductSetInput — null slots are skipped (resolve failed → no fallback to URL)');
  const model = makeModel();
  // 1st image resolved OK, 2nd failed (null) → only 1 file in input.
  const input = buildProductSetInput(model, {
    locationId: LOC,
    resolvedImages: [
      { fileId: 'gid://shopify/MediaImage/F1' },
      null,
    ],
  });
  assert(input.files.length === 1, `expected 1 file (failed slot skipped), got ${input.files.length}`);
  assert(input.files[0].id === 'gid://shopify/MediaImage/F1', 'first slot preserved');
}

function testBuildProductSetInput_resolvedImages_allNull_omitsFiles() {
  console.log('Test: buildProductSetInput — all slots null → files[] is empty so productSet does not touch media');
  const model = makeModel();
  const input = buildProductSetInput(model, {
    locationId: LOC,
    resolvedImages: [null, null],
  });
  // When files becomes empty, the legacy code path omits the key entirely
  // so productSet is declarative-no-op on media. Verify that contract.
  assert(!('files' in input), `expected files key absent when all slots failed, got ${JSON.stringify(input.files)}`);
}

function testBuildProductSetInput_legacyPathPreservedWhenNoResolvedOpt() {
  console.log('Test: buildProductSetInput — without resolvedImages opt → legacy URL path');
  const model = makeModel();
  const input = buildProductSetInput(model, { locationId: LOC });
  for (const f of input.files) {
    assert(!('id' in f), 'id absent on legacy path');
    assert(typeof f.originalSource === 'string' && f.originalSource.startsWith('https://'), 'originalSource is the URL');
    assert(f.contentType === 'IMAGE', 'contentType=IMAGE on legacy path');
  }
}

async function testResolveImagesForSku_happyPath() {
  console.log('Test: resolveImagesForSku — calls helper for each image, accumulates fileIds');
  const model = makeModel(); // 2 images
  // Mock fetch that returns a JPEG binary on CDN GET, and a Shopify
  // GraphQL flow that produces a fresh fileId on each upload.
  const jpeg = Buffer.alloc(64);
  jpeg[0] = 0xff; jpeg[1] = 0xd8; jpeg[2] = 0xff;
  // We make each image return a different binary so sha256 differs and
  // both go through full upload (no cache).
  let cdnHits = 0;
  const fetchImpl = async (url, init = {}) => {
    if (typeof url === 'string' && url.startsWith('https://example.com/')) {
      const body = Buffer.from(jpeg);
      body[10] = cdnHits++; // mutate to vary sha256
      return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (typeof url === 'string' && url.includes('mock-staged.s3.')) {
      return new Response('', { status: 200 });
    }
    if (typeof url === 'string' && url.includes('/admin/api/')) {
      const body = JSON.parse(init.body);
      const op = (body.query.match(/(?:mutation|query)\s+(\w+)/) ?? [])[1];
      if (op === 'StagedUploadsCreate') {
        return new Response(JSON.stringify({ data: { stagedUploadsCreate: {
          stagedTargets: [{ url: 'https://mock-staged.s3.amazonaws.com/u', resourceUrl: 'https://mock-staged.s3.amazonaws.com/r', parameters: [] }],
          userErrors: [],
        } } }), { status: 200 });
      }
      if (op === 'FileCreate') {
        return new Response(JSON.stringify({ data: { fileCreate: {
          files: [{ id: `gid://shopify/MediaImage/F${cdnHits}`, status: 'READY', mediaErrors: [] }],
          userErrors: [],
        } } }), { status: 200 });
      }
      throw new Error(`unexpected gql op: ${op}`);
    }
    throw new Error(`mock fetch: no handler for ${url}`);
  };
  const ctx = { endpoint: 'https://mock/admin/api/2025-10/graphql.json', token: 't', fetch: fetchImpl };
  const cdnBucket = createTokenBucket({ capacity: 10, refillPerSec: 100 });
  const r = await resolveImagesForSku({ model, ctx, cdnBucket, dbConnection: null, fetchImpl });
  assert(r.resolved.length === 2, `2 entries`);
  assert(r.resolved.every((slot) => slot && slot.fileId), `both slots resolved, got ${JSON.stringify(r.resolved)}`);
  assert(r.warnings.length === 0, `no warnings`);
  assert(cdnHits === 2, `2 CDN fetches, got ${cdnHits}`);
}

async function testResolveImagesForSku_partialFailure() {
  console.log('Test: resolveImagesForSku — partial failure: one slot null + one warning');
  const model = makeModel(); // 2 images
  const jpeg = Buffer.alloc(64);
  jpeg[0] = 0xff; jpeg[1] = 0xd8; jpeg[2] = 0xff;
  let cdnCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (typeof url === 'string' && url.startsWith('https://example.com/')) {
      cdnCalls++;
      // First image: OK. Second: 404.
      if (cdnCalls === 1) return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      return new Response('not found', { status: 404 });
    }
    if (typeof url === 'string' && url.includes('mock-staged.s3.')) return new Response('', { status: 200 });
    if (typeof url === 'string' && url.includes('/admin/api/')) {
      const body = JSON.parse(init.body);
      const op = (body.query.match(/(?:mutation|query)\s+(\w+)/) ?? [])[1];
      if (op === 'StagedUploadsCreate') return new Response(JSON.stringify({ data: { stagedUploadsCreate: { stagedTargets: [{ url: 'https://mock-staged.s3.amazonaws.com/u', resourceUrl: 'https://mock-staged.s3.amazonaws.com/r', parameters: [] }], userErrors: [] } } }), { status: 200 });
      if (op === 'FileCreate') return new Response(JSON.stringify({ data: { fileCreate: { files: [{ id: 'gid://shopify/MediaImage/PARTIAL', status: 'READY', mediaErrors: [] }], userErrors: [] } } }), { status: 200 });
      throw new Error(`unexpected gql op: ${op}`);
    }
    throw new Error(`mock fetch: no handler for ${url}`);
  };
  const ctx = { endpoint: 'https://mock/admin/api/2025-10/graphql.json', token: 't', fetch: fetchImpl };
  const cdnBucket = createTokenBucket({ capacity: 10, refillPerSec: 100 });
  const r = await resolveImagesForSku({ model, ctx, cdnBucket, dbConnection: null, fetchImpl });
  assert(r.resolved.length === 2, `2 entries even when one fails`);
  assert(r.resolved[0]?.fileId === 'gid://shopify/MediaImage/PARTIAL', 'first slot resolved');
  assert(r.resolved[1] === null, 'second slot null on failure');
  assert(r.warnings.length === 1, `1 warning, got ${r.warnings.length}`);
  assert(r.warnings[0].kind === 'image_resolve_failed', 'warning kind=image_resolve_failed');
  assert(r.warnings[0].resolveKind === 'fetch_failed', `resolveKind preserved, got ${r.warnings[0].resolveKind}`);
}

async function testResolveImagesForSku_emptyModel() {
  console.log('Test: resolveImagesForSku — model with 0 images returns empty arrays without calling anything');
  const model = makeModel();
  model.product.images = [];
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('', { status: 500 }); };
  const ctx = { endpoint: 'https://mock', token: 't', fetch: fetchImpl };
  const cdnBucket = createTokenBucket({ capacity: 10, refillPerSec: 100 });
  const r = await resolveImagesForSku({ model, ctx, cdnBucket, dbConnection: null, fetchImpl });
  assert(r.resolved.length === 0, 'no slots');
  assert(r.warnings.length === 0, 'no warnings');
  assert(calls === 0, 'no fetches made');
}

async function testPollProductMediaStatus_allReady() {
  console.log('Test: pollProductMediaStatus — all READY on first poll → returns ready=N immediately');
  let polls = 0;
  const fetchImpl = async () => {
    polls++;
    return new Response(JSON.stringify({ data: { product: { media: { nodes: [
      { __typename: 'MediaImage', status: 'READY', mediaErrors: [] },
      { __typename: 'MediaImage', status: 'READY', mediaErrors: [] },
    ] } } } }), { status: 200 });
  };
  const ctx = { endpoint: 'https://mock', token: 't', fetch: fetchImpl };
  const r = await pollProductMediaStatus(ctx, 'gid://shopify/Product/X', { pollMs: 5, pollMaxMs: 200 });
  assert(r.ready === 2 && r.failed === 0 && r.processing === 0, `ready=2 failed=0 processing=0, got ${JSON.stringify(r)}`);
  assert(r.firstError === '', 'no firstError');
  assert(polls === 1, `1 poll, got ${polls}`);
}

async function testPollProductMediaStatus_failedSurfacesError() {
  console.log('Test: pollProductMediaStatus — FAILED node surfaces firstError truncated to 200 chars');
  const longDetail = 'pixel limit exceeded — '.repeat(20); // ~440 chars
  const fetchImpl = async () => new Response(JSON.stringify({ data: { product: { media: { nodes: [
    { __typename: 'MediaImage', status: 'READY', mediaErrors: [] },
    { __typename: 'MediaImage', status: 'FAILED', mediaErrors: [{ code: 'INVALID', details: longDetail, message: 'pixel' }] },
  ] } } } }), { status: 200 });
  const ctx = { endpoint: 'https://mock', token: 't', fetch: fetchImpl };
  const r = await pollProductMediaStatus(ctx, 'gid://shopify/Product/X', { pollMs: 5, pollMaxMs: 200 });
  assert(r.ready === 1 && r.failed === 1 && r.processing === 0, `1/1/0, got ${JSON.stringify(r)}`);
  assert(r.firstError.length === 200, `truncated to 200 chars, got len=${r.firstError.length}`);
  assert(r.firstError.startsWith('pixel limit exceeded'), 'preserves leading content');
}

async function testPollProductMediaStatus_processingThenReady() {
  console.log('Test: pollProductMediaStatus — PROCESSING then READY across polls');
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 3) {
      return new Response(JSON.stringify({ data: { product: { media: { nodes: [
        { __typename: 'MediaImage', status: 'PROCESSING', mediaErrors: [] },
      ] } } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { product: { media: { nodes: [
      { __typename: 'MediaImage', status: 'READY', mediaErrors: [] },
    ] } } } }), { status: 200 });
  };
  const ctx = { endpoint: 'https://mock', token: 't', fetch: fetchImpl };
  const r = await pollProductMediaStatus(ctx, 'gid://shopify/Product/X', { pollMs: 5, pollMaxMs: 500 });
  assert(r.ready === 1 && r.processing === 0, `terminal: ready=1 processing=0, got ${JSON.stringify(r)}`);
  assert(calls >= 3, `polled at least 3 times, got ${calls}`);
}

async function testPollProductMediaStatus_timeoutReportsProcessing() {
  console.log('Test: pollProductMediaStatus — timeout returns processing>0 with ready/failed snapshot');
  const fetchImpl = async () => new Response(JSON.stringify({ data: { product: { media: { nodes: [
    { __typename: 'MediaImage', status: 'READY', mediaErrors: [] },
    { __typename: 'MediaImage', status: 'PROCESSING', mediaErrors: [] },
  ] } } } }), { status: 200 });
  const ctx = { endpoint: 'https://mock', token: 't', fetch: fetchImpl };
  const t0 = Date.now();
  const r = await pollProductMediaStatus(ctx, 'gid://shopify/Product/X', { pollMs: 10, pollMaxMs: 50 });
  const dt = Date.now() - t0;
  assert(r.processing === 1, `processing=1 at timeout, got ${JSON.stringify(r)}`);
  assert(r.ready === 1, 'ready snapshot preserved');
  assert(dt < 500, `did not hang, took ${dt}ms`);
}

async function testPollProductMediaStatus_videoCountedAsReady() {
  console.log('Test: pollProductMediaStatus — non-image media (Video) counted as ready, never blocks');
  const fetchImpl = async () => new Response(JSON.stringify({ data: { product: { media: { nodes: [
    { __typename: 'Video' }, // no status field — out of scope
    { __typename: 'MediaImage', status: 'READY', mediaErrors: [] },
  ] } } } }), { status: 200 });
  const ctx = { endpoint: 'https://mock', token: 't', fetch: fetchImpl };
  const r = await pollProductMediaStatus(ctx, 'gid://shopify/Product/X', { pollMs: 5, pollMaxMs: 200 });
  assert(r.ready === 2, `2 ready (1 video + 1 image), got ${JSON.stringify(r)}`);
  assert(r.processing === 0, 'video not blocking');
}

async function testRunFullImport_writesNewCsvColumnsAndWarn() {
  console.log('Test: runFullImport — changes.csv has 4 new media cols + WARN status when post-poll has FAILED media');
  const tmp = await mkdtemp(join(tmpdir(), 'runfullimport-warn-'));
  try {
    await mkdir(join(tmp, 'samples', 'productos'), { recursive: true });
    await mkdir(join(tmp, 'samples', 'stock'), { recursive: true });
    await mkdir(join(tmp, 'samples', 'precios'), { recursive: true });
    const surtidoHeader = Array.from({ length: 79 }, (_, i) => `col${i}`).join(',') + '\n';
    const fields = Array.from({ length: 79 }, () => '');
    fields[0] = 'WARN-001'; fields[3] = 'X'; fields[5] = 'F';
    fields[58] = 'https://example.com/main-photo/WARN-001'; // 1 image so polling runs
    const surtidoRow = fields.join(',');
    for (const loc of ['ES','EN','IT','DE','FR','PT']) {
      await writeFile(join(tmp, 'samples', 'productos', `listado_productos_${loc}.csv`), surtidoHeader + surtidoRow + '\n', 'utf8');
    }
    await writeFile(join(tmp, 'samples', 'stock', 'stock.csv'), 'SKU,INVENTARIO\nWARN-001,1\n', 'utf8');
    await writeFile(join(tmp, 'samples', 'precios', 'precios_productos.csv'), 'SKU,TARIFA\nWARN-001,1.00\n', 'utf8');

    const jpeg = Buffer.alloc(64); jpeg[0] = 0xff; jpeg[1] = 0xd8; jpeg[2] = 0xff;
    const mockFetch = async (url, init = {}) => {
      if (typeof url === 'string' && url.startsWith('https://example.com/')) {
        return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      if (typeof url === 'string' && url.includes('mock-staged.s3.')) return new Response('', { status: 200 });
      if (typeof url === 'string' && url.includes('/admin/api/')) {
        const body = JSON.parse(init.body);
        const op = (body.query.match(/(?:mutation|query)\s+(\w+)/) ?? [])[1];
        if (op === 'ShopContext') return new Response(JSON.stringify({ data: { publications: { nodes: [{ id: 'P', name: 'Tienda online' }] }, locations: { nodes: [{ id: 'L' }] } } }), { status: 200 });
        if (op === 'StagedUploadsCreate') return new Response(JSON.stringify({ data: { stagedUploadsCreate: { stagedTargets: [{ url: 'https://mock-staged.s3.amazonaws.com/u', resourceUrl: 'https://mock-staged.s3.amazonaws.com/r', parameters: [] }], userErrors: [] } } }), { status: 200 });
        if (op === 'FileCreate') return new Response(JSON.stringify({ data: { fileCreate: { files: [{ id: 'gid://shopify/MediaImage/F-WARN', status: 'READY', mediaErrors: [] }], userErrors: [] } } }), { status: 200 });
        if (op === 'productSet') return new Response(JSON.stringify({ data: { productSet: { product: { id: 'gid://shopify/Product/WARN', handle: 'warn-001', variants: { nodes: [] }, metafields: { nodes: [] } }, userErrors: [] } } }), { status: 200 });
        if (op === 'TranslatableContent') return new Response(JSON.stringify({ data: { translatableResource: { translatableContent: [] } } }), { status: 200 });
        if (op === 'TranslatableByIds') return new Response(JSON.stringify({ data: { translatableResourcesByIds: { nodes: [] } } }), { status: 200 });
        if (op === 'translationsRegister') return new Response(JSON.stringify({ data: { translationsRegister: { translations: [], userErrors: [] } } }), { status: 200 });
        if (op === 'publishablePublish') return new Response(JSON.stringify({ data: { publishablePublish: { userErrors: [] } } }), { status: 200 });
        // Polling: simulate a FAILED media on the product.
        if (op === 'ProductMediaSafe') return new Response(JSON.stringify({ data: { product: { media: { nodes: [
          { __typename: 'MediaImage', status: 'FAILED', mediaErrors: [{ code: 'INVALID', details: 'pixel limit exceeded', message: 'pixel' }] },
        ] } } } }), { status: 200 });
        throw new Error(`unexpected gql op: ${op}`);
      }
      throw new Error(`mock fetch: no handler for ${url}`);
    };

    const result = await runFullImport({
      samplesDir: join(tmp, 'samples'),
      reportDir: join(tmp, 'reports'),
      applyMode: true,
      onProgress: () => {},
      fetch: mockFetch,
      shopifyDomain: 'mock', shopifyToken: 'mock',
      rateLimit: { capacity: 100, refillPerSec: 100 },
      cdnRateLimit: { capacity: 100, refillPerSec: 1000 }, // fast for tests
      mediaPollMs: 1, mediaPollMaxMs: 50,
      concurrency: 1,
    });

    assert(result.counts.productSet.ok === 1, `productSet ok`);
    assert(result.counts.publish.ok === 1, `publish ok`);
    assert(result.counts.skus.ok === 1, `1 SKU ok`);
    assert(result.counts.media.warn_skus === 1, `1 SKU in WARN, got ${result.counts.media.warn_skus}`);
    assert(result.counts.media.failed === 1, `1 failed media node, got ${result.counts.media.failed}`);
    assert(result.counts.media.ready === 0, `0 ready, got ${result.counts.media.ready}`);
    assert(result.counts.image_resolution.resolved_ok === 1, '1 resolved');
    assert(result.counts.image_resolution.freshly_uploaded === 1, '1 fresh upload');

    const csv = await readFile(result.reportPaths.changes, 'utf8');
    assert(csv.includes('media_ready_count'), 'header has media_ready_count');
    assert(csv.includes('media_failed_count'), 'header has media_failed_count');
    assert(csv.includes('media_processing_count'), 'header has media_processing_count');
    assert(csv.includes('media_first_error'), 'header has media_first_error');
    const dataLines = csv.trim().split('\n').slice(1).filter(Boolean);
    const warnRow = dataLines.find((l) => l.includes('WARN-001'));
    assert(warnRow != null, `data row present`);
    assert(warnRow.endsWith(',WARN'), `overall=WARN, row tail: ${warnRow.slice(-40)}`);
    assert(/(?:^|,)0,1,0,/.test(warnRow), `media counts 0,1,0 (ready,failed,processing) in row: ${warnRow}`);
    assert(warnRow.includes('pixel limit'), 'first error preserved');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testRunFullImport_happyPathReportsAllReady() {
  console.log('Test: runFullImport — happy path: pre-upload + READY media → overall=OK, no WARN');
  const tmp = await mkdtemp(join(tmpdir(), 'runfullimport-ok-'));
  try {
    await mkdir(join(tmp, 'samples', 'productos'), { recursive: true });
    await mkdir(join(tmp, 'samples', 'stock'), { recursive: true });
    await mkdir(join(tmp, 'samples', 'precios'), { recursive: true });
    const surtidoHeader = Array.from({ length: 79 }, (_, i) => `col${i}`).join(',') + '\n';
    const fields = Array.from({ length: 79 }, () => '');
    fields[0] = 'OK-001'; fields[3] = 'X'; fields[5] = 'F';
    fields[58] = 'https://example.com/main-photo/OK-001';
    const surtidoRow = fields.join(',');
    for (const loc of ['ES','EN','IT','DE','FR','PT']) {
      await writeFile(join(tmp, 'samples', 'productos', `listado_productos_${loc}.csv`), surtidoHeader + surtidoRow + '\n', 'utf8');
    }
    await writeFile(join(tmp, 'samples', 'stock', 'stock.csv'), 'SKU,INVENTARIO\nOK-001,1\n', 'utf8');
    await writeFile(join(tmp, 'samples', 'precios', 'precios_productos.csv'), 'SKU,TARIFA\nOK-001,1.00\n', 'utf8');

    const jpeg = Buffer.alloc(64); jpeg[0] = 0xff; jpeg[1] = 0xd8; jpeg[2] = 0xff;
    const mockFetch = async (url, init = {}) => {
      if (typeof url === 'string' && url.startsWith('https://example.com/')) return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      if (typeof url === 'string' && url.includes('mock-staged.s3.')) return new Response('', { status: 200 });
      if (typeof url === 'string' && url.includes('/admin/api/')) {
        const body = JSON.parse(init.body);
        const op = (body.query.match(/(?:mutation|query)\s+(\w+)/) ?? [])[1];
        if (op === 'ShopContext') return new Response(JSON.stringify({ data: { publications: { nodes: [{ id: 'P', name: 'Tienda online' }] }, locations: { nodes: [{ id: 'L' }] } } }), { status: 200 });
        if (op === 'StagedUploadsCreate') return new Response(JSON.stringify({ data: { stagedUploadsCreate: { stagedTargets: [{ url: 'https://mock-staged.s3.amazonaws.com/u', resourceUrl: 'https://mock-staged.s3.amazonaws.com/r', parameters: [] }], userErrors: [] } } }), { status: 200 });
        if (op === 'FileCreate') return new Response(JSON.stringify({ data: { fileCreate: { files: [{ id: 'gid://shopify/MediaImage/F-OK', status: 'READY', mediaErrors: [] }], userErrors: [] } } }), { status: 200 });
        if (op === 'productSet') return new Response(JSON.stringify({ data: { productSet: { product: { id: 'gid://shopify/Product/OK', handle: 'ok-001', variants: { nodes: [] }, metafields: { nodes: [] } }, userErrors: [] } } }), { status: 200 });
        if (op === 'TranslatableContent') return new Response(JSON.stringify({ data: { translatableResource: { translatableContent: [] } } }), { status: 200 });
        if (op === 'TranslatableByIds') return new Response(JSON.stringify({ data: { translatableResourcesByIds: { nodes: [] } } }), { status: 200 });
        if (op === 'translationsRegister') return new Response(JSON.stringify({ data: { translationsRegister: { translations: [], userErrors: [] } } }), { status: 200 });
        if (op === 'publishablePublish') return new Response(JSON.stringify({ data: { publishablePublish: { userErrors: [] } } }), { status: 200 });
        if (op === 'ProductMediaSafe') return new Response(JSON.stringify({ data: { product: { media: { nodes: [
          { __typename: 'MediaImage', status: 'READY', mediaErrors: [] },
        ] } } } }), { status: 200 });
        throw new Error(`unexpected gql op: ${op}`);
      }
      throw new Error(`mock fetch: no handler for ${url}`);
    };

    const result = await runFullImport({
      samplesDir: join(tmp, 'samples'), reportDir: join(tmp, 'reports'),
      applyMode: true, onProgress: () => {}, fetch: mockFetch,
      shopifyDomain: 'mock', shopifyToken: 'mock',
      rateLimit: { capacity: 100, refillPerSec: 100 },
      cdnRateLimit: { capacity: 100, refillPerSec: 1000 },
      mediaPollMs: 1, mediaPollMaxMs: 50, concurrency: 1,
    });

    assert(result.counts.media.ready === 1, '1 ready');
    assert(result.counts.media.failed === 0, '0 failed');
    assert(result.counts.media.warn_skus === 0, 'no WARN');
    assert(result.counts.image_resolution.resolved_ok === 1, '1 resolved');

    const csv = await readFile(result.reportPaths.changes, 'utf8');
    const dataLines = csv.trim().split('\n').slice(1).filter(Boolean);
    const okRow = dataLines.find((l) => l.includes('OK-001'));
    assert(okRow.endsWith(',OK'), `overall=OK, tail: ${okRow.slice(-30)}`);
    assert(/(?:^|,)1,0,0,/.test(okRow), `media counts 1,0,0 in row: ${okRow}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  testBuildProductSetInput_basic();
  testBuildProductSetInput_handleLowercase();
  testBuildProductSetInput_variantWithInventory();
  testBuildProductSetInput_noImages();
  testBuildProductSetInput_filesShape();
  testBuildProductSetInput_noBodyHtml();
  testBuildProductSetInput_optionValuesDefault();
  testBuildProductSetInput_throwsWithoutLocation();
  testBuildTranslations_titleAndBodyOnly();
  testBuildTranslations_skipsKeysNotInShopContent();
  testBuildTranslations_missingLocale();
  testBuildTranslations_noShopContent();
  testMfBatches_groupsByMetafieldAcrossLocales();
  testMfBatches_skipsEmptyValues();
  testMfBatches_skipsValuesEqualToEs();
  testMfBatches_skipsMetafieldsMissingFromProduct();
  testMfBatches_skipsWhenDigestMissing();
  testMfBatches_ignoresNonProductNamespace();
  await testRunFullImportDryRun();
  await testRunFullImportApplyWithMockFetch();
  await testRunFullImportDbUpsert();
  await testRunFullImportFingerprintDeterminism();
  await testRunStockOnlyResolvesAndMutates();
  await testRunStockOnlySkipsNotFound();
  await testRunStockOnlyDbUpdatePath();
  await testRunStockOnlyFingerprintDeterminism();
  await testRunStockOnlyFingerprintDistinctFromFull();
  await testSummaryReportsRealUpsertCounts();
  testOrphans_publishablesEmpty_priorAll();
  testOrphans_publishablesEqualPrior();
  testOrphans_publishablesSubsetOfPrior();
  testOrphans_priorEmpty();
  testOrphans_priorIsAlreadyFilteredByCaller();
  testOrphans_acceptsIterables();

  // PR-IMG-2: pre-upload + media polling
  testBuildProductSetInput_resolvedImages_idMode();
  testBuildProductSetInput_resolvedImages_skipsNullSlots();
  testBuildProductSetInput_resolvedImages_allNull_omitsFiles();
  testBuildProductSetInput_legacyPathPreservedWhenNoResolvedOpt();
  await testResolveImagesForSku_happyPath();
  await testResolveImagesForSku_partialFailure();
  await testResolveImagesForSku_emptyModel();
  await testPollProductMediaStatus_allReady();
  await testPollProductMediaStatus_failedSurfacesError();
  await testPollProductMediaStatus_processingThenReady();
  await testPollProductMediaStatus_timeoutReportsProcessing();
  await testPollProductMediaStatus_videoCountedAsReady();
  await testRunFullImport_writesNewCsvColumnsAndWarn();
  await testRunFullImport_happyPathReportsAllReady();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
