const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {DraftStore} = require('../dist/src/draft-store');
const {snapshotFrom} = require('../dist/src/source-store');
const uri = value => ({scheme: value.split(':')[0], toString: () => value});
const ui = {window: {}, workspace: {}, commands: {}, Uri: {parse: uri}, ProgressLocation: {Notification: 1}};
const original = Module._load; let reconcileDraftView;
try {
  Module._load = function (name, ...args) {return name === 'vscode' ? ui : original.call(this, name, ...args);};
  ({reconcileDraftView} = require('../dist/src/draft-reconcile-view'));
} finally {Module._load = original;}
function setup(t, latest = 'one\nmid\nLAST\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-reconcile-view-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = (n, text) => snapshotFrom({origin: 'https://zod.example', ship: '~zod', session: '0x1',
    path: '/lib/test/hoon', mark: 'hoon', blob: `0x${n}`, text,
    source: {id: `0x${n}`, owner: '~zod', desk: 'demo', number: n, root: `0v${n}`, commit: `0v${n}`}});
  const drafts = new DraftStore(path.join(root, 'drafts')), old = drafts.create(source(1, 'one\nmid\nlast\n'));
  const current = source(2, latest), document = {uri: uri(old.uri), version: 1, isClosed: false, getText: () => 'UNSAVED\nmid\nlast\n'};
  const observed = {owner: '~zod', session: '0x1', ready: true, nonce: '0v1', cursor: '0x1', after: 0,
    projects: [], records: [], reviews: [], sessions: [{id: '0x1', project: 'demo', source: current.source}]};
  const actions = [], notices = []; let reads = 0, renders = 0;
  ui.window.activeTextEditor = {document};
  ui.window.showTextDocument = async doc => actions.push(['open', doc.uri.toString()]);
  ui.window.showInformationMessage = text => {notices.push(text); return Promise.resolve();};
  ui.window.showWarningMessage = text => {notices.push(text); return Promise.resolve();};
  ui.window.withProgress = async (_, action) => action({report() {}}, {isCancellationRequested: false});
  ui.workspace.openTextDocument = async uri => ({uri});
  ui.commands.executeCommand = async (...args) => {actions.push(args);};
  const deps = {drafts, project: 'demo', active: () => true, changed: () => renders++,
    client: {origin: current.origin, codingState: async () => {reads++; return observed;}},
    sources: {sources: () => [current], openSnapshot: value => {assert.equal(value.uri, current.uri); return current;}},
    loader: {load: async () => {throw new Error('Unexpected read');}}};
  return {deps, old, current, document, observed, actions, notices, reads: () => reads, renders: () => renders};
}
test('editor reconciliation uses unsaved buffer, reobserves source, and opens a separate persisted draft', async t => {
  const x = setup(t); await reconcileDraftView(x.deps);
  assert.equal(x.reads(), 2); assert.equal(x.renders(), 1);
  assert.deepEqual(x.deps.drafts.get(x.old.id), x.old);
  const target = x.deps.drafts.list().find(row => row.id !== x.old.id);
  assert.equal(target.text, 'UNSAVED\nmid\nLAST\n');
  assert.deepEqual(x.actions, [['open', target.uri]]);
});
test('overlap opens current-source versus editable draft without creating or submitting anything', async t => {
  const x = setup(t, 'THEIRS\nmid\nlast\n'); await reconcileDraftView(x.deps);
  assert.equal(x.deps.drafts.list().length, 1); assert.equal(x.renders(), 0);
  assert.equal(x.actions[0][0], 'vscode.diff'); assert.equal(x.actions[0][1].toString(), x.current.uri);
  assert.equal(x.actions[0][2].toString(), x.old.uri); assert.match(x.notices[0], /Both versions are preserved/);
});
test('buffer edits, close, and workspace changes during observations stop before creation', async t => {
  for (const change of ['edit', 'close', 'workspace']) {
    const x = setup(t);
    x.deps.client.codingState = async () => {
      if (change === 'edit') x.document.version++;
      if (change === 'close') x.document.isClosed = true;
      if (change === 'workspace') x.deps.active = () => false;
      return x.observed;
    };
    await assert.rejects(reconcileDraftView(x.deps), /Draft or workspace changed/);
    assert.equal(x.deps.drafts.list().length, 1); assert.deepEqual(x.actions, []);
  }
});
test('a source changing during final observation is refused', async t => {
  const x = setup(t); let calls = 0;
  x.deps.client.codingState = async () => {
    if (++calls === 2) x.observed.sessions[0].source = {...x.current.source, id: '0x3', number: 3};
    return x.observed;
  };
  await assert.rejects(reconcileDraftView(x.deps), /current project source/);
  assert.equal(x.deps.drafts.list().length, 1); assert.deepEqual(x.actions, []);
});
test('missing source uses bounded loader and cancellation leaves original alone', async t => {
  for (const cancel of [false, true]) {
    const x = setup(t); x.deps.sources.sources = () => [];
    x.deps.loader.load = async (session, basis, file, project, options) => {
      assert.equal(session, '0x1'); assert.deepEqual(basis, x.current.source); assert.equal(file, '/lib/test/hoon');
      assert.equal(project, 'demo'); assert.equal(options.active(), true); return cancel ? undefined : x.current;
    };
    await reconcileDraftView(x.deps);
    assert.equal(x.deps.drafts.list().length, cancel ? 1 : 2);
  }
});
test('foreign project is rejected before loading source', async t => {
  const x = setup(t); x.observed.sessions[0].project = 'foreign';
  await assert.rejects(reconcileDraftView(x.deps), /outside the current project/);
  assert.equal(x.reads(), 1); assert.equal(x.deps.drafts.list().length, 1);
});
test('explicit conflict resolution creates a current-source buffer beside original unsaved edits', async t => {
  const x = setup(t, 'THEIRS\nmid\nlast\n');
  ui.window.showWarningMessage = async () => 'Create Resolution Draft';
  await reconcileDraftView(x.deps);
  const target = x.deps.drafts.list().find(row => row.id !== x.old.id);
  assert.equal(target.text, x.current.text); assert.equal(target.snapshot.uri, x.current.uri);
  assert.deepEqual(x.deps.drafts.get(x.old.id), x.old); assert.equal(x.reads(), 3);
  assert.equal(x.actions[1][1].toString(), x.old.uri); assert.equal(x.actions[1][2].toString(), target.uri);
  x.deps.drafts.save(target.id, 'custom resolution\nmid\nlast\n');
  assert.equal(x.deps.drafts.get(target.id).text, 'custom resolution\nmid\nlast\n');
});
test('source drift while choosing resolution refuses creation', async t => {
  const x = setup(t, 'THEIRS\nmid\nlast\n');
  ui.window.showWarningMessage = async () => {
    x.observed.sessions[0].source = {...x.current.source, id: '0x3', number: 3};
    return 'Create Resolution Draft';
  };
  await assert.rejects(reconcileDraftView(x.deps), /current project source/);
  assert.equal(x.deps.drafts.list().length, 1);
});
test('context change while opening a merged document does not reveal it in another project', async t => {
  const x = setup(t);
  ui.workspace.openTextDocument = async uri => {x.deps.active = () => false; return {uri};};
  await reconcileDraftView(x.deps);
  assert.equal(x.deps.drafts.list().length, 2); assert.deepEqual(x.actions, []); assert.deepEqual(x.notices, []);
});
