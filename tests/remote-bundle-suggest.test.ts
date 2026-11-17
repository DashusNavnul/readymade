import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {remoteSourceHash, type RemoteSourceObservation} from '../src/remote-project-view';
import {remoteBundleIntent, remoteBundleBody, remoteBundleReply, remoteBundleRefused, remoteBundleOutcome, RemoteBundleJournal,
  type RemoteBundleIntent, type RemoteBundleReply} from '../src/remote-bundle-suggest';
import {ShipClient, ShipClientError, OutcomeUnknownError} from '../src/ship-client';

const one = 'one\n', two = 'two\n';
const observation: RemoteSourceObservation = {origin: 'https://peer.example', peer: '~nec', owner: '~zod', project: 'shared', generation: '4',
  request: '0x7787', grant: '0x2', observedAt: '~2026.11.16', root: '0x9c21', snapshotDigest: '0xb83a', desk: 'demo-work', revision: '4',
  files: [{path: '/lib/a/hoon', text: one, hash: remoteSourceHash(one)}, {path: '/lib/b/hoon', text: two, hash: remoteSourceHash(two)}]};
const files = [{path: '/lib/a/hoon', source: 'one\n::  edited\n'}, {path: '/lib/b/hoon', source: 'two\n::  edited\n'}];
const intent = (request = '0xcfda'): RemoteBundleIntent => remoteBundleIntent({observation, files, request});
function wire(i: RemoteBundleIntent, status: string, reason: string, receipt: string | null = null): Record<string, unknown> {
  const o = i.observation;
  return {schema: 'readymade-project-bundle-result-v1', owner: o.owner, peer: o.peer, project: o.project, generation: o.generation, request: i.request,
    viewRequest: o.request, grant: o.grant, root: o.root, snapshotDigest: o.snapshotDigest, status, reason,
    files: [...i.files].reverse().map(f => ({path: f.path, sourceHash: remoteSourceHash(f.source)})),
    deadline: '~2026.11.16..10.08.50', retainedUntil: '~2026.11.16..10.13.50', permissionGranted: false, committed: false, receiptHash: receipt};
}

test('a multi-file intent binds two or more changed shared files to one observation', () => {
  const i = intent();
  assert.deepEqual(remoteBundleBody(i), {schema: 'readymade-project-bundle-v1', owner: '~zod', project: 'shared', generation: '4', viewRequest: '0x7787',
    request: '0xcfda', files: {'/lib/a/hoon': files[0].source, '/lib/b/hoon': files[1].source}});
  for (const bad of [[files[0]], [files[0], files[0]], [files[0], {path: '/lib/b/hoon', source: two}], [files[0], {path: '/lib/c/hoon', source: 'x'}],
    [files[0], {path: '/lib/b/hoon', source: '\u0000'}], [files[0], {path: '/lib/b/hoon', source: 'x'.repeat(32769)}]])
    assert.throws(() => remoteBundleIntent({observation, files: bad, request: '0xcfda'}));
});

test('replies must match every sent file, the observation and the request; a missing record is unknown, never a resend', () => {
  const i = intent();
  assert.equal(remoteBundleReply(202, wire(i, 'watching', 'awaiting-owner'), i, true).status, 'watching');
  const recorded = remoteBundleReply(200, wire(i, 'recorded', 'bundle-recorded', '0xcff0.3e71'), i);
  assert.ok(recorded.status === 'recorded' && recorded.receiptHash === '0xcff0.3e71');
  assert.equal(remoteBundleReply(404, {status: 'unknown', message: 'Bundle not retained; do not resend an unknown outcome.'}, i).status, 'missing');
  const good = wire(i, 'recorded', 'bundle-recorded', '0x1');
  for (const patch of [{root: '0x1'}, {grant: '0x9'}, {request: '0x1'}, {files: (good.files as unknown[]).slice(1)}, {receiptHash: null}, {status: 'done'},
    {files: [{path: '/lib/a/hoon', sourceHash: '0x1'}, (good.files as unknown[])[1]]}, {extra: 1}]) assert.throws(() => remoteBundleReply(200, {...good, ...patch}, i));
  assert.throws(() => remoteBundleReply(200, wire(i, 'watching', 'awaiting-owner'), i));
  assert.equal(remoteBundleRefused(409, {status: 'refused', message: 'ready-view-required'}), 'ready-view-required');
  assert.equal(remoteBundleRefused(409, {status: 'refused', message: 'anything else'}), undefined);
  assert.match(remoteBundleOutcome('uncertain', 'poke-refused'), /refused it; nothing was recorded/);
  assert.match(remoteBundleOutcome('refused', 'stale-parent'), /^Owner’s ship refused it.*shared files changed/);
  assert.match(remoteBundleOutcome('refused', 'new-law'), /Reason: new-law/);
  assert.equal(remoteBundleOutcome('refused-before-submit'), 'Not sent: your ship refused to start it');
});

function setup(t: {after(fn: () => void): void}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-bundle-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const directory = path.join(root, 'bundles'), journal = new RemoteBundleJournal(directory), counts = {posts: 0, gets: 0};
  let post: (i: RemoteBundleIntent) => RemoteBundleReply = i => remoteBundleReply(202, wire(i, 'watching', 'awaiting-owner'), i, true);
  let get: (i: RemoteBundleIntent) => RemoteBundleReply = i => remoteBundleReply(200, wire(i, 'recorded', 'bundle-recorded', '0xa'), i);
  const client = {origin: observation.origin, browserCookies: () => [{name: 'urbauth-~nec', value: 'fixture'}],
    projectBundleSubmit: async (i: RemoteBundleIntent, consent: boolean) => {assert.equal(consent, true); counts.posts++; return post(i);},
    projectBundleResult: async (i: RemoteBundleIntent) => {counts.gets++; return get(i);}};
  return {directory, journal, client, counts, drafts: ['a'.repeat(64), 'b'.repeat(64)],
    onPost: (f: typeof post) => {post = f;}, onGet: (f: typeof get) => {get = f;}};
}

test('the intent is durable before the one send; a restored claim only observes; drafts are never sent twice', async t => {
  const x = setup(t), held = x.journal.claim(x.drafts, files, observation);
  assert.equal(new RemoteBundleJournal(x.directory).get(held.request).phase, 'claimed');
  await assert.rejects(new RemoteBundleJournal(x.directory).submit(x.client, held.request), /sent once/);
  assert.equal((await x.journal.submit(x.client, held.request)).phase, 'watching');
  await assert.rejects(x.journal.submit(x.client, held.request), /sent once/);
  assert.equal(x.counts.posts, 1);
  assert.throws(() => x.journal.claim([x.drafts[1], 'c'.repeat(64)], files, observation), /already sent/);
  assert.deepEqual([...x.journal.claimedDrafts()].sort(), x.drafts);
  const done = await x.journal.observe(x.client, held.request);
  assert.equal(done.phase, 'recorded'); assert.equal(done.receiptHash, '0xa');
  assert.equal((await x.journal.observe(x.client, held.request)).phase, 'recorded'); assert.equal(x.counts.gets, 1);
});

test('an owner refusal stays recorded as such; a later missing read never erases it', async t => {
  const x = setup(t), held = x.journal.claim(x.drafts, files, observation);
  x.onPost(i => remoteBundleReply(202, wire(i, 'uncertain', 'poke-refused'), i, true));
  const refused = await x.journal.submit(x.client, held.request);
  assert.equal(refused.phase, 'uncertain'); assert.equal(refused.reason, 'poke-refused');
  x.onGet(i => remoteBundleReply(404, {status: 'unknown', message: 'Bundle not retained; do not resend an unknown outcome.'}, i));
  assert.equal((await x.journal.observe(x.client, held.request)).reason, 'poke-refused'); assert.equal(x.counts.gets, 0);
});

test('a refusal by the collaborator ship before sending and an unknown transport outcome are kept apart', async t => {
  const x = setup(t), first = x.journal.claim(x.drafts, files, observation);
  x.onPost(() => {throw new ShipClientError('refused', 409);});
  await assert.rejects(x.journal.submit(x.client, first.request));
  assert.equal(x.journal.get(first.request).phase, 'refused-before-submit');
  const second = x.journal.claim(['c'.repeat(64), 'd'.repeat(64)], files, observation);
  x.onPost(() => {throw new OutcomeUnknownError();});
  await assert.rejects(x.journal.submit(x.client, second.request));
  assert.equal(x.journal.get(second.request).phase, 'unknown');
  assert.equal((await x.journal.observe(x.client, second.request)).phase, 'recorded');
});

test('the client sends one exact POST and reads the result with the suggestion selector', async () => {
  const seen: {method: string; url: string; body: string; request?: string}[] = []; let status = 202;
  const server = createServer((req, res) => {
    if (req.url === '/~/login') {res.setHeader('set-cookie', 'urbauth-~nec=fixture; Path=/'); res.end('{}'); return;}
    let body = ''; req.on('data', chunk => {body += chunk;}); req.on('end', () => {
      seen.push({method: req.method!, url: req.url!, body, request: req.headers['x-readymade-project-suggest-request'] as string});
      res.setHeader('content-type', 'application/json'); res.statusCode = status;
      const i = intent(JSON.parse(body || '{}').request ?? live.request);
      res.end(JSON.stringify(status === 409 ? {status: 'refused', message: 'ready-view-required'} : wire(i, req.method === 'GET' ? 'recorded' : 'watching',
        req.method === 'GET' ? 'bundle-recorded' : 'awaiting-owner', req.method === 'GET' ? '0xa' : null)));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ShipClient(`http://127.0.0.1:${address.port}`, async () => 'fixture');
  const live = remoteBundleIntent({observation: {...observation, origin: client.origin}, files, request: '0xcfda'});
  try {
    await client.signIn();
    await assert.rejects(client.projectBundleSubmit(live, false), e => e instanceof ShipClientError && e.code === 'consentRequired');
    assert.equal((await client.projectBundleSubmit(live, true)).status, 'watching');
    assert.deepEqual(JSON.parse(seen[0].body), remoteBundleBody(live)); assert.equal(seen[0].url, '/apps/readymade-collab/project-bundle');
    status = 200; assert.equal((await client.projectBundleResult(live)).status, 'recorded');
    assert.equal(seen[1].url, '/apps/readymade-collab/project-bundle-result'); assert.equal(seen[1].request, '0xcfda');
    status = 409;
    const other = remoteBundleIntent({...live, request: '0xbeef'});
    await assert.rejects(client.projectBundleSubmit(other, true), e => e instanceof ShipClientError && e.code === 'refused');
  } finally {client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});
