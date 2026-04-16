import { parse } from 'csv-parse/sync';

/**
 * Parse a CSV buffer into an array of row objects.
 * Auto-detects delimiter (comma or semicolon).
 * Trims headers and values. Skips empty rows.
 */
export function parseCsv(buffer, options = {}) {
  const content = buffer.toString('utf-8');
  const firstLine = content.split('\n')[0] || '';
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const delimiter = semicolons > commas ? ';' : ',';

  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    delimiter: options.delimiter || delimiter,
    bom: true,
    ...options,
  });

  return records;
}
