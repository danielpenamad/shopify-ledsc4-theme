import XLSX from 'xlsx';

/**
 * Parse an Excel buffer into an object keyed by sheet name.
 * Each value is an array of row objects (header-keyed).
 *
 * @param {Buffer} buffer
 * @param {Object} options
 * @param {string[]} [options.sheets] — only parse these sheets (default: all)
 * @returns {Object<string, Object[]>}
 */
export function parseXlsx(buffer, options = {}) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const result = {};

  const sheetNames = options.sheets
    ? workbook.SheetNames.filter((n) => options.sheets.includes(n))
    : workbook.SheetNames;

  for (const name of sheetNames) {
    const sheet = workbook.Sheets[name];
    result[name] = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  }

  return result;
}
