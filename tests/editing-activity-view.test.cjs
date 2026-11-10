const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {DraftStore} = require('../dist/src/draft-store'), {snapshotFrom} = require('../dist/src/source-store');
const original = Module._load; let EditingActivityView;
try {
  Module._load = function (name, ...args) {return name === 'vscode' ? {window: {}, workspace: {}} : original.call(this, name, ...args);};
  ({EditingActivityView} = require('../dist/src/editing-activity-view'));
} finally {Module._load = original;}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-activity-view-'));
  const drafts = new DraftStore(path.join(root, 'drafts'));
  const source = {id: '0x1', owner: '~zod', desk: 'demo-work', number: 1, root: '0v1', commit: '0v1'};
  const draft = drafts.create(snapshotFrom({origin: 'https://nec.example', ship: '~nec', session: '0x1', path: '/lib/example/hoon',
    mark: 'hoon', blob: '0x1', text: 'private source text\n', source}));
  let clock = 1000, active = draft.uri, focused = true, project = 'demo', cursor = 0, notifications = 0;
  const commands = [], requests = new Map(), views = [], scheduled = new Set();
  const client = {origin: 'https://nec.example', snapshot: {owner: '~nec', ready: true,
    projects: [{id: 'demo'}], sessions: [{id: '0x1', project: 'demo', source}]},
    activitySubmit: async command => {
      commands.push({...command}); const request = '0v' + commands.length.toString(32);
      requests.set(request, command);
      return {...command, request, status: 'pending', permissionGranted: false};
    },
    activityResult: async selector => {
      const command = requests.get(selector.request);
      if (command.operation !== 'query') cursor = Number(command.sequence.replaceAll('.', ''));
      return {...selector, status: 'ready', reason: null, permissionGranted: false, epoch: '~2026.11.08', at: '~2026.11.08',
        selfSequence: cursor ? String(cursor) : null, rows: []};
    }};
  const options = {listen: false, now: () => clock, activeUri: () => active, focused: () => focused,
    schedule: (callback, ms) => {const row = {callback, ms}; scheduled.add(row); return {dispose: () => scheduled.delete(row)};},
    delay: async ms => {clock += ms;}};
  const create = () => {const view = new EditingActivityView(drafts, () => ({client, project}), () => {notifications++;}, path.join(root, 'publishers'), options); views.push(view); return view;};
  t.after(async () => {for (const view of views) {await view.stop().catch(() => {}); view.dispose();} fs.rmSync(root, {recursive: true, force: true});});
  return {root, drafts, draft, source, client, commands, create, scheduled, options, notifications: () => notifications,
    time: ms => {clock += ms;}, active: value => {active = value;}, focus: value => {focused = value;}, project: value => {project = value;}};
}
test('activity starts off; passive refresh does not publish a file or source text', async t => {
  const x = setup(t), view = x.create();
  assert.equal(x.commands.length, 0); assert.ok(view.rows().some(r => r.id === 'project-activity'));
  await view.refresh(); assert.ok(x.commands.length > 0); assert.ok(x.commands.every(c => c.operation === 'query'));
  assert.ok(x.commands.every(c => !Object.hasOwn(c, 'path') && !Object.hasOwn(c, 'text')));
});
test('explicit sharing publishes the exact trusted owner/desk/path and stop ends it', async t => {
  const x = setup(t), view = x.create(); await view.share();
  const update = x.commands.find(c => c.operation === 'update');
  assert.deepEqual(update, {owner: '~zod', project: 'demo', operation: 'update', epoch: '~2026.11.08', sequence: '1', desk: 'demo-work', path: '/lib/example/hoon'});
  assert.equal(JSON.stringify(x.commands).includes('private source text'), false);
  await view.stop(); assert.equal(x.commands.at(-1).operation, 'stop'); assert.equal(x.commands.at(-1).sequence, '2');
  const count = x.commands.length; x.time(11000); await view.tick(); assert.equal(x.commands.length, count);
});
test('untrusted local paths, wrong sessions and changed source bindings never publish', async t => {
  for (const wrong of ['local', 'session', 'source']) {
    const x = setup(t), view = x.create();
    if (wrong === 'local') x.active('file:///private/a.hoon');
    if (wrong === 'session') x.client.snapshot.sessions[0].project = 'other';
    if (wrong === 'source') x.client.snapshot.sessions[0].source = {...x.source, desk: 'session-clone'};
    await assert.rejects(view.share()); assert.equal(x.commands.some(c => c.operation === 'update'), false);
  }
});
test('only one window publishes a given actor/owner/project', async t => {
  const x = setup(t), first = x.create(), second = x.create();
  await first.share(); await assert.rejects(second.share());
  assert.equal(x.commands.filter(c => c.operation === 'update').length, 1);
  await first.stop(); await second.share(); assert.equal(x.commands.filter(c => c.operation === 'update').length, 2);
});
test('unknown publication disables automatic updates and preserves local drafts', async t => {
  const x = setup(t), before = x.drafts.get(x.draft.id), submit = x.client.activitySubmit;
  x.client.activitySubmit = async c => {if (c.operation === 'update') {x.commands.push({...c}); throw new Error('Outcome unknown');} return submit(c);};
  const view = x.create(); await assert.rejects(view.share());
  const count = x.commands.length; x.time(11000); await view.tick(); await view.tick();
  assert.equal(x.commands.length, count); assert.deepEqual(x.drafts.get(x.draft.id), before);
});
test('loss of focus stops sharing and returning focus does not restore consent', async t => {
  const x = setup(t), view = x.create(); await view.share(); x.focus(false); await view.tick();
  assert.equal(x.commands.at(-1).operation, 'stop'); const count = x.commands.length;
  x.focus(true); x.time(11000); await view.tick(); assert.equal(x.commands.length, count);
});
test('focused heartbeat advances the native sequence without publishing unchanged text', async t => {
  const x = setup(t), view = x.create(); await view.share();
  const count = x.commands.length; x.time(1000); await view.tick(); assert.equal(x.commands.length, count);
  x.time(10000); await view.tick();
  const writes = x.commands.filter(c => c.operation === 'update');
  assert.equal(writes.length, 2); assert.equal(writes[1].sequence, '2');
  assert.equal(writes[1].path, '/lib/example/hoon'); assert.equal(Object.hasOwn(writes[1], 'text'), false);
});
test('changing project while query is pending cannot publish a late selected file', async t => {
  const x = setup(t), view = x.create(), result = x.client.activityResult;
  let release, entered; const arrived = new Promise(resolve => {entered = resolve;});
  x.client.activityResult = async key => {entered(); await new Promise(resolve => {release = resolve;}); return result(key);};
  const pending = view.share().catch(() => {}); await arrived;
  x.project('other'); const change = view.contextChanged(); release(); await Promise.all([pending, change]);
  assert.equal(x.commands.some(c => c.operation === 'update'), false);
  x.client.activityResult = result; x.project('demo');
  await x.create().share();
  assert.equal(x.commands.filter(c => c.operation === 'update').length, 1, 'A canceled query must release its unpublished reservation');
});
test('idle collaborator observations expire visibly without an editor event', async t => {
  const x = setup(t), view = x.create(), result = x.client.activityResult;
  x.client.activityResult = async key => ({...await result(key), rows: [{ship: '~bud', desk: 'demo-work', path: '/lib/example/hoon'}]});
  await view.refresh(); assert.ok(view.rows()[0].children.some(row => row.label === '~bud'));
  const before = x.notifications(), expiry = [...x.scheduled].find(row => row.ms >= 29_000 && row.ms <= 30_000);
  assert.ok(expiry, 'Displayed activity needs a scheduled expiry even when sharing is off');
  x.time(30_001); expiry.callback();
  assert.ok(x.notifications() > before); assert.equal(view.rows()[0].children.some(row => row.label === '~bud'), false);
});
test('a heartbeat firing during refresh is scheduled again after the query settles', async t => {
  const x = setup(t), view = x.create(); await view.share();
  const result = x.client.activityResult; let release, entered;
  const arrived = new Promise(resolve => {entered = resolve;});
  x.client.activityResult = async key => {entered(); await new Promise(resolve => {release = resolve;}); return result(key);};
  const refreshing = view.refresh(); await arrived;
  const heartbeat = [...x.scheduled].find(row => row.ms === 9000); assert.ok(heartbeat);
  x.time(9000); x.scheduled.delete(heartbeat); heartbeat.callback(); release(); await refreshing;
  assert.ok([...x.scheduled].some(row => row.ms > 0 && row.ms <= 9000), 'Heartbeat must survive a concurrent observation');
  x.client.activityResult = result; await view.tick();
  assert.equal(x.commands.filter(c => c.operation === 'update').length, 2);
});
test('a replaced publisher lock prevents the original window from updating or stopping its successor', async t => {
  const x = setup(t), first = x.create(); await first.share();
  const directory = path.join(x.root, 'publishers'), file = path.join(directory, fs.readdirSync(directory)[0]);
  fs.unlinkSync(file); const second = x.create(); await second.share();
  const retained = fs.readFileSync(file), count = x.commands.length;
  x.time(11_000); await first.tick();
  assert.equal(x.commands.length, count); assert.deepEqual(fs.readFileSync(file), retained);
  await second.stop(); assert.equal(fs.existsSync(file), false);
});
test('a late pending reply after the deadline cannot schedule more result requests', async t => {
  const x = setup(t), view = x.create(); let release, entered, reads = 0;
  const arrived = new Promise(resolve => {entered = resolve;});
  x.client.activityResult = async key => {reads++; entered(); await new Promise(resolve => {release = resolve;}); return {...key, status: 'pending', permissionGranted: false};};
  const sharing = view.share(); await arrived;
  const deadline = [...x.scheduled].find(row => row.ms === 10_000); assert.ok(deadline);
  x.time(10_000); deadline.callback(); await assert.rejects(sharing); release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1); assert.equal(x.commands.some(c => c.operation === 'update'), false);
});

test('collaborator file click refreshes exact filtered activity and never publishes', async t => {
  const x = setup(t), view = x.create(), originalResult = x.client.activityResult;
  const row = {ship: '~bud', desk: 'demo-work', path: '/lib/example/hoon'};
  x.client.activityResult = async selector => ({...await originalResult(selector), rows: [row]});
  await view.refresh();
  const item = view.rows()[0].children.find(r => r.label === '~bud');
  assert.deepEqual(item.command.arguments, ['~bud']); assert.equal(item.command.command, 'readymade.openActivityFile');
  let opened;
  await view.openFile('~bud', async (file, active) => {assert.equal(active(), true); opened = file;});
  assert.deepEqual(opened, {origin: x.client.origin, actor: '~nec', owner: '~zod', project: 'demo', ...row});
  assert.equal(x.commands.length, 2); assert.ok(x.commands.every(c => c.operation === 'query'));
});
test('activity file click refuses stale rows, moved peers and context switches', async t => {
  for (const mode of ['expired', 'moved', 'removed', 'context']) {
    const x = setup(t), view = x.create(), originalResult = x.client.activityResult;
    let rows = [{ship: '~bud', desk: 'demo-work', path: '/lib/example/hoon'}], reads = 0, opened = 0;
    x.client.activityResult = async selector => {reads++; if (mode === 'context' && reads === 2) x.project('other'); return {...await originalResult(selector), rows};};
    await view.refresh();
    if (mode === 'expired') x.time(30_000);
    if (mode === 'moved') rows = [{...rows[0], path: '/lib/other/hoon'}];
    if (mode === 'removed') rows = [];
    await assert.rejects(view.openFile('~bud', async () => {opened++;}));
    assert.equal(opened, 0); assert.ok(x.commands.every(c => c.operation === 'query'));
  }
});
