// Mapper: parsed records → Shopify product model (Fase I2).
//
// Responsibility: take the syntactic output of import-parse.mjs and build
// the Shopify product model per SKU, applying business rules from
// scripts/mapping.json. Knows about types, publication policy, title
// construction, translations, image positions, orphan tracking.
//
// Does NOT call Shopify Admin API. Does NOT write files. Pure function.
//
// Single export: buildShopifyModel({ surtidoByLocale, stock, precios, mapping })
//   → { products: Map<sku, ProductModel>, orphans, warnings }

import { getOverride } from './lib/sku-overrides.mjs';

const VENDOR = 'LedsC4';
const PRIMARY_LOCALE = 'ES';
const SECONDARY_LOCALES = ['EN', 'IT', 'DE', 'FR', 'PT'];

// Map the file suffix used by the parser (derived from the CSV filename:
// listado_productos_<SUFFIX>.csv) to the Shopify locale code expected by
// translationsRegister and Shopify's storefront API. Most are 1:1 lowercase,
// but Shopify uses regional codes for Portuguese (pt-PT for Portugal Portuguese,
// pt-BR for Brazilian) — confirmed with client 2026-05-06.
//
// ES is the primary locale of the shop and is NOT registered as a translation;
// it lives in product.title / product.body_html directly.
const FILE_SUFFIX_TO_SHOPIFY_LOCALE = {
  ES: 'es',
  EN: 'en',
  IT: 'it',
  DE: 'de',
  FR: 'fr',
  PT: 'pt-PT',
};

// Coerce raw string from parser to the type declared in the mapping.
// Returns { value, warning? }.
//   - value: coerced value (or null if uncoercible / empty).
//   - warning: optional warning record to surface to the operator.
// Exported for unit tests. Used internally by buildShopifyModel for each
// metafield. Returns { value, warning? }.
export function coerce(rawString, type, sku, columnIndex, locale) {
  if (rawString == null) return { value: null };

  switch (type) {
    case 'string':
    case 'single_line_text_field':
    case 'multi_line_text_field':
    case 'url':
      return { value: String(rawString) };

    case 'number_decimal':
    case 'number_integer': {
      // Accept both ES (coma) and EN (punto) decimal separators. Strip thousand
      // separators if obvious (e.g. "1.260,00" → "1260.00"). Conservative: only
      // strip "." as thousand-sep if there's also a "," present.
      let s = String(rawString).trim();
      if (s.includes(',')) {
        s = s.replace(/\./g, '').replace(',', '.');
      }
      // Use Number() instead of parseFloat/parseInt: parseFloat("36-61") returns
      // 36 (silent prefix-truncation), but Number("36-61") returns NaN. This
      // makes "X-Y" ranges fall into the same numeric_unparsable path as
      // "Min X Max Y" — see I2.5 rule (docs/import-pipeline.md §11.3) and the
      // diagnostic on SKUs 05-4787-BW-BW, 00-5694-05-05, 00-7382-05-05.
      let n = Number(s);
      if (type === 'number_integer' && !Number.isNaN(n)) n = Math.trunc(n);
      if (Number.isNaN(n)) {
        return {
          value: null,
          warning: {
            kind: 'numeric_unparsable',
            message: `value "${rawString}" cannot be parsed as ${type}`,
            sku,
            locale,
            column: columnIndex,
          },
        };
      }
      return { value: n };
    }

    case 'boolean': {
      const s = String(rawString).trim();
      if (['Si', 'si', 'SI', 'Sí', 'sí', 'SÍ', 'Yes', 'yes', 'YES', 'true', 'TRUE', 'True'].includes(s)) {
        return { value: true };
      }
      if (['No', 'no', 'NO', 'false', 'FALSE', 'False'].includes(s)) {
        return { value: false };
      }
      return {
        value: null,
        warning: {
          kind: 'boolean_unparsable',
          message: `value "${rawString}" not in known boolean tokens`,
          sku,
          locale,
          column: columnIndex,
        },
      };
    }

    default:
      return { value: String(rawString) };
  }
}

// Parse a precio value from the SFTP export.
//
// The ERP exports ES decimal + currency suffix: "15,00€", "1.234,56€", "0,00€".
// Samples (dev fixtures) use plain US decimal: "28.87". Both must work.
//
// Approach:
//   1. Strip everything that isn't a digit, sign, comma, or period (so €, EUR,
//      $, NBSP, regular spaces all disappear).
//   2. Detect separator format:
//      - If both "," and "." are present, ES thousands+decimal: drop "." and
//        convert "," to "." (e.g. "1.234,56" → "1234.56").
//      - If only "," is present, ES decimal: convert to "." ("15,00" → "15.00").
//      - If only "." or no separator, leave as is.
//   3. Coerce with Number(); NaN means unparseable.
//
// Returns { value, invalid }:
//   - { value: <number>, invalid: false } when parseable (including 0).
//   - { value: null, invalid: true } when input is empty after stripping or NaN.
//
// Why Number() and not parseFloat: parseFloat is permissive in a way that hides
// bugs ("36-61" → 36 silently). Number() is strict, but only meaningful AFTER
// we normalize separators and strip currency symbols — otherwise it rejects
// the whole ERP export ("15,00€" → NaN). This was the root cause of run
// 3fbcc5c2 marking 733 SKUs as price_zero when in fact every SKU's price was
// simply unparseable. See docs/import-pipeline.md §11.5 (to be added).
//
// Exported for unit testing.
export function parsePrice(rawString) {
  if (rawString == null) return { value: null, invalid: true };
  let s = String(rawString).trim();
  if (s === '') return { value: null, invalid: true };
  s = s.replace(/[^\d,.\-]/g, '');
  if (s === '') return { value: null, invalid: true };
  const hasComma = s.includes(',');
  const hasPeriod = s.includes('.');
  if (hasComma && hasPeriod) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  if (Number.isNaN(n)) return { value: null, invalid: true };
  return { value: n, invalid: false };
}

// Detect HTML in a free-text field. Surfaced as an observation, not a problem.
function looksLikeHtml(s) {
  if (s == null) return false;
  // Tag-like sequences or HTML entities. Conservative match.
  return /<[a-z!\/][^>]*>/i.test(s) || /&[a-z]+;|&#\d+;/i.test(s);
}

// Build the title per §5 of the import-pipeline doc:
//   "{Familia} {Tipo} {Acabado_corto}"
// Where Acabado_corto is the first token of Acabado (split on comma or whitespace).
// If all empty, fallback to the SKU and emit a warning.
//
// Whitespace normalization: the COMPOSED title collapses any run of
// whitespace to a single space (and trims edges). Inputs and individual
// metafields stay literal — only the composed title is normalized. This
// covers cases where the client export contains internal double-spaces
// in `familia` (e.g. "Gea Power LED Round  ø180mm"), which Shopify would
// otherwise show as ugly double-spaced product titles. See
// docs/import-pipeline.md §11.4.
//
// Exported for unit testing.
export function buildTitle(familia, tipo, acabado, sku) {
  const parts = [];
  if (familia) parts.push(String(familia).trim());
  if (tipo) parts.push(String(tipo).trim());
  if (acabado) {
    const corto = String(acabado).split(/[,\s]+/)[0].trim();
    if (corto) parts.push(corto);
  }
  const t = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (!t) {
    return { title: sku, warning: { kind: 'title_fallback_to_sku', sku, message: 'Familia/Tipo/Acabado all empty; title set to SKU' } };
  }
  return { title: t };
}

// Build the URL value validation. Returns warning if not http/https.
function isPlausibleUrl(s) {
  if (s == null) return true; // null is fine, just means absent
  return /^https?:\/\//i.test(String(s).trim());
}

export function buildShopifyModel({ surtidoByLocale, stock, precios, mapping }) {
  const warnings = [];
  const products = new Map();

  // 1) Build O(1) lookup maps for stock and precios.
  // Use Number() instead of parseInt/parseFloat to avoid silent prefix-truncation
  // of malformed values like "10-12" → 10. Math.trunc() preserves integer
  // semantics for stock (parseInt's original behaviour: drop fractional part).
  const stockMap = new Map();
  for (const r of stock.records) {
    if (r.inventario == null) continue;
    const raw = String(r.inventario).trim();
    const parsed = Number(raw);
    const n = Number.isNaN(parsed) ? null : Math.trunc(parsed);
    stockMap.set(r.sku, n);
  }

  // Map<sku, { value: number|null, invalid: boolean }>
  // - missing key: SKU not in precios file at all → publish_reason='missing_price'
  // - { invalid: true }:  parse failed (NaN, currency garbage, etc.) → publish_reason='price_invalid'
  // - { value: 0 }:       parsed as zero → publish_reason='price_zero'
  // The three buckets are kept distinct so the operator can tell the difference
  // between "ERP didn't send a price" and "ERP sent a price we can't parse".
  const preciosMap = new Map();
  const invalidPrices = [];
  for (const r of precios.records) {
    if (r.tarifa == null) continue;
    const parsed = parsePrice(r.tarifa);
    preciosMap.set(r.sku, parsed);
    if (parsed.invalid) invalidPrices.push({ sku: r.sku, raw: r.tarifa });
  }
  if (invalidPrices.length > 0) {
    const examples = invalidPrices.slice(0, 5)
      .map((p) => `${p.sku}=${JSON.stringify(p.raw)}`)
      .join(', ');
    const more = invalidPrices.length > 5 ? ` (+${invalidPrices.length - 5} more)` : '';
    console.error(`WARNING: ${invalidPrices.length} price entries unparseable, examples: ${examples}${more}`);
  }

  // 2) Index columns by destination for quick mapper lookups.
  const cols = mapping.columns;
  // PR-IMG-3: slots de imagen sintéticos (URL construida desde SKU,
  // no respaldados por columna del CSV). Ver mapping.derived_images.
  const derivedImageSlots = mapping.derived_images?.slots ?? [];
  // Map<colIndex, columnSpec> for entries with destination=metafield
  const metafieldCols = [];
  // Map<colIndex, columnSpec> for entries with destination=product.images
  const imageCols = [];
  // Single col indexes for special destinations
  let skuColIdx = null;
  let barcodeColIdx = null;
  let bodyHtmlColIdx = null;

  for (const [colKey, spec] of Object.entries(cols)) {
    if (colKey === '$comment') continue;
    const idx = parseInt(colKey, 10);
    if (Number.isNaN(idx)) continue;
    if (spec.destination === 'metafield') {
      metafieldCols.push({ idx, ...spec });
    } else if (spec.destination === 'product.images') {
      imageCols.push({ idx, ...spec });
    } else if (spec.destination === 'variant.sku') {
      skuColIdx = idx;
    } else if (spec.destination === 'variant.barcode') {
      barcodeColIdx = idx;
    } else if (spec.destination === 'product.body_html') {
      bodyHtmlColIdx = idx;
    }
  }
  imageCols.sort((a, b) => (a.image_position ?? 0) - (b.image_position ?? 0));

  // Find specific column indexes used for title construction.
  const familiaCol = metafieldCols.find((c) => c.namespace === 'product' && c.key === 'familia');
  const tipoCol = metafieldCols.find((c) => c.namespace === 'product' && c.key === 'tipo');
  const acabadoCol = metafieldCols.find((c) => c.namespace === 'product' && c.key === 'acabado');

  // 3) Iterate ONLY over surtido ES SKUs (the source of truth for the catalog).
  const surtidoES = surtidoByLocale.get(PRIMARY_LOCALE);
  if (!surtidoES) throw new Error('buildShopifyModel: missing surtido ES (primary locale)');

  const surtidoSkuSet = new Set(surtidoES.records.map((r) => r.sku));
  const surtidoOtherIndex = new Map(); // locale → Map<sku, raw>
  for (const loc of SECONDARY_LOCALES) {
    const s = surtidoByLocale.get(loc);
    if (!s) continue;
    const m = new Map();
    for (const r of s.records) m.set(r.sku, r.raw);
    surtidoOtherIndex.set(loc, m);
  }

  for (const record of surtidoES.records) {
    const { sku, raw } = record;
    const productWarnings = [];

    // --- Publication policy (§2 of import-pipeline) ---
    const inStock = stockMap.has(sku);
    const stockQty = stockMap.get(sku) ?? null;
    const inPrecios = preciosMap.has(sku);
    const priceEntry = preciosMap.get(sku);
    const price = priceEntry?.value ?? null;

    let publish = false;
    let publishReason = null;
    if (!inStock) {
      publishReason = 'missing_stock';
    } else if (stockQty == null || stockQty <= 0) {
      publishReason = 'stock_zero';
    } else if (!inPrecios) {
      publishReason = 'missing_price';
    } else if (priceEntry.invalid) {
      publishReason = 'price_invalid';
    } else if (price == null || price <= 0) {
      publishReason = 'price_zero';
    } else {
      publish = true;
    }

    // --- Build product fields ---
    const familiaVal = familiaCol ? raw[familiaCol.idx] : null;
    const tipoVal = tipoCol ? raw[tipoCol.idx] : null;
    const acabadoVal = acabadoCol ? raw[acabadoCol.idx] : null;
    const { title, warning: titleWarning } = buildTitle(familiaVal, tipoVal, acabadoVal, sku);
    if (titleWarning) productWarnings.push(titleWarning);

    const bodyHtml = bodyHtmlColIdx != null ? raw[bodyHtmlColIdx] : null;
    if (bodyHtml && looksLikeHtml(bodyHtml)) {
      productWarnings.push({
        kind: 'description_contains_html',
        message: `body_html contains HTML tags or entities (passed through as-is)`,
        sku,
        locale: PRIMARY_LOCALE,
      });
    }

    // Tags: include Familia:<value> and Coleccion:2026 (preserve current outlet visibility).
    const tags = [];
    if (familiaVal) tags.push(`Familia:${familiaVal}`);
    tags.push('Coleccion:2026');

    // Variant: sku + barcode (EAN13) + price + inventory.
    const barcode = barcodeColIdx != null ? raw[barcodeColIdx] : null;
    const variant = {
      sku,
      barcode: barcode ?? null,
      price: price ?? null,
      inventory_quantity: stockQty ?? null,
    };

    // Images: gather non-empty URLs in image_position order.
    const images = [];
    for (const ic of imageCols) {
      const url = raw[ic.idx];
      if (!url) continue;
      if (!isPlausibleUrl(url)) {
        productWarnings.push({
          kind: 'malformed_image_url',
          message: `image url "${url}" does not look like http(s)`,
          sku,
          locale: PRIMARY_LOCALE,
          column: ic.idx,
        });
        continue;
      }
      images.push({ src: String(url).trim(), position: ic.image_position ?? images.length });
    }

    // PR-IMG-3: slots sintéticos al FINAL del carrusel, después de todas
    // las fotos del CSV. El orden del array = posición en la galería.
    // altText propio (no hereda el de las fotos), sin extensión de fichero.
    for (const slot of derivedImageSlots) {
      images.push({
        src: slot.url_template.replaceAll('{SKU}', sku),
        position: images.length,
        alt: slot.alt_template ? slot.alt_template.replaceAll('{SKU}', sku) : null,
        derived: slot.id,
      });
    }

    // Metafields (primary locale): coerce per type, skip nulls.
    const metafields = [];
    for (const mc of metafieldCols) {
      const rawVal = raw[mc.idx];
      if (rawVal == null) continue;
      const { value, warning } = coerce(rawVal, mc.type, sku, mc.idx, PRIMARY_LOCALE);
      if (warning) productWarnings.push(warning);
      if (value == null) continue;
      // PR-CAT-RESTRUCTURE: post-coerce override por SKU (ver
      // scripts/sku-overrides.json y scripts/lib/sku-overrides.mjs).
      // Necesario porque el cron full reescribe estos metafields desde
      // el CSV; el override se aplica aquí para que el productSet envíe
      // el valor reasignado, no el del SFTP. Locale 'es' = valor primario.
      const override = getOverride(sku, mc.key, 'es');
      const finalValue = override != null ? override : value;
      // GraphQL Admin expects metafield values as serialized strings.
      let serialized;
      if (typeof finalValue === 'boolean') serialized = finalValue ? 'true' : 'false';
      else if (typeof finalValue === 'number') serialized = String(finalValue);
      else serialized = String(finalValue);
      metafields.push({
        namespace: mc.namespace,
        key: mc.key,
        type: mc.type,
        value: serialized,
      });
    }

    // --- Translations: only for translatable=true columns (+ body_html and title) ---
    const translations = {};
    const translatableMetafieldCols = metafieldCols.filter((c) => c.translatable === true);

    for (const loc of SECONDARY_LOCALES) {
      const otherRawMap = surtidoOtherIndex.get(loc);
      if (!otherRawMap) continue;
      const otherRaw = otherRawMap.get(sku);
      if (!otherRaw) {
        productWarnings.push({
          kind: 'missing_translation_row',
          message: `SKU not present in surtido ${loc}; translations skipped for this locale`,
          sku,
          locale: loc,
        });
        continue;
      }

      // Resolve the Shopify locale code up-front so it's available to the
      // metafield override lookup below (Opción 2: override-per-locale).
      const shopifyLocale = FILE_SUFFIX_TO_SHOPIFY_LOCALE[loc];
      if (!shopifyLocale) {
        throw new Error(`buildShopifyModel: no Shopify locale mapping for file suffix "${loc}". Update FILE_SUFFIX_TO_SHOPIFY_LOCALE.`);
      }

      const trMetafields = [];
      for (const mc of translatableMetafieldCols) {
        const rawVal = otherRaw[mc.idx];
        if (rawVal == null) continue;
        // For translations of text-typed metafields we keep them as string (no coerce).
        // Translatable metafields in our mapping are all string types.
        // PR-CAT-RESTRUCTURE: override aplica también a translations para
        // mantener primary↔translation alineados (writer reescribe traducciones
        // siempre tras PR-PIPELINE-A — si no overrideamos también las
        // traducciones, queda "Forlight" en ES y "DIY" en EN/FR/DE/IT/PT).
        // Pasa shopifyLocale para que overrides con shape por-locale (Bucket B
        // 'tipo') devuelvan la traducción canónica en cada idioma.
        const override = getOverride(sku, mc.key, shopifyLocale);
        const finalValue = override != null ? override : rawVal;
        trMetafields.push({ key: mc.key, value: String(finalValue) });
      }

      // body_html translation
      const otherBody = bodyHtmlColIdx != null ? otherRaw[bodyHtmlColIdx] : null;

      // Title translation (built per locale with the same rule §5).
      const otherFamilia = familiaCol ? otherRaw[familiaCol.idx] : null;
      const otherTipo = tipoCol ? otherRaw[tipoCol.idx] : null;
      const otherAcabado = acabadoCol ? otherRaw[acabadoCol.idx] : null;
      let titleTranslated = null;
      if (otherFamilia || otherTipo || otherAcabado) {
        const built = buildTitle(otherFamilia, otherTipo, otherAcabado, sku);
        // Don't emit a translated title if it just falls back to the SKU.
        if (built.title !== sku) titleTranslated = built.title;
      }

      // Edge case: description empty in ES but present in another locale (rare, worth flagging).
      if ((bodyHtml == null || String(bodyHtml).trim() === '') && otherBody) {
        productWarnings.push({
          kind: 'description_only_in_translation',
          message: `body_html is empty in ES but present in ${loc}`,
          sku,
          locale: loc,
        });
      }

      translations[shopifyLocale] = {
        title: titleTranslated,
        body_html: otherBody ?? null,
        metafields: trMetafields,
      };
    }

    // Assemble model
    const model = {
      sku,
      publish,
      publish_reason: publishReason,
      product: {
        title,
        body_html: bodyHtml ?? null,
        vendor: VENDOR,
        tags,
        images,
        metafields,
        variants: [variant],
      },
      translations,
      warnings: productWarnings,
    };

    products.set(sku, model);

    for (const w of productWarnings) warnings.push(w);
  }

  // 4) Orphans
  const orphans = {
    in_stock: [],
    in_precios: [],
  };
  for (const sku of stockMap.keys()) {
    if (!surtidoSkuSet.has(sku)) orphans.in_stock.push(sku);
  }
  for (const sku of preciosMap.keys()) {
    if (!surtidoSkuSet.has(sku)) orphans.in_precios.push(sku);
  }

  return { products, orphans, warnings };
}
