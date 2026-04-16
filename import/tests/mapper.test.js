import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mapStockRows } from '../src/mappers/stock-mapper.js';
import { mapProductRows } from '../src/mappers/product-mapper.js';

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

describe('Product Mapper', () => {
  it('should map MF_ES rows with Hoja1 price', () => {
    const sheets = {
      'Hoja1': [
        { 'Código': 'SKU-001', 'Precio Neto Special Buys': 99.50, 'Unidades': 10, 'Descripción': 'Test', 'Família': 'FAM', 'Tipologia': 'Tipo' },
      ],
      'MF_ES': [
        {
          'Referencia': 'SKU-001', 'Descripción': 'Lámpara Test', 'Tipo': 'Aplique',
          'EAN13': '1234567890123', 'Família': 'TestFam', 'Catálogo': 'Decorative',
          'Imagen web': 'https://files.ledsc4.com/main-photo/SKU-001',
          'Ficha': 'https://files.ledsc4.com/ft2/es/SKU-001.html',
          'masterfile.tender_text': 'Detailed description here',
        },
      ],
    };

    const { products, skipped } = mapProductRows(sheets, 'es');

    assert.strictEqual(products.length, 1);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(products[0].sku, 'SKU-001');
    assert.strictEqual(products[0].variants[0].price, '99.50');
    assert.strictEqual(products[0].images.length, 1);
    assert.ok(products[0].metafields.length > 0);
    assert.strictEqual(products[0].vendor, 'LedsC4');
  });

  it('should include Hoja1-only SKUs as basic products', () => {
    const sheets = {
      'Hoja1': [
        { 'Código': 'ONLY-HOJA', 'Precio Neto Special Buys': 50, 'Unidades': 5, 'Descripción': 'Solo Hoja1', 'Família': 'FAM', 'Tipologia': 'Tipo' },
      ],
      'MF_ES': [],
    };

    const { products } = mapProductRows(sheets, 'es');

    assert.strictEqual(products.length, 1);
    assert.strictEqual(products[0].sku, 'ONLY-HOJA');
    assert.strictEqual(products[0].variants[0].price, '50.00');
    assert.strictEqual(products[0].images.length, 0);
  });

  it('should skip duplicate SKUs', () => {
    const sheets = {
      'Hoja1': [],
      'MF_ES': [
        { 'Referencia': 'DUP-001', 'Descripción': 'First' },
        { 'Referencia': 'DUP-001', 'Descripción': 'Duplicate' },
      ],
    };

    const { products, skipped } = mapProductRows(sheets, 'es');

    assert.strictEqual(products.length, 1);
    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(skipped[0].reason, 'duplicate SKU');
  });
});
