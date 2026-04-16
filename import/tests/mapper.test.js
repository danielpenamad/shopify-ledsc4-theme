import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mapStockRows } from '../src/mappers/stock-mapper.js';

describe('Stock Mapper', () => {
  it('should map valid rows to updates', () => {
    const rows = [
      { SKU: 'AB123', INVENTARIO: '50' },
      { SKU: 'CD456', INVENTARIO: '0' },
      { SKU: 'EF789', INVENTARIO: '100', PRECIO: '29.99' },
    ];

    const { updates, skipped } = mapStockRows(rows);

    assert.strictEqual(updates.length, 3);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(updates[0].sku, 'AB123');
    assert.strictEqual(updates[0].inventory, 50);
    assert.strictEqual(updates[2].price, '29.99');
  });

  it('should skip rows without SKU', () => {
    const rows = [
      { SKU: '', INVENTARIO: '10' },
      { INVENTARIO: '20' },
      { SKU: 'OK123', INVENTARIO: '5' },
    ];

    const { updates, skipped } = mapStockRows(rows);

    assert.strictEqual(updates.length, 1);
    assert.strictEqual(skipped.length, 2);
    assert.strictEqual(updates[0].sku, 'OK123');
  });

  it('should skip rows with invalid inventory', () => {
    const rows = [
      { SKU: 'AB123', INVENTARIO: 'abc' },
      { SKU: 'CD456', INVENTARIO: '' },
    ];

    const { updates, skipped } = mapStockRows(rows);

    assert.strictEqual(updates.length, 0);
    assert.strictEqual(skipped.length, 2);
  });

  it('should handle alternative column names', () => {
    const rows = [
      { sku: 'AB123', stock: '10' },
    ];

    const { updates } = mapStockRows(rows);

    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].sku, 'AB123');
    assert.strictEqual(updates[0].inventory, 10);
  });
});
