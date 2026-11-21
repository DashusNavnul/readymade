import test from 'node:test';
import assert from 'node:assert/strict';
import type {InvitationResult} from '../src/project-invitations';
import {catalogFailureWords, joinedCandidates, joinedProjectWords, observedWhen, ownerAnswer, readRequestCatalog, type CatalogFailure} from '../src/project-membership';
import type {RemoteProjectSessionsReply} from '../src/remote-project-sessions';
import {ShipClient, ShipClientError} from '../src/ship-client';
import {createServer} from 'node:http';
import {once} from 'node:events';

const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const outcomes: Record<string, string> = {join: 'project-joined', leave: 'project-left', 'invite-member': 'project-invited'};
function row(n: number, operation = 'join', status = 'accepted', authority = '~wes', project = 'demo') {
  return {schema: 'readymade-project-invitation-result-v1', request: uuid(n), authority, project, operation, digest: '0x456', status,
    permissionGranted: false, outcome: status === 'accepted' ? outcomes[operation] : status === 'refused' ? 'native-refused' : null};
}
/** A ship that serves `rows` as its own request list, 64 to a page, each later page bound to the digest of the first. */
function ship(rows: () => unknown[], digest: () => string = () => '0x9') {
  const asked: {offset?: number; catalog?: string}[] = [];
  return {asked, projectInvitation: async (_operation: string, value: {offset?: number; catalog?: string}) => {
    asked.push({...value});
    const all = rows(), offset = value.offset ?? 0, catalog = digest();
    if (value.catalog !== undefined && value.catalog !== catalog) return {status: 409, body: {status: 'refused', message: 'invitation-catalog-stale'}};
    const requests = all.slice(offset, offset + 64), end = offset + requests.length;
    return {status: 200, body: {schema: 'readymade-project-invitation-catalog-v1', owner: '~nec', permissionGranted: false, catalog, offset, total: all.length, next: end === all.length ? null : end, requests}};
  }};
}
type Reader = Parameters<typeof readRequestCatalog>[0];

test('the request list is read whole, every later page bound to the first page\'s digest', async () => {
  const rows = Array.from({length: 130}, (_, n) => row(n + 1, 'join', 'accepted', '~wes', 'p' + n)), served = ship(() => rows);
  const read = await readRequestCatalog(served as unknown as Reader, '~nec');
  assert.equal(read.status, 'complete');
  assert.equal(read.status === 'complete' && read.requests.length, 130);
  assert.deepEqual(served.asked, [{}, {offset: 64, catalog: '0x9'}, {offset: 128, catalog: '0x9'}]);
  const empty = await readRequestCatalog(ship(() => []) as unknown as Reader, '~nec');
  assert.deepEqual(empty, {status: 'complete', catalog: '0x9', requests: []});
});

test('a list that changes while it is read is read again from the start, and never returned in part', async () => {
  const rows = Array.from({length: 70}, (_, n) => row(n + 1, 'join', 'accepted', '~wes', 'p' + n));
  let reads = 0;
  // The digest changes once, after the first page: the second page is refused as stale and the read starts over.
  const once = ship(() => rows, () => reads++ === 0 ? '0x9' : '0xa');
  const again = await readRequestCatalog(once as unknown as Reader, '~nec');
  assert.equal(again.status === 'complete' && again.catalog, '0xa');
  assert.equal(again.status === 'complete' && again.requests.length, 70);
  assert.deepEqual(once.asked, [{}, {offset: 64, catalog: '0x9'}, {}, {offset: 64, catalog: '0xa'}]);
  // A list that never holds still is given up after two reads; what was read so far is discarded.
  let n = 0; const restless = ship(() => rows, () => '0x' + (++n).toString(16));
  assert.deepEqual(await readRequestCatalog(restless as unknown as Reader, '~nec'), {status: 'unavailable', reason: 'changed'});
  assert.equal(restless.asked.length, 4);
});

test('an unverifiable, unsupported or unanswered list is unavailable, with its reason, never an empty list', async () => {
  const good = Array.from({length: 70}, (_, n) => row(n + 1, 'join', 'accepted', '~wes', 'p' + n));
  const reason = async (client: unknown, actor = '~nec') => {
    const read = await readRequestCatalog(client as Reader, actor);
    assert.equal(read.status, 'unavailable'); return read.status === 'unavailable' ? read.reason : undefined;
  };
  // Another ship's list, a page of the wrong size, a request repeated on a later page, a total that moves under one digest.
  assert.equal(await reason(ship(() => good), '~bud'), 'malformed');
  const page = async (alter: (body: Record<string, unknown>, offset: number) => void) => {
    const served = ship(() => good);
    return reason({projectInvitation: async (operation: string, value: {offset?: number; catalog?: string}) => {
      const reply = await served.projectInvitation(operation, value); alter(reply.body as Record<string, unknown>, value.offset ?? 0); return reply;
    }});
  };
  assert.equal(await page(body => {(body.requests as unknown[]).pop();}), 'malformed');
  assert.equal(await page((body, offset) => {if (offset) (body.requests as unknown[])[0] = good[0];}), 'malformed');
  assert.equal(await page((body, offset) => {if (offset) {body.total = 71; body.next = 70;}}), 'malformed');
  assert.equal(await page(body => {body.permissionGranted = true;}), 'malformed');
  const answer = (status: number, body: unknown) => ({projectInvitation: async () => ({status, body})});
  assert.equal(await reason(answer(404, {status: 'missing', message: 'x'})), 'unsupported');
  assert.equal(await reason(answer(409, {status: 'refused', message: 'invitation-catalog-capacity'})), 'capacity');
  assert.equal(await reason(answer(409, {status: 'refused', message: 'invitation-catalog-cursor'})), 'malformed');
  assert.equal(await reason(answer(503, {status: 'unavailable', message: 'x'})), 'unreachable');
  const fails = (error: unknown) => ({projectInvitation: async () => {throw error;}});
  assert.equal(await reason(fails(new ShipClientError('transport'))), 'unreachable');
  assert.equal(await reason(fails(new ShipClientError('commandBusy'))), 'unreachable');
  assert.equal(await reason(fails(new ShipClientError('malformed'))), 'malformed');
  assert.equal(await reason(fails(new ShipClientError('authenticationRequired'))), 'signed-out');
  assert.equal(await reason(fails(new Error('socket'))), 'unreachable');
  // The connection changed after the first page: nothing read for the old one is returned.
  let live = true; const served = ship(() => good);
  const switched = await readRequestCatalog({projectInvitation: async (operation: string, value: {offset?: number; catalog?: string}) => {
    const reply = await served.projectInvitation(operation, value); live = false; return reply;
  }} as unknown as Reader, '~nec', () => live);
  assert.deepEqual(switched, {status: 'unavailable', reason: 'changed'}); assert.equal(served.asked.length, 1);
  for (const failure of ['unsupported', 'changed', 'unreachable', 'malformed', 'capacity', 'signed-out'] as CatalogFailure[]) assert.doesNotMatch(catalogFailureWords(failure), /no projects|not joined/i);
});

test('only a join that was not refused names a project to ask about; the list never decides membership', () => {
  const rows = (...values: unknown[]) => values as unknown as InvitationResult[];
  const names = (values: InvitationResult[]) => joinedCandidates(values, '~nec').map(c => `${c.authority}/${c.project}:${c.evidence}${c.leaving ? ':leaving' : ''}`);
  assert.deepEqual(names(rows(row(1))), ['~wes/demo:accepted']);
  assert.deepEqual(names(rows(row(1, 'join', 'refused'))), []);
  for (const status of ['prepared', 'submitted', 'unknown']) assert.deepEqual(names(rows(row(1, 'join', status))), ['~wes/demo:unresolved']);
  assert.deepEqual(names(rows(row(1, 'join', 'unknown'), row(2, 'join', 'accepted'), row(3, 'join', 'refused'))), ['~wes/demo:accepted']);
  // Joined, left, joined again and "changed role, then left" hold the same rows: both stay candidates for the owner to decide.
  assert.deepEqual(names(rows(row(1), row(2, 'leave'), row(3))), ['~wes/demo:accepted']);
  assert.deepEqual(names(rows(row(1), row(2), row(3, 'leave'))), ['~wes/demo:accepted']);
  // Only a leave the ship sent and has no answer for stops another leave, as on the ship itself.
  assert.deepEqual(names(rows(row(1), row(2, 'leave', 'submitted'))), ['~wes/demo:accepted:leaving']);
  for (const status of ['prepared', 'unknown', 'refused', 'accepted']) assert.deepEqual(names(rows(row(1), row(2, 'leave', status))), ['~wes/demo:accepted']);
  // This ship's own projects and its invitations to others are not joined projects; a leave alone names nothing.
  assert.deepEqual(names(rows(row(1, 'join', 'accepted', '~nec'), row(2, 'invite-member', 'accepted', '~nec'), row(3, 'leave', 'accepted', '~bud', 'other'))), []);
  assert.deepEqual(names(rows(row(1, 'join', 'accepted', '~wes', 'zeta'), row(2, 'join', 'accepted', '~bud', 'beta'), row(3, 'join', 'accepted', '~wes', 'alpha'))),
    ['~bud/beta:accepted', '~wes/alpha:accepted', '~wes/zeta:accepted']);
});

test('only an answered read of the owner is membership; refusal and silence are worded as what they are', () => {
  const base = {owner: '~wes', project: 'demo', request: '0x1', peer: '~nec', permissionGranted: false as const};
  const held = {deadline: '~2026.11.20..22.42.33', retainedUntil: '~2026.11.20..22.47.33'};
  const ready = {...base, ...held, status: 'ready', reason: 'observed', observation: {owner: '~wes', peer: '~nec', observedAt: '~2026.11.20..22.42.03..2cbc', truncated: false, sessions: []}} as RemoteProjectSessionsReply;
  assert.deepEqual(ownerAnswer(ready), {standing: 'member', observedAt: '~2026.11.20..22.42.03..2cbc'});
  assert.deepEqual(ownerAnswer({...base, ...held, status: 'refused', reason: 'watch-refused', observation: null}), {standing: 'unconfirmed'});
  for (const status of ['uncertain', 'pending'] as const) assert.deepEqual(ownerAnswer({...base, ...held, status, reason: 'x', observation: null}), {standing: 'unreachable'});
  for (const status of ['missing', 'expired'] as const) assert.deepEqual(ownerAnswer({...base, status}), {standing: 'unreachable'});
  assert.deepEqual(ownerAnswer(undefined), {standing: 'unreachable'});
  assert.equal(observedWhen('~2026.11.20..22.42.03..2cbc'), '2026-11-20 22:42 UTC'); assert.equal(observedWhen('~2026.11.20'), '2026-11-20');
  const project = {authority: '~wes', project: 'demo', evidence: 'accepted' as const, leaving: false};
  assert.match(joinedProjectWords({...project, standing: 'member', observedAt: '~2026.11.20..22.42.03..2cbc'}).tooltip, /confirmed this ship as a member at 2026-11-20 22:42 UTC.*granted separately/);
  assert.match(joinedProjectWords({...project, standing: 'unconfirmed'}).description, /not confirmed/);
  assert.match(joinedProjectWords({...project, standing: 'unconfirmed'}).tooltip, /left or been removed.*Nothing was sent/);
  assert.match(joinedProjectWords({...project, evidence: 'unresolved', standing: 'unreachable'}).tooltip, /never learned the result/);
  for (const standing of ['checking', 'unconfirmed', 'unreachable', 'unchecked'] as const) assert.doesNotMatch(joinedProjectWords({...project, standing}).description, /· member$/);
});

test('the real client over HTTP: pages bound by header, a stale refusal restarts the read, and an owner\'s answer or refusal is read as what it is', async t => {
  // A ship on a local port: its request list (70 requests, changing once mid-read) and the shared-session list read for two owners.
  const rows = Array.from({length: 70}, (_, n) => row(n + 1, 'join', 'accepted', '~wes', 'p' + n));
  let digest = '0x9', pages = 0; const asked: string[] = [], seen: string[] = [];
  const held = {deadline: '~2026.11.20..22.42.33', retainedUntil: '~2026.11.20..22.47.33'};
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/~/login') {res.setHeader('set-cookie', 'urbauth-~nec=fixture; Path=/'); res.end('{}'); return;}
    seen.push(`${req.method} ${req.url}`);
    if (req.url === '/apps/readymade-collab/project-invitation-requests') {
      const offset = Number(req.headers['x-readymade-invitation-offset']), catalog = req.headers['x-readymade-invitation-catalog'];
      if (++pages === 2) digest = '0xa';                       // The list changes after the first page was served.
      if (catalog !== undefined && catalog !== digest) {res.statusCode = 409; res.end(JSON.stringify({status: 'refused', message: 'invitation-catalog-stale'})); return;}
      const requests = rows.slice(offset, offset + 64), end = offset + requests.length;
      res.end(JSON.stringify({schema: 'readymade-project-invitation-catalog-v1', owner: '~nec', permissionGranted: false, catalog: digest, offset, total: rows.length, next: end === rows.length ? null : end, requests}));
      return;
    }
    const answer = (owner: string, project: string, request: string, status: string) => ({schema: 'readymade-project-sessions-result-v1', owner, peer: '~nec', project, request,
      status, reason: status === 'pending' ? 'awaiting-owner' : status === 'ready' ? 'observed' : 'watch-refused', ...held, permissionGranted: false,
      observation: status === 'ready' ? {owner, peer: '~nec', observedAt: '~2026.11.20..22.42.03..2cbc', truncated: false, sessions: []} : null});
    if (req.url === '/apps/readymade-collab/project-sessions') {
      let raw = ''; req.on('data', chunk => {raw += chunk;}); req.on('end', () => {
        const body = JSON.parse(raw) as {owner: string; project: string}; asked.push(`${body.owner}/${body.project}`);
        res.statusCode = 202; res.end(JSON.stringify(answer(body.owner, body.project, '0x1', 'pending')));
      }); return;
    }
    const owner = String(req.headers['x-readymade-project-owner']), project = String(req.headers['x-readymade-project']);
    res.end(JSON.stringify(answer(owner, project, String(req.headers['x-readymade-project-sessions-request']), owner === '~wes' ? 'ready' : 'refused')));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ShipClient(`http://127.0.0.1:${address.port}`, async () => 'fixture');
  t.after(async () => {client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));});
  await client.signIn();
  const read = await readRequestCatalog(client, '~nec');
  assert.equal(read.status === 'complete' && read.catalog, '0xa'); assert.equal(read.status === 'complete' && read.requests.length, 70);
  assert.equal(seen.filter(line => line.endsWith('project-invitation-requests')).length, 4);       // Page one, the refused page two, then both again.
  // The owner that holds this ship as a member answers; the other refuses. Each is asked once; nothing but reads follow.
  const member = await client.projectSessionsSubmit('~wes', 'p0'); assert.equal(member.status, 'pending');
  assert.deepEqual(ownerAnswer(await client.projectSessionsResult('~wes', 'p0', member.request)), {standing: 'member', observedAt: '~2026.11.20..22.42.03..2cbc'});
  const stranger = await client.projectSessionsSubmit('~bud', 'p1');
  assert.deepEqual(ownerAnswer(await client.projectSessionsResult('~bud', 'p1', stranger.request)), {standing: 'unconfirmed'});
  assert.deepEqual(asked, ['~wes/p0', '~bud/p1']);
  assert.equal(seen.some(line => line.startsWith('POST') && !line.endsWith('/project-sessions')), false);
  // Another ship's list under this login is refused by the client itself, so the read reports it unavailable.
  assert.deepEqual(await readRequestCatalog(client, '~bud'), {status: 'unavailable', reason: 'malformed'});
});
