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

import { buildProductSetInput, buildTranslations, buildMetafieldTranslationBatches } from './import-write.mjs';

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

function main() {
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main();
