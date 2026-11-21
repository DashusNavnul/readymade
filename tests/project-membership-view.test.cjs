// The real invitation view and the real invitation journal, on an empty profile, against a ship and an owner that
// exist only in this file. Nothing here opens a socket or an editor.
const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const original = Module._load, ui = {window: {}};
let ProjectInvitationsView, InvitationJournal, ShipClientError;
try {
  Module._load = function(name, ...args) {return name === 'vscode' ? ui : original.call(this, name, ...args);};
  ({ProjectInvitationsView} = require('../dist/src/project-invitations-view'));
  ({InvitationJournal} = require('../dist/src/project-invitation-journal'));
  ({ShipClientError} = require('../dist/src/ship-client'));
} finally {Module._load = original;}

const uuid = n => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const outcomes = {join: 'project-joined', leave: 'project-left'};
const row = (n, operation = 'join', status = 'accepted', authority = '~wes', project = 'demo') => ({schema: 'readymade-project-invitation-result-v1', request: uuid(n), authority, project, operation,
  digest: '0x456', status, permissionGranted: false, outcome: status === 'accepted' ? outcomes[operation] : status === 'refused' ? 'native-refused' : null});
const held = {deadline: '~2026.11.20..22.42.33', retainedUntil: '~2026.11.20..22.47.33'};
/**
 * One ship as the desktop sees it. `requests` is the ship's own request list; `owners` says how each owner answers
 * the membership read ('ready', 'refused', 'uncertain', or a function returning a promise of one of those).
 */
function ship(actor, requests, owners, origin = 'https://' + actor.slice(1) + '.example') {
  const sent = [], asked = [], listed = [];
  let lists = 0;
  return {origin, sent, asked, listed, requests, snapshot: undefined,
    browserCookies: () => [{name: 'urbauth-' + actor, value: 'fixture'}],
    projectInvitation: async (operation, value) => {
      if (operation === 'requests') {
        listed.push({...value});
        if (owners.holdList) await owners.holdList;
        if (requests === undefined) return {status: 404, body: {status: 'missing', message: 'no such route'}};
        return {status: 200, body: {schema: 'readymade-project-invitation-catalog-v1', owner: actor, permissionGranted: false, catalog: '0x9', offset: 0, total: requests.length, next: null, requests: [...requests]}};
      }
      if (operation === 'submit') {
        sent.push(value);
        const settled = {schema: 'readymade-project-invitation-result-v1', request: value.request, authority: value.authority, project: value.project, operation: value.operation,
          digest: '0x789', status: 'accepted', permissionGranted: false, outcome: outcomes[value.operation]};
        requests.push(settled); return {status: 200, body: settled};
      }
      const found = requests.find(r => r.request === value.request);
      return found ? {status: 200, body: found} : {status: 404, body: {status: 'missing', message: 'No retained invitation command.'}};
    },
    projectSessionsSubmit: async (owner, project) => {
      asked.push(owner + '/' + project);
      if (owners[owner + '/' + project] === 'busy') throw new ShipClientError('commandBusy');
      return {owner, project, request: '0x' + (++lists).toString(16), peer: actor, permissionGranted: false, status: 'pending', reason: 'awaiting-owner', ...held, observation: null};
    },
    projectSessionsResult: async (owner, project, request) => {
      const how = owners[owner + '/' + project], status = typeof how === 'function' ? await how() : how;
      const base = {owner, project, request, peer: actor, permissionGranted: false, ...held};
      if (status === 'ready') return {...base, status, reason: 'observed', observation: {owner, peer: actor, observedAt: '~2026.11.20..22.42.03..2cbc', truncated: false, sessions: []}};
      return {...base, status, reason: status === 'refused' ? 'watch-refused' : 'sessions-timeout', observation: null};
    }};
}
/** A view over an empty profile (a new, private invitation folder), connected to `first`. */
function fresh(first, confirm = async () => true, directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-joined-'))) {
  const journal = new InvitationJournal(directory);
  const state = {client: first, confirmed: 0};
  const steps = {confirm: async (...args) => {state.confirmed++; return confirm(...args);}, progress: (_title, work) => work(), pause: async () => undefined, pollMs: 1, deadlineMs: 1000};
  const view = new ProjectInvitationsView('readymade.test', () => state.client, () => undefined, async () => state.client, journal, () => undefined, steps);
  return {view, journal, state, directory, done: () => {view.dispose(); fs.rmSync(directory, {recursive: true, force: true});}};
}
const children = view => view.rows()[0].children;
const named = (view, label) => children(view).find(r => r.label === label);
const commands = rowsOf => rowsOf.flatMap(r => [r.command?.command, ...commands(r.children ?? [])]).filter(Boolean);

test('an empty profile shows a project its owner confirms, and Leave sends one leave and never a join', async () => {
  const nec = ship('~nec', [row(1)], {'~wes/demo': 'ready'}), t = fresh(nec);
  try {
    assert.deepEqual(t.journal.entries(), []);
    // Before anything is read: no project, no Leave, and the palette command finds nothing in the profile.
    assert.equal(named(t.view, 'demo'), undefined);
    await t.view.discover();
    const shown = named(t.view, 'demo');
    assert.equal(shown.description, '~wes · member'); assert.match(shown.tooltip, /~wes confirmed this ship as a member at 2026-11-20 22:42 UTC/);
    assert.deepEqual(shown.children.map(r => r.label), ['Joined — ask owner for shared files', 'Leave Project…']);
    assert.deepEqual(shown.children[1].command, {command: 'readymade.leaveProject', title: 'Leave Project', arguments: [{authority: '~wes', project: 'demo'}]});
    assert.deepEqual(nec.listed, [{}]); assert.deepEqual(nec.asked, ['~wes/demo']);
    // Membership is not file access: no row opens files or sessions, and nothing was written or sent.
    assert.deepEqual(commands(children(t.view)).filter(c => !['readymade.joinProject', 'readymade.removeCollaborationService', 'readymade.leaveProject', 'readymade.refreshJoinedProjects'].includes(c)), []);
    assert.deepEqual(t.journal.entries(), []); assert.deepEqual(nec.sent, []);
    // The palette command, with nothing named, finds the one membership and asks before sending.
    await t.view.leave();
    await t.view.discovering;
    assert.equal(t.state.confirmed, 1);
    assert.equal(nec.sent.length, 1);
    assert.deepEqual({...nec.sent[0], request: undefined}, {request: undefined, authority: '~wes', project: 'demo', operation: 'leave'});
    // The leave is this profile's own new request; the old join was not copied into the profile and cannot be sent from it.
    assert.deepEqual(t.journal.entries().map(i => i.command.operation), ['leave']);
    assert.equal(nec.sent.filter(c => c.operation === 'join').length, 0);
  } finally {t.done();}
});

test('declining the question sends nothing, and a leave is confirmed by asking the owner again', async () => {
  const owners = {'~wes/demo': 'ready'}, nec = ship('~nec', [row(1)], owners);
  let answer = false; const t = fresh(nec, async () => answer);
  try {
    await t.view.discover();
    await t.view.leave({authority: '~wes', project: 'demo'});
    assert.deepEqual(nec.sent, []); assert.deepEqual(t.journal.entries(), []);
    answer = true; owners['~wes/demo'] = 'refused';   // After the leave the owner no longer answers this ship as a member.
    await t.view.leave({authority: '~wes', project: 'demo'});
    await t.view.discovering;
    assert.equal(nec.sent.length, 1);
    // The owner was asked again: the membership row is gone, no Leave is offered for it, and a second Leave is refused unsent.
    assert.deepEqual(nec.asked, ['~wes/demo', '~wes/demo']);
    assert.equal(children(t.view).filter(r => r.description === '~wes · member').length, 0);
    assert.equal(named(t.view, 'demo').description, '~wes · not confirmed by the owner’s ship');
    await assert.rejects(t.view.leave({authority: '~wes', project: 'demo'}), /Refresh joined projects first/);
    await assert.rejects(t.view.leave(), /No owner confirmed this ship as a member now \(1 not confirmed\)/);
    assert.equal(nec.sent.length, 1);
  } finally {t.done();}
});

test('refusal, silence, an unfinished join and an unreadable list never read as membership, nor as "joined nothing"', async () => {
  const requests = [row(1, 'join', 'accepted', '~wes', 'left'), row(2, 'leave', 'accepted', '~wes', 'left'), row(3, 'join', 'accepted', '~bud', 'quiet'),
    row(4, 'join', 'refused', '~bud', 'refused'), row(5, 'join', 'unknown', '~bud', 'lost'), row(9, 'join', 'accepted', '~bud', 'open'), row(6, 'join', 'accepted', '~wes', 'again'), row(7, 'leave', 'accepted', '~wes', 'again'), row(8, 'join', 'accepted', '~wes', 'again')];
  const nec = ship('~nec', requests, {'~wes/left': 'refused', '~bud/quiet': 'uncertain', '~bud/lost': 'ready', '~wes/again': 'ready', '~bud/open': 'busy'}), t = fresh(nec);
  try {
    await t.view.discover();
    const say = label => named(t.view, label)?.description;
    // An accepted leave is respected because the owner says so, not because of the order of rows.
    assert.equal(say('left'), '~wes · not confirmed by the owner’s ship');
    assert.equal(say('quiet'), '~bud · the owner’s ship did not answer');
    assert.equal(say('refused'), undefined); assert.deepEqual(nec.asked.includes('~bud/refused'), false);
    // A join whose result this ship never learned: the owner holds the truth, and here the owner says member.
    assert.equal(say('lost'), '~bud · member');
    assert.equal(say('again'), '~wes · member');
    // A check this connection could not start is said as that, with no Leave.
    assert.equal(say('open'), '~bud · not asked just now'); assert.match(named(t.view, 'open').tooltip, /still holding earlier checks.*Refresh joined projects in a few minutes/);
    for (const label of ['left', 'quiet', 'open']) {
      assert.deepEqual(named(t.view, label).children.map(r => r.label), ['Check Again']);
      await assert.rejects(t.view.leave({authority: named(t.view, label).description.split(' ')[0], project: label}), /Refresh joined projects first/);
    }
    assert.deepEqual(nec.sent, []);
    // With several memberships the palette command asks which; a dismissed question sends nothing.
    let offered; ui.window.showQuickPick = async items => {offered = items; return undefined;};
    await t.view.leave();
    assert.deepEqual(offered.map(i => i.label).sort(), ['again', 'lost']); assert.deepEqual(nec.sent, []);
  } finally {t.done();}
  // A ship whose service cannot list its requests: said so, with a way to try again, and the palette command says why.
  const old = ship('~nec', undefined, {}), u = fresh(old);
  try {
    await u.view.discover();
    const shown = named(u.view, 'Joined projects could not be read');
    assert.equal(shown.description, 'nothing assumed'); assert.match(shown.children[0].label, /does not list its requests\. Update it/);
    assert.equal(shown.children[1].command.command, 'readymade.refreshJoinedProjects');
    await assert.rejects(u.view.leave(), /Joined projects could not be read from your ship\. This ship’s collaboration service does not list its requests/);
    assert.deepEqual(old.asked, []); assert.deepEqual(old.sent, []);
  } finally {u.done();}
});

test('a connection that changes while an owner is being asked gets nothing from the old read', async () => {
  let answer; const waiting = new Promise(resolve => {answer = resolve;});
  const nec = ship('~nec', [row(1)], {'~wes/demo': () => waiting}), bud = ship('~bud', [row(2, 'join', 'accepted', '~wes', 'other')], {'~wes/other': 'refused'});
  const t = fresh(nec);
  try {
    const first = t.view.discover();
    while (!nec.asked.length) await new Promise(resolve => setImmediate(resolve));
    t.state.client = bud;                       // Another ship is connected while ~wes has not answered ~nec yet.
    const second = t.view.discover();
    answer('ready'); await first; await second;
    // ~nec's membership of demo is not shown for ~bud, and cannot be left from ~bud's connection.
    assert.equal(named(t.view, 'demo'), undefined);
    assert.equal(named(t.view, 'other').description, '~wes · not confirmed by the owner’s ship');
    await assert.rejects(t.view.leave({authority: '~wes', project: 'demo'}), /Refresh joined projects first/);
    assert.deepEqual(bud.asked, ['~wes/other']); assert.deepEqual(nec.sent, []); assert.deepEqual(bud.sent, []);
    // Back on ~nec before anything is read again: what was read for ~bud is not shown for ~nec, and cannot be acted on.
    t.state.client = nec;
    assert.equal(named(t.view, 'demo'), undefined); assert.equal(named(t.view, 'other'), undefined);
    assert.equal(named(t.view, 'Refresh Joined Projects').command.command, 'readymade.refreshJoinedProjects');
    await assert.rejects(t.view.leave({authority: '~wes', project: 'other'}), /Refresh joined projects first/);
    assert.deepEqual(nec.sent, []); assert.deepEqual(bud.sent, []);
  } finally {t.done();}
});

test('a profile that holds the join offers one Leave, and a leave the ship already sent is not sent again', async () => {
  const nec = ship('~nec', [row(1)], {'~wes/demo': 'ready'}), t = fresh(nec);
  try {
    // This profile made the join itself: its own row offers Leave, and the row read from the ships is not added beside it.
    const join = {request: uuid(1), authority: '~wes', project: 'demo', operation: 'join', invitation: '0x123'};
    const quiet = {...nec, projectInvitation: async (operation, value) => operation === 'submit' ? {status: 200, body: nec.requests[0]} : nec.projectInvitation(operation, value)};
    await t.journal.submit(quiet, {version: 1, origin: nec.origin, actor: '~nec', command: join}, true);
    await t.view.observeRetained(); await t.view.discover();
    const leaves = commands(children(t.view)).filter(c => c === 'readymade.leaveProject');
    assert.equal(leaves.length, 1);
    assert.deepEqual(children(t.view).filter(r => r.label === 'demo').map(r => r.description), ['join · accepted']);
  } finally {t.done();}
  // Another computer already sent a leave that the ship has no answer for: said so, and Leave is refused unsent.
  const away = ship('~nec', [row(1), row(2, 'leave', 'submitted')], {'~wes/demo': 'ready'}), u = fresh(away);
  try {
    await u.view.discover();
    assert.deepEqual(named(u.view, 'demo').children.map(r => r.label), ['Joined — ask owner for shared files', 'Leave sent — no answer yet']);
    await assert.rejects(u.view.leave({authority: '~wes', project: 'demo'}), /already sent a leave for this project and has no answer yet/);
    assert.deepEqual(away.sent, []); assert.equal(u.state.confirmed, 0);
  } finally {u.done();}
});

test('a request recorded here that the ship never received is said as that, and is put aside without sending so it can be made again', async t => {
  const nec = ship('~nec', [], {}), first = fresh(nec);
  t.after(() => first.done());
  ui.window.showInformationMessage = () => undefined;
  const join = {request: uuid(7), authority: '~wes', project: 'demo', operation: 'join', invitation: '0x123'}, intent = {version: 1, origin: nec.origin, actor: '~nec', command: join};
  // Readymade records the join and stops before the ship has it.
  const stopping = {...nec, projectInvitation: async (operation, value) => {if (operation === 'submit') throw new Error('process ended'); return nec.projectInvitation(operation, value);}};
  await assert.rejects(first.journal.submit(stopping, intent, true), /process ended/);
  // Reopened: the ship is read, has no such request, and the row says so with the way out. The same join cannot simply be sent again.
  const t2 = fresh(nec, async () => true, first.directory);
  await t2.view.observeRetained();
  const shown = children(t2.view).find(r => r.label === 'demo');
  assert.equal(shown.description, 'join · not held by your ship'); assert.match(shown.tooltip, /no record of this request: it never received it, or it settled so long ago that the ship has forgotten it\. Nothing is waiting to be sent/);
  assert.deepEqual(shown.children.map(r => r.label), ['Check Result', 'Put This Request Aside']);
  await assert.rejects(t2.journal.submit(nec, {...intent, command: {...join, request: uuid(8)}}, true), /it will not be sent again\. If your ship does not hold it, put it aside/);
  // Written a moment ago, it may still be arriving: it is left alone. Nothing was sent by asking.
  await assert.rejects(t2.view.retire(join.request), /recorded less than a minute ago and may still be on its way/);
  assert.equal(t2.journal.entries().length, 1); assert.deepEqual(nec.sent, []);
  const later = t2.journal.retire.bind(t2.journal); t2.journal.retire = (client, held) => later(client, held, Date.now() + 120000);
  // The ship cannot be read: nothing changes. The ship holds it after all: it is not put aside.
  const down = {...nec, projectInvitation: async () => ({status: 503, body: {status: 'unavailable', message: 'x'}})}, was = t2.state.client;
  t2.state.client = down; await assert.rejects(t2.view.retire(join.request), /Your ship could not be read\. Nothing was changed/); t2.state.client = was;
  nec.requests.push(row(7, 'join', 'submitted')); await assert.rejects(t2.view.retire(join.request), /Your ship holds this request after all/); nec.requests.pop();
  assert.equal(t2.journal.entries().length, 1);
  // Put aside: kept in history byte for byte, gone from the open requests, and not one command was sent.
  const file = fs.readdirSync(first.directory).find(n => n.endsWith('.intent.json')), bytes = fs.readFileSync(path.join(first.directory, file));
  await t2.view.retire(join.request);
  assert.deepEqual(t2.journal.entries(), []); assert.equal(children(t2.view).some(r => r.label === 'demo'), false);
  const kept = fs.readdirSync(path.join(first.directory, 'history'));
  assert.equal(kept.length, 1); assert.equal(kept[0].includes(join.request), true); assert.deepEqual(fs.readFileSync(path.join(first.directory, 'history', kept[0])), bytes);
  assert.equal(fs.statSync(path.join(first.directory, 'history')).mode & 0o777, 0o700); assert.deepEqual(nec.sent, []);
  await assert.rejects(t2.view.retire(join.request), /No retained invitation request belongs to this connection/);
  // The same join is made again as a new request, once.
  const again = await t2.journal.submit(nec, {...intent, command: {...join, request: uuid(8)}}, true);
  assert.equal(again.status, 'accepted'); assert.equal(nec.sent.length, 1); assert.equal(nec.sent[0].request, uuid(8));
});

test('a request the ship refused before recording keeps the ship\'s reason, and a request the ship holds is never put aside', async t => {
  const nec = ship('~nec', [], {}), x = fresh(nec);
  t.after(() => x.done());
  const leave = {request: uuid(9), authority: '~wes', project: 'demo', operation: 'leave'}, intent = {version: 1, origin: nec.origin, actor: '~nec', command: leave};
  const refusing = {...nec, projectInvitation: async (operation, value) => operation === 'submit' ? {status: 409, body: {status: 'refused', message: 'action-retained'}} : nec.projectInvitation(operation, value)};
  const refused = await x.journal.submit(refusing, intent, true);
  assert.equal(refused.status, 'unconfirmed'); assert.equal(refused.reason, 'action-retained');
  const {invitationStanding} = require('../dist/src/project-invitations-view');
  assert.equal(invitationStanding('unconfirmed', 'action-retained').words, 'not recorded by your ship (action-retained)');
  assert.deepEqual(['accepted', 'refused', 'prepared', 'submitted', 'unknown', undefined].map(status => invitationStanding(status).words),
    ['accepted', 'refused', 'waiting to reach the owner', 'sent — no answer yet', 'sent — outcome not known', 'not read yet — check result']);
  for (const status of ['prepared', 'submitted', 'unknown']) assert.doesNotMatch(invitationStanding(status).words + invitationStanding(status).tooltip, /failed|refused|not sent/i);
});

test('an action pressed while joined projects are being read waits for that read and then runs; the background read never takes its place', async t => {
  let release; const owners = {'~wes/demo': 'ready', holdList: new Promise(resolve => {release = resolve;})};
  const nec = ship('~nec', [row(1)], owners), x = fresh(nec);
  t.after(() => x.done());
  // This profile holds the join itself, so its row has a Check Result.
  const join = {request: uuid(1), authority: '~wes', project: 'demo', operation: 'join', invitation: '0x123'};
  await x.journal.submit({...nec, projectInvitation: async (operation, value) => operation === 'submit' ? {status: 200, body: nec.requests[0]} : nec.projectInvitation(operation, value)},
    {version: 1, origin: nec.origin, actor: '~nec', command: join}, true);
  const pass = x.view.discover();
  while (!nec.listed.length) await new Promise(resolve => setImmediate(resolve));
  // The request list is being read. Check Result is pressed now, and so is a second one right after the first.
  const pressed = x.view.check(join.request);
  release(); await pressed;
  assert.equal(children(x.view).find(r => r.label === 'demo').description, 'join · accepted');
  await x.view.check(join.request); await pass;
  assert.deepEqual(nec.asked, ['~wes/demo']); assert.deepEqual(nec.sent, []);
});

test('with more joined projects than one pass asks, each pass asks the ones not asked yet, and earlier answers stay shown', async t => {
  const requests = Array.from({length: 18}, (_, n) => row(n + 1, 'join', 'accepted', '~wes', 'p' + String(n).padStart(2, '0')));
  const owners = Object.fromEntries(requests.map(r => ['~wes/' + r.project, 'ready']));
  const nec = ship('~nec', requests, owners), x = fresh(nec);
  t.after(() => x.done());
  const standing = () => children(x.view).filter(r => /^p\d\d$/.test(r.label)).map(r => r.description.split(' · ')[1]);
  await x.view.discover();
  assert.equal(nec.asked.length, 8); assert.equal(standing().filter(s => s === 'member').length, 8); assert.equal(standing().filter(s => s === 'not checked yet').length, 10);
  // A pass soon after asks only owners that were not asked; the answers it has are used as they are.
  await x.view.discover();
  assert.equal(nec.asked.length, 16); assert.equal(new Set(nec.asked).size, 16); assert.equal(standing().filter(s => s === 'member').length, 16);
  await x.view.discover();
  assert.equal(nec.asked.length, 18); assert.equal(new Set(nec.asked).size, 18); assert.deepEqual(standing(), Array(18).fill('member'));
  // Nothing is due: a further pass asks no one. Asked for by name, owners are due again, eight at a time, and the rest keep their answers.
  await x.view.discover(); assert.equal(nec.asked.length, 18);
  owners['~wes/p00'] = 'refused';
  await x.view.discover(true);
  assert.equal(nec.asked.length, 26); assert.equal(standing().filter(s => s === 'member').length, 17);
  assert.equal(children(x.view).find(r => r.label === 'p00').description, '~wes · not confirmed by the owner’s ship');
  // Refreshing again and again goes round all of them, never the same eight twice in a row.
  await x.view.discover(true); await x.view.discover(true);
  assert.equal(nec.asked.length, 42); assert.equal(new Set(nec.asked.slice(18, 34)).size, 16);
  for (const late of ['~wes/p16', '~wes/p17']) assert.equal(nec.asked.slice(34).includes(late), true);
});

test('Leave from the palette works while another pass is queued, and does not wait for an owner that never answers', async t => {
  // ~zod sorts after ~wes, so ~wes is asked and answers first; ~zod is asked next and never answers.
  let never; const silent = new Promise(resolve => {never = resolve;});
  const nec = ship('~nec', [row(1), row(2, 'join', 'accepted', '~zod', 'far')], {'~wes/demo': 'ready', '~zod/far': () => silent}), x = fresh(nec);
  t.after(() => {never('uncertain'); x.done();});
  x.view.joinedWaitMs = 300;
  // One pass is running and another is queued behind it.
  void x.view.discover(); void x.view.discover();
  for (let n = 0; n < 400 && children(x.view).find(r => r.label === 'demo')?.description !== '~wes · member'; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(children(x.view).find(r => r.label === 'demo').description, '~wes · member');
  assert.equal(children(x.view).find(r => r.label === 'far').description, '~zod · asking the owner’s ship…');
  // The one confirmed project can be left, though ~zod has not answered: the wait is bounded.
  const started = Date.now();
  await x.view.leave();
  assert.equal(nec.sent.length, 1); assert.equal(nec.sent[0].project, 'demo'); assert.equal(x.state.confirmed, 1);
  assert.ok(Date.now() - started < 5000);
});

test('putting a request aside in one window never moves the same request made again from another', async t => {
  const nec = ship('~nec', [], {}), x = fresh(nec);
  t.after(() => x.done());
  const join = {request: uuid(11), authority: '~wes', project: 'demo', operation: 'join', invitation: '0x123'}, intent = {version: 1, origin: nec.origin, actor: '~nec', command: join};
  const stopping = {...nec, projectInvitation: async (operation, value) => {if (operation === 'submit') throw new Error('process ended'); return nec.projectInvitation(operation, value);}};
  await assert.rejects(x.journal.submit(stopping, intent, true), /process ended/);
  // Window two starts putting it aside; its read of the ship is slow.
  let answer; const slow = {...nec, projectInvitation: async (operation, value) => operation === 'result' ? new Promise(resolve => {answer = () => resolve({status: 404, body: {status: 'missing', message: 'No retained invitation command.'}});}) : nec.projectInvitation(operation, value)};
  const two = new InvitationJournal(x.directory), late = two.retire(slow, intent, Date.now() + 120000);
  while (!answer) await new Promise(resolve => setImmediate(resolve));
  // Meanwhile window one puts it aside and makes the same join again; the ship accepts it.
  await x.journal.retire(nec, intent, Date.now() + 120000);
  const again = {...intent, command: {...join, request: uuid(12)}};
  assert.equal((await x.journal.submit(nec, again, true)).status, 'accepted');
  // Window two's late answer is about the old request: the new one stays where it is.
  answer(); await assert.rejects(late, /Retained invitation context changed/);
  assert.deepEqual(x.journal.entries().map(i => i.command.request), [uuid(12)]);
  assert.equal(fs.readdirSync(path.join(x.directory, 'history')).length, 1);
});
