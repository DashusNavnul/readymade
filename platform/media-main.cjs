'use strict';
const fs = require('node:fs'), net = require('node:net'), path = require('node:path');
const policy = require('./media-policy.cjs');
const hooks = require('./media-session.cjs');
const LIMIT = 65536;
const publicState = (bound, pending = false) => ({ id: bound.wcId, bindingId: bound.bindingId, origin: bound.origin, pending,
  kind: bound.kind, requestedURL: bound.url, url: bound.wc.isDestroyed() ? bound.url : bound.wc.getURL(), ready: bound.ready, fault: bound.fault });
function createController(electron) {
  const watchers = new Map(), pending = new Map();
  const state = bound => publicState(bound, !!pending.get(bound.bindingId));
  const markPending = (id, change) => { if (id) { const count = (pending.get(id) || 0) + change;
    if (count > 0) pending.set(id, count); else pending.delete(id); } };
  const bootstrapViews = () => {
    const views = electron.webContents.getAllWebContents().filter(wc => !wc.isDestroyed()), result = [];
    for (const wc of views) {
      try {
        const url = wc.getURL(); if (!/^about:blank#readymade-[a-f0-9]{32}$/.test(url)) continue;
        const session = wc.session, prefs = wc.getLastWebPreferences();
        result.push({ id: wc.id, url, sandbox: prefs.sandbox ?? null, contextIsolation: prefs.contextIsolation ?? null,
          nodeIntegration: prefs.nodeIntegration ?? null, ephemeral: typeof session.getStoragePath === 'function' && !session.getStoragePath(),
          hooked: context.sessions.has(session), sameSessionViews: views.filter(other => !other.isDestroyed() && other.session === session).length });
      } catch { /* A view disappearing during diagnostics contributes no native properties. */ }
    }
    return result;
  };
  const context = { electron, sessions: new Map(), bindings: new Map(), byContents: new Map(),
    capture: (request, wc) => hooks.chooseCapture(electron, request, wc),
    emit: (bound, event) => { for (const send of watchers.get(bound.bindingId) || []) send(event); },
    changed: bound => context.emit(bound, { type: 'state', ...state(bound) }),
    closeBinding: bound => {
      if (bound.cleanup) return bound.cleanup;
      const session = bound.session, managed = context.sessions.get(session);
      markPending(bound.bindingId, 1); bound.ready = false; bound.fault = 'closed'; context.changed(bound);
      bound.cleanup = (async () => {
        try {
          await bound.operation?.catch(() => {});
          for (const [name, cookie] of managed || []) if (cookie.origin === bound.origin) {
            await session.cookies.remove(bound.origin + '/', name); managed.delete(name);
          }
          context.sessions.delete(session); context.byContents.delete(bound.wcId);
          context.bindings.delete(bound.bindingId); watchers.delete(bound.bindingId);
        } catch { bound.fault = 'outcomeUnknown'; context.changed(bound); throw new Error('outcomeUnknown'); }
        finally { markPending(bound.bindingId, -1); }
      })();
      return bound.cleanup;
    } };
  async function request(op, payload = {}, send = () => {}) {
    if (op === 'status') return { protocol: 1, nativeName: electron.app?.getName?.() ?? null,
      nativeWindowCount: electron.BrowserWindow?.getAllWindows?.().length ?? null,
      bindings: [...context.bindings.values()].map(state), bootstrapViews: bootstrapViews() };
    if (op === 'bind') {
      const data = policy.binding(payload);
      if (context.bindings.has(data.bindingId)) throw new Error('alreadyBound');
      if (context.bindings.size >= 32) throw new Error('bindingCapacity');
      const candidates = electron.webContents.getAllWebContents().filter(wc => !wc.isDestroyed() && wc.getURL() === data.bootstrapURL);
      if (candidates.length !== 1) throw new Error('bootstrapNotFound');
      const wc = candidates[0], wcId = wc.id, session = wc.session, prefs = wc.getLastWebPreferences();
      if (prefs.sandbox !== true || prefs.contextIsolation !== true || prefs.nodeIntegration !== false ||
          context.byContents.has(wcId) || !context.sessions.has(session) ||
          typeof session.getStoragePath !== 'function' || session.getStoragePath() ||
          electron.webContents.getAllWebContents().filter(other => !other.isDestroyed() && other.session === session).length !== 1) throw new Error('unsafeView');
      const managed = context.sessions.get(session);
      for (const cookie of data.cookies) if (managed.has(cookie.name) && managed.get(cookie.name).origin !== data.origin) throw new Error('cookieOriginConflict');
      const bound = { ...data, wc, wcId, session, ready: false, fault: null }; delete bound.cookies;
      context.bindings.set(data.bindingId, bound); context.byContents.set(wcId, bound);
      if (!watchers.has(bound.bindingId)) watchers.set(bound.bindingId, new Set());
      watchers.get(bound.bindingId).add(send);
      // Reserve identity before any mutation. A partial outcome remains inspectable, never retried.
      bound.operation = (async () => {
        for (const cookie of data.cookies) {
          if (wc.isDestroyed() || bound.cleanup) throw new Error('closed');
          managed.set(cookie.name, { origin: data.origin });
          await session.cookies.set(cookie);
        }
        if (wc.isDestroyed() || bound.cleanup) throw new Error('closed');
        await wc.loadURL(data.url);
        bound.ready = !bound.cleanup && !wc.isDestroyed() && policy.approved(wc.getURL(), bound.origin, bound.kind);
      })();
      try { await bound.operation; }
      catch { if (!bound.cleanup) bound.fault = 'outcomeUnknown'; context.changed(bound); throw new Error('outcomeUnknown'); }
      context.changed(bound); return state(bound);
    }
    if (op === 'forget') {
      const target = policy.origin(payload.origin);
      const ids = payload.bindingIds;
      if (!Array.isArray(ids) || !ids.length || ids.length > 8 || new Set(ids).size !== ids.length ||
          ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))) throw new Error('invalidBinding');
      // Closed bindings leave the map only after cookie cleanup; unknown IDs never broaden the supplied scope.
      const scope = ids.map(id => context.bindings.get(id)).filter(Boolean);
      if (scope.some(bound => bound.origin !== target)) throw new Error('bindingMissing');
      const cleanups = scope.map(bound => context.closeBinding(bound));
      for (const bound of scope) if (!bound.wc.isDestroyed()) bound.wc.close();
      await Promise.all(cleanups);
      return { forgotten: true };
    }
    if (!/^[a-f0-9]{32}$/.test(payload.bindingId)) throw new Error('invalidBinding');
    const bound = context.bindings.get(payload.bindingId);
    if (op === 'observe') {
      if (!bound) return { bindingId: payload.bindingId, exists: false, pending: !!pending.get(payload.bindingId) };
      if (!watchers.has(bound.bindingId)) watchers.set(bound.bindingId, new Set());
      watchers.get(bound.bindingId).add(send); return state(bound);
    }
    if (op !== 'navigate') throw new Error('invalidOperation');
    if (!bound || bound.wc.isDestroyed()) throw new Error('bindingMissing');
    if (!policy.approved(payload.url, bound.origin, bound.kind)) throw new Error('invalidURL');
    if (bound.fault) throw new Error('bindingFault');
    bound.ready = false; bound.url = payload.url; context.changed(bound);
    bound.operation = bound.wc.loadURL(payload.url);
    try { await bound.operation; bound.ready = !bound.cleanup && !bound.wc.isDestroyed() && policy.approved(bound.wc.getURL(), bound.origin, bound.kind); }
    catch { bound.fault = 'outcomeUnknown'; context.changed(bound); throw new Error('outcomeUnknown'); }
    context.changed(bound); return state(bound);
  }
  return { context, request, markPending, isPending: id => !!pending.get(id),
    unwatch: send => { for (const values of watchers.values()) values.delete(send); } };
}
async function startServer(electron, controller) {
  const directory = electron.app.getPath('userData');
  const stat = await fs.promises.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('unsafeDirectory');
  const socketPath = path.join(directory, 'readymade-media.sock');
  if (Buffer.byteLength(socketPath) > 103) throw new Error('socketPathTooLong');
  try { await fs.promises.lstat(socketPath); throw new Error('socketExists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let owned; let queue = Promise.resolve(); const clients = new Set();
  const server = net.createServer(socket => {
    if (clients.size >= 16) { socket.destroy(); return; }
    clients.add(socket); socket.setTimeout(60000, () => socket.destroy());
    let pending = 0, bytes = Buffer.alloc(0);
    const send = value => { if (!socket.destroyed && socket.writableLength < LIMIT * 2) socket.write(JSON.stringify(value) + '\n'); else socket.destroy(); };
    socket.on('data', data => {
      bytes = Buffer.concat([bytes, data]);
      for (;;) {
        const end = bytes.indexOf(10);
        if (end < 0) { if (bytes.length > LIMIT) socket.destroy(); break; }
        if (end > LIMIT || ++pending > 16) { socket.destroy(); break; }
        const line = bytes.subarray(0, end); bytes = bytes.subarray(end + 1);
        let message; try { message = JSON.parse(line.toString('utf8')); } catch { socket.destroy(); break; }
        if (!message || !/^[a-f0-9]{32}$/.test(message.id) || !['status', 'bind', 'navigate', 'observe', 'forget'].includes(message.op) ||
            (message.payload !== undefined && (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)))) { socket.destroy(); break; }
        const bindingId = ['bind', 'navigate'].includes(message.op) ? message.payload?.bindingId : null;
        controller.markPending(bindingId, 1);
        const execute = async () => {
          let result, errorCode;
          try { if (!socket.destroyed) result = await controller.request(message.op, message.payload, send); }
          catch (error) { errorCode = /^(invalidOrigin|invalidBinding|invalidURL|invalidCookies|alreadyBound|bootstrapNotFound|unsafeView|cookieOriginConflict|outcomeUnknown|invalidOperation|bindingMissing|bindingFault|bindingCapacity)$/.test(error.message) ? error.message : 'requestFailed'; }
          finally { controller.markPending(bindingId, -1); }
          if (result && bindingId) result.pending = controller.isPending(bindingId);
          if (result) send({ id: message.id, ok: true, result });
          else if (errorCode) send({ id: message.id, ok: false, error: errorCode });
        };
        if (['status', 'observe'].includes(message.op)) execute().finally(() => { pending--; });
        else queue = queue.then(execute).finally(() => { pending--; });
      }
    });
    socket.on('error', () => {}); socket.on('close', () => { clients.delete(socket); controller.unwatch(send); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.promises.chmod(socketPath, 0o600); owned = await fs.promises.lstat(socketPath);
  const close = () => {
    for (const socket of clients) socket.destroy(); server.close();
    try { const current = fs.lstatSync(socketPath); if (current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(socketPath); } catch {}
  };
  return { server, socketPath, close };
}
function install(electron) {
  const controller = createController(electron);
  electron.app.on('session-created', session => hooks.installSession(session, controller.context));
  electron.app.on('web-contents-created', (_event, wc) => hooks.installContents(wc, controller.context));
  let server;
  electron.app.whenReady().then(async () => { server = await startServer(electron, controller); }, () => {}).catch(() => {});
  electron.app.on('will-quit', () => server?.close());
  return controller;
}
module.exports = { install, createController, startServer, publicState };
