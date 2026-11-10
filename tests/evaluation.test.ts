import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvaluationStore, evaluationAllowed, evaluationValue} from '../src/evaluation-store';
import {snapshotFrom} from '../src/source-store';
import type {CodingSnapshot, JsonObject} from '../src/protocol';

const source = {id: '0xabc', owner: '~zod', desk: 'work', number: 2, root: '0v3', commit: '0v4'};
const snapshot = snapshotFrom({origin: 'https://zod.example', ship: '~zod', session: '0x1', source, path: '/lib/handoff/hoon', blob: '0x123', mark: 'hoon', text: '|=  [a=@ud b=@ud]\n(mul a b)\n'});
function state(records: JsonObject[] = []): CodingSnapshot {
  return {owner: '~zod', session: '0x1', nonce: '0v1', cursor: '0x1', ready: true, after: records.length ? 2 : 0, more: false, reset: false,
    projects: [{id: 'demo', operations: ['read', 'eval']}], sessions: [{id: '0x1', project: 'demo', source}], records,
    grants: [{id: '0x2', revoked: false, operations: ['read', 'eval'], readable: ['/lib']}]};
}
function nativeResult(): JsonObject {
  const {id: _id, ...basis} = source; void _id;
  const values = [{name: 'compile', passed: true, detail: 'Native Ford built the selected immutable source revision.', source, artifacts: ['0x11']},
    {name: 'eval', passed: true, detail: 'Result as jam hex: 0x1e50', source, artifacts: ['0x11', '0x22']}];
  return {id: '0x99', sequence: 1, kind: 'tool', file: {version: 'native-coding-problems-v1', kind: 'diagnostics', project: 'demo', session: '0x1',
    configuration: '0x3', request: '0x33', callId: '0x33', recordedAt: '~2026.11.9', source, value: {values}},
    text: JSON.stringify({version: 'native-coding-tool-result-v1', call_id: '0x33', context: {project: 'demo', session: '0x1', actor: '~zod', configuration: '0x3', request: '0x33', source: basis}, output: {kind: 'diagnostics', values: values.map(v => ({...v, source: basis}))}})};
}
function receipt(): CodingSnapshot {return {...state(), commandReceipt: {version: 'native-coding-command-receipt-v1', target: 'viki', session: '0x1', source: source.id, request: '0x33', delivery: '0x44'}, delivery: '0x44: submitted; observing native retention'};}
function temporary(t: {after(fn: () => void): void}): string {const path = fs.mkdtempSync(join(tmpdir(), 'readymade-eval-')); t.after(() => fs.rmSync(path, {recursive: true, force: true})); return path;}

test('bounded native noun presentation decodes atoms and preserves invalid evidence literally', () => {
  assert.equal(evaluationValue('Result as jam hex: 0x2'), '0');
  assert.equal(evaluationValue('Result as jam hex: 0xc'), '1');
  assert.equal(evaluationValue('Result as jam hex: 0x1e50'), '60');
  for (const text of ['Result as jam hex: 0x0', 'Result as jam hex: 0x3', 'Native failure', 'Result as jam hex: 0x123456789']) assert.equal(evaluationValue(text), text);
});
test('project and selected-session grants both gate exact immutable source before publishing', () => {
  evaluationAllowed(state(), snapshot, 'demo');
  const altered = state(); altered.grants = []; assert.throws(() => evaluationAllowed(altered, snapshot, 'demo'), /grant/);
  const absent = state(); absent.projects[0].operations = ['read', 'replace', 'compile', 'check']; assert.throws(() => evaluationAllowed(absent, snapshot, 'demo'), /allow/);
  const revoked = state(); (revoked.grants as JsonObject[])[0].revoked = true; assert.throws(() => evaluationAllowed(revoked, snapshot, 'demo'), /grant/);
  const otherPath = state(); (otherPath.grants as JsonObject[])[0].readable = ['/library']; assert.throws(() => evaluationAllowed(otherPath, snapshot, 'demo'), /grant/);
  const malformed = state(); (malformed.grants as JsonObject[])[0].readable = ['']; assert.throws(() => evaluationAllowed(malformed, snapshot, 'demo'), /grant/);
  const stale = state(); stale.sessions[0].source = {...source, number: 3}; assert.throws(() => evaluationAllowed(stale, snapshot, 'demo'), /exact/);
});
test('one explicit run journals before POST, shows60 and restores exact raw evidence', async t => {
  const directory = temporary(t), store = new EvaluationStore(directory); let posts = 0, finished = false;
  const client = {origin: snapshot.origin, codingState: async () => state(finished ? [nativeResult()] : []), codingTool: async (session: string, basis: string, input: string) => {
    posts++; assert.equal(new EvaluationStore(directory).list().length, 1); assert.equal(session, snapshot.session); assert.equal(basis, source.id);
    assert.equal(input, '/eval /lib/handoff/hoon 300000\n(. [3 20])'); finished = true; return receipt();
  }};
  const row = await store.run(client, snapshot, 'demo', '(. [3 20])'); assert.equal(posts, 1); assert.equal(row.phase, 'complete'); assert.equal(row.output, '60');
  const reopened = new EvaluationStore(directory).get(row.id); assert.deepEqual(reopened.result, nativeResult()); assert.equal(reopened.snapshot.text, snapshot.text);
  await store.observe(client, row.id); assert.equal(posts, 1);
  assert.equal(fs.statSync(join(directory, row.id + '.intent.json')).mode & 0o777, 0o600);
});
test('lost POST remains unknown across reload and another window; observation never resends', async t => {
  const directory = temporary(t), store = new EvaluationStore(directory); let posts = 0;
  const client = {origin: snapshot.origin, codingState: async () => state(), codingTool: async () => {posts++; throw new Error('lost');}};
  await assert.rejects(store.run(client, snapshot, 'demo', '(. [3 20])'), /lost/);
  const other = new EvaluationStore(directory), row = other.list()[0]; assert.equal(row.phase, 'unknown');
  await assert.rejects(other.run(client, snapshot, 'demo', '(. [3 20])'), /never resent/);
  assert.equal((await other.observe(client, row.id)).phase, 'unknown'); assert.equal(posts, 1);
});
test('pending exact receipt settles from GET after reload even when current source has advanced', async t => {
  const directory = temporary(t), store = new EvaluationStore(directory); let posts = 0, ready = false;
  const client = {origin: snapshot.origin, codingState: async () => {const s = state(ready ? [nativeResult()] : []); if (ready) s.sessions[0].source = {...source, id: '0xddd', number: 3}; return s;}, codingTool: async () => {posts++; return receipt();}};
  const pending = await store.run(client, snapshot, 'demo', '(. [3 20])'); assert.equal(pending.phase, 'pending'); ready = true;
  const row = await new EvaluationStore(directory).observe(client, pending.id); assert.equal(row.output, '60'); assert.equal(row.snapshot.source.number, 2); assert.equal(posts, 1);
});
test('context cancellation or denied grant creates no intent and makes no POST', async t => {
  const store = new EvaluationStore(temporary(t)); let posts = 0;
  const client = {origin: snapshot.origin, codingState: async () => state(), codingTool: async () => {posts++; return receipt();}};
  await assert.rejects(store.run(client, snapshot, 'demo', '1', () => false), /context/);
  client.codingState = async () => ({...state(), grants: []}); await assert.rejects(store.run(client, snapshot, 'demo', '1'), /grant/);
  assert.equal(store.list().length, 0); assert.equal(posts, 0);
});
test('foreign request or stale source evidence cannot settle the retained evaluation', async t => {
  const store = new EvaluationStore(temporary(t)); let row: JsonObject | undefined;
  const client = {origin: snapshot.origin, codingState: async () => state(row ? [row] : []), codingTool: async () => receipt()};
  const pending = await store.run(client, snapshot, 'demo', '(. [3 20])');
  row = nativeResult(); const raw = JSON.parse(row.text as string); raw.context.request = '0x999'; row.text = JSON.stringify(raw);
  assert.equal((await store.observe(client, pending.id)).phase, 'pending');
  row = nativeResult(); const changed = JSON.parse(row.text as string); changed.context.source.number = 1; row.text = JSON.stringify(changed);
  assert.equal((await store.observe(client, pending.id)).phase, 'pending');
});
test('simultaneous windows cannot dispatch a second evaluation while the first is unsettled', async t => {
  const directory = temporary(t), first = new EvaluationStore(directory), second = new EvaluationStore(directory); let posts = 0, entered!: () => void, finish!: (s: CodingSnapshot) => void;
  const dispatched = new Promise<void>(resolve => {entered = resolve;});
  const client = {origin: snapshot.origin, codingState: async () => state(), codingTool: async () => {posts++; entered(); return new Promise<CodingSnapshot>(resolve => {finish = resolve;});}};
  const run = first.run(client, snapshot, 'demo', '1'); await dispatched;
  await assert.rejects(second.run(client, snapshot, 'demo', '2'), /never resent/); finish(receipt()); await run; assert.equal(posts, 1);
});
