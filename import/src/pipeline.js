import logger from './logger.js';
import { validateAdapter } from './sources/source.interface.js';

/**
 * Generic pipeline: source → parser → mapper → writer.
 *
 * @param {Object} config
 * @param {Object} config.source — source adapter ({ fetch })
 * @param {Function} config.parse — (buffer) → raw rows
 * @param {Function} config.map — (rows) → { data, skipped }
 * @param {Function} config.write — (data, options) → result
 * @param {Object} config.options — { dryRun, ... }
 */
export async function runPipeline(config) {
  const { source, parse, map, write, options = {} } = config;
  const start = Date.now();

  validateAdapter(source);
  logger.info(`Pipeline start — source: ${source.name}, dryRun: ${!!options.dryRun}`);

  logger.info('Fetching data...');
  const buffer = await source.fetch();
  logger.info(`Fetched ${(buffer.length / 1024).toFixed(1)} KB`);

  logger.info('Parsing...');
  const rows = parse(buffer);
  logger.info(`Parsed ${Array.isArray(rows) ? rows.length : 'N/A'} rows`);

  logger.info('Mapping...');
  const mapped = map(rows);
  const data = mapped.updates || mapped.products || mapped.data || mapped;
  const dataCount = Array.isArray(data) ? data.length : 0;
  const skippedCount = mapped.skipped?.length || 0;
  logger.info(`Mapped ${dataCount} items, ${skippedCount} skipped`);

  logger.info('Writing...');
  const result = await write(data, options);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  logger.info(`Pipeline done in ${elapsed}s — ${JSON.stringify(result)}`);
  return result;
}
