import { productMapping } from '../../config/product-mapping.js';
import logger from '../logger.js';

/**
 * Map a raw Excel row to a Shopify product object.
 *
 * @param {Object} row — raw parsed Excel row (one sheet)
 * @returns {Object|null} — Shopify-ready product or null if invalid
 */
export function mapProductRow(row) {
  const get = (fieldDef) => {
    const raw = row[fieldDef.column] ?? '';
    return fieldDef.transform ? fieldDef.transform(raw) : raw.toString().trim();
  };

  const sku = get(productMapping.fields.sku);
  if (!sku) return null;

  const title = get(productMapping.fields.title);
  const description = get(productMapping.fields.description);
  const price = get(productMapping.fields.price);

  const images = productMapping.images.columns
    .map((col) => row[col]?.toString().trim())
    .filter((url) => url && url.startsWith('http'));

  const metafields = [];
  for (const [key, def] of Object.entries(productMapping.metafields.map)) {
    const value = get(def);
    if (value) {
      metafields.push({
        namespace: productMapping.metafields.namespace,
        key,
        value: value.toString(),
        type: typeof value === 'number' ? 'number_decimal' : 'single_line_text_field',
      });
    }
  }

  return {
    sku,
    title: title || sku,
    body_html: description,
    variants: [{ sku, price: price.toString(), inventory_management: 'shopify' }],
    images: images.map((src) => ({ src })),
    metafields,
  };
}

/**
 * Map all rows from a sheet.
 */
export function mapProductRows(rows) {
  const products = [];
  const skipped = [];

  for (let i = 0; i < rows.length; i++) {
    const product = mapProductRow(rows[i]);
    if (product) {
      products.push(product);
    } else {
      skipped.push({ row: i + 2, reason: 'missing SKU' });
    }
  }

  if (skipped.length > 0) {
    logger.warn(`Product mapper: ${skipped.length} rows skipped`);
  }

  return { products, skipped };
}
