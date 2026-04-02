import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/**
 * ESM replacement for __filename.
 * Usage: `const __filename = getFilename(import.meta.url);`
 */
export function getFilename(importMetaUrl: string): string {
  return fileURLToPath(importMetaUrl);
}

/**
 * ESM replacement for __dirname.
 * Usage: `const __dirname = getDirname(import.meta.url);`
 */
export function getDirname(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}
