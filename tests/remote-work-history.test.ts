import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {RemoteDraftStore, type RemoteDraftRecord} from '../src/remote-draft-store';
import {RemoteSuggestionJournal} from '../src/remote-suggestion-journal';
import {RemoteBundleJournal, remoteBundleReply, type RemoteBundleIntent} from '../src/remote-bundle-suggest';
import {remoteSourceHash, type RemoteSourceObservation} from '../src/remote-project-view';
import type {RemoteSuggestionIntent, RemoteSuggestionReply} from '../src/remote-project-suggest';
import {draftStanding, finishedWork, fullWords, makeRoom, moveAllFinished, movedWords} from '../src/remote-work-history';

// The rules for what is finished and what moves when room is needed, on the real stores. The ship is a function here.
const hex = (n: number) => '0x' + n.toString(16).replace(/\B(?=(?:[0-9a-f]{4})+$)/g, '.');
const original = 'original\n';
function observed(n: number): RemoteSourceObservation {
  return {origin: 'https://peer.example', owner: '~zod', peer: '~nec', project: 'shared', generation: '1', request: hex(n),
    grant: '0x2', observedAt: '~2026.11.09', root: '0x3', snapshotDigest: '0x4', desk: 'shared', revision: '1',
    files: [{path: '/lib/a/hoon', text: original, hash: remoteSourceHash(original)}, {path: '/lib/b/hoon', text: original, hash: remoteSourceHash(original)}]};
}
function reply(i: RemoteSuggestionIntent, status: 'watching' | 'recorded'): RemoteSuggestionReply {
  const o = i.observation;
  return {owner: o.owner, peer: o.peer, project: o.project, generation: o.generation, request: i.request, permissionGranted: false, committed: false,
    status, viewRequest: o.request, grant: o.grant, root: o.root, snapshotDigest: o.snapshotDigest, path: i.path, sourceHash: remoteSourceHash(i.source),
    reason: status === 'recorded' ? 'suggestion-recorded' : 'awaiting-owner', deadline: '~2026.11.09..00.00.30', retainedUntil: '~2026.11.09..00.05.30', receiptHash: status === 'recorded' ? '0xa' : null};
}
function bundleWire(i: RemoteBundleIntent, status: string, reason: string, receipt: string | null = null): Record<string, unknown> {
  const o = i.observation;
  return {schema: 'readymade-project-bundle-result-v1', owner: o.owner, peer: o.peer, project: o.project, generation: o.generation, request: i.request,
    viewRequest: o.request, grant: o.grant, root: o.root, snapshotDigest: o.snapshotDigest, status, reason,
    files: i.files.map(f => ({path: f.path, sourceHash: remoteSourceHash(f.source)})),
    deadline: '~2026.11.16..10.08.50', retainedUntil: '~2026.11.16..10.13.50', permissionGranted: false, committed: false, receiptHash: receipt};
}
function setup(t: {after(fn: () => void): void}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-work-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const drafts = new RemoteDraftStore(path.join(root, 'drafts')), suggestions = new RemoteSuggestionJournal(path.join(root, 'suggestions')), bundles = new RemoteBundleJournal(path.join(root, 'bundles'));
  let made = 0, bundleStatus: [string, string, string | null] = ['recorded', 'bundle-recorded', '0xa'];
  const client = {origin: 'https://peer.example', browserCookies: () => [{name: 'urbauth-~nec', value: 'fixture'}],
    projectSuggestionSubmit: async (i: RemoteSuggestionIntent) => reply(i, 'watching'), projectSuggestionResult: async (i: RemoteSuggestionIntent) => reply(i, 'recorded'),
    projectBundleSubmit: async (i: RemoteBundleIntent) => remoteBundleReply(202, bundleWire(i, 'watching', 'awaiting-owner'), i, true),
    projectBundleResult: async (i: RemoteBundleIntent) => remoteBundleReply(200, bundleWire(i, ...bundleStatus), i)};
  /** An open draft with an edit, of file `a` or `b` of a new read. */
  const draft = (file = '/lib/a/hoon'): RemoteDraftRecord => {const first = drafts.create(observed(++made), file); return drafts.save(first.id, `edit ${made}\n`);};
  /** A single-file suggestion for an open draft: only recorded on this computer, or sent and recorded by the owner. */
  const suggest = async (d: RemoteDraftRecord, finish: boolean) => {
    const claim = suggestions.claim(d, d.text, {...d.observation, request: hex(700000 + made++)});
    if (finish) {await suggestions.submit(client, claim.request); await suggestions.observe(client, claim.request);}
    return claim.request;
  };
  const bundle = async (a: RemoteDraftRecord, b: RemoteDraftRecord, status: typeof bundleStatus | undefined) => {
    const claim = bundles.claim([a.id, b.id], [{path: '/lib/a/hoon', source: a.text}, {path: '/lib/b/hoon', source: b.text}], {...a.observation, request: hex(800000 + made++)});
    if (status) {bundleStatus = status; await bundles.submit(client, claim.request); await bundles.observe(client, claim.request);}
    return claim.request;
  };
  return {stores: {drafts, suggestions, bundles}, draft, suggest, bundle};
}

test('finished means the owner recorded it, refused it, or it never started; unsent drafts and unsettled sends are never finished', async t => {
  const x = setup(t), {stores} = x;
  const unsent = x.draft(), waiting = x.draft(), done = x.draft(), older = x.draft();
  await x.suggest(waiting, false); const first = await x.suggest(older, true), second = await x.suggest(done, true);
  const a = x.draft('/lib/a/hoon'), b = x.draft('/lib/b/hoon'), c = x.draft('/lib/a/hoon'), d = x.draft('/lib/b/hoon'), e = x.draft('/lib/a/hoon'), f = x.draft('/lib/b/hoon');
  const recorded = await x.bundle(a, b, ['recorded', 'bundle-recorded', '0xa']), ended = await x.bundle(c, d, ['uncertain', 'suggest-timeout', null]);
  await x.bundle(e, f, undefined);
  assert.deepEqual([unsent, waiting, done, a, c, e].map(row => draftStanding(stores, row.id)), ['unsent', 'unsettled', 'finished', 'finished', 'ended', 'unsettled']);
  // Oldest first, by when each send settled; nothing unsent, unsettled or ended without a result is among them.
  assert.deepEqual(finishedWork(stores).map(unit => [unit.kind, unit.request]), [['suggestion', first], ['suggestion', second], ['bundle', recorded]]);
  assert.equal(finishedWork(stores).some(unit => unit.request === ended), false);
  // Work that includes a draft the person has open in an editor is left where it is.
  assert.deepEqual(finishedWork(stores, id => id === b.id || id === older.id).map(unit => unit.request), [second]);
  // Everything finished moves, with its drafts; the rest is exactly where it was.
  assert.deepEqual(moveAllFinished(stores), {sends: 3, drafts: 4});
  assert.deepEqual(stores.drafts.list().map(row => row.id).sort(), [unsent, waiting, c, d, e, f].map(row => row.id).sort());
  assert.equal(stores.suggestions.list().length, 1); assert.equal(stores.bundles.list().length, 2);
  assert.deepEqual(moveAllFinished(stores), {sends: 0, drafts: 0});
  // A sent draft brought back to look at is still marked as sent by its record in history, and is finished work again.
  stores.drafts.restore(done.id);
  assert.equal(draftStanding(stores, done.id), 'finished');
  assert.deepEqual(finishedWork(stores).map(unit => [unit.kind, unit.drafts]), [['draft', [done.id]]]);
  assert.deepEqual(moveAllFinished(stores), {sends: 0, drafts: 1});
  assert.equal(movedWords({sends: 3, drafts: 4}), '3 finished suggestions and 4 finished drafts'); assert.equal(movedWords({sends: 1, drafts: 0}), '1 finished suggestion');
  assert.equal(movedWords({sends: 0, drafts: 1}), '1 finished draft');
});

test('room is made only when a store is full, only from finished work, oldest first, and no more than needed', async t => {
  const x = setup(t), {stores} = x, all: RemoteDraftRecord[] = [];
  // 64 open drafts and 64 open suggestions: four recorded by the owner (the 3rd, 10th, 20th, 30th made), sixty not yet sent.
  const settled: string[] = [];
  for (let n = 0; n < 64; n++) {const d = x.draft(); all.push(d); const request = await x.suggest(d, [2, 9, 19, 29].includes(n)); if ([2, 9, 19, 29].includes(n)) settled.push(request);}
  assert.equal(stores.drafts.open, 64); assert.equal(stores.suggestions.list().length, 64);
  // Nothing is needed: nothing moves, even though finished work exists.
  assert.deepEqual(makeRoom(stores, {}), {sends: 0, drafts: 0, short: []});
  // One more suggestion: exactly the oldest finished one moves, with its draft.
  assert.deepEqual(makeRoom(stores, {suggestions: 1}), {sends: 1, drafts: 1, short: []});
  assert.equal(stores.suggestions.find(settled[0])!.phase, 'recorded'); assert.equal(stores.suggestions.list().some(row => row.request === settled[0]), false);
  assert.equal(stores.drafts.archived(all[2].id)!.text, all[2].text); assert.equal(stores.suggestions.list().length, 63); assert.equal(stores.drafts.open, 63);
  // There is room now: asking again moves nothing.
  assert.deepEqual(makeRoom(stores, {suggestions: 1, drafts: 1}), {sends: 0, drafts: 0, short: []});
  // Three more drafts: one place is free, so two more finished pieces move; the one whose draft is open in an editor is skipped.
  assert.deepEqual(makeRoom(stores, {drafts: 3}, id => id === all[9].id), {sends: 2, drafts: 2, short: []});
  assert.deepEqual([settled[1], settled[2], settled[3]].map(request => stores.suggestions.list().some(row => row.request === request)), [true, false, false]);
  // More than finished work can free: what can move moves, and the store that is still full is named. Nothing unsent or unsettled moved.
  assert.deepEqual(makeRoom(stores, {drafts: 6}), {sends: 1, drafts: 1, short: ['drafts']});
  assert.equal(stores.drafts.open, 60); assert.equal(stores.suggestions.list().length, 60);
  assert.equal(stores.suggestions.list().every(row => row.phase === 'claimed'), true);
  assert.deepEqual(makeRoom(stores, {suggestions: 5, bundles: 1}), {sends: 0, drafts: 0, short: ['suggestions']});
  for (const store of ['drafts', 'suggestions', 'bundles'] as const) {assert.match(fullWords(store), /^64 /); assert.doesNotMatch(fullWords(store), /delet|discard/i);}
  assert.equal(stores.drafts.archivedPage(0, 64).total, 4); assert.equal(stores.suggestions.archivedPage(0, 64).total, 4);
});

test('a second window sees what the first one moved: it neither refuses for a store that has room nor keeps showing a moved draft', async t => {
  const x = setup(t), {stores} = x;
  for (let n = 0; n < 64; n++) {const d = x.draft(); await x.suggest(d, n < 3);}
  // The second window opened while all 64 places were taken.
  const second = {drafts: new RemoteDraftStore(stores.drafts.directory), suggestions: new RemoteSuggestionJournal(stores.suggestions.directory), bundles: new RemoteBundleJournal(stores.bundles.directory)};
  assert.equal(second.drafts.open, 64);
  assert.deepEqual(moveAllFinished(stores), {sends: 3, drafts: 3});
  // It counts what is on disk now: there is room, nothing needs to move, and the moved drafts are in its history list, not its open list.
  assert.equal(second.drafts.open, 61); assert.equal(second.drafts.list().length, 61);
  assert.deepEqual(makeRoom(second, {drafts: 1, suggestions: 1}), {sends: 0, drafts: 0, short: []});
  assert.equal(second.drafts.archivedPage(0, 8).drafts.length, 3);
  const made = second.drafts.create({...second.drafts.list()[0].observation, request: '0xfeed'}, '/lib/a/hoon');
  // And the first window sees the draft the second one made.
  assert.equal(stores.drafts.open, 62); assert.equal(stores.drafts.get(made.id).path, '/lib/a/hoon');
});
