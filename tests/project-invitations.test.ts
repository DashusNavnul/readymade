import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {invitationCommand, invitationResult, invitationMembers, invitationCatalog, type InvitationCommand} from '../src/project-invitations';
import {InvitationJournal, type InvitationIntent} from '../src/project-invitation-journal';
import {ShipClient} from '../src/ship-client';
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
