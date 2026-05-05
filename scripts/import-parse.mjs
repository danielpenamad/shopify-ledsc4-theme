// Purely syntactic CSV parser for the LedsC4 importer (Fase I2).
//
// Responsibility: read a CSV file and return normalized records. Does NOT
// coerce types based on business rules — every value is kept as a string
// (or null for empty/sentinel values). The mapper applies type coercion
// from `scripts/mapping.json`. Rationale: separation of responsibilities,
// testability, and reusability for future SFTP-only validation jobs that
// don't need the mapping loaded.
//
// Exports:
//   - parseSurtido(filePath, locale)  → { records, errors, warnings, columnCount }
//   - parseStock(filePath)            → { records, errors, warnings }
//   - parsePrecios(filePath)          → { records, errors, warnings }
//
// Hard errors (thrown / rejected): missing file, empty file, header column
// count mismatch, missing SKU in a row.
// Soft warnings (collected): duplicate SKU (first wins), short row (skipped),
// invalid UTF-8 sequence (replaced with U+FFFD by Node's utf8 decoder).

import { readFile } from 'node:fs/promises';

const SURTIDO_EXPECTED_COLS = 79;
const STOCK_EXPECTED_COLS = 2;
const PRECIOS_EXPECTED_COLS = 2;

const NULL_SENTINELS = new Set(['', 'NULL', 'null', '-']);

/**
 * Tokenize a single CSV row respecting RFC-4180-style quoting:
 * - Fields may be wrapped in `"..."`.
 * - Inside a quoted field, `""` is a literal `"`.
 * - Outside quotes, the delimiter splits fields.
 *
 * Returns an array of strings (no normalization, no trimming).
 */
function splitCsvRow(row, delimiter = ',') {
  const out = [];
  let cur = '';
  let inQuotes = false;
  let i = 0;
  while (i < row.length) {
    const ch = row[i];
    if (inQuotes) {
      if (ch === '"') {
        if (row[i + 1] === '"') {
          // Escaped quote inside quoted field.
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  out.push(cur);
  return out;
}

/**
 * Split CSV text into logical rows, respecting quoted line breaks.
 * RFC-4180 allows newlines inside quoted fields.
 */
function splitCsvLines(text) {
  const rows = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
      continue;
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      // Handle CRLF as a single line break.
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (cur.length > 0) rows.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) rows.push(cur);
  return rows;
}

/**
 * Apply only the syntactic transformations:
 * - Trim outer whitespace.
 * - Empty / NULL / "-" → null.
 * - Otherwise, return the string verbatim. NO type coercion (booleans,
 *   decimals, etc. are mapper's responsibility).
 */
function normalizeCell(s) {
  if (s == null) return null;
  const t = s.trim();
  if (NULL_SENTINELS.has(t)) return null;
  return t;
}

async function readCsv(filePath) {
  const buf = await readFile(filePath);
  // Strip UTF-8 BOM if present (defensive — our samples don't have it).
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/**
 * Parse a surtido CSV (one of 6 locales).
 * Returns: { records, errors, warnings, columnCount }
 *   - records: [{ sku, raw: { 0: 'val', 1: 'val', ... 78: 'val' | null } }]
 *   - errors:   [{ kind, message, row? }]   — hard errors throw, but listed for callers that swallow.
 *   - warnings: [{ kind, message, sku?, row?, locale }]
 *   - columnCount: number of columns detected in the header.
 */
export async function parseSurtido(filePath, locale) {
  const text = await readCsv(filePath);
  const rows = splitCsvLines(text);
  if (rows.length === 0) {
    throw new Error(`parseSurtido(${locale}): file is empty (${filePath})`);
  }

  const header = splitCsvRow(rows[0]);
  if (header.length !== SURTIDO_EXPECTED_COLS) {
    throw new Error(
      `parseSurtido(${locale}): header has ${header.length} columns, expected ${SURTIDO_EXPECTED_COLS}`
    );
  }

  const records = [];
  const warnings = [];
  const seenSkus = new Set();

  for (let i = 1; i < rows.length; i++) {
    const cells = splitCsvRow(rows[i]);
    const rowNum = i + 1; // 1-indexed for human readability (matches editor line numbers).

    if (cells.length < header.length) {
      warnings.push({
        kind: 'short_row',
        message: `row has ${cells.length} columns, expected ${header.length}; skipped`,
        row: rowNum,
        locale,
      });
      continue;
    }

    // SKU is column 0 in the surtido contract.
    const sku = normalizeCell(cells[0]);
    if (sku == null) {
      // Hard error per prompt: SKU faltante is unrecoverable.
      throw new Error(`parseSurtido(${locale}): row ${rowNum} has empty SKU (col 0)`);
    }

    if (seenSkus.has(sku)) {
      warnings.push({
        kind: 'duplicate_sku',
        message: `duplicate SKU; first occurrence wins, this row dropped`,
        sku,
        row: rowNum,
        locale,
      });
      continue;
    }
    seenSkus.add(sku);

    const raw = {};
    for (let c = 0; c < header.length; c++) {
      raw[c] = normalizeCell(cells[c]);
    }

    records.push({ sku, raw });
  }

  return { records, errors: [], warnings, columnCount: header.length };
}

/**
 * Parse stock CSV.
 * Returns: { records: [{ sku, inventario: string|null }], errors, warnings }
 *
 * Duplicate handling: when a SKU appears more than once, the units are
 * SUMMED (per client decision 2026-05-05: "En el caso que en
 * stock_productos.csv aparezca duplicado, sumemos las unidades de stock
 * que indique"). The output `inventario` is the string-serialized sum.
 * A warning is always emitted with the formula so anomalies stay
 * visible to the operator.
 *
 * Edge case: if any of the duplicate values is non-numeric, summation
 * cannot proceed. Falls back to first-wins for that SKU and emits a
 * high-severity warning. Same applies if the sum is negative or
 * non-integer (defensive — should never happen with INVENTARIO data).
 *
 * NOTE: inventario is kept as a string in the output for API
 * compatibility with the mapper. Internally a parseInt is needed to
 * sum, but the result is serialized back to string.
 */
export async function parseStock(filePath) {
  const text = await readCsv(filePath);
  const rows = splitCsvLines(text);
  if (rows.length === 0) {
    throw new Error(`parseStock: file is empty (${filePath})`);
  }

  const header = splitCsvRow(rows[0]);
  if (header.length !== STOCK_EXPECTED_COLS) {
    throw new Error(
      `parseStock: header has ${header.length} columns, expected ${STOCK_EXPECTED_COLS}`
    );
  }

  // Accumulate occurrences per SKU before deciding the final value.
  // Keyed by SKU → { values: string[], rows: number[] }
  const accum = new Map();
  const warnings = [];

  for (let i = 1; i < rows.length; i++) {
    const cells = splitCsvRow(rows[i]);
    const rowNum = i + 1;

    if (cells.length < header.length) {
      warnings.push({
        kind: 'short_row',
        message: `row has ${cells.length} columns, expected ${header.length}; skipped`,
        row: rowNum,
      });
      continue;
    }

    const sku = normalizeCell(cells[0]);
    if (sku == null) {
      throw new Error(`parseStock: row ${rowNum} has empty SKU (col 0)`);
    }

    const value = normalizeCell(cells[1]);
    const existing = accum.get(sku);
    if (existing) {
      existing.values.push(value);
      existing.rows.push(rowNum);
    } else {
      accum.set(sku, { values: [value], rows: [rowNum] });
    }
  }

  // Produce one record per SKU. For duplicates: sum if all-numeric,
  // first-wins otherwise (with high-severity warning).
  const records = [];
  for (const [sku, acc] of accum) {
    if (acc.values.length === 1) {
      records.push({ sku, inventario: acc.values[0] });
      continue;
    }

    // Duplicate path. Try to sum.
    let allNumericNonNegativeInt = true;
    let sum = 0;
    for (const v of acc.values) {
      if (v == null) { allNumericNonNegativeInt = false; break; }
      // Stock should always be an integer >= 0. Reject decimals and negatives.
      if (!/^-?\d+$/.test(v.trim())) { allNumericNonNegativeInt = false; break; }
      const n = parseInt(v.trim(), 10);
      if (Number.isNaN(n) || n < 0) { allNumericNonNegativeInt = false; break; }
      sum += n;
    }

    if (allNumericNonNegativeInt) {
      const formula = `${acc.values.join('+')}=${sum}`;
      warnings.push({
        kind: 'duplicate_sku',
        message: `SKU duplicate (${acc.values.length} occurrences at rows ${acc.rows.join(',')}); stock units summed: ${formula}`,
        sku,
      });
      records.push({ sku, inventario: String(sum) });
    } else {
      warnings.push({
        kind: 'duplicate_sku_non_numeric',
        severity: 'high',
        message: `SKU duplicate (${acc.values.length} occurrences at rows ${acc.rows.join(',')}); non-numeric or invalid value encountered, cannot sum; first value retained: '${acc.values[0]}'; all values seen: [${acc.values.map((v) => v == null ? 'null' : `'${v}'`).join(', ')}]`,
        sku,
      });
      records.push({ sku, inventario: acc.values[0] });
    }
  }

  return { records, errors: [], warnings };
}

/**
 * Parse precios CSV.
 * Returns: { records: [{ sku, tarifa: string|null }], errors, warnings }
 * NOTE: tarifa is kept as a string. Mapper coerces to number.
 */
export async function parsePrecios(filePath) {
  const text = await readCsv(filePath);
  const rows = splitCsvLines(text);
  if (rows.length === 0) {
    throw new Error(`parsePrecios: file is empty (${filePath})`);
  }

  const header = splitCsvRow(rows[0]);
  if (header.length !== PRECIOS_EXPECTED_COLS) {
    throw new Error(
      `parsePrecios: header has ${header.length} columns, expected ${PRECIOS_EXPECTED_COLS}`
    );
  }

  const records = [];
  const warnings = [];
  const seenSkus = new Set();

  for (let i = 1; i < rows.length; i++) {
    const cells = splitCsvRow(rows[i]);
    const rowNum = i + 1;

    if (cells.length < header.length) {
      warnings.push({
        kind: 'short_row',
        message: `row has ${cells.length} columns, expected ${header.length}; skipped`,
        row: rowNum,
      });
      continue;
    }

    const sku = normalizeCell(cells[0]);
    if (sku == null) {
      throw new Error(`parsePrecios: row ${rowNum} has empty SKU (col 0)`);
    }

    if (seenSkus.has(sku)) {
      warnings.push({
        kind: 'duplicate_sku',
        message: `duplicate SKU in precios; first occurrence wins`,
        sku,
        row: rowNum,
      });
      continue;
    }
    seenSkus.add(sku);

    records.push({ sku, tarifa: normalizeCell(cells[1]) });
  }

  return { records, errors: [], warnings };
}
