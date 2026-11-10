import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {RemoteDraftStore} from '../src/remote-draft-store';
import {RemoteSuggestionJournal} from '../src/remote-suggestion-journal';
import {remoteSourceHash, type RemoteSourceObservation} from '../src/remote-project-view';
import {type RemoteSuggestionIntent, type RemoteSuggestionReply, type RemoteSuggestionRecoveryReply} from '../src/remote-project-suggest';
import {ShipClientError} from '../src/ship-client';

function reply(i: RemoteSuggestionIntent, status: 'watching' | 'recorded' | 'missing' | 'expired' = 'watching'): RemoteSuggestionReply {
  const o = i.observation, common = {owner: o.owner, peer: o.peer, project: o.project, generation: o.generation, request: i.request,
    permissionGranted: false as const, committed: false as const};
  if (status === 'missing' || status === 'expired') return {...common, status};
  return {...common, status, viewRequest: o.request, grant: o.grant, root: o.root, snapshotDigest: o.snapshotDigest,
    path: i.path, sourceHash: remoteSourceHash(i.source), reason: status === 'recorded' ? 'suggestion-recorded' : 'awaiting-owner',
    deadline: '~2026.11.09..00.00.30', retainedUntil: '~2026.11.09..00.05.30', receiptHash: status === 'recorded' ? '0xa' : null};
}
function setup(t: {after(fn: () => void): void}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-suggestion-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const text = 'original\n', observation: RemoteSourceObservation = {origin: 'https://peer.example', peer: '~nec', owner: '~zod',
    project: 'shared', generation: '1', request: '0x1', grant: '0x2', observedAt: '~2026.11.09', root: '0x3', snapshotDigest: '0x4',
    desk: 'demo', revision: '1', files: [{path: '/lib/example/hoon', text, hash: remoteSourceHash(text)}]};
  const drafts = new RemoteDraftStore(path.join(root, 'drafts')), first = drafts.create(observation, observation.files[0].path);
  const draft = drafts.save(first.id, 'edited\n'), fresh = {...observation, request: '0x2'};
  const directory = path.join(root, 'suggestions'), journal = new RemoteSuggestionJournal(directory);
  let posts = 0, gets = 0;
  const client = {origin: observation.origin, browserCookies: () => [{name: 'urbauth-~nec', value: 'fixture'}],
    projectSuggestionSubmit: async (i: RemoteSuggestionIntent, consent: boolean): Promise<RemoteSuggestionReply> => {
      assert.equal(consent, true); posts++; return reply(i);
    }, projectSuggestionResult: async (i: RemoteSuggestionIntent): Promise<RemoteSuggestionReply> => {gets++; return reply(i, 'recorded');}};
  return {root, directory, journal, drafts, draft, fresh, client, counts: () => ({posts, gets})};
}
test('claim and dispatch are durable before POST; subsequent edits cannot change frozen intent', async t => {
  const x = setup(t), held = x.journal.claim(x.draft, x.draft.text, x.fresh), send = x.client.projectSuggestionSubmit;
  assert.equal(new RemoteSuggestionJournal(x.directory).get(held.request).phase, 'claimed');
  x.drafts.save(x.draft.id, 'later edits');
  x.client.projectSuggestionSubmit = async (intent, consent) => {
    const disk = new RemoteSuggestionJournal(x.directory).get(held.request);
    assert.equal(disk.phase, 'submitting'); assert.equal(disk.intent.source, 'edited\n');
    assert.equal(disk.draft.observation.request, '0x1'); assert.equal(disk.intent.observation.request, '0x2');
    assert.equal(disk.draft.observation.files[0].text, 'original\n'); return send(intent, consent);
  };
  assert.equal((await x.journal.submit(x.client, held.request)).phase, 'watching');
  const result = await new RemoteSuggestionJournal(x.directory).observe(x.client, held.request);
  assert.equal(result.phase, 'recorded'); assert.equal(result.reply?.committed, false);
  await assert.rejects(x.journal.submit(x.client, held.request)); assert.deepEqual(x.counts(), {posts: 1, gets: 1});
  assert.equal(fs.statSync(path.join(x.directory, `${x.draft.id}.json`)).mode & 0o777, 0o600);
});
test('crash after claim and cross-window duplicate claims never dispatch a POST', async t => {
  const x = setup(t), held = x.journal.claim(x.draft, x.draft.text, x.fresh), restored = new RemoteSuggestionJournal(x.directory);
  assert.throws(() => restored.claim(x.draft, x.draft.text, x.fresh), /already/);
  await assert.rejects(restored.submit(x.client, held.request), /newly claimed/);
  await restored.observe(x.client, held.request);
  await assert.rejects(x.journal.submit(x.client, held.request)); assert.deepEqual(x.counts(), {posts: 0, gets: 1});
});
test('lost POST survives reload; missing and expired observations never permit resend', async t => {
  const x = setup(t), held = x.journal.claim(x.draft, x.draft.text, x.fresh); let sends = 0;
  x.client.projectSuggestionSubmit = async () => {sends++; throw new Error('socket lost');};
  await assert.rejects(x.journal.submit(x.client, held.request), /socket lost/);
  const restored = new RemoteSuggestionJournal(x.directory); assert.equal(restored.get(held.request).phase, 'unknown');
  for (const status of ['missing', 'expired'] as const) {
    x.client.projectSuggestionResult = async i => reply(i, status);
    assert.equal((await restored.observe(x.client, held.request)).phase, status);
    await assert.rejects(restored.submit(x.client, held.request)); assert.throws(() => restored.claim(x.draft, x.draft.text, x.fresh));
  }
  assert.equal(sends, 1);
});
test('fresh source, grant and editor bytes must match before any claim exists', t => {
  const x = setup(t);
  for (const patch of [{origin: 'https://other.example'}, {peer: '~wes'}, {owner: '~wes'}, {project: 'other'}, {generation: '2'},
    {grant: '0x9'}, {root: '0x9'}, {snapshotDigest: '0x9'}, {desk: 'other'}, {revision: '2'}, {request: '0x1'}]) {
    assert.throws(() => x.journal.claim(x.draft, x.draft.text, {...x.fresh, ...patch}));
  }
  assert.throws(() => x.journal.claim(x.draft, 'not captured', x.fresh));
  assert.throws(() => x.journal.claim({...x.draft, id: '0'.repeat(64)}, x.draft.text, x.fresh));
  assert.deepEqual(x.journal.list(), []); assert.equal(fs.existsSync(x.directory), false);
});
test('known preflight refusal remains retained and cannot be claimed or sent again', async t => {
  const x = setup(t), held = x.journal.claim(x.draft, x.draft.text, x.fresh);
  x.client.projectSuggestionSubmit = async () => {throw new ShipClientError('refused', 409);};
  await assert.rejects(x.journal.submit(x.client, held.request));
  const restored = new RemoteSuggestionJournal(x.directory);
  assert.equal(restored.get(held.request).phase, 'refused-before-submit');
  await restored.observe(x.client, held.request); assert.deepEqual(x.counts(), {posts: 0, gets: 0});
  await assert.rejects(restored.submit(x.client, held.request)); assert.throws(() => restored.claim(x.draft, x.draft.text, x.fresh));
});
test('foreign connections and altered journal provenance fail closed', async t => {
  const x = setup(t), held = x.journal.claim(x.draft, x.draft.text, x.fresh);
  await assert.rejects(x.journal.submit({...x.client, origin: 'https://other.example'}, held.request));
  await assert.rejects(x.journal.submit({...x.client, browserCookies: () => [{name: 'urbauth-~wes', value: 'fixture'}]}, held.request));
  assert.deepEqual(x.counts(), {posts: 0, gets: 0});
  const file = path.join(x.directory, `${x.draft.id}.json`), data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.intent.observation.root = '0x9'; fs.writeFileSync(file, JSON.stringify(data));
  assert.throws(() => new RemoteSuggestionJournal(x.directory).list());
});
test('late failed observation cannot replace a recorded receipt from another window', async t => {
  const x = setup(t), held = x.journal.claim(x.draft, x.draft.text, x.fresh);
  await x.journal.submit(x.client, held.request);
  let reject!: (e: Error) => void;
  const late = x.journal.observe({...x.client, projectSuggestionResult: () => new Promise((_resolve, bad) => {reject = bad;})}, held.request);
  const other = new RemoteSuggestionJournal(x.directory); await other.observe(x.client, held.request);
  reject(new Error('late loss')); await assert.rejects(late);
  assert.equal(x.journal.get(held.request).phase, 'recorded'); assert.equal(x.journal.get(held.request).reply?.committed, false);
});
test('a cross-window observation between initial read and durable dispatch blocks POST', async t => {
  const x = setup(t), held = x.journal.claim(x.draft, x.draft.text, x.fresh);
  const file = path.join(x.directory, `${x.draft.id}.json`);
  x.client.browserCookies = () => {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({...current, phase: 'missing', reply: reply(held.intent, 'missing')}));
    return [{name: 'urbauth-~nec', value: 'fixture'}];
  };
  await assert.rejects(x.journal.submit(x.client, held.request), /another window/);
  assert.deepEqual(x.counts(), {posts: 0, gets: 0}); assert.equal(x.journal.get(held.request).phase, 'missing');
});

function recoveryReply(i: RemoteSuggestionIntent, status: 'watching' | 'recorded' = 'watching'): RemoteSuggestionRecoveryReply {
  const value = reply(i, status);
  if (!('reason' in value)) throw new Error('Unexpected fixture status');
  return {...value, recovery: true, reason: status === 'watching' ? 'recovering-receipt' : 'suggestion-recorded'};
}
test('explicit recovery appends history across restarts without replacing the original unknown send record', async t => {
  const x = setup(t), held = x.journal.claim(x.draft, x.draft.text, x.fresh); let recovered = 0, observed = 0;
  x.client.projectSuggestionSubmit = async () => {throw new Error('lost send');};
  const client = {...x.client, projectSuggestionResult: async (i: RemoteSuggestionIntent) => reply(i, 'missing'),
    projectSuggestionRecover: async (i: RemoteSuggestionIntent) => {
      recovered++; assert.equal(new RemoteSuggestionJournal(x.directory).get(i.request).recoveries?.at(-1)?.phase, 'requested');
      return recoveryReply(i);
    }, projectSuggestionRecoveryResult: async (i: RemoteSuggestionIntent) => {observed++; return recoveryReply(i, 'recorded');}};
  await assert.rejects(x.journal.submit(client, held.request));
  await assert.rejects(x.journal.recover(client, held.request, true), /missing or expired/); assert.equal(recovered, 0);
  const original = await x.journal.observe(client, held.request);
  await assert.rejects(x.journal.recover(client, held.request, false));
  const started = await x.journal.recover(client, held.request, true);
  assert.equal(started.phase, 'missing'); assert.deepEqual(started.reply, original.reply); assert.deepEqual(started.intent, original.intent);
  const restored = new RemoteSuggestionJournal(x.directory);
  await assert.rejects(restored.recover(client, held.request, true), /retained recovery/);
  const result = await restored.observe(client, held.request);
  assert.equal(result.phase, original.phase); assert.equal(result.updatedAt, original.updatedAt);
  assert.deepEqual(result.recoveries?.map(r => r.phase), ['requested', 'watching', 'recorded']);
  assert.equal(result.recoveries?.at(-1)?.reply?.committed, false);
  await restored.recover(client, held.request, true); assert.equal(recovered, 1); assert.equal(observed, 1);
  await assert.rejects(restored.submit(client, held.request));
});
test('lost recovery stays distinct; later failures cannot replace another window recovered receipt', async t => {
  const x = setup(t), held = x.journal.claim(x.draft, x.draft.text, x.fresh);
  const client = {...x.client, projectSuggestionResult: async (i: RemoteSuggestionIntent) => reply(i, 'expired'),
    projectSuggestionRecover: async (): Promise<RemoteSuggestionRecoveryReply> => {throw new Error('lost recovery');},
    projectSuggestionRecoveryResult: async (i: RemoteSuggestionIntent) => recoveryReply(i, 'recorded')};
  await x.journal.observe(client, held.request);
  await assert.rejects(x.journal.recover(client, held.request, true), /lost recovery/);
  assert.deepEqual(x.journal.get(held.request).recoveries?.map(r => r.phase), ['requested', 'unknown']);
  let reject!: (error: Error) => void;
  const pending = x.journal.observeRecovery({...client, projectSuggestionRecoveryResult: () => new Promise((_resolve, bad) => {reject = bad;})}, held.request);
  const other = new RemoteSuggestionJournal(x.directory); await other.observeRecovery(client, held.request);
  reject(new Error('late failure')); await assert.rejects(pending);
  const row = other.get(held.request); assert.equal(row.phase, 'expired'); assert.equal(row.recoveries?.at(-1)?.phase, 'recorded');
  const file = path.join(x.directory, `${row.draftId}.json`), data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.recoveries.at(-1).reply.root = '0x999'; fs.writeFileSync(file, JSON.stringify(data));
  assert.throws(() => new RemoteSuggestionJournal(x.directory).get(held.request));
});
