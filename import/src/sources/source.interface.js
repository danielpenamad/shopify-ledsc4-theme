/**
 * Source adapter contract.
 * Every source adapter must implement fetch() → Buffer.
 *
 * @typedef {Object} SourceAdapter
 * @property {() => Promise<Buffer>} fetch
 */

/**
 * @param {SourceAdapter} adapter
 */
export function validateAdapter(adapter) {
  if (typeof adapter.fetch !== 'function') {
    throw new Error('Source adapter must implement fetch() → Promise<Buffer>');
  }
}
