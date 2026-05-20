#!/usr/bin/env node
// Unit tests for scripts/import-map.mjs.
// Zero dependencies. Run: node scripts/import-map.test.mjs

import { buildTitle, coerce, parsePrice, buildShopifyModel } from './import-map.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) { passed++; }
  else { failed++; failures.push(message); console.error(`  ✗ ${message}`); }
}

function assertEq(actual, expected, label) {
  assert(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function testCleanIdempotent() {
  console.log('Test 1: input limpio → resultado idéntico al actual (idempotencia post-collapse)');
  const r = buildTitle('Easy Square 120mm', 'Empotrable de techo', 'Blanco, Opal', 'SKU-A');
  assertEq(r.title, 'Easy Square 120mm Empotrable de techo Blanco', 'clean compose');
  assert(r.warning == null, 'no warning on clean compose');
}

function testDoubleSpaceCollapsed() {
  console.log('Test 2: doble espacio interno en familia → colapsado en el title final');
  const r = buildTitle('Gea Power LED Round  ø180mm', 'Empotrable de suelo', 'Acero inoxidable, Transparente', 'SKU-B');
  assertEq(r.title, 'Gea Power LED Round ø180mm Empotrable de suelo Acero', 'collapsed double space');
  assert(!r.title.includes('  '), 'no double-space in result');
}

function testEdgeWhitespace() {
  console.log('Test 3: whitespace al borde de cada componente → sin leading/trailing y sin colapsar contenido');
  const r = buildTitle('  A  ', '\tC\t', 'D ', 'SKU-C');
  assertEq(r.title, 'A C D', 'trim + single-space inside');
  assert(r.title === r.title.trim(), 'no leading/trailing space');
}

function testFallbackToSku() {
  console.log('Test 4: todos los inputs vacíos → fallback al SKU + warning');
  const r = buildTitle(null, null, null, 'SKU-D');
  assertEq(r.title, 'SKU-D', 'fallback to sku');
  assert(r.warning?.kind === 'title_fallback_to_sku', 'fallback warning emitted');
}

function testRealGeaCase() {
  console.log('Test 5 (real): Gea Power LED Round ø180mm tras la regla — sin doble espacio');
  const r = buildTitle('Gea Power LED Round  ø180mm', 'Empotrable de suelo', 'Acero inoxidable AISI 316, Transparente', '55-9665-CA-CL');
  assertEq(r.title, 'Gea Power LED Round ø180mm Empotrable de suelo Acero', 'real Gea case collapsed');
  assert(!r.title.includes('  '), 'no double-space in real case');
}

function testTabsAndNewlinesCollapsed() {
  console.log('Test 6 (defensive): tabs/newlines también colapsan a un solo espacio');
  const r = buildTitle('A\tB', 'C\nD', 'E', 'SKU-E');
  assertEq(r.title, 'A B C D E', 'tabs and newlines normalized to spaces');
}

// ---- coerce() tests (range-truncation fix, 2026-05-07) ----

function testCoerceRangeNumericNumeric() {
  console.log('Test 7: coerce("36-61", number_decimal) → null + warning (was 36 with parseFloat)');
  const r = coerce('36-61', 'number_decimal', '05-4787-BW-BW', 16, 'ES');
  assertEq(r.value, null, 'value=null on "36-61"');
  assert(r.warning?.kind === 'numeric_unparsable', `expected numeric_unparsable warning, got ${JSON.stringify(r.warning)}`);
  assert(r.warning?.sku === '05-4787-BW-BW' && r.warning?.column === 16 && r.warning?.locale === 'ES', 'warning carries sku/column/locale');
  assert(r.warning?.message?.includes('"36-61"'), 'warning message includes literal CSV value');
}

function testCoerceRangeNumericNumericLargeAlto() {
  console.log('Test 8: coerce("600-1980", number_decimal) → null + warning');
  const r = coerce('600-1980', 'number_decimal', '00-5694-05-05', 18, 'ES');
  assertEq(r.value, null, 'value=null on "600-1980"');
  assert(r.warning?.kind === 'numeric_unparsable', 'warning emitted');
  assert(r.warning?.message?.includes('"600-1980"'), 'message includes literal value');
}

function testCoerceCommaDecimalRegression() {
  console.log('Test 9 (regression): coerce("1,1", number_decimal) → 1.1');
  const r = coerce('1,1', 'number_decimal', 'TEST', 28, 'ES');
  assertEq(r.value, 1.1, 'value=1.1 from ES decimal comma');
  assert(r.warning == null, 'no warning on valid ES-format decimal');
}

function testCoerceCommaTrailingZeroRegression() {
  console.log('Test 10 (regression): coerce("94,00", number_decimal) → 94');
  const r = coerce('94,00', 'number_decimal', 'TEST', 50, 'ES');
  assertEq(r.value, 94, 'value=94 from ES decimal comma with trailing zeros');
  assert(r.warning == null, 'no warning');
}

function testCoerceIntegerClean() {
  console.log('Test 11: coerce("92", number_integer) → 92');
  const r = coerce('92', 'number_integer', 'TEST', 53, 'ES');
  assertEq(r.value, 92, 'value=92 integer');
  assert(r.warning == null, 'no warning');
}

function testCoerceIntegerTruncatesDecimal() {
  console.log('Test 12 (regression of parseInt semantics): coerce("3.7", number_integer) → 3');
  // Original parseInt("3.7", 10) returned 3 (truncates fractional part).
  // The new Number()+Math.trunc must preserve that semantics for integer fields.
  const r = coerce('3.7', 'number_integer', 'TEST', 53, 'ES');
  assertEq(r.value, 3, 'integer fields still truncate fractional input');
}

function testCoerceTextPrefixedRangeStillFails() {
  console.log('Test 13 (regression): coerce("Min. 30 Max. 415", number_decimal) → null + warning (already covered by I2.5, must keep working)');
  const r = coerce('Min. 30 Max. 415', 'number_decimal', 'TEST', 19, 'ES');
  assertEq(r.value, null, 'still null for text-prefixed range');
  assert(r.warning?.kind === 'numeric_unparsable', 'warning still emitted');
}

function testCoerceDiameterPrefixStillFails() {
  console.log('Test 14 (regression): coerce("∅78", number_decimal) → null + warning (already covered by I2.5)');
  const r = coerce('∅78', 'number_decimal', 'TEST', 17, 'ES');
  assertEq(r.value, null, 'still null for diameter prefix');
  assert(r.warning?.kind === 'numeric_unparsable', 'warning still emitted');
}

// ---- parsePrice() tests (SFTP price format fix, 2026-05-08) ----
//
// Bug context: the ERP exports prices as "15,00€" (ES decimal + currency
// suffix). The old loader called Number() on the raw string, which yields
// NaN, so every SKU got mapped to null and classified as price_zero. Run
// 3fbcc5c2 (full pipeline against SFTP CSV) hid all 733 SKUs because of
// this. parsePrice() normalizes the string before Number() and distinguishes
// genuinely-invalid values from legitimate zeros.

function assertPrice(input, expectedValue, expectedInvalid, label) {
  const r = parsePrice(input);
  assertEq(r.value, expectedValue, `${label}: value`);
  assertEq(r.invalid, expectedInvalid, `${label}: invalid flag`);
}

function testParsePriceUsDecimal() {
  console.log('Test 15: parsePrice("28.87") → value=28.87, invalid=false (US decimal, no symbol)');
  assertPrice('28.87', 28.87, false, '"28.87"');
}

function testParsePriceEsDecimal() {
  console.log('Test 16: parsePrice("15,00") → value=15, invalid=false (ES decimal, no symbol)');
  assertPrice('15,00', 15, false, '"15,00"');
}

function testParsePriceEsDecimalWithEuro() {
  console.log('Test 17: parsePrice("15,00€") → value=15, invalid=false (ES decimal + €) — the actual SFTP format');
  assertPrice('15,00€', 15, false, '"15,00€"');
}

function testParsePriceUsDecimalWithEuro() {
  console.log('Test 18 (edge): parsePrice("15.00€") → value=15, invalid=false (US decimal + €)');
  assertPrice('15.00€', 15, false, '"15.00€"');
}

function testParsePriceEsThousandsAndDecimal() {
  console.log('Test 19: parsePrice("1.234,56") → value=1234.56, invalid=false (ES thousands sep + decimal)');
  assertPrice('1.234,56', 1234.56, false, '"1.234,56"');
}

function testParsePriceMultipleEsThousands() {
  console.log('Test 20: parsePrice("1.234.567,89") → value=1234567.89, invalid=false (multiple ES thousands sep)');
  assertPrice('1.234.567,89', 1234567.89, false, '"1.234.567,89"');
}

function testParsePriceUsDecimalNoSymbol() {
  console.log('Test 21: parsePrice("1234.56") → value=1234.56, invalid=false (period as decimal, no thousands)');
  assertPrice('1234.56', 1234.56, false, '"1234.56"');
}

function testParsePriceEmpty() {
  console.log('Test 22: parsePrice("") → value=null, invalid=true');
  assertPrice('', null, true, '""');
}

function testParsePriceGarbage() {
  console.log('Test 23: parsePrice("abc") → value=null, invalid=true');
  assertPrice('abc', null, true, '"abc"');
}

function testParsePriceZeroNotInvalid() {
  console.log('Test 24: parsePrice("0,00") → value=0, invalid=false (zero is a valid price, not invalid)');
  assertPrice('0,00', 0, false, '"0,00"');
}

function testParsePriceZeroWithEuroNotInvalid() {
  console.log('Test 25: parsePrice("0,00€") → value=0, invalid=false');
  assertPrice('0,00€', 0, false, '"0,00€"');
}

function testParsePriceWhitespaceAndSpacedEuro() {
  console.log('Test 26: parsePrice("  15,00 €") → value=15, invalid=false (leading/trailing/internal spaces)');
  assertPrice('  15,00 €', 15, false, '"  15,00 €"');
}

function testParsePriceNbspBeforeEuro() {
  console.log('Test 27: parsePrice("15,00\\u00a0€") → value=15, invalid=false (NBSP between value and currency)');
  assertPrice('15,00 €', 15, false, '"15,00<NBSP>€"');
}

function testParsePriceNullInput() {
  console.log('Test 28: parsePrice(null) → value=null, invalid=true');
  assertPrice(null, null, true, 'null');
}

function testParsePriceCurrencyCodeSuffix() {
  console.log('Test 29: parsePrice("15,00 EUR") → value=15, invalid=false (currency code instead of symbol)');
  assertPrice('15,00 EUR', 15, false, '"15,00 EUR"');
}

// ---- buildShopifyModel SKU-override tests (PR-CAT-RESTRUCTURE) ----
//
// These tests exercise the post-coerce override path added in import-map.mjs.
// Fixture: 4 SKUs covering Bucket A / B / C and a control (not in overrides).
// Minimal mapping with sku, tipo, familia, catalogo columns. Translations
// are provided for EN (one of the 5 secondary locales) to verify that the
// override propagates to translations too.

function makeTestFixture() {
  // Column indexes: 0=sku, 3=tipo, 5=familia, 6=catalogo.
  const mapping = {
    files: { surtido: { primary_locale: 'ES' } },
    columns: {
      "0": { column_name_es: 'Referencia', destination: 'variant.sku', translatable: false, type: 'string', key: true },
      "3": { column_name_es: 'Tipo', destination: 'metafield', namespace: 'product', key: 'tipo', translatable: true, filterable: true, type: 'single_line_text_field' },
      "5": { column_name_es: 'Familia', destination: 'metafield', namespace: 'product', key: 'familia', translatable: true, type: 'single_line_text_field' },
      "6": { column_name_es: 'Catálogo', destination: 'metafield', namespace: 'product', key: 'catalogo', translatable: true, type: 'single_line_text_field' },
    },
  };

  // raw[i] indexed by column position. Sparse arrays are fine — buildShopifyModel
  // only reads the column positions declared in mapping.columns.
  function row(sku, tipo, familia, catalogo) {
    const r = [];
    r[0] = sku;
    r[3] = tipo;
    r[5] = familia;
    r[6] = catalogo;
    return r;
  }

  // CSV says DIY for all DIY SKUs' catalogo (per audit). The override should
  // transform A/B/C; control stays as-is.
  // For Bucket B (Flexo), use distinct CSV translations of "Flexo" per locale
  // to verify the override REPLACES them with the canonical "Sobremesa"
  // translation in each locale.
  const recordsES = [
    { sku: 'DE-0055-NEG', raw: row('DE-0055-NEG', 'Sobremesa', 'Tress', 'DIY') },         // Bucket A
    { sku: 'DE-0148-BLA', raw: row('DE-0148-BLA', 'Flexo', 'Pomo', 'DIY') },               // Bucket B
    { sku: 'PX-0555-ANT', raw: row('PX-0555-ANT', 'Farola', 'PALE', 'DIY') },              // Bucket C
    { sku: 'ZZ-0000-CTL', raw: row('ZZ-0000-CTL', 'Colgante', 'Control', 'Decorative') },  // Control (not in overrides)
  ];

  // Non-ES locales: distinct translated 'tipo' values so we can verify the
  // override actually replaces them (Bucket B) or leaves them intact (others).
  // For tipo we simulate what the CSV would carry in each locale: "Flexo"
  // typically translates to "Desk lamp"/"Lampe articulée"/etc. — but the
  // override should set "Table lamp"/"Lampe de table"/etc.
  function makeLocaleRecords(tipoFlexo) {
    return [
      { sku: 'DE-0055-NEG', raw: row('DE-0055-NEG', 'Table lamp_NATIVE', 'Tress', 'DIY') }, // tipo translation natural; Bucket A doesn't override tipo so this stays
      { sku: 'DE-0148-BLA', raw: row('DE-0148-BLA', tipoFlexo, 'Pomo', 'DIY') },             // distinct per locale
      { sku: 'PX-0555-ANT', raw: row('PX-0555-ANT', 'Streetlight_NATIVE', 'PALE', 'DIY') },  // Bucket C doesn't override tipo
      { sku: 'ZZ-0000-CTL', raw: row('ZZ-0000-CTL', 'Pendant_NATIVE', 'Control', 'Decorative') },
    ];
  }

  const surtidoByLocale = new Map([
    ['ES', { records: recordsES }],
    ['EN', { records: makeLocaleRecords('Desk lamp_CSV') }],
    ['FR', { records: makeLocaleRecords('Lampe articulée_CSV') }],
    ['DE', { records: makeLocaleRecords('Schreibtischleuchte_CSV') }],
    ['IT', { records: makeLocaleRecords('Lampada da scrivania_CSV') }],
    ['PT', { records: makeLocaleRecords('Candeeiro de secretária_CSV') }],
  ]);
  const stock = { records: recordsES.map((r) => ({ sku: r.sku, inventario: 10 })) };
  const precios = { records: recordsES.map((r) => ({ sku: r.sku, tarifa: '15,00€' })) };

  return { surtidoByLocale, stock, precios, mapping };
}

function getMfValue(metafields, key) {
  const m = metafields.find((x) => x.key === key);
  return m ? m.value : null;
}

function getTrMfValue(translations, locale, key) {
  const t = translations?.[locale];
  if (!t) return null;
  const m = (t.metafields ?? []).find((x) => x.key === key);
  return m ? m.value : null;
}

function testOverrideBucketA() {
  console.log('Test 30 (override A): DE-0055-NEG → catalogo "DIY" overrideado a "Forlight", tipo intacto (traducción natural del CSV se preserva en EN)');
  const fx = makeTestFixture();
  const { products } = buildShopifyModel(fx);
  const m = products.get('DE-0055-NEG');
  assert(m != null, 'DE-0055-NEG present in model');
  assertEq(getMfValue(m.product.metafields, 'catalogo'), 'Forlight', 'primary catalogo overridden');
  assertEq(getMfValue(m.product.metafields, 'tipo'), 'Sobremesa', 'primary tipo intact (from CSV)');
  assertEq(getTrMfValue(m.translations, 'en', 'catalogo'), 'Forlight', 'EN translation catalogo overridden (flat string)');
  // Bucket A doesn't override tipo, so the EN translation comes from the CSV directly.
  assertEq(getTrMfValue(m.translations, 'en', 'tipo'), 'Table lamp_NATIVE', 'EN translation tipo intact from CSV');
}

function testOverrideBucketB_metafieldAndTitle() {
  console.log('Test 31 (override B): DE-0148-BLA → catalogo "DIY"→"Forlight" (flat), tipo "Flexo"→"Sobremesa" en ES y traducción canónica en EN, title sigue diciendo "Pomo Flexo"');
  const fx = makeTestFixture();
  const { products } = buildShopifyModel(fx);
  const m = products.get('DE-0148-BLA');
  assert(m != null, 'DE-0148-BLA present in model');
  assertEq(getMfValue(m.product.metafields, 'catalogo'), 'Forlight', 'primary catalogo overridden');
  assertEq(getMfValue(m.product.metafields, 'tipo'), 'Sobremesa', 'primary tipo overridden Flexo→Sobremesa');
  // Title must keep the commercial "Flexo" — buildTitle reads the raw tipoVal
  // from the CSV before the override is applied.
  assertEq(m.product.title, 'Pomo Flexo', 'product title keeps "Flexo" (commercial name)');
  assertEq(getTrMfValue(m.translations, 'en', 'catalogo'), 'Forlight', 'EN catalogo overridden (flat)');
  // KEY: tipo in EN must be the canonical "Table lamp" (per-locale override),
  // NOT the CSV's "Desk lamp_CSV" and NOT the ES literal "Sobremesa".
  assertEq(getTrMfValue(m.translations, 'en', 'tipo'), 'Table lamp', 'EN tipo = canonical translation, not CSV value, not ES literal');
}

function testOverrideBucketB_multilocale() {
  console.log('Test 31b (override B multi-locale): tipo en EN/FR/DE/IT/PT-PT es la traducción canónica del CSV (no la traducción natural de Flexo, no Sobremesa literal)');
  const fx = makeTestFixture();
  const { products } = buildShopifyModel(fx);
  const m = products.get('DE-0148-BLA');
  assert(m != null, 'DE-0148-BLA present');
  const expected = {
    'en': 'Table lamp',
    'fr': 'Lampe de table',
    'de': 'Tischleuchten',
    'it': 'Lampade da tavolo',
    'pt-PT': 'Candeeiro de mesa',
  };
  for (const [locale, val] of Object.entries(expected)) {
    assertEq(getTrMfValue(m.translations, locale, 'tipo'), val, `${locale} tipo = "${val}"`);
    // catalogo is flat ("Forlight"); must be identical in every locale.
    assertEq(getTrMfValue(m.translations, locale, 'catalogo'), 'Forlight', `${locale} catalogo = "Forlight" (flat)`);
  }
}

function testOverrideBucketC() {
  console.log('Test 32 (override C): PX-0555-ANT → catalogo "DIY"→"Outdoor", tipo "Farola" intacto en ES y EN');
  const fx = makeTestFixture();
  const { products } = buildShopifyModel(fx);
  const m = products.get('PX-0555-ANT');
  assert(m != null, 'PX-0555-ANT present in model');
  assertEq(getMfValue(m.product.metafields, 'catalogo'), 'Outdoor', 'primary catalogo overridden');
  assertEq(getMfValue(m.product.metafields, 'tipo'), 'Farola', 'primary tipo intact');
  assertEq(getTrMfValue(m.translations, 'en', 'catalogo'), 'Outdoor', 'EN catalogo overridden (flat)');
  assertEq(getTrMfValue(m.translations, 'en', 'tipo'), 'Streetlight_NATIVE', 'EN tipo intact from CSV (no tipo override in Bucket C)');
}

function testOverrideControl_skuNotInTable() {
  console.log('Test 33 (control): ZZ-0000-CTL no en overrides → catalogo y tipo del CSV sin tocar');
  const fx = makeTestFixture();
  const { products } = buildShopifyModel(fx);
  const m = products.get('ZZ-0000-CTL');
  assert(m != null, 'ZZ-0000-CTL present in model');
  assertEq(getMfValue(m.product.metafields, 'catalogo'), 'Decorative', 'catalogo preserved from CSV');
  assertEq(getMfValue(m.product.metafields, 'tipo'), 'Colgante', 'tipo preserved from CSV');
  assertEq(getTrMfValue(m.translations, 'en', 'catalogo'), 'Decorative', 'EN catalogo preserved');
  assertEq(getTrMfValue(m.translations, 'en', 'tipo'), 'Pendant_NATIVE', 'EN tipo preserved');
}

// ---- PR-IMG-3: derived schematic image slot ----
function testDerivedSchematicSlot() {
  console.log('Test 34 (PR-IMG-3): el slot de esquema se añade al FINAL del array de imágenes, con altText propio y sin extensión');
  const mapping = {
    files: { surtido: { primary_locale: 'ES' } },
    columns: {
      "0": { column_name_es: 'Referencia', destination: 'variant.sku', translatable: false, type: 'string', key: true },
      "58": { column_name_es: 'Imagen web', destination: 'product.images', image_position: 0, type: 'url' },
      "59": { column_name_es: 'Imagen ambiente 1', destination: 'product.images', image_position: 1, type: 'url' },
    },
    derived_images: {
      slots: [
        { id: 'esquema_tecnico', url_template: 'https://files.ledsc4.com/png/{SKU}', alt_template: 'Esquema técnico — {SKU}' },
      ],
    },
  };
  function row(sku, img0, img1) { const r = []; r[0] = sku; r[58] = img0; r[59] = img1; return r; }
  const records = [{ sku: 'DE-0148-BLA', raw: row('DE-0148-BLA', 'https://files.ledsc4.com/img/a.jpg', 'https://files.ledsc4.com/img/b.jpg') }];
  const fx = {
    surtidoByLocale: new Map([['ES', { records }]]),
    stock: { records: [{ sku: 'DE-0148-BLA', inventario: 10 }] },
    precios: { records: [{ sku: 'DE-0148-BLA', tarifa: '15,00€' }] },
    mapping,
  };
  const { products } = buildShopifyModel(fx);
  const imgs = products.get('DE-0148-BLA').product.images;
  assertEq(imgs.length, 3, 'two CSV photos + one schematic slot');
  const last = imgs[imgs.length - 1];
  assertEq(last.src, 'https://files.ledsc4.com/png/DE-0148-BLA', 'schematic src built from SKU, no extension');
  assertEq(last.alt, 'Esquema técnico — DE-0148-BLA', 'schematic altText is its own, not inherited');
  assertEq(last.derived, 'esquema_tecnico', 'schematic slot tagged as derived');
  assert(imgs[0].alt === undefined && imgs[1].alt === undefined, 'CSV photos keep no alt key (behaviour unchanged)');
  assert(!last.src.endsWith('.png') && !last.alt.includes('.png'), 'no file extension assumed anywhere in the slot');
}

function main() {
  testCleanIdempotent();
  testDoubleSpaceCollapsed();
  testEdgeWhitespace();
  testFallbackToSku();
  testRealGeaCase();
  testTabsAndNewlinesCollapsed();
  testCoerceRangeNumericNumeric();
  testCoerceRangeNumericNumericLargeAlto();
  testCoerceCommaDecimalRegression();
  testCoerceCommaTrailingZeroRegression();
  testCoerceIntegerClean();
  testCoerceIntegerTruncatesDecimal();
  testCoerceTextPrefixedRangeStillFails();
  testCoerceDiameterPrefixStillFails();
  testParsePriceUsDecimal();
  testParsePriceEsDecimal();
  testParsePriceEsDecimalWithEuro();
  testParsePriceUsDecimalWithEuro();
  testParsePriceEsThousandsAndDecimal();
  testParsePriceMultipleEsThousands();
  testParsePriceUsDecimalNoSymbol();
  testParsePriceEmpty();
  testParsePriceGarbage();
  testParsePriceZeroNotInvalid();
  testParsePriceZeroWithEuroNotInvalid();
  testParsePriceWhitespaceAndSpacedEuro();
  testParsePriceNbspBeforeEuro();
  testParsePriceNullInput();
  testParsePriceCurrencyCodeSuffix();
  testOverrideBucketA();
  testOverrideBucketB_metafieldAndTitle();
  testOverrideBucketB_multilocale();
  testOverrideBucketC();
  testOverrideControl_skuNotInTable();
  testDerivedSchematicSlot();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main();
