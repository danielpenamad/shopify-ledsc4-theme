import fs from 'fs/promises';
import path from 'path';

export function createLocalFileSource(filePath) {
  const resolved = path.resolve(filePath);
  return {
    name: `local:${path.basename(resolved)}`,
    async fetch() {
      return fs.readFile(resolved);
    },
  };
}
