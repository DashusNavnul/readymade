'use strict';
const policy = require('./media-policy.cjs');
const os = require('node:os');
function captureCapabilities(platform = process.platform, kernel = os.release(), electronVersion = process.versions.electron || '0') {
  const [major, minor = 0] = kernel.split('.').map(Number), electron = Number(electronVersion.split('.')[0]);
  // Darwin 24 is macOS 15; Darwin 23.2 is macOS 14.2.
  return { nativePicker: platform === 'darwin' && major >= 24 && electron >= 39,
    loopback: platform === 'win32' || (platform === 'darwin' && electron >= 39 && (major > 23 || (major === 23 && minor >= 2))) };
}
function installSession(session, context) {
  // Global/workspace browser storage stays entirely under upstream's policies.
  if (typeof session.getStoragePath !== 'function' || session.getStoragePath()) return;
  const managed = new Map(); context.sessions.set(session, managed);
  context.mediaSessions ||= new WeakMap();
  const bindingFor = wc => wc && !wc.isDestroyed() && context.byContents.get(wc.id);
  const allowed = (wc, details = {}, fallback) => {
    const bound = bindingFor(wc);
    if (!bound) return true;
    const requested = details.securityOrigin || details.requestingUrl || fallback;
    try { return new URL(requested).origin === bound.origin &&
      policy.approved(wc.getURL(), bound.origin, bound.kind); } catch { return false; }
  };
  for (const method of ['setPermissionRequestHandler', 'setPermissionCheckHandler']) {
    const original = session[method].bind(session);
    session[method] = handler => original(method === 'setPermissionRequestHandler' ?
      (wc, permission, callback, details) => {
        if (!allowed(wc, details)) return callback(false);
        if (bindingFor(wc) && (permission === 'display-capture' || (permission === 'media' &&
            Array.isArray(details?.mediaTypes) && details.mediaTypes.length === 0))) return callback(details?.isMainFrame === true);
        return handler ? handler(wc, permission, callback, details) : callback(false);
      } : (wc, permission, requestingOrigin, details) =>
        allowed(wc, details, requestingOrigin) && ((bindingFor(wc) && permission === 'display-capture' && details?.isMainFrame === true) ||
        !!handler?.(wc, permission, requestingOrigin, details)));
    session[method](null);
  }
  // Electron retains one listener. Compose the vendor callback, including later registrations.
  const register = session.webRequest.onBeforeSendHeaders.bind(session.webRequest);
  session.webRequest.onBeforeSendHeaders = (filter, listener) => {
    if (typeof filter === 'function' || filter === null) { listener = filter; filter = undefined; }
    const wrapped = (details, callback) => {
      const finish = (result = {}) => callback({ ...result,
        requestHeaders: policy.stripCookies(result.requestHeaders || details.requestHeaders, details.url, managed) });
      const matches = !filter?.urls || filter.urls.some(pattern => pattern === '<all_urls>' ||
        new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(details.url));
      if (listener && matches) listener(details, finish); else finish();
    };
    return register(wrapped);
  };
  session.webRequest.onBeforeSendHeaders(null);
  const originalDisplay = session.setDisplayMediaRequestHandler.bind(session);
  const originalNative = session._setDisplayMediaRequestHandler?.bind(session);
  const capabilities = () => context.captureCapabilities?.() || captureCapabilities();
  const soleOwner = () => {
    const views = context.electron.webContents.getAllWebContents().filter(wc => !wc.isDestroyed() && wc.session === session);
    return views.length === 1 ? bindingFor(views[0]) : null;
  };
  const admitted = request => {
    const frame = request.frame;
    let wc; try { wc = frame && context.electron.webContents.fromFrame(frame); } catch { return null; }
    const bound = bindingFor(wc);
    return bound && request.userGesture && frame === frame.top &&
      allowed(wc, { securityOrigin: request.securityOrigin }) ? wc : null;
  };
  let nativePicker = false;
  // Pinned Electron 43 session.ts routes the system picker around its public handler.
  // Fence its native registration too, before that wrapper chooses a source.
  if (originalNative) session._setDisplayMediaRequestHandler = handler => {
    const usesPicker = nativePicker;
    return originalNative(handler && ((request, callback) => {
      const answer = streams => { try { callback(streams); } catch {} };
      if (!usesPicker) return handler(request, answer);
      const owner = soleOwner(), wc = admitted(request);
      if (!owner || !wc || wc !== owner.wc) return answer({});
      confirmCapture(context.electron, request, wc, capabilities()).then(choice => {
        if (!choice || soleOwner() !== owner || admitted(request) !== wc) return answer({});
        handler(request, streams => {
          if (!streams?.video) return answer(streams);
          const selected = { ...streams }; delete selected.audio;
          answer(choice.audio ? { ...selected, audio: 'loopback' } : selected);
        });
      }, () => answer({}));
    }));
  };
  let vendorHandler = null;
  const dispatch = (request, callback) => {
    const answer = streams => { try { callback(streams); } catch {} };
    const frame = request.frame;
    let wc; try { wc = frame && context.electron.webContents.fromFrame(frame); } catch { return answer({}); }
    const bound = bindingFor(wc);
    if (!bound) return vendorHandler ? vendorHandler(request, answer) : answer({});
    if (!admitted(request)) return answer({});
    context.capture(request, wc).then(streams => {
      if (bindingFor(wc) !== bound || wc.isDestroyed() ||
          !allowed(wc, { securityOrigin: request.securityOrigin })) return answer({});
      answer(streams);
    }, () => answer({}));
  };
  const refresh = () => {
    nativePicker = !!originalNative && capabilities().nativePicker && !!soleOwner();
    originalDisplay(dispatch, { useSystemPicker: nativePicker });
  };
  context.mediaSessions.set(session, refresh);
  session.setDisplayMediaRequestHandler = handler => { vendorHandler = handler; refresh(); };
  session.setDisplayMediaRequestHandler(null);
}
function installContents(wc, context) {
  const wcId = wc.id, session = wc.session;
  context.mediaSessions?.get(session)?.();
  const loadURL = wc.loadURL.bind(wc);
  wc.loadURL = (url, ...options) => {
    const bound = context.byContents.get(wcId);
    if (bound && !policy.approved(url, bound.origin, bound.kind, true)) return Promise.reject(new Error('invalidURL'));
    context.mediaSessions?.get(session)?.();
    return loadURL(url, ...options);
  };
  const original = wc.setWindowOpenHandler.bind(wc);
  wc.setWindowOpenHandler = handler => original(details => {
    const bound = context.byContents.get(wcId);
    if (!bound) return handler ? handler(details) : { action: 'deny' };
    if (policy.anyApp(details.url, bound.origin)) context.emit(bound, { type: 'open', bindingId: bound.bindingId, url: details.url });
    else if (!details.postBody) confirmExternal(context, bound, details.url).catch(() => {});
    return { action: 'deny' };
  });
  wc.setWindowOpenHandler(null);
  for (const event of ['will-navigate', 'will-redirect']) wc.on(event, (e, url) => {
    const bound = context.byContents.get(wcId);
    const target = typeof url === 'string' ? url : e.url;
    if (bound && !policy.approved(target, bound.origin, bound.kind, true)) {
      e.preventDefault();
      if (event === 'will-navigate' && e.isMainFrame !== false &&
          ['glurff', 'noltbook', 'landscape'].some(kind => policy.approved(target, bound.origin, kind)))
        context.emit(bound, { type: 'open', bindingId: bound.bindingId, url: target });
    }
  });
  wc.on('did-finish-load', () => {
    const bound = context.byContents.get(wcId);
    if (bound && !bound.cleanup) { bound.ready = policy.approved(wc.getURL(), bound.origin, bound.kind); context.changed(bound); }
  });
  wc.once('destroyed', () => {
    const bound = context.byContents.get(wcId);
    if (bound) context.closeBinding(bound).catch(() => {});
    else if (!context.electron.webContents.getAllWebContents().some(other => !other.isDestroyed() && other.session === session))
      context.sessions.delete(session);
    context.mediaSessions?.get(session)?.();
  });
}
async function confirmExternal(context, bound, value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) return;
  let target; try { target = new URL(value); } catch { return; }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || bound.externalPrompt) return;
  const current = () => !bound.wc.isDestroyed() && !bound.cleanup && !bound.fault &&
    context.byContents.get(bound.wcId) === bound && policy.approved(bound.wc.getURL(), bound.origin, bound.kind);
  if (!current()) return;
  bound.externalPrompt = true;
  try {
    const { electron } = context, parent = electron.BrowserWindow.fromWebContents(bound.wc);
    const options = { type: 'question', title: 'Open external link', message: bound.origin + ' requests an external browser',
      detail: target.href, buttons: ['Cancel', 'Open Browser'], defaultId: 0, cancelId: 0 };
    const choice = parent ? await electron.dialog.showMessageBox(parent, options) : await electron.dialog.showMessageBox(options);
    if (choice.response === 1 && current()) await electron.shell.openExternal(target.href);
  } finally { bound.externalPrompt = false; }
}
async function confirmCapture(electron, request, wc, capabilities = captureCapabilities()) {
  const options = { type: 'question', title: 'Share your screen', message: request.securityOrigin + ' wants to share your screen',
    buttons: ['Cancel', 'Choose screen or window'], defaultId: 0, cancelId: 0,
    ...(request.audioRequested && capabilities.loopback ? { checkboxLabel: 'Share system audio', checkboxChecked: false } : {}) };
  const parent = electron.BrowserWindow.fromWebContents(wc);
  const choice = parent ? await electron.dialog.showMessageBox(parent, options) : await electron.dialog.showMessageBox(options);
  return choice.response === 1 ? { audio: !!options.checkboxLabel && choice.checkboxChecked === true } : null;
}
async function chooseCapture(electron, request, wc) {
  const sources = await electron.desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
  if (!sources.length || sources.length > 100 || wc.isDestroyed()) return {};
  const parent = electron.BrowserWindow.fromWebContents(wc);
  const options = { type: 'question', title: 'Share your screen', message: request.securityOrigin + ': choose what to share',
    buttons: ['Cancel', ...sources.map(source => source.name.slice(0, 120))], defaultId: 0, cancelId: 0,
    ...(request.audioRequested && captureCapabilities().loopback ? { checkboxLabel: 'Share system audio', checkboxChecked: false } : {}) };
  const choice = parent ? await electron.dialog.showMessageBox(parent, options) : await electron.dialog.showMessageBox(options);
  if (choice.response < 1 || choice.response > sources.length) return {};
  return { video: sources[choice.response - 1],
    ...(request.audioRequested && captureCapabilities().loopback && choice.checkboxChecked ? { audio: 'loopback' } : {}) };
}
module.exports = { installSession, installContents, chooseCapture, captureCapabilities, confirmCapture };
