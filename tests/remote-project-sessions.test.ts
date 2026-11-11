import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {ShipClient, ShipClientError, OutcomeUnknownError} from '../src/ship-client';
import {remoteProjectSessionsReply, remoteProjectSessionsTarget, remoteProjectSessionsSelector, remoteProjectSessionsHeaders, remoteProjectSessionsRefused,
  remoteProjectSessionsObserve, remoteProjectSessionRows, remoteSessionShortId, REMOTE_SESSION_PHASES, type RemoteProjectSessionsReply} from '../src/remote-project-sessions';

const target = {owner: '~zod', project: 'café-共同'};
const selector = {...target, request: '0x1'}, peer = '~nec';
const session = (id = '0x5e55.2002', patch: object = {}, working: object = {}) => ({id, inspection: '0x595.9100', phase: 'judgment',
  working: {ship: target.owner, desk: 'pataphor-native-work', revision: '1', root: '0v1.abcde', commit: '0v0', ...working}, ...patch});
const pending = () => ({schema: 'readymade-project-sessions-result-v1', ...selector, peer, status: 'pending', reason: 'awaiting-owner',
  deadline: '~2026.11.11..05.00.30', retainedUntil: '~2026.11.11..05.05.30', permissionGranted: false, observation: null as unknown});
const ready = (sessions: unknown[] = [session()], truncated = false) => ({...pending(), status: 'ready', reason: 'observed',
  observation: {owner: target.owner, peer, observedAt: '~2026.11.11..05.00.01..8000', truncated, sessions}});
const settled = (status: string, reason: string) => ({...pending(), status, reason});
const unknown = {status: 'unknown', message: 'List not retained; no retry was issued.'}, expired = {status: 'expired', message: 'Historical list expired.'};
const decode = (value: unknown, status = 200) => remoteProjectSessionsReply(status, value, selector, peer);
const blocked = (e: unknown) => e instanceof ShipClientError && e.code === 'commandBusy';

test('a ready list decodes to an immutable past observation with every allowed phase', () => {
  const source = ready(REMOTE_SESSION_PHASES.map((phase, i) => session('0x' + (i + 1).toString(16), {phase}))), result = decode(source);
  if (result.status !== 'ready' || !result.observation) throw Error('fixture');
  assert.equal(result.permissionGranted, false); assert.equal(result.owner, target.owner); assert.equal(result.peer, peer); assert.equal(result.request, '0x1');
  assert.deepEqual(result.observation.sessions.map(s => s.phase), [...REMOTE_SESSION_PHASES]);
  assert.deepEqual(result.observation.sessions[0].working, {ship: '~zod', desk: 'pataphor-native-work', revision: '1', root: '0v1.abcde', commit: '0v0'});
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.observation) && Object.isFrozen(result.observation.sessions) &&
    Object.isFrozen(result.observation.sessions[0]) && Object.isFrozen(result.observation.sessions[0].working));
  (source.observation.sessions[0] as {phase: string}).phase = 'changed'; assert.equal(result.observation.sessions[0].phase, 'idle');
  assert.equal(decode(ready([])).status, 'ready'); assert.equal(decode(pending(), 202).status, 'pending');
  assert.equal(remoteProjectSessionsReply(202, pending(), target, peer).request, '0x1');
  assert.equal(decode(ready(Array.from({length: 64}, (_, i) => session('0x' + (i + 1).toString(16))), true)).status, 'ready');
  assert.equal(decode(ready([session('0x' + 'f'.repeat(4) + '.ffff'.repeat(15), {}, {revision: '18.446.744.073.709.551.615', root: '0v1v.' + Array(10).fill('vvvvv').join('.')})])).status, 'ready');
});

test('every settled status maps only to its own reasons and HTTP status', () => {
  assert.equal(decode(settled('refused', 'watch-refused')).status, 'refused');
  for (const reason of ['sessions-timeout', 'closed-without-list', 'invalid-list', 'list-mismatch', 'unexpected-poke-ack']) assert.equal(decode(settled('uncertain', reason)).status, 'uncertain');
  for (const [status, reason] of [['refused', 'observed'], ['uncertain', 'watch-refused'], ['pending', 'observed'], ['ready', 'awaiting-owner'], ['done', 'observed'], ['uncertain', 'view-timeout']])
    assert.throws(() => decode(settled(status, reason), status === 'pending' ? 202 : 200));
  assert.throws(() => decode(pending(), 200)); assert.throws(() => decode(ready(), 202)); assert.throws(() => decode(ready(), 503));
  assert.throws(() => remoteProjectSessionsReply(200, ready(), target, peer)); // A submission may only answer pending.
  assert.throws(() => decode({...pending(), observation: ready().observation}, 202)); assert.throws(() => decode({...ready(), observation: null}));
  assert.throws(() => decode({...settled('refused', 'watch-refused'), observation: ready().observation}));
});

test('decoder rejects substituted context, claimed permission, extra or missing fields, and bad dates', () => {
  for (const patch of [{schema: 'readymade-project-view-result-v1'}, {owner: '~wes'}, {peer: '~wes'}, {project: 'other'}, {request: '0x2'}, {permissionGranted: true},
    {permissionGranted: 0}, {generation: '1'}, {retainedUntil: '~2026.11.11..05.05.31'}, {deadline: '~2026.02.30'}, {deadline: '~2026.11.11..05.00.30..0000'}, {status: 1}, {reason: null}])
    assert.throws(() => decode({...ready(), ...patch}));
  for (const key of Object.keys(ready())) {const value: Record<string, unknown> = ready(); delete value[key]; assert.throws(() => decode(value));}
  assert.throws(() => decode([ready()])); assert.throws(() => decode(null)); assert.throws(() => decode(Object.assign(Object.create({schema: 'x'}), ready())));
  assert.throws(() => remoteProjectSessionsReply(200, {...ready(), peer: '~zod'}, selector, '~zod')); // A ship never lists its own project as a peer.
  assert.throws(() => remoteProjectSessionsReply(200, ready(), selector, 'nec'));
});

test('decoder rejects every malformed observation and session', () => {
  const seen = (patch: object) => ({...ready(), observation: {...ready().observation, ...patch}});
  for (const patch of [{owner: '~wes'}, {peer: '~wes'}, {observedAt: '2026-11-11'}, {observedAt: 1}, {truncated: 'false'}, {truncated: 0}, {sessions: {}}, {sessions: null}, {extra: 1},
    {sessions: Array.from({length: 65}, (_, i) => session('0x' + (i + 1).toString(16)))}]) assert.throws(() => decode(seen(patch)));
  for (const key of ['owner', 'peer', 'observedAt', 'truncated', 'sessions']) {const o: Record<string, unknown> = {...ready().observation}; delete o[key]; assert.throws(() => decode({...ready(), observation: o}));}
  for (const patch of [{id: '0x0'}, {id: '0x05e5'}, {id: '0X5E55'}, {id: '0x5e552002'}, {id: '0x1' + '.0000'.repeat(16)}, {id: 5}, {inspection: '0x0'}, {inspection: '595'},
    {phase: 'running'}, {phase: 'Idle'}, {phase: null}, {transcript: 'invented'}, {working: null}]) assert.throws(() => decode(ready([session('0x5e55.2002', patch)])));
  for (const working of [{ship: '~wes'}, {ship: peer}, {desk: ''}, {desk: 'Work'}, {desk: '1work'}, {desk: 'a'.repeat(129)}, {desk: 'bad:desk'}, {revision: '01'}, {revision: '1000'},
    {revision: 1}, {revision: '18.446.744.073.709.551.616'}, {root: '0v00'}, {root: '0x1'}, {root: '0vabcdef'}, {root: '0v20.' + Array(10).fill('00000').join('.')}, {commit: '0V1'},
    {commit: null}, {path: '/app'}]) assert.throws(() => decode(ready([session('0x5e55.2002', {}, working)])));
  const short: Record<string, unknown> = session(); delete short.inspection; assert.throws(() => decode(ready([short])));
  const bare: Record<string, unknown> = {...session().working}; delete bare.commit; assert.throws(() => decode(ready([{...session(), working: bare}])));
  assert.equal(decode(ready([session('0x5e55.2002', {}, {revision: '0', root: '0v0'})])).status, 'ready');
});

test('targets and selectors admit only colon-free bounded values and canonical request atoms', () => {
  assert.deepEqual(remoteProjectSessionsTarget(target), target); assert.deepEqual(remoteProjectSessionsSelector(selector), selector);
  for (const project of ['bad:header', 'bad\nheader', '', 'a'.repeat(129), '\ud800', 7]) assert.throws(() => remoteProjectSessionsTarget({...target, project}));
  for (const owner of ['zod', '~ZOD', '~zod:8080', '~', 7]) assert.throws(() => remoteProjectSessionsTarget({...target, owner}));
  for (const request of ['0x0', '0x01', '0x10000', '0xABCD', '1', '0x1.0000.0000.0000.0000.0000.0000.0000.0000', 1]) assert.throws(() => remoteProjectSessionsSelector({...selector, request}));
  assert.throws(() => remoteProjectSessionsTarget({...target, generation: '1'})); assert.throws(() => remoteProjectSessionsSelector(target));
  const headers = remoteProjectSessionsHeaders({...selector, request: '0xffff.ffff.ffff.ffff.ffff.ffff.ffff.ffff'});
  assert.deepEqual(Object.keys(headers), ['x-readymade-project-owner', 'x-readymade-project', 'x-readymade-project-sessions-request']);
  assert.equal(Buffer.from(headers['x-readymade-project'], 'latin1').toString('utf8'), target.project);
});

test('unknown and expired lists are observations only, and only for an exact read', () => {
  assert.deepEqual(decode(unknown, 404), {...selector, peer, permissionGranted: false, status: 'missing'});
  assert.deepEqual(decode(expired, 410), {...selector, peer, permissionGranted: false, status: 'expired'});
  for (const [status, body] of [[404, expired], [410, unknown], [404, {...unknown, request: '0x1'}], [404, {status: 'unknown', message: 'Observation not retained; no retry was issued.'}], [200, unknown]] as const)
    assert.throws(() => decode(body, status));
  assert.throws(() => remoteProjectSessionsReply(404, unknown, target, peer));
  for (const message of ['sessions-selector-invalid', 'sessions-request-reused', 'sessions-capacity']) assert.equal(remoteProjectSessionsRefused(409, {status: 'refused', message}), true);
  assert.equal(remoteProjectSessionsRefused(403, {status: 'refused', message: 'Owner login required.'}), true);
  assert.equal(remoteProjectSessionsRefused(400, {status: 'refused', message: 'Exact owner-origin shared session list command required.'}), true);
  for (const [status, body] of [[409, {status: 'refused', message: 'view-capacity'}], [503, {status: 'refused', message: 'sessions-capacity'}], [409, {status: 'unavailable', message: 'sessions-capacity'}],
    [409, {status: 'refused', message: 'sessions-capacity', extra: 1}]] as const) assert.equal(remoteProjectSessionsRefused(status, body), false);
});

test('rows say in plain language what one reply means', () => {
  assert.equal(remoteSessionShortId('0x5e55.2002'), '0x5e55.2002'); assert.equal(remoteSessionShortId('0x1.2222.3333.4444.5555'), '0x1.2222…5555');
  assert.deepEqual(remoteProjectSessionRows(decode(ready())), [{label: '0x5e55.2002', description: 'judgment',
    tooltip: 'pataphor-native-work @ 1\nObserved ~2026.11.11..05.00.01..8000\nSession 0x5e55.2002'}]);
  assert.deepEqual(remoteProjectSessionRows(decode(ready([]))), [{label: 'No sessions are shared with you in this project'}]);
  assert.deepEqual(remoteProjectSessionRows(decode(settled('refused', 'watch-refused'))), [{label: 'The owner did not share a session list with this ship'}]);
  assert.deepEqual(remoteProjectSessionRows(decode(settled('uncertain', 'sessions-timeout'))), [{label: 'No answer from the owner; nothing was retried'}]);
  assert.equal(remoteProjectSessionRows(decode(ready(Array.from({length: 64}, (_, i) => session('0x' + (i + 1).toString(16))), true))).at(-1)!.label, 'Showing the first 64');
  assert.equal(remoteProjectSessionRows(decode(pending(), 202))[0].label, 'Waiting for the owner');
  assert.match(remoteProjectSessionRows(decode(unknown, 404))[0].label, /nothing was retried$/); assert.match(remoteProjectSessionRows(decode(expired, 410))[0].label, /nothing was retried$/);
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
const posts = (captures: Capture[]) => captures.filter(c => c.method === 'POST' && c.url === '/apps/readymade-collab/project-sessions').length;

test('real HTTP sends exactly three colon-free keys, then reads by exact headers', () => fixture(async (client, steps, captures) => {
  steps.push((_c, r) => json(r, pending(), 202)); assert.equal((await client.projectSessionsSubmit(target.owner, target.project)).status, 'pending');
  const post = captures.at(-1)!;
  assert.equal(post.url, '/apps/readymade-collab/project-sessions'); assert.equal(post.method, 'POST');
  assert.equal(post.headers.origin, client.origin); assert.equal(post.headers.cookie, 'urbauth-~nec=fixture');
  assert.equal(post.headers['content-type'], 'application/json'); assert.equal(post.headers['x-readymade-project-sessions'], 'v1');
  assert.deepEqual(JSON.parse(post.body), {schema: 'readymade-project-sessions-v1', ...target});
  assert.equal(post.body.split(':').length - 1, 3); // The ship counts colons to prove three plain keys.
  await assert.rejects(client.projectSessionsSubmit(target.owner, target.project), blocked);
  steps.push((_c, r) => json(r, ready())); const result = await client.projectSessionsResult(target.owner, target.project, selector.request);
  assert.equal(result.status, 'ready'); const get = captures.at(-1)!;
  assert.equal(get.method, 'GET'); assert.equal(get.url, '/apps/readymade-collab/project-sessions-result'); assert.equal(get.body, '');
  assert.equal(get.headers['x-readymade-project-owner'], target.owner);
  assert.equal(Buffer.from(get.headers['x-readymade-project'] as string, 'latin1').toString('utf8'), target.project);
  assert.equal(get.headers['x-readymade-project-sessions-request'], selector.request); assert.equal(client.snapshot, undefined);
  steps.push((_c, r) => json(r, {...pending(), request: '0x2'}, 202)); await client.projectSessionsSubmit(target.owner, target.project);
}));

test('invalid arguments and a self-owned project never reach the wire', () => fixture(async (client, _steps, captures) => {
  await assert.rejects(client.projectSessionsSubmit('~zod', 'bad:project')); await assert.rejects(client.projectSessionsSubmit('zod', 'project'));
  await assert.rejects(client.projectSessionsResult('~zod', 'project', '0x0')); await assert.rejects(client.projectSessionsResult('~zod', 'project', '0X1'));
  await assert.rejects(client.projectSessionsSubmit('~nec', 'project'), e => e instanceof ShipClientError && e.code === 'contextChanged');
  await assert.rejects(client.projectSessionsResult('~nec', 'project', '0x1'), e => e instanceof ShipClientError && e.code === 'contextChanged');
  assert.equal(captures.length, 1);
}));

test('an unknown submission is never resent; unknown and expired lists are observations only', async () => {
  for (const [code, body, status] of [[404, unknown, 'missing'], [410, expired, 'expired']] as const) await fixture(async (client, steps, captures) => {
    steps.push((_c, r) => r.socket!.destroy()); await assert.rejects(client.projectSessionsSubmit(target.owner, target.project), OutcomeUnknownError);
    steps.push((_c, r) => json(r, body, code)); assert.equal((await client.projectSessionsResult(target.owner, target.project, selector.request)).status, status);
    await assert.rejects(client.projectSessionsSubmit(target.owner, target.project), blocked); assert.equal(posts(captures), 1);
    assert.equal(captures.filter(c => c.method === 'GET').length, 1); // One read, no retry.
  });
});

test('a known refusal permits a new explicit request; malformed replies, redirects and 503 do not', async () => {
  for (const message of ['sessions-capacity', 'sessions-request-reused', 'sessions-selector-invalid']) await fixture(async (client, steps) => {
    steps.push((_c, r) => json(r, {status: 'refused', message}, 409));
    await assert.rejects(client.projectSessionsSubmit(target.owner, target.project), e => e instanceof ShipClientError && e.code === 'refused' && e.status === 409);
    steps.push((_c, r) => json(r, pending(), 202)); await client.projectSessionsSubmit(target.owner, target.project);
  });
  for (const step of [((_c, r) => {r.writeHead(302, {location: '/elsewhere'}); r.end();}) as Step, ((_c, r) => json(r, {...pending(), peer: '~wes'}, 202)) as Step,
    ((_c, r) => json(r, {status: 'unavailable', message: 'List selector encoding refused.'}, 503)) as Step, ((_c, r) => json(r, ready())) as Step,
    ((_c, r) => {r.writeHead(202, {'content-type': 'text/html'}); r.end(JSON.stringify(pending()));}) as Step,
    ((_c, r) => {r.writeHead(202, {'content-type': 'application/json'}); r.end(JSON.stringify(pending()).replace('{', '{"owner":"~zod",'));}) as Step,
    ((_c, r) => {r.writeHead(202, {'content-type': 'application/json'}); r.end(' '.repeat(524289));}) as Step]) await fixture(async (client, steps) => {
    steps.push(step); await assert.rejects(client.projectSessionsSubmit(target.owner, target.project), OutcomeUnknownError);
    await assert.rejects(client.projectSessionsSubmit(target.owner, target.project), blocked);
  });
});

test('any settled answer releases only its own request; a pending or stale one does not', async () => {
  for (const [code, body] of [[200, ready()], [200, settled('refused', 'watch-refused')], [200, settled('uncertain', 'sessions-timeout')], [404, unknown], [410, expired]] as const) await fixture(async (client, steps, captures) => {
    steps.push((_c, r) => json(r, pending(), 202)); await client.projectSessionsSubmit(target.owner, target.project);
    steps.push((_c, r) => json(r, pending(), 202)); assert.equal((await client.projectSessionsResult(target.owner, target.project, selector.request)).status, 'pending');
    await assert.rejects(client.projectSessionsSubmit(target.owner, target.project), blocked);
    steps.push((_c, r) => json(r, body, code)); await client.projectSessionsResult(target.owner, target.project, selector.request);
    assert.equal(posts(captures), 1); // Reading never submits.
    steps.push((_c, r) => json(r, {...pending(), request: '0x2'}, 202)); await client.projectSessionsSubmit(target.owner, target.project);
    steps.push((_c, r) => json(r, body, code)); await client.projectSessionsResult(target.owner, target.project, selector.request);
    await assert.rejects(client.projectSessionsSubmit(target.owner, target.project), blocked);
  });
});

test('one unresolved project does not block another, and a read is refused for a mismatched echo', () => fixture(async (client, steps) => {
  steps.push((_c, r) => r.socket!.destroy()); await assert.rejects(client.projectSessionsSubmit(target.owner, target.project), OutcomeUnknownError);
  steps.push((_c, r) => json(r, {...pending(), project: 'other', request: '0x2'}, 202)); await client.projectSessionsSubmit(target.owner, 'other');
  await assert.rejects(client.projectSessionsSubmit(target.owner, target.project), blocked);
  steps.push((_c, r) => json(r, {...ready(), project: 'other'})); await assert.rejects(client.projectSessionsResult(target.owner, target.project, selector.request));
  steps.push((_c, r) => json(r, {...ready(), request: '0x3'})); await assert.rejects(client.projectSessionsResult(target.owner, target.project, selector.request));
  steps.push((_c, r) => json(r, ready([session('0x1', {}, {ship: '~wes'})]))); await assert.rejects(client.projectSessionsResult(target.owner, target.project, selector.request));
}));

test('an ambiguous authenticated peer is rejected before dispatch', () => fixture(async (client, _steps, captures) => {
  await assert.rejects(client.projectSessionsSubmit(target.owner, target.project), e => e instanceof ShipClientError && e.code === 'authenticationRequired');
  await assert.rejects(client.projectSessionsResult(target.owner, target.project, selector.request), e => e instanceof ShipClientError && e.code === 'authenticationRequired');
  assert.equal(captures.length, 1);
}, ['urbauth-~nec=fixture; Path=/', 'urbauth-~wes=fixture; Path=/']));

test('an in-flight read cannot survive a new authentication epoch', () => fixture(async (client, steps) => {
  let release!: () => void; let received!: () => void; const arrived = new Promise<void>(r => {received = r;});
  steps.push((_c, r) => {release = () => json(r, ready()); received();});
  const reading = client.projectSessionsResult(target.owner, target.project, selector.request); await arrived;
  steps.push((_c, r) => {r.writeHead(200, {'set-cookie': 'urbauth-~nec=next; Path=/'}); r.end();}); await client.signIn(); release();
  await assert.rejects(reading, e => e instanceof ShipClientError && e.code === 'contextChanged');
}));

test('observing submits once, reads until settled, and only reads a request that is already pending', async () => {
  const none = async () => {};
  await fixture(async (client, steps, captures) => {
    const seen: RemoteProjectSessionsReply[] = [];
    steps.push((_c, r) => json(r, pending(), 202), (_c, r) => json(r, pending(), 202), (_c, r) => json(r, ready()));
    await remoteProjectSessionsObserve(client, target, undefined, reply => seen.push(reply), none);
    assert.deepEqual(seen.map(r => r.status), ['pending', 'pending', 'ready']); assert.equal(posts(captures), 1);
    assert.deepEqual(captures.slice(2).map(c => c.headers['x-readymade-project-sessions-request']), ['0x1', '0x1']);
  });
  await fixture(async (client, steps, captures) => {
    const seen: string[] = [];
    steps.push((_c, r) => json(r, settled('uncertain', 'sessions-timeout')));
    await remoteProjectSessionsObserve(client, target, '0x1', reply => seen.push(reply.status), none);
    assert.deepEqual(seen, ['uncertain']); assert.equal(posts(captures), 0); assert.equal(captures.length, 2); // No answer is final: nothing is retried.
  });
  await fixture(async (client, steps, captures) => {
    const seen: string[] = [];
    steps.push((_c, r) => json(r, pending(), 202));
    await remoteProjectSessionsObserve(client, target, undefined, reply => seen.push(reply.status), none, 0);
    assert.deepEqual(seen, ['pending']); assert.equal(captures.length, 2); // An exhausted budget stops reading and never resubmits.
  });
  await fixture(async (client, steps, captures) => {
    steps.push((_c, r) => json(r, pending(), 202));
    await assert.rejects(remoteProjectSessionsObserve(client, target, undefined, () => {throw new Error('context changed');}, none), /context changed/);
    steps.push((_c, r) => json(r, unknown, 404));
    const seen: string[] = []; await remoteProjectSessionsObserve(client, target, '0x1', reply => seen.push(reply.status), none);
    assert.deepEqual(seen, ['missing']); assert.equal(posts(captures), 1); assert.equal(captures.length, 3);
  });
});
