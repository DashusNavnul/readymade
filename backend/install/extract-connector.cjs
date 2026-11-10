const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

function hex(bytes) {
  const digits = BigInt('0x' + Buffer.from(bytes).reverse().toString('hex')).toString(16);
  return '0x' + digits.replace(/\B(?=(.{4})+$)/g, '.');
}
function digest(bytes) { return hex(crypto.createHash('sha256').update(bytes).digest()); }
function decimal(n) { return String(n).replace(/\B(?=(\d{3})+$)/g, '.'); }
function keys(object, expected) {
  assert(object && typeof object === 'object' && !Array.isArray(object), 'Expected object');
  assert.deepEqual(Object.keys(object).sort(), [...expected].sort(), 'Unexpected fields');
}
function validate(source) {
  keys(source, ['protocol', 'sourceContract', 'digestEncoding', 'instructions', 'manifest', 'files']);
  assert.equal(source.protocol, 'pataphor-connector-source-v1');
  assert.equal(source.sourceContract, 'rust-cargo-locked-v1');
  assert.equal(source.digestEncoding, 'little-endian-urbit-hex');
  assert(typeof source.instructions === 'string' && Buffer.byteLength(source.instructions) <= 8192);
  assert(Array.isArray(source.files) && source.files.length >= 6 && source.files.length <= 64);
  const names = new Set();
  let total = 0;
  for (const file of source.files) {
    keys(file, ['path', 'bytes', 'sha256', 'text']);
    assert(typeof file.path === 'string' && file.path.length <= 512);
    assert(/^(?:Cargo\.(?:toml|lock)|src\/(?:[A-Za-z0-9_-]+\/){0,15}[A-Za-z0-9_-]+\.rs)$/.test(file.path), 'Unsafe source path');
    assert(!names.has(file.path.toLowerCase()), 'Duplicate or case-colliding path');
    names.add(file.path.toLowerCase());
    assert(typeof file.text === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(file.text), 'Invalid Unicode');
    assert(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= 1048576);
    assert.equal(Buffer.byteLength(file.text), file.bytes, 'Source byte count mismatch');
    assert.equal(digest(file.text), file.sha256, 'Source hash mismatch');
    total += file.bytes;
  }
  assert(total <= 4194304, 'Source package too large');
  for (const name of ['Cargo.toml', 'Cargo.lock', 'src/main.rs', 'src/connect.rs', 'src/connect_cli.rs', 'src/connect_state.rs']) {
    assert(source.files.some(file => file.path === name), 'Required file missing');
  }
  assert.equal(digest(source.files.map(f => `${f.path}\n${decimal(f.bytes)}\n${f.sha256}\n`).join('')), source.manifest, 'Manifest mismatch');
  return source.files;
}
function extract(input, destination) {
  const fd = fs.openSync(input, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let source;
  try {
    const stat = fs.fstatSync(fd);
    assert(stat.isFile() && stat.size <= 32 * 1024 * 1024, 'Invalid source package file');
    source = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
  const files = validate(source);
  destination = path.resolve(destination);
  // Resolve existing ancestors individually: never follow a symlink into output.
  let parent = path.parse(destination).root;
  for (const part of path.relative(parent, path.dirname(destination)).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, part);
    const stat = fs.lstatSync(parent);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Output parent must be a real directory');
  }
  fs.mkdirSync(destination, {mode: 0o700});
  for (const file of files) {
    const target = path.join(destination, file.path);
    fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
    fs.writeFileSync(target, file.text, {flag: 'wx', mode: 0o600});
  }
  return {files: files.length, manifest: source.manifest};
}
if (require.main === module) {
  try {
    assert.equal(process.argv.length, 4, 'Usage: node backend/install/extract-connector.cjs SOURCE_JSON NEW_DIRECTORY');
    console.log(JSON.stringify(extract(process.argv[2], process.argv[3])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = {extract, validate, digest, decimal};
