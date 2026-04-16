/**
 * SFTP source adapter — stub for future implementation.
 *
 * Will connect to SFTP server, download the file, and return a Buffer.
 * Same interface as local-file.js: { name, fetch() → Promise<Buffer> }
 */

export function createSftpSource(_config) {
  return {
    name: 'sftp:not-implemented',
    async fetch() {
      throw new Error(
        'SFTP source not implemented yet. Pass --file to use local file source.'
      );
    },
  };
}
