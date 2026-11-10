import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {ShipClient, ShipClientError, OutcomeUnknownError} from '../src/ship-client';
import {remoteProjectViewReply, remoteProjectViewJSON, remoteProjectViewTarget, remoteProjectViewSelector, remoteSourceHash} from '../src/remote-project-view';

const target = {owner: '~zod', project: 'café-共同', generation: '1'};
const selector = {...target, request: '0x1'}, peer = '~nec', origin = 'http://localhost:8080';
const file = (text = 'abc', path = '/lib/example/hoon') => ({path, text, hash: remoteSourceHash(text)});
const pending = () => ({schema: 'readymade-project-view-result-v1', ...selector, peer, status: 'pending', reason: 'awaiting-owner',
  deadline: '~2026.11.09..00.00.30', retainedUntil: '~2026.11.09..00.05.30', permissionGranted: false, observation: null});
const ready = () => ({...pending(), status: 'ready', reason: 'observed', observation: {owner: target.owner, peer, grant: '0x1',
  observedAt: '~2025.01.01', root: '0x2', snapshotDigest: '0x3', desk: 'work', revision: '1', files: [file()]}});
const decode = (value: unknown, status = 200) => remoteProjectViewReply(status, value, selector, peer, origin);
const blocked = (e: unknown) => e instanceof ShipClientError && e.code === 'commandBusy';

test('remote observation is immutable, distinct provenance with verified native little endian shax', () => {
  assert.equal(remoteSourceHash('abc'), '0xad15.00f2.61ff.10b4.9c7a.1796.a361.03b0.2322.ae5d.de40.4141.eacf.018f.bf16.78ba');
  const source = ready(), result = decode(source);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw Error('fixture');
  assert.equal(result.observation?.origin, origin);
  assert.equal(result.observation?.observedAt, '~2025.01.01');
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.observation) && Object.isFrozen(result.observation!.files[0]));
  source.observation.files[0].text = 'changed'; assert.equal(result.observation!.files[0].text, 'abc');
  assert.equal('session' in result.observation!, false); assert.equal('commit' in result.observation!, false);
});

test('remote decoder rejects context substitution, extra fields, noncanonical atoms and dates', () => {
  for (const patch of [{owner: '~wes'}, {peer: '~wes'}, {project: 'other'}, {generation: '2'}, {request: '0x2'}, {permissionGranted: true}, {session: 'invented'}, {retainedUntil: '~2026.11.09..00.05.31'}, {deadline: '~2026.02.30'}]) assert.throws(() => decode({...ready(), ...patch}));
  for (const generation of ['01', '1000', '0', '18.446.744.073.709.551.616']) assert.throws(() => remoteProjectViewTarget({...target, generation}));
  for (const request of ['0x0', '0x01', '0x10000', '0x1.0000.0000.0000.0000.0000.0000.0000.0000']) assert.throws(() => remoteProjectViewSelector({...selector, request}));
  for (const project of ['bad:header', 'bad\nheader', 'a'.repeat(129), '\ud800']) assert.throws(() => remoteProjectViewTarget({...target, project}));
  assert.throws(() => decode({...ready(), observation: {...ready().observation, commit: 'invented'}}));
  assert.throws(() => decode({...ready(), observation: {...ready().observation, files: [{...file(), hash: '0x1'}]}}));
});

test('source limits, grammar, ASCII and aggregate bounds are enforced', () => {
  const withFiles = (files: ReturnType<typeof file>[]) => ({...ready(), observation: {...ready().observation, files}});
  decode(withFiles([file('a'.repeat(32768)), file('b'.repeat(32768), '/app/other/hoon')]));
  for (const files of [[], [file('a'.repeat(32769))], [file('a'.repeat(32768)), file('b'.repeat(32768), '/app/other/hoon'), file('x', '/ted/extra/hoon')], [file(), file()], Array.from({length: 9}, (_, i) => file('', `/lib/f${i}/hoon`))]) assert.throws(() => decode(withFiles(files)));
  for (const path of ['/lib/../hoon', '/lib/%61/hoon', '/app/a/b/c/d/e/f/g/hoon', '/sys/a/hoon']) assert.throws(() => decode(withFiles([file('', path)])));
  for (const text of ['é', '\0', '\x7f']) assert.throws(() => decode(withFiles([file(text)])));
});

test('wire JSON is bounded fatal UTF8 and rejects duplicate keys including aliases', () => {
  assert.deepEqual(remoteProjectViewJSON(Buffer.from('{"a":[{"b":"{}[]"}]}')), {a: [{b: '{}[]'}]});
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":[{"b":1,"b":2}]}']) assert.throws(() => remoteProjectViewJSON(Buffer.from(text)));
  assert.throws(() => remoteProjectViewJSON(Buffer.from([123, 34, 97, 34, 58, 34, 255, 34, 125])));
  assert.throws(() => remoteProjectViewJSON(Buffer.alloc(524289, 32)));
});

type Capture = {method: string; url: string; headers: http.IncomingHttpHeaders; body: string};
type Step = (capture: Capture, response: http.ServerResponse) => void;
const json = (r: http.ServerResponse, body: unknown, status = 200) => {r.writeHead(status, {'content-type': 'application/json'}); r.end(JSON.stringify(body));};
async function fixture(run: (client: ShipClient, steps: Step[], captures: Capture[]) => Promise<void>, cookies = ['urbauth-~nec=fixture; Path=/']): Promise<void> {
  const steps: Step[] = [], captures: Capture[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk)); req.on('end', () => {
      const c = {method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString('utf8')}; captures.push(c);
      const step = steps.shift(); if (step) step(c, res); else {res.writeHead(599); res.end();}
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new ShipClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async () => 'fixture-only');
  try {
    steps.push((_c, r) => {r.writeHead(200, {'set-cookie': cookies}); r.end();}); await client.signIn();
    await run(client, steps, captures); assert.equal(steps.length, 0);
  } finally {client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
}

test('real HTTP uses cookie peer without codingState and UTF8 project header bytes', () => fixture(async (client, steps, captures) => {
  steps.push((_c, r) => json(r, pending(), 202)); await client.projectViewSubmit(target);
  const post = captures.at(-1)!;
  assert.equal(post.url, '/apps/readymade-collab/project-view'); assert.equal(post.method, 'POST');
  assert.equal(post.headers.origin, client.origin); assert.equal(post.headers.cookie, 'urbauth-~nec=fixture');
  assert.equal(post.headers['x-readymade-project-view'], 'v1');
  assert.deepEqual(JSON.parse(post.body), {schema: 'readymade-project-view-v1', ...target});
  await assert.rejects(client.projectViewSubmit(target), blocked);
  steps.push((_c, r) => json(r, ready())); const result = await client.projectViewResult(selector);
  assert.equal(result.status, 'ready'); const get = captures.at(-1)!;
  assert.equal(get.method, 'GET'); assert.equal(get.url, '/apps/readymade-collab/project-view-result'); assert.equal(get.body, '');
  assert.equal(Buffer.from(get.headers['x-readymade-project'] as string, 'latin1').toString('utf8'), target.project);
  assert.equal(get.headers['x-readymade-project-view-request'], selector.request); assert.equal(client.snapshot, undefined);
  steps.push((_c, r) => json(r, {...pending(), request: '0x2'}, 202)); await client.projectViewSubmit(target);
}));

test('unknown publication never resends; missing and expired are observations only', async () => {
  for (const [code, body, status] of [[404, {status: 'unknown', message: 'Observation not retained; no retry was issued.'}, 'missing'], [410, {status: 'expired', message: 'Historical observation expired.'}, 'expired']] as const) await fixture(async (client, steps, captures) => {
    steps.push((_c, r) => r.socket!.destroy()); await assert.rejects(client.projectViewSubmit(target), OutcomeUnknownError);
    steps.push((_c, r) => json(r, body, code)); assert.equal((await client.projectViewResult(selector)).status, status);
    await assert.rejects(client.projectViewSubmit(target), blocked); assert.equal(captures.filter(c => c.method === 'POST' && c.url.includes('project-view')).length, 1);
  });
});

test('known predispatch refusal permits a new explicit read; malformed reply and redirects do not', async () => {
  await fixture(async (client, steps) => {
    steps.push((_c, r) => json(r, {status: 'refused', message: 'view-capacity'}, 409));
    await assert.rejects(client.projectViewSubmit(target), e => e instanceof ShipClientError && e.code === 'refused');
    steps.push((_c, r) => json(r, pending(), 202)); await client.projectViewSubmit(target);
  });
  for (const step of [((_c, r) => {r.writeHead(302, {location: '/elsewhere'}); r.end();}) as Step, ((_c, r) => json(r, {...pending(), peer: '~wes'}, 202)) as Step,
    ((_c, r) => {r.writeHead(202, {'content-type': 'application/json'}); r.end(' '.repeat(524289));}) as Step]) await fixture(async (client, steps) => {
    steps.push(step); await assert.rejects(client.projectViewSubmit(target), OutcomeUnknownError); await assert.rejects(client.projectViewSubmit(target), blocked);
  });
});

test('correlated missing or expired permits only a new explicit read; old observations cannot release its hold', async () => {
  for (const [code, body] of [[404, {status: 'unknown', message: 'Observation not retained; no retry was issued.'}], [410, {status: 'expired', message: 'Historical observation expired.'}]] as const) await fixture(async (client, steps, captures) => {
    steps.push((_c, r) => json(r, pending(), 202)); await client.projectViewSubmit(target);
    steps.push((_c, r) => json(r, body, code)); await client.projectViewResult(selector);
    assert.equal(captures.filter(c => c.method === 'POST').length, 2); // Login and one read; GET never retries.
    steps.push((_c, r) => json(r, {...pending(), request: '0x2'}, 202)); await client.projectViewSubmit(target);
    steps.push((_c, r) => json(r, body, code)); await client.projectViewResult(selector);
    await assert.rejects(client.projectViewSubmit(target), blocked);
  });
});

test('unknown read on one project does not block a different target', () => fixture(async (client, steps) => {
  steps.push((_c, r) => r.socket!.destroy()); await assert.rejects(client.projectViewSubmit(target), OutcomeUnknownError);
  const other = {...target, project: 'other'};
  steps.push((_c, r) => json(r, {...pending(), ...other, request: '0x2'}, 202)); await client.projectViewSubmit(other);
  await assert.rejects(client.projectViewSubmit(target), blocked);
}));

test('ambiguous authenticated peer is rejected before dispatch', () => fixture(async (client, _steps, captures) => {
  await assert.rejects(client.projectViewSubmit(target), e => e instanceof ShipClientError && e.code === 'authenticationRequired'); assert.equal(captures.length, 1);
}, ['urbauth-~nec=fixture; Path=/', 'urbauth-~wes=fixture; Path=/']));

test('in-flight observation cannot survive a new authentication epoch', () => fixture(async (client, steps) => {
  let release!: () => void; let received!: () => void; const arrived = new Promise<void>(r => {received = r;});
  steps.push((_c, r) => {release = () => json(r, ready()); received();});
  const reading = client.projectViewResult(selector); await arrived;
  steps.push((_c, r) => {r.writeHead(200, {'set-cookie': 'urbauth-~nec=next; Path=/'}); r.end();}); await client.signIn(); release();
  await assert.rejects(reading, e => e instanceof ShipClientError && e.code === 'contextChanged');
}));
