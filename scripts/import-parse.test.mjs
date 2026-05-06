#!/usr/bin/env node
// Unit tests for scripts/import-parse.mjs.
//
// No external test framework (project convention: zero dependencies).
// Each test writes a temporary CSV, runs the parser against it, asserts
// expected outputs. Exit code 0 = all pass; non-zero = at least one fail.
//
// Run:
//   node scripts/import-parse.test.mjs

import { writeFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStock } from './import-parse.mjs';

let tmp;
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

async function withCsv(content, fn) {
  const path = join(tmp, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
  await writeFile(path, content, 'utf8');
  try {
    return await fn(path);
  } finally {
    await unlink(path);
  }
}

async function testSingleSku() {
  console.log('Test 1: SKU único con stock 5 → resultado 5');
  await withCsv('SKU,INVENTARIO\nA-100,5\n', async (path) => {
    const r = await parseStock(path);
    assert(r.records.length === 1, `expected 1 record, got ${r.records.length}`);
    assert(r.records[0]?.sku === 'A-100', `expected sku A-100, got ${r.records[0]?.sku}`);
    assert(r.records[0]?.inventario === '5', `expected inventario "5", got ${JSON.stringify(r.records[0]?.inventario)}`);
    assert(r.warnings.length === 0, `expected 0 warnings, got ${r.warnings.length}`);
  });
}

async function testDupTwo() {
  console.log('Test 2: SKU duplicado con stock 53 y 1 → resultado 54 + warning');
  await withCsv('SKU,INVENTARIO\nB-200,53\nB-200,1\n', async (path) => {
    const r = await parseStock(path);
    assert(r.records.length === 1, `expected 1 dedup record, got ${r.records.length}`);
    assert(r.records[0]?.sku === 'B-200', `expected sku B-200, got ${r.records[0]?.sku}`);
    assert(r.records[0]?.inventario === '54', `expected summed "54", got ${JSON.stringify(r.records[0]?.inventario)}`);
    assert(r.warnings.length === 1, `expected 1 warning, got ${r.warnings.length}`);
    const w = r.warnings[0];
    assert(w?.kind === 'duplicate_sku', `expected kind 'duplicate_sku', got '${w?.kind}'`);
    assert(w?.sku === 'B-200', `expected warning sku B-200, got '${w?.sku}'`);
    assert(typeof w?.message === 'string' && w.message.includes('53+1=54'), `expected formula 53+1=54 in message, got: ${w?.message}`);
  });
}

async function testDupThree() {
  console.log('Test 3: SKU triplicado con stock 10, 5, 2 → resultado 17 + warning');
  await withCsv('SKU,INVENTARIO\nC-300,10\nC-300,5\nC-300,2\n', async (path) => {
    const r = await parseStock(path);
    assert(r.records.length === 1, `expected 1 dedup record, got ${r.records.length}`);
    assert(r.records[0]?.inventario === '17', `expected summed "17", got ${JSON.stringify(r.records[0]?.inventario)}`);
    assert(r.warnings.length === 1, `expected 1 warning, got ${r.warnings.length}`);
    const w = r.warnings[0];
    assert(w?.kind === 'duplicate_sku', `expected kind 'duplicate_sku', got '${w?.kind}'`);
    assert(w.message.includes('10+5+2=17'), `expected formula 10+5+2=17 in message, got: ${w.message}`);
    assert(w.message.includes('3 occurrences'), `expected '3 occurrences' in message, got: ${w.message}`);
  });
}

async function testDupNonNumeric() {
  console.log('Test 4: SKU duplicado con stock 10 y "abc" (no numérico) → first wins + high-severity warning');
  await withCsv('SKU,INVENTARIO\nD-400,10\nD-400,abc\n', async (path) => {
    const r = await parseStock(path);
    assert(r.records.length === 1, `expected 1 dedup record, got ${r.records.length}`);
    assert(r.records[0]?.inventario === '10', `expected first-wins "10", got ${JSON.stringify(r.records[0]?.inventario)}`);
    assert(r.warnings.length === 1, `expected 1 warning, got ${r.warnings.length}`);
    const w = r.warnings[0];
    assert(w?.kind === 'duplicate_sku_non_numeric', `expected kind 'duplicate_sku_non_numeric', got '${w?.kind}'`);
    assert(w?.severity === 'high', `expected severity 'high', got '${w?.severity}'`);
    assert(w.message.includes("'10'") && w.message.includes("'abc'"), `expected both values listed in message, got: ${w.message}`);
  });
}

// Bonus: real-world case from samples (stock has duplicate AH12-12V8W1OUWT 53,1)
async function testRealCase() {
  console.log('Test 5 (bonus): real samples/stock — AH12-12V8W1OUWT should be 54');
  const r = await parseStock('samples/stock/stock.csv');
  const target = r.records.find((x) => x.sku === 'AH12-12V8W1OUWT');
  assert(target != null, 'expected AH12-12V8W1OUWT in records');
  assert(target?.inventario === '54', `expected inventario "54" (53+1), got ${JSON.stringify(target?.inventario)}`);
  const w = r.warnings.find((x) => x.sku === 'AH12-12V8W1OUWT');
  assert(w != null, 'expected warning for AH12-12V8W1OUWT');
  assert(w?.kind === 'duplicate_sku', `expected kind 'duplicate_sku', got '${w?.kind}'`);
}

async function main() {
  tmp = await mkdtemp(join(tmpdir(), 'ledsc4-parse-test-'));
  try {
    await testSingleSku();
    await testDupTwo();
    await testDupThree();
    await testDupNonNumeric();
    await testRealCase();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
