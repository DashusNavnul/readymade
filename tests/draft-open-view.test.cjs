const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {DraftStore} = require('../dist/src/draft-store'), {snapshotFrom} = require('../dist/src/source-store');
const ui = {window: {}, workspace: {}, Uri: {parse: value => ({toString: () => value})}};
const original = Module._load; let openSavedDraft;
try {
  Module._load = function (name, ...args) {return name === 'vscode' ? ui : original.call(this, name, ...args);};
  ({openSavedDraft} = require('../dist/src/draft-open-view'));
} finally {Module._load = original;}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-open-draft-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const drafts = new DraftStore(path.join(root, 'drafts'));
  const create = (ship, session) => drafts.create(snapshotFrom({origin: `https://${ship.slice(1)}.example`, ship, session,
    path: '/lib/test/hoon', mark: 'hoon', blob: '0x1', text: 'original\n',
    source: {id: '0x1', owner: ship, desk: 'demo', number: 1, root: '0v1', commit: '0v1'}}));
  const actions = [], document = {isDirty: true, getText: () => 'UNSAVED λ\n'};
  ui.workspace.openTextDocument = async uri => {actions.push(['open', uri.toString()]); return document;};
  ui.window.showTextDocument = async (doc, options) => {assert.equal(doc, document); actions.push(['show', options]);};
  ui.window.showInformationMessage = async message => {actions.push(['info', message]);};
  ui.window.showQuickPick = async () => {throw new Error('Unexpected picker');};
  return {root, drafts, create, actions, document};
}
test('explicit offline selection distinguishes origins and sessions, preserving journal and dirty buffer', async t => {
  const x = setup(t), a = x.create('~zod', '0x1'), b = x.create('~nec', '0x2');
  const before = x.drafts.list();
  ui.window.showQuickPick = async (items, options) => {
    assert.equal(options.matchOnDetail, true); assert.equal(items.length, 2);
    const choice = items.find(i => i.id === b.id);
    assert.match(choice.description, /~nec.*retained revision 1/);
    assert.match(choice.detail, /https:\/\/nec.example.*source owner ~nec.*session 0x2/);
    assert.ok(items.some(i => i.id === a.id)); return choice;
  };
  await openSavedDraft(x.drafts, () => true);
  assert.deepEqual(x.actions, [['open', b.uri], ['show', {preview: false}]]);
  assert.equal(x.document.getText(), 'UNSAVED λ\n'); assert.equal(x.document.isDirty, true);
  assert.deepEqual(x.drafts.list(), before);
  const restored = new DraftStore(x.drafts.directory);
  assert.equal(restored.list().length, before.length);
  for (const row of before) assert.deepEqual(restored.get(row.id), row);
});
test('empty list and canceled choice never open a document', async t => {
  const x = setup(t); await openSavedDraft(x.drafts, () => true); assert.equal(x.actions[0][0], 'info');
  x.actions.length = 0; x.create('~zod', '0x1'); ui.window.showQuickPick = async () => undefined;
  await openSavedDraft(x.drafts, () => true); assert.deepEqual(x.actions, []);
});
test('deactivation during picker or document opening prevents late editor reveal', async t => {
  for (const stage of ['picker', 'open']) {
    const x = setup(t), row = x.create('~zod', '0x1'); let active = true;
    ui.window.showQuickPick = async () => {if (stage === 'picker') active = false; return {id: row.id};};
    ui.workspace.openTextDocument = async () => {active = false; return x.document;};
    await openSavedDraft(x.drafts, () => active); assert.deepEqual(x.actions, []);
  }
});
test('unknown IDs fail closed; opening a retained unknown submission never resends it', async t => {
  const x = setup(t), row = x.create('~zod', '0x1');
  await assert.rejects(openSavedDraft(x.drafts, () => true, 'not-a-draft'));
  x.drafts.save(row.id, 'changed\n');
  let sends = 0;
  const client = {origin: row.snapshot.origin, snapshot: {ready: true, owner: '~zod', session: '0x1', nonce: '0v1',
    sessions: [{id: '0x1', source: row.snapshot.source}]}, codingTool: async () => {sends++; throw new Error('delivery unknown');}};
  await assert.rejects(x.drafts.prepare(row.id, client), /delivery unknown/);
  const before = x.drafts.get(row.id); assert.equal(before.pending.phase, 'unknown');
  await openSavedDraft(x.drafts, () => true, row.id);
  assert.equal(sends, 1); assert.deepEqual(x.drafts.get(row.id), before);
  assert.deepEqual(x.actions, [['open', row.uri], ['show', {preview: false}]]);
});
