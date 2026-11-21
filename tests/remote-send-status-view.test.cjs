// What the shared-project tree says about a send, and what its next step does, with the real view and stores.
// The ship is a set of functions in this file; every request to it is counted.
const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const original = Module._load;
const ui = {said: [], documents: [], Uri: {parse: value => ({toString: () => value})},
  window: {showInformationMessage: message => {ui.said.push(message);}},
  workspace: {registerTextDocumentContentProvider: () => ({dispose() {}}), get textDocuments() {return ui.documents;}}};
let RemoteSourceView, RemoteDraftStore, RemoteSuggestionJournal, RemoteBundleJournal, remoteSourceHash, ShipClientError, OutcomeUnknownError;
try {
  Module._load = function(name, ...args) {return name === 'vscode' ? ui : original.call(this, name, ...args);};
  ({RemoteSourceView} = require('../dist/src/remote-source-view'));
  ({RemoteDraftStore} = require('../dist/src/remote-draft-store'));
  ({RemoteSuggestionJournal} = require('../dist/src/remote-suggestion-journal'));
  ({RemoteBundleJournal} = require('../dist/src/remote-bundle-suggest'));
  ({remoteSourceHash} = require('../dist/src/remote-project-view'));
  ({ShipClientError, OutcomeUnknownError} = require('../dist/src/ship-client'));
} finally {Module._load = original;}

const text = 'original\n';
const observed = request => ({origin: 'https://peer.example', owner: '~zod', peer: '~nec', project: 'shared', generation: '1', request,
  grant: '0x2', observedAt: '~2026.11.09', root: '0x3', snapshotDigest: '0x4', desk: 'shared', revision: '1',
  files: [{path: '/lib/a/hoon', text, hash: remoteSourceHash(text)}, {path: '/lib/b/hoon', text, hash: remoteSourceHash(text)}]});
function reply(i, status, recovery = false) {
  const o = i.observation, common = {owner: o.owner, peer: o.peer, project: o.project, generation: o.generation, request: i.request, permissionGranted: false, committed: false};
  if (status === 'missing') return {...common, status, ...(recovery ? {recovery: true} : {})};
  return {...common, status, viewRequest: o.request, grant: o.grant, root: o.root, snapshotDigest: o.snapshotDigest, path: i.path, sourceHash: remoteSourceHash(i.source),
    reason: status === 'recorded' ? 'suggestion-recorded' : 'awaiting-owner', deadline: '~2026.11.09..00.00.30', retainedUntil: '~2026.11.09..00.05.30',
    receiptHash: status === 'recorded' ? '0xa' : null, ...(recovery ? {recovery: true} : {})};
}
function setup(t, actor = '~nec') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-send-view-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  ui.said.length = 0; ui.documents = [];
  const drafts = new RemoteDraftStore(path.join(root, 'drafts')), directory = path.join(root, 'suggestions');
  const counts = {posts: 0, gets: 0, recovers: 0, recoveryGets: 0}, ship = {result: () => 'recorded', recover: () => 'recorded', recovered: () => 'recorded'};
  const answer = (how, i, recovery) => {const value = how(); if (value instanceof Error) throw value; return reply(i, value, recovery);};
  const client = {origin: 'https://peer.example', browserCookies: () => [{name: 'urbauth-' + actor, value: 'fixture'}],
    projectSuggestionSubmit: async i => {counts.posts++; return reply(i, 'watching');},
    projectSuggestionResult: async i => {counts.gets++; return answer(ship.result, i);},
    projectSuggestionRecover: async i => {counts.recovers++; return answer(ship.recover, i, true);},
    projectSuggestionRecoveryResult: async i => {counts.recoveryGets++; return answer(ship.recovered, i, true);}};
  const state = {client};
  // The view of a new process: it reads the journal folder afresh, as after a restart.
  const reopen = () => {
    const suggestions = new RemoteSuggestionJournal(directory), bundles = new RemoteBundleJournal(path.join(root, 'bundles'));
    const view = new RemoteSourceView('readymade.test', () => state.client, async () => state.client, () => undefined, drafts, suggestions, bundles);
    t.after(() => view.dispose()); return {view, suggestions, bundles};
  };
  let made = 0;
  const draft = () => {const first = drafts.create(observed('0x' + (++made).toString(16)), '/lib/a/hoon'); return drafts.save(first.id, `edit ${made}\n`);};
  return {drafts, directory, counts, ship, client, state, reopen, draft};
}
const row = (view, id) => view.rows()[0].children.find(r => r.children?.some(c => c.command?.arguments?.[0] === id && c.command.command === 'readymade.openSharedDraft'));
const labels = r => r.children.map(c => c.label);
const act = (r, label) => r.children.find(c => c.label === label)?.command;

test('a suggestion recorded before Readymade stopped is shown as never sent, closed without a request to any ship, and leaves its draft free to continue', async t => {
  const x = setup(t), d = x.draft();
  const claim = new RemoteSuggestionJournal(x.directory).claim(d, d.text, observed('0xa1'));     // Recorded; the process ends here.
  const {view, suggestions} = x.reopen(), shown = row(view, d.id);
  assert.deepEqual(labels(shown).filter(l => !['Open Draft', 'Compare', 'Reconcile'].includes(l)), ['Recorded on this computer — never sent', 'Close as Not Sent']);
  assert.match(shown.children.find(c => c.label.startsWith('Recorded on this computer')).tooltip, /Nothing left this computer.*Close it as not sent, then reconcile the draft/);
  assert.deepEqual(act(shown, 'Close as Not Sent'), {command: 'readymade.closeUnsentSharedSuggestion', title: 'Close as Not Sent', arguments: [claim.request]});
  assert.equal(shown.children.find(c => c.label === 'Close as Not Sent').problem.status, 'blocked');
  // Check Result has nothing to read and says what to do instead; it reads nothing and leaves the record as it is.
  await assert.rejects(view.checkSuggestion(claim.request), /recorded on this computer and never sent, so there is no result to read\. Use Close as Not Sent/);
  assert.equal(suggestions.get(claim.request).phase, 'claimed');
  // The draft is not continued while its suggestion is unresolved, and the refusal names the next step.
  view.link = {owner: '~zod', project: 'shared', generation: '1', peer: '~nec'}; view.client = x.client;
  await assert.rejects(view.reconcile(d.id), /not resolved \(Recorded on this computer — never sent\)\. Use Close as Not Sent first/);
  await view.closeUnsent(claim.request);
  assert.deepEqual(x.counts, {posts: 0, gets: 0, recovers: 0, recoveryGets: 0});
  assert.deepEqual(labels(row(view, d.id)).filter(l => !['Open Draft', 'Compare', 'Reconcile'].includes(l)), ['Not sent — nothing reached the owner', 'Move to History']);
  assert.match(ui.said.at(-1), /Closed as not sent; nothing was sent/);
  assert.equal(x.drafts.get(d.id).text, d.text);
  await assert.rejects(view.closeUnsent(claim.request), /Only a suggestion that was never sent can be closed as not sent/);
  await assert.rejects(view.closeUnsent('0xdead'), /not among the open ones/);
  // The same holds for a draft that went in a multi-file suggestion recorded and never sent: closed first, continued after.
  const {suggestions: singles, bundles, view: both} = x.reopen(), e = x.draft(), f = x.drafts.save(x.drafts.create(observed('0xa7'), '/lib/b/hoon').id, 'edit b\n');
  const pair = bundles.claim([e.id, f.id], [{path: '/lib/a/hoon', source: e.text}, {path: '/lib/b/hoon', source: f.text}], observed('0xa8'));
  both.link = {owner: '~zod', project: 'shared', generation: '1', peer: '~nec'}; both.client = x.client;
  await assert.rejects(both.reconcile(e.id), /went in a multi-file suggestion that is not resolved \(Recorded on this computer — never sent\)\. Use Close as Not Sent on it first/);
  await assert.rejects(both.checkBundle(pair.request), /never sent, so there is no result to read/);
  await both.closeUnsent(pair.request);
  assert.equal(bundles.get(pair.request).reason, 'closed-unsent'); assert.equal(singles.list().length, 1);
  assert.deepEqual(x.counts, {posts: 0, gets: 0, recovers: 0, recoveryGets: 0});
  // A new draft that continues this one says so, with what became of the earlier suggestion.
  const next = x.drafts.create(observed('0xa9'), '/lib/a/hoon'); x.drafts.continues(next.id, d.id);
  const continued = row(x.reopen().view, next.id).children.find(c => c.label === 'Continues an earlier draft');
  assert.equal(continued.description, 'Not sent — nothing reached the owner');
  assert.equal(new RemoteDraftStore(x.drafts.directory).continued(next.id), d.id);
});

test('a result that cannot be read is said as that, sends nothing, and is settled by reading later, also from another process', async t => {
  const x = setup(t), d = x.draft(), first = x.reopen();
  const claim = first.suggestions.claim(d, d.text, observed('0xb1')); await first.suggestions.submit(x.client, claim.request);
  // The ship does not answer the read.
  x.ship.result = () => new ShipClientError('transport');
  await assert.rejects(first.view.checkSuggestion(claim.request), /^Error: Your ship did not answer\. The result could not be read just now\. Nothing was sent and your draft is unchanged; the outcome is still not known\. Check again\.$/);
  let shown = row(first.view, d.id);
  assert.equal(labels(shown).includes('The result could not be read just now'), true);
  assert.equal(labels(shown).some(l => /failed|refused|Not sent/.test(l)), false);
  assert.equal(act(shown, 'Check Result').command, 'readymade.checkSharedSuggestion');
  // Another identity on this connection is refused before anything is read.
  const gets = x.counts.gets; x.state.client = {...x.client, browserCookies: () => [{name: 'urbauth-~bud', value: 'fixture'}]};
  await assert.rejects(first.view.checkSuggestion(claim.request), /belongs to another ship connection/); assert.equal(x.counts.gets, gets);
  x.state.client = x.client;
  // A new process reads the same request; the owner had recorded it. One send in all.
  x.ship.result = () => 'recorded';
  const later = x.reopen(); await later.view.checkSuggestion(claim.request);
  shown = row(later.view, d.id);
  assert.deepEqual(labels(shown).filter(l => !['Open Draft', 'Compare', 'Reconcile'].includes(l)), ['Recorded on owner — awaiting review', 'Move to History']);
  assert.equal(x.counts.posts, 1);
});

test('a receipt recovery that is interrupted stays a recovery to read; it never becomes a second send or a verdict', async t => {
  const x = setup(t), d = x.draft(), {view, suggestions} = x.reopen();
  const claim = suggestions.claim(d, d.text, observed('0xc1')); await suggestions.submit(x.client, claim.request);
  x.ship.result = () => 'missing'; await view.checkSuggestion(claim.request);
  let shown = row(view, d.id);
  assert.equal(labels(shown).includes('Your ship no longer holds this send — outcome not known'), true);
  assert.equal(act(shown, 'Recover Owner Receipt').command, 'readymade.checkSharedSuggestion');
  // The recovery request itself gets no usable answer.
  x.ship.recover = () => new OutcomeUnknownError();
  await assert.rejects(view.checkSuggestion(claim.request), /could not be read just now/);
  shown = row(view, d.id);
  assert.equal(labels(shown).includes('Asked the owner for its receipt — the answer was lost'), true);
  assert.equal(shown.children.find(c => c.label.startsWith('Asked the owner')).description, 'Original send record retained · Not committed');
  assert.equal(act(shown, 'Check Result').command, 'readymade.checkSharedSuggestion');
  // Reading again, in a new process, finds the owner's receipt. The suggestion was posted once; recovery was asked once.
  const later = x.reopen(); await later.view.checkSuggestion(claim.request);
  assert.equal(labels(row(later.view, d.id)).includes('Owner receipt recovered — awaiting review'), true);
  assert.deepEqual(x.counts, {posts: 1, gets: 1, recovers: 1, recoveryGets: 1});
  assert.equal(later.suggestions.get(claim.request).phase, 'missing');
});
