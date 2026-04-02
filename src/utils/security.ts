import fs from 'node:fs';
import path from 'node:path';
import { getDirname } from './paths.js';

const __dirname = getDirname(import.meta.url);

export const SSH_KEYS_DIR = path.join(__dirname, '..', '..', 'data', 'ssh-keys');

export function readPrivateKey(inputPath: string): Buffer {
  if (!fs.existsSync(SSH_KEYS_DIR)) {
    fs.mkdirSync(SSH_KEYS_DIR, { recursive: true });
  }

  const realRoot = fs.realpathSync(SSH_KEYS_DIR);

  // Sanitize: strip directory components, allow only the filename
  const filename = path.basename(inputPath);
  if (!filename || filename === '.' || filename === '..') {
    throw new Error('Invalid private key filename');
  }

  const target = path.join(realRoot, filename);

  if (!fs.existsSync(target)) {
    throw new Error('Private key file not found: ' + filename);
  }

  const lstat = fs.lstatSync(target);
  if (lstat.isSymbolicLink()) throw new Error('Private key path must not be a symlink');
  if (!lstat.isFile()) throw new Error('Private key path is not a file');
  if (lstat.size > 64 * 1024) throw new Error('Private key file too large (max 64KB)');

  return fs.readFileSync(target);
}
