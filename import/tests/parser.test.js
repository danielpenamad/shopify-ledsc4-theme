import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseCsv } from '../src/parsers/csv-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('CSV Parser', () => {
  it('should parse sample-stock.csv with correct columns', async () => {
    const buf = await fs.readFile(path.join(__dirname, 'fixtures', 'sample-stock.csv'));
    const rows = parseCsv(buf);

    assert.strictEqual(rows.length, 5);
    assert.strictEqual(rows[0].SKU, 'AB12345');
    assert.strictEqual(rows[0].INVENTARIO, '150');
  });

  it('should handle semicolon-delimited CSV', () => {
    const buf = Buffer.from('SKU;INVENTARIO\nAA111;25\nBB222;0\n');
    const rows = parseCsv(buf);

    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].SKU, 'AA111');
    assert.strictEqual(rows[0].INVENTARIO, '25');
  });

  it('should skip empty lines', () => {
    const buf = Buffer.from('SKU,INVENTARIO\nAA111,10\n\nBB222,20\n');
    const rows = parseCsv(buf);

    assert.strictEqual(rows.length, 2);
  });
});
