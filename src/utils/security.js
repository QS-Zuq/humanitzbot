const fs = require('fs');
const path = require('path');

const SSH_KEYS_DIR = path.join(__dirname, '..', '..', 'data', 'ssh-keys');

function readPrivateKey(inputPath) {
  if (!fs.existsSync(SSH_KEYS_DIR)) {
    fs.mkdirSync(SSH_KEYS_DIR, { recursive: true });
  }

  const realRoot = fs.realpathSync(SSH_KEYS_DIR);

  // Sanitize: strip directory components, allow only the filename
  const filename = path.basename(String(inputPath));
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

module.exports = { readPrivateKey, SSH_KEYS_DIR };
