'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const {patchBundle} = require('../platform/browser-reveal.cjs');
const checksum = text => crypto.createHash('sha256').update(text).digest('base64').replace(/=+$/, '');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-integrity-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const sources = {
    'vs/workbench/api/node/extensionHostProcess.js': 'startCDPSession(){return i._startCDPSession()},close(){return i._close()}',
    'vs/workbench/workbench.desktop.main.js': 'nui=class extends x{constructor(e,t,i,n,r,a){super();this.editorService=t; async $closeBrowserTab(e){let t=this._knownBrowsers.get(e); m(4,Dt),m(5,V)],nui)'
  };
  for (const [key, source] of Object.entries(sources)) {
    const file = path.join(root, 'out', key);
    fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, source);
  }
  const product = {nameShort: 'VSCodium', checksums: {...Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, checksum(source)])), 'unchanged.js': 'retained'}};
  const manifest = path.join(root, 'product.json');
  fs.writeFileSync(manifest, JSON.stringify(product));
  return {root, sources, product, manifest};
}
test('native reveal retains integrity checking with checksums of the resulting files', t => {
  const f = fixture(t); patchBundle(f.root);
  const result = JSON.parse(fs.readFileSync(f.manifest));
  assert.equal(result.nameShort, f.product.nameShort);
  assert.equal(result.checksums['unchanged.js'], 'retained');
  for (const key of Object.keys(f.sources)) {
    const bytes = fs.readFileSync(path.join(f.root, 'out', key));
    assert.equal(result.checksums[key], checksum(bytes));
    assert.notEqual(result.checksums[key], f.product.checksums[key]);
    assert.notEqual(checksum(Buffer.concat([bytes, Buffer.from('tamper')])), result.checksums[key]);
  }
  assert.throws(() => patchBundle(f.root), /Unexpected browser reveal/);
});
for (const missing of [false, true]) test(`refuses ${missing ? 'missing' : 'mismatched'} upstream checksum before any source write`, t => {
  const f = fixture(t), key = 'vs/workbench/workbench.desktop.main.js';
  if (missing) delete f.product.checksums[key]; else f.product.checksums[key] = 'wrong';
  const original = JSON.stringify(f.product); fs.writeFileSync(f.manifest, original);
  assert.throws(() => patchBundle(f.root), /checksum mismatch/);
  assert.equal(fs.readFileSync(f.manifest, 'utf8'), original);
  for (const [name, source] of Object.entries(f.sources)) assert.equal(fs.readFileSync(path.join(f.root, 'out', name), 'utf8'), source);
});
