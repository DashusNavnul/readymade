import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {ShipClient, ShipClientError, OutcomeUnknownError} from '../src/ship-client';
import {projectInbox, inboxBasisMatches, importInboxSuggestion, mergeInboxSuggestion, ExistingInboxDraftError, type InboxDetail} from '../src/project-inbox';
import {remoteSourceHash} from '../src/remote-project-view';
import {snapshotFrom} from '../src/source-store';
import {DraftStore} from '../src/draft-store';

const owner = '~zod', project = 'shared', original = 'original\n', source = 'suggested\n';
const detail: InboxDetail = {receiptHash: '0x1', peer: '~nec', receivedAt: '~2026.11.09', generation: '1', request: '0x2', path: '/lib/example/hoon',
  sourceHash: remoteSourceHash(source), parentRoot: '0x20', snapshotDigest: '0x3', desk: 'work', revision: '4', originalHash: remoteSourceHash(original), source};
const {source: _source, ...catalog} = detail;
const envelope = (receipts: unknown[] = [catalog]) => ({schema: 'readymade-project-inbox-v1', owner, project, permissionGranted: false, committed: false, receipts});
const basis = {id: '0x4', owner, desk: 'work', number: 4, root: '0v10', commit: '0v5'};
const snapshot = snapshotFrom({origin: 'https://zod.example', ship: owner, session: '0x6', source: basis, path: detail.path, blob: '0x7', mark: 'hoon', text: original});
const context = {origin: snapshot.origin, owner, project, session: snapshot.session, basis, state: {owner, session: snapshot.session, sessions: [{id: snapshot.session, project, source: basis}]}};
async function fixture(run: (store: DraftStore) => void | Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'readymade-inbox-'));
  try {await run(new DraftStore(directory));} finally {rmSync(directory, {recursive: true, force: true});}
}

test('inbox catalog and exact detail retain immutable native receipt identity', () => {
  const parsed = projectInbox(envelope(), owner, project);
  assert.equal(parsed.receipts[0].receiptHash, detail.receiptHash); assert.ok(Object.isFrozen(parsed.receipts[0]));
  const full = projectInbox(envelope([detail]), owner, project, detail.receiptHash).receipts[0] as InboxDetail;
  assert.equal(full.source, source); assert.equal('session' in full, false); assert.equal('commit' in full, false);
  for (const patch of [{owner: '~nec'}, {project: 'other'}, {permissionGranted: true}, {committed: true}, {session: 'fake'}]) assert.throws(() => projectInbox({...envelope(), ...patch}, owner, project));
  assert.throws(() => projectInbox(envelope([detail]), owner, project));
  assert.throws(() => projectInbox(envelope([detail]), owner, project, '0x9'));
});

test('inbox bounds, canonical atoms, hashes and paths reject ambiguous native data', () => {
  for (const patch of [{request: '0x01'}, {generation: '01'}, {revision: '1000'}, {parentRoot: '0x0'}, {peer: owner}, {receivedAt: '~2026.02.30'},
    {path: '/lib/../hoon'}, {path: '/sys/a/hoon'}, {source: 'changed'}, {source: '\u0000'}, {source: 'x'.repeat(32769)}]) assert.throws(() => projectInbox(envelope([{...detail, ...patch}]), owner, project, detail.receiptHash));
  assert.throws(() => projectInbox(envelope([catalog, catalog]), owner, project));
  assert.throws(() => projectInbox(envelope(Array.from({length: 65}, () => catalog)), owner, project));
});

test('native uv root uses exact atom comparison with ux and rejects noncanonical aliases', () => {
  const number = (1n << 256n) - 1n, hash = '0x' + number.toString(16).replace(/\B(?=(?:[0-9a-f]{4})+$)/g, '.'), root = '0v' + number.toString(32).replace(/\B(?=(?:[0-9a-v]{5})+$)/g, '.');
  assert.equal(hash.length, 81);
  assert.equal(inboxBasisMatches({...detail, parentRoot: hash}, {...basis, root}, owner), true);
  projectInbox(envelope([{...catalog, receiptHash: hash, parentRoot: hash, snapshotDigest: hash, sourceHash: hash, originalHash: hash}]), owner, project);
  assert.equal(inboxBasisMatches(detail, basis, owner), true);
  assert.equal(inboxBasisMatches({...detail, parentRoot: '0x200.0000'}, {...basis, root: '0v1.00000'}, owner), true);
  assert.equal(inboxBasisMatches(detail, {...basis, root: '0v010'}, owner), false);
  for (const changed of [{owner: '~nec'}, {desk: 'other'}, {number: 5}, {root: '0v11'}]) assert.equal(inboxBasisMatches(detail, {...basis, ...changed}, owner), false);
});

test('import uses actual source snapshot and retains original for normal candidate path', () => fixture(store => {
  const imported = importInboxSuggestion(store, detail, snapshot, context);
  assert.deepEqual(imported.snapshot, snapshot); assert.equal(imported.text, source);
  assert.equal(imported.snapshot.source.commit, basis.commit); assert.equal(imported.pending, undefined);
  assert.equal(new DraftStore(store.directory).get(imported.id).text, source);
}));

test('stale or foreign source refuses before creating or changing any local draft', () => fixture(store => {
  for (const changed of [{origin: 'https://other.example'}, {owner: '~nec'}, {session: '0x9'}, {project: 'other'}, {state: {...context.state, sessions: []}}, {state: {...context.state, sessions: [...context.state.sessions, ...context.state.sessions]}}, {basis: {...basis, commit: '0v9'}}])
    assert.throws(() => importInboxSuggestion(store, detail, snapshot, {...context, ...changed}));
  for (const changed of [{originalHash: '0x0'}, {parentRoot: '0x21'}, {revision: '5'}, {desk: 'other'}, {path: '/lib/other/hoon'}])
    assert.throws(() => importInboxSuggestion(store, {...detail, ...changed}, snapshot, context));
  assert.equal(store.list().length, 0);
}));

test('existing edited or pending owner draft is never overwritten by receipt import', () => fixture(async store => {
  const draft = store.create(snapshot); store.save(draft.id, 'owner edit\n');
  assert.throws(() => importInboxSuggestion(store, detail, snapshot, context), ExistingInboxDraftError);
  await assert.rejects(store.prepare(draft.id, {origin: snapshot.origin, snapshot: {nonce: '0v1', cursor: '0x1', owner, session: snapshot.session, ready: true,
    after: 0, projects: [], records: [], sessions: [{id: snapshot.session, project, source: basis}]}, codingTool: async () => {throw Error('fixture response lost');}}));
  store.save(draft.id, original);
  assert.throws(() => importInboxSuggestion(store, detail, snapshot, context), ExistingInboxDraftError);
  assert.equal(store.get(draft.id).text, original); assert.equal(store.get(draft.id).pending?.phase, 'unknown');
}));

test('merge preview combines independent edits and preserves journal and receipt', () => fixture(store => {
  const base = 'first\nsecond\nthird\n', local = 'owner\nsecond\nthird\n', peer = 'first\nsecond\npeer\n';
  const snap = snapshotFrom({origin: snapshot.origin, ship: owner, session: snapshot.session, source: basis, path: detail.path, blob: '0x7', mark: 'hoon', text: base});
  const suggestion = {...detail, source: peer, sourceHash: remoteSourceHash(peer), originalHash: remoteSourceHash(base)};
  const draft = store.create(snap), before = JSON.stringify(store.get(draft.id)), receipt = JSON.stringify(suggestion);
  assert.deepEqual(mergeInboxSuggestion(draft, local, suggestion, snap, context), {kind: 'merged', text: 'owner\nsecond\npeer\n'});
  assert.equal(mergeInboxSuggestion(draft, 'first\nsecond\nconflict\n', suggestion, snap, context).kind, 'conflict');
  assert.equal(JSON.stringify(store.get(draft.id)), before); assert.equal(JSON.stringify(suggestion), receipt);
  assert.throws(() => mergeInboxSuggestion(draft, local, suggestion, snap, {...context, project: 'other'}));
  assert.throws(() => mergeInboxSuggestion(draft, local, {...suggestion, originalHash: '0x0'}, snap, context));
}));

test('merge refuses an unresolved submission even when local text has changed', () => fixture(async store => {
  const draft = store.create(snapshot); store.save(draft.id, source);
  await assert.rejects(store.prepare(draft.id, {origin: snapshot.origin, snapshot: {nonce: '0v1', cursor: '0x1', owner, session: snapshot.session, ready: true,
    after: 0, projects: [], records: [], sessions: [{id: snapshot.session, project, source: basis}]}, codingTool: async () => {throw Error('lost');}}));
  assert.throws(() => mergeInboxSuggestion(store.get(draft.id), 'different\n', detail, snapshot, context), /submitted/);
}));

test('owner inbox transport binds authenticated owner and exact UTF-8 project, and never writes', async () => {
  let mode = 'catalog';
  const selected = 'café-共同', seen: {method: string; project?: string; receipt?: string}[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/~/login') {res.setHeader('set-cookie', 'urbauth-~zod=fixture; Path=/'); res.end('{}'); return;}
    seen.push({method: req.method!, project: req.headers['x-readymade-project'] as string, receipt: req.headers['x-readymade-project-receipt'] as string});
    res.setHeader('content-type', 'application/json');
    if (mode === 'missing') {res.statusCode = 404; res.end('{}'); return;}
    if (mode === 'close') client.close();
    const body = {...envelope(mode === 'detail' ? [detail] : [catalog]), project: selected, ...(mode === 'foreign' ? {owner: '~nec'} : {})};
    if (mode === 'oversize') {res.end(' '.repeat(524289)); return;}
    const raw = JSON.stringify(body);
    res.end(mode === 'duplicate' ? '{"owner":"~zod",' + raw.slice(1) : raw);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ShipClient(`http://127.0.0.1:${address.port}`, async () => 'fixture');
  try {
    await assert.rejects(client.projectInbox(selected), e => e instanceof ShipClientError && e.code === 'authenticationRequired');
    await client.signIn();
    for (const receipt of ['0x0', '0x01', '0x1.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000']) await assert.rejects(client.projectInbox(selected, receipt));
    assert.equal(seen.length, 0);
    assert.equal((await client.projectInbox(selected)).owner, owner);
    assert.equal(Buffer.from(seen[0].project!, 'latin1').toString('utf8'), selected);
    mode = 'detail'; assert.deepEqual((await client.projectInbox(selected, detail.receiptHash)).receipts, [detail]);
    assert.equal(seen.at(-1)!.receipt, detail.receiptHash);
    for (mode of ['foreign', 'duplicate', 'oversize']) await assert.rejects(client.projectInbox(selected));
    mode = 'missing'; await assert.rejects(client.projectInbox(selected, detail.receiptHash), e => e instanceof ShipClientError && e.code === 'receiptMissing');
    mode = 'close'; await assert.rejects(client.projectInbox(selected), e => e instanceof ShipClientError && ['contextChanged', 'transport'].includes(e.code));
    assert.ok(seen.every(row => row.method === 'GET'));
  } finally {client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});

test('an answer to a suggestion is one exact request; a refusal or an unknown outcome never becomes "told"', async () => {
  const selected = 'café-共同', receipt = '0x5e55.2002', posts: {headers: Record<string, unknown>; body: string}[] = [];
  let reply: (res: import('node:http').ServerResponse) => void = res => res.end('{}');
  const server = createServer((req, res) => {
    if (req.url === '/~/login') {res.setHeader('set-cookie', 'urbauth-~zod=fixture; Path=/'); res.end('{}'); return;}
    let body = ''; req.on('data', chunk => {body += chunk;}); req.on('end', () => {
      assert.equal(req.url, '/apps/readymade-collab/suggestion-answer'); assert.equal(req.method, 'POST');
      posts.push({headers: req.headers, body}); res.setHeader('content-type', 'application/json'); reply(res);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ShipClient(`http://127.0.0.1:${address.port}`, async () => 'fixture');
  const sent = (answer: string) => (res: import('node:http').ServerResponse) => {res.statusCode = 202; res.end(JSON.stringify({schema: 'readymade-suggestion-answer-receipt-v1', status: 'sent', answer, confirmed: false}));};
  try {
    await client.signIn();
    // Nothing leaves this computer for a malformed receipt or answer.
    for (const bad of ['0x0', '0x05', 'abc']) await assert.rejects(client.suggestionAnswer(selected, bad, 'taken'));
    await assert.rejects(client.suggestionAnswer(selected, receipt, 'maybe' as 'taken')); assert.equal(posts.length, 0);
    reply = sent('taken'); await client.suggestionAnswer(selected, receipt, 'taken');
    assert.deepEqual(JSON.parse(posts[0].body), {schema: 'readymade-suggestion-answer-v1', owner: '~zod', project: selected, receipt, answer: 'taken'});
    assert.equal(posts[0].headers['x-readymade-suggestion-answer'], 'v1'); assert.equal(posts[0].headers.origin, client.origin);
    reply = sent('declined'); await client.suggestionAnswer(selected, receipt, 'declined');
    // The ship's own refusals mean nothing was sent on.
    reply = res => {res.statusCode = 404; res.end(JSON.stringify({status: 'refused', message: 'receipt-missing'}));};
    await assert.rejects(client.suggestionAnswer(selected, receipt, 'taken'), e => e instanceof ShipClientError && e.code === 'receiptMissing');
    for (const [status, message] of [[400, 'Explicit owner-origin suggestion answer required.'], [404, 'Unknown collaboration route.'], [409, 'cantrip-not-live']] as const) {
      reply = res => {res.statusCode = status; res.end(JSON.stringify({status: 'refused', message}));};
      await assert.rejects(client.suggestionAnswer(selected, receipt, 'taken'), e => e instanceof ShipClientError && e.code === 'refused' && e.status === status);
    }
    // Anything else is an unknown outcome: a receipt for the other answer, a wrong shape, a server error, a dropped connection.
    for (const odd of [sent('declined'), (res: import('node:http').ServerResponse) => {res.statusCode = 200; res.end('{}');},
      (res: import('node:http').ServerResponse) => {res.statusCode = 202; res.end(JSON.stringify({schema: 'readymade-suggestion-answer-receipt-v1', status: 'sent', answer: 'taken', confirmed: true}));},
      (res: import('node:http').ServerResponse) => {res.statusCode = 500; res.end('{}');}, (res: import('node:http').ServerResponse) => {res.destroy();}]) {
      reply = odd; await assert.rejects(client.suggestionAnswer(selected, receipt, 'taken'), OutcomeUnknownError);
    }
    const before = posts.length; reply = sent('taken');
    await client.suggestionAnswer(selected, receipt, 'taken'); assert.equal(posts.length, before + 1); // The client stays usable and sends exactly once per call.
  } finally {client.close(); server.close();}
});
