const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const script = path.resolve(__dirname, '../backend/prepare.py');

test('shipped application archive extracts verified activity, shared source, suggestion inbox and candidate decision dependencies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-application-source-'));
  const program = `
import importlib.util,json,hashlib,sys,re
from pathlib import Path
backend=Path(sys.argv[1]); output=Path(sys.argv[2])
spec=importlib.util.spec_from_file_location('application_extract',backend/'application/extract.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
manifest=json.loads((backend/'assembly-manifest.json').read_text())
archive=backend/'application/source.tar.gz'
count=m.extract(archive,manifest,output/'source')
expected={k:v for k,v in manifest['files'].items() if v['component']=='application'}
assert count==len(expected)
for name,pin in expected.items():
 data=(output/'source'/name).read_bytes()
 assert len(data)==pin['bytes'] and hashlib.sha256(data).hexdigest()==pin['sha256'],name
apps=(output/'source/desk.bill').read_text().strip()[2:-1].split()
assert len(apps)==10 and len(set(apps))==10 and '%readymade-editing' in apps
for app in apps:assert (output/'source/app'/ (app[1:]+'.hoon')).is_file(),app
for name in ['lib/readymade-editing-activity.hoon','lib/readymade-editing-activity-owner.hoon',
 'lib/readymade-editing-activity-client.hoon','lib/readymade-editing-activity-http.hoon',
 'lib/cantrip-project-access-runtime.hoon','sur/cantrip-project-view.hoon',
 'lib/readymade-project-view-client.hoon','lib/readymade-project-view-http.hoon',
 'ted/cantrip-project-view.hoon','lib/cantrip-project-receipt.hoon',
 'lib/readymade-project-suggest-client.hoon','lib/readymade-project-suggest-http.hoon',
 'lib/readymade-project-inbox-http.hoon','gen/cantrip-project-receipt-proof.hoon',
 'gen/readymade-project-suggest-proof.hoon','gen/readymade-project-inbox-proof.hoon',
 'lib/native-coding-candidate-decision-http.hoon','gen/native-coding-candidate-decision-http-proof.hoon']:
 assert name in expected and (output/'source'/name).stat().st_size>0,name
# Both new entry points must compile using shipped imports, not private fixtures.
for entry in ['lib/native-coding-candidate-decision-http.hoon','gen/native-coding-candidate-decision-http-proof.hoon']:
 text=(output/'source'/entry).read_text()
 for kind,block in re.findall(r'^/([-+])  (.*?)(?=\\n[^ ]|\\Z)',text,re.M|re.S):
  for token in re.split(r'[,\\s]+',block.strip()):
   if token:
    dep=('sur/' if kind=='-' else 'lib/')+token.split('=')[-1]+'.hoon'
    assert dep in manifest['files'],(entry,dep)
bad=json.loads(json.dumps(manifest));bad['files']['app/readymade-editing.hoon']['sha256']='0'*64
try:m.extract(archive,bad,output/'bad')
except ValueError as e:assert 'hash mismatch' in str(e)
else:raise AssertionError('modified manifest was accepted')
assert not (output/'bad').exists()
`;
  try {
    const result = spawnSync('python3', ['-c', program, path.resolve(__dirname, '../backend'), root], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('public source preparation refuses existing output and invalid archives before changing files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-prepare-refusal-'));
  try {
    const archive = path.join(root, 'invalid.tar.gz'); fs.writeFileSync(archive, 'invalid');
    const output = path.join(root, 'output'); fs.mkdirSync(output); fs.writeFileSync(path.join(output, 'keep'), 'preserve');
    const run = out => spawnSync('python3', [script, '--output', out, '--urbit-archive', archive], {encoding: 'utf8'});
    const existing = run(output); assert.notEqual(existing.status, 0); assert.match(existing.stderr, /Output already exists/);
    assert.equal(fs.readFileSync(path.join(output, 'keep'), 'utf8'), 'preserve');
    const fresh = path.join(root, 'fresh'); const corrupt = run(fresh);
    assert.notEqual(corrupt.status, 0); assert.match(corrupt.stderr, /archive hash or size mismatch/);
    assert.equal(fs.existsSync(fresh), false);
    const linked = path.join(root, 'linked'); fs.symlinkSync(output, linked);
    assert.notEqual(run(linked).status, 0); assert.equal(fs.readFileSync(path.join(output, 'keep'), 'utf8'), 'preserve');
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('the recorded source of the shipped application archive matches the archive, its pin and its manifest', () => {
  const crypto = require('node:crypto'), backend = path.join(__dirname, '../backend');
  const record = JSON.parse(fs.readFileSync(path.join(backend, 'application/source.json'), 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['applicationFiles', 'archiveSha256', 'pataphorCommit', 'schema']);
  assert.equal(record.schema, 'readymade-application-source-v1'); assert.match(record.pataphorCommit, /^[0-9a-f]{40}$/);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(backend, 'application/source.tar.gz'))).digest('hex'), record.archiveSha256);
  assert.ok(fs.readFileSync(path.join(backend, 'application/extract.py'), 'utf8').includes(`ARCHIVE_SHA256 = "${record.archiveSha256}"`));
  const manifest = JSON.parse(fs.readFileSync(path.join(backend, 'assembly-manifest.json'), 'utf8'));
  assert.equal(Object.values(manifest.files).filter(row => row.component === 'application').length, record.applicationFiles);
  assert.ok(fs.readFileSync(path.join(backend, 'application/README.md'), 'utf8').includes(`contains ${record.applicationFiles} application files`));
});
