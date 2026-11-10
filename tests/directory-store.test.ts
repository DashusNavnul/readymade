import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectoryStore } from '../src/directory-store';
import type { PageJournal } from '../src/source-pager';
import type { CodingSnapshot, JsonObject } from '../src/protocol';

const source = {id: '0xabc', owner: '~zod', desk: 'demo', number: 1, root: '0v1', commit: '0v2'};
const entry = (name: string) => ({path: `/lib/${name}/hoon`, mark: 'hoon', blob: '0x99'});
const names = Array.from({length: 64}, (_, i) => `file-${i}`);
function state(records: JsonObject[] = []): CodingSnapshot {
  return {owner: '~zod', session: '0x1', nonce: '0v1', cursor: '0x1', ready: true, after: 0,
    projects: [{id: 'demo'}], sessions: [{id: '0x1', project: 'demo', source}], records};
}
function result(names: string[], next: number | null, request = '0x123'): CodingSnapshot {
  const files = names.map(entry), value = {entries: files, next};
  const reply = state([{kind: 'tool', text: JSON.stringify({version: 'native-coding-tool-result-v1', call_id: request,
    context: {session: '0x1', request, project: 'demo', source}, output: {kind: 'list', entries: files.map(f => ({...f, bytes: null})), next}}),
    file: {kind: 'list', session: '0x1', request, callId: request, source, value}}]);
  reply.commandReceipt = {version: 'native-coding-command-receipt-v1', target: 'viki', session: '0x1', source: source.id, request}; return reply;
}
function journal(): PageJournal {
  const rows = new Map<string, unknown>();
  return {get: <T>(key: string) => structuredClone(rows.get(key)) as T | undefined,
    update: async (key, value) => { rows.set(key, structuredClone(value)); }};
}
test('directory pages bind an issued cursor and survive reopening without replay', async () => {
  let posts = 0;
  const client = {origin: 'https://zod.example', codingState: async () => state(), codingTool: async (_s: string, _b: string, input: string) => {
    posts++; assert.equal(input, posts === 1 ? '/list /lib 0 64' : '/list /lib 64 64');
    return posts === 1 ? result(names, 64) : result(['c'], null, '0x124');
  }};
  const disk = journal(), store = new DirectoryStore(client, disk), opened = await store.open('0x1', 'demo', '/lib');
  assert.equal(posts, 0); assert.deepEqual(opened.entries, []);
  const first = await store.next(opened.binding); assert.equal(first.next, 64); assert.equal(first.pending, undefined);
  const restored = new DirectoryStore(client, disk);
  assert.equal((await restored.open('0x1', 'demo', '/lib')).entries.length, 64); assert.equal(posts, 1);
  const last = await restored.next(opened.binding); assert.equal(last.next, null); assert.equal(last.entries.length, 65);
  await restored.next(opened.binding); assert.equal(posts, 2);
});
test('unknown directory delivery stays blocked after reconstruction', async () => {
  let posts = 0;
  const client = {origin: 'https://zod.example', codingState: async () => state(), codingTool: async () => { posts++; throw new Error('lost'); }};
  const disk = journal(), store = new DirectoryStore(client, disk), opened = await store.open('0x1', 'demo');
  await assert.rejects(store.next(opened.binding), /lost/);
  const restored = new DirectoryStore(client, disk); assert.ok((await restored.refresh(opened.binding)).pending);
  await assert.rejects(restored.next(opened.binding), /already sent/); assert.equal(posts, 1);
});
test('delayed listing is observed by receipt with no second POST', async () => {
  let observed = state(), posts = 0;
  const client = {origin: 'https://zod.example', codingState: async () => observed, codingTool: async () => {
    posts++; const reply = result(['a'], null); return {...reply, records: []};
  }};
  const store = new DirectoryStore(client, journal()), opened = await store.open('0x1', 'demo');
  assert.ok((await store.next(opened.binding)).pending);
  observed = result(['a'], null, '0x999'); assert.ok((await store.refresh(opened.binding)).pending);
  observed = result(['a'], null); assert.equal((await store.refresh(opened.binding)).entries[0].path, '/lib/a/hoon');
  assert.equal(posts, 1);
});
test('source and project changes refuse listing before submission', async () => {
  let observed = state(), posts = 0;
  const client = {origin: 'https://zod.example', codingState: async () => observed, codingTool: async () => { posts++; return result([], null); }};
  const store = new DirectoryStore(client, journal()), opened = await store.open('0x1', 'demo');
  observed = state(); observed.sessions[0].source = {...source, commit: '0v3'};
  await assert.rejects(store.next(opened.binding), /changed/);
  observed = state(); observed.sessions[0].project = 'private';
  await assert.rejects(store.next(opened.binding), /changed/); assert.equal(posts, 0);
});
test('exact native refusal settles the intent and permits a later explicit retry', async () => {
  let posts = 0;
  const client = {origin: 'https://zod.example', codingState: async () => state(), codingTool: async () => {
    posts++; const reply = result([], null);
    if (posts === 1) {
      const raw = JSON.parse(reply.records[0].text as string); raw.output = {kind: 'refused', reason: 'source-denied', detail: 'Access denied.'};
      reply.records[0].text = JSON.stringify(raw); reply.records[0].file = null;
    }
    return reply;
  }};
  const store = new DirectoryStore(client, journal()), opened = await store.open('0x1', 'demo');
  const denied = await store.next(opened.binding);
  assert.equal(denied.refusal?.reason, 'source-denied'); assert.equal(denied.pending, undefined); assert.equal(posts, 1);
  await store.refresh(opened.binding); assert.equal(posts, 1);
  const retried = await store.next(opened.binding); assert.equal(posts, 2); assert.equal(retried.next, null); assert.equal(retried.refusal, undefined);
});
test('projection mismatch, wrong directory, changed source and overlapping pages cannot become listings', async () => {
  for (const corrupt of ['projection', 'directory', 'source', 'cursor', 'overlap']) {
    let posts = 0;
    const client = {origin: 'https://zod.example', codingState: async () => state(), codingTool: async () => {
      posts++; const reply = result(names, 64, posts === 1 ? '0x123' : '0x124');
      if (corrupt === 'overlap' && posts === 1) return reply;
      const record = reply.records[0], file = record.file as JsonObject, projection = file.value as JsonObject;
      if (corrupt === 'projection') projection.next = 9;
      if (corrupt === 'directory') { const raw = JSON.parse(record.text as string); raw.output.entries[0].path = '/secret/a/hoon'; record.text = JSON.stringify(raw); }
      if (corrupt === 'source') file.source = {...source, commit: '0v3'};
      if (corrupt === 'cursor') { projection.next = 9; const raw = JSON.parse(record.text as string); raw.output.next = 9; record.text = JSON.stringify(raw); }
      if (corrupt === 'overlap') { projection.next = null; const raw = JSON.parse(record.text as string); raw.output.next = null; record.text = JSON.stringify(raw); }
      return reply;
    }};
    const store = new DirectoryStore(client, journal()), opened = await store.open('0x1', 'demo', '/lib');
    if (corrupt === 'overlap') await store.next(opened.binding);
    await assert.rejects(store.next(opened.binding));
    assert.equal((await store.refresh(opened.binding)).entries.length, corrupt === 'overlap' ? 64 : 0);
  }
});
