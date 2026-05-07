// Deterministic fingerprint for the import writer.
//
// Computes a SHA-256 hex of a stable serialization of the desired-state
// payload that was sent to Shopify for a given SKU. Stored in
// private.sku_state for Fase B (incremental imports — skip SKUs whose
// fingerprint matches the cached one).
//
// Stability requirements:
//   - JSON.stringify is NOT stable: object key order depends on insertion.
//     We use a deep key-sorting replacer.
//   - Arrays are NOT sorted automatically — the caller pre-sorts arrays
//     whose semantic identity is order-independent (tags, metafields,
//     files). Order-significant arrays (productOptions, variants) keep
//     insertion order.
//   - Numbers and booleans serialize trivially. Strings preserve UTF-8.
//
// Composition (see buildSkuFingerprint below):
//   {
//     sku,
//     product: <ProductSetInput sent>,
//     product_translations: { locale → { title, body_html } },
//     metafield_translations: { 'product.<key>' → { locale → value } },
//     publication_id: <gid>
//   }

import { createHash } from 'node:crypto';

// Stable JSON serializer: sorts object keys at every depth. Arrays kept in
// the order they're given.
export function stableStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  // undefined, function, symbol → omit (returning undefined here would
  // break the inner join; emit null instead to keep the structure stable).
  return 'null';
}

export function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

// Build the fingerprint object from the writer's per-SKU state. The
// caller must have already pre-sorted any order-independent arrays inside
// productSetInput (tags, metafields, files) using sortPayloadForFingerprint
// below.
//
// productTranslations: array of { locale, key, value } that was sent to
// translationsRegister at the product resource. We index by locale → key.
//
// metafieldTranslationBatches: array of { metafieldKey, translations:
// [{ locale, value }] } where metafieldKey is the namespaced key like
// 'product.tipo'. The fingerprint indexes by metafieldKey → locale →
// value, so it's stable across runs even if Shopify reissues the
// metafield GID.
export function buildSkuFingerprint({
  sku,
  productSetInput,
  productTranslations,
  metafieldTranslationBatches,
  publicationId,
}) {
  const productTransByLocale = {};
  for (const t of productTranslations ?? []) {
    if (!productTransByLocale[t.locale]) productTransByLocale[t.locale] = {};
    productTransByLocale[t.locale][t.key] = t.value;
  }

  const mfTransByKey = {};
  for (const batch of metafieldTranslationBatches ?? []) {
    const k = batch.metafieldKey;
    if (!mfTransByKey[k]) mfTransByKey[k] = {};
    for (const t of batch.translations ?? []) {
      mfTransByKey[k][t.locale] = t.value;
    }
  }

  const payload = {
    sku,
    product: productSetInput,
    product_translations: productTransByLocale,
    metafield_translations: mfTransByKey,
    publication_id: publicationId,
  };
  return sha256Hex(stableStringify(payload));
}

// Build the fingerprint for a stock_only run. Distinct from full-run
// fingerprint — covers ONLY (sku, locationId, quantity) tuple. Used by
// runStockOnly to decide if a SKU's stock has changed vs the last
// stock_last_seen_at recorded in private.sku_state.fingerprint_stock.
//
// Stable: same inputs → same hex.
export function buildStockFingerprint({ sku, locationId, quantity }) {
  return sha256Hex(stableStringify({ sku, locationId, quantity }));
}

// Sort the order-independent arrays inside a ProductSetInput so the
// fingerprint is stable regardless of input shuffling. Mutates the input.
//   - tags: sorted lexicographically.
//   - metafields: sorted by `${namespace}.${key}`.
//   - files: sorted by filename.
// Order-significant arrays (productOptions, variants) are NOT touched.
export function sortPayloadForFingerprint(productSetInput) {
  if (Array.isArray(productSetInput.tags)) {
    productSetInput.tags = [...productSetInput.tags].sort();
  }
  if (Array.isArray(productSetInput.metafields)) {
    productSetInput.metafields = [...productSetInput.metafields].sort((a, b) => {
      const ka = `${a.namespace}.${a.key}`;
      const kb = `${b.namespace}.${b.key}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }
  if (Array.isArray(productSetInput.files)) {
    productSetInput.files = [...productSetInput.files].sort((a, b) => {
      const na = a.filename ?? '';
      const nb = b.filename ?? '';
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
  }
  return productSetInput;
}
