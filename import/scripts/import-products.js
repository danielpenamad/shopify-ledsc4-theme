import 'dotenv/config';
import { parseArgs } from 'node:util';
import { createLocalFileSource } from '../src/sources/local-file.js';
import { parseXlsx } from '../src/parsers/xlsx-parser.js';
import { mapProductRows } from '../src/mappers/product-mapper.js';
import { writeProducts } from '../src/writers/product-writer.js';
import { initClient } from '../src/writers/shopify-client.js';
import { runPipeline } from '../src/pipeline.js';
import { productMapping } from '../config/product-mapping.js';
import logger from '../src/logger.js';

const { values: args } = parseArgs({
  options: {
    file: { type: 'string' },
    lang: { type: 'string', default: 'es' },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: false,
});

if (!args.file) {
  console.error('Usage: node scripts/import-products.js --file=./data/masterfile.xlsx [--lang=es] [--dry-run]');
  process.exit(1);
}

const dryRun = args['dry-run'] ?? false;
const lang = args.lang || 'es';
const sheetName = productMapping.sheets[lang];

if (!sheetName) {
  console.error(`Unknown language "${lang}". Available: ${Object.keys(productMapping.sheets).join(', ')}`);
  process.exit(1);
}

if (!dryRun) {
  initClient();
}

runPipeline({
  source: createLocalFileSource(args.file),
  parse: (buf) => parseXlsx(buf),
  map: (sheets) => mapProductRows(sheets, lang),
  write: (products, opts) => {
    if (opts.dryRun) {
      let withPrice = 0;
      let withImages = 0;
      let withMeta = 0;
      for (const p of products) {
        if (p.variants[0].price !== '0.00') withPrice++;
        if (p.images.length > 0) withImages++;
        if (p.metafields.length > 0) withMeta++;
        logger.info(`[DRY RUN] SKU ${p.sku}: "${p.title}" | ${p.variants[0].price}€ | ${p.images.length} imgs | ${p.metafields.length} mf | tags: ${p.tags.join(', ')}`);
      }
      logger.info(`Summary: ${products.length} products, ${withPrice} with price, ${withImages} with images, ${withMeta} with metafields`);
      return { created: products.length, updated: 0, errors: 0 };
    }
    return writeProducts(products, { dryRun: false });
  },
  options: { dryRun },
}).catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
