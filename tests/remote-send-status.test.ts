import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {RemoteDraftStore} from '../src/remote-draft-store';
import {RemoteSuggestionJournal, suggestionSettled, type SavedSuggestion} from '../src/remote-suggestion-journal';
import {RemoteBundleJournal, bundleStanding, remoteBundleOutcome, type RemoteBundleIntent, type SavedBundle} from '../src/remote-bundle-suggest';
import {remoteSourceHash, type RemoteSourceObservation} from '../src/remote-project-view';
import type {RemoteSuggestionIntent, RemoteSuggestionReply} from '../src/remote-project-suggest';
import {SEND_ACTIONS, bundleStatus, suggestionStatus} from '../src/remote-send-status';
import {OutcomeUnknownError} from '../src/ship-client';

const original = 'original\n';
function observed(request: string): RemoteSourceObservation {
  return {origin: 'https://peer.example', owner: '~zod', peer: '~nec', project: 'shared', generation: '1', request,
    grant: '0x2', observedAt: '~2026.11.09', root: '0x3', snapshotDigest: '0x4', desk: 'shared', revision: '1',
    files: [{path: '/lib/a/hoon', text: original, hash: remoteSourceHash(original)}, {path: '/lib/b/hoon', text: original, hash: remoteSourceHash(original)}]};
}
type Phase = SavedSuggestion['phase'];
const single = (phase: Phase, recovery?: string) => suggestionStatus({phase, ...(recovery ? {recoveries: [{at: 1, phase: recovery}]} : {})} as Pick<SavedSuggestion, 'phase' | 'recoveries' | 'reply'>);

test('every state of a send is one of five things, with one next step, and unknown is never called failed or done', () => {
  const phases: Phase[] = ['claimed', 'submitting', 'unknown', 'watching', 'sent', 'uncertain', 'missing', 'expired', 'recorded', 'refused', 'refused-before-submit'];
  assert.deepEqual(phases.map(phase => [single(phase).state, single(phase).action]), [['local', 'close-unsent'], ['unknown', 'check'], ['unknown', 'check'], ['unknown', 'check'], ['unknown', 'check'],
    ['unknown', 'check'], ['unknown', 'recover'], ['unknown', 'recover'], ['recorded', 'none'], ['refused', 'none'], ['not-sent', 'none']]);
  // A receipt recovery, once started, is what the row speaks of; only a recovered receipt resolves the send.
  assert.deepEqual(['requested', 'watching', 'unknown', 'uncertain', 'missing', 'expired', 'recorded'].map(recovery => [single('missing', recovery).state, single('missing', recovery).action]),
    [['unknown', 'check'], ['unknown', 'check'], ['unknown', 'check'], ['unknown', 'check'], ['unknown', 'recover'], ['unknown', 'recover'], ['recorded', 'none']]);
  assert.equal(single('missing', 'recorded').label, 'Owner receipt recovered — awaiting review');
  // Resolved is exactly what the journal calls settled: the same rule lets a draft be reconciled and a record move to history.
  for (const phase of phases) assert.equal(single(phase).resolved, suggestionSettled({phase}), phase);
  for (const recovery of ['requested', 'uncertain', 'missing', 'recorded']) assert.equal(single('unknown', recovery).resolved, recovery === 'recorded');
  const bundles: SavedBundle['phase'][] = ['claimed', 'submitting', 'unknown', 'watching', 'sent', 'missing', 'uncertain', 'recorded', 'refused', 'refused-before-submit'];
  assert.deepEqual(bundles.map(phase => [bundleStatus({phase}).state, bundleStatus({phase}).action]), [['local', 'close-unsent'], ['unknown', 'check'], ['unknown', 'check'], ['unknown', 'check'], ['unknown', 'check'],
    ['unknown', 'check'], ['unknown', 'none'], ['recorded', 'none'], ['refused', 'none'], ['not-sent', 'none']]);
  assert.equal(bundleStatus({phase: 'uncertain', reason: 'poke-refused'}).state, 'refused');
  assert.match(bundleStatus({phase: 'uncertain', reason: 'suggest-timeout'}).label, /^Ended without a result — outcome not known \(the owner’s ship did not answer in time\)$/);
  assert.equal(bundleStatus({phase: 'refused-before-submit', reason: 'closed-unsent'}).label, 'Not sent: closed before it was sent; nothing left this computer');
  for (const phase of bundles) assert.equal(bundleStatus({phase}).resolved, bundleStanding({phase}) === 'finished', phase);
  // Words: an unknown outcome is never said to have failed, been lost for good, or completed; every row says the draft is kept.
  const all = [...phases.map(phase => single(phase)), ...['requested', 'unknown', 'uncertain', 'missing'].map(r => single('missing', r)), ...bundles.map(phase => bundleStatus({phase}))];
  for (const status of all) {
    assert.match(status.detail, /Your draft is kept as it is\.$/);
    if (status.state === 'unknown') {
      // It may say that silence is not proof of non-delivery; it may not assert non-delivery.
      assert.doesNotMatch(status.label + ' ' + status.detail, /\bfailed\b|\bcomplete|\bdone\b|(?<!not proof it )was not (?:delivered|sent)/i);
      assert.match(status.detail, /cannot be sent again or replaced|never sent again/);
    }
    if (status.state === 'local') assert.match(status.detail, /Nothing left this computer/);
  }
  // No next step sends anything.
  for (const action of Object.values(SEND_ACTIONS)) assert.match(action.tooltip, /Nothing is sent|does not send your suggestion again/);
});

function reply(i: RemoteSuggestionIntent, status: 'watching' | 'recorded'): RemoteSuggestionReply {
  const o = i.observation;
  return {owner: o.owner, peer: o.peer, project: o.project, generation: o.generation, request: i.request, permissionGranted: false, committed: false,
    status, viewRequest: o.request, grant: o.grant, root: o.root, snapshotDigest: o.snapshotDigest, path: i.path, sourceHash: remoteSourceHash(i.source),
    reason: status === 'recorded' ? 'suggestion-recorded' : 'awaiting-owner', deadline: '~2026.11.09..00.00.30', retainedUntil: '~2026.11.09..00.05.30', receiptHash: status === 'recorded' ? '0xa' : null};
}
function setup(t: {after(fn: () => void): void}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-send-status-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const drafts = new RemoteDraftStore(path.join(root, 'drafts')), directory = path.join(root, 'suggestions'), bundles = path.join(root, 'bundles');
  const counts = {posts: 0, gets: 0}; let lose = false;
  const client = {origin: 'https://peer.example', browserCookies: () => [{name: 'urbauth-~nec', value: 'fixture'}],
    projectSuggestionSubmit: async (i: RemoteSuggestionIntent) => {counts.posts++; if (lose) throw new OutcomeUnknownError(); return reply(i, 'watching');},
    projectSuggestionResult: async (i: RemoteSuggestionIntent) => {counts.gets++; return reply(i, 'recorded');},
    projectBundleSubmit: async (_i: RemoteBundleIntent): Promise<never> => {counts.posts++; throw new OutcomeUnknownError();},
    projectBundleResult: async (_i: RemoteBundleIntent): Promise<never> => {counts.gets++; throw new Error('not read in this test');}};
  let made = 0;
  const draft = (file = '/lib/a/hoon') => {const first = drafts.create(observed('0x' + (++made).toString(16)), file); return drafts.save(first.id, `edit ${made}\n`);};
  return {directory, bundles, client, counts, draft, losing: (on: boolean) => {lose = on;}};
}

test('a send recorded and never started is closed as not sent without sending, in another process and against a window about to send', async t => {
  const x = setup(t), first = new RemoteSuggestionJournal(x.directory), d = x.draft();
  // One process records the suggestion and stops before sending.
  const claim = first.claim(d, d.text, observed('0xa1'));
  // Another process, later: the record says never sent, and offers to close it; nothing has been read from or sent to a ship.
  const later = new RemoteSuggestionJournal(x.directory), held = later.get(claim.request);
  assert.equal(suggestionStatus(held).state, 'local'); assert.equal(suggestionStatus(held).action, 'close-unsent');
  await assert.rejects(later.submit(x.client, claim.request), /Only a newly claimed suggestion can be sent once/);
  const closed = later.release(claim.request);
  assert.equal(closed.phase, 'refused-before-submit'); assert.equal(suggestionStatus(closed).state, 'not-sent'); assert.equal(suggestionStatus(closed).resolved, true);
  assert.deepEqual(closed.intent, held.intent); assert.deepEqual(closed.draft, held.draft);
  // The first process is still alive after all and tries to send its claim: it is refused before anything is sent.
  await assert.rejects(first.submit(x.client, claim.request), /Only a newly claimed suggestion can be sent once|observed in another window/);
  assert.deepEqual(x.counts, {posts: 0, gets: 0});
  // Closed is closed: not sent later, not claimed again for the same draft, not closed twice; and it is finished work.
  assert.throws(() => later.release(claim.request), /Only a suggestion that was never sent can be closed as not sent/);
  assert.throws(() => later.claim(d, d.text, observed('0xa2')), /already has a retained suggestion/);
  assert.equal(later.archive(claim.request).phase, 'refused-before-submit');
  assert.throws(() => new RemoteSuggestionJournal(x.directory).claim(d, d.text, observed('0xa3')), /already sent; its suggestion is in history/);
  assert.deepEqual(x.counts, {posts: 0, gets: 0});
});

test('a window that still holds the permit loses it to a close; a send that started, was checked, or has an outcome cannot be closed as not sent', async t => {
  const x = setup(t), journal = new RemoteSuggestionJournal(x.directory), other = new RemoteSuggestionJournal(x.directory);
  // The claiming window has not sent yet; another window closes the claim; the claiming window's send is refused under the lock.
  const a = x.draft(), racing = journal.claim(a, a.text, observed('0xb1'));
  other.release(racing.request);
  await assert.rejects(journal.submit(x.client, racing.request), /Only a newly claimed suggestion can be sent once|observed in another window/);
  assert.equal(x.counts.posts, 0);
  // Sent with no answer; sent and recorded; checked before sending: none of these is "never sent".
  const b = x.draft(), lost = journal.claim(b, b.text, observed('0xb2')); x.losing(true);
  await assert.rejects(journal.submit(x.client, lost.request)); x.losing(false);
  const c = x.draft(), done = journal.claim(c, c.text, observed('0xb3')); await journal.submit(x.client, done.request);
  const e = x.draft(), checked = journal.claim(e, e.text, observed('0xb4')); await other.observe(x.client, checked.request);
  assert.deepEqual([lost, done, checked].map(row => journal.get(row.request).phase), ['unknown', 'watching', 'recorded']);
  for (const row of [lost, done, checked]) assert.throws(() => other.release(row.request), /Only a suggestion that was never sent can be closed as not sent\. This one was sent or checked; read its result instead/);
  assert.equal(suggestionStatus(journal.get(lost.request)).state, 'unknown'); assert.equal(suggestionStatus(journal.get(lost.request)).action, 'check');
  // The unknown one is settled by reading, from the other window, with nothing sent again.
  assert.equal((await other.observe(x.client, lost.request)).phase, 'recorded'); assert.equal(x.counts.posts, 2);
});

test('a multi-file send that never started is closed the same way, and says why it was not sent', async t => {
  const x = setup(t), first = new RemoteBundleJournal(x.bundles), a = x.draft('/lib/a/hoon'), b = x.draft('/lib/b/hoon');
  const files = [{path: '/lib/a/hoon', source: a.text}, {path: '/lib/b/hoon', source: b.text}];
  const claim = first.claim([a.id, b.id], files, observed('0xc1'));
  const later = new RemoteBundleJournal(x.bundles);
  assert.equal(bundleStatus(later.get(claim.request)).state, 'local');
  const closed = later.release(claim.request);
  assert.equal(closed.phase, 'refused-before-submit'); assert.equal(closed.reason, 'closed-unsent'); assert.equal(bundleStanding(closed), 'finished');
  assert.equal(remoteBundleOutcome(closed.phase, closed.reason), 'Not sent: closed before it was sent; nothing left this computer');
  await assert.rejects(first.submit(x.client, claim.request), /sent once|observed in another window/);
  assert.equal(x.counts.posts, 0);
  assert.throws(() => later.release(claim.request), /Only a suggestion that was never sent/);
  assert.throws(() => later.claim([a.id, 'e'.repeat(64)], files, observed('0xc2')), /already sent in a multi-file suggestion/);
  // One that started sending is not "never sent", whatever happened to the answer.
  const c = x.draft('/lib/a/hoon'), d = x.draft('/lib/b/hoon'), sent = later.claim([c.id, d.id], [{path: '/lib/a/hoon', source: c.text}, {path: '/lib/b/hoon', source: d.text}], observed('0xc3'));
  await assert.rejects(later.submit(x.client, sent.request));
  assert.equal(later.get(sent.request).phase, 'unknown');
  assert.throws(() => later.release(sent.request), /read its result instead/);
});
