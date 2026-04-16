import 'dotenv/config';
import { parseArgs } from 'node:util';
import { createLocalFileSource } from '../src/sources/local-file.js';
import { parseCsv } from '../src/parsers/csv-parser.js';
import { mapStockRows } from '../src/mappers/stock-mapper.js';
import { writeStockUpdates } from '../src/writers/stock-writer.js';
import { initClient } from '../src/writers/shopify-client.js';
import { runPipeline } from '../src/pipeline.js';
import logger from '../src/logger.js';

const { values: args } = parseArgs({
  options: {
    file: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: false,
});

if (!args.file) {
  console.error('Usage: node scripts/sync-stock.js --file=./data/stock.csv [--dry-run]');
  process.exit(1);
}

const dryRun = args['dry-run'] ?? false;

if (!dryRun) {
  initClient();
}

const locationId = process.env.SHOPIFY_LOCATION_ID;

runPipeline({
  source: createLocalFileSource(args.file),
  parse: (buf) => parseCsv(buf),
  map: (rows) => mapStockRows(rows),
  write: (updates, opts) => {
    if (opts.dryRun) {
      for (const u of updates) {
        const parts = [`SKU ${u.sku}: inventory → ${u.inventory}`];
        if (u.price) parts.push(`price → ${u.price}`);
        logger.info(`[DRY RUN] ${parts.join(', ')}`);
      }
      return { processed: updates.length, errors: 0, notFound: 0 };
    }
    return writeStockUpdates(updates, { dryRun: false, locationId });
  },
  options: { dryRun },
}).catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
