/**
 * Stock CSV column mapping.
 *
 * Keys are the internal field names used by the mapper/writer.
 * Values are the CSV column headers (case-insensitive match).
 * Alternatives are tried in order.
 */
export const stockMapping = {
  sku: ['SKU', 'sku', 'Sku', 'REFERENCIA', 'referencia'],
  inventory: ['INVENTARIO', 'inventario', 'Inventario', 'STOCK', 'stock', 'Stock', 'QTY', 'qty'],
  price: ['PRECIO', 'precio', 'Precio', 'PRICE', 'price', 'Price', 'PVP', 'pvp'],
};

/**
 * Resolve a field from a row using the mapping alternatives.
 */
export function resolveField(row, fieldAlternatives) {
  for (const col of fieldAlternatives) {
    if (row[col] !== undefined && row[col] !== '') {
      return row[col];
    }
  }
  return undefined;
}
