#!/usr/bin/env node
// Unit tests for scripts/import-map.mjs.
// Zero dependencies. Run: node scripts/import-map.test.mjs

import { buildTitle, coerce } from './import-map.mjs';

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
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main();
