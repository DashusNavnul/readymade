import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {NativeSessionHistory, type NativeHistoryConnection} from '../src/native-session-history';
import {ShipClient, type RequestOptions} from '../src/ship-client';
import type {JsonObject} from '../src/protocol';

const ux = (n: number) => '0x' + n.toString(16).replace(/\B(?=(?:[0-9a-f]{4})+$)/g, '.');
function page(offset = 0, sessionIds = ['0x2', '0x1'], next: number | null = null): JsonObject {
  return {schema: 'native-coding-session-archive-page-v1', owner: '~zod', available: true,
    head: {revision: 1234, commit: '0v1'}, offset, next, sessionIds};
}
function record(sequence: number, change: JsonObject = {}): JsonObject {
  return {id: ux(sequence + 1), sequence, kind: 'operator', text: 'Full retained record', file: null, context: null, ...change};
}
function detail(records = [record(0)], more = false, change: JsonObject = {}): JsonObject {
  return {schema: 'native-coding-session-archive-detail-v1', owner: '~zod', available: true, session: '0x1', project: 'demo',
    objective: 'Full native objective', summary: 'Retained summary', phase: 'paused', records,
    after: records.length ? Number(records.at(-1)!.sequence) + 1 : 0, more, ...change};
}
function fixture(values: JsonObject[], current = () => true) {
  const calls: {path: string; options?: RequestOptions}[] = [];
  const connection: NativeHistoryConnection = {owner: '~zod', current, client: {origin: 'https://zod.example',
    async requestJSON(path, options) {
      calls.push({path, options}); const value = values.shift(); assert.ok(value, 'Unexpected read'); return structuredClone(value);
    }}};
  return {calls, connection, reader: new NativeSessionHistory(connection)};
}

test('native archive catalog follows its pinned head on demand, preserving tree order', async () => {
  const {reader, calls} = fixture([page(0, ['0x2', '0x1'], 2), page(2, ['0x3'])]);
  const pages = reader.pages(); assert.equal(calls.length, 0);
  assert.deepEqual((await pages.next()).value?.sessionIds, ['0x2', '0x1']); assert.equal(calls.length, 1);
  assert.deepEqual((await pages.next()).value?.sessionIds, ['0x3']);
  assert.equal((await pages.next()).done, true);
  assert.deepEqual(calls.map(c => c.path), [
    '/apps/pataphor-native/coding/archived-sessions?offset=0&revision=0&commit=0v0',
    '/apps/pataphor-native/coding/archived-sessions?offset=2&revision=1.234&commit=0v1']);
  assert.ok(calls.every(c => JSON.stringify(c.options) === '{"method":"GET"}'));
});

test('catalog and history queries use canonical Hoon decimals above 999', async () => {
  const values = Array.from({length: 17}, (_, i) => page(i * 64, Array.from({length: 64}, (_, j) => ux(i * 64 + j + 1)), i === 16 ? null : (i + 1) * 64));
  const catalog = fixture(values); for await (const p of catalog.reader.pages()) assert.equal(p.sessionIds.length, 64);
  assert.match(catalog.calls.at(-1)!.path, /offset=1\.024&revision=1\.234/);
  const history = fixture([...Array.from({length: 32}, (_, i) => detail(Array.from({length: 32}, (_, j) => record(i * 32 + j)), true)), detail([record(1024)])]);
  let count = 0; for await (const p of history.reader.history('0x1')) count += p.records.length;
  assert.equal(count, 1025);
  assert.match(history.calls.at(-1)!.path, /id=0x1&after=1\.024$/);
});

test('native detail preserves complete text and retained context without any active catalog', async () => {
  const text = 'Native retained text\n' + 'α'.repeat(8192), file = {version: 'retained-file', value: {text: 'Exact file bytes\n'}};
  const {reader, calls} = fixture([detail([record(0, {text, file, context: {request: '0xa'}})], true), detail([record(1)], false)]);
  const pages = reader.history('0x1'), first = (await pages.next()).value!;
  assert.equal(first.objective, 'Full native objective'); assert.equal(first.records[0].text, text);
  assert.deepEqual(first.records[0].file, file); assert.deepEqual(first.records[0].context, {request: '0xa'});
  assert.equal(calls.length, 1); assert.equal((await pages.next()).value?.records[0].sequence, 1);
  assert.match(calls[1].path, /after=1$/); assert.equal((await pages.next()).done, true);
});

test('catalog rejects foreign owner, malformed identity, overfull pages and cursor drift', async () => {
  for (const change of [{owner: '~nec'}, {schema: 'old'}, {available: 'true'}, {offset: 1}, {next: 5},
    {sessionIds: ['0x01']}, {sessionIds: ['0x0']}, {sessionIds: ['0x1', '0x1']},
    {sessionIds: Array.from({length: 65}, (_, i) => ux(i + 1))}, {head: {revision: 0, commit: '0v1'}},
    {head: {revision: 1, commit: '0v01'}}, {head: {revision: 1, commit: '0v0'}}, {unexpected: true}]) {
    await assert.rejects(fixture([{...page(), ...change}]).reader.pages().next());
  }
  for (const change of [{head: {revision: 1235, commit: '0v1'}}, {head: {revision: 1234, commit: '0v2'}},
    {sessionIds: ['0x1']}, {offset: 0}, {sessionIds: [], next: 1}, {sessionIds: [], next: null}]) {
    const pages = fixture([page(0, ['0x1'], 1), {...page(1, ['0x2']), ...change}]).reader.pages();
    await pages.next(); await assert.rejects(pages.next());
  }
});

test('history refuses changed metadata, missing sequences and duplicate records across pages', async () => {
  for (const change of [{owner: '~nec'}, {session: '0x2'}, {project: 'other'}, {objective: 'Changed'}, {summary: 'Changed'}, {phase: 'complete'},
    {after: 1}, {records: [record(0)]}, {records: [record(2)], after: 3}, {records: [record(1, {id: '0x1'})]}, {records: [], after: 1, more: true}, {records: [], after: 1, more: false}]) {
    const pages = fixture([detail([record(0)], true), detail([record(1)], false, change)]).reader.history('0x1');
    await pages.next(); await assert.rejects(pages.next());
  }
});

test('history rejects malformed records and unsafe cursors before displaying a partial page', async () => {
  for (const records of [[record(1)], [record(0), record(2)], [record(0), record(0)], [record(1), record(0)], [record(0, {kind: 'unknown'})],
    [record(-1)], [record(0, {id: '0x01'})], [record(0, {text: 3})], [record(0, {context: []})], [record(0, {kind: ['tool']})],
    [record(0, {file: 'file'})], [record(Number.MAX_SAFE_INTEGER)], Array.from({length: 33}, (_, i) => record(i))]) {
    await assert.rejects(fixture([detail(records)]).reader.history('0x1').next());
  }
  for (const change of [{after: 0}, {after: 1.5}, {more: 'false'}, {phase: 'other'}, {phase: ['paused']}, {objective: '\ud800'}, {records: [], more: true, after: 0}]) {
    await assert.rejects(fixture([detail([record(0)], false, change)]).reader.history('0x1').next());
  }
});

test('unavailable detail uses native page-schema refusal and never becomes empty history', async () => {
  for (const detailRead of [false, true]) {
    const {reader, calls} = fixture([{schema: 'native-coding-session-archive-page-v1', owner: '~zod', available: false, error: 'archive-session-not-found'}]);
    await assert.rejects((detailRead ? reader.history('0x1') : reader.pages()).next(), /archive-session-not-found/);
    assert.equal(calls.length, 1);
  }
  assert.deepEqual((await fixture([page(0, [])]).reader.pages().next()).value?.sessionIds, []);
  assert.equal((await fixture([detail([])]).reader.history('0x1').next()).value?.more, false);
});

test('connection changes before or during reads refuse results and never retry', async () => {
  const before = fixture([page()], () => false);
  await assert.rejects(before.reader.pages().next(), /connection changed/); assert.equal(before.calls.length, 0);
  for (const changeOrigin of [false, true]) {
    let current = true;
    const f = fixture([page()], () => current);
    f.connection.client.requestJSON = async () => {
      if (changeOrigin) Object.defineProperty(f.connection.client, 'origin', {value: 'https://nec.example'}); else current = false;
      return page();
    };
    await assert.rejects(f.reader.pages().next(), /connection changed/);
  }
  const f = fixture([]); f.connection.client.requestJSON = async () => {throw new Error('Unknown read outcome');};
  await assert.rejects(f.reader.history('0x1').next(), /Unknown read outcome/);
  const malformed = fixture([]); await assert.rejects(malformed.reader.history('0x01').next()); assert.equal(malformed.calls.length, 0);
});

test('real shared transport authenticates archive GETs and refuses expired authentication without replay', async () => {
  const requests: {method: string; url: string; cookie?: string}[] = [];
  const server = createServer((request, response) => {
    requests.push({method: request.method!, url: request.url!, cookie: request.headers.cookie});
    if (request.url === '/~/login') {response.writeHead(200, {'Set-Cookie': 'urbauth-~zod=fixture-history; Path=/'}); response.end(); return;}
    if (request.url!.includes('archived-sessions?')) {response.writeHead(200, {'Content-Type': 'application/json'}); response.end(JSON.stringify(page())); return;}
    response.writeHead(403); response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new ShipClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async () => 'fixture-only');
  try {
    await client.signIn();
    const reader = new NativeSessionHistory({client, owner: '~zod', current: () => true});
    await reader.pages().next(); await assert.rejects(reader.history('0x1').next(), /authenticationRequired/);
    assert.equal(requests.length, 3); assert.equal(requests[0].url, '/~/login');
    assert.ok(requests.slice(1).every(r => r.method === 'GET' && r.cookie === 'urbauth-~zod=fixture-history'));
  } finally {client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});
