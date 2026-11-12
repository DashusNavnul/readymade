import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {invitationCommand, leavableJoins, invitationResult, invitationMembers, invitationCatalog, type InvitationCommand, eventSentence, type EventRow} from '../src/project-invitations';
import {InvitationJournal, type InvitationIntent} from '../src/project-invitation-journal';
import {OutcomeUnknownError, ShipClient, ShipClientError} from '../src/ship-client';
const command: InvitationCommand = {request: '01234567-89ab-4cde-8fab-0123456789ab', authority: '~wes', project: 'demo', operation: 'join', invitation: '0x123'};
const result = {schema: 'readymade-project-invitation-result-v1', request: command.request, authority: command.authority, project: command.project, operation: command.operation,
  digest: '0x456', status: 'accepted', permissionGranted: false, outcome: 'project-joined'};
const members = {schema: 'readymade-project-members-v1', project: 'demo', authority: '~wes', permissionGranted: false, inviteUntil: '~2026.11.10', kind: 'invitations', catalog: '0x9', offset: 0, total: 1, next: null,
  rows: [{id: '0x123', target: '~nec', role: 'contributor', issuedBy: '~wes', expiresAt: '~2026.11.10', expired: false}]};
test('invitation codecs bind native actions, canonical atoms and complete pinned pages', () => {
  assert.deepEqual(invitationCommand(command), command); assert.equal(invitationResult(result, command).outcome, 'project-joined');
  for (const delta of [{request: 'bad'}, {invitation: '0x0'}, {invitation: '0x12345'}, {extra: true}]) assert.throws(() => invitationCommand({...command, ...delta}));
  const invite = {request: command.request, authority: '~wes', project: 'demo', operation: 'invite-member', target: '~nec', role: 'contributor', expiresAt: '~2026.11.09', nonce: '0x' + Array(16).fill('ffff').join('.')};
  assert.equal(invitationCommand(invite).operation, 'invite-member');
  for (const expiresAt of ['~2026.02.30', '~2026.11.09..29.00.00', '~2026.11.9']) assert.throws(() => invitationCommand({...invite, expiresAt}));
  for (const delta of [{request: '11234567-89ab-4cde-8fab-0123456789ab'}, {authority: '~bud'}, {operation: 'invite-member'}, {outcome: 'project-invited'}, {status: 'submitted'}, {permissionGranted: true}, {extra: 1}]) assert.throws(() => invitationResult({...result, ...delta}, command));
  const leave = {request: command.request, authority: command.authority, project: command.project, operation: 'leave'};
  assert.deepEqual(invitationCommand(leave), leave);
  for (const delta of [{invitation: '0x1'}, {target: '~nec'}, {project: ''}]) assert.throws(() => invitationCommand({...leave, ...delta}));
  const left = {...result, operation: 'leave', outcome: 'project-left'};
  assert.equal(invitationResult(left, invitationCommand(leave)).outcome, 'project-left');
  assert.throws(() => invitationResult({...left, outcome: 'project-joined'})); assert.throws(() => invitationResult({...result, outcome: 'project-left'}));
  assert.equal(invitationMembers(members, 'demo', '~wes', 'invitations').rows.length, 1);
  for (const delta of [{authority: '~bud'}, {next: 1}, {total: 2}, {catalog: '0x0'}, {rows: [members.rows[0], members.rows[0]], total: 2}]) assert.throws(() => invitationMembers({...members, ...delta}, 'demo', '~wes', 'invitations'));
  assert.throws(() => invitationMembers(members, 'demo', '~wes', 'invitations', 0, '0x8'));
  const catalog = {schema: 'readymade-project-invitation-catalog-v1', owner: '~nec', permissionGranted: false, catalog: '0x9', offset: 0, total: 1, next: null, requests: [result]};
  assert.equal(invitationCatalog(catalog, '~nec').requests[0].digest, '0x456'); assert.throws(() => invitationCatalog(catalog, '~wes'));
});
test('durable invite/join intents survive lost POST, deduplicate windows and only observe after reload', async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'readymade-invitation-')); t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const intent: InvitationIntent = {version: 1, origin: 'https://nec.example', actor: '~nec', command};
  let posts = 0, missing = true;
  const client = {origin: intent.origin, browserCookies: () => [{name: 'urbauth-~nec', value: 'fixture'}], projectInvitation: async (op: string) => {
    if (op === 'submit') {posts++; assert.deepEqual(new InvitationJournal(directory).entries(), [intent]); throw new Error('lost POST');}
    return missing ? {status: 404, body: {status: 'missing'}} : {status: 200, body: result};
  }};
  const journal = new InvitationJournal(directory);
  await assert.rejects(journal.submit(client, intent, false)); assert.equal(journal.entries().length, 0);
  await assert.rejects(journal.submit(client, intent, true), /lost POST/);
  await assert.rejects(new InvitationJournal(directory).submit(client, {...intent, command: {...command, request: '11234567-89ab-4cde-8fab-0123456789ab'}}, true), /retained/);
  assert.equal((await new InvitationJournal(directory).recover(client, intent)).status, 'unconfirmed');
  missing = false; assert.equal((await journal.recover(client, intent)).status, 'accepted'); assert.equal(posts, 1);
  await assert.rejects(journal.recover({...client, origin: 'https://bud.example'}, intent));
  await assert.rejects(journal.recover({...client, browserCookies: () => [{name: 'urbauth-~bud', value: 'fixture'}]}, intent));
  const file = join(directory, fs.readdirSync(directory)[0]); fs.chmodSync(file, 0o644); assert.throws(() => journal.entries());
});
test('real HTTP invitation transport joins remote authority without local Viki and rejects late context drift', async t => {
  let calls = 0, mode = 'ready';
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/~/login') {res.setHeader('set-cookie', 'urbauth-~nec=fixture; Path=/'); res.end('{}'); return;}
    calls++;
    if (req.method === 'POST') {
      let raw = ''; req.on('data', chunk => {raw += chunk;}); req.on('end', () => {
        assert.equal(req.url, '/apps/readymade-collab/project-invitation'); assert.equal(req.headers['x-readymade-project-invitation'], 'v1');
        assert.equal(req.headers.origin, client.origin); assert.deepEqual(JSON.parse(raw), {schema: 'readymade-project-invitation-v1', ...command});
        res.end(JSON.stringify(result));
      }); return;
    }
    assert.equal(req.headers['x-readymade-project-request'], command.request);
    if (mode === 'close') client.close();
    res.end(JSON.stringify(mode === 'foreign' ? {...result, request: '11234567-89ab-4cde-8fab-0123456789ab'} : result));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ShipClient(`http://127.0.0.1:${address.port}`, async () => 'fixture');
  t.after(async () => {client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));});
  await client.signIn(); assert.equal(client.snapshot, undefined);
  assert.equal((await client.projectInvitation('submit', command)).status, 200);
  assert.equal((await client.projectInvitation('result', {request: command.request})).status, 200);
  await assert.rejects(client.projectInvitation('requests', {offset: 64})); assert.equal(calls, 2);
  mode = 'foreign'; await assert.rejects(client.projectInvitation('result', {request: command.request}));
  mode = 'close'; await assert.rejects(client.projectInvitation('result', {request: command.request}));
});

test('a project history page is strict, newest first, and reads as plain sentences', () => {
  const row = (sequence: number, action: string, actor: string, subject: string | null, role: string | null) => ({sequence, at: '~2026.11.11', actor, action, subject, role});
  const rows = [row(5, 'member-left', '~wes', '~nec', null), row(4, 'member-left', '~bud', '~bud', null), row(3, 'invitation-accepted', '~nec', '~nec', 'contributor'),
    row(2, 'invitation-issued', '~wes', '~nec', 'contributor'), row(1, 'project-opened', '~wes', null, null)];
  const page = {schema: 'readymade-project-members-v1', project: 'demo', authority: '~wes', permissionGranted: false, inviteUntil: '~2026.11.12', kind: 'events', catalog: '0x7', offset: 0, total: 5, next: null, rows};
  const read = invitationMembers(page, 'demo', '~wes', 'events');
  assert.deepEqual((read.rows as EventRow[]).map(eventSentence), ['~wes removed ~nec', '~bud left', '~nec accepted as contributor', '~wes invited ~nec as contributor', '~wes opened the project']);
  assert.equal(eventSentence(row(9, 'invitation-revoked', '~wes', '~nec', 'observer') as EventRow), '~wes withdrew the invitation for ~nec');
  assert.equal(eventSentence(row(9, 'invitation-declined', '~nec', '~nec', 'observer') as EventRow), '~nec declined the invitation as observer');
  assert.equal(eventSentence(row(9, 'invitation-expired', '~wes', '~nec', 'observer') as EventRow), 'The invitation for ~nec expired');
  for (const bad of [[rows[1], rows[0], ...rows.slice(2)], [{...rows[0], action: 'granted'}, ...rows.slice(1)], [{...rows[0], extra: 1}, ...rows.slice(1)], [{...rows[0], subject: 'nec'}, ...rows.slice(1)],
    [{...rows[0], sequence: 0}, ...rows.slice(1)], [{...rows[0], role: 'owner'}, ...rows.slice(1)]]) assert.throws(() => invitationMembers({...page, rows: bad}, 'demo', '~wes', 'events'));
  assert.throws(() => invitationMembers(page, 'demo', '~wes', 'members'));
});

test('leaving a project again after rejoining is retained and sent again; every other identical action is not', async t => {
  const directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'rm-leave-again-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const sent: InvitationCommand[] = [];
  const client = {origin: 'http://localhost:8080', browserCookies: () => [{name: 'urbauth-~nec', value: 'x'}],
    projectInvitation: async (_operation: string, value: InvitationCommand) => {sent.push(value);
      return {status: 200, body: {...result, request: value.request, operation: value.operation, outcome: value.operation === 'leave' ? 'project-left' : 'project-joined'}};}};
  const journal = new InvitationJournal(directory);
  const intent = (request: string, operation: 'leave' | 'join'): InvitationIntent => ({version: 1, origin: client.origin, actor: '~nec',
    command: invitationCommand(operation === 'leave' ? {request, authority: '~wes', project: 'demo', operation} : {request, authority: '~wes', project: 'demo', operation, invitation: '0x123'})});
  const ids = ['01234567-89ab-4cde-8fab-0123456789a1', '01234567-89ab-4cde-8fab-0123456789a2', '01234567-89ab-4cde-8fab-0123456789a3', '01234567-89ab-4cde-8fab-0123456789a4'];
  assert.equal((await journal.submit(client as never, intent(ids[0], 'leave'), true)).status, 'accepted');
  assert.equal((await journal.submit(client as never, intent(ids[1], 'leave'), true)).status, 'accepted');   // left, rejoined, leaves again
  await assert.rejects(journal.submit(client as never, intent(ids[1], 'leave'), true), /will not be sent again/); // the same request never twice
  assert.equal((await journal.submit(client as never, intent(ids[2], 'join'), true)).status, 'accepted');
  await assert.rejects(journal.submit(client as never, intent(ids[3], 'join'), true), /will not be sent again/);  // same invitation, new request id
  assert.deepEqual(sent.map(row => row.operation), ['leave', 'leave', 'join']); assert.equal(journal.entries().length, 3);
});

test('leave is decided by the newest accepted join or leave of each project', () => {
  const row = (request: string, operation: 'join' | 'leave' | 'invite-member', project = 'demo', authority = '~nec') => ({request, operation, project, authority});
  const can = (...rows: ReturnType<typeof row>[]) => [...leavableJoins(rows)];
  assert.deepEqual(can(row('a', 'join')), ['a']);
  assert.deepEqual(can(row('a', 'join'), row('b', 'leave')), []);
  assert.deepEqual(can(row('a', 'join'), row('b', 'leave'), row('c', 'join')), ['c'], 'left, then rejoined');
  assert.deepEqual(can(row('a', 'join'), row('b', 'join'), row('c', 'leave')), [], 'changed role (a second join), then left');
  assert.deepEqual(can(row('a', 'join'), row('b', 'join')), ['b'], 'a role change is left through its newest join');
  assert.deepEqual(can(row('a', 'join'), row('b', 'leave', 'other'), row('c', 'join', 'demo', '~bud'), row('d', 'invite-member')), ['a', 'c'], 'projects and owners are separate');
  assert.deepEqual(can(), []);
});
test('the journal can be read oldest first', async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'readymade-invitation-order-')); t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const client = {origin: 'https://wes.example', browserCookies: () => [{name: 'urbauth-~wes', value: 'fixture'}], projectInvitation: async () => {throw new Error('lost POST');}};
  const journal = new InvitationJournal(directory), written: string[] = [];
  for (let n = 0; n < 6; n++) {
    const request = `${n}1234567-89ab-4cde-8fab-0123456789ab`; written.push(request);
    await assert.rejects(journal.submit(client, {version: 1, origin: client.origin, actor: '~wes', command: invitationCommand({request, authority: '~nec', project: 'demo', operation: 'leave'})}, true), /lost POST/);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(journal.ordered().map(row => row.command.request), written);
  assert.deepEqual(journal.entries().map(row => row.command.request).sort(), [...written].sort());
});

test('an invitation command with no usable answer is an unknown outcome, and a busy client records nothing', async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'readymade-invitation-unknown-')); t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const intent: InvitationIntent = {version: 1, origin: 'https://nec.example', actor: '~nec', command};
  const busy = {origin: intent.origin, browserCookies: () => [{name: 'urbauth-~nec', value: 'fixture'}], assertIdle: () => {throw new ShipClientError('commandBusy');}, projectInvitation: async () => {throw new Error('must not be reached');}};
  const journal = new InvitationJournal(directory);
  await assert.rejects(journal.submit(busy, intent, true), /still finishing another request to your ship\. Try again in a moment; nothing was sent\./);
  assert.equal(journal.entries().length, 0, 'nothing is recorded for a command that could not be sent');
  assert.equal(new OutcomeUnknownError().message, 'No answer came back from your ship, so the outcome is not known. Nothing was sent again. Check the result before trying again.');
});
