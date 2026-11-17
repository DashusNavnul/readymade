const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
const {createServer} = require('node:http'), {once} = require('node:events');
const {projectInboxHistory, projectInboxDetail, inboxHistorySelector} = require('../dist/src/project-inbox');
const {remoteSourceHash} = require('../dist/src/remote-project-view');
const {ShipClient, ShipClientError} = require('../dist/src/ship-client');

const owner = '~zod', project = 'shared';
const detail = {receiptHash: '0x1', peer: '~nec', receivedAt: '~2026.11.09', generation: '1', request: '0x2', path: '/lib/example/hoon',
  sourceHash: remoteSourceHash('after'), parentRoot: '0x20', snapshotDigest: '0x3', desk: 'work', revision: '4', originalHash: remoteSourceHash('before'), source: 'after'};
const row = Object.fromEntries(Object.entries(detail).filter(([key]) => key !== 'source'));
const page = (receipts = [row], patch = {}) => ({schema: 'readymade-project-inbox-history-v1', owner, project, permissionGranted: false, committed: false,
  desk: 'suggestion-history', revision: '2', commit: '0v123', examined: receipts.length, next: null, more: false, receipts, ...patch});
const bundleFiles = [{path: '/lib/a/hoon', originalHash: remoteSourceHash('a0'), sourceHash: remoteSourceHash('a1'), source: 'a1'},
  {path: '/lib/b/hoon', originalHash: remoteSourceHash('b0'), sourceHash: remoteSourceHash('b1'), source: 'b1'}];
const bundleDetail = {kind: 'bundle', receiptHash: '0x9', peer: '~nec', receivedAt: '~2026.11.16', generation: '4', request: '0x7',
  parentRoot: '0x20', snapshotDigest: '0x3', desk: 'work', revision: '4', files: bundleFiles};
const bundleSummary = {...bundleDetail, files: bundleFiles.map(f => ({path: f.path, originalHash: f.originalHash, sourceHash: f.sourceHash}))};
const page2 = (receipts = [row, bundleSummary], patch = {}) => page(receipts, {schema: 'readymade-project-inbox-history-v2', ...patch});
const detail2 = receipt => ({schema: 'readymade-project-inbox-detail-v2', owner, project, permissionGranted: false, committed: false, receipt});

test('history validates exact bounded pages and preserves empty continuation', () => {
  const first = inboxHistorySelector(), parsed = projectInboxHistory(page(), owner, project, first);
  assert.deepEqual(parsed.receipts, [row]); assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(parsed.receipts[0]));
  const empty = page([], {examined: 8, next: '0x1234', more: true});
  assert.equal(projectInboxHistory(empty, owner, project).more, true);
  const next = inboxHistorySelector({revision: '2', after: '0x1234', limit: 8});
  assert.equal(projectInboxHistory(page(), owner, project, next).revision, '2');
  for (const patch of [{schema: 'other'}, {owner: '~nec'}, {project: 'other'}, {permissionGranted: true}, {committed: true}, {extra: 1},
    {desk: 'base'}, {revision: '02'}, {commit: '0v0123'}, {commit: '0v0'}, {examined: 9}, {examined: 0}, {examined: 1.5},
    {more: true}, {next: '0x1234'}, {receipts: [row, row], examined: 2}, {receipts: [{...row, peer: owner}]}])
    assert.throws(() => projectInboxHistory(page([row], patch), owner, project));
  assert.throws(() => projectInboxHistory(page(), owner, project, {...next, revision: '3'}));
  assert.throws(() => projectInboxHistory(empty, owner, project, next)); // A cursor must advance.
  assert.throws(() => projectInboxHistory(page([row, {...row, receiptHash: '0x2'}]), owner, project)); // Same nonce, different hash.
  for (const query of [{revision: '00', after: 'start', limit: 8}, {revision: '0', after: '0x1', limit: 8},
    {revision: '2', after: 'start', limit: 8}, {revision: '2', after: '../noun', limit: 8}, {revision: '2', after: '0x01', limit: 8},
    {revision: '0', after: 'start', limit: 0}, {revision: '0', after: 'start', limit: 9}, {...first, extra: 1}]) assert.throws(() => inboxHistorySelector(query));
});

test('a v2 history page splits archived single-file and multi-file suggestions; detail returns either kind', () => {
  const parsed = projectInboxHistory(page2(), owner, project);
  assert.deepEqual(parsed.receipts, [row]); assert.deepEqual(parsed.bundles, [bundleSummary]); assert.ok(Object.isFrozen(parsed.bundles[0].files));
  assert.deepEqual(projectInboxHistory(page(), owner, project).bundles, []);
  assert.throws(() => projectInboxHistory(page([row, bundleSummary]), owner, project)); // v1 never carries bundles
  for (const bad of [bundleDetail, {...bundleSummary, receiptHash: row.receiptHash}, {...bundleSummary, request: row.request, generation: row.generation, receiptHash: '0xa'},
    {...bundleSummary, peer: owner}, {...bundleSummary, files: []}, {...bundleSummary, files: [bundleSummary.files[0], bundleSummary.files[0]]}, {...bundleSummary, kind: 'other'}])
    assert.throws(() => projectInboxHistory(page2([row, bad]), owner, project));
  assert.throws(() => projectInboxHistory(page2([row, bundleSummary], {examined: 1}), owner, project));
  assert.deepEqual(projectInboxDetail(detail2(detail), owner, project, '0x1'), detail);
  assert.deepEqual(projectInboxDetail(detail2(bundleDetail), owner, project, '0x9'), bundleDetail);
  for (const [value, receipt] of [[detail2(bundleDetail), '0x1'], [detail2(detail), '0x9'], [detail2(bundleSummary), '0x9'], [detail2(row), '0x1'],
    [detail2({...bundleDetail, files: [{...bundleFiles[0], source: 'tampered'}]}), '0x9'], [{...detail2(detail), committed: true}, '0x1'],
    [{...detail2(detail), schema: 'readymade-project-inbox-v1'}, '0x1'], [detail2(detail), '0x01']])
    assert.throws(() => projectInboxDetail(value, owner, project, receipt));
});

test('v2 history and detail transport fall back only for an older ship', async () => {
  const seen = []; let mode = 'v2';
  const server = createServer((req, res) => {
    if (req.url === '/~/login') {res.setHeader('set-cookie', 'urbauth-~zod=fixture; Path=/'); res.end('{}'); return;}
    seen.push(req.url.split('/').at(-1)); res.setHeader('content-type', 'application/json');
    const refuse = (code, message) => {res.statusCode = code; res.end(JSON.stringify({status: 'refused', message}));};
    if (req.url.endsWith('history-v2')) {
      if (mode === 'old-route') return refuse(404, 'Unknown collaboration route.');
      if (mode === 'old-cantrip') return refuse(409, 'receipt-history-unavailable');
      if (mode === 'refused') return refuse(409, 'receipt-history-unobserved');
      return res.end(JSON.stringify(page2()));
    }
    if (req.url.endsWith('history')) return res.end(JSON.stringify(page()));
    if (mode === 'missing') return refuse(404, 'receipt-missing');
    if (mode === 'old-route') return refuse(404, 'Unknown collaboration route.');
    if (mode === 'old-cantrip') return refuse(409, 'receipt-history-unavailable');
    res.end(JSON.stringify(detail2(req.headers['x-readymade-project-receipt'] === '0x9' ? bundleDetail : detail)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new ShipClient(`http://127.0.0.1:${server.address().port}`, async () => 'fixture');
  try {
    await client.signIn();
    assert.equal((await client.projectInboxHistory(project)).schema, 'readymade-project-inbox-history-v2'); assert.deepEqual(seen.splice(0), ['project-inbox-history-v2']);
    for (mode of ['old-route', 'old-cantrip']) {
      assert.equal((await client.projectInboxHistory(project)).schema, 'readymade-project-inbox-history-v1');
      assert.deepEqual(seen.splice(0), ['project-inbox-history-v2', 'project-inbox-history']);
    }
    mode = 'refused'; await assert.rejects(client.projectInboxHistory(project), e => e.code === 'refused'); assert.deepEqual(seen.splice(0), ['project-inbox-history-v2']);
    mode = 'v2';
    assert.equal((await client.projectInboxDetail(project, '0x9')).receipt.kind, 'bundle');
    assert.equal((await client.projectInboxDetail(project, '0x1')).receipt.source, 'after');
    for (const [m, code] of [['missing', 'receiptMissing'], ['old-route', 'unsupported'], ['old-cantrip', 'unsupported']]) {
      mode = m; await assert.rejects(client.projectInboxDetail(project, '0x9'), e => e instanceof ShipClientError && e.code === code);
    }
    await assert.rejects(client.projectInboxDetail(project, '0x09'), e => e.code === 'contextChanged');
    assert.deepEqual(seen.splice(0), Array(5).fill('project-inbox-detail-v2'));
  } finally {client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
});

test('history transport is one authenticated bounded GET with exact continuation and no retry', async () => {
  const selected = 'café-共同', seen = []; let mode = 'first';
  const server = createServer((req, res) => {
    if (req.url === '/~/login') {res.setHeader('set-cookie', 'urbauth-~zod=fixture; Path=/'); res.end('{}'); return;}
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('-v2')) {res.statusCode = 404; res.end(JSON.stringify({status: 'refused', message: 'Unknown collaboration route.'})); return;}
    seen.push({method: req.method, url: req.url, headers: req.headers});
    if (mode === 'unknown') {res.statusCode = 409; res.end(JSON.stringify({status: 'refused', message: 'receipt-history-unobserved'})); return;}
    if (mode === 'changed') {res.statusCode = 409; res.end(JSON.stringify({status: 'refused', message: 'receipt-page-head-changed'})); return;}
    if (mode === 'oversize') {res.end(' '.repeat(524289)); return;}
    const body = page([], {project: selected, examined: 8, next: mode === 'next' ? '0x5678' : '0x1234', more: true});
    const raw = JSON.stringify(body); res.end(mode === 'duplicate' ? '{"owner":"~zod",' + raw.slice(1) : raw);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new ShipClient(`http://127.0.0.1:${server.address().port}`, async () => 'fixture');
  try {
    await assert.rejects(client.projectInboxHistory(selected), e => e instanceof ShipClientError && e.code === 'authenticationRequired');
    await client.signIn();
    await assert.rejects(client.projectInboxHistory(selected, {revision: '2', after: 'start', limit: 8})); assert.equal(seen.length, 0);
    await client.projectInboxHistory(selected);
    assert.equal(Buffer.from(seen[0].headers['x-readymade-project'], 'latin1').toString('utf8'), selected);
    assert.deepEqual(['revision', 'after', 'limit'].map(k => seen[0].headers[`x-readymade-history-${k}`]), ['0', 'start', '8']);
    mode = 'next'; await client.projectInboxHistory(selected, {revision: '2', after: '0x1234', limit: 8});
    assert.equal(seen.at(-1).headers['x-readymade-history-after'], '0x1234');
    for (mode of ['unknown', 'changed', 'duplicate', 'oversize']) {
      const before = seen.length;
      await assert.rejects(client.projectInboxHistory(selected), e => e instanceof ShipClientError &&
        e.code === (mode === 'unknown' ? 'refused' : mode === 'changed' ? 'historyChanged' : mode === 'oversize' ? 'tooLarge' : 'malformed'));
      assert.equal(seen.length, before + 1);
    }
    assert.ok(seen.every(r => r.method === 'GET' && r.url === '/apps/readymade-collab/project-inbox-history'));
  } finally {client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
});

let commandHook = async () => {};
const ui = {workspace: {registerTextDocumentContentProvider: () => ({dispose() {}}), openTextDocument: async uri => uri},
  window: {showTextDocument: async () => {}, showInformationMessage: async () => undefined, showQuickPick: async items => items[0],
    withProgress: async (_options, task) => task({report() {}}, {isCancellationRequested: false})},
  ProgressLocation: {Notification: 15}, commands: {executeCommand: async (...args) => commandHook(...args)},
  Uri: {from: ({path}) => ({toString: () => `readymade-inbox:${path}`})}, FileSystemError: {FileNotFound: () => Error('missing')}};
const original = Module._load; let ProjectInboxView;
try {
  Module._load = function(name, ...args) {return name === 'vscode' ? ui : original.call(this, name, ...args);};
  ({ProjectInboxView} = require('../dist/src/project-inbox-view'));
} finally {Module._load = original;}

function viewFixture() {
  let context, response = page(), full = detail, hot = [], archived = bundleDetail; const calls = [], answers = [];
  const client = {origin: 'https://zod.example', snapshot: {owner, sessions: []}, codingState: async () => client.snapshot,
    projectInboxHistory: async (p, q) => {calls.push([p, q]); return typeof response === 'function' ? response() : response;},
    projectInboxBundles: async p => ({schema: 'readymade-project-inbox-bundles-v1', owner, project: p, permissionGranted: false, committed: false, total: '0', more: false, bundles: []}),
    projectInboxDetail: async (p, receipt) => {calls.push(['detail', p, receipt]); return detail2(archived);},
    suggestionAnswer: async (...args) => {answers.push(args);}};
  context = {client, project, sources: {}, loader: {}, drafts: {}};
  const view = new ProjectInboxView(() => context, async (_client, p, receipt) => ({schema: 'readymade-project-inbox-v1', owner, project: p,
    permissionGranted: false, committed: false, receipts: receipt ? [full] : hot}), async () => {}, () => {});
  return {view, client, calls, answers, response: value => {response = value;}, archived: value => {archived = value;}, full: value => {full = value;}, hot: value => {hot = value;}, context: value => {context = value;}, current: () => context};
}
const historyRows = view => view.rows()[0].children.find(r => r.label === 'History').children;

test('History and Next keep only the current page, preserve old actions, and never mark archive as waiting', async () => {
  const f = viewFixture();
  try {
    f.response(page([], {examined: 8, next: '0x1234', more: true})); await f.view.observeHistory();
    assert.ok(historyRows(f.view).some(r => r.label === 'No suggestions on this page'));
    assert.deepEqual(historyRows(f.view).find(r => r.label === 'Next').command.arguments, ['next-history']);
    f.response(page()); await f.view.observeHistory(true);
    assert.deepEqual(f.calls[1], [project, {revision: '2', after: '0x1234', limit: 8}]);
    assert.equal(f.view.receipts, undefined); assert.equal(f.view.waiting, undefined);
    const actions = historyRows(f.view).find(r => r.label === row.path).children;
    assert.deepEqual(actions.map(a => a.command.arguments), [['0x1'], ['0x1'], ['0x1', 'taken'], ['0x1', 'declined']]);
    await f.view.show('0x1'); await f.view.answer('0x1', 'taken'); assert.deepEqual(f.answers, [[project, '0x1', 'taken']]);
    f.full({...detail, peer: '~bud'}); await assert.rejects(f.view.show('0x1'), /receipt changed/);
    // Replacing the page removes old command selection; no lifetime accumulation.
    f.response(page([], {examined: 8, next: '0x3', more: true})); await f.view.observeHistory();
    await assert.rejects(f.view.show('0x1'), /Read the inbox or history/);
    for (let i = 4; i < 20; i++) {f.response(page([], {examined: 8, next: `0x${i.toString(16)}`, more: true})); await f.view.observeHistory(true);}
    assert.equal(historyRows(f.view).filter(r => r.label === row.path).length, 0);
  } finally {f.view.dispose();}
});

test('history refuses changed heads, repeated rows and in-flight context changes without another request', async () => {
  const f = viewFixture();
  try {
    f.response(page([row], {next: '0x1234', more: true})); await f.view.observeHistory();
    f.response(page([], {commit: '0v124'})); await assert.rejects(f.view.observeHistory(true), /history changed/);
    f.response(page()); await assert.rejects(f.view.observeHistory(true), /repeated a page/);
    const before = f.calls.length;
    f.response(async () => {f.context({...f.current(), project: 'other'}); return page();});
    await assert.rejects(f.view.observeHistory(), /Owner project changed/); assert.equal(f.calls.length, before + 1);
    assert.equal(historyRows(f.view).some(r => r.label === row.path), false);
    await assert.rejects(f.view.answer('0x1', 'taken'), /Read the inbox or history/); assert.equal(f.answers.length, 0);
  } finally {f.view.dispose();}
});

test('history refuses conflicting hot selection while keeping exact duplicates usable', async () => {
  const f = viewFixture();
  try {
    f.hot([row]); await f.view.observe();
    f.response(page()); await f.view.observeHistory(); await f.view.show(row.receiptHash);
    f.response(page([{...row, peer: '~bud'}])); await assert.rejects(f.view.observeHistory(), /Inbox and history disagree/);
    f.response(page([{...row, receiptHash: '0x2'}])); await assert.rejects(f.view.observeHistory(), /Inbox and history disagree/);
    assert.equal(f.view.receipts[0].peer, '~nec'); assert.equal(f.answers.length, 0);
  } finally {f.view.dispose();}
});

test('hot refresh refuses history-first conflicts without replacing a valid selection', async () => {
  const f = viewFixture();
  try {
    await f.view.observeHistory();
    f.hot([row]); await f.view.observe();
    for (const conflicting of [{...row, peer: '~bud'}, {...row, receiptHash: '0x2'}]) {
      f.hot([conflicting]); await assert.rejects(f.view.observe(), /Inbox and history disagree/);
      assert.deepEqual(f.view.receipts, [row]);
      assert.equal(historyRows(f.view).find(r => r.label === row.path).description, '~nec');
      await f.view.show(row.receiptHash);
    }
    await f.view.answer(row.receiptHash, 'declined');
    assert.deepEqual(f.answers, [[project, row.receiptHash, 'declined']]);
  } finally {f.view.dispose();}
});

test('History lists an archived multi-file suggestion and opens each file through one checked detail read', async () => {
  const f = viewFixture(), opened = [];
  const show = ui.window.showTextDocument; ui.window.showTextDocument = async uri => {opened.push(String(uri));};
  try {
    await assert.rejects(f.view.showBundleFile('0x9', '/lib/a/hoon'), /Refresh the inbox or history/);
    f.response(page2()); await f.view.observeHistory();
    const bundle = historyRows(f.view).find(r => r.label === '2 files');
    assert.deepEqual(bundle.children.map(c => c.command.arguments), [['0x9'], ['0x9'], ['0x9', '/lib/a/hoon'], ['0x9', '/lib/b/hoon']]);
    assert.equal(bundle.children[1].command.command, 'readymade.compareInboxBundle');
    assert.equal(bundle.children[0].command.command, 'readymade.importInboxBundle');
    await f.view.showBundleFile('0x9', '/lib/b/hoon');
    assert.deepEqual(f.calls.at(-1), ['detail', project, '0x9']); assert.match(opened.at(-1), /\/lib\/b\/hoon$/);
    await assert.rejects(f.view.showBundleFile('0x9', '/lib/c/hoon'), /Refresh the inbox or history/);
    f.archived({...bundleDetail, files: [bundleFiles[0]]}); await assert.rejects(f.view.showBundleFile('0x9', '/lib/a/hoon'), /receipt changed/);
    // The same receipt held hot must agree with its archived row, or neither replaces the other.
    f.archived(bundleDetail); f.client.projectInboxBundles = async p => ({schema: 'readymade-project-inbox-bundles-v1', owner, project: p,
      permissionGranted: false, committed: false, total: '1', more: false, bundles: [{...bundleDetail, revision: '5'}]});
    await assert.rejects(f.view.observe(), /Inbox and history disagree/);
    f.client.projectInboxBundles = async p => ({schema: 'readymade-project-inbox-bundles-v1', owner, project: p,
      permissionGranted: false, committed: false, total: '1', more: false, bundles: [bundleDetail]});
    await f.view.observe(); const calls = f.calls.length;
    await f.view.showBundleFile('0x9', '/lib/a/hoon'); assert.equal(f.calls.length, calls); // hot copy needs no detail read
  } finally {ui.window.showTextDocument = show; f.view.dispose();}
});

test('a whole multi-file suggestion imports into ONE draft with its origin, and a stale source imports nothing', async () => {
  const {mkdtempSync, rmSync} = require('node:fs'), {tmpdir} = require('node:os'), {join} = require('node:path');
  const {DraftStore} = require('../dist/src/draft-store'), {snapshotFrom} = require('../dist/src/source-store');
  const directory = mkdtempSync(join(tmpdir(), 'readymade-bundle-view-'));
  const basis = {id: '0x4', owner, desk: 'work', number: 4, root: '0v10', commit: '0v5'};
  const originals = {'/lib/a/hoon': 'a0\n', '/lib/b/hoon': 'b0\n'};
  const snap = path => snapshotFrom({origin: 'https://zod.example', ship: owner, session: '0x6', source: basis, path, blob: path === '/lib/a/hoon' ? '0x7' : '0x8', mark: 'hoon', text: originals[path]});
  const bundle = {kind: 'bundle', receiptHash: '0x9', peer: '~nec', receivedAt: '~2026.11.16', generation: '4', request: '0x7', parentRoot: '0x20',
    snapshotDigest: '0x3', desk: 'work', revision: '4', files: Object.keys(originals).map(path => ({path, originalHash: remoteSourceHash(originals[path]), sourceHash: remoteSourceHash('new\n'), source: 'new\n'}))};
  let sessionBasis = basis; const reads = [];
  const state = () => ({owner, session: '0x6', sessions: [{id: '0x6', project, source: sessionBasis}]});
  const client = {origin: 'https://zod.example', snapshot: {owner, sessions: []}, codingState: async () => state(),
    projectInboxBundles: async p => ({schema: 'readymade-project-inbox-bundles-v1', owner, project: p, permissionGranted: false, committed: false, total: '1', more: false, bundles: [bundle]})};
  const drafts = new DraftStore(directory);
  const context = {client, project, drafts, sources: {openSnapshot: descriptor => snap(descriptor)},
    loader: {load: async (session, b, path) => {reads.push([session, b.number, path]); return path;}}};
  const view = new ProjectInboxView(() => context, async () => ({schema: 'readymade-project-inbox-v1', owner, project, permissionGranted: false, committed: false, receipts: []}), async () => {}, () => {});
  try {
    await view.observe();
    const row = view.rows()[0].children.find(r => r.label === '2 files');
    assert.deepEqual(row.children[0].command.arguments, ['0x9']);
    sessionBasis = {...basis, number: 5, root: '0v11'};
    await assert.rejects(view.importBundle('0x9'), /No current owner session matches/);
    assert.equal(drafts.listBundles().length, 0); assert.equal(reads.length, 0);
    sessionBasis = basis;
    await view.importBundle('0x9');
    assert.deepEqual(reads, [['0x6', 4, '/lib/a/hoon'], ['0x6', 4, '/lib/b/hoon']]);
    const [draft] = drafts.listBundles();
    assert.equal(drafts.listBundles().length, 1); assert.equal(draft.receipt.peer, '~nec'); assert.equal(draft.receipt.receiptHash, '0x9');
    assert.deepEqual(draft.files.map(f => [f.snapshot.path, f.text]), [['/lib/a/hoon', 'new\n'], ['/lib/b/hoon', 'new\n']]);
    const shown = view.rows()[0].children.find(r => r.label === 'Imported Multi-File Drafts').children[0];
    assert.equal(shown.description, 'from ~nec'); assert.match(shown.tooltip, /0x9/);
    await assert.rejects(view.importBundle('0x9'), /already has a retained bundle draft/);
    assert.equal(drafts.listBundles().length, 1);
  } finally {view.dispose(); rmSync(directory, {recursive: true, force: true});}
});

test('comparing a suggestion with the owner current files shows each moved file side by side and changes nothing', async () => {
  const {mkdtempSync, rmSync, readdirSync} = require('node:fs'), {tmpdir} = require('node:os'), {join} = require('node:path');
  const {DraftStore} = require('../dist/src/draft-store'), {snapshotFrom} = require('../dist/src/source-store');
  const {bundleDrift} = require('../dist/src/project-inbox');
  const directory = mkdtempSync(join(tmpdir(), 'readymade-bundle-drift-'));
  const old = {id: '0x4', owner, desk: 'work', number: 4, root: '0v10', commit: '0v5'}, now = {...old, number: 5, root: '0v11', commit: '0v6'};
  const originals = {'/lib/a/hoon': 'a0\n', '/lib/b/hoon': 'b0\n'}, currents = {'/lib/a/hoon': 'a0 owner edit\n', '/lib/b/hoon': 'b0\n'};
  const snap = (path, basis, text) => snapshotFrom({origin: 'https://zod.example', ship: owner, session: '0x6', source: basis, path, blob: path === '/lib/a/hoon' ? '0x7' : '0x8', mark: 'hoon', text});
  const bundle = {kind: 'bundle', receiptHash: '0x9', peer: '~nec', receivedAt: '~2026.11.16', generation: '4', request: '0x7', parentRoot: '0x20',
    snapshotDigest: '0x3', desk: 'work', revision: '4', files: Object.keys(originals).map(path => ({path, originalHash: remoteSourceHash(originals[path]), sourceHash: remoteSourceHash('new\n'), source: 'new\n'}))};
  assert.deepEqual(bundleDrift(bundle, [snap('/lib/b/hoon', now, 'b0\n'), snap('/lib/a/hoon', now, 'x\n')]).map(r => [r.path, r.changed]), [['/lib/a/hoon', true], ['/lib/b/hoon', false]]);
  assert.throws(() => bundleDrift(bundle, [snap('/lib/a/hoon', now, 'x\n')]));
  const reads = [], diffs = [];
  commandHook = async (name, left, right, title) => {diffs.push([name, String(left), String(right), title]);};
  const client = {origin: 'https://zod.example', snapshot: {owner, sessions: []},
    codingState: async () => ({owner, session: '0x6', sessions: [{id: '0x5', project, source: old}, {id: '0x6', project, source: now}]}),
    projectInboxBundles: async p => ({schema: 'readymade-project-inbox-bundles-v1', owner, project: p, permissionGranted: false, committed: false, total: '1', more: false, bundles: [bundle]})};
  const drafts = new DraftStore(directory);
  const context = {client, project, drafts, sources: {openSnapshot: path => snap(path, now, currents[path])},
    loader: {load: async (session, b, path) => {reads.push([session, b.number, path]); return path;}}};
  const view = new ProjectInboxView(() => context, async () => ({schema: 'readymade-project-inbox-v1', owner, project, permissionGranted: false, committed: false, receipts: []}), async () => {}, () => {});
  try {
    await view.observe(); await view.compareBundle('0x9');
    assert.deepEqual(reads, [['0x6', 5, '/lib/a/hoon'], ['0x6', 5, '/lib/b/hoon']]);
    assert.equal(diffs.length, 1); assert.equal(diffs[0][0], 'vscode.diff'); assert.match(diffs[0][3], /^\/lib\/a\/hoon: suggested \(revision 4\) ↔ your current \(revision 5\)$/);
    const row = view.rows()[0].children.find(r => r.label === '2 files').children[1];
    assert.equal(row.description, '1 of 2 changed since suggested (vs revision 5)');
    assert.equal(drafts.listBundles().length, 0); assert.deepEqual(readdirSync(directory), []);
    // Item 26: both versions stay until the owner chooses; then only chosen suggested files become drafts on the current source.
    const choiceRows = () => view.rows()[0].children.find(r => r.label === '2 files').children[1].children;
    assert.deepEqual(choiceRows().map(r => [r.label, r.description]), [['/lib/a/hoon', 'changed since suggested: choose'], ['/lib/b/hoon', 'use suggested (unchanged)']]);
    assert.throws(() => view.resolveBundle('0x9'), /Choose a version for \/lib\/a\/hoon/);
    assert.equal(drafts.list().length, 0);
    view.chooseBundleFile('0x9', '/lib/a/hoon', 'mine');
    assert.equal(choiceRows().at(-1).command.command, 'readymade.resolveInboxBundle');
    view.resolveBundle('0x9');
    assert.deepEqual(drafts.list().map(d => [d.snapshot.path, d.snapshot.source.number, d.text]), [['/lib/b/hoon', 5, 'new\n']]);
    view.chooseBundleFile('0x9', '/lib/a/hoon', 'suggested');
    assert.throws(() => view.resolveBundle('0x9'), /already has a draft. Nothing was written/);
    assert.equal(drafts.list().length, 1);
  } finally {commandHook = async () => {}; view.dispose(); rmSync(directory, {recursive: true, force: true});}
});
