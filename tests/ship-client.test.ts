import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { ShipClient, ShipClientError, OutcomeUnknownError } from '../src/ship-client';
import { asRecord, codingSnapshot, exactUTF8, isInteger, isUv, isUx, validUnicode, type JsonObject } from '../src/protocol';

type Captured = { method: string; url: string; cookie?: string; nonce?: string; body: string; headers: http.IncomingHttpHeaders };
type Step = (request: Captured, response: http.ServerResponse) => void;
class Fixture {
  readonly steps: Step[] = [];
  readonly captured: Captured[] = [];
  readonly server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const row = { method: request.method!, url: request.url!, cookie: request.headers.cookie, headers: request.headers,
        nonce: request.headers['x-terminal-nonce'] as string | undefined, body: Buffer.concat(chunks).toString() };
      this.captured.push(row); const step = this.steps.shift();
      if (!step) { response.writeHead(599); response.end(); return; } step(row, response);
    });
  });
  origin = '';
  async start(): Promise<this> {
    this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening');
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`; return this;
  }
  async stop(): Promise<void> { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server.close(() => resolve())); }
  json(value: unknown, status = 200): void { this.steps.push((_request, response) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); }); }
}
function snapshot(nonce = '0v1', session = '0x1', source = '0xabc'): JsonObject {
  return { nonce, cursor: '0x123', session, owner: '~zod', ready: true, after: 0, records: [], reviews: [],
    projects: [{ id: 'fixture', operations: ['list', 'read', 'replace'] }],
    sessions: [{ id: session, project: 'fixture', source: { id: source, owner: '~zod', desk: 'scratch', number: 1, root: '0v1', commit: '0v2' } }] };
}
function code(wanted: string): (error: unknown) => boolean { return error => error instanceof ShipClientError && error.code === wanted; }
async function fixture(run: (server: Fixture, client: ShipClient) => Promise<void>): Promise<void> {
  const server = await new Fixture().start(), client = new ShipClient(server.origin, async () => 'fixture+only&code');
  try { await run(server, client); assert.equal(server.steps.length, 0); } finally { client.close(); await server.stop(); }
}

test('project sharing sends exact owner protocol and recovers by GET without resubmission', async () => {
  await fixture(async (server, client) => {
    const command = { request: '01234567-89ab-4cde-8fab-0123456789ab', owner: '~zod', project: 'demo', peer: '~nec', expected: '0x123',
      operation: 'grant' as const, desk: 'demo-work', paths: '/lib/example/hoon', permission: 'view' as const };
    server.steps.push((_request, response) => { response.writeHead(200, { 'Set-Cookie': 'urbauth-~zod=sharing-session; Path=/' }); response.end(); });
    await client.signIn();
    server.json({ expected: '0x123' }); await client.projectSharing('read', { project: 'demo', peer: '~nec' });
    assert.equal(server.captured.at(-1)!.headers['x-readymade-project'], 'demo');
    assert.equal(server.captured.at(-1)!.headers['x-readymade-project-peer'], '~nec');
    server.json({ request: command.request, status: 'unconfirmed' }, 202);
    assert.equal((await client.projectSharing('submit', command)).status, 202);
    const sent = server.captured.at(-1)!;
    assert.equal(sent.method, 'POST'); assert.equal(sent.url, '/apps/readymade-collab/project-sharing');
    assert.equal(sent.cookie, 'urbauth-~zod=sharing-session'); assert.equal(sent.headers.origin, server.origin);
    assert.equal(sent.headers['x-readymade-project-sharing'], 'v1');
    assert.deepEqual(JSON.parse(sent.body), { schema: 'readymade-project-sharing-v1', ...command });
    await assert.rejects(client.projectSharing('submit', command), code('commandBusy'));
    server.json({ request: command.request, status: 'confirmed' });
    await client.projectSharing('result', { request: command.request });
    assert.equal(server.captured.at(-1)!.url, '/apps/readymade-collab/project-sharing-result');
    assert.equal(server.captured.at(-1)!.method, 'GET');
    assert.equal(server.captured.at(-1)!.headers['x-readymade-project-request'], command.request);
    const lost = { ...command, request: '11234567-89ab-4cde-8fab-0123456789ab' };
    server.steps.push((_request, response) => { response.socket!.destroy(); });
    await assert.rejects(client.projectSharing('submit', lost), OutcomeUnknownError);
    const count = server.captured.length;
    await assert.rejects(client.projectSharing('submit', lost), code('commandBusy'));
    assert.equal(server.captured.length, count);
    server.json({ status: 'missing' }, 404);
    assert.equal((await client.projectSharing('result', { request: lost.request })).status, 404);
    await assert.rejects(client.projectSharing('submit', lost), code('commandBusy'));
    const revoke = { request: '21234567-89ab-4cde-8fab-0123456789ab', owner: '~zod', project: 'demo', peer: '~nec', expected: '0x234', operation: 'revoke' as const, generation: '1.234' };
    server.json({ request: revoke.request, status: 'unconfirmed' }, 202);
    await client.projectSharing('submit', revoke);
    assert.deepEqual(JSON.parse(server.captured.at(-1)!.body), { schema: 'readymade-project-sharing-v1', ...revoke });
  });
});

test('project sharing rejects malformed selections before sending and bounds server responses', async () => {
  await fixture(async (server, client) => {
    const command = { request: '01234567-89ab-4cde-8fab-0123456789ab', owner: '~zod', project: 'demo', peer: '~nec', expected: '0x123', operation: 'grant' as const, desk: 'demo-work', paths: '/lib/example/hoon', permission: 'view' as const };
    for (const change of [{ peer: '~nec\r\nx:x' }, { paths: '/lib/example/hoon\n/lib/example/hoon' }, { paths: '/lib/../hoon' }, { paths: '/lib/example/js' }, { expected: '0x0123' }, { request: 'bad' }, { project: '' }, { unexpected: 'field' }]) {
      await assert.rejects(client.projectSharing('submit', { ...command, ...change }), code('contextChanged'));
    }
    for (const generation of ['0', '01', '1000', '18.446.744.073.709.551.616']) {
      await assert.rejects(client.projectSharing('submit', { request: command.request, owner: '~zod', project: 'demo', peer: '~nec', expected: '0x1', operation: 'revoke', generation }), code('contextChanged'));
    }
    await assert.rejects(client.projectSharing('result', { request: 'bad' }), code('contextChanged'));
    assert.equal(server.captured.length, 0);
    server.json({ oversized: 'x'.repeat(65536) });
    await assert.rejects(client.projectSharing('read', { project: 'demo', peer: '~nec' }), code('tooLarge'));
    server.steps.push((_request, response) => { response.writeHead(302, { Location: '/~/login' }); response.end(); });
    await assert.rejects(client.projectSharing('result', { request: command.request }), code('redirectRefused'));
    server.steps.push((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('[]'); });
    await assert.rejects(client.projectSharing('result', { request: command.request }), code('malformed'));
  });
});

test('workspace protocol preserves outcomes, exact headers and authenticated request bodies', async () => {
  await fixture(async (server, client) => {
    const key = { requester: '~zod', nonce: '01234567-89ab-4cde-8fab-0123456789ab' };
    server.steps.push((_request, response) => { response.writeHead(200, { 'Set-Cookie': 'urbauth-~zod=workspace-session; Path=/' }); response.end(); });
    await client.signIn();
    server.json({ catalog: '0x1' }); await client.workspaceRequest('catalog', {});
    assert.equal(server.captured.at(-1)!.headers['x-readymade-workspace-offset'], '0');
    server.json({ requests: [] }); await client.workspaceRequest('catalog', { offset: 64, catalog: '0x1' });
    assert.equal(server.captured.at(-1)!.headers['x-readymade-workspace-catalog'], '0x1');
    for (const operation of ['read', 'preview'] as const) {
      server.json({ observed: true }); await client.workspaceRequest(operation, key);
      const request = server.captured.at(-1)!;
      assert.equal(request.url, `/apps/readymade-collab/workspace-${operation === 'read' ? 'request' : operation}`);
      assert.equal(request.method, 'GET'); assert.equal(request.cookie, 'urbauth-~zod=workspace-session');
      assert.equal(request.headers['x-readymade-workspace-requester'], key.requester);
      assert.equal(request.headers['x-readymade-workspace-nonce'], key.nonce);
    }
    for (const status of [200, 202, 409]) {
      const params = { ...key, nonce: `${status}34567-89ab-4cde-8fab-0123456789ab`, requestDigest: '0xabc', scope: '0xdef' };
      const body = { status: status === 409 ? 'unknown' : 'submitted' };
      server.json(body, status); assert.deepEqual(await client.workspaceRequest('submit', params), { status, body });
      const request = server.captured.at(-1)!;
      assert.equal(request.url, '/apps/readymade-collab/workspace-submit'); assert.equal(request.method, 'POST');
      assert.equal(request.headers.origin, server.origin); assert.equal(request.headers['x-readymade-workspace'], 'v1');
      assert.equal(request.headers['x-readymade-workspace-nonce'], undefined);
      assert.deepEqual(JSON.parse(request.body), { schema: 'readymade-workspace-command-v1', operation: 'submit', ...params });
      await assert.rejects(client.workspaceRequest('submit', params), code('commandBusy'));
    }
    server.json({ status: 'unknown' }, 409); await client.workspaceRequest('recover', key);
    assert.deepEqual(JSON.parse(server.captured.at(-1)!.body), { schema: 'readymade-workspace-command-v1', operation: 'recover', ...key });
  });
});

test('workspace rejects unsafe parameters before sending and bounds observation responses', async () => {
  await fixture(async (server, client) => {
    const key = { requester: '~zod', nonce: '01234567-89ab-4cde-8fab-0123456789ab' };
    for (const params of [{ offset: -1 }, { offset: 512 }, { offset: 64 }, { catalog: '0x0' }, { catalog: '0x01' }, { headers: {} }]) {
      await assert.rejects(client.workspaceRequest('catalog', params), code('contextChanged'));
    }
    for (const params of [{ ...key, requester: '~zod\r\nx:x' }, { ...key, nonce: key.nonce.toUpperCase() }, { ...key, nonce: 'bad' },
      { ...key, requestDigest: '0x0', scope: '0x1' }, { ...key, requestDigest: '0x1', scope: '0x' + 'ffff.'.repeat(16) + 'ffff' }]) {
      await assert.rejects(client.workspaceRequest('submit', params as typeof key & { requestDigest: string; scope: string }), code('contextChanged'));
    }
    assert.equal(server.captured.length, 0);
    server.json({ oversized: 'x'.repeat(65536) }); await assert.rejects(client.workspaceRequest('read', key), code('tooLarge'));
    server.steps.push((_request, response) => { response.writeHead(302, { Location: '/~/login' }); response.end(); });
    await assert.rejects(client.workspaceRequest('read', key), code('redirectRefused'));
    server.steps.push((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('[]'); });
    await assert.rejects(client.workspaceRequest('read', key), code('malformed'));
  });
});

test('workspace lost submit blocks its identity while recovery stays available without resubmission', async () => {
  await fixture(async (server, client) => {
    const key = { requester: '~zod', nonce: '01234567-89ab-4cde-8fab-0123456789ab' };
    const params = { ...key, requestDigest: '0x1', scope: '0x2' };
    server.steps.push((_request, response) => { response.socket!.destroy(); });
    await assert.rejects(client.workspaceRequest('submit', params), OutcomeUnknownError);
    const count = server.captured.length;
    await assert.rejects(client.workspaceRequest('submit', { ...params, scope: '0x3' }), code('commandBusy'));
    assert.equal(server.captured.length, count);
    server.json({ status: 'unknown' }, 409); assert.equal((await client.workspaceRequest('recover', key)).status, 409);
    assert.equal(server.captured.at(-1)!.url, '/apps/readymade-collab/workspace-recover');
    await assert.rejects(client.workspaceRequest('submit', params), code('commandBusy'));
    server.steps.push((_request, response) => { response.writeHead(403); response.end(); });
    const other = { ...params, nonce: '11234567-89ab-4cde-8fab-0123456789ab' };
    await assert.rejects(client.workspaceRequest('submit', other), code('authenticationRequired'));
    server.json({ status: 'refused' }, 409); assert.equal((await client.workspaceRequest('submit', other)).status, 409);
  });
});

test('workspace submission tombstones are independent of generic unknown limits and never evicted after recovery', async () => {
  await fixture(async (server, client) => {
    const params = (n: number) => ({requester: '~zod', nonce: `01234567-89ab-4cde-8fab-${n.toString(16).padStart(12, '0')}`, requestDigest: '0x1', scope: '0x2'});
    for (let n = 0; n < 512; n++) {
      server.json({status: n === 1 ? 'recorded' : n === 2 ? 'refused' : 'submitted'}, n === 2 ? 409 : n > 2 ? 202 : 200);
      await client.workspaceRequest('submit', params(n));
      if (n === 16) {
        server.json({status: 'recorded'}); await client.workspaceRequest('recover', {requester: '~zod', nonce: params(0).nonce});
        await assert.rejects(client.workspaceRequest('submit', params(0)), code('commandBusy'));
        server.json({accepted: true}); await client.requestJSON('/apps/x', {method: 'POST', body: {id: 'independent'}});
        for (let i = 0; i < 16; i++) {
          server.steps.push((_request, response) => response.socket!.destroy());
          await assert.rejects(client.requestJSON('/apps/x', {method: 'POST', body: {id: `unknown-${i}`}}), OutcomeUnknownError);
        }
      }
    }
    const count = server.captured.length;
    for (const n of [0, 1, 2, 512]) await assert.rejects(client.workspaceRequest('submit', params(n)), code('commandBusy'));
    assert.equal(server.captured.length, count);
    await assert.rejects(client.requestJSON('/apps/x', {method: 'POST', body: {id: 'generic-still-bounded'}}), code('commandBusy'));
    server.json({status: 'recorded'}); await client.workspaceRequest('recover', {requester: '~zod', nonce: params(511).nonce});
  });
});

test('strict origins, paths, identifier/number/Unicode helpers never submit unsafe requests', async () => {
  for (const raw of ['http://example.org', 'https://name:secret@example.org', 'https://@example.org', 'https://example.org/apps/..',
    'https://example.org/?x', 'https://example.org#', 'https://example.org?', 'https://example.org:0', 'file:///tmp', 'https://example.org\\']) {
    assert.throws(() => new ShipClient(raw), code('invalidOrigin'));
  }
  for (const raw of ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080', 'https://SHIP.EXAMPLE:443/']) {
    const client = new ShipClient(raw); assert.ok(!client.origin.endsWith('/')); client.close();
  }
  assert.equal(isUx('0x1.abcd'), true); assert.equal(isUx('0xAB'), false); assert.equal(isUx('0x00001'), false);
  assert.equal(isUv('0v1.abcde'), true); assert.equal(isUv('0vabcdez'), false);
  for (const value of [true, '1', NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(isInteger(value), false);
  assert.equal(exactUTF8('é', 'e\u0301'), false); assert.equal(exactUTF8('a\r\n🦕', 'a\r\n🦕'), true);
  assert.equal(validUnicode('\ud800'), false); assert.equal(validUnicode('🦕'), true); assert.equal(exactUTF8('\ud800', '\ufffd'), false);
  for (const invalid of [{ ...snapshot(), after: true }, { ...snapshot(), records: [false] }, { ...snapshot(), ready: 1 }]) assert.throws(() => codingSnapshot(invalid));
  assert.throws(() => asRecord([]));
  await fixture(async (server, client) => {
    for (const path of ['https://other.example/apps/x', '//other.example/apps/x', '/~/login', '/apps/../x', '/apps/%2e%2e/x',
      '/apps/x/%2fsecret', '/apps/x\\y', '/apps/x#fragment', '/apps/x\n', '/apps/pataphor-native/coding/action',
      '/apps/%70ataphor-native/coding/action', '/apps//pataphor-native/coding/action']) {
      await assert.rejects(client.requestJSON(path), code('contextChanged'));
    }
    await assert.rejects(client.requestJSON('/apps/x', { body: {} }), code('contextChanged'));
    await assert.rejects(client.requestJSON('/apps/x', { method: 'POST' }), code('contextChanged'));
    await assert.rejects(client.requestJSON('/apps/x', { method: 'POST', body: { number: NaN } }), code('malformed'));
    await assert.rejects(client.requestJSON('/apps/x', { timeoutMs: 0 }), code('contextChanged'));
    await assert.rejects(client.requestJSON('/apps/x', { method: 'POST', body: {}, terminalNonce: '0v1' }), code('contextChanged'));
    assert.equal(server.captured.length, 0);
    server.json({ scry: true }); assert.equal((await client.requestJSON('/~/scry/viki/x/status.json')).scry, true);
  });
});

test('authentication is exact-origin, encoded, memory-only and never follows redirects', async () => {
  await fixture(async (server, client) => {
    server.steps.push((request, response) => {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/~/login'); assert.equal(request.body, 'password=fixture%2Bonly%26code');
      response.writeHead(302, { Location: '/', 'Set-Cookie': ['foreign=ignored; Path=/', 'urbauth-~zod=fixture-session; Path=/; HttpOnly'] }); response.end();
    });
    await client.signIn(); assert.equal(server.captured.length, 1);
    server.steps.push((request, response) => { assert.equal(request.cookie, 'urbauth-~zod=fixture-session'); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); });
    await client.workspaceState(); assert.equal(server.captured[1]!.url, '/apps/pataphor/remote/state.json');
    server.steps.push((_request, response) => { response.writeHead(302, { Location: 'https://foreign.example/', 'Set-Cookie': 'urbauth-~zod=private; Path=/' }); response.end(); });
    await assert.rejects(client.signIn(), code('redirectRefused'));
    server.steps.push((request, response) => { assert.equal(request.cookie, undefined); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); });
    await client.workspaceState();
    server.steps.push((_request, response) => { response.writeHead(200, { 'Set-Cookie': 'urbauth-~zod=private; Path=/' }); response.end(); });
    const beforeLogin = server.captured.length; await client.signIn(); assert.equal(server.captured.length, beforeLogin + 1);
    server.steps.push((request, response) => { assert.equal(request.cookie, 'urbauth-~zod=private'); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); });
    await client.workspaceState();
    for (const cookie of ['urbauth-~zod=private; Domain=foreign.example; Path=/', 'urbauth-~zod=private; Path=/other', 'urbauth-~zod=private; Path=/; Max-Age=0']) {
      server.steps.push((_request, response) => { response.writeHead(302, { Location: '/', 'Set-Cookie': cookie }); response.end(); });
      await assert.rejects(client.signIn(), code('authenticationRequired'));
    }
  });
  const missing = new ShipClient('https://ship.example', async () => undefined);
  await assert.rejects(missing.signIn(), code('noSavedCode')); missing.close();
});

test('coding observed source/nonce guard, immutable state, no retry, and deliberate fresh-token admission', async () => {
  await fixture(async (server, client) => {
    server.json(snapshot()); const first = await client.codingState('0x1');
    assert.equal(server.captured[0]!.url, '/apps/pataphor-native/coding/state?0x1&0&0x0');
    assert.throws(() => { first.nonce = '0v9'; });
    await assert.rejects(client.codingTool('0x1', '0xdef', '/list / 0 64'), code('contextChanged'));
    await assert.rejects(client.codingTool('0x1', '0xabc', '🦕'.repeat(17000)), code('tooLarge'));
    assert.equal(server.captured.length, 1);
    server.steps.push((request, response) => {
      assert.deepEqual(JSON.parse(request.body) as unknown, { kind: 'terminal', session: '0x1', source: '0xabc', input: '/list / 0 64', nonce: '0v1' });
      response.socket!.destroy();
    });
    await assert.rejects(client.codingTool('0x1', '0xabc', '/list / 0 64'), OutcomeUnknownError);
    await assert.rejects(client.codingTool('0x1', '0xabc', '/list / 0 64'), code('commandBusy'));
    server.json(snapshot()); await client.codingState('0x1');
    await assert.rejects(client.codingTool('0x1', '0xabc', '/list / 0 64'), code('commandBusy'));
    server.json(snapshot('0v2')); await client.codingState('0x1');
    server.json({ error: 'private refused body' }, 409);
    await assert.rejects(client.codingTool('0x1', '0xabc', '/list / 0 64'), error => code('refused')(error) && !String(error).includes('private'));
    const accepted = { ...snapshot('0v3'), commandReceipt: { request: '0x55' } }; server.json(accepted);
    const reply = await client.codingTool('0x1', '0xabc', '/list / 0 64');
    assert.deepEqual(reply.commandReceipt, { request: '0x55' }); assert.equal(client.snapshot!.nonce, '0v3');
    server.json(snapshot('0v1')); await client.codingState('0x1');
    await assert.rejects(client.codingTool('0x1', '0xabc', '/list / 0 64'), code('commandBusy'));
  });
});

test('late state replies cannot switch selection; in-flight command results are never replayed', async () => {
  await fixture(async (server, client) => {
    let release: (() => void) | undefined;
    server.json(snapshot('0v1', '0x2')); await client.codingState('0x2');
    server.steps.push((_request, response) => { release = () => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(snapshot('0v1'))); }; });
    const old = client.codingState('0x1'); const oldRejected = assert.rejects(old, code('contextChanged'));
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(client.codingTool('0x2', '0xabc', '/list / 0 64'), code('contextChanged'));
    server.json(snapshot('0v2', '0x2')); await client.codingState('0x2'); release(); await oldRejected;
    assert.equal(client.snapshot!.session, '0x2');
    server.steps.push((_request, response) => { release = () => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(snapshot('0v3', '0x2'))); }; });
    release = undefined;
    const command = client.codingTool('0x2', '0xabc', '/list / 0 64');
    const unknown = assert.rejects(command, OutcomeUnknownError);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(client.requestJSON('/apps/x', { method: 'POST', body: { id: '0x1' } }), code('commandBusy'));
    server.json(snapshot('0v4', '0x1')); await client.codingState('0x1'); (release as () => void)(); await unknown;
    assert.equal(client.snapshot!.session, '0x1');
  });
});

test('generic terminal unknown packet identity, attach is read-only recovery, receipt GET remains usable', async () => {
  await fixture(async (server, client) => {
    const path = '/apps/pataphor-terminal/action', options = { method: 'POST' as const, terminalNonce: '0v1', body: { kind: 1, generation: 2, sequence: 3, controlRevision: 4, input: 'fixture' } };
    server.steps.push((request, response) => { assert.equal(request.nonce, '0v1'); response.socket!.destroy(); });
    await assert.rejects(client.requestJSON(path, options), OutcomeUnknownError);
    await assert.rejects(client.requestJSON(path, { ...options, body: { ...options.body, input: 'changed' } }), code('commandBusy'));
    server.json({ receipt: 'unknown' }); assert.equal((await client.requestJSON('/apps/pataphor/remote/receipt.json?id=0x1')).receipt, 'unknown');
    server.steps.push((_request, response) => response.socket!.destroy());
    const attach = { ...options, body: { ...options.body, kind: 6 } };
    await assert.rejects(client.requestJSON(path, attach), code('transport'));
    server.json({ attached: true }); await client.requestJSON(path, attach);
    server.steps.push((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('not json private'); });
    await assert.rejects(client.requestJSON('/apps/x', { method: 'POST', body: { id: 'same' } }), OutcomeUnknownError);
    await assert.rejects(client.requestJSON('/apps/x', { method: 'POST', body: { id: 'same', changed: true } }), code('commandBusy'));
  });
});

test('connector source transport refusal is distinct from authentication and never exposes server details', async () => {
  await fixture(async (server, client) => {
    const path = '/apps/pataphor-cli/source';
    server.json({status: 'secure-transport-required'}, 403);
    await assert.rejects(client.requestJSON(path), code('secureTransportRequired'));
    for (const body of [{status: 'owner-required'}, {status: 'secure-transport-required', private: 'secret'}, ['secure-transport-required']]) {
      server.json(body, 403);
      await assert.rejects(client.requestJSON(path), code('authenticationRequired'));
    }
    server.json({status: 'secure-transport-required'}, 401);
    await assert.rejects(client.requestJSON(path), code('authenticationRequired'));
    server.json({status: 'secure-transport-required'}, 403);
    await assert.rejects(client.workspaceState(), code('authenticationRequired'));
    for (const [type, body] of [['text/html', '{"status":"secure-transport-required"}'], ['application/json', 'private broken JSON']]) {
      server.steps.push((_request, response) => {response.writeHead(403, {'Content-Type': type}); response.end(body);});
      await assert.rejects(client.requestJSON(path), code('authenticationRequired'));
    }
    assert.equal(server.captured.length, 8, 'No automatic retry');
  });
});

test('bounded strict JSON, redirect refusal, cancellation, absolute timeout and close', async () => {
  await fixture(async (server, client) => {
    for (const raw of ['{"number":1e309}', '{"number":9007199254740993}', '[1]', '{"value":"\\ud800"}']) {
      server.steps.push((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(raw); });
      await assert.rejects(client.workspaceState(), code('malformed'));
    }
    server.steps.push((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(Buffer.from([0xff])); });
    await assert.rejects(client.workspaceState(), code('malformed'));
    server.steps.push((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 4194305 }); response.end(); });
    await assert.rejects(client.workspaceState(), code('tooLarge'));
    server.steps.push((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(' '.repeat(4194305)); });
    await assert.rejects(client.workspaceState(), code('tooLarge'));
    for (const [location, error] of [['/~/login?redirect=x', 'authenticationRequired'], ['https://foreign.example/apps/x', 'redirectRefused']]) {
      server.steps.push((_request, response) => { response.writeHead(302, { Location: location }); response.end(); });
      await assert.rejects(client.workspaceState(), code(error!));
    }
    const abort = new AbortController(); abort.abort(); const count = server.captured.length;
    await assert.rejects(client.requestJSON('/apps/x', { method: 'POST', body: { id: 'cancel' }, signal: abort.signal }), code('cancelledBeforeSend'));
    assert.equal(server.captured.length, count);
    server.steps.push(() => {}); await assert.rejects(client.requestJSON('/apps/x', { timeoutMs: 20 }), code('transport'));
    server.steps.push(() => {}); const reading = client.workspaceState(); const closed = assert.rejects(reading, code('transport'));
    while (server.steps.length) await new Promise(resolve => setImmediate(resolve)); client.close(); await closed;
    await assert.rejects(client.workspaceState(), code('closed'));
  });
});

test('actual 45-second quiet GET expiry is distinct; ordinary GET failures and POST timeouts remain unchanged', { timeout: 55000 }, async () => {
  await fixture(async (server, client) => {
    server.steps.push(() => {});
    const started = Date.now();
    await assert.rejects(client.requestJSON('/apps/pataphor-terminal/events?offset=0&cursor=0v1', { timeoutMs: 45000 }), code('pollExpired'));
    assert.ok(Date.now() - started >= 44000); assert.equal(server.captured.length, 1);
    server.steps.push(() => {});
    await assert.rejects(client.requestJSON('/apps/pataphor/remote/submit', { method: 'POST', body: { id: 'fixture-timeout' }, timeoutMs: 1000 }), OutcomeUnknownError);
    assert.equal(server.captured.length, 2);
    await assert.rejects(client.requestJSON('/apps/pataphor/remote/submit', { method: 'POST', body: { id: 'fixture-timeout' } }), code('commandBusy'));
    assert.equal(server.captured.length, 2);
  });
});

test('trusted browser cookie export is exact-origin, session-only, immutable and expires without exporting access codes', async () => {
  await fixture(async (server, client) => {
    assert.throws(() => client.browserCookies(server.origin), code('authenticationRequired'));
    server.steps.push((_request, response) => { response.writeHead(200, { 'Set-Cookie': 'urbauth-~zod=browser-session; Path=/; HttpOnly; Max-Age=1' }); response.end(); });
    await client.signIn();
    const cookies = client.browserCookies(server.origin);
    assert.deepEqual(cookies.map(cookie => ({ name: cookie.name, value: cookie.value })), [{ name: 'urbauth-~zod', value: 'browser-session' }]);
    assert.ok(cookies[0]!.expires! > Date.now() / 1000 && cookies[0]!.expires! < Date.now() / 1000 + 2);
    assert.ok(!JSON.stringify(cookies).includes('fixture+only&code'));
    assert.throws(() => { (cookies as unknown as { name: string }[]).push({ name: 'injected' }); });
    assert.throws(() => { (cookies[0] as { value: string }).value = 'changed'; });
    assert.throws(() => client.browserCookies(server.origin + '/'), code('contextChanged'));
    assert.throws(() => client.browserCookies('https://elsewhere.example'), code('contextChanged'));
    await new Promise(resolve => setTimeout(resolve, 1100)); assert.throws(() => client.browserCookies(server.origin), code('authenticationRequired'));
    server.steps.push((_request, response) => { response.writeHead(200, { 'Set-Cookie': 'urbauth-~zod=session-cookie; Path=/; HttpOnly' }); response.end(); });
    await client.signIn(); assert.equal(client.browserCookies(server.origin)[0]!.expires, undefined);
    client.close(); assert.throws(() => client.browserCookies(server.origin), code('closed'));
  });
});
