const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {extract, validate, digest, decimal} = require('../backend/install/extract-connector.cjs');
function fixture() {
  const files = ['Cargo.toml', 'Cargo.lock', 'src/main.rs', 'src/connect.rs', 'src/connect_cli.rs', 'src/connect_state.rs'].map(p => ({path:p, text:'// source\n', bytes:10, sha256:digest('// source\n')}));
  return {protocol:'pataphor-connector-source-v1', sourceContract:'rust-cargo-locked-v1', digestEncoding:'little-endian-urbit-hex', instructions:'Build separately.', files, manifest:digest(files.map(f => `${f.path}\n${decimal(f.bytes)}\n${f.sha256}\n`).join(''))};
}
test('connector extraction validates all bytes before output and never overwrites', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'connector-source-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const input = path.join(root, 'source.json'), out = path.join(root, 'out');
  fs.writeFileSync(input, JSON.stringify(fixture()));
  assert.equal(extract(input,out).files,6);
  assert.equal(fs.readFileSync(path.join(out,'src/main.rs'),'utf8'),'// source\n');
  assert.equal(fs.statSync(out).mode & 0o777,0o700);
  assert.throws(() => extract(input,out));
  const bad=fixture(); bad.files[5].text='changed';
  fs.writeFileSync(input,JSON.stringify(bad));
  assert.throws(() => extract(input,path.join(root,'bad')));
  assert(!fs.existsSync(path.join(root,'bad')));
});
test('connector validation refuses corrupt hashes, traversal, duplicates and missing files', () => {
  for (const mutate of [s=>s.files[0].path='../Cargo.toml', s=>s.files[0].sha256='0x0', s=>s.manifest='0x0', s=>s.files.push(s.files[0]), s=>s.files[0].path='Cargo.lock', s=>s.files[2].text='\ud800', s=>s.files[0].extra=true, s=>s.extra=true, s=>s.files.reverse()]) {
    const source=fixture(); mutate(source); assert.throws(()=>validate(source));
  }
});
test('connector extractor refuses symlink inputs and output ancestors', t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'connector-links-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const input=path.join(root,'source.json'); fs.writeFileSync(input,JSON.stringify(fixture()));
  fs.symlinkSync(input,path.join(root,'input-link'));
  assert.throws(()=>extract(path.join(root,'input-link'),path.join(root,'out')));
  fs.symlinkSync(root,path.join(root,'parent-link'));
  assert.throws(()=>extract(input,path.join(root,'parent-link','out')));
  assert(!fs.existsSync(path.join(root,'out')));
});
