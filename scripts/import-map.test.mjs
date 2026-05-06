#!/usr/bin/env node
// Unit tests for scripts/import-map.mjs.
// Zero dependencies. Run: node scripts/import-map.test.mjs

import { buildTitle } from './import-map.mjs';

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

function main() {
  testCleanIdempotent();
  testDoubleSpaceCollapsed();
  testEdgeWhitespace();
  testFallbackToSku();
  testRealGeaCase();
  testTabsAndNewlinesCollapsed();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main();
