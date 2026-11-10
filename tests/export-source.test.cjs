const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {exportSource} = require('../platform/export-source.cjs');

test('source export preserves bytes and executable mode, excludes unlisted private data and is reproducible', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-export-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const answer = 42;\n');
    fs.writeFileSync(path.join(root, 'build.sh'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
    fs.writeFileSync(path.join(root, '.env'), 'PRIVATE_FIXTURE');
    const inventory = ['src/a.ts', 'build.sh'];
    const a = exportSource(root, path.join(root, 'one'), inventory);
    const b = exportSource(root, path.join(root, 'two'), inventory);
    assert.deepEqual(a, b);
    assert.deepEqual(fs.readdirSync(path.join(root, 'one')).sort(), ['SOURCE-MANIFEST.json', 'build.sh', 'src']);
    for (const name of inventory) {
      const bytes = fs.readFileSync(path.join(root, 'one', name));
      assert.deepEqual(bytes, fs.readFileSync(path.join(root, name)));
      assert.equal(a.files[name].sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    }
    assert.equal(fs.statSync(path.join(root, 'one/build.sh')).mode & 0o777, 0o755);
    assert.throws(() => exportSource(root, path.join(root, 'one'), inventory), /EEXIST/);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('source export refuses missing files, traversal, duplicates and file/directory links before output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-export-'));
  try {
    fs.writeFileSync(path.join(root, 'secret'), 'PRIVATE_FIXTURE');
    fs.symlinkSync('secret', path.join(root, 'linked'));
    fs.symlinkSync(root, path.join(root, 'directory'));
    fs.linkSync(path.join(root, 'secret'), path.join(root, 'hardlinked'));
    for (const files of [['missing'], ['../secret'], ['/secret'], ['secret', 'secret'], ['linked'], ['directory/secret'], ['hardlinked']]) {
      assert.throws(() => exportSource(root, path.join(root, 'out'), files));
      assert.equal(fs.existsSync(path.join(root, 'out')), false);
    }
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('release inventory covers every current product, test and platform file', () => {
  const root = path.resolve(__dirname, '..');
  const inventory = require('../platform/source-files.json');
  function check(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), {withFileTypes: true})) {
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) check(name);
      else assert.ok(inventory.includes(name), `Review and add new release source: ${name}`);
    }
  }
  for (const directory of ['src', 'tests', 'platform', 'packaging', 'runtime']) check(directory);
});

test('exported runtime package retains its qualified patch, proof and upstream license', () => {
  const root = path.resolve(__dirname, '..');
  const inventory = require('../platform/source-files.json').filter(name => name.startsWith('runtime/'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-runtime-export-'));
  try {
    const output = path.join(temporary, 'release');
    const receipt = exportSource(root, output, inventory);
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'runtime/source-manifest.json')));
    for (const [file, field] of [['readymade-vere.patch', 'patchSHA256'], ['bounded-evaluation-proof.hoon', 'proofSHA256']]) {
      assert.equal(receipt.files['runtime/' + file].sha256, manifest[field]);
    }
    for (const file of ['README.md', 'LICENSE.vere.txt']) {
      assert.deepEqual(fs.readFileSync(path.join(output, 'runtime', file)), fs.readFileSync(path.join(root, 'runtime', file)));
    }
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});
