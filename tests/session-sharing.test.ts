import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {ShipClient, ShipClientError, OutcomeUnknownError, SessionSharingRefusedError} from '../src/ship-client';
import {sessionSharingSnapshot, sessionSharingReceipt, sessionSharingCommand, sessionSharingTarget, sessionSharingHeaders, sessionSharingRefusal, sessionSharingHolds,
  sessionSharingConfirm, sessionSharingSettle, sessionSharingMessage, SESSION_SHARING_PHASES, SESSION_SHARING_REASONS, SESSION_SHARING_ROLES,
  type SessionSharingClient, type SessionSharingCommand, type SessionSharingReceipt} from '../src/session-sharing';

const target = {owner: '~zod', project: 'café-共同', peer: '~nec'}, id = '0x5e55.2002';
const share: SessionSharingCommand = {...target, operation: 'share', session: id}, unshare: SessionSharingCommand = {...share, operation: 'unshare'};
const remove: SessionSharingCommand = {...target, operation: 'remove', session: '0x0'};
const row = (session = id, shared = false, patch: object = {}) => ({id: session, phase: 'judgment', desk: 'pataphor-native-work', revision: '1', shared, inspection: shared ? '0x595.9100' : null, ...patch});
const state = (sessions: unknown[] = [row()], patch: object = {}) => ({schema: 'readymade-session-sharing-v1', ...target, observedAt: '~2026.11.11..05.00.01..8000',
  member: true, role: 'contributor', inspectable: true, viewGrant: 'none', truncated: false, sessionSharing: 'on', sessionSharingBlocked: null, sessions, ...patch});
const gone = () => state([row()], {member: false, role: null, inspectable: false, viewGrant: 'revoked'});
const receipt = (operation = 'share', status = 'submitted', pokes = 1) => ({schema: 'readymade-session-sharing-receipt-v1', status, operation, pokes, confirmed: false});
const decode = (value: unknown) => sessionSharingSnapshot(value, target);
const many = (count: number) => Array.from({length: count}, (_, i) => row('0x' + (i + 1).toString(16)));

test('a standing decodes to an immutable snapshot for every role, phase and grant state', () => {
  const source = state(SESSION_SHARING_PHASES.map((phase, i) => row('0x' + (i + 1).toString(16), i % 2 === 0, {phase}))), seen = decode(source);
  assert.deepEqual(seen.sessions.map(s => s.phase), [...SESSION_SHARING_PHASES]); assert.deepEqual(seen.sessions[0], {id: '0x1', phase: 'idle', desk: 'pataphor-native-work', revision: '1', shared: true, inspection: '0x595.9100'});
  assert.equal(seen.sessions[1].inspection, null); assert.equal(seen.owner, '~zod'); assert.equal(seen.peer, '~nec'); assert.equal(seen.project, target.project);
  assert.ok(Object.isFrozen(seen) && Object.isFrozen(seen.sessions) && Object.isFrozen(seen.sessions[0]));
  (source.sessions[0] as {shared: boolean}).shared = false; assert.equal(seen.sessions[0].shared, true);
  for (const role of SESSION_SHARING_ROLES) assert.equal(decode(state([], {role})).role, role);
  for (const viewGrant of ['none', 'live', 'revoked']) assert.equal(decode(state([], {viewGrant})).viewGrant, viewGrant);
  assert.deepEqual([decode(gone()).member, decode(gone()).role, decode(gone()).inspectable], [false, null, false]);
  assert.equal(decode(state(many(128), {truncated: true})).sessions.length, 128); assert.equal(decode(state(many(128))).truncated, false);
  assert.equal(decode(state([row('0x' + 'f'.repeat(4) + '.ffff'.repeat(15), true, {revision: '0', inspection: '0x' + 'f'.repeat(4) + '.ffff'.repeat(15)})])).sessions.length, 1);
});

test('standing decoder rejects substituted context, inconsistent membership and malformed fields', () => {
  for (const patch of [{schema: 'readymade-session-sharing-v2'}, {owner: '~wes'}, {peer: '~wes'}, {project: 'other'}, {observedAt: '2026-11-11'}, {observedAt: '~2026.11.11..05.00.00..0000'},
    {member: 'true'}, {role: null}, {role: 'owner'}, {member: false}, {inspectable: 1}, {viewGrant: 'pending'}, {viewGrant: null}, {truncated: 0}, {truncated: true}, {sessions: {}},
    {sessions: many(129)}, {permissionGranted: false}, {sessionSharing: 'maybe'}, {sessionSharing: true}, {sessionSharing: 'off'}, {sessionSharing: 'unregistered'}, {sessionSharingBlocked: 'busy'}, {sessionSharingBlocked: false}]) assert.throws(() => decode(state([row()], patch)));
  assert.throws(() => decode(state(many(127), {truncated: true}))); assert.throws(() => decode({...gone(), role: 'observer'}));
  for (const key of Object.keys(state())) {const value: Record<string, unknown> = state(); delete value[key]; assert.throws(() => decode(value));}
  assert.throws(() => decode(null)); assert.throws(() => decode([state()])); assert.throws(() => sessionSharingSnapshot(state(), {...target, peer: '~zod'}));
  for (const patch of [{id: '0x0'}, {id: '0x05e5'}, {id: '0X5E55'}, {id: '0x5e552002'}, {id: '0x1' + '.0000'.repeat(16)}, {id: 5}, {phase: 'running'}, {phase: null}, {desk: ''}, {desk: 'Work'},
    {desk: 'bad:desk'}, {revision: '01'}, {revision: 1}, {revision: '18.446.744.073.709.551.616'}, {shared: 'no'}, {shared: true}, {inspection: '0x1'}, {inspection: undefined}, {working: {}}])
    assert.throws(() => decode(state([row(id, false, patch)])));
  for (const patch of [{inspection: null}, {inspection: '0x0'}, {inspection: '595'}]) assert.throws(() => decode(state([row(id, true, patch)])));
  const short: Record<string, unknown> = row(); delete short.inspection; assert.throws(() => decode(state([short])));
  assert.throws(() => decode(state([row('0x2'), row('0x1')]))); assert.throws(() => decode(state([row('0x2'), row('0x2')]))); // Ascending and unique.
  assert.equal(decode(state([row('0x1'), row('0x2')])).sessions.length, 2);
});

test('commands carry exactly a colon-free target, an operation and the right session text', () => {
  assert.deepEqual(sessionSharingCommand(share), share); assert.deepEqual(sessionSharingCommand(remove), remove); assert.deepEqual(sessionSharingTarget(target), target);
  for (const patch of [{session: '0x0'}, {session: '0x05'}, {session: '0X5'}, {session: 5}, {operation: 'grant'}, {operation: 'remove'}, {owner: '~nec'}, {owner: 'zod'}, {peer: '~'},
    {project: 'bad:project'}, {project: ''}, {project: 'a'.repeat(129)}, {project: 'bad\nproject'}, {request: '0x1'}]) assert.throws(() => sessionSharingCommand({...share, ...patch}));
  for (const session of [id, '0x1', '']) assert.throws(() => sessionSharingCommand({...remove, session}));
  const partial: Record<string, unknown> = {...share}; delete partial.session; assert.throws(() => sessionSharingCommand(partial));
  const headers = sessionSharingHeaders(target);
  assert.deepEqual(Object.keys(headers), ['x-readymade-project', 'x-readymade-project-peer']); assert.equal(headers['x-readymade-project-peer'], '~nec');
  assert.equal(Buffer.from(headers['x-readymade-project'], 'latin1').toString('utf8'), target.project);
});

test('a receipt says what was sent and never confirms; refusals are only the ship’s exact ones', () => {
  assert.deepEqual(sessionSharingReceipt(202, receipt(), share), {status: 'submitted', operation: 'share', pokes: 1, confirmed: false});
  assert.equal(sessionSharingReceipt(202, receipt('remove', 'submitted', 3), remove).pokes, 3); assert.equal(sessionSharingReceipt(202, receipt('unshare', 'unchanged', 0), unshare).status, 'unchanged');
  for (const [value, command, status] of [[receipt(), share, 200], [receipt('unshare'), share, 202], [{...receipt(), confirmed: true}, share, 202], [receipt('share', 'submitted', 0), share, 202],
    [receipt('share', 'unchanged', 1), share, 202], [receipt('share', 'done', 1), share, 202], [receipt('share', 'submitted', 1.5), share, 202], [receipt('share', 'submitted', -1), share, 202],
    [receipt('share', 'submitted', 257), share, 202], [{...receipt(), schema: 'readymade-session-sharing-v1'}, share, 202], [{...receipt(), session: id}, share, 202], [{...receipt(), pokes: '1'}, share, 202]] as const)
    assert.throws(() => sessionSharingReceipt(status, value, command));
  for (const message of SESSION_SHARING_REASONS) for (const post of [true, false]) assert.equal(sessionSharingRefusal(409, {status: 'refused', message}, post), message);
  assert.equal(sessionSharingRefusal(400, {status: 'refused', message: 'Explicit owner-origin session sharing command required.'}, true), 'session-sharing-command-required');
  assert.equal(sessionSharingRefusal(400, {status: 'refused', message: 'Project and peer required.'}, false), 'session-sharing-selector-required');
  assert.equal(sessionSharingRefusal(503, {status: 'unavailable', message: 'Session sharing state unavailable.'}, true), 'session-sharing-unavailable');
  for (const [status, body, post] of [[409, {status: 'refused', message: 'view-capacity'}, true], [409, {status: 'refused', message: 'session-sharing-self', extra: 1}, true],
    [409, {status: 'unavailable', message: 'session-sharing-self'}, true], [400, {status: 'refused', message: 'Project and peer required.'}, true], [503, {status: 'unavailable', message: 'Sharing state unavailable.'}, false],
    [500, {status: 'refused', message: 'session-sharing-self'}, true], [409, null, true], [409, {status: 'refused', message: 5}, false]] as const) assert.equal(sessionSharingRefusal(status, body, post), undefined);
});

test('the requested state holds only when a read shows it', () => {
  assert.equal(sessionSharingHolds(share, decode(state([row(id, true)]))), true); assert.equal(sessionSharingHolds(share, decode(state())), false);
  assert.equal(sessionSharingHolds(unshare, decode(state())), true); assert.equal(sessionSharingHolds(unshare, decode(state([row(id, true)]))), false);
  for (const command of [share, unshare]) assert.equal(sessionSharingHolds(command, decode(state([row('0x1', true)]))), false); // A session that is not listed proves nothing.
  assert.equal(sessionSharingHolds(remove, decode(gone())), true); assert.equal(sessionSharingHolds(remove, decode(state())), false);
  assert.equal(sessionSharingHolds(remove, decode({...gone(), viewGrant: 'live'})), false); assert.equal(sessionSharingHolds(remove, decode(state([row(id, true)], {member: false, role: null, inspectable: false}))), false);
});

/** A scripted ship: each read returns the next standing (the last one repeats); submissions are counted, never implied. */
function scripted(reads: (object | Error)[], submit: SessionSharingReceipt | Error) {
  const calls = {reads: 0, submits: 0};
  const client: SessionSharingClient = {
    sessionSharingRead: async (project, peer) => {
      assert.deepEqual([project, peer], [target.project, target.peer]);
      const next = reads[Math.min(calls.reads++, reads.length - 1)]; if (next instanceof Error) throw next; return decode(next);
    },
    sessionSharingSubmit: async () => {calls.submits++; if (submit instanceof Error) throw submit; return submit;}};
  return {client, calls};
}
const none = async () => {}, sent = (operation: string, status = 'submitted', pokes = 1) => receipt(operation, status, pokes) as SessionSharingReceipt;

test('submit-then-confirm settles as confirmed, unchanged or not confirmed, and sends exactly once', async () => {
  const shown: boolean[] = [], confirmed = scripted([state(), state(), state([row(id, true)])], sent('share'));
  const first = await sessionSharingSettle(confirmed.client, share, snapshot => shown.push(snapshot.sessions[0].shared), none);
  assert.deepEqual([first.status, 'holds' in first && first.holds], ['confirmed', true]); assert.deepEqual(confirmed.calls, {reads: 3, submits: 1}); assert.deepEqual(shown, [false, false, true]);
  assert.equal('snapshot' in first && first.snapshot?.sessions[0].shared, true);
  const unchanged = scripted([state()], sent('unshare', 'unchanged', 0));
  assert.equal((await sessionSharingSettle(unchanged.client, unshare, undefined, none)).status, 'unchanged'); assert.deepEqual(unchanged.calls, {reads: 1, submits: 1});
  const removed = scripted([state(), gone()], sent('remove', 'submitted', 3));
  assert.equal((await sessionSharingSettle(removed.client, remove, undefined, none)).status, 'confirmed'); assert.deepEqual(removed.calls, {reads: 2, submits: 1});
  for (const reply of [sent('share'), sent('share', 'unchanged', 0)]) {
    const never = scripted([state()], reply), outcome = await sessionSharingSettle(never.client, share, undefined, none);
    assert.deepEqual([outcome.status, 'holds' in outcome && outcome.holds], ['not-confirmed', false]); assert.deepEqual(never.calls, {reads: 11, submits: 1}); // About ten seconds of reads; no resend.
  }
  const timed = scripted([state()], sent('share'));
  assert.equal((await sessionSharingSettle(timed.client, share, undefined, none, 0)).status, 'not-confirmed'); assert.deepEqual(timed.calls, {reads: 1, submits: 1});
  const flaky = scripted([new Error('read lost'), new Error('read lost'), state([row(id, true)])], sent('share'));
  assert.equal((await sessionSharingSettle(flaky.client, share, undefined, none)).status, 'confirmed'); assert.deepEqual(flaky.calls, {reads: 3, submits: 1});
  const blind = scripted([new Error('read lost')], sent('share')), dark = await sessionSharingSettle(blind.client, share, undefined, none);
  assert.deepEqual(dark, {status: 'not-confirmed', holds: false}); assert.equal(blind.calls.submits, 1);
});

test('a refusal is final, an unknown submission is only read, and an unsent command is rethrown', async () => {
  const refused = scripted([state()], new SessionSharingRefusedError(409, 'session-sharing-not-inspectable'));
  assert.deepEqual(await sessionSharingSettle(refused.client, share, undefined, none), {status: 'refused', reason: 'session-sharing-not-inspectable'}); assert.deepEqual(refused.calls, {reads: 0, submits: 1});
  const plain = scripted([state()], new ShipClientError('refused', 400));
  assert.deepEqual(await sessionSharingSettle(plain.client, share, undefined, none), {status: 'refused', reason: 'refused'});
  for (const [reads, holds] of [[[state([row(id, true)])], true], [[state()], false]] as const) {
    const lost = scripted([...reads], new OutcomeUnknownError()), outcome = await sessionSharingSettle(lost.client, share, undefined, none);
    assert.deepEqual([outcome.status, 'holds' in outcome && outcome.holds], ['unknown', holds]); assert.equal(lost.calls.submits, 1); assert.equal(lost.calls.reads, holds ? 1 : 11);
  }
  for (const error of [new ShipClientError('commandBusy'), new ShipClientError('authenticationRequired', 403), new Error('offline before sending')]) {
    const unsent = scripted([state()], error);
    await assert.rejects(sessionSharingSettle(unsent.client, share, undefined, none), e => e === error); assert.deepEqual(unsent.calls, {reads: 0, submits: 1});
  }
  const invalid = scripted([state()], sent('share'));
  await assert.rejects(sessionSharingSettle(invalid.client, {...share, session: '0x0'}, undefined, none)); assert.deepEqual(invalid.calls, {reads: 0, submits: 0});
  const stopped = scripted([state()], sent('share'));
  await assert.rejects(sessionSharingSettle(stopped.client, share, () => {throw new Error('project changed');}, none), /project changed/); assert.deepEqual(stopped.calls, {reads: 1, submits: 1});
  const again = scripted([state(), state([row(id, true)])], sent('share'));
  assert.deepEqual(await sessionSharingConfirm(again.client, share, undefined, none, 0), {holds: false, snapshot: decode(state())}); assert.equal(again.calls.submits, 0); // "Check again" only reads.
});

test('outcomes read as plain sentences that never claim more than a read showed', () => {
  const seen = decode(state());
  assert.equal(sessionSharingMessage(share, {status: 'confirmed', holds: true, snapshot: seen}, '0x5e55.2002'), 'Session 0x5e55.2002 is now shared with ~nec.');
  assert.equal(sessionSharingMessage(share, {status: 'unchanged', holds: true}), 'Session 0x5e55.2002 was already shared with ~nec.');
  assert.equal(sessionSharingMessage(unshare, {status: 'confirmed', holds: true}), 'Session 0x5e55.2002 is no longer shared with ~nec.');
  assert.equal(sessionSharingMessage(remove, {status: 'confirmed', holds: true}), '~nec was removed from café-共同.');
  assert.match(sessionSharingMessage(share, {status: 'not-confirmed', holds: false}), /^Not confirmed yet\..*nothing was resent\.$/);
  assert.match(sessionSharingMessage(remove, {status: 'unknown', holds: false}), /may not have reached your ship\. Your ship does not show the change\..*nothing was resent\.$/);
  assert.match(sessionSharingMessage(remove, {status: 'unknown', holds: true}), /Your ship shows the requested state\./);
  for (const reason of [...SESSION_SHARING_REASONS, 'session-sharing-unavailable']) {
    const text = sessionSharingMessage(share, {status: 'refused', reason});
    assert.match(text, /^Your ship refused\. .+ Nothing was changed\.$/); assert.equal(text.includes(reason), false);
  }
  assert.match(sessionSharingMessage(share, {status: 'refused', reason: 'something-new'}), /Reason: something-new\./);
});

type Capture = {method: string; url: string; headers: http.IncomingHttpHeaders; body: string};
type Step = (capture: Capture, response: http.ServerResponse) => void;
const json = (r: http.ServerResponse, body: unknown, status = 200) => {r.writeHead(status, {'content-type': 'application/json'}); r.end(JSON.stringify(body));};
async function fixture(run: (client: ShipClient, steps: Step[], captures: Capture[]) => Promise<void>, cookies = ['urbauth-~zod=fixture; Path=/']): Promise<void> {
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
const posts = (captures: Capture[]) => captures.filter(c => c.method === 'POST' && c.url === '/apps/readymade-collab/session-sharing').length;
const refusedAs = (reason: string, status: number) => (e: unknown) => e instanceof SessionSharingRefusedError && e.code === 'refused' && e.reason === reason && e.status === status;

test('real HTTP reads one standing by exact headers as the signed-in owner', () => fixture(async (client, steps, captures) => {
  steps.push((_c, r) => json(r, state([row(id, true)]))); const seen = await client.sessionSharingRead(target.project, target.peer);
  assert.equal(seen.sessions[0].shared, true); assert.equal(seen.owner, '~zod'); const get = captures.at(-1)!;
  assert.equal(get.method, 'GET'); assert.equal(get.url, '/apps/readymade-collab/session-sharing'); assert.equal(get.body, '');
  assert.equal(get.headers.cookie, 'urbauth-~zod=fixture'); assert.equal(get.headers['x-readymade-project-peer'], '~nec');
  assert.equal(Buffer.from(get.headers['x-readymade-project'] as string, 'latin1').toString('utf8'), target.project); assert.equal(client.snapshot, undefined);
  steps.push((_c, r) => json(r, {status: 'refused', message: 'session-sharing-project-missing'}, 409));
  await assert.rejects(client.sessionSharingRead(target.project, target.peer), refusedAs('session-sharing-project-missing', 409));
  steps.push((_c, r) => json(r, {status: 'unavailable', message: 'Session sharing state unavailable.'}, 503));
  await assert.rejects(client.sessionSharingRead(target.project, target.peer), refusedAs('session-sharing-unavailable', 503));
  steps.push((_c, r) => json(r, {status: 'refused', message: 'Owner login required.'}, 403));
  await assert.rejects(client.sessionSharingRead(target.project, target.peer), e => e instanceof ShipClientError && e.code === 'authenticationRequired');
  for (const [body, status, code] of [[state([], {owner: '~wes'}), 200, 'malformed'], [state([], {peer: '~wes'}), 200, 'malformed'], [state([row(id, true, {inspection: null})]), 200, 'malformed'],
    [{status: 'missing', message: 'No such route.'}, 404, 'unavailable'], [{status: 'refused', message: 'something-new'}, 409, 'unavailable']] as const) {
    steps.push((_c, r) => json(r, body, status)); await assert.rejects(client.sessionSharingRead(target.project, target.peer), e => e instanceof ShipClientError && e.code === code);
  }
  steps.push((_c, r) => {r.writeHead(302, {location: '/elsewhere'}); r.end();});
  await assert.rejects(client.sessionSharingRead(target.project, target.peer), e => e instanceof ShipClientError && e.code === 'redirectRefused');
  const before = captures.length;
  await assert.rejects(client.sessionSharingRead(target.project, '~zod')); await assert.rejects(client.sessionSharingRead('bad:project', '~nec')); assert.equal(captures.length, before);
}));

test('real HTTP sends exactly six colon-free keys once and returns a receipt that confirms nothing', () => fixture(async (client, steps, captures) => {
  steps.push((_c, r) => json(r, receipt(), 202)); assert.deepEqual(await client.sessionSharingSubmit(share), {status: 'submitted', operation: 'share', pokes: 1, confirmed: false});
  const post = captures.at(-1)!;
  assert.equal(post.method, 'POST'); assert.equal(post.url, '/apps/readymade-collab/session-sharing'); assert.equal(post.headers.origin, client.origin);
  assert.equal(post.headers.cookie, 'urbauth-~zod=fixture'); assert.equal(post.headers['content-type'], 'application/json'); assert.equal(post.headers['x-readymade-session-sharing'], 'v1');
  assert.deepEqual(JSON.parse(post.body), {schema: 'readymade-session-sharing-command-v1', ...share});
  assert.equal(post.body.split(':').length - 1, 6); // The ship counts colons to prove six plain keys.
  steps.push((_c, r) => json(r, receipt('remove', 'unchanged', 0), 202)); assert.equal((await client.sessionSharingSubmit(remove)).status, 'unchanged');
  assert.equal(JSON.parse(captures.at(-1)!.body).session, '0x0');
  for (const reason of ['session-sharing-not-inspectable', 'session-sharing-session-missing', 'session-sharing-self']) {
    steps.push((_c, r) => json(r, {status: 'refused', message: reason}, 409)); await assert.rejects(client.sessionSharingSubmit(share), refusedAs(reason, 409));
  }
  steps.push((_c, r) => json(r, {status: 'refused', message: 'Explicit owner-origin session sharing command required.'}, 400));
  await assert.rejects(client.sessionSharingSubmit(share), refusedAs('session-sharing-command-required', 400));
  steps.push((_c, r) => json(r, {status: 'unavailable', message: 'Session sharing state unavailable.'}, 503));
  await assert.rejects(client.sessionSharingSubmit(share), refusedAs('session-sharing-unavailable', 503));
  steps.push((_c, r) => json(r, {status: 'refused', message: 'Owner login required.'}, 403));
  await assert.rejects(client.sessionSharingSubmit(share), e => e instanceof ShipClientError && e.code === 'authenticationRequired');
  const before = captures.length;
  await assert.rejects(client.sessionSharingSubmit({...share, owner: '~wes'}), e => e instanceof ShipClientError && e.code === 'contextChanged');
  await assert.rejects(client.sessionSharingSubmit({...remove, session: id})); await assert.rejects(client.sessionSharingSubmit({...share, session: '0x0'}));
  await assert.rejects(client.sessionSharingSubmit({...share, peer: '~zod'})); assert.equal(captures.length, before);
}));

test('an unknown submission is reported as unknown and is never replayed by the client', async () => {
  for (const step of [((_c, r) => r.socket!.destroy()) as Step, ((_c, r) => {r.writeHead(302, {location: '/elsewhere'}); r.end();}) as Step, ((_c, r) => json(r, receipt(), 200)) as Step,
    ((_c, r) => json(r, {...receipt(), confirmed: true}, 202)) as Step, ((_c, r) => json(r, receipt('unshare'), 202)) as Step, ((_c, r) => json(r, {status: 'refused', message: 'something-new'}, 409)) as Step,
    ((_c, r) => {r.writeHead(202, {'content-type': 'text/html'}); r.end(JSON.stringify(receipt()));}) as Step,
    ((_c, r) => {r.writeHead(202, {'content-type': 'application/json'}); r.end(JSON.stringify(receipt()).replace('{', '{"pokes":1,'));}) as Step]) await fixture(async (client, steps, captures) => {
    steps.push(step); await assert.rejects(client.sessionSharingSubmit(share), OutcomeUnknownError); assert.equal(posts(captures), 1);
    // The ship keeps no journal for these commands: a second submission is the owner's explicit choice, so nothing is held.
    steps.push((_c, r) => json(r, receipt('share', 'unchanged', 0), 202)); assert.equal((await client.sessionSharingSubmit(share)).status, 'unchanged'); assert.equal(posts(captures), 2);
  });
});

test('over real HTTP one share is sent once and confirmed by a later read; a lost reply is only read', async () => {
  await fixture(async (client, steps, captures) => {
    steps.push((_c, r) => json(r, receipt(), 202), (_c, r) => json(r, state()), (_c, r) => json(r, state([row(id, true)])));
    const outcome = await sessionSharingSettle(client, share, undefined, none);
    assert.equal(outcome.status, 'confirmed'); assert.equal(posts(captures), 1); assert.equal(captures.filter(c => c.method === 'GET').length, 2);
  });
  await fixture(async (client, steps, captures) => {
    steps.push((_c, r) => r.socket!.destroy(), (_c, r) => json(r, gone()));
    const outcome = await sessionSharingSettle(client, remove, undefined, none);
    assert.deepEqual([outcome.status, 'holds' in outcome && outcome.holds], ['unknown', true]); assert.equal(posts(captures), 1);
  });
  await fixture(async (client, steps, captures) => {
    steps.push((_c, r) => json(r, {status: 'refused', message: 'session-sharing-not-inspectable'}, 409));
    assert.deepEqual(await sessionSharingSettle(client, share, undefined, none), {status: 'refused', reason: 'session-sharing-not-inspectable'}); assert.equal(captures.length, 2);
  });
});

test('an ambiguous signed-in identity is rejected before dispatch', () => fixture(async (client, _steps, captures) => {
  await assert.rejects(client.sessionSharingRead(target.project, target.peer), e => e instanceof ShipClientError && e.code === 'authenticationRequired');
  await assert.rejects(client.sessionSharingSubmit(share), e => e instanceof ShipClientError && e.code === 'authenticationRequired'); assert.equal(captures.length, 1);
}, ['urbauth-~zod=fixture; Path=/', 'urbauth-~wes=fixture; Path=/']));

test('the project-wide setting decodes, commands name no session, holds reads the setting, and messages say what changed', () => {
  for (const sessionSharing of ['unregistered', 'off', 'on'] as const) assert.equal(decode(state([], {inspectable: false, sessionSharing})).sessionSharing, sessionSharing);
  const on: SessionSharingCommand = {...target, operation: 'sharing-on', session: '0x0'}, off: SessionSharingCommand = {...on, operation: 'sharing-off'};
  assert.deepEqual(sessionSharingCommand(on), on); assert.deepEqual(sessionSharingCommand(off), off);
  for (const bad of [{...on, session: id}, {...off, session: '0x1'}, {...on, operation: 'sharing'}]) assert.throws(() => sessionSharingCommand(bad));
  assert.equal(sessionSharingHolds(on, decode(state())), true); assert.equal(sessionSharingHolds(off, decode(state())), false);
  const closed = decode(state([], {inspectable: false, sessionSharing: 'off'}));
  assert.equal(sessionSharingHolds(off, closed), true); assert.equal(sessionSharingHolds(on, closed), false);
  assert.equal(sessionSharingReceipt(202, receipt('sharing-off'), off).operation, 'sharing-off');
  assert.throws(() => sessionSharingReceipt(202, receipt('policy'), off));
  assert.match(sessionSharingMessage(on, {status: 'confirmed', holds: true}), /can now be shared/);
  assert.match(sessionSharingMessage(off, {status: 'confirmed', holds: true}), /every shared session stopped at once/);
  assert.match(sessionSharingMessage(off, {status: 'unchanged', holds: true}), /already off/);
  assert.match(sessionSharingMessage(on, {status: 'refused', reason: 'session-sharing-policy-invalid'}), /could not change this project's policy/);
  assert.match(sessionSharingMessage(off, {status: 'refused', reason: 'session-sharing-project-not-private'}), /readable by other ships/);
  assert.equal(decode(state([], {sessionSharingBlocked: 'project-not-private'})).sessionSharingBlocked, 'project-not-private');
  assert.throws(() => decode(state([], {inspectable: false, sessionSharing: 'unregistered', sessionSharingBlocked: 'work-not-isolated'})));
});
