import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {RemoteDraftStore} from '../src/remote-draft-store';
import {remoteSourceHash, type RemoteSourceObservation} from '../src/remote-project-view';

function source(): RemoteSourceObservation {
  return {origin: 'https://peer.example', owner: '~zod', peer: '~nec', project: 'shared', generation: '1', request: '0x1',
    grant: '0x2', observedAt: '~2026.11.09', root: '0x3', snapshotDigest: '0x4', desk: 'shared', revision: '1',
    files: [{path: '/lib/example/hoon', text: 'original\n', hash: remoteSourceHash('original\n')}]};
}
function setup(t: {after(fn: () => void): void}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-remote-draft-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const directory = path.join(root, 'drafts'); return {root, directory, store: new RemoteDraftStore(directory)};
}
test('remote drafts retain exact provenance and changed bytes across process-like reconstruction', t => {
  const {store, directory} = setup(t), s = source(), draft = store.create(s, s.files[0].path);
  store.save(draft.uri, 'changed\r\n');
  const fresh = new RemoteDraftStore(directory), restored = fresh.get(draft.id);
  assert.equal(restored.text, 'changed\r\n'); assert.deepEqual(restored.observation, s);
  assert.equal(fresh.create(s, draft.path).text, restored.text);
  assert.equal(restored.observation.files[0].text, 'original\n');
  assert.equal('session' in restored.observation, false); assert.equal('commit' in restored.observation, false);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(directory, `${draft.id}.json`)).mode & 0o777, 0o600);
  assert.throws(() => fresh.save(draft.originalUri, 'bad'), /read-only/);
  (restored.observation.files[0] as {text: string}).text = 'caller mutation';
  assert.equal(fresh.get(draft.id).observation.files[0].text, 'original\n');
});
test('origin, owner, peer and native observation selectors cannot alias a draft', t => {
  const {store} = setup(t), s = source(), first = store.create(s, s.files[0].path);
  for (const patch of [{origin: 'https://other.example'}, {owner: '~wes'}, {peer: '~bud'}, {project: 'other'},
    {generation: '2'}, {request: '0x2'}, {root: '0x5'}, {snapshotDigest: '0x6'}, {revision: '2'}, {grant: '0x7'}]) {
    assert.notEqual(store.create({...s, ...patch}, first.path).id, first.id);
  }
  assert.throws(() => store.get(first.uri + '?origin=other'));
  assert.throws(() => store.get(first.uri.replace('remote-draft', 'draft')));
});
test('malformed observations and inadmissible edits never replace saved bytes', t => {
  const {store, directory} = setup(t), s = source(), row = store.create(s, s.files[0].path);
  const before = fs.readFileSync(path.join(directory, `${row.id}.json`));
  for (const text of ['λ', '\0', 'x'.repeat(32769)]) assert.throws(() => store.save(row.id, text));
  for (const patch of [{origin: 'https://user:pass@peer.example'}, {peer: '~zod'}, {request: '0x01'},
    {files: [{...s.files[0], hash: '0x1'}]}, {files: [s.files[0], s.files[0]]}, {files: [{...s.files[0], path: '/lib/../hoon'}]}]) {
    assert.throws(() => store.create({...s, ...patch}, row.path));
  }
  assert.deepEqual(fs.readFileSync(path.join(directory, `${row.id}.json`)), before);
  const data = JSON.parse(before.toString()); data.observation.files[0].text = 'tampered';
  fs.writeFileSync(path.join(directory, `${row.id}.json`), JSON.stringify(data));
  assert.throws(() => new RemoteDraftStore(directory));
});
test('concurrent windows, retained locks and insecure journals fail closed', t => {
  const {store, directory} = setup(t), s = source(), row = store.create(s, s.files[0].path);
  const other = new RemoteDraftStore(directory); store.save(row.id, 'first window');
  assert.throws(() => other.save(row.id, 'second window'), /another window/);
  assert.equal(new RemoteDraftStore(directory).get(row.id).text, 'first window');
  fs.writeFileSync(path.join(directory, '.write.lock'), 'retained', {mode: 0o600});
  assert.throws(() => store.save(row.id, 'blocked'));
  assert.equal(fs.readFileSync(path.join(directory, '.write.lock'), 'utf8'), 'retained');
  fs.chmodSync(path.join(directory, `${row.id}.json`), 0o644);
  assert.throws(() => new RemoteDraftStore(directory), /private/);
});
test('linked journal and linked storage cannot disclose or replace other files', t => {
  const {root, store, directory} = setup(t), s = source(), row = store.create(s, s.files[0].path);
  const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'preserve', {mode: 0o600});
  const journal = path.join(directory, `${row.id}.json`); fs.unlinkSync(journal); fs.symlinkSync(outside, journal);
  assert.throws(() => new RemoteDraftStore(directory)); assert.throws(() => store.save(row.id, 'bad'));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preserve');
  const linked = path.join(root, 'linked'); fs.symlinkSync(directory, linked);
  assert.throws(() => new RemoteDraftStore(linked));
});
test('capacity includes journals created by another window and leaves existing edits intact', t => {
  const {store, directory} = setup(t), other = new RemoteDraftStore(directory), s = source();
  for (let i = 1; i <= 64; i++) store.create({...s, request: `0x${i.toString(16)}`}, s.files[0].path);
  assert.throws(() => other.create({...s, request: '0x100'}, s.files[0].path), /64 remote drafts/);
  const retained = store.list()[0]; store.save(retained.id, 'still editable');
  const restored = new RemoteDraftStore(directory);
  assert.equal(restored.list().length, 64); assert.equal(restored.get(retained.id).text, 'still editable');
});

test('identical draft saves preserve exact journal bytes, timestamp and file identity after reload', t => {
  const {store, directory} = setup(t), s = source(), row = store.create(s, s.files[0].path);
  const changed = store.save(row.id, 'local edit'), file = path.join(directory, row.id + '.json');
  const bytes = fs.readFileSync(file), stat = fs.statSync(file);
  for (const editor of [store, new RemoteDraftStore(directory)]) {
    assert.deepEqual(editor.save(row.uri, changed.text), changed);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(fs.statSync(file).ino, stat.ino); assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);
  }
  const next = store.save(row.id, 'real later edit'); assert.ok(next.updatedAt > changed.updatedAt);
  assert.equal(new RemoteDraftStore(directory).get(row.id).text, 'real later edit');
});
test('identical saves still refuse stale windows, retained locks and insecure journals', t => {
  const {store, directory} = setup(t), s = source(), row = store.create(s, s.files[0].path), stale = new RemoteDraftStore(directory);
  const current = store.save(row.id, 'other window edit'), file = path.join(directory, row.id + '.json'), bytes = fs.readFileSync(file);
  assert.throws(() => stale.save(row.id, row.text), /another window/); assert.deepEqual(fs.readFileSync(file), bytes);
  const lock = path.join(directory, '.write.lock'); fs.writeFileSync(lock, 'retained', {mode: 0o600});
  assert.throws(() => store.save(row.id, current.text)); assert.equal(fs.readFileSync(lock, 'utf8'), 'retained');
  fs.unlinkSync(lock); fs.chmodSync(file, 0o644);
  assert.throws(() => store.save(row.id, current.text), /private/); assert.deepEqual(fs.readFileSync(file), bytes);
});
