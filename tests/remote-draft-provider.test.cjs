const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {RemoteDraftStore} = require('../dist/src/remote-draft-store');
const {remoteSourceHash} = require('../dist/src/remote-project-view');
const changes = [];
const ui = {EventEmitter: class {event = () => {}; fire(value) {changes.push(value);} dispose() {}}, Disposable: class {},
  FileType: {File: 1, Directory: 2}, FilePermission: {Readonly: 1}, FileChangeType: {Changed: 1},
  FileSystemError: {FileNotFound: () => Error('missing'), NoPermissions: message => Error(message), Unavailable: message => Error(message)}};
ui.env = {uriScheme: 'readymade'};
ui.Uri = {parse: uri, from: value => uri(value.scheme + '://' + (value.authority ?? '') + value.path + (value.query ? '?' + value.query : ''))};
ui.workspace = {registerTextDocumentContentProvider: () => ({dispose() {}}), openTextDocument: async value => value};
ui.window = {showTextDocument: async () => {}}; ui.commands = {executeCommand: async () => {}};
const original = Module._load; let RemoteDraftProvider, RemoteSourceView, sharedProjectLink, ProjectSharingView;
try {
  Module._load = function(name, ...args) {return name === 'vscode' ? ui : original.call(this, name, ...args);};
  ({RemoteDraftProvider} = require('../dist/src/remote-draft-provider'));
  ({RemoteSourceView, sharedProjectLink} = require('../dist/src/remote-source-view'));
  ({ProjectSharingView} = require('../dist/src/project-sharing-view'));
} finally {Module._load = original;}
function uri(value) {const u = new URL(value); return {scheme: u.protocol.slice(0, -1), authority: u.host, path: u.pathname, query: u.search.slice(1), fragment: u.hash.slice(1), toString: () => value};}
test('provider saves editable remote drafts, restores them, and protects original diff bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-remote-provider-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const directory = path.join(root, 'drafts'), store = new RemoteDraftStore(directory), provider = new RemoteDraftProvider(store);
  const text = 'original\n', source = {origin: 'https://peer.example', owner: '~zod', peer: '~nec', project: 'shared', generation: '1', request: '0x1',
    grant: '0x2', observedAt: '~2026.11.09', root: '0x3', snapshotDigest: '0x4', desk: 'shared', revision: '1',
    files: [{path: '/lib/example/hoon', text, hash: remoteSourceHash(text)}]};
  const row = store.create(source, source.files[0].path), draft = uri(row.uri), baseline = uri(row.originalUri);
  assert.equal(provider.stat(baseline).permissions, ui.FilePermission.Readonly);
  assert.equal(provider.stat(draft).permissions, undefined);
  provider.writeFile(draft, Buffer.from('edited\n'));
  assert.equal(Buffer.from(provider.readFile(draft)).toString(), 'edited\n');
  assert.equal(Buffer.from(provider.readFile(baseline)).toString(), text);
  assert.equal(new RemoteDraftStore(directory).get(row.id).text, 'edited\n');
  assert.equal(changes.length, 1); assert.equal(changes[0][0].uri, draft);
  for (const action of [() => provider.writeFile(baseline, Buffer.from('bad')), () => provider.delete(draft),
    () => provider.rename(draft, baseline), () => provider.writeFile(draft, Buffer.from([255])),
    () => provider.readFile(uri(row.uri + '?other=1'))]) assert.throws(action);
  assert.equal(store.get(row.id).text, 'edited\n'); provider.dispose();
});

function savedProject(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-resume-project-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const store = new RemoteDraftStore(directory), text = 'original';
  const observation = {origin: 'https://peer.example', owner: '~zod', peer: '~nec', project: 'shared', generation: '1', request: '0x1',
    grant: '0x2', observedAt: '~2026.11.09', root: '0x3', snapshotDigest: '0x4', desk: 'shared', revision: '1',
    files: [{path: '/lib/example/hoon', text, hash: remoteSourceHash(text)}]};
  const row = store.create(observation, observation.files[0].path); store.save(row.id, 'unsent edits');
  return {directory, row: store.get(row.id), observation};
}
test('resume reconstructs project context from durable draft and freshly reads without changing it', async t => {
  const {directory, row, observation} = savedProject(t), store = new RemoteDraftStore(directory);
  let posts = 0, status = 'ready';
  const client = {origin: observation.origin, browserCookies: () => [{name: 'urbauth-~nec'}],
    projectViewSubmit: async target => {assert.deepEqual(target, {owner: '~zod', project: 'shared', generation: '1'}); posts++; return {status: 'pending', ...target, request: '0x2'};},
    projectViewResult: async () => ({status, request: '0x2', observation: status === 'ready' ? {...observation, request: '0x2', revision: '2',
      files: [{path: row.path, text: 'new canonical', hash: remoteSourceHash('new canonical')}]} : null})};
  let current;
  let view = new RemoteSourceView('test.extension', () => current, async origin => {assert.equal(origin, observation.origin); current = client; return client;}, () => {}, store);
  assert.equal(posts, 0); assert.equal(view.rows()[0].children.filter(r => r.command?.command === 'readymade.resumeSharedProject').length, 1);
  await view.resume(row.id); assert.equal(posts, 1); assert.deepEqual(store.get(row.id), row);
  assert.equal(view.observation.revision, '2');
  await view.resume(row.id); assert.equal(posts, 2, 'Explicit resume must refresh a settled cached observation');
  status = 'uncertain'; await view.resume(row.id); assert.equal(posts, 3);
  await view.resume(row.id); assert.equal(posts, 3, 'An unsettled retained read is never restarted');
  assert.match(JSON.stringify(view.rows()), /Outcome unknown/); view.dispose();
  status = 'refused'; view = new RemoteSourceView('test.extension', () => client, async () => client, () => {}, new RemoteDraftStore(directory));
  await view.resume(row.id); assert.equal(posts, 4); assert.equal(view.observation, undefined);
  assert.match(JSON.stringify(view.rows()), /Owner refused/); assert.deepEqual(store.get(row.id), row); view.dispose();
});
test('resume refuses foreign origin, peer, changed connection and disposed views before requesting source', async t => {
  const {directory, row, observation} = savedProject(t), store = new RemoteDraftStore(directory); let posts = 0;
  const client = {origin: observation.origin, browserCookies: () => [{name: 'urbauth-~nec'}], projectViewSubmit: async () => {posts++; throw Error('unexpected write');}};
  for (const foreign of [{...client, origin: 'https://foreign.example'}, {...client, browserCookies: () => [{name: 'urbauth-~wes'}]}]) {
    const view = new RemoteSourceView('test.extension', () => foreign, async () => foreign, () => {}, store);
    await assert.rejects(view.resume(row.id), /belongs to|for ~nec/); assert.equal(posts, 0); view.dispose();
  }
  let current = client, release;
  const view = new RemoteSourceView('test.extension', () => current, () => new Promise(resolve => {release = resolve;}), () => {}, store);
  const resumed = view.resume(row.id); current = undefined; release(client);
  await assert.rejects(resumed, /connection changed/); assert.equal(posts, 0); view.dispose();
  await assert.rejects(view.resume(row.id), /operation/); assert.equal(posts, 0);
});

const projectLink = file => uri('readymade://test.extension/shared-project?' + new URLSearchParams({owner: '~zod', project: 'shared', generation: '1', peer: '~nec', ...(file === undefined ? {} : {file})}));
test('shared file links validate exact fields and never fall back to another file', async t => {
  const {observation} = savedProject(t); let shown, posts = 0, status = 'ready';
  const second = {path: '/lib/second/hoon', text: 'second', hash: remoteSourceHash('second')};
  const client = {origin: observation.origin, browserCookies: () => [{name: 'urbauth-~nec'}],
    projectViewSubmit: async target => {posts++; return {status: 'pending', ...target, request: '0x2'};},
    projectViewResult: async () => ({status, request: '0x2', observation: {...observation, files: [...observation.files, second]}})};
  const view = new RemoteSourceView('test.extension', () => client, async () => client, () => {});
  const previous = ui.window.showTextDocument; ui.window.showTextDocument = async document => {shown = document;};
  t.after(() => {ui.window.showTextDocument = previous; view.dispose();});
  assert.equal(sharedProjectLink(projectLink(), 'test.extension').file, undefined);
  for (const file of ['', '/lib/../hoon', '/lib/a/hoon?bad', '/lib/a.js']) assert.throws(() => sharedProjectLink(projectLink(file), 'test.extension'));
  assert.throws(() => sharedProjectLink(uri(projectLink(second.path).toString() + '&file=/lib/other/hoon'), 'test.extension'));
  await view.open(projectLink(second.path)); assert.equal(posts, 1); assert.equal(view.provideTextDocumentContent(shown), 'second');
  shown = undefined; await assert.rejects(view.open(projectLink('/lib/missing/hoon')), /not currently shared/); assert.equal(shown, undefined);
  await view.open(projectLink()); assert.equal(view.provideTextDocumentContent(shown), observation.files[0].text);
  shown = undefined; status = 'refused'; await view.open(projectLink(second.path)); assert.equal(shown, undefined);
  const count = posts; client.browserCookies = () => [{name: 'urbauth-~wes'}];
  await assert.rejects(view.open(projectLink(second.path)), /for ~nec/); assert.equal(posts, count);
});
test('copy shared file rechecks recipient grant after choosing and refuses removed paths or revocation', async t => {
  let copied, reads = 0, project = 'shared';
  const base = {schema: 'readymade-project-sharing-view-v1', owner: '~zod', project, peer: '~nec', expected: '0x1', member: true, baseDesk: 'shared', workingDesk: null,
    grant: {generation: '1', desk: 'shared', paths: ['/lib/first/hoon', '/lib/second/hoon'], view: true, suggest: false, revoked: false}};
  let fresh = structuredClone(base);
  const client = {origin: 'https://owner.example', snapshot: {owner: '~zod'}, projectSharing: async operation => {assert.equal(operation, 'read'); reads++; return {status: 200, body: fresh};}};
  const view = new ProjectSharingView(() => project, () => {}, {entries: () => []}); view.connect(client); view.held = base;
  const oldPick = ui.window.showQuickPick; ui.window.showQuickPick = async () => '/lib/second/hoon';
  ui.env.clipboard = {writeText: async text => {copied = text;}}; ui.window.showInformationMessage = () => {};
  t.after(() => {view.dispose(); ui.window.showQuickPick = oldPick;});
  await view.copyLink('test.extension', true); assert.equal(reads, 1); assert.equal(sharedProjectLink(uri(copied), 'test.extension').file, '/lib/second/hoon');
  copied = undefined; fresh = {...base, grant: {...base.grant, paths: ['/lib/first/hoon']}};
  await assert.rejects(view.copyLink('test.extension', true), /no longer shared/); assert.equal(copied, undefined);
  fresh = {...base, grant: {...base.grant, revoked: true}};
  await assert.rejects(view.copyLink('test.extension', true), /current read access/); assert.equal(copied, undefined);
  const count = reads; ui.window.showQuickPick = async () => {project = 'other'; return '/lib/second/hoon';};
  await assert.rejects(view.copyLink('test.extension', true), /context changed/); assert.equal(reads, count);
});

for (const mode of ['ready', 'revoked', 'missing-file', 'pending', 'changed-peer', 'moved']) {
  test(`remote activity needs no local coding session and fresh granted source: ${mode}`, async t => {
    const {directory, row, observation} = savedProject(t), store = new RemoteDraftStore(directory);
    let sourceReads = 0, queries = 0, phase = 'ready', moved = false, peer = '~nec', opened = [];
    t.mock.method(ui.workspace, 'openTextDocument', async value => value);
    t.mock.method(ui.window, 'showTextDocument', async value => {opened.push(value.toString());});
    const client = {origin: observation.origin, browserCookies: () => [{name: 'urbauth-' + peer}],
      codingState: async () => {throw Error('No local Viki session may be queried');},
      projectViewSubmit: async target => {sourceReads++; return {...target, request: '0x' + sourceReads, status: 'pending'};},
      projectViewResult: async selector => ({...selector, status: phase, observation: phase === 'ready' ? {...observation, request: selector.request, files: mode === 'missing-file' && sourceReads > 1 ? [] : observation.files} : null}),
      activitySubmit: async command => {assert.deepEqual(command, {owner: '~zod', project: 'shared', operation: 'query'}); queries++; return {...command, request: '0v' + queries, status: 'pending'};},
      activityResult: async selector => ({...selector, status: 'ready', permissionGranted: false, rows: [{ship: '~bud', desk: 'shared', path: moved ? '/lib/elsewhere/hoon' : row.path}]})};
    const view = new RemoteSourceView('test.extension', () => client, async () => client, () => {}, store);t.after(() => view.dispose());
    await view.open(projectLink());await view.refreshActivity();opened = [];
    const group = view.rows()[0].children.find(item => item.label === 'Activity · ~zod / shared');assert.ok(group);
    assert.equal(group.children.find(item => item.label === '~bud').command.command, 'readymade.openSharedActivityFile');
    if (mode === 'revoked') phase = 'refused';
    if (mode === 'pending') {view.settled = false; view.state = 'Waiting for owner — Check for result';}
    if (mode === 'changed-peer') peer = '~wes';
    if (mode === 'moved') moved = true;
    if (mode === 'ready') {await view.openActivityFile('~bud');assert.equal(opened.length, 1);assert.ok(opened[0].endsWith(row.path));assert.equal(sourceReads, 2);assert.equal(queries, 2);}
    else {await assert.rejects(view.openActivityFile('~bud'));assert.equal(opened.length, 0);if (['pending', 'changed-peer', 'moved'].includes(mode)) assert.equal(sourceReads, 1);}
    assert.deepEqual(store.get(row.id), row, 'Navigation never mutates saved edits or their immutable provenance');
    if (mode === 'revoked') {const before = queries;await assert.rejects(view.refreshActivity());assert.equal(queries, before);assert.ok(view.observation, 'Historical source remains retained without admission');}
  });
}
