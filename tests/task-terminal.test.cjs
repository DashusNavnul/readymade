const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const {patchSource, patchBundle} = require('../platform/task-terminal.cjs');
const source = 'function foreground(e,C){let cache=false;if(C!==void 0)switch(e.command.presentation.panel){case 1:case 2:cache=true;}return cache;}function background(e,T){let cache=false;if(T!==void 0)switch(e.command.presentation.panel){case 1:case 2:cache=true;}return cache;}';
const digest = value => crypto.createHash('sha256').update(value).digest('base64').replace(/=+$/, '');
test('closing task terminals are excluded from both reuse caches; normal reuse remains', () => {
  const api = new Function(patchSource(source) + ';return {foreground,background};')();
  for (const fn of Object.values(api)) for (const panel of [1, 2]) {
    for (const close of [true, false, undefined]) {
      const task = {command: {presentation: {panel, close}}};
      assert.equal(fn(task, 0), close !== true);
      assert.equal(fn(task, 2), close !== true);
      assert.equal(fn(task, undefined), false);
    }
  }
});
test('task patch refuses changed, duplicated or already patched completion paths', () => {
  assert.throws(() => patchSource(source.replace('T!==void 0', 'T!=null')), /Unexpected/);
  assert.throws(() => patchSource(source + source), /Unexpected/);
  assert.throws(() => patchSource(patchSource(source)), /Unexpected/);
});
test('task patch checks and preserves bundle integrity metadata', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-task-patch-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const key = 'vs/workbench/workbench.desktop.main.js', file = path.join(root, 'out', key), manifest = path.join(root, 'product.json');
  fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, source);
  const product = {nameShort: 'VSCodium', checksums: {[key]: 'wrong', other: 'retained'}};
  fs.writeFileSync(manifest, JSON.stringify(product));
  assert.throws(() => patchBundle(root), /checksum mismatch/);
  assert.equal(fs.readFileSync(file, 'utf8'), source);
  product.checksums[key] = digest(source); fs.writeFileSync(manifest, JSON.stringify(product));
  patchBundle(root);
  const actual = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.equal(actual.checksums[key], digest(fs.readFileSync(file)));
  assert.equal(actual.checksums.other, 'retained'); assert.equal(actual.nameShort, 'VSCodium');
});
