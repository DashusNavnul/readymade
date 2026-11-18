const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
const fs = require('node:fs'), path = require('node:path');
const page = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/native', name + '.json'), 'utf8'));

// A small stand-in for the editor: enough of the API for the screens, recording what they show and ask.
function editor() {
  const shown = {info: [], warn: []}, settings = {}, listeners = {editor: [], document: []}, answers = {warn: undefined, input: [], pick: []}, panels = [], documents = [];
  const item = () => ({text: '', tooltip: '', name: '', command: '', visible: false, show() {this.visible = true;}, hide() {this.visible = false;}, dispose() {}});
  const said = (list, answer) => (message, ...rest) => {list.push(message); const choice = typeof answer === 'function' ? answer(rest) : undefined; return Promise.resolve(choice);};
  const vscode = {
    StatusBarAlignment: {Left: 1, Right: 2}, ViewColumn: {Active: -1}, ConfigurationTarget: {Global: 1},
    window: {activeTextEditor: undefined, createStatusBarItem: item,
      onDidChangeActiveTextEditor: cb => {listeners.editor.push(cb); return {dispose() {}};},
      showInformationMessage: said(shown.info), showWarningMessage: said(shown.warn, rest => rest.includes(answers.warn) ? answers.warn : undefined),
      showInputBox: () => Promise.resolve(answers.input.shift()), showQuickPick: items => Promise.resolve(answers.pick.length ? answers.pick.shift()(items) : undefined),
      showTextDocument: doc => {documents.push(doc); return Promise.resolve();},
      createWebviewPanel: () => {
        const panel = {webview: {html: '', onDidReceiveMessage: cb => {panel.receive = cb; return {dispose() {}};}}, onDidDispose: cb => {panel.closed = cb; return {dispose() {}};}, reveal() {}, dispose() {panel.closed?.();}};
        panels.push(panel); return panel;
      }},
    workspace: {onDidChangeTextDocument: cb => {listeners.document.push(cb); return {dispose() {}};}, onDidChangeConfiguration: cb => {listeners.config = cb; return {dispose() {}};}, openTextDocument: doc => Promise.resolve(doc),
      getConfiguration: () => ({get: (key, fallback) => key in settings ? settings[key] : fallback, update: (key, value) => {settings[key] = value; return Promise.resolve();}})}
  };
  return {vscode, shown, settings, answers, panels, documents, listeners};
}
const ED = editor(), original = Module._load;
let NativeScreens, ReportPanel, OutcomeUnknownError, ShipClientError;
try {
  Module._load = function (name, ...args) {return name === 'vscode' ? ED.vscode : original.call(this, name, ...args);};
  ({NativeScreens} = require('../dist/src/native-screens')); ({ReportPanel} = require('../dist/src/report-panel'));
  ({OutcomeUnknownError, ShipClientError} = require('../dist/src/ship-client'));
} finally {Module._load = original;}

const OWNER = '~zod', PEER = '~nec', DEMO = 'pataphor-demo-mp', CODING = '/apps/pataphor-native/coding/', COLLAB = '/apps/readymade-collab/';
/** A ship that answers each page from a table and records every request. A function entry may throw. */
function setup(t, me, pages = {}, host = {}) {
  ED.shown.info.length = 0; ED.shown.warn.length = 0; ED.documents.length = 0; ED.panels.length = 0; ED.answers.input = []; ED.answers.pick = []; ED.answers.warn = undefined;
  for (const key of Object.keys(ED.settings)) delete ED.settings[key];
  ED.vscode.window.activeTextEditor = undefined;
  const requests = [], held = new Map(), writes = [], state = {get: key => held.get(key), update: (key, value) => {held.set(key, value); writes.push(key); return Promise.resolve();}};
  const client = {nativePage: async (where, request = {}) => {
    const method = request.method ?? 'GET', key = `${method} ${where.split('?')[0]}`; requests.push({method, path: where, headers: request.headers, body: request.body});
    const answer = pages[key]; if (answer === undefined) throw new ShipClientError('unavailable', 404);
    const value = typeof answer === 'function' ? await answer(request, where) : answer;
    return 'status' in value && 'value' in value ? value : {status: 200, value};
  }};
  let changes = 0;
  const screens = new NativeScreens({client: () => host.disconnected ? undefined : host.swap ?? client, ship: () => host.shipNow ? host.shipNow() : me, project: () => host.project, shared: uri => host.shared?.(uri), sessions: () => host.sessions ?? [], state, recover: host.recover,
    changed: () => {changes++;}}, 1, host.boardFreshMs, host.streamPollMs);
  t.after(() => screens.dispose());
  return {screens, requests, state: held, writes, changes: () => changes, posts: where => requests.filter(r => r.method === 'POST' && r.path === where).map(r => r.body)};
}
const ownerPages = () => ({[`GET ${CODING}overview`]: page('overview'), [`GET ${CODING}tasks`]: page('tasks'), [`GET ${COLLAB}session-stream`]: {schema: 'readymade-session-streams-v1', peer: OWNER, observedAt: '~2026.11.17..10.00.00', streams: []}});
const doc = (scheme, where) => ({document: {uri: {scheme, path: where, toString: () => `${scheme}:${where}`}, isDirty: false}});

test('the tree shows nothing until a ship is connected, then the Ship group and the overview with its blockers as problems', async t => {
  const x = setup(t, OWNER, ownerPages(), {project: DEMO});
  const before = x.screens.rows(); assert.deepEqual(before.map(r => r.id), ['native-pages'], 'collaboration pages show before the overview has answered');
  await x.screens.connected();
  const rows = x.screens.rows(), overview = rows.find(r => r.id === 'native-overview'), pages = rows.find(r => r.id === 'native-pages');
  assert.match(overview.description, /^\d+ waiting on you$/); assert.equal(overview.children.length, page('overview').blockers.length);
  assert.ok(overview.children.every(r => r.problem.status === 'blocked' && r.command.command === 'readymade.overview'));
  const labels = pages.children.map(r => r.label);
  for (const label of ['Tasks and Questions', 'Work Requests', 'Standing Policy', 'Memory Handoff', 'Suggestion History', 'Session Roles', 'Notices']) assert.ok(labels.includes(label), label);
  assert.ok(!labels.includes('Follow a Shared Session'), 'no shared session is listed'); assert.ok(x.changes() > 0);
  // Disconnecting drops what was read: no overview row, no badge left over from the last ship.
  const moved = {}; const y = setup(t, OWNER, ownerPages(), moved); y.screens.rows(); await new Promise(r => setTimeout(r, 20)); assert.equal(y.screens.rows().length, 2, 'the tree itself notices the connection and reads once');
  moved.disconnected = true; assert.deepEqual(y.screens.rows(), []);
  const guest = setup(t, PEER, {}, {sessions: [{owner: OWNER, project: DEMO, generation: '5', session: '0xe1b1', inspection: '0xdf49', phase: 'paused'}]});
  await guest.screens.connected();
  assert.deepEqual(guest.screens.rows()[0].children.map(r => r.label), ['Notices', 'Who Has What Open', 'Follow a Shared Session', 'Ask the Owner\'s Agent for Work', 'Show Collaborators Which Shared File I Have Open']);
  assert.deepEqual(setup(t, OWNER, {}, {disconnected: true}).screens.rows(), []);
});

test('presence is off until turned on; then it reports, renews nothing early, and closes the file it left', async t => {
  const board = entries => ({schema: 'readymade-file-presence-v1', authority: OWNER, project: DEMO, observedAt: '~2026.11.17..10.00.00', entries, refused: []});
  const shared = uri => uri.includes('/lib/a/hoon') ? {owner: OWNER, project: DEMO, path: '/lib/a/hoon'} : uri.includes('/lib/b/hoon') ? {owner: OWNER, project: DEMO, path: '/lib/b/hoon'} : undefined;
  const x = setup(t, PEER, {[`POST ${COLLAB}presence`]: {status: 202, value: {status: 'sent'}},
    [`GET ${COLLAB}presence`]: board([{ship: OWNER, path: '/lib/a/hoon', mode: 'editing', label: '', at: '~2026.11.17..10.00.00', until: '~2026.11.17..10.04.00'}])}, {shared});
  ED.vscode.window.activeTextEditor = doc('readymade-remote-source', '/key/lib/a/hoon');
  await x.screens.tellPresence();
  assert.equal(x.requests.length, 0, 'nothing leaves this computer while presence is off'); assert.equal(x.screens.presenceShown.text, '');
  ED.answers.warn = undefined; await x.screens.togglePresence();
  assert.equal(ED.settings.sharePresence, true); assert.match(ED.shown.info.at(-1), /now see which shared file you have open/);
  assert.deepEqual(x.posts(COLLAB + 'presence').map(b => [b.path, b.mode, b.authority]), [['/lib/a/hoon', 'viewing', OWNER]]);
  assert.equal(x.screens.presenceShown.text, '$(eye) ~zod is editing (a private draft)');
  await x.screens.tellPresence(); assert.equal(x.posts(COLLAB + 'presence').length, 1, 'a fresh lease is not sent again');
  ED.vscode.window.activeTextEditor = doc('readymade-remote-draft', '/key/lib/b/hoon'); await x.screens.tellPresence();
  assert.deepEqual(x.posts(COLLAB + 'presence').slice(1).map(b => [b.path, b.mode]), [['/lib/a/hoon', 'closed'], ['/lib/b/hoon', 'editing']]);
  ED.vscode.window.activeTextEditor = doc('file', '/Users/me/notes.txt'); await x.screens.tellPresence();
  assert.deepEqual(x.posts(COLLAB + 'presence').at(-1).mode, 'closed', 'a local file is never reported; the last report is withdrawn');
  await x.screens.togglePresence(); assert.equal(ED.settings.sharePresence, false);
  // Turning it on in Settings, not through the command, reports at once too.
  ED.settings.sharePresence = true; ED.vscode.window.activeTextEditor = doc('readymade-remote-source', '/key/lib/a/hoon');
  const before = x.posts(COLLAB + 'presence').length; ED.listeners.config({affectsConfiguration: key => key === 'readymade.sharePresence'}); await new Promise(r => setTimeout(r, 15));
  assert.equal(x.posts(COLLAB + 'presence').length, before + 1); ED.settings.sharePresence = false; ED.vscode.window.activeTextEditor = undefined; await x.screens.tellPresence();
  const count = x.posts(COLLAB + 'presence').length; ED.vscode.window.activeTextEditor = doc('readymade-remote-source', '/key/lib/a/hoon'); await x.screens.tellPresence();
  assert.equal(x.posts(COLLAB + 'presence').length, count);
});

test('on a slow ship a followed session still ends on screen, and the poll never asks faster than the ship answers', async t => {
  const s = {owner: OWNER, project: DEMO, generation: '5', session: '0xe1b1.e811', inspection: '0xdf49.1c93'};
  let phase = 'live';
  const stream = () => ({schema: 'readymade-session-streams-v1', peer: PEER, observedAt: '~2026.11.17..10.21.00', streams: [{owner: OWNER, session: s.session, project: DEMO, phase, reason: phase === 'live' ? 'opening' : 'inspection-grant-revoked',
    sequence: 19, reconnects: 0, opened: '~2026.11.17..10.19.27', updated: '~2026.11.17..10.20.30', status: {phase: 'paused', at: '~2026.11.17..10.20.30', source: 'pataphor-demo-mp-work/8'}}]});
  let out = 0, most = 0;
  // Every answer takes four poll intervals: each one arrives after the next poll was due.
  const x = setup(t, PEER, {[`POST ${COLLAB}session-stream`]: {status: 202, value: {}},
    [`GET ${COLLAB}session-stream`]: async () => {out++; most = Math.max(most, out); const said = stream(); await new Promise(r => setTimeout(r, 40)); out--; return said;}}, {sessions: [s], streamPollMs: 10});
  await x.screens.follow(s); assert.equal(x.screens.followed[0].phase, 'live');
  phase = 'ended'; await new Promise(r => setTimeout(r, 200));
  assert.equal(x.screens.followed[0].phase, 'ended', 'the late answer is applied, not dropped'); assert.equal(most, 1, 'never two reads out at once');
  const reads = x.requests.length; await new Promise(r => setTimeout(r, 80)); assert.equal(x.requests.length, reads, 'and the poll stopped once nothing was live');
});
test('a withdrawal the ship answered is never rejected by what is read after it', async t => {
  const queue = {schema: 'readymade-work-queue-v1', ship: PEER, observedAt: '~2026.11.17..10.47.00', store: false, requests: [], asked: [], withdrawRefused: []};
  const x = setup(t, PEER, {[`POST ${COLLAB}work-withdraw`]: {status: 202, value: {status: 'sent'}}, [`GET ${COLLAB}work-queue`]: queue, [`GET ${COLLAB}notices`]: {...page('peer-notices'), inbox: [{kind: 7}]}});
  x.state.set('readymade.workAsked:~nec', [{nonce: '0x1002', owner: OWNER, project: DEMO, session: '0xe1b1.e811', text: 'x', at: 1, answer: 'queued'}]);
  assert.equal(await x.screens.withdraw('0x1002'), 'Asked ~zod to withdraw it; its ship has not answered yet. Read the page again to see.');
  assert.equal(x.posts(COLLAB + 'work-withdraw').length, 1);
});
test('an overview read that fails after the window moved to another ship says nothing about that ship', async t => {
  let fail;
  const pages = {...ownerPages(), [`GET ${CODING}overview`]: () => new Promise((_, reject) => {fail = () => reject(new ShipClientError('transport'));})};
  const host = {project: DEMO};
  const x = setup(t, OWNER, pages, host);
  x.screens.rows(); await new Promise(r => setTimeout(r, 5));          // ship A: its overview read is out
  host.swap = {nativePage: async () => {throw new ShipClientError('unavailable', 404);}};   // the window is now on a guest ship
  x.screens.rows(); await new Promise(r => setTimeout(r, 5));
  fail(); await new Promise(r => setTimeout(r, 5));
  const rows = x.screens.rows();
  assert.deepEqual(rows.map(r => r.id), ['native-pages'], 'no Overview row for the guest'); assert.ok(!rows[0].children.some(r => r.label === 'Tasks and Questions'));
});
test('typing in a shared file does not ask the ship who else is here on every keystroke', async t => {
  const board = {schema: 'readymade-file-presence-v1', authority: OWNER, project: DEMO, observedAt: '~2026.11.17..10.00.00', entries: [], refused: []};
  const shared = uri => uri.includes('/lib/a/hoon') ? {owner: OWNER, project: DEMO, path: '/lib/a/hoon'} : undefined;
  const x = setup(t, PEER, {[`POST ${COLLAB}presence`]: {status: 202, value: {status: 'sent'}}, [`GET ${COLLAB}presence`]: board}, {shared, boardFreshMs: 60});
  ED.settings.sharePresence = true; ED.vscode.window.activeTextEditor = doc('readymade-remote-source', '/key/lib/a/hoon');
  const reads = () => x.requests.filter(r => r.method === 'GET' && r.path === COLLAB + 'presence').length;
  await x.screens.tellPresence(); assert.equal(reads(), 1); assert.equal(x.posts(COLLAB + 'presence').length, 1);
  for (let i = 0; i < 40; i++) await x.screens.tellPresence();
  // The read right after the report may be too early for the owner's answer, so the next edit reads once more; that one stands.
  assert.equal(reads(), 2, 'forty edits: one more read, then the board stands'); assert.equal(x.posts(COLLAB + 'presence').length, 1);
  await new Promise(r => setTimeout(r, 80)); await x.screens.tellPresence(); assert.equal(reads(), 3, 'and it is read again once it is no longer fresh');
});
test('Who Has What Open keeps its project when it is read again from the screen itself', async t => {
  const board = project => ({schema: 'readymade-file-presence-v1', authority: OWNER, project, observedAt: '~2026.11.17..10.00.00', entries: [], refused: []});
  const shared = uri => uri.includes('/lib/a/hoon') ? {owner: OWNER, project: DEMO, path: '/lib/a/hoon'} : undefined;
  const x = setup(t, PEER, {[`GET ${COLLAB}presence`]: request => board(request.headers['x-readymade-project'])}, {shared, project: 'my-own-project'});
  ED.vscode.window.activeTextEditor = doc('readymade-remote-source', '/key/lib/a/hoon');
  await x.screens.board.show();
  const asked = () => x.requests.filter(r => r.path === COLLAB + 'presence').map(r => [r.headers['x-readymade-project'], r.headers['x-readymade-project-owner']]);
  assert.deepEqual(asked(), [[DEMO, OWNER]]);
  // The screen now has the focus: no file is in front. Read again must ask about the same shared project.
  ED.vscode.window.activeTextEditor = undefined; await x.screens.board.refresh();
  assert.deepEqual(asked().at(-1), [DEMO, OWNER]);
  // A file of this ship's own project in front changes it, as before.
  ED.vscode.window.activeTextEditor = doc('file', '/Users/x/notes.txt'); await x.screens.board.refresh();
  assert.deepEqual(asked().at(-1), ['my-own-project', PEER]);
});
test('a refused presence report is said once, with the owner’s reason', async t => {
  const x = setup(t, PEER, {[`POST ${COLLAB}presence`]: {status: 202, value: {status: 'sent'}}, [`GET ${COLLAB}presence`]: page('peer-presence')},
    {shared: () => ({owner: OWNER, project: DEMO, path: '/desk/bill'})});
  ED.settings.sharePresence = true; ED.vscode.window.activeTextEditor = doc('readymade-remote-source', '/key/desk/bill');
  await x.screens.tellPresence(); await x.screens.tellPresence();
  assert.deepEqual(ED.shown.warn, ['~zod does not show you on /desk/bill: presence path not shared. That file is not shared with you, so the owner\'s ship will not show you on it.']);
  assert.equal(x.screens.presenceShown.text, '$(eye-closed) Presence refused');
});

test('a command says what the ship did, why it refused, or that the outcome is unknown; it is never sent twice', async t => {
  let sent = 0;
  const x = setup(t, OWNER, {[`POST ${CODING}tasks`]: request => {
    sent++;
    if (request.body.id === '0x1') return {status: 409, value: {error: 'question-missing'}};
    if (request.body.id === '0x2') throw new OutcomeUnknownError();
    return {status: 202, value: {status: 'written'}};
  }});
  assert.equal(await x.screens.answer('0x3', 'Keep it.'), 'Your answer is stored. The task can be claimed again.');
  assert.equal(await x.screens.answer('0x1', 'x'), 'Refused by the ship: question missing. Your ship holds no such question. Read the page again. Nothing changed.');
  assert.match(await x.screens.answer('0x2', 'x'), /outcome is unknown\. It was not sent again/); assert.equal(sent, 3);
  await assert.rejects(x.screens.answer('0x3', '   '), /Invalid answer/); assert.equal(sent, 3, 'an empty answer never leaves this computer');
  await assert.rejects(setup(t, OWNER, {}).screens.retry('0x9'), /does not have this page/);
  const policy = setup(t, OWNER, {[`POST ${CODING}policy`]: request => request.body.action === 'revoke' ? {status: 202, value: {status: 'submitted'}} : {status: 409, value: {error: 'standing-policy-unchanged'}}});
  assert.equal(await policy.screens.revokePolicy(), 'Sent. No policy is in force once the revocation appears below.'); assert.deepEqual(policy.posts(CODING + 'policy'), [{action: 'revoke'}]);
});

test('a ship that signed the window out: a read is asked once more after signing in, a command is never resent', async t => {
  let signedOut = true, recovered = 0, posts = 0;
  const guard = answer => () => {if (signedOut) throw new ShipClientError('authenticationRequired', 401); return answer;};
  const x = setup(t, PEER, {[`GET ${COLLAB}notices`]: guard(page('peer-notices')), [`POST ${COLLAB}notice-retry`]: () => {posts++; if (signedOut) throw new ShipClientError('authenticationRequired', 401); return {status: 202, value: {}};}},
    {recover: async () => {recovered++; signedOut = false; return true;}});
  assert.equal(await x.screens.readInbox(true), page('peer-notices').inbox.length); assert.equal(recovered, 1); assert.equal(x.requests.length, 2, 'one refused read, one read after signing in');
  signedOut = true;
  await assert.rejects(x.screens.retry('0x9'), /signed this window out, so nothing was sent.*press the button once more/); assert.equal(posts, 1, 'the command is not sent a second time');
  const stuck = setup(t, PEER, {[`GET ${COLLAB}notices`]: () => {throw new ShipClientError('authenticationRequired', 401);}}, {recover: async () => false});
  await assert.rejects(stuck.screens.readInbox(true), e => e.code === 'authenticationRequired'); assert.equal(stuck.requests.length, 1);
});

test('new notices from owners are shown once and the mark is kept', async t => {
  const x = setup(t, PEER, {[`GET ${COLLAB}notices`]: page('peer-notices')}), all = page('peer-notices').inbox.length;
  assert.equal(await x.screens.readInbox(true), all); assert.equal(ED.shown.info.length, 1);
  assert.match(ED.shown.info[0], /^~zod (?:ended|started|queued|landed|took)/); assert.match(ED.shown.info[0], new RegExp(`and ${all - 4} more\\.$`));
  assert.equal(await x.screens.readInbox(true), 0); assert.equal(ED.shown.info.length, 1, 'quiet when nothing is new');
  assert.equal(await x.screens.readInbox(), 0); assert.equal(ED.shown.info.at(-1), 'No new notices from owners.');
  const none = setup(t, PEER, {[`GET ${COLLAB}notices`]: {schema: 'readymade-collab-notices-v1', available: false, error: 'notice-store-unavailable'}});
  assert.equal(await none.screens.readInbox(true), 0);
  // A notice made before the ones already shown, arriving after them, is shown once all the same.
  let arrived = false; const base = page('peer-notices'), late = {...base.inbox[0], id: '0xabc.0001', at: '~2026.11.16..01.00.00'};
  const z = setup(t, PEER, {[`GET ${COLLAB}notices`]: () => ({...base, inbox: arrived ? [...base.inbox, late] : base.inbox})});
  assert.equal(await z.screens.readInbox(true), all); arrived = true;
  assert.equal(await z.screens.readInbox(true), 1, 'older by its sender\'s clock, new to this computer'); assert.equal(await z.screens.readInbox(true), 0);
  // The mark belongs to the ship that read: another ship used from this same computer still sees its own notices.
  assert.deepEqual(x.writes, ['readymade.nativeNoticesSeen:~nec']);
  const other = setup(t, '~bud', {[`GET ${COLLAB}notices`]: JSON.parse(JSON.stringify(page('peer-notices')).replaceAll('~nec', '~bud'))});
  for (const [key, value] of x.state) other.state.set(key, value);
  assert.equal(await other.screens.readInbox(true), all, 'nothing of ~nec\'s mark hides ~bud\'s notices');
  // And a request one ship asked is not the other's to withdraw.
  other.state.set('readymade.workAsked:~nec', [{nonce: '0x7', owner: OWNER, project: DEMO, session: '0xe1b1.e811', text: 'Add a test.', at: 1_800_000_000_000, answer: 'queued'}]);
  assert.match(await other.screens.withdraw('0x7'), /no record of that request/); assert.equal(other.requests.filter(r => r.method === 'POST').length, 0);
});

test('following a session starts at the remembered sequence, and stopping closes it', async t => {
  const s = {owner: OWNER, project: DEMO, generation: '5', session: '0xe1b1.e811', inspection: '0xdf49.1c93', phase: 'paused'};
  let live = true;
  const stream = () => ({schema: 'readymade-session-streams-v1', peer: PEER, observedAt: '~2026.11.17..10.21.00', streams: [{owner: OWNER, session: s.session, project: DEMO, phase: live ? 'live' : 'ended', reason: live ? 'opening' : 'stopped',
    sequence: 19, reconnects: 0, opened: '~2026.11.17..10.19.27', updated: '~2026.11.17..10.20.30', status: {phase: 'paused', at: '~2026.11.17..10.20.30', source: 'pataphor-demo-mp-work/8'}}]});
  const x = setup(t, PEER, {[`POST ${COLLAB}session-stream`]: request => {live = request.body.action === 'open'; return {status: 202, value: {}};}, [`GET ${COLLAB}session-stream`]: () => stream()}, {sessions: [s]});
  assert.equal(await x.screens.follow(s), 'Following. Its status appears in the status bar.');
  assert.ok(!('cursor' in x.posts(COLLAB + 'session-stream')[0])); assert.equal(x.screens.followed[0].sequence, 19);
  assert.equal(x.writes.filter(k => k === 'readymade.sessionStreamCursors:~nec').length, 1, 'the cursor is written when it moves');
  assert.equal(await x.screens.unfollow(s), 'Stopped following.'); assert.equal(x.screens.followed[0].phase, 'ended');
  assert.equal(x.writes.filter(k => k === 'readymade.sessionStreamCursors:~nec').length, 1, 'and not again while it stays where it is');
  assert.equal(await x.screens.follow(s), 'Following again from sequence 19.'); assert.equal(x.posts(COLLAB + 'session-stream').at(-1).cursor, '19');
  await x.screens.unfollow(s);
  // A long-lived session: the listed generation is passed on as listed, and a sequence past 999 goes in the ship's form.
  const old = {...s, generation: '1.024'};
  const far = setup(t, PEER, {[`POST ${COLLAB}session-stream`]: {status: 202, value: {}}, [`GET ${COLLAB}session-stream`]: () => ({...stream(), streams: []})}, {sessions: [old]});
  far.state.set('readymade.sessionStreamCursors:~nec', {[`${OWNER}/${s.session}`]: 12345});
  assert.equal(await far.screens.follow(old), 'Following again from sequence 12345.');
  assert.deepEqual([far.posts(COLLAB + 'session-stream')[0].generation, far.posts(COLLAB + 'session-stream')[0].cursor], ['1.024', '12.345']);
});

test('a work request is sent once and the owner’s answer is read once', async t => {
  const s = {owner: OWNER, project: DEMO, session: '0xe1b1.e811'};
  let answer = 'refused';
  const queue = nonce => ({schema: 'readymade-work-queue-v1', ship: PEER, observedAt: '~2026.11.17..10.47.00', store: false, requests: [],
    asked: answer === 'none' ? [] : [{nonce, owner: OWNER, project: DEMO, session: s.session, status: answer, reason: answer === 'refused' ? 'poke-ack\n | %work-peer-limit\n' : '', at: '~2026.11.17..10.47.00'}]});
  let last;
  const x = setup(t, PEER, {[`POST ${COLLAB}work-request`]: request => {last = request.body.nonce; return {status: 202, value: {status: 'sent'}};}, [`GET ${COLLAB}work-queue`]: () => queue(last)});
  assert.deepEqual(await x.screens.ask(s, 'Add a test.').then(a => [a.said, a.refused]), ['~zod refused the request: work peer limit. You already have two open requests in this project. Wait for one to finish. Nothing was queued.', true]);
  answer = 'accepted'; assert.match((await x.screens.ask(s, 'Add a test.')).said, /^~zod queued your request 0x[0-9a-f.]+\. Progress arrives as notices\.$/);
  answer = 'none'; assert.match((await x.screens.ask(s, 'Add a test.')).said, /has not answered yet.*It will not be sent again\.$/);
  assert.equal(x.posts(COLLAB + 'work-request').length, 3); assert.equal(new Set(x.posts(COLLAB + 'work-request').map(b => b.nonce)).size, 3, 'each request has its own nonce');
  // Each request that left this computer is kept with its text and the owner's first answer, newest first.
  const kept = x.state.get('readymade.workAsked:~nec');
  assert.deepEqual(kept.map(a => [a.text, a.answer, a.reason]), [['Add a test.', 'unanswered', undefined], ['Add a test.', 'queued', undefined], ['Add a test.', 'refused', 'work-peer-limit']]);
  assert.deepEqual(kept.map(a => a.nonce), x.posts(COLLAB + 'work-request').map(b => b.nonce).reverse());
  const refused = setup(t, PEER, {[`POST ${COLLAB}work-request`]: {status: 409, value: {status: 'refused', message: 'work-request-reused'}}});
  assert.deepEqual(await refused.screens.ask(s, 'x').then(a => [a.said, a.refused]), ['Refused by the ship: work request reused. Nothing changed.', true]);
  assert.equal(refused.state.get('readymade.workAsked:~nec'), undefined, 'a request this ship itself refused never left, so nothing is kept');
  // A request whose answer was lost may have reached the owner: it is kept, said to be unknown, and not sent again.
  const lost = setup(t, PEER, {[`POST ${COLLAB}work-request`]: () => {throw new OutcomeUnknownError();}});
  const unknown = await lost.screens.ask(s, 'Add a test.');
  assert.match(unknown.said, /^The ship gave no answer this app could read, so it is unknown whether request 0x[0-9a-f.]+ was sent\. It is kept under Work Requests and was not sent again\.$/); assert.equal(unknown.refused, false);
  assert.deepEqual(lost.state.get('readymade.workAsked:~nec').map(a => [a.nonce, a.text, a.answer]), [[unknown.nonce, 'Add a test.', 'unknown']]);
  assert.equal(lost.posts(COLLAB + 'work-request').length, 1); assert.equal(lost.requests.length, 1, 'nothing else was asked of the ship');
});

test('an overview that could not be read keeps the owner’s rows and says why; a ship without the page shows none', async t => {
  let fail = true;
  const pages = {...ownerPages(), [`GET ${CODING}overview`]: () => {if (fail) throw new ShipClientError('transport'); return page('overview');}};
  const x = setup(t, OWNER, pages, {project: DEMO});
  x.screens.rows(); await x.screens.connected();   // the first draw notices the connection; the read after it is awaited here
  const rows = x.screens.rows(), overview = rows.find(r => r.id === 'native-overview'), labels = rows.find(r => r.id === 'native-pages').children.map(r => r.label);
  assert.ok(labels.includes('Tasks and Questions') && labels.includes('Standing Policy') && labels.includes('Session Roles'), 'one failed read does not take the owner’s screens away');
  assert.equal(overview.description, 'could not be read; open it to read again'); assert.match(overview.tooltip, /transport/); assert.equal(overview.children, undefined);
  fail = false; await x.screens.overview.show();
  assert.match(x.screens.rows().find(r => r.id === 'native-overview').description, /waiting on you|nothing waiting/);
  // A guest ship: the page is missing, or the ship says it hosts nothing. No owner rows, no reason to show.
  for (const answer of [undefined, {status: 404, value: {error: 'owner-pages-unavailable'}}]) {
    const guest = setup(t, PEER, answer ? {[`GET ${CODING}overview`]: answer} : {}, {project: DEMO});
    guest.screens.rows(); await guest.screens.connected();
    const seen = guest.screens.rows(); assert.deepEqual(seen.map(r => r.id), ['native-pages']); assert.ok(!seen[0].children.some(r => r.label === 'Tasks and Questions'));
  }
});
test('the badge and the tree never say nothing is waiting when the ship could not read every source', async t => {
  const partial = {...page('overview'), decisions: [], unavailable: ['tasks']};
  const x = setup(t, OWNER, {...ownerPages(), [`GET ${CODING}overview`]: partial}, {project: DEMO});
  x.screens.rows(); await x.screens.connected();   // the first draw notices the connection; the read after it is awaited here
  assert.equal(x.screens.rows().find(r => r.id === 'native-overview').description, 'incomplete: the ship could not read every part');
  const some = setup(t, OWNER, {...ownerPages(), [`GET ${CODING}overview`]: {...page('overview'), unavailable: ['tasks']}}, {project: DEMO});
  some.screens.rows(); await some.screens.connected();
  assert.match(some.screens.rows().find(r => r.id === 'native-overview').description, /^\d+ waiting on you \(incomplete\)$/);
});
test('a window whose sign-in is gone shows no rows instead of failing to draw the sidebar', async t => {
  let alive = true;
  const x = setup(t, OWNER, ownerPages(), {project: DEMO, shipNow: () => {if (!alive) throw new Error('no session cookie'); return OWNER;}});
  await x.screens.connected(); assert.ok(x.screens.rows().length > 0);
  alive = false; assert.deepEqual(x.screens.rows(), []); await assert.rejects(x.screens.withdraw('0x1'), /Connect your ship first/); assert.equal(x.posts(COLLAB + 'work-withdraw').length, 0);
});
test('a command the ship answered is never reported as failed when the read after it fails', async t => {
  const s = {owner: OWNER, project: DEMO, session: '0xe1b1.e811', generation: '1', inspection: '0xabc'};
  const down = () => {throw new ShipClientError('transport');};
  // Ask: the request left; only the read of the owner's answer failed.
  const ask = setup(t, PEER, {[`POST ${COLLAB}work-request`]: {status: 202, value: {status: 'sent'}}, [`GET ${COLLAB}work-queue`]: down});
  const asked = await ask.screens.ask(s, 'Add a test.');
  assert.match(asked.said, /^Request 0x[0-9a-f.]+ was sent, but ~zod's answer could not be read just now\. It is kept under Work Requests and will not be sent again\.$/); assert.equal(asked.refused, false);
  assert.equal(ask.posts(COLLAB + 'work-request').length, 1); assert.deepEqual(ask.state.get('readymade.workAsked:~nec').map(a => a.answer), ['unanswered']);
  // Withdraw: the same, and the journal entry is still there to read again from.
  const back = setup(t, PEER, {[`POST ${COLLAB}work-withdraw`]: {status: 202, value: {status: 'sent'}}, [`GET ${COLLAB}work-queue`]: down});
  back.state.set('readymade.workAsked:~nec', [{nonce: '0x1002', owner: OWNER, project: DEMO, session: s.session, text: 'x', at: 1, answer: 'queued'}]);
  assert.equal(await back.screens.withdraw('0x1002'), 'Asked ~zod to withdraw it, but the answer could not be read just now. It was not sent again; read the page again to see.');
  assert.equal(back.posts(COLLAB + 'work-withdraw').length, 1);
  // Follow and stop following: the ship's answer to the command is what is said.
  const watch = setup(t, PEER, {[`POST ${COLLAB}session-stream`]: {status: 202, value: {status: 'submitted'}}, [`GET ${COLLAB}session-stream`]: down});
  assert.match(await watch.screens.follow(s), /^Following\. Its status appears in the status bar\. The page could not be read again just now; nothing was sent twice\./);
  assert.match(await watch.screens.unfollow(s), /^Stopped following\. The page could not be read again just now/);
  assert.equal(watch.posts(COLLAB + 'session-stream').length, 2);
});
test('a request in flight when the window leaves its ship is still kept, under the ship that sent it', async t => {
  const s = {owner: OWNER, project: DEMO, session: '0xe1b1.e811'};
  let now = PEER;
  // The answer is lost and, by the time that is known, the window is on another ship.
  const moved = setup(t, PEER, {[`POST ${COLLAB}work-request`]: () => {now = '~bud'; throw new OutcomeUnknownError();}}, {shipNow: () => now});
  const said = await moved.screens.ask(s, 'Add a test.');
  assert.match(said.said, /unknown whether request/); assert.deepEqual([...moved.state.keys()], ['readymade.workAsked:~nec']);
  // The same when the window has no ship at all by then.
  now = PEER;
  const gone = setup(t, PEER, {[`POST ${COLLAB}work-request`]: () => {now = undefined; throw new OutcomeUnknownError();}}, {shipNow: () => now});
  assert.match((await gone.screens.ask(s, 'Add a test.')).said, /unknown whether request/); assert.deepEqual(gone.state.get('readymade.workAsked:~nec').map(a => a.answer), ['unknown']);
  // With no ship before sending, nothing is sent.
  const none = setup(t, PEER, {[`POST ${COLLAB}work-request`]: {status: 202, value: {status: 'sent'}}}, {shipNow: () => undefined});
  await assert.rejects(none.screens.ask(s, 'x'), /Connect your ship first/); assert.equal(none.requests.length, 0);
});
test('an open screen is read again when the connection changes, so no button from one ship is pressed against another', async t => {
  const moved = {};
  const x = setup(t, OWNER, ownerPages(), moved);
  x.screens.rows(); await x.screens.tasks.show();
  assert.ok(x.screens.tasks.shown.sections.some(s => s.lines.some(l => l.action)), 'the screen offers actions built from this ship\'s page');
  const reads = () => x.requests.filter(r => r.path === CODING + 'tasks').length, before = reads();
  moved.disconnected = true; x.screens.rows(); await new Promise(r => setTimeout(r, 20));
  assert.equal(x.screens.tasks.shown.status, 'Connect your ship first.'); assert.deepEqual(x.screens.tasks.shown.sections, [], 'nothing of the last ship is left to press');
  moved.disconnected = false; x.screens.rows(); await new Promise(r => setTimeout(r, 20));
  assert.equal(reads(), before + 1, 'read once from the ship connected now'); assert.ok(x.screens.tasks.shown.sections.length > 0);
  // A screen that is not open reads nothing.
  const y = setup(t, OWNER, ownerPages(), {}); y.screens.rows(); await new Promise(r => setTimeout(r, 20));
  assert.equal(y.requests.filter(r => r.path === CODING + 'tasks').length, 0);
});

test('an answer that arrives after the window moved to another ship is dropped', async t => {
  let release; const slow = new Promise(resolve => {release = resolve;});
  const moved = {};
  const x = setup(t, OWNER, {...ownerPages(), [`GET ${CODING}overview`]: async () => {await slow; return page('overview');}}, moved);
  const reading = x.screens.connected();
  await new Promise(r => setTimeout(r, 10)); const before = x.changes();
  // The window leaves that ship while its overview is still on the way; the answer then arrives.
  moved.disconnected = true; release(); await reading;
  assert.equal(x.changes(), before, 'a late answer from the ship that was left is not taken and announces nothing');
  // The same read on a connection that stayed is taken: the check above is not passing by accident.
  const y = setup(t, OWNER, ownerPages()); const first = y.changes(); await y.screens.connected(); assert.ok(y.changes() > first);
});

test('the work screen counts admissions from the policy and its own queue, without the heavy overview read', async t => {
  const policy = page('policy'), queue = page('owner-work'), version = Math.max(...policy.versions.map(v => v.version));
  const used = queue.requests.filter(w => w.policyVersion === version).length, left = Math.max(0, policy.inForce.resources.maxAdmissions - used);
  const x = setup(t, OWNER, {[`GET ${COLLAB}work-queue`]: queue, [`GET ${CODING}policy.json`]: policy, [`GET ${COLLAB}notices`]: page('owner-notices'), [`GET ${CODING}overview`]: page('overview')});
  await x.screens.work.show();
  assert.match(x.screens.work.shown.note, new RegExp(`Your policy has ${left} admissions? left\\.`));
  assert.ok(!x.requests.some(r => r.path === CODING + 'overview'), 'the overview is not read for this');
  const guest = setup(t, PEER, {[`GET ${COLLAB}work-queue`]: page('peer-work')}); await guest.screens.work.show();
  assert.ok(!/admissions? left/.test(guest.screens.work.shown.note), 'a ship without a policy store says nothing about admissions');
});
test('notices that could not be read are unknown progress with nothing to withdraw, never “no progress”', async t => {
  const queued = [{nonce: '0x1003', owner: OWNER, project: DEMO, session: '0xe1b1.e811', text: 'Add a test.', at: 1, answer: 'queued'}];
  let down = false;
  const x = setup(t, PEER, {[`GET ${COLLAB}work-queue`]: page('peer-work'), [`GET ${COLLAB}notices`]: () => {if (down) throw new ShipClientError('transport'); return {...page('peer-notices'), inbox: []};}});
  x.state.set('readymade.workAsked:~nec', queued);
  await x.screens.work.show();
  let line = x.screens.work.shown.sections[1].lines[0];
  assert.match(line.detail, /^Queued; no progress has been reported yet\./); assert.equal(line.action?.id, 'withdraw:0x1003', 'readable and nothing told: queued, and it can be withdrawn');
  down = true; await x.screens.work.show(); line = x.screens.work.shown.sections[1].lines[0];
  assert.match(line.detail, /^Progress unknown: the notices could not be read just now\./); assert.equal(line.action, undefined);
  assert.match(x.screens.work.shown.note, /notices could not be read just now.*Read again\./);
  // One row this app cannot take in the second read does not make the whole screen unreadable either.
  const odd = setup(t, PEER, {[`GET ${COLLAB}work-queue`]: page('peer-work'), [`GET ${COLLAB}notices`]: {...page('peer-notices'), inbox: [{kind: 7}]}, [`GET ${CODING}policy.json`]: {schema: 'standing-policy-v1', versions: 'x'}});
  odd.state.set('readymade.workAsked:~nec', queued);
  await odd.screens.work.show(); assert.equal(odd.screens.work.shown.title, 'Work Requests'); assert.match(odd.screens.work.shown.sections[1].lines[0].detail, /^Progress unknown/);
});

test('dismissing and withdrawing: sent once, and the answer is what the ship said', async t => {
  const owner = setup(t, OWNER, {[`POST ${COLLAB}work-dismiss`]: request => request.body.id === '0x1' ? {status: 409, value: {status: 'refused', message: 'work-request-started'}} : {status: 202, value: {status: 'dismissed'}}});
  assert.equal(await owner.screens.dismiss('0x2'), 'Dismissed. Its requester is told, and nothing runs.');
  assert.equal(await owner.screens.dismiss('0x1'), 'Refused by the ship: work request started. It has already started or ended, so it cannot be removed. Nothing changed.');
  // Every confirmation names the ship it will act on; without a yes, nothing is sent.
  const sentBefore = owner.requests.length;
  assert.equal(await owner.screens.endWork('dismiss:0x3'), 'Nothing changed.'); assert.equal(await owner.screens.changePolicy('revoke'), 'Nothing changed.');
  assert.equal(await owner.screens.answerQuestion('dismiss-proposal:0x4'), 'Nothing changed.'); assert.equal(await owner.screens.retryNotice('retry:0x5'), 'Nothing was sent.');
  assert.equal(await owner.screens.endWork('withdraw:0x6'), 'Nothing changed.');
  assert.deepEqual(ED.shown.warn, ['Dismiss this request on ~zod?', 'Revoke the standing policy on ~zod?', 'Dismiss this proposal on ~zod?', 'Send this notice again from ~zod?', 'Withdraw this request, as ~zod?']);
  assert.equal(owner.requests.length, sentBefore);
  let answer = 'withdrawn';
  const queue = () => ({schema: 'readymade-work-queue-v1', ship: PEER, observedAt: '~2026.11.17..14.00.00', store: false, requests: [], asked: [],
    withdrawRefused: answer === 'refused' ? [{nonce: '0x7', reason: 'poke-ack\n | %work-request-started\n', at: '~2026.11.17..14.00.00'}] : []});
  const notices = () => ({schema: 'readymade-collab-notices-v1', available: true, ship: PEER, observedAt: '~2026.11.17..14.00.01', capacity: 512, outbox: [],
    inbox: answer === 'withdrawn' ? [{id: '0x99', from: OWNER, to: PEER, project: DEMO, kind: 'work-finished', subject: '0x7', at: '~2026.11.17..14.00.00', detail: 'Withdrawn before it started. Nothing ran.'}] : []});
  const x = setup(t, PEER, {[`POST ${COLLAB}work-withdraw`]: {status: 202, value: {status: 'sent'}}, [`GET ${COLLAB}work-queue`]: () => queue(), [`GET ${COLLAB}notices`]: () => notices()});
  assert.match(await x.screens.withdraw('0x7'), /no record of that request/); assert.equal(x.posts(COLLAB + 'work-withdraw').length, 0, 'nothing is sent for a request this computer never made');
  x.state.set('readymade.workAsked:~nec', [{nonce: '0x7', owner: OWNER, project: DEMO, session: '0xe1b1.e811', text: 'Add a test.', at: 1_800_000_000_000, answer: 'queued'}]);
  assert.equal(await x.screens.withdraw('0x7'), '~zod withdrew your request. Nothing ran.');
  assert.deepEqual(x.posts(COLLAB + 'work-withdraw')[0], {schema: 'readymade-work-withdraw-v1', owner: OWNER, nonce: '0x7', project: DEMO, session: '0xe1b1.e811'});
  answer = 'refused'; assert.equal(await x.screens.withdraw('0x7'), '~zod did not withdraw it: work request started. It has already started or ended, so it cannot be removed.');
  answer = 'none'; assert.match(await x.screens.withdraw('0x7'), /has not answered yet\. Read the page again to see\.$/);
});

test('the handoff is one document that names the returning agent’s account', async t => {
  const x = setup(t, OWNER, {[`GET ${CODING}memory`]: page('memory-handoff')});
  const text = await x.screens.handoffText('claude', 'readymade notices');
  assert.match(text, /^# Handoff from ~zod/); assert.equal(x.requests[0].path, CODING + 'memory?view=handoff&bytes=12000&who=claude&topic=readymade+notices');
  // "Everything recent, the last day": the account starts a day ago, in the ship's own form for a moment.
  const before = Date.now(); await x.screens.handoffText('', '');
  const asked = /^\/apps\/pataphor-native\/coding\/memory\?view=handoff&bytes=12000&since=~(\d{4})\.(\d{1,2})\.(\d{1,2})\.\.(\d\d)\.(\d\d)\.(\d\d)$/.exec(x.requests[1].path);
  assert.ok(asked, x.requests[1].path);
  const [y, mo, d, h, mi, sec] = asked.slice(1).map(Number), since = Date.UTC(y, mo - 1, d, h, mi, sec);
  assert.ok(Math.abs(before - 86_400_000 - since) < 5000, 'one day before now');
});
test('an older stream answer that arrives late does not move a cursor back, and nothing polls after the screens close', async t => {
  const s = {owner: OWNER, project: DEMO, generation: '5', session: '0xe1b1.e811', inspection: '0xdf49.1c93'};
  const stream = sequence => ({schema: 'readymade-session-streams-v1', peer: PEER, observedAt: '~2026.11.17..10.21.00', streams: [{owner: OWNER, session: s.session, project: DEMO, phase: 'live', reason: 'opening',
    sequence, reconnects: 0, opened: '~2026.11.17..10.19.27', updated: '~2026.11.17..10.20.30', status: {phase: 'paused', at: '~2026.11.17..10.20.30', source: 'pataphor-demo-mp-work/8'}}]});
  const waiting = [];
  const x = setup(t, PEER, {[`POST ${COLLAB}session-stream`]: {status: 202, value: {}}, [`GET ${COLLAB}session-stream`]: () => new Promise(r => {waiting.push(r);})}, {sessions: [s]});
  // Two reads overlap; the newer one is answered first with sequence 21, then the older one with 19.
  const first = x.screens.follow(s); await new Promise(r => setTimeout(r, 5));
  const second = x.screens.unfollow(s); await new Promise(r => setTimeout(r, 5));
  assert.equal(waiting.length, 2);
  waiting[1](stream(21)); await second; waiting[0](stream(19)); await first;
  assert.equal(x.screens.followed[0].sequence, 21); assert.equal(x.state.get('readymade.sessionStreamCursors:~nec')[`${OWNER}/${s.session}`], 21);
  // A read still out when the screens are closed is dropped: no poll starts afterwards.
  const closing = x.screens.unfollow(s); await new Promise(r => setTimeout(r, 5)); const reads = x.requests.length;
  x.screens.dispose(); waiting.at(-1)(stream(22)); await closing; await new Promise(r => setTimeout(r, 30));
  assert.equal(x.screens.followed[0].sequence, 21); assert.equal(x.requests.length, reads);
});

test('a report panel reads again on request, routes one action at a time, and drops a read that was overtaken', async () => {
  ED.panels.length = 0;
  let reads = 0, release; const acted = [];
  const panel = new ReportPanel('readymade.test', 'Test', async () => {reads++; if (reads === 2) await new Promise(r => {release = r;}); return {title: 'Test', status: `read ${reads}`, sections: []};},
    async id => {acted.push(id); return 'Done.';});
  // The webview's message callback returns nothing, so each step waits a moment for the panel to settle.
  const settle = () => new Promise(r => setTimeout(r, 15));
  await panel.show(); const view = ED.panels[0];
  assert.equal(panel.shown.status, 'read 1'); assert.match(view.webview.html, /read 1/);
  view.receive({action: 'bad action'}); view.receive({action: 'again', extra: 1}); view.receive('again'); await settle(); assert.equal(reads, 1, 'anything but one exact action is ignored');
  view.receive({action: 'again'}); await settle(); assert.equal(reads, 2); assert.match(view.webview.html, /disabled/, 'buttons are off while reading');
  view.receive({action: 'answer:0x1'}); await settle(); assert.deepEqual(acted, [], 'no action while a read is in progress');
  release(); await settle(); assert.equal(panel.shown.status, 'read 2');
  view.receive({action: 'answer:0x1'}); await settle(); assert.deepEqual(acted, ['answer:0x1']); assert.equal(panel.shown.note, 'Done.'); assert.equal(reads, 3);
  const failing = new ReportPanel('readymade.test2', 'Broken', async () => {throw new Error('The ship did not answer this page: owner-pages-unavailable');});
  await failing.show(); assert.equal(failing.shown.status, 'The ship did not answer this page: owner-pages-unavailable'); assert.deepEqual(failing.shown.sections, []);
  panel.dispose(); failing.dispose();
});
test('showing a screen again while its action is in flight does not switch the buttons back on', async () => {
  ED.panels.length = 0;
  let finish; const started = [];
  const panel = new ReportPanel('readymade.test3', 'Slow', async () => ({title: 'Slow', status: 'read', sections: [{title: 'One', lines: [{text: 'a request', action: {id: 'withdraw:0x1', label: 'Withdraw'}}]}]}),
    id => {started.push(id); return new Promise(r => {finish = r;});});
  const settle = () => new Promise(r => setTimeout(r, 15));
  await panel.show(); const view = ED.panels[0];
  assert.doesNotMatch(view.webview.html, /<button[^>]*disabled/, 'ready: the buttons are on');
  view.receive({action: 'withdraw:0x1'}); await settle(); assert.deepEqual(started, ['withdraw:0x1']); assert.match(view.webview.html, /<button[^>]*disabled/);
  // The person clicks the screen's row in the sidebar: it is read again while the withdrawal is still out.
  await panel.show(); assert.match(view.webview.html, /<button[^>]*disabled/, 'still off: the action has not come back');
  view.receive({action: 'withdraw:0x1'}); await settle(); assert.deepEqual(started, ['withdraw:0x1'], 'and a second press sends nothing');
  finish('Withdrawn.'); await settle(); assert.equal(panel.shown.note, 'Withdrawn.'); assert.doesNotMatch(view.webview.html, /<button[^>]*disabled/);
  panel.dispose();
});
