'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const policy = require('../platform/media-policy.cjs');
const { createController, startServer } = require('../platform/media-main.cjs');
const { installSession, installContents, chooseCapture, captureCapabilities } = require('../platform/media-session.cjs');
const ID = 'a'.repeat(32), ORIGIN = 'http://localhost:8080';
test('native picker refuses a selection after its owner navigates, closes or loses isolation', async () => {
  for (const change of ['navigate', 'close', 'second-tab']) {
    const f = fixture();
    f.controller.context.captureCapabilities = () => ({ nativePicker: true, loopback: true });
    f.electron.BrowserWindow = { fromWebContents: () => null };
    f.electron.dialog = { showMessageBox: async () => ({ response: 1, checkboxChecked: true }) };
    const wc = f.view(); await f.controller.request('bind', payload());
    let finish, started;
    const picking = new Promise(resolve => { started = resolve; });
    f.session._setDisplayMediaRequestHandler((_request, callback) => { finish = callback; started(); });
    const result = new Promise(resolve => f.session.display({ frame: wc.mainFrame,
      securityOrigin: ORIGIN, userGesture: true, audioRequested: true }, resolve));
    await picking;
    if (change === 'navigate') wc.url = 'https://foreign.test/';
    else if (change === 'close') wc.close();
    else f.view('b'.repeat(32));
    finish({ video: { id: 'selected-screen' }, audio: 'loopback' });
    assert.deepEqual(await result, {}, change);
  }
});
const payload = (id = ID) => ({ bindingId: id, bootstrapURL: 'about:blank#readymade-' + id,
  origin: ORIGIN, kind: 'glurff', url: ORIGIN + '/apps/glurff/?x=1#room',
  cookies: [{ name: 'urbauth-~zod', value: 'fixture-session' }] });
function mockSession(stored, removed) {
  return { cookies: { set: async value => { stored.push(value); }, remove: async (...value) => { removed.push(value); } },
    getStoragePath: () => null,
    setPermissionRequestHandler(fn) { this.requestPermission = fn; },
    setPermissionCheckHandler(fn) { this.checkPermission = fn; },
    _setDisplayMediaRequestHandler(fn) { this.display = fn; },
    setDisplayMediaRequestHandler(fn, options) {
      this.displayOptions = options;
      this._setDisplayMediaRequestHandler(options?.useSystemPicker ? (_request, callback) => {
        this.nativeChoices = (this.nativeChoices || 0) + 1; callback({ video: { id: 'native-picker' } });
      } : fn);
    },
    webRequest: { onBeforeSendHeaders(...args) { this.handler = args.at(-1); } } };
}
function fixture() {
  const stored = [], removed = [], views = [], session = mockSession(stored, removed);
  const electron = { webContents: { getAllWebContents: () => views, fromFrame: frame => views.find(wc => wc.mainFrame === frame) } };
  const controller = createController(electron); installSession(session, controller.context);
  function view(id = ID, ownSession = session) {
    const wc = new EventEmitter(), wcId = views.length + 1;
    const alive = value => { if (wc.destroyed) throw new TypeError('Object has been destroyed'); return value; };
    Object.defineProperties(wc, { id: { get: () => alive(wcId) }, session: { get: () => alive(ownSession) } });
    wc.url = 'about:blank#readymade-' + id; wc.destroyed = false; wc.loads = [];
    wc.getURL = () => alive(wc.url); wc.isDestroyed = () => wc.destroyed;
    wc.getLastWebPreferences = () => ({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    wc.loadURL = async url => { wc.loads.push(url); wc.url = url; wc.emit('did-finish-load'); };
    wc.setWindowOpenHandler = handler => { wc.popup = handler; };
    wc.close = () => { wc.destroyed = true; wc.emit('destroyed'); };
    wc.mainFrame = {}; wc.mainFrame.top = wc.mainFrame;
    views.push(wc); installContents(wc, controller.context);
    controller.context.bootstrapLoads.set(wc, {url: wc.url, state: 'ready'}); // Default fixture has completed its initial load.
    return wc;
  }
  return { electron, controller, session, stored, removed, views, view };
}
test('strict origins, app roots, cookie names and exact bootstrap admission', () => {
  assert.equal(policy.origin('https://ship.test'), 'https://ship.test');
  for (const value of ['http://ship.test', 'https://u:p@ship.test', 'https://ship.test/path', 'https://ship.test/?code=secret'])
    assert.throws(() => policy.origin(value), /invalidOrigin/);
  assert(policy.approved(ORIGIN + '/apps/glurff/?a=1#x', ORIGIN, 'glurff'));
  assert(!policy.approved('http://localhost:9999/apps/glurff/', ORIGIN, 'glurff'));
  assert(!policy.approved(ORIGIN + '/apps/glurff-evil/', ORIGIN, 'glurff'));
  assert.throws(() => policy.binding({ ...payload(), bootstrapURL: 'about:blank' }), /invalidBinding/);
  assert.throws(() => policy.binding({ ...payload(), cookies: [{ name: '+code', value: 'secret' }] }), /invalidCookies/);
  const cookie = policy.binding(payload()).cookies[0];
  assert.equal(cookie.httpOnly, true); assert.equal(cookie.path, '/'); assert(!('domain' in cookie));
});
test('Landscape binds only its exact origin and app root, retaining the same native owner', async () => {
  const f = fixture(), wc = f.view();
  const request = { ...payload(), kind: 'landscape', url: ORIGIN + '/apps/landscape/' };
  assert.equal(policy.approved(request.url, ORIGIN, 'landscape'), true);
  for (const url of [ORIGIN + '/apps/landscape-other/', ORIGIN + '/apps/other/', 'http://localhost:9999/apps/landscape/'])
    assert.equal(policy.approved(url, ORIGIN, 'landscape'), false);
  const state = await f.controller.request('bind', request);
  assert.equal(state.kind, 'landscape'); assert.equal(state.ready, true); assert.equal(state.requestedURL, request.url);
  assert.equal((await f.controller.request('observe', { bindingId: ID })).bindingId, ID);
  await assert.rejects(f.controller.request('bind', request), /alreadyBound/);
  await assert.rejects(f.controller.request('navigate', { bindingId: ID, url: ORIGIN + '/apps/other/' }), /invalidURL/);
  assert.deepEqual(wc.loads, [request.url]); assert.equal(f.views.length, 1);
});
test('bind reserves an immutable safe tab, emits full popup URL, and never returns cookies', async () => {
  const f = fixture(), wc = f.view(), events = [];
  const state = await f.controller.request('bind', payload());
  assert.equal(state.ready, true); assert.equal(state.requestedURL, payload().url);
  assert(!JSON.stringify(state).includes('fixture-session')); assert.equal(f.stored.length, 1);
  await f.controller.request('observe', { bindingId: ID }, value => events.push(value));
  const target = ORIGIN + '/apps/noltbook/?room=abc#call';
  assert.deepEqual(wc.popup({ url: target }), { action: 'deny' }); assert.equal(events.at(-1).url, target);
  wc.popup({ url: 'https://foreign.test/apps/noltbook/' }); assert.equal(events.length, 1);
  let prevented = false; wc.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://foreign.test/');
  assert(prevented);
  await assert.rejects(wc.loadURL('https://foreign.test/'), /invalidURL/);
  await assert.rejects(f.controller.request('bind', payload()), /alreadyBound/); assert.equal(wc.loads.length, 1);
  await assert.rejects(f.controller.request('navigate', { bindingId: ID, url: 'http://localhost:9999/apps/glurff/' }), /invalidURL/);
  const bound = f.controller.context.byContents.get(wc.id); wc.close(); await bound.cleanup;
  assert.deepEqual(await f.controller.request('observe', { bindingId: ID }), { bindingId: ID, exists: false, pending: false });
  assert.equal(f.removed.length, 1, 'tab close removes its private cookie');
});
test('permission wrappers retain native prompts while denying foreign frames', async () => {
  const f = fixture(), wc = f.view(); await f.controller.request('bind', payload());
  let prompts = 0;
  f.session.setPermissionRequestHandler((_wc, _permission, callback) => { prompts++; callback(true); });
  const request = details => new Promise(resolve => f.session.requestPermission(wc, 'media', resolve, details));
  assert.equal(await request({ securityOrigin: ORIGIN }), true); assert.equal(prompts, 1);
  assert.equal(await request({ securityOrigin: 'http://localhost:9999' }), false); assert.equal(prompts, 1);
  f.session.setPermissionCheckHandler(() => true);
  assert.equal(f.session.checkPermission(wc, 'media', ORIGIN, { securityOrigin: ORIGIN }), true);
  assert.equal(f.session.checkPermission(wc, 'media', ORIGIN, { securityOrigin: 'https://foreign.test' }), false);
  assert.equal(await new Promise(resolve => f.session.requestPermission(wc, 'display-capture', resolve, { securityOrigin: ORIGIN, isMainFrame: true })), true);
  assert.equal(await new Promise(resolve => f.session.requestPermission(wc, 'media', resolve, { securityOrigin: ORIGIN, isMainFrame: false, mediaTypes: [] })), false);
});
test('managed auth cookies never cross origin/port, vendor network callback remains composed', async () => {
  const f = fixture(); f.view(); await f.controller.request('bind', payload());
  let called = 0;
  f.session.webRequest.onBeforeSendHeaders({ urls: ['http://localhost:8080/*'] }, (details, callback) => {
    called++; callback({ requestHeaders: { ...details.requestHeaders, 'X-Vendor': 'kept' } });
  });
  const headers = url => new Promise(resolve => f.session.webRequest.handler({ url,
    requestHeaders: { Cookie: 'other=ok; urbauth-~zod=fixture-session' } }, resolve));
  assert.equal((await headers(ORIGIN + '/apps/glurff/')).requestHeaders.Cookie.includes('urbauth'), true);
  assert.equal((await headers('http://localhost:9999/')).requestHeaders.Cookie, 'other=ok');
  assert.equal(called, 1); assert.equal((await headers(ORIGIN + '/x')).requestHeaders['X-Vendor'], 'kept');
});
test('capture requires bound top frame, exact origin and gesture; never auto selects', async () => {
  const f = fixture(), wc = f.view(); await f.controller.request('bind', payload());
  let captures = 0; f.controller.context.capture = async () => { captures++; return { video: { id: 'explicit' } }; };
  const request = change => new Promise(resolve => f.session.display({ frame: wc.mainFrame, securityOrigin: ORIGIN, userGesture: true, ...change }, resolve));
  assert.deepEqual(await request({ userGesture: false }), {});
  assert.deepEqual(await request({ securityOrigin: 'http://localhost:9999' }), {});
  const iframe = { top: wc.mainFrame }; assert.deepEqual(await request({ frame: iframe }), {});
  assert.equal(captures, 0); assert.equal((await request({})).video.id, 'explicit'); assert.equal(captures, 1);
  assert.equal(f.session.displayOptions.useSystemPicker, false);
  const electron = { desktopCapturer: { getSources: async () => [{ id: 'one', name: 'Screen' }] },
    BrowserWindow: { fromWebContents: () => null }, dialog: { showMessageBox: async options => { assert.equal(options.defaultId, 0); return { response: 0 }; } } };
  assert.deepEqual(await chooseCapture(electron, { audioRequested: true }, wc), {});
});
test('partial bind failure stays inspectable and locked; forget only removes managed cookies', async () => {
  const f = fixture(), wc = f.view(); wc.loadURL = async () => { throw new Error('sensitive failure'); };
  await assert.rejects(f.controller.request('bind', payload()), /outcomeUnknown/);
  const state = await f.controller.request('observe', { bindingId: ID }); assert.equal(state.fault, 'outcomeUnknown');
  await assert.rejects(f.controller.request('navigate', { bindingId: ID, url: payload().url }), /bindingFault/);
  assert.equal(f.stored.length, 1);
  await f.controller.request('forget', { origin: ORIGIN, bindingIds: [ID] }); assert(wc.destroyed);
  assert.deepEqual(f.removed, [[ORIGIN + '/', 'urbauth-~zod']]);
});
test('unsafe views and shared cookie sessions are refused before cookie changes', async () => {
  const f = fixture(), wc = f.view(); wc.getLastWebPreferences = () => ({ sandbox: false });
  await assert.rejects(f.controller.request('bind', payload()), /unsafeView/); assert.equal(f.stored.length, 0);
  wc.getLastWebPreferences = () => ({ sandbox: true, contextIsolation: true, nodeIntegration: false });
  await f.controller.request('bind', payload()); f.view('b'.repeat(32));
  await assert.rejects(f.controller.request('bind', { ...payload('b'.repeat(32)), origin: 'http://localhost:9999', url: 'http://localhost:9999/apps/glurff/' }), /unsafeView/);
  assert.equal(f.stored.length, 1);
});
test('persistent sessions are untouched and cannot receive managed auth', async () => {
  const f = fixture(), wc = f.view(), before = f.session.setPermissionRequestHandler;
  f.session.getStoragePath = () => '/persistent';
  installSession(f.session, f.controller.context);
  assert.equal(f.session.setPermissionRequestHandler, before);
  await assert.rejects(f.controller.request('bind', payload()), /unsafeView/);
  assert.equal(f.stored.length, 0); assert.equal(wc.loads.length, 0);
});
test('queued or active mutations are distinguishable from a conclusive absent observation', async () => {
  const f = fixture(); f.controller.markPending(ID, 1);
  assert.deepEqual(await f.controller.request('observe', { bindingId: ID }), { bindingId: ID, exists: false, pending: true });
  f.view(); await f.controller.request('bind', payload());
  assert.equal((await f.controller.request('observe', { bindingId: ID })).pending, true);
  f.controller.markPending(ID, -1);
  assert.equal((await f.controller.request('observe', { bindingId: ID })).pending, false);
});
test('real private Unix RPC is bounded and refuses an existing path', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rm-media-')); await fs.chmod(directory, 0o700);
  const f = fixture(); f.electron.app = { getPath: () => directory };
  const server = await startServer(f.electron, f.controller);
  try {
    assert.equal((await fs.lstat(server.socketPath)).mode & 0o777, 0o600);
    await assert.rejects(startServer(f.electron, f.controller), /socketExists/);
    const socket = net.createConnection(server.socketPath); await once(socket, 'connect');
    socket.write(JSON.stringify({ id: ID, op: 'status', payload: {} }) + '\n');
    const [data] = await once(socket, 'data'); const response = JSON.parse(data.toString());
    assert.equal(response.id, ID); assert.equal(response.result.protocol, 1); assert.deepEqual(response.result.bindings, []);
    socket.write(Buffer.alloc(65537, 65)); await once(socket, 'close');
  } finally { server.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
test('native macOS picker is activated only for one bound private tab and fences Electron bypass', async () => {
  assert.deepEqual(captureCapabilities('darwin', '24.0.0', '43.7.7'), { nativePicker: true, loopback: true });
  assert.deepEqual(captureCapabilities('darwin', '23.1.0', '43.7.7'), { nativePicker: false, loopback: false });
  assert.deepEqual(captureCapabilities('darwin', '23.2.0', '43.7.7'), { nativePicker: false, loopback: true });
  assert.equal(captureCapabilities('darwin', '24.0.0', '38.0.0').loopback, false);
  const f = fixture(); f.controller.context.captureCapabilities = () => ({ nativePicker: true, loopback: true });
  let choice = { response: 0 }, prompts = 0;
  f.electron.BrowserWindow = { fromWebContents: () => null };
  f.electron.dialog = { showMessageBox: async options => {
    prompts++; assert(options.message.includes(ORIGIN)); assert.equal(options.defaultId, 0);
    assert.equal(options.checkboxChecked, false); return choice;
  } };
  const wc = f.view(); assert.equal(f.session.displayOptions.useSystemPicker, false);
  await f.controller.request('bind', payload()); assert.equal(f.session.displayOptions.useSystemPicker, true);
  const request = (change = {}, handler = f.session.display) => new Promise(resolve => handler({ frame: wc.mainFrame,
    securityOrigin: ORIGIN, userGesture: true, audioRequested: true, ...change }, resolve));
  assert.deepEqual(await request({ securityOrigin: 'https://foreign.test' }), {});
  assert.deepEqual(await request({ userGesture: false }), {}); assert.equal(prompts, 0);
  assert.deepEqual(await request(), {}); assert.equal(f.session.nativeChoices || 0, 0);
  choice = { response: 1, checkboxChecked: false };
  const silent = await request(); assert.equal(silent.video.id, 'native-picker'); assert(!('audio' in silent));
  choice = { response: 1, checkboxChecked: true }; assert.equal((await request()).audio, 'loopback');
  const stale = f.session.display, bound = f.controller.context.byContents.get(wc.id); wc.close(); await bound.cleanup;
  assert.deepEqual(await request({}, stale), {}); assert.equal(f.session.nativeChoices, 2);
});
test('bind subscribes before early popup; same-frame Noltbook link hands off but redirects do not', async () => {
  const f = fixture(), wc = f.view(), events = [], target = ORIGIN + '/apps/noltbook/room?invite=x#call';
  const load = wc.loadURL;
  wc.loadURL = async url => { const result = await load(url); wc.popup({ url: target }); return result; };
  await f.controller.request('bind', payload(), value => events.push(value));
  assert.equal(events.filter(event => event.type === 'open').length, 1);
  wc.emit('will-navigate', { isMainFrame: true, preventDefault() {} }, target);
  assert.equal(events.filter(event => event.type === 'open').at(-1).url, target);
  const count = events.length;
  wc.emit('will-redirect', { isMainFrame: true, preventDefault() {} }, target);
  wc.emit('will-navigate', { isMainFrame: false, preventDefault() {} }, target);
  assert.equal(events.length, count); assert.equal(wc.getURL(), payload().url);
});
test('scoped forget validates every owner before removing only one of two same-origin private jars', async () => {
  const f = fixture(), first = f.view(); await f.controller.request('bind', payload());
  const removed = [], secondSession = mockSession([], removed), secondId = 'b'.repeat(32);
  installSession(secondSession, f.controller.context); const second = f.view(secondId, secondSession);
  await f.controller.request('bind', payload(secondId));
  assert.deepEqual(await f.controller.request('forget', { origin: ORIGIN, bindingIds: ['c'.repeat(32)] }), { forgotten: true });
  assert(!first.destroyed); assert(!second.destroyed); assert.equal(f.removed.length, 0);
  await f.controller.request('forget', { origin: ORIGIN, bindingIds: [ID] });
  assert(first.destroyed); assert(!second.destroyed); assert.equal(f.removed.length, 1); assert.equal(removed.length, 0);
  assert.equal((await f.controller.request('observe', { bindingId: secondId })).ready, true);
  const bound = f.controller.context.byContents.get(second.id); second.close(); await bound.cleanup;
  assert.equal(removed.length, 1); assert.equal(f.controller.context.sessions.size, 0);
});
test('forget after normal X skips only completed cleanup and closes the listed live sibling', async () => {
  const f = fixture(), first = f.view(); await f.controller.request('bind', payload());
  const removed = [], secondSession = mockSession([], removed), secondId = 'b'.repeat(32);
  installSession(secondSession, f.controller.context); const second = f.view(secondId, secondSession);
  await f.controller.request('bind', payload(secondId));
  const untouchedRemoved = [], thirdSession = mockSession([], untouchedRemoved), thirdId = 'c'.repeat(32);
  installSession(thirdSession, f.controller.context); const third = f.view(thirdId, thirdSession);
  await f.controller.request('bind', payload(thirdId));
  const bound = f.controller.context.byContents.get(first.id); first.close(); await bound.cleanup;
  assert.deepEqual(await f.controller.request('forget', { origin: ORIGIN, bindingIds: [ID, secondId] }), { forgotten: true });
  assert(second.destroyed); assert.equal(removed.length, 1); assert.equal(f.removed.length, 1);
  assert(!third.destroyed); assert.equal(untouchedRemoved.length, 0);
  assert.equal((await f.controller.request('observe', { bindingId: thirdId })).ready, true);
});
test('missing IDs never bypass atomic validation of a present binding from another origin', async () => {
  const f = fixture(), first = f.view(); await f.controller.request('bind', payload());
  const removed = [], foreignSession = mockSession([], removed), foreignId = 'b'.repeat(32), foreignOrigin = 'https://foreign.fixture';
  installSession(foreignSession, f.controller.context); const foreign = f.view(foreignId, foreignSession);
  await f.controller.request('bind', { ...payload(foreignId), origin: foreignOrigin, url: foreignOrigin + '/apps/glurff/' });
  await assert.rejects(f.controller.request('forget', { origin: ORIGIN, bindingIds: [ID, 'c'.repeat(32), foreignId] }), /bindingMissing/);
  assert(!first.destroyed); assert(!foreign.destroyed); assert.equal(f.removed.length, 0); assert.equal(removed.length, 0);
  assert.equal((await f.controller.request('observe', { bindingId: ID })).ready, true);
  assert.equal((await f.controller.request('observe', { bindingId: foreignId })).ready, true);
});
test('tab close waits for in-flight cookie installation before cleanup and stays pending meanwhile', async () => {
  const f = fixture(), wc = f.view(); let release;
  f.session.cookies.set = () => new Promise(resolve => { release = resolve; });
  const operation = f.controller.request('bind', payload()); const rejected = assert.rejects(operation, /outcomeUnknown/);
  const bound = f.controller.context.byContents.get(wc.id); wc.close();
  const observation = await f.controller.request('observe', { bindingId: ID });
  assert.equal(observation.fault, 'closed'); assert.equal(observation.pending, true); assert.equal(f.removed.length, 0);
  release(); await rejected; await bound.cleanup;
  assert.equal(f.removed.length, 1); assert.equal(wc.loads.length, 0);
  assert.deepEqual(await f.controller.request('observe', { bindingId: ID }), { bindingId: ID, exists: false, pending: false });
});
test('destroyed native getters are never touched during bound or unbound cleanup', async () => {
  const f = fixture(), unbound = f.view();
  assert.doesNotThrow(() => unbound.close());
  assert.throws(() => unbound.id, /Object has been destroyed/);
  assert.throws(() => unbound.session, /Object has been destroyed/);
  assert.equal(f.controller.context.sessions.size, 0);
  installSession(f.session, f.controller.context);
  const wc = f.view(); await f.controller.request('bind', payload());
  const bound = f.controller.context.byContents.get(wc.id), events = [];
  await f.controller.request('observe', { bindingId: ID }, event => events.push(event));
  let release;
  f.session.cookies.remove = () => new Promise(resolve => { release = resolve; });
  assert.doesNotThrow(() => wc.close());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.controller.request('status')).bindings[0].id, bound.wcId);
  const closed = await f.controller.request('observe', { bindingId: ID });
  assert.equal(closed.pending, true); assert.equal(closed.fault, 'closed');
  assert.equal(events.at(-1).id, bound.wcId);
  release(); await bound.cleanup;
  assert.equal(f.controller.context.sessions.size, 0);
  assert.deepEqual(await f.controller.request('observe', { bindingId: ID }), { bindingId: ID, exists: false, pending: false });
});
test('external popup requires explicit native confirmation; navigation and unsafe destinations stay blocked', async () => {
  const f = fixture(), wc = f.view(), prompts = [], opened = [], events = [];
  f.electron.BrowserWindow = { fromWebContents: () => null };
  let answer = { response: 0 };
  f.electron.dialog = { showMessageBox: async options => { prompts.push(options); return answer; } };
  f.electron.shell = { openExternal: async url => { opened.push(url); } };
  await f.controller.request('bind', payload(), event => events.push(event));
  const tick = () => new Promise(resolve => setImmediate(resolve)), target = 'https://foreign.test/path?q=1#room';
  for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'other:thing', 'https://u:p@foreign.test/', 'https://foreign.test/\npath']) wc.popup({ url });
  wc.popup({ url: target, postBody: { data: [] } }); await tick(); assert.equal(prompts.length, 0);
  for (const type of ['will-navigate', 'will-redirect']) {
    let blocked = false; wc.emit(type, { preventDefault() { blocked = true; } }, target); assert(blocked);
  }
  assert.equal(prompts.length, 0);
  assert.deepEqual(wc.popup({ url: target }), { action: 'deny' }); await tick();
  assert.equal(prompts[0].defaultId, 0); assert.equal(prompts[0].cancelId, 0);
  assert(prompts[0].message.includes(ORIGIN)); assert.equal(prompts[0].detail, target); assert.deepEqual(opened, []);
  answer = { response: 1 }; wc.popup({ url: target }); await tick(); assert.deepEqual(opened, [target]);
  wc.popup({ url: ORIGIN + '/apps/noltbook/?room=kept#call' }); await tick();
  assert.equal(events.filter(event => event.type === 'open').length, 1); assert.equal(prompts.length, 2);
  let release; f.electron.dialog.showMessageBox = options => { prompts.push(options); return new Promise(resolve => { release = resolve; }); };
  wc.popup({ url: target }); wc.popup({ url: 'https://another.test/' }); assert.equal(prompts.length, 3);
  const bound = f.controller.context.byContents.get(wc.id); wc.close(); release({ response: 1 }); await tick(); await bound.cleanup;
  assert.deepEqual(opened, [target], 'closing the requesting tab invalidates a pending Open Browser choice');
});
test('status diagnoses only exact empty bootstrap views and never exposes unrelated page URLs or auth', async () => {
  const f = fixture(), wc = f.view(), unrelated = f.view('b'.repeat(32)), invalid = f.view('c'.repeat(32));
  unrelated.url = 'https://private.fixture/?secret=private-value'; invalid.url = 'about:blank#readymade-wrong';
  const result = await f.controller.request('status');
  assert.equal(result.nativeName, null);
  f.electron.app = { getName: () => 'Readymade Workspace' };
  assert.equal((await f.controller.request('status')).nativeName, 'Readymade Workspace');
  assert.deepEqual(result.bootstrapViews, [{ id: wc.id, url: wc.getURL(), bootstrapLoaded: true, sandbox: true, contextIsolation: true,
    nodeIntegration: false, ephemeral: true, hooked: true, sameSessionViews: 3 }]);
  assert(!JSON.stringify(result).includes('private-value')); assert(!JSON.stringify(result).includes('fixture-session'));
  wc.getLastWebPreferences = () => ({ sandbox: false, contextIsolation: true });
  f.session.getStoragePath = () => '/private-profile'; f.controller.context.sessions.delete(f.session);
  const diagnosed = (await f.controller.request('status')).bootstrapViews[0];
  assert.equal(diagnosed.nodeIntegration, null); assert.equal(diagnosed.sandbox, false);
  assert.equal(diagnosed.ephemeral, false); assert.equal(diagnosed.hooked, false);
  wc.close(); assert.deepEqual((await f.controller.request('status')).bootstrapViews, []);
});

test('Noltbook hands same-frame and popup Glurff links to the workspace without navigating its call owner', async () => {
  const f = fixture(), wc = f.view(), events = [];
  const note = { ...payload(), kind: 'noltbook', url: ORIGIN + '/apps/noltbook/?note=held#call' };
  await f.controller.request('bind', note, value => events.push(value));
  const target = ORIGIN + '/apps/glurff/?world=red%2Fblue#place';
  let prevented = false;
  wc.emit('will-navigate', { isMainFrame: true, preventDefault() { prevented = true; } }, target);
  assert.equal(prevented, true); assert.equal(events.filter(event => event.type === 'open').at(-1).url, target);
  assert.deepEqual(wc.popup({ url: target }), { action: 'deny' });
  assert.equal(events.filter(event => event.type === 'open').length, 2);
  const count = events.length;
  for (const url of [target, ORIGIN + '/apps/call', ORIGIN + '/apps/other/', 'https://foreign.test/apps/glurff/']) {
    wc.emit('will-redirect', { isMainFrame: true, preventDefault() {} }, url);
    wc.emit('will-navigate', { isMainFrame: false, preventDefault() {} }, url);
  }
  for (const url of [ORIGIN + '/apps/call', ORIGIN + '/apps/other/', 'https://foreign.test/apps/glurff/'])
    wc.emit('will-navigate', { isMainFrame: true, preventDefault() {} }, url);
  assert.equal(events.length, count); assert.equal(wc.getURL(), note.url); assert.deepEqual(wc.loads, [note.url]);
});

test('Groups keeps its exact app boundary and hands Landscape links off without losing its owner', async () => {
  const f = fixture(), wc = f.view(), events = [];
  const request = { ...payload(), kind: 'groups', url: ORIGIN + '/apps/groups/groups/~zod/test' };
  for (const url of [ORIGIN + '/apps/groups-other/', ORIGIN + '/apps/other/', 'https://foreign.test/apps/groups/'])
    assert.equal(policy.approved(url, ORIGIN, 'groups'), false);
  const state = await f.controller.request('bind', request, event => events.push(event));
  assert.equal(state.kind, 'groups'); assert.equal(state.ready, true);
  const target = ORIGIN + '/apps/landscape/';
  let prevented = false;
  wc.emit('will-navigate', { isMainFrame: true, preventDefault() { prevented = true; } }, target);
  assert.equal(prevented, true); assert.equal(events.at(-1).url, target);
  assert.deepEqual(wc.loads, [request.url]);
  const count = events.length;
  wc.emit('will-navigate', { isMainFrame: true, preventDefault() {} }, 'https://foreign.test/apps/groups/');
  assert.equal(events.length, count);
});

test('Lattice admits reader and editor on its own origin and hands app links off without reload', async () => {
  const f = fixture(), wc = f.view(), events = [];
  const request = { ...payload(), kind: 'lattice', url: ORIGIN + '/apps/lattice/app' };
  assert(policy.approved(ORIGIN + '/apps/lattice', ORIGIN, 'lattice'));
  for (const url of [ORIGIN + '/apps/lattice-other/', ORIGIN + '/apps/other/', 'https://foreign.test/apps/lattice/app'])
    assert.equal(policy.approved(url, ORIGIN, 'lattice'), false);
  const state = await f.controller.request('bind', request, event => events.push(event));
  assert.equal(state.kind, 'lattice'); assert.equal(state.ready, true);
  const target = ORIGIN + '/apps/groups/';
  let prevented = false;
  wc.emit('will-navigate', { isMainFrame: true, preventDefault() { prevented = true; } }, target);
  assert.equal(prevented, true); assert.equal(events.at(-1).url, target);
  assert.deepEqual(wc.loads, [request.url]);
});

 test('a committed bootstrap URL cannot bind until its original navigation promise completes', async () => {
  const f = fixture(), wc = f.view();
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  wc.loadURL = url => { wc.url = url; return pending; };
  installContents(wc, f.controller.context);
  const initial = wc.loadURL(wc.getURL());
  assert.equal((await f.controller.request('status')).bootstrapViews[0].bootstrapLoaded, false);
  await assert.rejects(f.controller.request('bind', payload()), /bootstrapNotFound/);
  assert.deepEqual(f.stored, []);
  complete(); await initial;
  assert.equal((await f.controller.request('status')).bootstrapViews[0].bootstrapLoaded, true);
  await f.controller.request('bind', payload());
  assert.equal(f.stored.length, 1);
});
 test('a failed bootstrap refuses binding before any credentials are installed', async () => {
  const f = fixture(), wc = f.view();
  wc.loadURL = async () => { throw new Error('initial page failed'); };
  installContents(wc, f.controller.context);
  await assert.rejects(wc.loadURL(wc.getURL()), /initial page failed/);
  assert.equal((await f.controller.request('status')).bootstrapViews[0].bootstrapLoaded, false);
  await assert.rejects(f.controller.request('bind', payload()), /bootstrapNotFound/);
  assert.deepEqual(f.stored, []);
});
test('a superseded bootstrap promise cannot make the replacement navigation ready', async () => {
  const f = fixture(), wc = f.view(), releases = [];
  wc.loadURL = url => { wc.url = url; return new Promise(resolve => releases.push(resolve)); };
  installContents(wc, f.controller.context);
  const first = wc.loadURL(wc.getURL()), nextId = 'd'.repeat(32);
  const second = wc.loadURL('about:blank#readymade-' + nextId);
  releases[0](); await first;
  assert.equal((await f.controller.request('status')).bootstrapViews[0].bootstrapLoaded, false);
  await assert.rejects(f.controller.request('bind', payload(nextId)), /bootstrapNotFound/);
  assert.deepEqual(f.stored, []);
  releases[1](); await second;
  assert.equal((await f.controller.request('status')).bootstrapViews[0].bootstrapLoaded, true);
});


test('system permission diagnostics are read-only and preserve denied, undecided and unsupported states', async () => {
  const f = fixture();
  assert.deepEqual((await f.controller.request('status')).systemMediaPermissions,
    {camera: 'unavailable', microphone: 'unavailable', screen: 'unavailable'});
  const reads = [];
  f.electron.systemPreferences = {getMediaAccessStatus(kind) {
    reads.push(kind);
    if (kind === 'screen') throw new Error('unsupported');
    return kind === 'camera' ? 'denied' : 'not-determined';
  }, askForMediaAccess() {assert.fail('Observation must never request access');}};
  assert.deepEqual((await f.controller.request('status')).systemMediaPermissions,
    {camera: 'denied', microphone: 'not-determined', screen: 'unavailable'});
  assert.deepEqual(reads, ['camera', 'microphone', 'screen']);
  f.electron.systemPreferences.getMediaAccessStatus = () => 'unexpected';
  assert.equal((await f.controller.request('status')).systemMediaPermissions.camera, 'unavailable');
});


test('presentation distinguishes native visibility from readiness without exposing unrelated windows', async () => {
  const f = fixture(), wc = f.view(); await f.controller.request('bind', payload());
  wc.isFocused = () => false;
  const view = {webContents: wc, children: [], getVisible: () => false,
    getBounds: () => ({x: 20, y: 40, width: 300, height: 500, secret: 'omit'})};
  const window = {id: 7, title: 'private title', contentView: {children: [view]},
    isVisible: () => true, isMinimized: () => false, isFocused: () => true};
  f.electron.BrowserWindow = {getAllWindows: () => [window, {title: 'unrelated', contentView: {children: []}}]};
  const status = await f.controller.request('status');
  assert.equal(status.bindings[0].ready, true);
  assert.deepEqual(status.bindings[0].presentation, {matches: 1, viewVisible: false,
    bounds: {x: 20, y: 40, width: 300, height: 500}, windowId: 7,
    windowVisible: true, windowMinimized: false, windowFocused: true, contentsFocused: false});
  assert(!JSON.stringify(status).includes('private title'));
  assert(!JSON.stringify(status).includes('unrelated'));
  assert(!JSON.stringify(status).includes('omit'));
  view.getVisible = () => true;
  assert.equal((await f.controller.request('status')).bindings[0].presentation.viewVisible, true);
  view.getBounds = () => {throw Error('retired native object');};
  assert.equal((await f.controller.request('status')).bindings[0].presentation.bounds, null);
  window.contentView.children = [{children: [view]}];
  view.getBounds = () => ({x: 0, y: 0, width: NaN, height: 50});
  assert.equal((await f.controller.request('status')).bindings[0].presentation.bounds, null);
});


test('permission diagnostics preserve vendor consent and refusals with bounded sanitized history', async () => {
  const f = fixture(), wc = f.view(); await f.controller.request('bind', payload());
  let vendorAnswer, answer;
  f.session.setPermissionRequestHandler((_wc, _permission, callback) => {vendorAnswer = callback;});
  const details = {securityOrigin: ORIGIN, requestingUrl: ORIGIN + '/private?secret=hidden', mediaTypes: ['audio', 'private-value']};
  f.session.requestPermission(wc, 'media', value => {answer = value;}, details);
  let events = (await f.controller.request('status')).bindings[0].permissionEvents;
  assert.deepEqual(events.map(e => e.phase), ['requested', 'delegated']);
  assert.equal(answer, undefined, 'No implicit grant while vendor consent is pending');
  assert.deepEqual(events[0].mediaTypes, ['audio']);
  assert(!JSON.stringify(events).includes('private'));
  vendorAnswer(false); assert.equal(answer, false);
  events = (await f.controller.request('status')).bindings[0].permissionEvents;
  assert.equal(events.at(-1).decision, false);
  events[0].mediaTypes.push('mutated');
  assert.deepEqual((await f.controller.request('status')).bindings[0].permissionEvents[0].mediaTypes, ['audio']);
  f.session.setPermissionRequestHandler(() => assert.fail('Foreign requests must not reach vendor consent'));
  for (let i = 0; i < 20; i++) f.session.requestPermission(wc, 'media', value => assert.equal(value, false), {...details, securityOrigin: 'https://foreign.test'});
  events = (await f.controller.request('status')).bindings[0].permissionEvents;
  assert.equal(events.length, 16); assert.equal(events.at(-1).decision, false);
});
