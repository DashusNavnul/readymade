import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type ServerResponse} from 'node:http';
import {CallNotices, CallNotificationFeed, type CallNotice} from '../src/call-notifications';

const snap = (gen: number, callId = 'call-1', participants = ['~let']) => ({noteId: 'note-1', gen,
  call: {callId, status: 'active', participants}});
test('native snapshots notify once per call, reject stale revisions and suppress own participation', () => {
  const notices: CallNotice[] = [], state = new CallNotices('~zod', n => notices.push(n));
  state.update({'call-snap': snap(1)}); state.update({'call-snap': snap(2)});
  state.update({'call-snap': snap(1, 'stale')});
  assert.equal(notices.length, 1); assert.equal(state.current(notices[0]), true);
  state.update({'call-snap': {...snap(3), call: null}}); assert.equal(state.current(notices[0]), false);
  state.update({'call-snap': snap(4, 'own', ['~zod', '~let'])}); assert.equal(notices.length, 1);
  state.update({'call-snap': snap(5, 'new')}); assert.equal(notices.length, 2);
  state.update({'call-list': [snap(5, 'new')]}); assert.equal(notices.length, 2);
  state.update({'call-list': []}); assert.equal(state.current(notices[1]), false);
  state.update({'message-added': {text: 'call-started'}}); assert.equal(notices.length, 2);
});
test('malformed participant and call identities cannot become links or notifications', () => {
  const notices: CallNotice[] = [], state = new CallNotices('~zod', n => notices.push(n));
  state.update({'call-snap': snap(1, 'bad\ncall')});
  state.update({'call-snap': snap(2, 'good', ['<script>'])});
  state.update({'call-snap': {...snap(3), gen: Infinity}});
  state.update({'call-snap': snap(4, 'empty', [])});
  assert.deepEqual(notices, []);
});
async function until(fn: () => boolean): Promise<void> {
  const until = Date.now() + 3000;
  while (!fn()) { if (Date.now() > until) throw new Error('Missing event'); await new Promise(r => setTimeout(r, 10)); }
}
test('one authenticated stream accepts split SSE, acks, deduplicates and deletes without a poke', async () => {
  const actions: {id: number; action: string; path?: string}[] = [], notices: CallNotice[] = [];
  let stream: ServerResponse | undefined, failures = 0, gets = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.cookie, 'urbauth-~zod=test-secret');
    assert.match(req.url!, /^\/~\/channel\/readymade-calls-[a-f0-9]{32}$/);
    if (req.method === 'GET') { gets++; stream = res; res.writeHead(200, {'Content-Type': 'text/event-stream'}); res.flushHeaders(); return; }
    let body = ''; for await (const b of req) body += b;
    const rows = JSON.parse(body); actions.push(...rows); res.writeHead(204).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const feed = new CallNotificationFeed({origin, browserCookies: () => [{name: 'urbauth-~zod', value: 'test-secret'}]}, n => notices.push(n), () => failures++);
  try {
    await feed.start(); await until(() => !!stream);
    const event = 'id: 1\r\ndata: '+JSON.stringify({id: 1, response: 'diff', json: {'call-snap': snap(1)}})+'\r\n\r\n';
    stream!.write(event.slice(0, -1)); await new Promise(r => setTimeout(r, 20)); assert.equal(notices.length, 0);
    stream!.write(event.slice(-1)); await until(() => notices.length === 1 && actions.some(a => a.action === 'ack'));
    stream!.write(event); await new Promise(r => setTimeout(r, 20)); assert.equal(notices.length, 1);
    await feed.close(); assert.equal(feed.current(notices[0]), false);
    assert.equal(gets, 1); assert.equal(failures, 0);
    assert.equal(actions.filter(a => a.action === 'subscribe').length, 1);
    assert.equal(actions[0].path, '/notes'); assert.equal(actions.at(-1)?.action, 'delete');
    assert.ok(actions.every(a => ['subscribe', 'ack', 'delete'].includes(a.action)));
  } finally { await feed.close(); stream?.destroy(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
test('redirects never leak cookies or retry subscription writes', async () => {
  let requests = 0, failures = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(302, {Location: 'https://untrusted.example/'}).end(); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const feed = new CallNotificationFeed({origin, browserCookies: () => [{name: 'urbauth-~zod', value: 'test-secret'}]}, () => assert.fail(), () => failures++);
  try { await assert.rejects(feed.start()); await feed.close(); assert.equal(failures, 1); assert.equal(requests, 2); }
  finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('closing waits for an outstanding acknowledgement before deleting the channel', async () => {
  const actions: string[] = [];
  let stream: ServerResponse | undefined, ack: ServerResponse | undefined;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { stream = res; res.writeHead(200, {'Content-Type': 'text/event-stream'}); res.flushHeaders(); return; }
    let body = ''; for await (const part of req) body += part;
    const action = JSON.parse(body)[0].action; actions.push(action);
    if (action === 'ack') { ack = res; return; }
    res.writeHead(204).end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const feed = new CallNotificationFeed({origin, browserCookies: () => [{name: 'urbauth-~zod', value: 'test-secret'}]}, () => undefined, () => assert.fail());
  try {
    await feed.start(); await until(() => !!stream);
    stream!.write('id: 1\ndata: '+JSON.stringify({id: 1, response: 'diff', json: {'call-list': []}})+'\n\n');
    await until(() => !!ack);
    const closing = feed.close();
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(actions, ['subscribe', 'ack']);
    ack!.writeHead(204).end(); await closing;
    assert.deepEqual(actions, ['subscribe', 'ack', 'delete']);
  } finally { ack?.end(); await feed.close(); stream?.destroy(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
