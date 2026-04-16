import { stockMapping, resolveField } from '../../config/stock-mapping.js';
import logger from '../logger.js';

/**
 * Map raw CSV rows to stock update operations.
 *
 * @param {Object[]} rows — raw parsed CSV rows
 * @returns {{ updates: Object[], skipped: Object[] }}
 */
export function mapStockRows(rows) {
  const updates = [];
  const skipped = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sku = resolveField(row, stockMapping.sku)?.toString().trim();

    if (!sku) {
      skipped.push({ row: i + 2, reason: 'missing SKU', raw: row });
      continue;
    }

    const rawInventory = resolveField(row, stockMapping.inventory);
    const inventory = parseInt(rawInventory, 10);

    if (isNaN(inventory)) {
      skipped.push({ row: i + 2, sku, reason: `invalid inventory: "${rawInventory}"` });
      continue;
    }

    const rawPrice = resolveField(row, stockMapping.price);
    const price = rawPrice !== undefined ? parseFloat(rawPrice) : undefined;

    const update = { sku, inventory };
    if (price !== undefined && !isNaN(price)) {
      update.price = price.toFixed(2);
    }

    updates.push(update);
  }

  if (skipped.length > 0) {
    logger.warn(`Stock mapper: ${skipped.length} rows skipped`);
    for (const s of skipped) {
      logger.warn(`  Row ${s.row}: ${s.reason}${s.sku ? ` (SKU: ${s.sku})` : ''}`);
    }
  }

  return { updates, skipped };
}
