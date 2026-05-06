#!/usr/bin/env node
// Import pipeline orchestrator (Fase I2).
//
// Reads sample CSVs, runs parser + mapper, writes 4 reports under
// reports/import-<ISO timestamp>/. Does NOT call Shopify Admin API.
//
// Usage:
//   node scripts/import-report.mjs
//   node scripts/import-report.mjs --samples-dir=samples
//   node scripts/import-report.mjs --verbose
//
// The --env-file convention is preserved for homogeneity with I3/I4 even
// though no Shopify call happens here:
//   node --env-file=shopify-ledsc4-theme.env scripts/import-report.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { parseSurtido, parseStock, parsePrecios } from './import-parse.mjs';
import { buildShopifyModel } from './import-map.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const samplesArg = args.find((a) => a.startsWith('--samples-dir='));
const SAMPLES_DIR = samplesArg
  ? resolve(REPO_ROOT, samplesArg.slice('--samples-dir='.length))
  : resolve(REPO_ROOT, 'samples');

const LOCALES = ['ES', 'EN', 'IT', 'DE', 'FR', 'PT'];

function nowIsoStamp() {
  // ISO without colons / dots, suitable for filesystem paths.
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(arr) {
  return arr.map(csvEscape).join(',') + '\n';
}

async function loadMapping() {
  const path = resolve(REPO_ROOT, 'scripts', 'mapping.json');
  const text = await readFile(path, 'utf8');
  return JSON.parse(text);
}

async function main() {
  const t0 = Date.now();
  console.log(`Reading samples from: ${SAMPLES_DIR}`);

  const mapping = await loadMapping();

  // Parse the 8 CSVs in parallel.
  const surtidoPaths = LOCALES.map((loc) => ({
    locale: loc,
    path: join(SAMPLES_DIR, 'productos', `listado_productos_${loc}.csv`),
  }));

  const [surtidoResults, stockResult, preciosResult] = await Promise.all([
    Promise.all(surtidoPaths.map((p) => parseSurtido(p.path, p.locale).then((r) => ({ ...r, locale: p.locale })))),
    parseStock(join(SAMPLES_DIR, 'stock', 'stock_productos.csv')),
    parsePrecios(join(SAMPLES_DIR, 'precios', 'precios_productos.csv')),
  ]);

  const surtidoByLocale = new Map();
  for (const sr of surtidoResults) surtidoByLocale.set(sr.locale, sr);

  const surtidoES = surtidoByLocale.get('ES');
  const totalDuplicates = surtidoES.warnings.filter((w) => w.kind === 'duplicate_sku').length;

  // Build the Shopify model (mapper).
  const { products, orphans, warnings: mapperWarnings } = buildShopifyModel({
    surtidoByLocale,
    stock: stockResult,
    precios: preciosResult,
    mapping,
  });

  // Combine warnings across parser and mapper.
  const allWarnings = [];
  for (const sr of surtidoResults) for (const w of sr.warnings) allWarnings.push({ source: 'parser', ...w });
  for (const w of stockResult.warnings) allWarnings.push({ source: 'parser', kind: w.kind, message: w.message, sku_or_row: w.sku ?? w.row, locale: 'stock' });
  for (const w of preciosResult.warnings) allWarnings.push({ source: 'parser', kind: w.kind, message: w.message, sku_or_row: w.sku ?? w.row, locale: 'precios' });
  for (const w of mapperWarnings) allWarnings.push({ source: 'mapper', ...w });

  // Compute publish_reason breakdown for the summary.
  const reasonCounts = { missing_stock: 0, stock_zero: 0, missing_price: 0, price_zero: 0 };
  let publishCount = 0;
  for (const m of products.values()) {
    if (m.publish) publishCount++;
    else if (m.publish_reason) reasonCounts[m.publish_reason]++;
  }

  const ts = nowIsoStamp();
  const reportDir = resolve(REPO_ROOT, 'reports', `import-${ts}`);
  await mkdir(reportDir, { recursive: true });

  // ---- summary.txt ----
  const summary =
    `LedsC4 B2B Outlet — Import Report (I2 dry-pipeline)\n` +
    `Generated: ${new Date().toISOString()}\n` +
    `Samples:   ${SAMPLES_DIR}\n` +
    `\n` +
    `INPUT\n` +
    LOCALES.map((loc) => {
      const r = surtidoByLocale.get(loc);
      const dups = r.warnings.filter((w) => w.kind === 'duplicate_sku').length;
      const dupNote = dups > 0 ? ` (${dups} duplicate SKU${dups > 1 ? 's' : ''} dropped)` : '';
      return `- Surtido ${loc}:  ${r.records.length} records${dupNote}`;
    }).join('\n') +
    `\n- Stock:       ${stockResult.records.length} records (${(() => {
      let zero = 0; let pos = 0;
      for (const r of stockResult.records) {
        const n = parseInt(r.inventario, 10);
        if (Number.isNaN(n)) continue;
        if (n === 0) zero++; else if (n > 0) pos++;
      }
      return `${zero} with qty=0; ${pos} with qty>0`;
    })()})\n` +
    `- Precios:     ${preciosResult.records.length} records\n` +
    `\n` +
    `CROSS-CHECK\n` +
    `- SKUs in surtido (unique):                              ${products.size}\n` +
    `- SKUs would publish (in surtido + stock>0 + price>0):   ${publishCount}\n` +
    `- SKUs would NOT publish:                                ${products.size - publishCount}\n` +
    `  · missing_stock  (in surtido, not in stock):           ${reasonCounts.missing_stock}\n` +
    `  · stock_zero     (in surtido & stock, qty=0):          ${reasonCounts.stock_zero}\n` +
    `  · missing_price  (in surtido & stock>0, not in precios): ${reasonCounts.missing_price}\n` +
    `  · price_zero     (in surtido & stock>0 & price=0):     ${reasonCounts.price_zero}\n` +
    `- Orphan SKUs in stock (not in surtido):                 ${orphans.in_stock.length}\n` +
    `- Orphan SKUs in precios (not in surtido):               ${orphans.in_precios.length}` +
    (orphans.in_precios.length > 0 ? ` (${orphans.in_precios.join(', ')})` : '') +
    `\n` +
    `\n` +
    `ERRORS:    0\n` +
    `WARNINGS:  ${allWarnings.length} (see warnings.csv for detail)\n` +
    `\n` +
    `REPORTS WRITTEN\n` +
    `- ${join(reportDir, 'summary.txt')}\n` +
    `- ${join(reportDir, 'changes.csv')}\n` +
    `- ${join(reportDir, 'hidden.csv')}\n` +
    `- ${join(reportDir, 'warnings.csv')}\n` +
    `\n` +
    `Elapsed: ${((Date.now() - t0) / 1000).toFixed(2)}s\n`;

  await writeFile(join(reportDir, 'summary.txt'), summary, 'utf8');

  // ---- changes.csv ----
  let changesText = csvRow(['sku', 'would_publish', 'publish_reason', 'title', 'n_metafields', 'n_translations', 'n_images', 'has_warnings']);
  for (const [sku, m] of products) {
    const nTranslations = Object.keys(m.translations).length;
    changesText += csvRow([
      sku,
      m.publish ? 'true' : 'false',
      m.publish_reason ?? '',
      m.product.title,
      m.product.metafields.length,
      nTranslations,
      m.product.images.length,
      m.warnings.length > 0 ? 'true' : 'false',
    ]);
  }
  await writeFile(join(reportDir, 'changes.csv'), changesText, 'utf8');

  // ---- hidden.csv ----
  let hiddenText = csvRow(['sku', 'publish_reason', 'in_surtido', 'in_stock', 'stock_qty', 'in_precios', 'price']);
  for (const [sku, m] of products) {
    if (m.publish) continue;
    const variant = m.product.variants[0] ?? {};
    hiddenText += csvRow([
      sku,
      m.publish_reason ?? '',
      'true', // by definition, m comes from surtido
      variant.inventory_quantity != null ? 'true' : 'false',
      variant.inventory_quantity ?? '',
      variant.price != null ? 'true' : 'false',
      variant.price ?? '',
    ]);
  }
  await writeFile(join(reportDir, 'hidden.csv'), hiddenText, 'utf8');

  // ---- warnings.csv ----
  let warningsText = csvRow(['source', 'severity', 'sku_or_row', 'locale', 'kind', 'message']);
  for (const w of allWarnings) {
    warningsText += csvRow([
      w.source,
      'warning',
      w.sku ?? w.sku_or_row ?? w.row ?? '',
      w.locale ?? '',
      w.kind ?? '',
      w.message ?? '',
    ]);
  }
  await writeFile(join(reportDir, 'warnings.csv'), warningsText, 'utf8');

  // Console output.
  console.log('');
  console.log(summary);
  if (VERBOSE) {
    console.log('--- per-SKU verbose dump (first 10) ---');
    let i = 0;
    for (const [sku, m] of products) {
      if (i++ >= 10) break;
      console.log(JSON.stringify({ sku, publish: m.publish, publish_reason: m.publish_reason, title: m.product.title, n_metafields: m.product.metafields.length, n_warnings: m.warnings.length }));
    }
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
