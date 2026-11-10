import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DraftStore} from '../src/draft-store';
import {snapshotFrom, type SourceSnapshot} from '../src/source-store';
import type {CodingSnapshot} from '../src/protocol';

const origin = 'https://zod.example';
function source(number: number, text: string, overrides: object = {}): SourceSnapshot {
  return snapshotFrom({origin, ship: '~zod', session: '0x1', path: '/lib/test/hoon', mark: 'hoon',
    blob: `0x${number}`, text, source: {id: `0x${number}`, owner: '~zod', desk: 'demo', number, root: `0v${number}`, commit: `0v${number}`}, ...overrides});
}
function state(current: SourceSnapshot): CodingSnapshot {
  return {owner: '~zod', session: '0x1', ready: true, nonce: '0v1', cursor: '0x1', after: 0, records: [], projects: [], reviews: [],
    sessions: [{id: '0x1', project: 'demo', source: current.source}]};
}
function setup(t: {after(fn: () => void): void}) {
  const root = mkdtempSync(join(tmpdir(), 'readymade-reconcile-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const directory = join(root, 'drafts'), store = new DraftStore(directory);
  const old = store.create(source(1, 'one\nmid\nlast\n'));
  store.save(old.id, 'ONE\nmid\nlast\n');
  const current = source(2, 'one\nmid\nLAST\n');
  return {store, directory, old: store.get(old.id), current};
}
test('reconciliation atomically creates a new source-bound draft and preserves original bytes across reopen', t => {
  const {store, directory, old, current} = setup(t), file = join(directory, old.id + '.json'), before = readFileSync(file);
  const result = store.reconcile(old.id, current, 'UNSAVED\nmid\nlast\n', state(current), 'demo');
  assert.equal(result.kind, 'merged'); if (result.kind !== 'merged') throw new Error('Expected merge');
  assert.equal(result.draft.text, 'UNSAVED\nmid\nLAST\n'); assert.equal(result.draft.snapshot.uri, current.uri);
  assert.notEqual(result.draft.id, old.id); assert.equal(result.draft.pending, undefined);
  assert.deepEqual(readFileSync(file), before);
  const reopened = new DraftStore(directory);
  assert.deepEqual(reopened.get(old.id), old); assert.deepEqual(reopened.get(result.draft.id), result.draft);
});
test('overlap leaves only the untouched original journal', t => {
  const {store, directory, old} = setup(t), current = source(2, 'THEIRS\nmid\nlast\n');
  const before = readFileSync(join(directory, old.id + '.json'));
  assert.equal(store.reconcile(old.id, current, old.text, state(current), 'demo').kind, 'conflict');
  assert.deepEqual(readdirSync(directory), [old.id + '.json']);
  assert.deepEqual(readFileSync(join(directory, old.id + '.json')), before);
});
test('foreign context, stale observations and unchanged source refuse without writing', t => {
  const {store, directory, old, current} = setup(t);
  for (const replacement of [
    {origin: 'https://nec.example'}, {ship: '~nec'}, {session: '0x2'}, {path: '/lib/other/hoon'},
    {source: {...current.source, owner: '~nec'}}, {source: {...current.source, desk: 'foreign'}},
  ]) assert.throws(() => store.reconcile(old.id, source(2, current.text, replacement), old.text, state(current), 'demo'), /same ship/);
  for (const observation of [
    {...state(current), ready: false}, {...state(current), owner: '~nec'}, {...state(current), session: '0x2'},
    {...state(current), sessions: []}, {...state(current), sessions: [...state(current).sessions, ...state(current).sessions]},
    {...state(current), sessions: [{id: '0x1', project: 'other', source: current.source}]},
    state(old.snapshot),
  ]) assert.throws(() => store.reconcile(old.id, current, old.text, observation, 'demo'), /current project source/);
  assert.throws(() => store.reconcile(old.id, old.snapshot, old.text, state(old.snapshot), 'demo'), /changed source/);
  assert.deepEqual(readdirSync(directory), [old.id + '.json']);
});
test('existing target and concurrently changed original are never overwritten', t => {
  const {store, directory, old, current} = setup(t), other = new DraftStore(directory);
  const target = other.create(current); other.save(target.id, 'another editor draft');
  const before = readFileSync(join(directory, target.id + '.json'));
  assert.throws(() => store.reconcile(old.id, current, old.text, state(current), 'demo'), /outside this editor/);
  assert.deepEqual(readFileSync(join(directory, target.id + '.json')), before);
  assert.throws(() => other.reconcile(old.id, current, old.text, state(current), 'demo'), /already exists/);
  other.save(old.id, 'new original buffer');
  const third = source(3, current.text);
  assert.throws(() => store.reconcile(old.id, third, old.text, state(third), 'demo'), /Original draft changed/);
  assert.equal(readdirSync(directory).length, 2);
});
test('retained pending intent and an active writer lock refuse reconciliation', async t => {
  const {store, directory, old, current} = setup(t);
  const lock = join(directory, old.id + '.json.lock'); writeFileSync(lock, 'owned', {mode: 0o600});
  assert.throws(() => store.reconcile(old.id, current, old.text, state(current), 'demo'), /EEXIST/);
  assert.equal(readFileSync(lock, 'utf8'), 'owned'); rmSync(lock);
  await assert.rejects(store.prepare(old.id, {origin, snapshot: state(old.snapshot), codingTool: async () => {throw new Error('lost reply');}}), /lost reply/);
  const before = readFileSync(join(directory, old.id + '.json'));
  assert.throws(() => store.reconcile(old.id, current, old.text, state(current), 'demo'), /retained candidate intent/);
  assert.deepEqual(readFileSync(join(directory, old.id + '.json')), before);
});
test('reconciliation refuses a journal directory that is no longer private', t => {
  const {store, directory, old, current} = setup(t);
  const before = readFileSync(join(directory, old.id + '.json'));
  chmodSync(directory, 0o755);
  assert.throws(() => store.reconcile(old.id, current, old.text, state(current), 'demo'), /owned and private/);
  assert.deepEqual(readdirSync(directory), [old.id + '.json']);
  assert.deepEqual(readFileSync(join(directory, old.id + '.json')), before);
});
