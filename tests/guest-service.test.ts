import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {ShipClient, ShipClientError, OutcomeUnknownError} from '../src/ship-client';
import {GUEST_DESK, GUEST_PIKES_PATH, GUEST_PROBE_PATH, GUEST_SOURCE, guestInstallActions, guestServiceDesk, guestServiceMessage, guestServiceProbe,
  guestServiceState} from '../src/guest-service';

const synced = (zest: string, ship = '~dashus-navnul', desk = 'readymade-peer') => ({sync: {ship, desk}, zest, wefts: [], hash: '0v1'});

test('the probe tells a bound agent from a missing binding and proves nothing otherwise', () => {
  // Measured on a real moon: the bound route answers a bare GET with 400 JSON; an unbound app is a bare 404.
  assert.equal(guestServiceProbe(400, {status: 'refused', message: 'Exact retained invitation page required.'}), 'present');
  assert.equal(guestServiceProbe(200, {}), 'present');
  assert.equal(guestServiceProbe(404, undefined), 'absent');
  assert.equal(guestServiceProbe(503, undefined), 'down'); // measured after the desk was suspended: an HTML 503
  assert.equal(guestServiceProbe(503, {}), 'unknown');
  for (const [status, body] of [[400, undefined], [400, []], [502, {}], [307, undefined], [500, {}]] as const) assert.equal(guestServiceProbe(status, body), 'unknown');
});

test('kiln desk lists decode strictly and map to one of four states', () => {
  assert.equal(guestServiceDesk({base: synced('live', '~zod', 'kids')}), null);
  assert.deepEqual(guestServiceDesk({[GUEST_DESK]: synced('live')}), {zest: 'live', source: GUEST_SOURCE});
  assert.deepEqual(guestServiceDesk({[GUEST_DESK]: {sync: null, zest: 'held', wefts: [], hash: '0v1'}}), {zest: 'held', source: null});
  for (const bad of [null, [], 'x', {[GUEST_DESK]: null}, {[GUEST_DESK]: {sync: null, zest: 'running'}}, {[GUEST_DESK]: synced('live', 'zod')},
    {[GUEST_DESK]: synced('live', '~zod', 'Bad Desk')}, {[GUEST_DESK]: {sync: 'x', zest: 'live'}}]) assert.throws(() => guestServiceDesk(bad), /unreadable desk list/);
  assert.deepEqual(guestServiceState('present', null), {status: 'ready', source: null});
  assert.equal(guestServiceState('absent', null).status, 'missing');
  assert.equal(guestServiceState('absent', {zest: 'live', source: GUEST_SOURCE}).status, 'starting');
  for (const zest of ['held', 'dead'] as const) assert.equal(guestServiceState('down', {zest, source: null}).status, 'suspended');
  assert.throws(() => guestServiceState('down', null), /another installation/);
  for (const status of ['ready', 'starting', 'suspended', 'missing'] as const) assert.match(guestServiceMessage({status, source: null}), /collaboration service/);
});

test('the install request is one kiln poke to the ship itself, naming the published source', () => {
  assert.deepEqual(guestInstallActions('~sampel-palnet'), [{id: 1, action: 'poke', ship: 'sampel-palnet', app: 'hood', mark: 'kiln-install',
    json: {local: 'readymade-peer', ship: '~dashus-navnul', desk: 'readymade-peer'}}]);
  const both = guestInstallActions('~sampel-palnet', GUEST_SOURCE, true);
  assert.equal(both.length, 2); assert.deepEqual(both[1], {id: 2, action: 'poke', ship: 'sampel-palnet', app: 'hood', mark: 'kiln-revive', json: 'readymade-peer'});
  assert.throws(() => guestInstallActions('~dashus-navnul'), /from itself/);
  for (const our of ['zod', '~zod ', '', '~Zod']) assert.throws(() => guestInstallActions(our), /Invalid/);
  assert.throws(() => guestInstallActions('~zod', {ship: '~nec', desk: '../x'}), /Invalid/);
});

type Capture = {method: string; url: string; body: string; headers: http.IncomingHttpHeaders};
type Step = (capture: Capture, response: http.ServerResponse) => void;
const json = (r: http.ServerResponse, body: unknown, status = 200) => {r.writeHead(status, {'content-type': 'application/json'}); r.end(JSON.stringify(body));};
async function fixture(run: (client: ShipClient, steps: Step[], captures: Capture[]) => Promise<void>): Promise<void> {
  const steps: Step[] = [], captures: Capture[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk)); req.on('end', () => {
      const c = {method: req.method!, url: req.url!, body: Buffer.concat(chunks).toString('utf8'), headers: req.headers}; captures.push(c);
      const step = steps.shift(); if (step) step(c, res); else {res.writeHead(599); res.end();}
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new ShipClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async () => 'fixture-only');
  try {
    steps.push((_c, r) => {r.writeHead(200, {'set-cookie': ['urbauth-~zod=fixture; Path=/']}); r.end();}); await client.signIn();
    await run(client, steps, captures); assert.equal(steps.length, 0);
  } finally {client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
}
const settle = async (captures: Capture[], count: number) => {for (let i = 0; i < 100 && captures.length < count; i++) await new Promise(r => setTimeout(r, 10));};

test('a read asks the agent first and kiln only when the agent is missing', () => fixture(async (client, steps, captures) => {
  steps.push((_c, r) => json(r, {status: 'refused', message: 'Exact retained invitation page required.'}, 400));
  assert.equal((await client.guestServiceRead()).status, 'ready'); assert.deepEqual(captures.slice(1).map(c => [c.method, c.url]), [['GET', GUEST_PROBE_PATH]]);
  assert.equal(captures[1].headers.cookie, 'urbauth-~zod=fixture');
  const cases: [unknown, string][] = [[{base: synced('live', '~zod', 'kids')}, 'missing'], [{[GUEST_DESK]: synced('live')}, 'starting'], [{[GUEST_DESK]: synced('held')}, 'suspended']];
  for (const [pikes, status] of cases) {
    steps.push((_c, r) => {r.writeHead(404); r.end();}, (_c, r) => json(r, pikes));
    assert.equal((await client.guestServiceRead()).status, status); assert.equal(captures.at(-1)!.url, GUEST_PIKES_PATH);
  }
  steps.push((_c, r) => {r.writeHead(503); r.end('<html>503</html>');}, (_c, r) => json(r, {[GUEST_DESK]: {sync: null, zest: 'dead'}}));
  assert.equal((await client.guestServiceRead()).status, 'suspended');
  steps.push((_c, r) => {r.writeHead(503); r.end('<html>503</html>');}, (_c, r) => json(r, {base: synced('live', '~zod', 'kids')}));
  await assert.rejects(client.guestServiceRead(), /another installation/);
  steps.push((_c, r) => {r.writeHead(404); r.end();}, (_c, r) => json(r, {[GUEST_DESK]: {zest: 'nonsense'}}));
  await assert.rejects(client.guestServiceRead(), e => e instanceof ShipClientError && e.code === 'malformed');
  steps.push((_c, r) => json(r, {}, 403));
  await assert.rejects(client.guestServiceRead(), e => e instanceof ShipClientError && e.code === 'authenticationRequired');
  steps.push((_c, r) => json(r, {}, 502));
  await assert.rejects(client.guestServiceRead(), e => e instanceof ShipClientError && e.code === 'unavailable');
}));

test('install sends exactly one poke on a fresh channel, then closes it; failures are classified, never resent', () => fixture(async (client, steps, captures) => {
  steps.push((_c, r) => {r.writeHead(204); r.end();}, (_c, r) => {r.writeHead(204); r.end();});
  await client.guestServiceInstall(); await settle(captures, 3);
  const [poke, close] = captures.slice(1);
  assert.equal(poke.method, 'PUT'); assert.match(poke.url, /^\/~\/channel\/readymade-guest-[0-9a-f-]{36}$/); assert.equal(close.url, poke.url);
  assert.deepEqual(JSON.parse(poke.body), guestInstallActions('~zod')); assert.deepEqual(JSON.parse(close.body), [{id: 2, action: 'delete'}]);
  steps.push((_c, r) => {r.writeHead(204); r.end();}, (_c, r) => {r.writeHead(204); r.end();});
  await client.guestServiceInstall(GUEST_SOURCE, true); await settle(captures, 5);
  assert.deepEqual(JSON.parse(captures[3].body), guestInstallActions('~zod', GUEST_SOURCE, true)); assert.deepEqual(JSON.parse(captures[4].body), [{id: 3, action: 'delete'}]);
  assert.equal(poke.headers['content-type'], 'application/json');
  steps.push((_c, r) => json(r, {}, 403), (_c, r) => {r.writeHead(204); r.end();});
  await assert.rejects(client.guestServiceInstall(), e => e instanceof ShipClientError && e.code === 'authenticationRequired'); await settle(captures, 7);
  steps.push((_c, r) => json(r, {}, 400), (_c, r) => {r.writeHead(204); r.end();});
  await assert.rejects(client.guestServiceInstall(), e => e instanceof ShipClientError && e.code === 'refused'); await settle(captures, 9);
  steps.push((_c, r) => {r.socket?.destroy();}, (_c, r) => {r.writeHead(204); r.end();});
  await assert.rejects(client.guestServiceInstall(), e => e instanceof OutcomeUnknownError); await settle(captures, 11);
  assert.equal(captures.filter(c => c.method === 'PUT' && JSON.parse(c.body)[0]?.action === 'poke').length, 5);
}));
