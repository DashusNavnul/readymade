import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {RecordHistory} from '../src/private-history';
import {RemoteDraftStore} from '../src/remote-draft-store';
import {RemoteSuggestionJournal, suggestionSettled} from '../src/remote-suggestion-journal';
import {RemoteBundleJournal, bundleStanding, remoteBundleReply, type RemoteBundleIntent, type RemoteBundleReply} from '../src/remote-bundle-suggest';
import {remoteSourceHash, type RemoteSourceObservation} from '../src/remote-project-view';
import type {RemoteSuggestionIntent, RemoteSuggestionReply} from '../src/remote-project-suggest';

// Drafts, single-file suggestions and multi-file suggestions each keep 64 open records and a history beside them.
// These tests use the real stores on real private folders; the ship is a function in this file.
type After = {after(fn: () => void): void};
function folder(t: After): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-history-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true})); return root;
}
/** A ship's hexadecimal: no leading zero, a dot every four digits from the right. */
const hex = (n: number) => '0x' + n.toString(16).replace(/\B(?=(?:[0-9a-f]{4})+$)/g, '.');
const original = 'original\n';
/** The owner's files as read once; every `n` is another read, so another draft. */
function observed(n: number): RemoteSourceObservation {
  return {origin: 'https://peer.example', owner: '~zod', peer: '~nec', project: 'shared', generation: '1', request: hex(n),
    grant: '0x2', observedAt: '~2026.11.09', root: '0x3', snapshotDigest: '0x4', desk: 'shared', revision: '1',
    files: [{path: '/lib/a/hoon', text: original, hash: remoteSourceHash(original)}, {path: '/lib/b/hoon', text: original, hash: remoteSourceHash(original)}]};
}
const names = (directory: string) => fs.existsSync(directory) ? fs.readdirSync(directory).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).sort() : [];
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('a record moves to history byte for byte, an interrupted move is finished by doing it again, and nothing is overwritten by an older copy', t => {
  const store = path.join(folder(t), 'store'), a = 'a'.repeat(64), k = 'c'.repeat(64);
  fs.mkdirSync(store, {mode: 0o700});
  const write = (name: string, text: string) => fs.writeFileSync(path.join(store, name + '.json'), text, {mode: 0o600});
  const history = new RecordHistory(store, 'Test storage');
  assert.equal(history.has(a), false); assert.equal(history.read(a), undefined); assert.deepEqual(history.page(), {total: 0, names: []});
  assert.throws(() => history.move(a), /not open/);
  write(a, 'first'); history.move(a, [['draft', k]]);
  assert.equal(fs.existsSync(path.join(store, a + '.json')), false);
  assert.equal(history.read(a)?.toString(), 'first'); assert.equal(history.read(k, 'draft')?.toString(), 'first');
  assert.equal(history.has(a), true); assert.equal(history.has(k, 'draft'), true); assert.equal(history.has(k), false);
  for (const file of [path.join(store, 'history'), path.join(store, 'history', 'draft')]) assert.equal(fs.statSync(file).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(store, 'history', a + '.json')).mode & 0o777, 0o600);
  // Interrupted after the copy was written and before the open file was removed: both exist. Doing the move again finishes it.
  write(a, 'first'); history.move(a, [['draft', k]]);
  assert.equal(fs.existsSync(path.join(store, a + '.json')), false); assert.equal(history.read(a)?.toString(), 'first');
  // Interrupted, then the open record went on changing: the open one is the record, and replaces the copy left behind, links included.
  write(a, 'second'); history.move(a, [['draft', k]]);
  assert.equal(history.read(a)?.toString(), 'second'); assert.equal(history.read(k, 'draft')?.toString(), 'second');
  // Back among the open records, exactly; history lets go of it last. A record already open stays as it is.
  history.restore(a);
  assert.equal(fs.readFileSync(path.join(store, a + '.json'), 'utf8'), 'second'); assert.equal(history.has(a), false);
  assert.throws(() => history.restore(a), /does not hold/);
  history.move(a); write(a, 'third'); history.restore(a);
  assert.equal(fs.readFileSync(path.join(store, a + '.json'), 'utf8'), 'third'); assert.equal(history.has(a), false);
  // Names only, newest move first, a page at a time.
  const b = 'b'.repeat(64); write(b, 'b'); history.move(b); history.move(a);
  fs.utimesSync(path.join(store, 'history', b + '.json'), new Date(1000), new Date(1000));
  assert.deepEqual(history.page(0, 1), {total: 2, names: [a]}); assert.deepEqual(history.page(1, 5), {total: 2, names: [b]});
  for (const bad of ['../x', 'A'.repeat(64), a + '0', '']) assert.throws(() => history.has(bad), /Invalid/);
});

test('history that is not private, or reached through a link, is refused and never read or written through', t => {
  const root = folder(t), store = path.join(root, 'store'), a = 'a'.repeat(64);
  fs.mkdirSync(store, {mode: 0o700}); fs.writeFileSync(path.join(store, a + '.json'), 'x', {mode: 0o600});
  const history = new RecordHistory(store, 'Test storage');
  fs.mkdirSync(path.join(store, 'history'), {mode: 0o755});
  assert.throws(() => history.move(a), /private and owned/); assert.throws(() => history.has(a), /private and owned/);
  assert.equal(fs.existsSync(path.join(store, a + '.json')), true);
  fs.rmdirSync(path.join(store, 'history')); fs.mkdirSync(path.join(root, 'elsewhere'), {mode: 0o700});
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(store, 'history'));
  assert.throws(() => history.move(a), /private and owned/); assert.deepEqual(fs.readdirSync(path.join(root, 'elsewhere')), []);
  fs.unlinkSync(path.join(store, 'history')); history.move(a);
  fs.chmodSync(path.join(store, 'history', a + '.json'), 0o644);
  assert.throws(() => history.read(a), /private and owned/);
  fs.unlinkSync(path.join(store, 'history', a + '.json')); fs.writeFileSync(path.join(root, 'secret'), 'secret', {mode: 0o600});
  fs.symlinkSync(path.join(root, 'secret'), path.join(store, 'history', a + '.json'));
  assert.throws(() => history.read(a)); assert.equal(history.has(a), true);
});

test('the 65th draft is refused only while 64 are open; finished drafts move to history and stay exact and restorable, round after round', t => {
  const directory = path.join(folder(t), 'drafts');
  let store = new RemoteDraftStore(directory), made = 0;
  const fill = () => {
    const ids: string[] = [];
    while (store.open < 64) {const draft = store.create(observed(++made), '/lib/a/hoon'); store.save(draft.id, `edit ${made}\n`); ids.push(draft.id);}
    return ids;
  };
  const moved: {id: string; bytes: string}[] = [];
  // Round one moves eight, the next two move six each. Every round starts with 64 open and refuses one more.
  for (const take of [8, 6, 6]) {
    const ids = fill();
    assert.equal(names(directory).length, 64);
    assert.throws(() => store.create(observed(1000 + take + moved.length), '/lib/a/hoon'), /64 remote drafts are open\. Move finished drafts to history/);
    assert.equal(names(directory).length, 64);
    // An old store is this same folder without a history: nothing about its files is changed by reading it.
    const before = names(directory).map(n => sha(path.join(directory, n)));
    store = new RemoteDraftStore(directory);
    assert.deepEqual(names(directory).map(n => sha(path.join(directory, n))), before);
    for (const id of ids.slice(0, take)) {
      const bytes = sha(path.join(directory, id + '.json'));
      store.archive(id); moved.push({id, bytes});
      assert.equal(sha(path.join(directory, 'history', id + '.json')), bytes);
    }
    assert.throws(() => store.get(moved.at(-1)!.id), /Unknown remote draft/);
  }
  assert.equal(made, 78); assert.equal(moved.length, 20);
  // Reopened: the open drafts are the open drafts, history is all there, and one page reads one page.
  store = new RemoteDraftStore(directory);
  assert.equal(store.open, 58); assert.equal(store.list().length, 58);
  const page = store.archivedPage(0, 5);
  assert.equal(page.total, moved.length); assert.equal(page.drafts.length, 5);
  for (const {id} of moved) assert.equal(store.holds(id), true);
  const first = store.archived(moved[0].id)!;
  assert.equal(first.text, 'edit 1\n'); assert.deepEqual(first.observation, observed(1)); assert.equal(first.path, '/lib/a/hoon');
  // Restored exactly, by name or by opening the same file of the same read again; it is editable again.
  assert.equal(store.restore(moved[0].id).text, 'edit 1\n'); assert.equal(sha(path.join(directory, moved[0].id + '.json')), moved[0].bytes);
  assert.equal(store.create(observed(2), '/lib/a/hoon').text, 'edit 2\n'); assert.equal(store.archived(moved[1].id), undefined);
  assert.equal(store.save(moved[1].id, 'edit 2 again\n').text, 'edit 2 again\n');
  assert.throws(() => store.restore(moved[1].id), /not in history/);
  // Restoring needs room among the 64, and says so; history is untouched by the refusal.
  fill();
  assert.throws(() => store.restore(moved[2].id), /64 remote drafts are open/); assert.equal(store.archived(moved[2].id)!.text, 'edit 3\n');
});

test('a draft moved in one window cannot be silently overwritten or lost from another', t => {
  const directory = path.join(folder(t), 'drafts'), one = new RemoteDraftStore(directory), draft = one.create(observed(1), '/lib/a/hoon');
  one.save(draft.id, 'mine\n');
  const two = new RemoteDraftStore(directory);
  // The other window edited after this one read: this window's move is refused and the edit stays.
  two.save(draft.id, 'theirs\n');
  assert.throws(() => one.archive(draft.id), /changed in another window/);
  assert.equal(new RemoteDraftStore(directory).get(draft.id).text, 'theirs\n');
  two.archive(draft.id);
  // The first window still shows what it read; its save is refused with the reason, and history keeps the moved text.
  assert.throws(() => one.save(draft.id, 'late\n'), /moved to history in another window\. Restore it before editing/);
  assert.equal(two.archived(draft.id)!.text, 'theirs\n'); assert.equal(names(directory).length, 0);
  // A lock another window holds stops a move like any other write.
  const kept = one.restore(draft.id);
  fs.writeFileSync(path.join(directory, '.write.lock'), '', {mode: 0o600});
  assert.throws(() => one.archive(kept.id), /EEXIST/); fs.unlinkSync(path.join(directory, '.write.lock'));
  assert.equal(one.get(kept.id).text, 'theirs\n');
});

function suggestionReply(i: RemoteSuggestionIntent, status: 'watching' | 'recorded' | 'missing'): RemoteSuggestionReply {
  const o = i.observation, common = {owner: o.owner, peer: o.peer, project: o.project, generation: o.generation, request: i.request, permissionGranted: false as const, committed: false as const};
  if (status === 'missing') return {...common, status};
  return {...common, status, viewRequest: o.request, grant: o.grant, root: o.root, snapshotDigest: o.snapshotDigest, path: i.path, sourceHash: remoteSourceHash(i.source),
    reason: status === 'recorded' ? 'suggestion-recorded' : 'awaiting-owner', deadline: '~2026.11.09..00.00.30', retainedUntil: '~2026.11.09..00.05.30', receiptHash: status === 'recorded' ? '0xa' : null};
}
function suggesting(t: After) {
  const root = folder(t), directory = path.join(root, 'suggestions');
  const counts = {posts: 0, gets: 0}; let answer: 'recorded' | 'missing' = 'recorded';
  const client = {origin: 'https://peer.example', browserCookies: () => [{name: 'urbauth-~nec', value: 'fixture'}],
    projectSuggestionSubmit: async (i: RemoteSuggestionIntent) => {counts.posts++; return suggestionReply(i, 'watching');},
    projectSuggestionResult: async (i: RemoteSuggestionIntent) => {counts.gets++; return suggestionReply(i, answer);}};
  let made = 0;
  /**
   * One new draft with an edit, and the fresh read a send is bound to. The draft store only mints the record (a new
   * folder every 60, so its own 64 never interferes); the edit is made on the record, which is what a claim checks.
   */
  const draft = () => {
    const first = new RemoteDraftStore(path.join(root, 'drafts-' + Math.floor(made / 60))).create(observed(++made), '/lib/a/hoon');
    return {draft: {...first, text: `edit ${made}\n`, updatedAt: first.updatedAt + 1}, fresh: observed(100000 + made)};
  };
  return {directory, client, counts, draft, answers: (next: typeof answer) => {answer = next;}};
}

test('the 65th suggestion is refused only while 64 are open; finished ones move to history, which still refuses a second send of their drafts', async t => {
  const x = suggesting(t); let journal = new RemoteSuggestionJournal(x.directory);
  const sent: {draftId: string; request: string; bytes: string}[] = [];
  let claims = 0;
  const finish = async (request: string) => {await journal.submit(x.client, request); assert.equal((await journal.observe(x.client, request)).phase, 'recorded');};
  // Round one is the full case: 64 suggestions, every one recorded by the owner. Round two finishes four and
  // leaves the rest recorded on this computer only, which costs the test fewer forced disk writes.
  for (const finished of [64, 4]) {
    const open: {draftId: string; request: string}[] = [];
    while (journal.list().length < 64) {
      const d = x.draft(), claim = journal.claim(d.draft, d.draft.text, d.fresh); claims++;
      if (open.length < finished) {await finish(claim.request); open.push({draftId: claim.draftId, request: claim.request});}
    }
    const extra = x.draft();
    assert.throws(() => journal.claim(extra.draft, extra.draft.text, extra.fresh), /64 suggestions are open\. Move finished ones to history/);
    journal = new RemoteSuggestionJournal(x.directory);        // Reopening makes no room by itself, as before.
    assert.throws(() => journal.claim(extra.draft, extra.draft.text, extra.fresh), /64 suggestions are open/);
    for (const row of open) {
      const bytes = sha(path.join(x.directory, row.draftId + '.json'));
      assert.equal(journal.archive(row.request).phase, 'recorded'); sent.push({...row, bytes});
      assert.equal(sha(path.join(x.directory, 'history', row.draftId + '.json')), bytes);
    }
    // One more than 64 in this round: there is room now, and it is sent and finished like any other.
    const claim = journal.claim(extra.draft, extra.draft.text, extra.fresh); claims++;
    await finish(claim.request); journal.archive(claim.request);
    sent.push({draftId: claim.draftId, request: claim.request, bytes: sha(path.join(x.directory, 'history', claim.draftId + '.json'))});
  }
  assert.equal(sent.length, 70); assert.equal(x.counts.posts, 70); assert.equal(claims, 64 + 1 + 64 + 1); assert.equal(names(x.directory).length, 60);
  // Another process, later: history is all there, one page reads one page, and each record is found by its request.
  const later = new RemoteSuggestionJournal(x.directory), page = later.archivedPage(0, 7);
  assert.equal(page.total, 70); assert.equal(page.suggestions.length, 7); assert.equal(later.list().length, 60);
  const found = later.find(sent[3].request)!;
  assert.equal(found.phase, 'recorded'); assert.equal(found.draftId, sent[3].draftId); assert.equal(found.intent.path, '/lib/a/hoon');
  assert.equal(later.find('0x' + 'f'.repeat(4)), undefined);
  assert.equal(later.archived(sent[3].draftId)!.request, sent[3].request);
  // No route from history back to a send: not by claiming the draft again, not by the old request, in this process or the first.
  for (const each of [later, journal]) {
    assert.equal(each.holds(sent[3].draftId), true); assert.equal(each.holds('e'.repeat(64)), false);
    assert.throws(() => each.claim({...found.draft}, found.draft.text, {...found.intent.observation, request: '0xabcd'}), /already sent; its suggestion is in history/);
    await assert.rejects(each.submit(x.client, sent[3].request), /Retained suggestion not found/);
    await assert.rejects(each.observe(x.client, sent[3].request), /Retained suggestion not found/);
    assert.throws(() => each.archive(sent[3].request), /Retained suggestion not found/);
  }
  assert.equal(x.counts.posts, 70);
  for (const row of sent) assert.equal(sha(path.join(x.directory, 'history', row.draftId + '.json')), row.bytes);
});

test('a send whose outcome is not settled never moves to history, and an interrupted move leaves the record open and protected', async t => {
  const x = suggesting(t), journal = new RemoteSuggestionJournal(x.directory);
  const claim = () => {const d = x.draft(); return journal.claim(d.draft, d.draft.text, d.fresh);};
  // Recorded on this computer only; sent with no answer yet; answered "not held".
  const local = claim(), sent = claim(), lost = claim();
  await journal.submit(x.client, sent.request);
  await journal.submit(x.client, lost.request); x.answers('missing'); await journal.observe(x.client, lost.request);
  assert.deepEqual([local, sent, lost].map(row => journal.get(row.request).phase), ['claimed', 'watching', 'missing']);
  for (const row of [local, sent, lost]) {
    assert.equal(suggestionSettled(journal.get(row.request)), false);
    assert.throws(() => journal.archive(row.request), /Only a finished suggestion moves to history\. Check this one first/);
  }
  assert.equal(names(path.join(x.directory, 'history')).length, 0); assert.equal(journal.list().length, 3);
  // Finished, and its move interrupted after the copy was written: it is still open, still found once, still refuses its draft.
  x.answers('recorded'); const done = await journal.observe(x.client, sent.request);
  assert.equal(done.phase, 'recorded');
  const open = path.join(x.directory, done.draftId + '.json'), bytes = fs.readFileSync(open);
  journal.archive(done.request); fs.writeFileSync(open, bytes, {mode: 0o600});
  const again = new RemoteSuggestionJournal(x.directory);
  assert.equal(again.list().filter(row => row.request === done.request).length, 1); assert.equal(again.archivedPage().suggestions.length, 0);
  assert.throws(() => again.claim(done.draft, done.draft.text, {...done.intent.observation, request: '0xabcd'}), /already has a retained suggestion/);
  await assert.rejects(again.submit(x.client, done.request), /Only a newly claimed suggestion can be sent once/);
  // A second window finishes the move; the first window, which read before, cannot send or claim either.
  assert.equal(again.archive(done.request).phase, 'recorded');
  assert.equal(fs.existsSync(open), false); assert.equal(again.archivedPage().suggestions.length, 1);
  assert.throws(() => journal.claim(done.draft, done.draft.text, {...done.intent.observation, request: '0xabcd'}), /in history/);
  assert.equal(x.counts.posts, 2);
});

const bundleFiles = [{path: '/lib/a/hoon', source: 'original\n::  a\n'}, {path: '/lib/b/hoon', source: 'original\n::  b\n'}];
function bundleWire(i: RemoteBundleIntent, status: string, reason: string, receipt: string | null = null): Record<string, unknown> {
  const o = i.observation;
  return {schema: 'readymade-project-bundle-result-v1', owner: o.owner, peer: o.peer, project: o.project, generation: o.generation, request: i.request,
    viewRequest: o.request, grant: o.grant, root: o.root, snapshotDigest: o.snapshotDigest, status, reason,
    files: i.files.map(f => ({path: f.path, sourceHash: remoteSourceHash(f.source)})),
    deadline: '~2026.11.16..10.08.50', retainedUntil: '~2026.11.16..10.13.50', permissionGranted: false, committed: false, receiptHash: receipt};
}

test('the 65th multi-file suggestion is refused only while 64 are open; history keeps every sent draft marked as sent', async t => {
  const directory = path.join(folder(t), 'bundles'); let journal = new RemoteBundleJournal(directory);
  const counts = {posts: 0}; let post: (i: RemoteBundleIntent) => RemoteBundleReply = i => remoteBundleReply(202, bundleWire(i, 'watching', 'awaiting-owner'), i, true);
  const client = {origin: 'https://peer.example', browserCookies: () => [{name: 'urbauth-~nec', value: 'fixture'}],
    projectBundleSubmit: async (i: RemoteBundleIntent) => {counts.posts++; return post(i);},
    projectBundleResult: async (i: RemoteBundleIntent) => remoteBundleReply(200, bundleWire(i, 'recorded', 'bundle-recorded', '0xa'), i)};
  let made = 0; const pair = () => [(++made).toString(16).padStart(64, '0'), (++made).toString(16).padStart(64, '0')];
  const recorded = async (drafts: string[]) => {
    const claim = journal.claim(drafts, bundleFiles, observed(500000 + made));
    await journal.submit(client, claim.request); await journal.observe(client, claim.request); return claim.request;
  };
  const moved: {request: string; drafts: string[]}[] = [];
  // Each round fills the 64 open places, eight of them recorded by the owner and the rest recorded on this computer
  // only; the eight move to history and one more than 64 is then sent. Three rounds, reopened in between.
  for (let round = 0; round < 3; round++) {
    const open: {request: string; drafts: string[]}[] = [];
    while (journal.list().length < 64) {
      const drafts = pair();
      if (open.length < 8) open.push({request: await recorded(drafts), drafts}); else journal.claim(drafts, bundleFiles, observed(500000 + made));
    }
    const extra = pair();
    assert.throws(() => journal.claim(extra, bundleFiles, observed(1)), /64 multi-file suggestions are open\. Move finished ones to history/);
    journal = new RemoteBundleJournal(directory);
    for (const row of open) {assert.equal(journal.archive(row.request).phase, 'recorded'); moved.push(row);}
    moved.push({request: await recorded(extra), drafts: extra});          // One more than 64 in this round.
    journal.archive(moved.at(-1)!.request);
  }
  assert.equal(moved.length, 27); assert.equal(counts.posts, 27); assert.equal(names(directory).length, 56);
  const later = new RemoteBundleJournal(directory);
  assert.equal(later.archivedPage(0, 9).total, 27); assert.equal(later.archivedPage(0, 9).bundles.length, 9); assert.equal(later.claimedDrafts().size, 112);
  assert.equal(later.find(moved[5].request)!.receiptHash, '0xa'); assert.equal(later.find('0xffff'), undefined);
  // Every draft of every moved suggestion is still marked as sent, by name, and is refused in any new combination.
  for (const row of moved) for (const id of row.drafts) assert.equal(later.holdsDraft(id), true);
  assert.equal(later.holdsDraft('e'.repeat(64)), false);
  for (const each of [later, journal]) {
    assert.throws(() => each.claim([moved[5].drafts[1], 'e'.repeat(64)], bundleFiles, observed(2)), /already sent in a multi-file suggestion that is now in history/);
    await assert.rejects(each.submit(client, moved[5].request), /not found/);
  }
  // Ended without an outcome: it moves only when the person says so, and history keeps saying what it was.
  post = i => remoteBundleReply(202, bundleWire(i, 'uncertain', 'suggest-timeout'), i, true);
  const ended = later.claim(pair(), bundleFiles, observed(3)); await later.submit(client, ended.request);
  assert.equal(bundleStanding(later.get(ended.request)), 'ended');
  assert.throws(() => later.archive(ended.request), /Only a finished suggestion moves to history/);
  assert.equal(later.archive(ended.request, true).phase, 'uncertain'); assert.equal(later.find(ended.request)!.phase, 'uncertain');
  assert.equal(later.find(ended.request)!.reason, 'suggest-timeout');
  // Still being sent or still checkable: it stays, whoever asks.
  post = i => remoteBundleReply(202, bundleWire(i, 'watching', 'awaiting-owner'), i, true);
  const waiting = later.claim(pair(), bundleFiles, observed(4)), claimed = later.claim(pair(), bundleFiles, observed(5));
  await later.submit(client, waiting.request);
  for (const row of [waiting, claimed]) {
    assert.equal(bundleStanding(later.get(row.request)), 'open');
    assert.throws(() => later.archive(row.request, true), /Only a finished suggestion moves to history/);
  }
  assert.equal(bundleStanding({phase: 'uncertain', reason: 'poke-refused'}), 'finished'); assert.equal(bundleStanding({phase: 'refused', reason: 'stale-parent'}), 'finished');
});
