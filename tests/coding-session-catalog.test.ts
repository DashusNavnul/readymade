import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {CodingCatalogError, CodingSessionCatalog} from '../src/coding-session-catalog';
import {ShipClient, ShipClientError} from '../src/ship-client';
import {asRecord, type CodingSnapshot, type JsonObject} from '../src/protocol';

const SCHEMA = 'native-coding-session-catalog-v2', ENDPOINT = '/apps/pataphor-native/coding/sessions?offset=0';
function row(id: number): JsonObject {
  return {id: '0x' + id.toString(16), project: 'fixture', objective: 'Retained task', phase: 'paused', model: 'codex-cli', worker: '~zod',
    source: {id: '0xabc', owner: '~zod', desk: 'scratch', number: 1, root: '0v1', commit: '0v2'}};
}
const all = Array.from({length: 129}, (_, i) => row(i + 1));
function snapshot(complete = false, total = 129): CodingSnapshot {
  return {owner: '~zod', nonce: '0v1', cursor: '0x1', session: '0x81', after: 0, ready: complete,
    sessionCatalogReady: true, projects: [{id: 'fixture'}], sessions: complete ? all.slice(0, total) : [], records: [{sequence: 0, text: 'Selected session record'}],
    sessionCatalog: {schema: SCHEMA, owner: '~zod', available: true, complete, digest: '0xabc', total,
      endpoint: ENDPOINT, error: complete ? null : 'coding-catalog-upgrade-required', permissionGranted: false}};
}
function page(offset: number, values = all, digest = '0xabc'): JsonObject {
  const end = Math.min(offset + 64, values.length);
  return {schema: SCHEMA, owner: '~zod', available: true, permissionGranted: false,
    catalog: {digest, offset, total: values.length, next: end === values.length ? null : end},
    sessionIds: values.map(r => r.id), sessions: values.slice(offset, end)};
}
const current = (): void => {};
const offset = (path: string): number => Number(new URL(path, 'http://localhost').searchParams.get('offset'));
const never = async (): Promise<JsonObject> => { throw new Error('Unexpected catalog request'); };

test('catalog beyond128 resolves exact complete selection and caches only within the same connection, owner, digest and total', async () => {
  const loader = new CodingSessionCatalog(), paths: string[] = [];
  const fetch = async (path: string) => { paths.push(path); return page(offset(path)); };
  const next = await loader.resolve(snapshot(), 1, fetch, current);
  assert.equal(next.ready, true); assert.equal(next.sessions.length, 129); assert.equal(next.sessions.at(-1)?.id, '0x81');
  assert.deepEqual(next.records, snapshot().records); assert.equal(paths.length, 3);
  assert.ok(paths.every(path => path.endsWith('&catalog=0xabc')));
  const again = await loader.resolve(snapshot(), 1, never, current); assert.equal(again.sessions.length, 129);
  next.sessions.pop(); assert.equal((await loader.resolve(snapshot(), 1, never, current)).sessions.length, 129);
  await loader.resolve(snapshot(), 2, fetch, current); assert.equal(paths.length, 6);
  const changed = snapshot(); asRecord(changed.sessionCatalog).digest = '0xdef';
  await loader.resolve(changed, 2, async path => { paths.push(path); return page(offset(path), all, '0xdef'); }, current);
  assert.equal(paths.length, 9);
  const reduced = snapshot(false, 128);
  await loader.resolve(reduced, 2, async path => { paths.push(path); return page(offset(path), all.slice(0, 128)); }, current);
  assert.equal(paths.length, 11);
  loader.clear(); await loader.resolve(snapshot(), 2, fetch, current); assert.equal(paths.length, 14);
  const other = snapshot(); other.owner = '~nec'; asRecord(other.sessionCatalog).owner = '~nec';
  const foreignRows = all.map(r => ({...r, source: {...asRecord(r.source), owner: '~nec'}}));
  await loader.resolve(other, 2, async path => { paths.push(path); return {...page(offset(path), foreignRows), owner: '~nec'}; }, current);
  assert.equal(paths.length, 17);
});

test('full metadata and legacy snapshots require no page fetch; pagination cannot invent connection readiness', async () => {
  const loader = new CodingSessionCatalog();
  assert.equal((await loader.resolve(snapshot(true), 1, never, current)).sessions.length, 129);
  const detached = snapshot(); detached.sessionCatalogReady = false;
  assert.equal((await loader.resolve(detached, 1, never, current)).ready, false);
  const legacy = snapshot(true); delete legacy.sessionCatalog; delete legacy.sessionCatalogReady;
  assert.equal(await loader.resolve(legacy, 1, never, current), legacy);
  const empty = snapshot(true, 0); assert.equal((await loader.resolve(empty, 1, never, current)).sessions.length, 0);
});

test('metadata mismatches and unavailable observations never produce an empty successful catalog', async () => {
  for (const patch of [{schema: 'future'}, {owner: '~nec'}, {total: 513}, {total: 128}, {digest: '0x0123'}, {permissionGranted: true},
    {complete: false}, {error: 'unexpected'}, {endpoint: 'https://foreign.invalid'}]) {
    const s = snapshot(true); s.sessionCatalog = {...asRecord(s.sessionCatalog), ...patch};
    await assert.rejects(new CodingSessionCatalog().resolve(s, 1, never, current), CodingCatalogError);
  }
  const unavailable = snapshot(); asRecord(unavailable.sessionCatalog).available = false;
  await assert.rejects(new CodingSessionCatalog().resolve(unavailable, 1, never, current), {code: 'catalogUnavailable'});
  const absent = snapshot(); delete absent.sessionCatalogReady;
  await assert.rejects(new CodingSessionCatalog().resolve(absent, 1, never, current), CodingCatalogError);
});

test('invalid rows, repeated pages, changed IDs and early termination refuse the whole catalog without caching partial data', async () => {
  const faults: ((value: JsonObject) => JsonObject)[] = [
    p => ({...p, owner: '~nec'}), p => ({...p, permissionGranted: true}), p => ({...p, sessions: []}),
    p => ({...p, extra: 'x'.repeat(524288)}),
    p => ({...p, catalog: {...asRecord(p.catalog), next: null}}), p => ({...p, catalog: {...asRecord(p.catalog), offset: 0}}),
    p => ({...p, catalog: {...asRecord(p.catalog), digest: '0xdef'}}),
    p => ({...p, sessionIds: [...all.slice(0, 128).map(r => r.id), '0x82']}),
    p => ({...p, sessions: [all[0], ...(p.sessions as JsonObject[]).slice(1)]}),
    p => ({...p, sessions: [{...asRecord((p.sessions as JsonObject[])[0]), source: {...asRecord(all[0].source), owner: '~nec'}}, ...(p.sessions as JsonObject[]).slice(1)]}),
    p => ({...p, sessions: [{...asRecord((p.sessions as JsonObject[])[0]), records: ['private']}, ...(p.sessions as JsonObject[]).slice(1)]})
  ];
  for (const fault of faults) {
    const loader = new CodingSessionCatalog(); let count = 0;
    await assert.rejects(loader.resolve(snapshot(), 1, async path => { count++; return offset(path) === 0 ? page(0) : fault(page(64)); }, current), CodingCatalogError);
    assert.equal(count, 2); count = 0;
    await loader.resolve(snapshot(), 1, async path => { count++; return page(offset(path)); }, current);
    assert.equal(count, 3);
  }
});

test('stale catalog and changed request generation stop without retry or cache promotion', async () => {
  const loader = new CodingSessionCatalog(); let calls = 0;
  await assert.rejects(loader.resolve(snapshot(), 1, async () => { calls++; return {schema: SCHEMA, owner: '~zod', available: false,
    permissionGranted: false, error: 'coding-catalog-stale'}; }, current), {code: 'catalogChanged'});
  assert.equal(calls, 1);
  let active = true;
  await assert.rejects(loader.resolve(snapshot(), 1, async () => { active = false; return page(0); }, () => { if (!active) throw new Error('changed'); }), /changed/);
  calls = 0; await loader.resolve(snapshot(), 1, async path => { calls++; return page(offset(path)); }, current); assert.equal(calls, 3);
});

test('ShipClient selects and sends from a later-page session, reuses complete pages, and clears cache on sign-in', async () => {
  const seen: string[] = []; let actions = 0;
  const server = http.createServer((req, res) => {
    seen.push(req.url!);
    if (req.url === '/~/login') { res.setHeader('Set-Cookie', 'urbauth-~zod=catalog; Path=/'); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/apps/pataphor-native/coding/sessions?')) { res.end(JSON.stringify(page(offset(req.url)))); return; }
    if (req.method === 'POST') { actions++; res.end(JSON.stringify({...snapshot(), nonce: '0v2'})); return; }
    res.end(JSON.stringify(snapshot()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new ShipClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async () => 'test');
  try {
    await client.signIn(); const selected = await client.codingState('0x81');
    assert.equal(selected.ready, true); assert.equal(selected.sessions.length, 129);
    await client.codingTool('0x81', '0xabc', '/list /'); assert.equal(actions, 1);
    await client.codingState('0x81'); assert.equal(seen.filter(p => p.includes('/sessions?')).length, 3);
    await client.signIn(); await client.codingState('0x81'); assert.equal(seen.filter(p => p.includes('/sessions?')).length, 6);
    assert.ok(Object.isFrozen(client.snapshot?.sessions));
  } finally { client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('ShipClient never exposes partial pages or permits a write when the complete catalog is stale', async () => {
  let actions = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/~/login') { res.setHeader('Set-Cookie', 'urbauth-~zod=catalog; Path=/'); res.end(); return; }
    if (req.method === 'POST') actions++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url?.includes('/sessions?') ? {schema: SCHEMA, owner: '~zod', available: false,
      permissionGranted: false, error: 'coding-catalog-stale'} : snapshot()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new ShipClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async () => 'test');
  try {
    await client.signIn(); await assert.rejects(client.codingState('0x81'), (e: unknown) => e instanceof ShipClientError && e.code === 'catalogChanged');
    assert.equal(client.snapshot, undefined); await assert.rejects(client.codingTool('0x81', '0xabc', '/list /'));
    assert.equal(actions, 0);
  } finally { client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
