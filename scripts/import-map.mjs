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

const VENDOR = 'LedsC4';
const PRIMARY_LOCALE = 'ES';
const SECONDARY_LOCALES = ['EN', 'IT', 'DE', 'FR', 'PT'];

// Coerce raw string from parser to the type declared in the mapping.
// Returns { value, warning? }.
//   - value: coerced value (or null if uncoercible / empty).
//   - warning: optional warning record to surface to the operator.
function coerce(rawString, type, sku, columnIndex, locale) {
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
      const n = type === 'number_integer' ? parseInt(s, 10) : parseFloat(s);
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
function buildTitle(familia, tipo, acabado, sku) {
  const parts = [];
  if (familia) parts.push(String(familia).trim());
  if (tipo) parts.push(String(tipo).trim());
  if (acabado) {
    const corto = String(acabado).split(/[,\s]+/)[0].trim();
    if (corto) parts.push(corto);
  }
  const t = parts.filter(Boolean).join(' ').trim();
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
  const stockMap = new Map();
  for (const r of stock.records) {
    if (r.inventario == null) continue;
    const n = parseInt(String(r.inventario).trim(), 10);
    stockMap.set(r.sku, Number.isNaN(n) ? null : n);
  }

  const preciosMap = new Map();
  for (const r of precios.records) {
    if (r.tarifa == null) continue;
    // Accept ES decimal too.
    let s = String(r.tarifa).trim();
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s);
    preciosMap.set(r.sku, Number.isNaN(n) ? null : n);
  }

  // 2) Index columns by destination for quick mapper lookups.
  const cols = mapping.columns;
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
    const price = preciosMap.get(sku) ?? null;

    let publish = false;
    let publishReason = null;
    if (!inStock) {
      publishReason = 'missing_stock';
    } else if (stockQty == null || stockQty <= 0) {
      publishReason = 'stock_zero';
    } else if (!inPrecios) {
      publishReason = 'missing_price';
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

    // Metafields (primary locale): coerce per type, skip nulls.
    const metafields = [];
    for (const mc of metafieldCols) {
      const rawVal = raw[mc.idx];
      if (rawVal == null) continue;
      const { value, warning } = coerce(rawVal, mc.type, sku, mc.idx, PRIMARY_LOCALE);
      if (warning) productWarnings.push(warning);
      if (value == null) continue;
      // GraphQL Admin expects metafield values as serialized strings.
      let serialized;
      if (typeof value === 'boolean') serialized = value ? 'true' : 'false';
      else if (typeof value === 'number') serialized = String(value);
      else serialized = String(value);
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

      const trMetafields = [];
      for (const mc of translatableMetafieldCols) {
        const rawVal = otherRaw[mc.idx];
        if (rawVal == null) continue;
        // For translations of text-typed metafields we keep them as string (no coerce).
        // Translatable metafields in our mapping are all string types.
        trMetafields.push({ key: mc.key, value: String(rawVal) });
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

      translations[loc] = {
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
