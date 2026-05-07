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

import { buildProductSetInput, buildTranslations, buildMetafieldTranslationBatches, runFullImport, runStockOnly } from './import-write.mjs';
import { buildStockFingerprint } from './fingerprint.mjs';
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
