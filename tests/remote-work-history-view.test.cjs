// The real shared-project view over the real stores, with the editor replaced by a recorder. No ship, no socket.
const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const original = Module._load;
const ui = {said: [], asked: [], opened: [], answer: undefined, documents: [],
  Uri: {parse: value => ({toString: () => value})},
  window: {
    showInformationMessage: message => {ui.said.push(message);},
    showWarningMessage: async (message, options, action) => {ui.asked.push({message, detail: options.detail, action}); return ui.answer;},
    showTextDocument: async document => {ui.opened.push(document.uri.toString());},
  },
  workspace: {
    registerTextDocumentContentProvider: () => ({dispose() {}}),
    openTextDocument: async uri => ({uri}),
    get textDocuments() {return ui.documents;},
  }};
let RemoteSourceView, RemoteDraftStore, RemoteSuggestionJournal, RemoteBundleJournal, remoteBundleReply, remoteSourceHash;
try {
  Module._load = function(name, ...args) {return name === 'vscode' ? ui : original.call(this, name, ...args);};
  ({RemoteSourceView} = require('../dist/src/remote-source-view'));
  ({RemoteDraftStore} = require('../dist/src/remote-draft-store'));
  ({RemoteSuggestionJournal} = require('../dist/src/remote-suggestion-journal'));
  ({RemoteBundleJournal, remoteBundleReply} = require('../dist/src/remote-bundle-suggest'));
  ({remoteSourceHash} = require('../dist/src/remote-project-view'));
} finally {Module._load = original;}

const hex = n => '0x' + n.toString(16).replace(/\B(?=(?:[0-9a-f]{4})+$)/g, '.');
const text = 'original\n';
const observed = n => ({origin: 'https://peer.example', owner: '~zod', peer: '~nec', project: 'shared', generation: '1', request: hex(n),
  grant: '0x2', observedAt: '~2026.11.09', root: '0x3', snapshotDigest: '0x4', desk: 'shared', revision: '1',
  files: [{path: '/lib/a/hoon', text, hash: remoteSourceHash(text)}, {path: '/lib/b/hoon', text, hash: remoteSourceHash(text)}]});
function reply(i, status) {
  const o = i.observation;
  return {owner: o.owner, peer: o.peer, project: o.project, generation: o.generation, request: i.request, permissionGranted: false, committed: false,
    status, viewRequest: o.request, grant: o.grant, root: o.root, snapshotDigest: o.snapshotDigest, path: i.path, sourceHash: remoteSourceHash(i.source),
    reason: status === 'recorded' ? 'suggestion-recorded' : 'awaiting-owner', deadline: '~2026.11.09..00.00.30', retainedUntil: '~2026.11.09..00.05.30', receiptHash: status === 'recorded' ? '0xa' : null};
}
function bundleWire(i, status, reason) {
  const o = i.observation;
  return {schema: 'readymade-project-bundle-result-v1', owner: o.owner, peer: o.peer, project: o.project, generation: o.generation, request: i.request,
    viewRequest: o.request, grant: o.grant, root: o.root, snapshotDigest: o.snapshotDigest, status, reason,
    files: i.files.map(f => ({path: f.path, sourceHash: remoteSourceHash(f.source)})),
    deadline: '~2026.11.16..10.08.50', retainedUntil: '~2026.11.16..10.13.50', permissionGranted: false, committed: false, receiptHash: null};
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-work-view-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  ui.said.length = 0; ui.asked.length = 0; ui.opened.length = 0; ui.answer = undefined; ui.documents = [];
  const drafts = new RemoteDraftStore(path.join(root, 'drafts')), suggestions = new RemoteSuggestionJournal(path.join(root, 'suggestions')), bundles = new RemoteBundleJournal(path.join(root, 'bundles'));
  const client = {origin: 'https://peer.example', browserCookies: () => [{name: 'urbauth-~nec', value: 'fixture'}],
    projectSuggestionSubmit: async i => reply(i, 'watching'), projectSuggestionResult: async i => reply(i, 'recorded'),
    projectBundleSubmit: async i => remoteBundleReply(202, bundleWire(i, 'uncertain', 'suggest-timeout'), i, true)};
  const view = new RemoteSourceView('readymade.test', () => client, async () => client, () => undefined, drafts, suggestions, bundles);
  t.after(() => view.dispose());
  let made = 0;
  const draft = (file = '/lib/a/hoon') => {const first = drafts.create(observed(++made), file); return drafts.save(first.id, `edit ${made}\n`);};
  const suggest = async (d, finish = true) => {
    const claim = suggestions.claim(d, d.text, {...d.observation, request: hex(700000 + made++)});
    if (finish) {await suggestions.submit(client, claim.request); await suggestions.observe(client, claim.request);}
    return claim.request;
  };
  return {view, drafts, suggestions, bundles, client, draft, suggest, observed: () => observed(900000 + made++)};
}
const children = view => view.rows()[0].children;
const row = (view, id) => children(view).find(r => r.children?.some(c => c.command?.arguments?.[0] === id && c.command.command === 'readymade.openSharedDraft'));
const labels = r => r.children.map(c => c.label);

test('a 65th draft opens: the oldest finished work moves to history and the person is told; with nothing finished, nothing is discarded and the reason is said', async t => {
  const x = setup(t), first = x.draft(), second = x.draft();
  await x.suggest(first); await x.suggest(second);
  while (x.drafts.open < 64) x.draft();
  // The view is showing one read of the owner's files; the person edits a file of it.
  x.view.observation = x.observed();
  await x.view.editDraft('/lib/a/hoon');
  assert.equal(x.drafts.open, 64); assert.equal(x.drafts.archived(first.id).text, first.text); assert.equal(x.suggestions.list().length, 1);
  assert.deepEqual(ui.said, ['Moved 1 finished suggestion and 1 finished draft to history to make room. Nothing was deleted; see Shared Work History.']);
  assert.equal(ui.opened.length, 1);
  x.view.observation = x.observed(); await x.view.editDraft('/lib/a/hoon');
  assert.equal(x.drafts.archived(second.id).text, second.text); assert.equal(x.suggestions.list().length, 0);
  // 64 drafts are open and none was ever sent: the next one is refused with the way out, and every draft is still there.
  x.view.observation = x.observed();
  await assert.rejects(x.view.editDraft('/lib/a/hoon'), /64 drafts are open and none of them is finished\. Finish a suggestion, or move a draft you are not working on to history: its text is kept and it can be restored/);
  assert.equal(x.drafts.open, 64); assert.equal(x.drafts.archivedPage(0, 64).total, 2); assert.equal(ui.said.length, 2);
  // A draft open in an editor is not moved from under the person, even when it is finished.
  const kept = x.drafts.list()[0]; await x.suggest(kept);
  ui.documents = [{isClosed: false, uri: {scheme: 'readymade-remote-draft', path: `/${kept.id}${kept.path}`, toString: () => kept.uri}, getText: () => kept.text}];
  await assert.rejects(x.view.editDraft('/lib/a/hoon'), /64 drafts are open and none of them is finished/);
  assert.equal(x.drafts.get(kept.id).text, kept.text);
});

test('an unsent draft moves only when the person confirms; an unsettled send does not move; finished work moves and is shown in history', async t => {
  const x = setup(t), unsent = x.draft(), waiting = x.draft(), done = x.draft();
  await x.suggest(waiting, false); const request = await x.suggest(done);
  // What the tree offers for each: ask first for the unsent draft, nothing for the unsettled send, a plain move for finished work.
  assert.equal(labels(row(x.view, unsent.id)).includes('Move to History…'), true);
  assert.equal(labels(row(x.view, waiting.id)).some(label => label.startsWith('Move to History')), false);
  assert.equal(labels(row(x.view, done.id)).includes('Move to History'), true);
  assert.deepEqual(children(x.view).find(r => r.label === 'Move Finished Work to History').description, '1 finished');
  assert.equal(children(x.view).find(r => r.label === 'Shared Work History').command.command, 'readymade.sharedWorkHistory');
  // Dismissed: nothing moves.
  await x.view.moveDraftToHistory(unsent.id);
  assert.equal(ui.asked.length, 1); assert.match(ui.asked[0].detail, /was never sent\. It moves out of your open drafts with its text exactly as it is, and can be restored/);
  assert.equal(x.drafts.get(unsent.id).text, unsent.text);
  await assert.rejects(x.view.moveDraftToHistory(waiting.id), /result is not settled\. Check its result first/);
  assert.equal(x.drafts.open, 3); assert.equal(x.suggestions.list().length, 2);
  // Confirmed: the unsent draft moves with its text. Finished work moves without a question.
  ui.answer = 'Move to History'; await x.view.moveDraftToHistory(unsent.id);
  assert.equal(x.drafts.archived(unsent.id).text, unsent.text); assert.equal(ui.asked.length, 2);
  await x.view.moveFinishedToHistory();
  assert.equal(ui.asked.length, 2); assert.equal(ui.said.at(-1), 'Moved 1 finished suggestion and 1 finished draft to history. Nothing was deleted; see Shared Work History.');
  assert.deepEqual(x.drafts.list().map(d => d.id), [waiting.id]); assert.deepEqual(x.suggestions.list().map(s => s.phase), ['claimed']);
  await x.view.moveFinishedToHistory();
  assert.match(ui.said.at(-1), /Nothing is finished yet/);
  // History is read when asked for, a page at a time, and offers the drafts back.
  await x.view.showHistory();
  const history = children(x.view).find(r => r.label === 'Shared Work History');
  assert.equal(history.description, '2 drafts · 1 suggestions');
  assert.deepEqual(history.children.map(r => r.description.split(' · ')[0]), ['Draft', 'Draft', 'Suggestion']);
  const sent = history.children.find(r => r.description.startsWith('Suggestion'));
  assert.match(sent.description, /^Suggestion · Recorded on owner — awaiting review · ~zod \/ shared · \d{4}-\d\d-\d\d$/); assert.match(sent.tooltip, new RegExp('Request ' + request.replaceAll('.', '\\.')));
  assert.deepEqual(sent.children.at(-1).command, {command: 'readymade.restoreSharedDraft', title: 'Restore Draft', arguments: [done.id]});
  // The sent draft comes back exactly, is opened, and is still marked as sent: no Send is offered for it, and it is finished work again.
  await x.view.restoreDraft(done.id);
  assert.equal(x.drafts.get(done.id).text, done.text); assert.equal(ui.opened.at(-1), done.uri);
  assert.equal(labels(row(x.view, done.id)).includes('Sent — its suggestion is in history'), true);
  assert.equal(row(x.view, done.id).children.some(c => c.command?.command === 'readymade.sendSharedSuggestion'), false);
  assert.equal(x.suggestions.holds(done.id), true);
  // The unsent draft comes back as an unsent draft: its Send is offered again, because it was never sent.
  await x.view.restoreDraft(unsent.id);
  assert.equal(row(x.view, unsent.id).children.some(c => c.command?.command === 'readymade.sendSharedSuggestion'), true);
  await assert.rejects(x.view.restoreDraft(unsent.id), /not in history/);
});

test('a multi-file suggestion that ended without a result moves only when the person confirms, and stays what it was', async t => {
  const x = setup(t), a = x.draft('/lib/a/hoon'), b = x.draft('/lib/b/hoon');
  const claim = x.bundles.claim([a.id, b.id], [{path: '/lib/a/hoon', source: a.text}, {path: '/lib/b/hoon', source: b.text}], {...a.observation, request: hex(800001)});
  await x.bundles.submit(x.client, claim.request);
  assert.equal(x.bundles.get(claim.request).phase, 'uncertain');
  const shown = children(x.view).find(r => r.label === 'Suggestion · 2 files');
  assert.equal(shown.children.at(-1).label, 'Move to History…');
  assert.equal(children(x.view).some(r => r.label === 'Move Finished Work to History'), false);
  await assert.rejects(x.view.moveDraftToHistory(a.id), /ended without a result\. Move that suggestion to history/);
  await x.view.moveFinishedToHistory(); assert.equal(x.bundles.list().length, 1);
  await x.view.moveBundleToHistory(claim.request);
  assert.equal(x.bundles.list().length, 1); assert.match(ui.asked.at(-1).detail, /History keeps it exactly so, and its 2 drafts stay marked as sent: they are never sent again/);
  ui.answer = 'Move to History'; await x.view.moveBundleToHistory(claim.request);
  assert.equal(x.bundles.list().length, 0); assert.equal(x.bundles.find(claim.request).phase, 'uncertain'); assert.equal(x.drafts.open, 0);
  assert.equal(x.bundles.holdsDraft(a.id), true); assert.equal(x.bundles.holdsDraft(b.id), true);
  await x.view.showHistory();
  const kept = children(x.view).find(r => r.label === 'Shared Work History').children.find(r => r.label === 'Suggestion · 2 files');
  assert.match(kept.description, /^Ended without a result — outcome not known \(the owner’s ship did not answer in time\) · ~zod \/ shared/);
  assert.deepEqual(kept.children.filter(c => c.command).map(c => c.label).sort(), ['Restore Draft /lib/a/hoon', 'Restore Draft /lib/b/hoon']);
});
