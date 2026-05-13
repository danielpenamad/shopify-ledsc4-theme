// Post-coerce override de metafields por SKU. PR-CAT-RESTRUCTURE (2026-05).
//
// Carga scripts/sku-overrides.json al primer uso (lazy), explota la
// estructura agrupada por reglas en un Map<sku, Record<key, value>> para
// O(1) lookup, y expone getOverride(sku, key) → value | null.
//
// Aplicado en import-map.mjs tras coerce() del valor primario (ES) y al
// leer cada locale secundario, ANTES del push al array de metafields /
// trMetafields. Mantiene primary↔traducciones alineados (requerido por
// PR-PIPELINE-A: el writer reescribe traducciones aunque coincidan con ES).
//
// Reversible: vaciar rules:[] o borrar el JSON → getOverride() siempre
// devuelve null → comportamiento idéntico al pre-PR. Tras el siguiente
// cron full 02:00 UTC, los productos vuelven al valor SFTP-canónico.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = resolve(__dirname, '..', 'sku-overrides.json');

let _index = null;

function loadIndex() {
  if (_index) return _index;
  let raw;
  try {
    raw = readFileSync(DATA_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      _index = new Map();
      return _index;
    }
    throw err;
  }
  const parsed = JSON.parse(raw);
  const map = new Map();
  for (const rule of parsed.rules ?? []) {
    for (const sku of rule.skus ?? []) {
      const existing = map.get(sku) ?? {};
      // Later rules win on same key (deterministic by file order).
      Object.assign(existing, rule.overrides ?? {});
      map.set(sku, existing);
    }
  }
  _index = map;
  return _index;
}

// Returns the override value for (sku, key, locale) or null if none.
//
// The override value in the JSON can be:
//   - a string → applies in all 6 locales (used when the value should not be
//     translated, e.g. catalogo='Forlight').
//   - an object { es, en, fr, de, it, 'pt-PT' } → per-locale override (used
//     when the value should be translated, e.g. tipo='Sobremesa'/'Table lamp').
//
// `locale` defaults to 'es' (the shop's primary locale). For per-locale
// objects, returns null if the requested locale is not present, so the
// caller leaves the CSV's original translation untouched.
//
// All three args are case-sensitive: SKUs come uppercase, metafield keys are
// lowercase, locales follow Shopify's BCP-47 codes ('en', 'fr', 'de', 'it',
// 'pt-PT'). The JSON must match these exactly.
export function getOverride(sku, key, locale = 'es') {
  const m = loadIndex();
  const entry = m.get(sku);
  if (!entry) return null;
  const v = entry[key];
  if (v == null) return null;
  if (typeof v === 'string') return v;
  // Object form: per-locale override.
  return v[locale] ?? null;
}

// For tests: reset the cached index so a freshly written JSON is picked up.
export function _resetCacheForTests() {
  _index = null;
}

// For tests / diagnostics: return the full SKU→overrides map (read-only view).
export function _getIndexForTests() {
  return loadIndex();
}
