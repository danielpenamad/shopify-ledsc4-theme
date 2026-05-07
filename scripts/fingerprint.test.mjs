#!/usr/bin/env node
// Unit tests for scripts/fingerprint.mjs.
// Zero dependencies. Run: node scripts/fingerprint.test.mjs

import { stableStringify, sha256Hex, buildSkuFingerprint, sortPayloadForFingerprint } from './fingerprint.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) { passed++; }
  else { failed++; failures.push(message); console.error(`  ✗ ${message}`); }
}

function eq(actual, expected, label) {
  assert(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function testStableStringifyKeySort() {
  console.log('Test 1: stableStringify sorts object keys recursively');
  const a = { c: 1, a: { z: 2, y: 3 }, b: 4 };
  const b = { a: { y: 3, z: 2 }, b: 4, c: 1 };
  eq(stableStringify(a), stableStringify(b), 'differently-ordered objects → identical string');
  eq(stableStringify(a), '{"a":{"y":3,"z":2},"b":4,"c":1}', 'expected sorted form');
}

function testStableStringifyArraysOrderPreserved() {
  console.log('Test 2: stableStringify preserves array order (caller pre-sorts)');
  eq(stableStringify([3, 1, 2]), '[3,1,2]', 'array order preserved');
}

function testStableStringifyPrimitives() {
  console.log('Test 3: stableStringify handles primitives');
  eq(stableStringify(null), 'null', 'null');
  eq(stableStringify(true), 'true', 'true');
  eq(stableStringify(false), 'false', 'false');
  eq(stableStringify(42), '42', 'integer');
  eq(stableStringify(1.5), '1.5', 'float');
  eq(stableStringify('hi"bye'), '"hi\\"bye"', 'string with quote');
  eq(stableStringify(NaN), 'null', 'NaN → null');
  eq(stableStringify(Infinity), 'null', 'Infinity → null');
}

function testSha256DeterministicLength() {
  console.log('Test 4: sha256Hex returns 64-char hex');
  const h = sha256Hex('hello');
  assert(/^[0-9a-f]{64}$/.test(h), `expected 64 hex chars, got '${h}'`);
}

function testFingerprintDeterminism() {
  console.log('Test 5: identical inputs → identical fingerprints');
  const input = {
    sku: 'TEST-001',
    productSetInput: { handle: 'test-001', title: 'X', tags: ['a', 'b'] },
    productTranslations: [
      { locale: 'en', key: 'title', value: 'X-en', translatableContentDigest: 'd-en-title' },
      { locale: 'fr', key: 'title', value: 'X-fr', translatableContentDigest: 'd-fr-title' },
    ],
    metafieldTranslationBatches: [
      { resourceId: 'gid://shopify/Metafield/1', metafieldKey: 'product.tipo', translations: [{ locale: 'en', key: 'value', value: 'Bath', translatableContentDigest: 'd-tipo' }] },
    ],
    publicationId: 'gid://shopify/Publication/X',
  };
  const a = buildSkuFingerprint(input);
  const b = buildSkuFingerprint(input);
  eq(a, b, 'twice-computed fingerprints');
  assert(/^[0-9a-f]{64}$/.test(a), `expected sha256 hex, got '${a}'`);
}

function testFingerprintInputOrderInsensitive() {
  console.log('Test 6: object key order in productSetInput does not change fingerprint');
  const a = buildSkuFingerprint({
    sku: 'X', productSetInput: { title: 'A', vendor: 'V', handle: 'x' },
    productTranslations: [], metafieldTranslationBatches: [], publicationId: 'P',
  });
  const b = buildSkuFingerprint({
    sku: 'X', productSetInput: { handle: 'x', vendor: 'V', title: 'A' },
    productTranslations: [], metafieldTranslationBatches: [], publicationId: 'P',
  });
  eq(a, b, 'reordered keys');
}

function testFingerprintMetafieldTransIndependentOfGid() {
  console.log('Test 7: metafield batches keyed by metafieldKey, NOT by Shopify GID (which can change)');
  const a = buildSkuFingerprint({
    sku: 'X', productSetInput: {},
    productTranslations: [],
    metafieldTranslationBatches: [
      { resourceId: 'gid://shopify/Metafield/AAAA', metafieldKey: 'product.tipo',
        translations: [{ locale: 'en', key: 'value', value: 'Bath', translatableContentDigest: 'd' }] },
    ],
    publicationId: 'P',
  });
  const b = buildSkuFingerprint({
    sku: 'X', productSetInput: {},
    productTranslations: [],
    metafieldTranslationBatches: [
      { resourceId: 'gid://shopify/Metafield/BBBB-different-gid', metafieldKey: 'product.tipo',
        translations: [{ locale: 'en', key: 'value', value: 'Bath', translatableContentDigest: 'd' }] },
    ],
    publicationId: 'P',
  });
  eq(a, b, 'different GIDs, same metafieldKey/value → same fingerprint');
}

function testFingerprintChangesOnValueChange() {
  console.log('Test 8: changing any value (title, translation, metafield, publication) changes fingerprint');
  const base = {
    sku: 'X', productSetInput: { title: 'Original' },
    productTranslations: [{ locale: 'en', key: 'title', value: 'Original-en', translatableContentDigest: 'd' }],
    metafieldTranslationBatches: [{ resourceId: 'gid://X', metafieldKey: 'product.tipo',
      translations: [{ locale: 'en', key: 'value', value: 'Bath', translatableContentDigest: 'd2' }] }],
    publicationId: 'P1',
  };
  const baseFp = buildSkuFingerprint(base);

  const titleChanged = buildSkuFingerprint({ ...base, productSetInput: { title: 'Changed' } });
  assert(titleChanged !== baseFp, 'title change → different fingerprint');

  const transChanged = buildSkuFingerprint({ ...base, productTranslations: [{ locale: 'en', key: 'title', value: 'Different-en', translatableContentDigest: 'd' }] });
  assert(transChanged !== baseFp, 'translation change → different fingerprint');

  const mfChanged = buildSkuFingerprint({
    ...base,
    metafieldTranslationBatches: [{ resourceId: 'gid://X', metafieldKey: 'product.tipo',
      translations: [{ locale: 'en', key: 'value', value: 'Toilet', translatableContentDigest: 'd2' }] }],
  });
  assert(mfChanged !== baseFp, 'metafield translation change → different fingerprint');

  const pubChanged = buildSkuFingerprint({ ...base, publicationId: 'P2' });
  assert(pubChanged !== baseFp, 'publicationId change → different fingerprint');
}

function testSortPayloadForFingerprint() {
  console.log('Test 9: sortPayloadForFingerprint sorts tags, metafields, files');
  const input = {
    handle: 'x',
    tags: ['z', 'a', 'm'],
    metafields: [
      { namespace: 'product', key: 'familia', value: 'A' },
      { namespace: 'product', key: 'tipo', value: 'B' },
      { namespace: 'product', key: 'acabado', value: 'C' },
    ],
    files: [
      { filename: 'z.jpg' },
      { filename: 'a.jpg' },
      { filename: 'm.jpg' },
    ],
    productOptions: [{ name: 'Title' }],
    variants: [{ sku: 'X' }],
  };
  const sorted = sortPayloadForFingerprint(input);
  eq(sorted.tags.join(','), 'a,m,z', 'tags sorted lex');
  eq(sorted.metafields.map((m) => m.key).join(','), 'acabado,familia,tipo', 'metafields sorted by ns.key');
  eq(sorted.files.map((f) => f.filename).join(','), 'a.jpg,m.jpg,z.jpg', 'files sorted by filename');
  // productOptions and variants must NOT be touched (semantic order matters).
  eq(sorted.productOptions[0].name, 'Title', 'productOptions untouched');
  eq(sorted.variants[0].sku, 'X', 'variants untouched');
}

function testSortPayloadIsStableInputShuffleSafe() {
  console.log('Test 10: sortPayload + buildSkuFingerprint = stable across input shuffles');
  const a = sortPayloadForFingerprint({
    handle: 'x', tags: ['b', 'a'], metafields: [], files: [],
  });
  const b = sortPayloadForFingerprint({
    handle: 'x', tags: ['a', 'b'], metafields: [], files: [],
  });
  const fpA = buildSkuFingerprint({ sku: 'X', productSetInput: a, productTranslations: [], metafieldTranslationBatches: [], publicationId: 'P' });
  const fpB = buildSkuFingerprint({ sku: 'X', productSetInput: b, productTranslations: [], metafieldTranslationBatches: [], publicationId: 'P' });
  eq(fpA, fpB, 'shuffled tags → same fingerprint after sort');
}

async function main() {
  testStableStringifyKeySort();
  testStableStringifyArraysOrderPreserved();
  testStableStringifyPrimitives();
  testSha256DeterministicLength();
  testFingerprintDeterminism();
  testFingerprintInputOrderInsensitive();
  testFingerprintMetafieldTransIndependentOfGid();
  testFingerprintChangesOnValueChange();
  testSortPayloadForFingerprint();
  testSortPayloadIsStableInputShuffleSafe();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main();
