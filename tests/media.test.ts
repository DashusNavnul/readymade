import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaController, mediaURL, type MediaTab, type MediaBridge } from '../src/media-controller';
import type { JsonObject } from '../src/protocol';

function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture() {
  const origin = 'https://media.example', opened: MediaTab[] = [], revealed: MediaTab[] = [], closed: MediaTab[] = [], externallyClosed = new Set<MediaTab>();
  const requests: { op: string; payload: JsonObject }[] = [], bindings = new Map<string, JsonObject>(), order: string[] = [];
  const controls = { uncertain: '', auth: true, signs: 0, refuseAuth: false, closeFails: false, bindWait: undefined as undefined | ReturnType<typeof held<void>>, observe: undefined as JsonObject | undefined };
  const client = { origin, signIn: async () => { controls.signs++; if (controls.refuseAuth) throw new Error('No saved code'); controls.auth = true; }, browserCookies: (selected: string) => {
    assert.equal(selected, origin); if (!controls.auth) throw new Error('authenticationRequired');
    return [{ name: 'urbauth-~zod', value: 'private-test-cookie' }];
  } };
  const bridge: MediaBridge = { request: async (op, payload = {}) => {
    requests.push({ op, payload });
    if (op === 'bind') {
      const value = { bindingId: payload.bindingId, origin, kind: payload.kind, requestedURL: payload.url, url: payload.url, ready: true, fault: null };
      bindings.set(payload.bindingId as string, value); await controls.bindWait?.promise;
      if (controls.uncertain === op) throw new Error('reply lost'); return value;
    }
    if (op === 'navigate') { if (controls.uncertain === op) throw new Error('reply lost'); return bindings.get(payload.bindingId as string)!; }
    if (op === 'observe') return controls.observe ?? bindings.get(payload.bindingId as string) ?? { bindingId: payload.bindingId, exists: false };
    if (op === 'forget') {
      order.push('forget'); if (controls.uncertain === op) throw new Error('reply lost');
      for (const id of payload.bindingIds as string[]) bindings.delete(id); return { forgotten: true };
    }
    return { protocol: 1, bindings: [...bindings.values()] };
  } };
  const controller = new MediaController({ client, bridge, browser: {
    open: async url => { const tab = Object.freeze({ url }); opened.push(tab); return tab; },
    reveal: async tab => { revealed.push(tab); }, close: async tab => { order.push('close'); if (controls.closeFails) throw new Error('Tab handle unavailable'); closed.push(tab); },
    isClosed: tab => externallyClosed.has(tab),
  } });
  return { origin, controller, requests, opened, revealed, closed, controls, client, bindings, bridge, order, externallyClosed };
}

test('media remains lazy; repeated Open and Reveal retain exact tab and never navigate or sign in again', async () => {
  const f = fixture(); assert.equal(f.requests.length, 0); assert.equal(f.opened.length, 0);
  const first = await f.controller.open('glurff');
  assert.equal(first.phase, 'bound'); assert.match(f.opened[0].url, /^about:blank#readymade-[a-f0-9]{32}$/);
  const again = await f.controller.open('glurff'); await f.controller.reveal(first.bindingId);
  assert.equal(first.bindingId, again.bindingId); assert.equal(f.opened.length, 1);
  assert.deepEqual(f.revealed, [f.opened[0], f.opened[0]]); assert.deepEqual(f.requests.map(r => r.op), ['bind']);
  assert.equal(f.controls.signs, 0, 'Existing authenticated client was reset');
  assert.equal(JSON.stringify(f.controller.state()).includes('private-test-cookie'), false);
});

test('explicit Open after user X creates a new owner only when the browser conclusively confirms closure', async () => {
  const f = fixture(), first = await f.controller.open('glurff');
  f.externallyClosed.add(f.opened[0]); f.bindings.delete(first.bindingId);
  const next = await f.controller.open('glurff');
  assert.notEqual(next.bindingId, first.bindingId); assert.equal(next.phase, 'bound');
  assert.notEqual(f.opened[0], f.opened[1]); assert.notEqual(f.opened[0].url, f.opened[1].url);
  assert.deepEqual(f.controller.state().map(row => row.bindingId), [next.bindingId]);
  assert.deepEqual(f.requests.map(row => row.op), ['bind', 'bind']); assert.equal(f.closed.length, 0);
  assert.equal(f.revealed.length, 0, 'The closed browser handle was revealed');
});

test('an unknown live handle stays retained; closing it does not create a replacement until explicit Open', async () => {
  const f = fixture(); f.controls.uncertain = 'bind';
  const first = await f.controller.open('noltbook'); assert.equal(first.phase, 'unknown');
  assert.equal((await f.controller.open('noltbook')).bindingId, first.bindingId);
  assert.equal(f.opened.length, 1); assert.equal(f.requests.length, 1);
  f.externallyClosed.add(f.opened[0]); f.bindings.delete(first.bindingId);
  assert.equal(f.controller.state()[0].bindingId, first.bindingId); assert.equal(f.requests.length, 1);
  f.controls.uncertain = ''; const next = await f.controller.open('noltbook');
  assert.notEqual(next.bindingId, first.bindingId); assert.equal(f.opened.length, 2);
  assert.deepEqual(f.requests.map(row => row.op), ['bind', 'bind']);
});

test('native readiness timeout preserves its exact unbound tab without bind, reload, or automatic close', async () => {
  const f = fixture(), retained = new Map<string, MediaTab>(), closed: MediaTab[] = [], revealed: MediaTab[] = [];
  let opens = 0;
  const controller = new MediaController({ client: f.client, bridge: f.bridge, browser: {
    open: async url => { opens++; retained.set(url, { url }); throw new Error('Native bootstrap readiness timed out'); },
    retained: url => retained.get(url), reveal: async tab => { revealed.push(tab); }, close: async tab => { closed.push(tab); }, isClosed: () => false,
  } });
  const row = await controller.open('glurff'); assert.equal(row.phase, 'unknown');
  const tab = retained.get('about:blank#readymade-' + row.bindingId)!;
  assert.ok(tab); assert.equal(closed.length, 0); assert.equal(f.requests.length, 0);
  assert.equal((await controller.open('glurff')).bindingId, row.bindingId); assert.deepEqual(revealed, [tab]); assert.equal(opens, 1);
  await assert.rejects(controller.reconnect(row.bindingId)); assert.equal(f.requests.length, 0);
  await controller.disconnect(); assert.deepEqual(closed, [tab]); assert.equal(f.requests.length, 0, 'Unattempted native bind was forgotten');
});

test('explicit disconnect still releases a late-created unbound tab when native readiness subsequently times out', async () => {
  const f = fixture(), wait = held<void>(), retained = new Map<string, MediaTab>(), closed: MediaTab[] = [];
  const controller = new MediaController({ client: f.client, bridge: f.bridge, browser: {
    open: async url => { await wait.promise; retained.set(url, { url }); throw new Error('Native bootstrap readiness timed out'); },
    retained: url => retained.get(url), reveal: async () => {}, close: async tab => { closed.push(tab); },
  } });
  const opening = controller.open('glurff'); await controller.disconnect(); wait.resolve(); await opening;
  assert.equal(closed.length, 1); assert.equal(controller.state().length, 0); assert.equal(f.requests.length, 0);
});

test('exact note and room bytes survive bind; automatic joins and foreign routes never open', async () => {
  const f = fixture(), note = `${f.origin}/apps/noltbook/?note=note-a%2Fb&room=red%20room#L2%3A4`;
  await f.controller.open('noltbook', note); assert.equal(f.requests[0].payload.url, note);
  const room = `${f.origin}/apps/call?room=red%20room#marker`; await f.controller.open('call', room);
  assert.equal(f.requests[1].payload.url, room); assert.notEqual(f.opened[0].url, f.opened[1].url);
  for (const url of ['/apps/call?auto=1', '/apps/call?%61uto=0', 'https://foreign.example/apps/call', 'https://a@media.example/apps/call', '/apps/call/%2e%2e/glurff/', '/apps/call?room=x\n', '/apps/call?room=\ud800']) {
    await assert.rejects(f.controller.open('call', url));
  }
  assert.equal(f.opened.length, 2);
  assert.equal(mediaURL(f.origin, 'noltbook', note), note);
});

test('app descendants and hash routes remain available without prefix confusion or normalized traversal', async () => {
  const f = fixture();
  for (const kind of ['glurff', 'noltbook', 'landscape', 'call'] as const) {
    const root = `/apps/${kind}`, target = f.origin + root + '/room/red%20door?note=note-a%2Fb#L2%3A4';
    assert.equal(mediaURL(f.origin, kind, target), target);
    assert.equal(mediaURL(f.origin, kind, root + '#/world/room'), f.origin + root + '#/world/room');
    for (const path of [root + '-other', root + 'ish/room', root + '/a/../room', root + '/%2e/room', root + '/a/.%2e/room', root + '/a%2froom', root + '/a%5croom', root + '/%zz']) {
      assert.throws(() => mediaURL(f.origin, kind, path));
    }
    assert.throws(() => mediaURL(f.origin, kind, 'https://foreign.example' + root + '/room'));
  }
  const row = await f.controller.open('glurff');
  f.controls.observe = { ...f.bindings.get(row.bindingId), url: f.origin + '/apps/glurff/world/~zod#room' };
  const observed = await f.controller.observe(row.bindingId);
  assert.equal(observed.phase, 'bound'); assert.equal(observed.currentURL, f.controls.observe.url); assert.equal(observed.url, row.url);
  const note = f.origin + '/apps/noltbook/room/view?note=red%2Fblue#range';
  assert.equal((await f.controller.handleOpen({ type: 'open', bindingId: row.bindingId, url: note }))?.url, note);
});

test('an early bound-page handoff waits for bind confirmation and keeps the original owner', async () => {
  const f = fixture(), wait = held<void>(); f.controls.bindWait = wait;
  const opening = f.controller.open('glurff');
  while (!f.requests.length) await new Promise(resolve => setImmediate(resolve));
  const bindingId = f.controller.state()[0].bindingId, url = f.origin + '/apps/noltbook/?note=early#room';
  const handoff = f.controller.handleOpen({ type: 'open', bindingId, url });
  assert.equal(f.opened.length, 1);
  f.controls.bindWait = undefined; wait.resolve(); await opening;
  assert.equal((await handoff)?.url, url); assert.equal(f.opened.length, 2); assert.equal(f.closed.length, 0);
  assert.deepEqual(f.requests.map(request => request.op), ['bind', 'bind']);
});

test('lost bind acknowledgment retains owner, blocks replay and allows observation before deliberate GET reconnect', async () => {
  const f = fixture(); f.controls.uncertain = 'bind';
  const row = await f.controller.open('glurff'); assert.equal(row.phase, 'unknown');
  await f.controller.open('glurff'); await assert.rejects(f.controller.reconnect(row.bindingId));
  assert.deepEqual(f.requests.map(r => r.op), ['bind']); assert.equal(f.opened.length, 1);
  f.controls.observe = { ...f.bindings.get(row.bindingId), pending: true };
  assert.equal((await f.controller.observe(row.bindingId)).phase, 'unknown'); await assert.rejects(f.controller.reconnect(row.bindingId));
  f.controls.observe = undefined; f.controls.uncertain = ''; assert.equal((await f.controller.observe(row.bindingId)).phase, 'bound');
  await f.controller.reconnect(row.bindingId);
  assert.deepEqual(f.requests.map(r => r.op), ['bind', 'observe', 'observe', 'navigate']);
  assert.deepEqual(f.requests[3].payload, { bindingId: row.bindingId, url: row.url });
});

test('unknown navigation cannot repeat, contradictory observations cannot unlock, missing binding requires explicit close', async () => {
  const f = fixture(), row = await f.controller.open('call'); f.controls.uncertain = 'navigate';
  assert.equal((await f.controller.reconnect(row.bindingId)).phase, 'unknown');
  await assert.rejects(f.controller.reconnect(row.bindingId));
  f.controls.observe = { ...f.bindings.get(row.bindingId), requestedURL: f.origin + '/apps/call?room=wrong' };
  await assert.rejects(f.controller.observe(row.bindingId)); assert.equal(f.controller.state()[0].phase, 'unknown');
  f.controls.observe = { bindingId: row.bindingId, exists: false };
  assert.equal((await f.controller.observe(row.bindingId)).phase, 'unknown'); await assert.rejects(f.controller.reconnect(row.bindingId));
  await f.controller.close(row.bindingId); assert.deepEqual(f.closed, [f.opened[0]]); assert.equal(f.controller.state().length, 0);
});

test('Noltbook handoff preserves Glurff and an existing note call; stale/foreign IDs cannot create a tab', async () => {
  const f = fixture(), glurff = await f.controller.open('glurff');
  const existing = await f.controller.open('noltbook', f.origin + '/apps/noltbook/?note=old');
  const url = f.origin + '/apps/noltbook/?note=new%2Fx#room';
  const target = await f.controller.handleOpen({ type: 'open', bindingId: glurff.bindingId, url });
  assert.equal(target?.url, url); assert.notEqual(target?.bindingId, existing.bindingId); assert.equal(f.closed.length, 0);
  assert.equal(f.requests.filter(r => r.op === 'navigate').length, 0);
  assert.equal(await f.controller.handleOpen({ type: 'open', bindingId: 'stale', url }), undefined);
  assert.equal(await f.controller.handleOpen({ type: 'open', bindingId: glurff.bindingId, url: 'https://foreign.example/apps/noltbook/' }), undefined);
  await f.controller.close(glurff.bindingId);
  assert.equal(await f.controller.handleOpen({ type: 'open', bindingId: glurff.bindingId, url }), undefined);
});

test('login observation is bound but not ready and never rewrites the requested note target', async () => {
  const f = fixture(), row = await f.controller.open('noltbook', f.origin + '/apps/noltbook/?note=protected#range');
  f.controls.observe = { ...f.bindings.get(row.bindingId), url: f.origin + '/~/login?redirect=%2Fapps%2Fnoltbook%2F', ready: false };
  const observed = await f.controller.observe(row.bindingId); assert.equal(observed.url, row.url); assert.equal(observed.ready, false);
  assert.match(observed.currentURL!, /\/~\/login/);
  f.controls.observe.ready = true; await assert.rejects(f.controller.observe(row.bindingId));
});

test('disconnect closes only owned tabs and exact-origin cookies, ignoring late bind results and old owners', async () => {
  const f = fixture(), wait = held<void>(); f.controls.bindWait = wait;
  const opening = f.controller.open('glurff');
  while (!f.requests.length) await new Promise(resolve => setImmediate(resolve));
  await f.controller.disconnect(); wait.resolve(); await opening;
  assert.deepEqual(f.closed, [f.opened[0]]); assert.equal(f.controller.state().length, 0);
  assert.deepEqual(f.requests.at(-1), { op: 'forget', payload: { origin: f.origin, bindingIds: [f.requests[0].payload.bindingId] } });
  assert.deepEqual(f.order, ['forget', 'close']);
  await assert.rejects(f.controller.open('glurff'));
});

test('disconnect scopes exact binding IDs before closing handles and preserves another same-origin controller', async () => {
  const f = fixture(), siblingTabs: MediaTab[] = [], siblingClosed: MediaTab[] = [];
  const sibling = new MediaController({ client: f.client, bridge: f.bridge, browser: {
    open: async url => { const tab = { url }; siblingTabs.push(tab); return tab; }, reveal: async () => {}, close: async tab => { siblingClosed.push(tab); },
  } });
  const own = await f.controller.open('glurff'), other = await sibling.open('call', f.origin + '/apps/call?room=protected');
  const nativeOther = f.bindings.get(other.bindingId);
  await f.controller.disconnect();
  assert.deepEqual(f.requests.at(-1), { op: 'forget', payload: { origin: f.origin, bindingIds: [own.bindingId] } });
  assert.deepEqual(f.order, ['forget', 'close']); assert.equal(f.bindings.has(own.bindingId), false);
  assert.equal(f.bindings.get(other.bindingId), nativeOther); assert.equal(siblingClosed.length, 0);
  assert.equal(siblingTabs.length, 1); assert.equal(sibling.state()[0].bindingId, other.bindingId);
  assert.equal((await sibling.observe(other.bindingId)).phase, 'bound');
});

test('uncertain scoped release preserves each owned record and never closes handles or sibling bindings', async () => {
  const f = fixture(), row = await f.controller.open('noltbook'); f.controls.uncertain = 'forget';
  await assert.rejects(f.controller.disconnect());
  assert.equal(f.controller.state()[0].bindingId, row.bindingId); assert.equal(f.controller.state()[0].phase, 'unknown');
  assert.equal(f.closed.length, 0); assert.equal(f.bindings.has(row.bindingId), true);
  await assert.rejects(f.controller.disconnect()); assert.equal(f.requests.filter(request => request.op === 'forget').length, 1);
});

test('pre-bind authentication failure sends no forget and failed tab cleanup retains its own identity', async () => {
  const f = fixture(); f.controls.auth = false; f.controls.refuseAuth = true;
  await f.controller.open('glurff'); await f.controller.disconnect(); assert.equal(f.requests.length, 0);
  const g = fixture(), row = await g.controller.open('glurff'); g.controls.closeFails = true;
  await assert.rejects(g.controller.disconnect()); assert.equal(g.bindings.has(row.bindingId), false);
  assert.equal(g.controller.state()[0].bindingId, row.bindingId); assert.equal(g.controller.state()[0].phase, 'unknown');
  g.controls.closeFails = false; await g.controller.disconnect(); assert.equal(g.controller.state().length, 0);
  assert.equal(g.requests.filter(request => request.op === 'forget').length, 1, 'Confirmed native release was replayed for a failed frontend handle');
});

test('fresh authentication occurs only for explicit Open when no usable cookie exists', async () => {
  const f = fixture(); f.controls.auth = false;
  assert.equal(f.controls.signs, 0); await f.controller.open('glurff'); assert.equal(f.controls.signs, 1);
  await f.controller.open('glurff'); assert.equal(f.controls.signs, 1);
});

test('bidirectional app links reuse exact retained owners and reject foreign, arbitrary, or closed-source handoffs', async () => {
  const f = fixture(), world = f.origin + '/apps/glurff/?world=red%2Fblue#place';
  const glurff = await f.controller.open('glurff', world);
  const note = await f.controller.open('noltbook', f.origin + '/apps/noltbook/?note=kept#call');
  const before = f.requests.length;
  const returned = await f.controller.handleOpen({ type: 'open', bindingId: note.bindingId, url: world });
  assert.equal(returned?.bindingId, glurff.bindingId);
  assert.equal(returned?.url, world); assert.equal(f.opened.length, 2);
  assert.deepEqual(f.revealed, [f.opened[0]]); assert.equal(f.requests.length, before); assert.equal(f.closed.length, 0);
  for (const url of ['https://foreign.example/apps/glurff/', f.origin + '/apps/call',
    f.origin + '/apps/other/', f.origin + '/apps/glurff-evil/', f.origin + '/apps/glurff/%2e%2e/noltbook/']) {
    assert.equal(await f.controller.handleOpen({ type: 'open', bindingId: note.bindingId, url }), undefined);
  }
  f.externallyClosed.add(f.opened[1]);
  assert.equal(await f.controller.handleOpen({ type: 'open', bindingId: note.bindingId, url: world }), undefined);
  assert.equal(f.requests.length, before); assert.equal(f.revealed.length, 1);
});

test('Landscape reuses its owner and hands approved app links between retained tabs without navigation', async () => {
  const f = fixture(), landscape = await f.controller.open('landscape');
  assert.equal(landscape.url, f.origin + '/apps/landscape/'); assert.equal(landscape.phase, 'bound');
  assert.equal(f.requests[0].payload.kind, 'landscape');
  assert.equal((await f.controller.open('landscape')).bindingId, landscape.bindingId);
  for (const kind of ['glurff', 'noltbook'] as const) {
    const target = await f.controller.handleOpen({ type: 'open', bindingId: landscape.bindingId, url: f.origin + `/apps/${kind}/` });
    assert.equal(target?.kind, kind);
    const back = await f.controller.handleOpen({ type: 'open', bindingId: target!.bindingId, url: landscape.url });
    assert.equal(back?.bindingId, landscape.bindingId);
  }
  for (const url of [f.origin + '/apps/other/', f.origin + '/apps/landscape-other/', 'https://foreign.example/apps/landscape/'])
    assert.equal(await f.controller.handleOpen({ type: 'open', bindingId: landscape.bindingId, url }), undefined);
  assert.equal(f.opened.length, 3); assert.deepEqual(f.requests.map(row => row.op), ['bind', 'bind', 'bind']);
  assert.equal(f.closed.length, 0);
});

test('native selected-page title and focus are read-only observations; a closed page is never active', async () => {
  const f = fixture(); let active = true, closed = false;
  const tab = { url: '', title: 'Shared note' };
  const controller = new MediaController({ client: f.client, bridge: f.bridge, browser: {
    open: async url => { tab.url = url; return tab; }, reveal: async () => {}, close: async () => { closed = true; },
    isActive: () => active, isClosed: () => closed
  } });
  await controller.open('noltbook'); const count = f.requests.length;
  assert.equal(controller.state()[0].title, 'Shared note'); assert.equal(controller.state()[0].active, true);
  active = false; tab.title = 'Renamed shared note';
  assert.equal(controller.state()[0].title, 'Renamed shared note'); assert.equal(controller.state()[0].active, false);
  closed = true; active = true;
  assert.equal(controller.state()[0].closed, true); assert.equal(controller.state()[0].active, false);
  assert.equal(controller.state()[0].ready, false); assert.equal(f.requests.length, count);
});
