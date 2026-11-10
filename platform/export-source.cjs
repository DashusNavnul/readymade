const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// An explicit release inventory, never a recursive copy of the operator's workspace.
function exportSource(root, destination, files = require('./source-files.json')) {
  root = fs.realpathSync(root);
  destination = path.resolve(destination);
  if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length) {
    throw new Error('Invalid source inventory');
  }
  const entries = [...files].sort().map(name => {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.\-/]+$/.test(name) ||
        name.split('/').some(part => !part || part === '.' || part === '..') || name === 'SOURCE-MANIFEST.json') {
      throw new Error('Unsafe source inventory path');
    }
    let file = root;
    for (const part of name.split('/')) {
      file = path.join(file, part);
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Symlink refused: ${name}`);
    }
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Non-regular or linked source refused: ${name}`);
    const bytes = fs.readFileSync(file);
    return {name, bytes, mode: stat.mode & 0o111 ? 0o755 : 0o644};
  });
  // Validate and read everything before creating output. Never overwrite an existing directory.
  fs.mkdirSync(destination, {mode: 0o700});
  const manifest = {format: 1, files: {}};
  for (const {name, bytes, mode} of entries) {
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o755});
    fs.writeFileSync(target, bytes, {flag: 'wx', mode});
    fs.chmodSync(target, mode);
    manifest.files[name] = {sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, mode};
  }
  fs.writeFileSync(path.join(destination, 'SOURCE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx', mode: 0o644});
  return manifest;
}

if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('Usage: node platform/export-source.cjs NEW_OUTPUT_DIRECTORY');
  const result = exportSource(path.resolve(__dirname, '..'), process.argv[2]);
  console.log(`Exported ${Object.keys(result.files).length} source files. Review before publishing; this does not scan source contents for secrets.`);
}
module.exports = {exportSource};
