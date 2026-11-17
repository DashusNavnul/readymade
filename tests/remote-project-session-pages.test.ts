import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {ShipClient, OutcomeUnknownError} from '../src/ship-client';
import {SharedSessionPages, SessionPageError, sessionPageReply, sessionPageSelector, sessionPageHeaders,
  type SessionPageSelector, type SessionPageClient} from '../src/remote-project-session-pages';

const target = {owner: '~zod', project: 'café-共同'}, peer = '~nec';
const first: SessionPageSelector = {...target, request: '0x1', offset: 0, grantCatalog: '0x0'};
const row = (inspection = '0x1') => ({id: '0x5', inspection, phase: 'ready', working: {ship: '~zod', desk: 'work', revision: '1', root: '0v1', commit: '0v0'}});
function ready(s: SessionPageSelector, total = 65, sessions: unknown[] = [], catalog = '0xabc') {
  const examined = Math.min(64, total - s.offset);
  return {schema: 'readymade-project-session-page-result-v2', owner: s.owner, project: s.project, request: s.request, peer,
    offset: s.offset, expectedGrantCatalog: s.grantCatalog, status: 'ready', reason: 'observed', deadline: '~2026.11.13..05.00.30',
    retainedUntil: '~2026.11.13..05.05.30', permissionGranted: false,
    observation: {owner: s.owner, peer, observedAt: '~2026.11.13..05.00.01', catalogKind: 'standing-grants', grantCatalog: catalog,
      totalGrants: total, examined, offset: s.offset, nextOffset: s.offset + examined === total ? null : s.offset + examined, sessions}};
}
const decode = (s: SessionPageSelector, body = ready(s)) => sessionPageReply(200, body, s, peer, true);
const noop = () => {};
const wait = async () => {};

test('v2 admits empty advancing pages, exact source-bound rows and immutable observations', () => {
  const r = decode(first); assert.equal(r.observation?.nextOffset, 64); assert.deepEqual(r.observation?.sessions, []);
  const last = {...first, request: '0x2', offset: 64, grantCatalog: '0xabc'}, body = ready(last, 65, [row()]);
  const result = decode(last, body); assert.equal(result.observation?.nextOffset, null);
  body.observation.sessions.length = 0; assert.equal(result.observation?.sessions.length, 1);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.observation) && Object.isFrozen(result.observation?.sessions[0].working));
  assert.equal(decode(first, ready(first, 0)).observation?.totalGrants, 0);
  const headers = sessionPageHeaders(last);
  assert.equal(headers['x-readymade-session-offset'], '64'); assert.equal(headers['x-readymade-grant-catalog'], '0xabc');
  assert.equal(Buffer.from(headers['x-readymade-project'], 'latin1').toString('utf8'), target.project);
});

test('cursor, count, identity, source and permission mismatches never become pages', () => {
  for (const patch of [{offset: 512}, {offset: -1}, {offset: 1.5}, {offset: '1'}, {offset: 64}, {grantCatalog: '0x00'}, {request: '0x0'}, {grantCatalog: '0x1' + '.0000'.repeat(16)}])
    assert.throws(() => sessionPageSelector({...first, ...patch}));
  for (const patch of [{schema: 'readymade-project-sessions-result-v1'}, {peer: '~wes'}, {request: '0x2'}, {project: 'other'}, {offset: 64}, {expectedGrantCatalog: '0x2'}, {permissionGranted: true}, {extra: 1}])
    assert.throws(() => decode(first, {...ready(first), ...patch}));
  for (const patch of [{totalGrants: 513}, {totalGrants: -1}, {examined: 0}, {examined: 63}, {offset: 1}, {nextOffset: null}, {nextOffset: 0},
    {grantCatalog: '0x0'}, {catalogKind: 'sessions'}, {owner: '~wes'}, {peer: '~wes'}, {extra: 1}, {sessions: [row(), row()]},
    {sessions: [{...row(), working: {...row().working, ship: '~wes'}}]}, {sessions: [{...row(), transcript: 'private'}]}])
    assert.throws(() => decode(first, {...ready(first), observation: {...ready(first).observation, ...patch}}));
  const next = {...first, offset: 64, grantCatalog: '0xabc'};
  assert.throws(() => decode(next, ready(next, 65, [], '0xdef')));
  assert.throws(() => decode(first, {...ready(first), observation: {...ready(first).observation, sessions: [row('0x2')], examined: 1}}));
  assert.throws(() => sessionPageReply(202, ready(first), first, peer, false));
});

test('missing and expired are exact observations only; no legacy response is accepted', () => {
  for (const [status, message, result] of [[404, 'Page not retained; no retry was issued.', 'missing'], [410, 'Historical page expired.', 'expired']] as const) {
    const body = {status: status === 404 ? 'unknown' : 'expired', message};
    assert.equal(sessionPageReply(status, body, first, peer, true).status, result);
    assert.throws(() => sessionPageReply(status, body, first, peer, false));
    assert.throws(() => sessionPageReply(status, {...body, message: 'List not retained; no retry was issued.'}, first, peer, true));
  }
});

test('all 512 grants are examined even when seven pages are empty', async () => {
  const selectors: SessionPageSelector[] = [];
  const client: SessionPageClient = {projectSessionPageScope: () => 'one', projectSessionPageResult: async () => {throw Error('unexpected GET');},
    projectSessionPageSubmit: async s => {selectors.push(s); return decode(s, ready(s, 512, s.offset === 448 ? [row()] : []));}};
  const read = new SharedSessionPages(client, target, peer); await read.observe(noop, wait);
  assert.equal(read.complete, true); assert.equal(read.resumable, false); assert.equal(selectors.length, 8);
  assert.deepEqual(selectors.map(s => s.offset), [0, 64, 128, 192, 256, 320, 384, 448]);
  assert.equal(new Set(selectors.map(s => s.request)).size, 8);
  assert.ok(selectors.slice(1).every(s => s.grantCatalog === '0xabc'));
  assert.equal(read.rows().filter(r => r.label === '0x5').length, 1); assert.match(read.note, /512 sharing grants examined/);
  await read.observe(noop, wait); assert.equal(selectors.length, 8);
});

test('partial observations stay incomplete; changed grant totals and repeated inspections stop traversal', async () => {
  for (const bad of ['total', 'duplicate', 'connection'] as const) {
    let scope = 'one', calls = 0;
    const client: SessionPageClient = {projectSessionPageScope: () => scope, projectSessionPageResult: async () => {throw Error('unexpected GET');},
      projectSessionPageSubmit: async s => {calls++; if (calls === 2 && bad === 'connection') scope = 'two';
        return decode(s, ready(s, calls === 2 && bad === 'total' ? 66 : 65, [row()]));}};
    const read = new SharedSessionPages(client, target, peer);
    await assert.rejects(read.observe(noop, wait), SessionPageError);
    assert.equal(read.complete, false); assert.equal(read.resumable, false); assert.equal(calls, 2);
    assert.equal(read.rows().filter(r => r.label === '0x5').length, 1);
  }
});

test('a zero time budget does not submit or claim an empty complete catalog', async () => {
  const client: SessionPageClient = {projectSessionPageScope: () => 'one', projectSessionPageResult: async () => {throw Error('GET');}, projectSessionPageSubmit: async () => {throw Error('POST');}};
  const read = new SharedSessionPages(client, target, peer); await read.observe(noop, wait, 0);
  assert.equal(read.complete, false); assert.equal(read.resumable, true); assert.match(read.note, /Incomplete/);
  assert.ok(read.rows().every(r => !r.label.startsWith('No sessions')));
});

type Capture = {method: string; url: string; headers: http.IncomingHttpHeaders; body: string};
type Step = (capture: Capture, response: http.ServerResponse) => void;
function json(r: http.ServerResponse, body: unknown, status = 200): void {r.writeHead(status, {'content-type': 'application/json'}); r.end(JSON.stringify(body));}
async function fixture(run: (client: ShipClient, steps: Step[], captures: Capture[]) => Promise<void>): Promise<void> {
  const steps: Step[] = [], captures: Capture[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk)); req.on('end', () => {
      const c = {method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString()}; captures.push(c);
      const step = steps.shift(); if (step) step(c, res); else {res.writeHead(599); res.end();}
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new ShipClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async () => 'fixture');
  try {
    steps.push((_c, r) => {r.writeHead(200, {'set-cookie': 'urbauth-~nec=fixture; Path=/'}); r.end();}); await client.signIn();
    await run(client, steps, captures); assert.equal(steps.length, 0);
  } finally {client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
}

test('a dropped POST recovers its exact nonce by GET and continues from an empty page without resending', () => fixture(async (client, steps, captures) => {
  let selected!: SessionPageSelector;
  steps.push((c, r) => {const {schema, ...body} = JSON.parse(c.body); assert.equal(schema, 'readymade-project-session-page-v2');
    selected = sessionPageSelector({...body, offset: Number(body.offset)}); assert.equal(c.body.split(':').length - 1, 6); r.socket!.destroy();});
  const read = new SharedSessionPages(client, target, peer);
  await assert.rejects(read.observe(noop, wait), OutcomeUnknownError);
  assert.equal(read.resumable, true); assert.equal(read.complete, false);
  steps.push((c, r) => {
    assert.equal(c.method, 'GET'); assert.equal(c.headers['x-readymade-project-session-page-request'], selected.request);
    assert.equal(c.headers['x-readymade-session-offset'], '0'); assert.equal(c.headers['x-readymade-grant-catalog'], '0x0'); json(r, ready(selected));
  });
  steps.push((c, r) => {const {schema, ...body} = JSON.parse(c.body); assert.equal(schema, 'readymade-project-session-page-v2'); const next = sessionPageSelector({...body, offset: Number(body.offset)});
    assert.equal(next.offset, 64); assert.notEqual(next.request, selected.request); assert.equal(next.grantCatalog, '0xabc'); json(r, ready(next, 65, [row()]));});
  await read.observe(noop, wait); assert.equal(read.complete, true);
  const requests = captures.slice(1); assert.deepEqual(requests.map(c => c.method), ['POST', 'GET', 'POST']);
  assert.equal(requests[0].headers.origin, client.origin); assert.equal(requests[0].headers['x-readymade-project-session-pages'], 'v2');
  assert.equal(requests[0].headers.cookie, 'urbauth-~nec=fixture'); assert.equal(client.snapshot, undefined);
}));

test('old endpoint explicitly requires upgrade; no v1 fallback or second submission occurs', () => fixture(async (client, steps, captures) => {
  steps.push((_c, r) => {r.writeHead(404, {'content-type': 'text/html'}); r.end('missing');});
  const read = new SharedSessionPages(client, target, peer);
  await assert.rejects(read.observe(noop, wait), e => e instanceof SessionPageError && e.code === 'upgrade');
  assert.equal(read.resumable, false); assert.match(read.note, /Update this ship/);
  await read.observe(noop, wait); assert.equal(captures.length, 2);
  assert.equal(captures[1].url, '/apps/readymade-collab/project-session-pages');
}));

test('GET recovery does not cross reauthentication or silently accept a malformed page', () => fixture(async (client, steps) => {
  const read = new SharedSessionPages(client, target, peer);
  steps.push((_c, r) => r.socket!.destroy()); await assert.rejects(read.observe(noop, wait));
  steps.push((_c, r) => {r.writeHead(200, {'set-cookie': 'urbauth-~nec=new; Path=/'}); r.end();}); await client.signIn();
  await assert.rejects(read.observe(noop, wait), e => e instanceof SessionPageError && e.code === 'changed');
  assert.equal(read.resumable, false);
  steps.push((_c, r) => json(r, {...ready(first), expectedGrantCatalog: '0x2'}));
  await assert.rejects(client.projectSessionPageResult(first));
}));
