#!/usr/bin/env node
// Unit tests for scripts/lib/sku-overrides.mjs and the integrity of
// scripts/sku-overrides.json.
// Zero dependencies. Run: node scripts/lib/sku-overrides.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getOverride, _getIndexForTests } from './sku-overrides.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = resolve(__dirname, '..', 'sku-overrides.json');

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

// ---- Bucket A (catalogo: DIY → Forlight, tipo intacto) ----

function testBucketA_catalogoOverridden() {
  console.log('Test A1: Bucket A SKU → catalogo override returns "Forlight"');
  assertEq(getOverride('DE-0055-NEG', 'catalogo'), 'Forlight', 'DE-0055-NEG catalogo');
  assertEq(getOverride('DE-0196-CRO', 'catalogo'), 'Forlight', 'DE-0196-CRO catalogo (last in bucket A)');
  assertEq(getOverride('VE-0029-MAD', 'catalogo'), 'Forlight', 'VE-0029-MAD catalogo (ventilador)');
}

function testBucketA_tipoUntouched() {
  console.log('Test A2: Bucket A SKU → tipo override returns null (not overridden)');
  assertEq(getOverride('DE-0055-NEG', 'tipo'), null, 'DE-0055-NEG tipo should be null (not in overrides)');
  assertEq(getOverride('PX-0506-ANT', 'tipo'), null, 'PX-0506-ANT tipo should be null');
}

// ---- Bucket B (catalogo: → Forlight, tipo: Flexo → Sobremesa por locale) ----

function testBucketB_catalogoFlat() {
  console.log('Test B1: Bucket B SKU → catalogo="Forlight" (string flat, mismo valor en los 6 locales)');
  for (const sku of ['DE-0148-BLA', 'DE-0148-NEG', 'DE-0147-BLA', 'DE-0147-NEG']) {
    assertEq(getOverride(sku, 'catalogo'), 'Forlight', `${sku} catalogo default (es)`);
    assertEq(getOverride(sku, 'catalogo', 'es'), 'Forlight', `${sku} catalogo es`);
    assertEq(getOverride(sku, 'catalogo', 'en'), 'Forlight', `${sku} catalogo en (flat string aplica igual)`);
    assertEq(getOverride(sku, 'catalogo', 'fr'), 'Forlight', `${sku} catalogo fr`);
    assertEq(getOverride(sku, 'catalogo', 'pt-PT'), 'Forlight', `${sku} catalogo pt-PT`);
  }
}

function testBucketB_tipoByLocale() {
  console.log('Test B2: Bucket B SKU → tipo override per-locale, traducciones canónicas del CSV');
  const expected = {
    'es': 'Sobremesa',
    'en': 'Table lamp',
    'fr': 'Lampe de table',
    'de': 'Tischleuchten',
    'it': 'Lampade da tavolo',
    'pt-PT': 'Candeeiro de mesa',
  };
  for (const sku of ['DE-0148-BLA', 'DE-0148-NEG', 'DE-0147-BLA', 'DE-0147-NEG']) {
    for (const [locale, val] of Object.entries(expected)) {
      assertEq(getOverride(sku, 'tipo', locale), val, `${sku} tipo ${locale}`);
    }
    // Default locale should equal 'es'.
    assertEq(getOverride(sku, 'tipo'), expected.es, `${sku} tipo default = es`);
  }
}

function testBucketB_tipoUnknownLocale() {
  console.log('Test B3: Bucket B tipo con locale desconocido → null (no aplica override, caller deja CSV intacto)');
  assertEq(getOverride('DE-0148-BLA', 'tipo', 'ja'), null, 'unknown locale falls back to null');
  assertEq(getOverride('DE-0148-BLA', 'tipo', 'pt-BR'), null, 'pt-BR (vs pt-PT) returns null');
}

function testBucketA_flatStringIgnoresLocale() {
  console.log('Test A3 (Opción 2): Bucket A catalogo es string flat → mismo valor para cualquier locale');
  for (const locale of ['es', 'en', 'fr', 'de', 'it', 'pt-PT', 'ja']) {
    assertEq(getOverride('DE-0055-NEG', 'catalogo', locale), 'Forlight', `flat string ignores locale=${locale}`);
  }
}

// ---- Bucket C (catalogo: DIY → Outdoor, tipo intacto) ----

function testBucketC_catalogoOnly() {
  console.log('Test C1: Bucket C SKU PX-0555-ANT → catalogo="Outdoor", tipo=null');
  assertEq(getOverride('PX-0555-ANT', 'catalogo'), 'Outdoor', 'PX-0555-ANT catalogo');
  assertEq(getOverride('PX-0555-ANT', 'tipo'), null, 'PX-0555-ANT tipo should be null (intact)');
}

// ---- Control: SKUs NOT in the table ----

function testControl_unknownSku() {
  console.log('Test Z1: SKU not in any rule → returns null for any key');
  assertEq(getOverride('FOO-BAR-BAZ', 'catalogo'), null, 'unknown SKU catalogo');
  assertEq(getOverride('FOO-BAR-BAZ', 'tipo'), null, 'unknown SKU tipo');
  assertEq(getOverride('FOO-BAR-BAZ', 'familia'), null, 'unknown SKU familia');
}

function testControl_caseSensitive() {
  console.log('Test Z2: lookup is case-sensitive (SKUs in CSV come uppercase)');
  assertEq(getOverride('de-0055-neg', 'catalogo'), null, 'lowercase SKU should miss');
  assertEq(getOverride('DE-0055-NEG', 'Catalogo'), null, 'capitalised key should miss');
}

function testControl_unknownKey() {
  console.log('Test Z3: known SKU but key not in overrides → null');
  assertEq(getOverride('DE-0055-NEG', 'familia'), null, 'familia not in Bucket A overrides');
  assertEq(getOverride('DE-0148-BLA', 'acabado'), null, 'acabado not in Bucket B overrides');
}

// ---- JSON integrity: count and uniqueness ----

function testJsonIntegrity() {
  console.log('Test J1: JSON contains expected 50 + 4 + 1 = 55 unique SKUs across 3 rules');
  const raw = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  assertEq(raw.rules.length, 3, 'exactly 3 rules');

  const rulesById = Object.fromEntries(raw.rules.map((r) => [r.id, r]));
  assertEq(
    rulesById['cat-restructure-2026-05-A-diy-to-forlight'].skus.length,
    50,
    'Bucket A has 50 SKUs'
  );
  assertEq(
    rulesById['cat-restructure-2026-05-B-flexo-to-forlight-sobremesa'].skus.length,
    4,
    'Bucket B has 4 SKUs'
  );
  assertEq(
    rulesById['cat-restructure-2026-05-C-farola-diy-to-outdoor'].skus.length,
    1,
    'Bucket C has 1 SKU'
  );

  // No SKU repeats across buckets.
  const all = raw.rules.flatMap((r) => r.skus);
  const set = new Set(all);
  assertEq(set.size, all.length, `no duplicate SKUs across buckets (got ${all.length} entries, ${set.size} unique)`);
  assertEq(set.size, 55, 'total 55 unique SKUs');

  // Index size matches.
  const idx = _getIndexForTests();
  assertEq(idx.size, 55, 'loaded index has 55 entries');
}

function testJsonIntegrity_overrideShape() {
  console.log('Test J2: each rule has overrides with allowed keys (catalogo, tipo)');
  const raw = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  const allowedKeys = new Set(['catalogo', 'tipo']);
  for (const r of raw.rules) {
    const keys = Object.keys(r.overrides ?? {});
    assert(keys.length > 0, `rule ${r.id} has at least one override key`);
    for (const k of keys) {
      assert(allowedKeys.has(k), `rule ${r.id} override key "${k}" is one of {catalogo, tipo}`);
    }
  }
}

function testJsonIntegrity_perLocaleShape() {
  console.log('Test J3: per-locale objects have exactly the 6 required locale keys');
  const raw = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  const requiredLocales = ['es', 'en', 'fr', 'de', 'it', 'pt-PT'].sort();
  for (const r of raw.rules) {
    for (const [k, v] of Object.entries(r.overrides ?? {})) {
      if (typeof v === 'object' && v !== null) {
        const locales = Object.keys(v).sort();
        assertEq(JSON.stringify(locales), JSON.stringify(requiredLocales), `rule ${r.id}.${k} per-locale object has exactly {es,en,fr,de,it,pt-PT}`);
        for (const [locKey, locVal] of Object.entries(v)) {
          assert(typeof locVal === 'string' && locVal.length > 0, `rule ${r.id}.${k}.${locKey} value is a non-empty string`);
        }
      } else {
        assert(typeof v === 'string' && v.length > 0, `rule ${r.id}.${k} flat value is a non-empty string`);
      }
    }
  }
}

function main() {
  testBucketA_catalogoOverridden();
  testBucketA_tipoUntouched();
  testBucketA_flatStringIgnoresLocale();
  testBucketB_catalogoFlat();
  testBucketB_tipoByLocale();
  testBucketB_tipoUnknownLocale();
  testBucketC_catalogoOnly();
  testControl_unknownSku();
  testControl_caseSensitive();
  testControl_unknownKey();
  testJsonIntegrity();
  testJsonIntegrity_overrideShape();
  testJsonIntegrity_perLocaleShape();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main();
