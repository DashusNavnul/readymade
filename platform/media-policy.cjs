'use strict';
// Pure admission rules. This adapter carries presentation cookies, never login codes.
const fail = code => { throw new Error(code); };
const roots = { glurff: '/apps/glurff', noltbook: '/apps/noltbook', landscape: '/apps/landscape', groups: '/apps/groups', lattice: '/apps/lattice', call: '/apps/call' };
function origin(value) {
  let url; try { url = new URL(value); } catch { fail('invalidOrigin'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) fail('invalidOrigin');
  return url.origin;
}
function approved(value, boundOrigin, kind, login = false) {
  try {
    const url = new URL(value), root = roots[kind];
    return !!root && !url.username && !url.password && url.origin === boundOrigin &&
      (url.pathname === root || url.pathname.startsWith(root + '/') ||
       (login && ['/~/login', '/~/login/'].includes(url.pathname)));
  } catch { return false; }
}
function anyApp(value, boundOrigin) {
  return Object.keys(roots).some(kind => approved(value, boundOrigin, kind));
}
function binding(payload) {
  if (!payload || !/^[a-f0-9]{32}$/.test(payload.bindingId) || !roots[payload.kind] ||
      payload.bootstrapURL !== 'about:blank#readymade-' + payload.bindingId) fail('invalidBinding');
  const boundOrigin = origin(payload.origin);
  if (!approved(payload.url, boundOrigin, payload.kind)) fail('invalidURL');
  if (!Array.isArray(payload.cookies) || !payload.cookies.length || payload.cookies.length > 8) fail('invalidCookies');
  const seen = new Set();
  const cookies = payload.cookies.map(cookie => {
    if (!cookie || !/^urbauth-~[a-z][a-z-]{1,100}$/.test(cookie.name) || seen.has(cookie.name) ||
        typeof cookie.value !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(cookie.value) ||
        /[;,]/.test(cookie.value) || (cookie.expires !== undefined &&
        (!Number.isFinite(cookie.expires) || cookie.expires <= Date.now() / 1000))) fail('invalidCookies');
    seen.add(cookie.name);
    return { url: boundOrigin + '/', name: cookie.name, value: cookie.value, path: '/',
      httpOnly: true, secure: boundOrigin.startsWith('https:'), sameSite: 'lax' };
  });
  return { bindingId: payload.bindingId, bootstrapURL: payload.bootstrapURL,
    origin: boundOrigin, kind: payload.kind, url: payload.url, cookies };
}
function stripCookies(headers, requestURL, managed) {
  const next = { ...headers }; let target;
  try { target = new URL(requestURL).origin; } catch { target = null; }
  for (const key of Object.keys(next)) if (key.toLowerCase() === 'cookie') {
    const values = Array.isArray(next[key]) ? next[key] : [next[key]];
    const value = values.join('; ').split(';').map(part => part.trim()).filter(part => {
      const name = part.slice(0, part.indexOf('='));
      return !managed.has(name) || managed.get(name).origin === target;
    }).join('; ');
    if (value) next[key] = value; else delete next[key];
  }
  return next;
}
module.exports = { origin, approved, anyApp, binding, stripCookies };
