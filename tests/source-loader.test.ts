import test from 'node:test';
import assert from 'node:assert/strict';
import {SourceLoader} from '../src/source-loader';
import {SourcePager, type PageJournal} from '../src/source-pager';
import {SourceStore} from '../src/source-store';
import type {CodingSnapshot, JsonObject} from '../src/protocol';

const basis = {id: '0xabc', owner: '~zod', desk: 'test', number: 1, root: '0v1', commit: '0v2'};
const path = '/lib/test/hoon';
function rig() {
  const records: JsonObject[] = [], commands: string[] = [], disk = new Map<string, unknown>();
  let active = true, current = basis;
  const state = (): CodingSnapshot => ({nonce: '0v1', cursor: '0x123', session: '0x1', owner: '~zod', ready: true,
    after: records.length, projects: [], sessions: [{id: '0x1', project: 'demo', source: current}], records: [...records], reviews: []});
  const add = (text: string, start: number, total: number, next: number | null) => {
    const request = `0x${records.length + 100}`, sequence = records.length;
    const value = {path, mark: 'hoon', blob: '0x99', start, total, text, bytes: Buffer.byteLength(text), lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0), next};
    records.push({id: request, sequence, kind: 'tool', text: JSON.stringify({version: 'native-coding-tool-result-v1',
      call_id: request, context: {session: '0x1', request, source: basis}, output: {kind: 'read', ...value}}),
    file: {kind: 'read', session: '0x1', request, callId: request, source: basis, value}});
  };
  const client = {origin: 'https://test.example', codingState: async () => state(),
    codingTool: async (_session: string, _source: string, command: string): Promise<CodingSnapshot> => {commands.push(command); return state();}};
  const journal: PageJournal = {get: <T>(key: string) => disk.get(key) as T | undefined, update: async (key, value) => {disk.set(key, structuredClone(value));}};
  const store = new SourceStore(client), pager = new SourcePager(client, store, journal);
  const loader = (wait: () => Promise<void> = async () => {}) => new SourceLoader(store, pager, wait);
  const options = {active: () => active, progress: () => {}};
  return {client, store, journal, commands, records, add, state, loader, options,
    cancel: () => {active = false;}, resume: () => {active = true;}, drift: () => {current = {...basis, commit: '0v3'};}};
}

test('one file load assembles exact pages and a completed reopen sends nothing', async () => {
  const r = rig();
  r.client.codingTool = async (_s, _b, command) => {
    r.commands.push(command);
    if (r.commands.length === 1) r.add('α\n', 1, 3, 2);
    else if (r.commands.length === 2) r.add('middle\n', 2, 3, 3);
    else r.add('😀', 3, 3, null);
    return r.state();
  };
  const file = await r.loader().load('0x1', basis, path, 'demo', r.options); assert.ok(file);
  assert.equal(r.store.openSnapshot(file).text, 'α\nmiddle\n😀');
  await r.loader().load('0x1', basis, path, 'demo', r.options);
  assert.deepEqual(r.commands, [1, 2, 3].map(n => `/read ${path} ${n} 200`));
});

test('pending delivery is observed until retained bytes arrive without resending', async () => {
  const r = rig(); let waits = 0;
  const file = await r.loader(async () => {if (++waits === 3) r.add('done\n', 1, 1, null);}).load('0x1', basis, path, 'demo', r.options);
  assert.ok(file); assert.equal(r.commands.length, 1);
});

test('unknown delivery stays bounded and cannot replay after reconstruction', async () => {
  const r = rig();
  await assert.rejects(r.loader().load('0x1', basis, path, 'demo', r.options), /still pending/);
  await assert.rejects(r.loader().load('0x1', basis, path, 'demo', r.options), /still pending/);
  assert.equal(r.commands.length, 1);
  r.add('late\n', 1, 1, null);
  assert.ok(await r.loader().load('0x1', basis, path, 'demo', r.options));
  assert.equal(r.commands.length, 1);
});

test('only a receipt-bound size refusal authorizes a smaller page', async () => {
  const r = rig();
  r.client.codingTool = async (_s, _b, command) => {
    r.commands.push(command);
    if (r.commands.length > 1) {r.add('done\n', 1, 1, null); return r.state();}
    const request = '0x777';
    r.records.push({id: '0x77', sequence: 0, kind: 'tool', text: JSON.stringify({version: 'native-coding-tool-result-v1', call_id: request,
      context: {session: '0x1', request, source: basis}, output: {kind: 'refused', reason: 'read-page-too-large'}})});
    return {...r.state(), commandReceipt: {version: 'native-coding-command-receipt-v1', target: 'viki', session: '0x1', source: basis.id, request}};
  };
  assert.ok(await r.loader().load('0x1', basis, path, 'demo', r.options));
  assert.deepEqual(r.commands, [`/read ${path} 1 200`, `/read ${path} 1 100`]);
});

test('cancelling during fresh authorization prevents a new request', async () => {
  const r = rig(); let reads = 0;
  r.client.codingState = async () => {if (++reads === 2) r.cancel(); return r.state();};
  assert.equal(await r.loader().load('0x1', basis, path, 'demo', r.options), undefined);
  assert.equal(r.commands.length, 0);
});

test('cancelling an in-flight read preserves its result for later completion', async () => {
  const r = rig();
  r.client.codingTool = async (_s, _b, command) => {r.commands.push(command); r.add('done\n', 1, 1, null); r.cancel(); return r.state();};
  assert.equal(await r.loader().load('0x1', basis, path, 'demo', r.options), undefined);
  r.resume(); assert.ok(await r.loader().load('0x1', basis, path, 'demo', r.options));
  assert.equal(r.commands.length, 1);
});

test('source changes between pages stop the remaining read', async () => {
  const r = rig();
  r.client.codingTool = async (_s, _b, command) => {r.commands.push(command); r.add('first\n', 1, 2, 2); r.drift(); return r.state();};
  await assert.rejects(r.loader().load('0x1', basis, path, 'demo', r.options), /source or project changed/);
  assert.equal(r.commands.length, 1);
});

function rejectRead(r: ReturnType<typeof rig>, context: JsonObject = {}, reasons = ['standing-grant-revoked']) {
  const request = '0x777';
  for (const reason of reasons) r.records.push({id: `0x${80 + r.records.length}`, sequence: r.records.length, kind: 'tool',
    text: JSON.stringify({version: 'native-coding-tool-result-v1', call_id: request,
      context: {session: '0x1', request, source: basis, ...context}, output: {kind: 'refused', reason}})});
  return {...r.state(), commandReceipt: {version: 'native-coding-command-receipt-v1', target: 'viki', session: '0x1', source: basis.id, request}};
}

test('known native refusal is immediate and remains refused after reopening without replay', async () => {
  const r = rig(); let waits = 0;
  r.client.codingTool = async (_s, _b, command) => {r.commands.push(command); return rejectRead(r);};
  const load = () => r.loader(async () => {waits++;}).load('0x1', basis, path, 'demo', r.options);
  await assert.rejects(load(), /ship refused this file read: standing-grant-revoked/);
  await assert.rejects(load(), /standing-grant-revoked/);
  assert.equal(waits, 0); assert.equal(r.commands.length, 1);
});

test('late retained refusal is observed without another submission', async () => {
  const r = rig(); let waits = 0;
  r.client.codingTool = async (_s, _b, command) => {r.commands.push(command); return {...r.state(),
    commandReceipt: {version: 'native-coding-command-receipt-v1', target: 'viki', session: '0x1', source: basis.id, request: '0x777'}};};
  await assert.rejects(r.loader(async () => {if (++waits === 2) rejectRead(r);}).load('0x1', basis, path, 'demo', r.options), /standing-grant-revoked/);
  assert.equal(r.commands.length, 1); assert.equal(waits, 2);
});

test('another request, session or source cannot supply a refusal reason or authorize shrinking', async () => {
  for (const context of [{request: '0x888'}, {session: '0x2'}, {source: {...basis, commit: '0v3'}}]) {
    const r = rig();
    r.client.codingTool = async (_s, _b, command) => {r.commands.push(command); return rejectRead(r, context, ['read-page-too-large']);};
    await assert.rejects(r.loader().load('0x1', basis, path, 'demo', r.options), /still pending/);
    assert.equal(r.commands.length, 1);
  }
});

test('contradictory refusals cannot authorize a smaller page', async () => {
  const r = rig();
  r.client.codingTool = async (_s, _b, command) => {r.commands.push(command); return rejectRead(r, {}, ['read-page-too-large', 'standing-grant-revoked']);};
  await assert.rejects(r.loader().load('0x1', basis, path, 'demo', r.options), /Conflicting native file-read refusals/);
  assert.equal(r.commands.length, 1);
});
