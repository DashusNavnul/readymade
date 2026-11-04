import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { MediaClient, MediaClientError, MediaOutcomeUnknownError, type MediaOpenEvent } from '../src/media-client';
import { type JsonObject } from '../src/protocol';

const origin = 'https://ship.fixture', bindingId = 'a'.repeat(32);
const bind = (id = bindingId): JsonObject => ({ bindingId: id, bootstrapURL: 'about:blank#readymade-' + id,
  origin, kind: 'glurff', url: origin + '/apps/glurff/?room=fixture#retained', cookies: [{ name: 'urbauth-~zod', value: 'fixture-session-only' }] });
const state = (changes: JsonObject = {}): JsonObject => ({ bindingId, origin, kind: 'glurff', url: origin + '/apps/glurff/', ready: true, fault: null, pending: false, ...changes });
type Step = (row: JsonObject, socket: Socket) => void;
class Fixture {
  readonly directory = mkdtempSync('/tmp/rm-media-');
  readonly path = join(this.directory, 'readymade-media.sock');
  readonly sockets = new Set<Socket>(); readonly frames: JsonObject[] = []; readonly steps: Step[] = [];
  readonly server = createServer(socket => {
    this.sockets.add(socket); let input = '';
    socket.on('error', () => {}); socket.on('close', () => this.sockets.delete(socket));
    socket.on('data', chunk => {
      input += chunk.toString(); let at: number;
      while ((at = input.indexOf('\n')) !== -1) {
        const row = JSON.parse(input.slice(0, at)) as JsonObject; input = input.slice(at + 1);
        this.frames.push(row); const step = this.steps.shift(); assert.ok(step, 'Unexpected media request'); step(row, socket);
      }
    });
  });
  async start(): Promise<this> { this.server.listen(this.path); await once(this.server, 'listening'); chmodSync(this.path, 0o600); return this; }
  answer(result: JsonObject): void { this.steps.push((row, socket) => socket.write(JSON.stringify({ id: row.id, ok: true, result }) + '\n')); }
  async stop(): Promise<void> { for (const socket of this.sockets) socket.destroy(); await new Promise<void>(resolve => this.server.close(() => resolve())); }
}
const code = (expected: string) => (error: unknown) => error instanceof MediaClientError && error.code === expected;
async function fixture(run: (server: Fixture, client: MediaClient) => Promise<void>): Promise<void> {
  const server = await new Fixture().start(), client = new MediaClient(server.directory);
  try { await run(server, client); assert.equal(server.steps.length, 0); } finally { client.close(); await server.stop(); }
}

test('socket must be private, owned, a real socket and inside a private real directory', async () => {
  assert.throws(() => new MediaClient('relative'), code('unsafeSocket'));
  await fixture(async (server, client) => {
    chmodSync(server.path, 0o666); await assert.rejects(client.request('status'), code('unsafeSocket'));
    chmodSync(server.path, 0o600); chmodSync(server.directory, 0o755); await assert.rejects(client.request('status'), code('unsafeSocket'));
    chmodSync(server.directory, 0o700); server.answer({ protocol: 1, bindings: [] }); await client.request('status');
    assert.equal(server.frames.length, 1);
    const link = server.directory + '-link'; symlinkSync(server.directory, link);
    const aliased = new MediaClient(link); await assert.rejects(aliased.request('status'), code('unsafeSocket')); aliased.close();
  });
  const directory = mkdtempSync('/tmp/rm-media-'); writeFileSync(join(directory, 'readymade-media.sock'), 'not a socket', { mode: 0o600 });
  const file = new MediaClient(directory); await assert.rejects(file.request('status'), code('unsafeSocket')); file.close();
});

test('strict bounded binding, cookies and navigation validation sends nothing unsafe', async () => {
  await fixture(async (server, client) => {
    for (const payload of [{ ...bind(), origin: 'http://remote.fixture' }, { ...bind(), bootstrapURL: 'about:blank#wrong' },
      { ...bind(), url: 'https://foreign.fixture/apps/glurff/' }, { ...bind(), bindingId: 'wrong' }, { ...bind(), kind: 'other' },
      { ...bind(), cookies: [{ name: 'urbauth-~zod', value: 'private\nvalue' }] }, { ...bind(), cookies: Array(9).fill({ name: 'urbauth-~zod', value: 'x' }) }]) {
      await assert.rejects(client.request('bind', payload), MediaClientError);
    }
    await assert.rejects(client.request('navigate', { bindingId, url: origin + '/apps/glurff/' }), code('invalidBinding'));
    await assert.rejects(client.request('status', { huge: 'x'.repeat(65536) }), code('tooLarge'));
    assert.equal(server.frames.length, 0); server.answer(state()); await client.request('bind', bind());
    await assert.rejects(client.request('navigate', { bindingId, url: 'https://elsewhere.fixture/apps/glurff/' }), code('invalidURL'));
    assert.equal(server.frames.length, 1);
  });
});

test('Groups binding retains its kind and exact URL through IPC and rejects foreign origins', async () => {
  await fixture(async (server, client) => {
    const url = origin + '/apps/groups/?group=fixture%2Froom#channel', payload = { ...bind(), kind: 'groups', url };
    server.answer(state({ kind: 'groups', url }));
    assert.equal((await client.request('bind', payload)).kind, 'groups');
    assert.deepEqual(server.frames[0].payload, payload);
    await assert.rejects(client.request('bind', { ...payload, kind: 'noltbook' }), code('invalidBinding'));
    await assert.rejects(client.request('navigate', { bindingId, url: 'https://foreign.fixture/apps/groups/' }), code('invalidURL'));
    const seen: MediaOpenEvent[] = []; client.events.onOpen(event => seen.push(event));
    server.steps.push((row, socket) => {
      socket.write(JSON.stringify({ type: 'open', bindingId, url: origin + '/apps/noltbook/' }) + '\n');
      socket.write(JSON.stringify({ type: 'open', bindingId, url: 'https://foreign.fixture/apps/groups/' }) + '\n');
      socket.write(JSON.stringify({ id: row.id, ok: true, result: state({ kind: 'groups', url }) }) + '\n');
    });
    await client.request('observe', { bindingId });
    assert.deepEqual(seen, [{ type: 'open', bindingId, url: origin + '/apps/noltbook/' }]);
    assert.equal(server.frames.length, 2);
  });
});

test('correlated responses may split and arrive out of order; only approved bound-origin events are exposed', async () => {
  await fixture(async (server, client) => {
    let first: JsonObject | undefined;
    server.steps.push(row => { first = row; });
    server.steps.push((row, socket) => {
      socket.write(JSON.stringify({ id: row.id, ok: true, result: { order: (row.payload as JsonObject).order } }) + '\n');
      const reply = JSON.stringify({ id: first!.id, ok: true, result: { order: (first!.payload as JsonObject).order } }) + '\n'; socket.write(reply.slice(0, 11)); socket.write(reply.slice(11));
    });
    const values = await Promise.all([client.request('status', { order: 1 }), client.request('status', { order: 2 })]); assert.deepEqual(values.map(value => value.order), [1, 2]);
    assert.notEqual(server.frames[0]!.id, server.frames[1]!.id);
    server.answer(state()); await client.request('bind', bind());
    const seen: MediaOpenEvent[] = [], subscription = client.events.onOpen(event => seen.push(event));
    client.events.onOpen(() => { throw new Error('UI callback failure must stay local'); });
    server.steps.push((row, socket) => {
      for (const event of [{ type: 'open', bindingId: 'b'.repeat(32), url: origin + '/apps/noltbook/' },
        { type: 'open', bindingId, url: 'https://foreign.fixture/apps/noltbook/' },
        { type: 'open', bindingId, url: origin + '/apps/noltbook/?note=fixture&room=private#fragment' }]) socket.write(JSON.stringify(event) + '\n');
      socket.write(JSON.stringify({ id: row.id, ok: true, result: { protocol: 1 } }) + '\n');
    });
    await client.request('status'); assert.equal(seen.length, 1); assert.ok(seen[0]!.url.endsWith('?note=fixture&room=private#fragment')); assert.ok(Object.isFrozen(seen[0]));
    subscription.dispose();
  });
});

test('mutation disconnect is unknown with no replay; pending/foreign observation cannot release the fence', async () => {
  await fixture(async (server, client) => {
    server.steps.push((_row, socket) => socket.destroy());
    await assert.rejects(client.request('bind', bind()), MediaOutcomeUnknownError);
    assert.equal(server.frames.length, 1);
    await assert.rejects(client.request('bind', bind()), code('observeRequired')); assert.equal(server.frames.length, 1);
    for (const observed of [state({ pending: true }), state({ origin: 'https://foreign.fixture' }), { bindingId, exists: false }]) {
      server.answer(observed); await client.request('observe', { bindingId });
      await assert.rejects(client.request('navigate', { bindingId, url: origin + '/apps/glurff/' }), code('observeRequired'));
    }
    server.answer(state()); await client.request('observe', { bindingId });
    server.answer(state()); await client.request('navigate', { bindingId, url: origin + '/apps/glurff/' });
    assert.equal(server.frames.filter(row => row.op === 'bind').length, 1);
  });
});

test('real deadline preserves binding identity; late acknowledgment does not settle it, explicit absent observation can', { timeout: 15000 }, async () => {
  await fixture(async (server, client) => {
    let original: JsonObject | undefined, socket: Socket | undefined;
    server.steps.push((row, target) => { original = row; socket = target; });
    const started = Date.now(); await assert.rejects(client.request('bind', bind()), MediaOutcomeUnknownError);
    assert.ok(Date.now() - started >= 9900); assert.equal(server.frames.length, 1);
    socket!.write(JSON.stringify({ id: original!.id, ok: true, result: state() }) + '\n');
    server.answer({ protocol: 1 }); await client.request('status');
    await assert.rejects(client.request('navigate', { bindingId, url: origin + '/apps/glurff/' }), code('observeRequired'));
    server.answer({ bindingId, exists: false, pending: false }); await client.request('observe', { bindingId });
    server.answer(state()); await client.request('bind', bind()); assert.equal(server.frames.filter(row => row.op === 'bind').length, 2);
  });
});

test('explicit refusal is safe, operational refusal is unknown, and uncertain forget fences only its frozen IDs', async () => {
  await fixture(async (server, client) => {
    server.steps.push((row, socket) => socket.write(JSON.stringify({ id: row.id, ok: false, error: 'invalidBinding' }) + '\n'));
    await assert.rejects(client.request('bind', bind()), error => code('refused')(error) && !String(error).includes('fixture-session-only'));
    server.answer(state()); await client.request('bind', bind());
    server.steps.push((row, socket) => socket.write(JSON.stringify({ id: row.id, ok: false, error: 'outcomeUnknown' }) + '\n'));
    await assert.rejects(client.request('navigate', { bindingId, url: origin + '/apps/glurff/' }), MediaOutcomeUnknownError);
    server.answer(state()); await client.request('observe', { bindingId });
    server.steps.push((row, socket) => {
      assert.deepEqual(row.payload, { origin, bindingIds: [bindingId] });
      socket.write(JSON.stringify({ id: row.id, ok: false, error: 'outcomeUnknown' }) + '\n');
    });
    await assert.rejects(client.request('forget', { origin, bindingIds: [bindingId] }), MediaOutcomeUnknownError);
    server.answer({ protocol: 1, bindings: [] }); await client.request('status');
    server.answer({ bindingId, exists: false, pending: false }); await client.request('observe', { bindingId });
    await assert.rejects(client.request('bind', bind()), code('observeRequired'));
    await assert.rejects(client.request('forget', { origin, bindingIds: [bindingId] }), code('observeRequired'));
    const sibling = 'b'.repeat(32); server.answer(state({ bindingId: sibling })); await client.request('bind', bind(sibling));
    server.answer(state({ bindingId: sibling })); await client.request('navigate', { bindingId: sibling, url: origin + '/apps/glurff/' });
  });
});

test('native refusals retain only fixed diagnostic reasons and never expose arbitrary private text', async () => {
  await fixture(async (server, client) => {
    for (const reason of ['invalidOrigin', 'invalidBinding', 'invalidURL', 'invalidCookies', 'alreadyBound', 'bootstrapNotFound',
      'unsafeView', 'cookieOriginConflict', 'bindingMissing', 'bindingFault', 'bindingCapacity', 'requestFailed', 'private-cookie-fixture']) {
      server.steps.push((row, socket) => socket.write(JSON.stringify({ id: row.id, ok: false, error: reason }) + '\n'));
      await assert.rejects(client.request('bind', bind()), error => {
        assert.ok(error instanceof MediaClientError); assert.equal(error.code, 'refused');
        assert.equal(error.reason, reason === 'private-cookie-fixture' ? undefined : reason);
        if (reason === 'private-cookie-fixture') assert.ok(!JSON.stringify(error).includes(reason) && !String(error).includes(reason));
        return true;
      });
    }
    server.steps.push((row, socket) => socket.write(JSON.stringify({ id: row.id, ok: false, error: 'outcomeUnknown' }) + '\n'));
    await assert.rejects(client.request('bind', bind()), MediaOutcomeUnknownError);
    await assert.rejects(client.request('bind', bind()), code('observeRequired'));
  });
});

test('forget requires a bounded owned list and cannot broaden to another window or same-origin sibling', async () => {
  await fixture(async (server, client) => {
    const sibling = 'b'.repeat(32), otherWindow = 'c'.repeat(32), other = new MediaClient(server.directory);
    try {
      server.answer(state()); await client.request('bind', bind());
      server.answer(state({ bindingId: sibling })); await client.request('bind', bind(sibling));
      server.answer(state({ bindingId: otherWindow })); await other.request('bind', bind(otherWindow));
      const count = server.frames.length;
      for (const payload of [{ origin }, { origin, bindingIds: [] }, { origin, bindingIds: [bindingId, bindingId] },
        { origin, bindingIds: [otherWindow] }, { origin, bindingIds: [bindingId, otherWindow] },
        { origin, bindingIds: Array(9).fill(bindingId) }, { origin, bindingIds: ['wrong'] },
        { origin: 'https://foreign.fixture', bindingIds: [bindingId] }]) {
        await assert.rejects(client.request('forget', payload), code('invalidBinding'));
      }
      assert.equal(server.frames.length, count);
      const ids = [bindingId];
      server.steps.push((row, socket) => {
        assert.deepEqual(row.payload, { origin, bindingIds: [bindingId] });
        socket.write(JSON.stringify({ id: row.id, ok: true, result: { forgotten: true } }) + '\n');
      });
      const forgetting = client.request('forget', { origin, bindingIds: ids }); ids.push(otherWindow); await forgetting;
      await assert.rejects(client.request('navigate', { bindingId, url: origin + '/apps/glurff/' }), code('invalidBinding'));
      server.answer(state({ bindingId: sibling })); await client.request('navigate', { bindingId: sibling, url: origin + '/apps/glurff/' });
      server.answer(state({ bindingId: otherWindow })); await other.request('navigate', { bindingId: otherWindow, url: origin + '/apps/glurff/' });
      const scopes = server.frames.filter(row => row.op === 'forget').map(row => row.payload);
      assert.deepEqual(scopes, [{ origin, bindingIds: [bindingId] }]);
    } finally { other.close(); }
  });
});

test('same-binding concurrency is refused; malformed replies and close cancel finite waits without closing the browser', async () => {
  await fixture(async (server, client) => {
    let reply: (() => void) | undefined;
    server.steps.push((row, socket) => { reply = () => socket.write(JSON.stringify({ id: row.id, ok: true, result: state() }) + '\n'); });
    const competing = Promise.allSettled([client.request('bind', bind()), client.request('bind', bind())]);
    while (!reply) await new Promise(resolve => setImmediate(resolve)); reply();
    const attempts = await competing; assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
    const refused = attempts.find(attempt => attempt.status === 'rejected'); assert.ok(refused?.status === 'rejected' && code('busy')(refused.reason));
    server.steps.push((row, socket) => socket.write(JSON.stringify({ id: row.id, ok: true, result: { bindingId: 'b'.repeat(32) } }) + '\n'));
    await assert.rejects(client.request('navigate', { bindingId, url: origin + '/apps/glurff/' }), MediaOutcomeUnknownError);
    server.answer(state()); await client.request('observe', { bindingId });
    server.steps.push(() => {}); const waiting = client.request('navigate', { bindingId, url: origin + '/apps/glurff/' });
    const cancelled = assert.rejects(waiting, MediaOutcomeUnknownError);
    while (server.steps.length) await new Promise(resolve => setImmediate(resolve));
    const count = server.frames.length; client.close(); await cancelled;
    await assert.rejects(client.request('status'), code('closed')); assert.equal(server.frames.length, count);
    assert.ok(server.frames.every(row => row.op !== 'close' && row.op !== 'forget'));
  });
  await fixture(async (server, client) => {
    server.steps.push((_row, socket) => socket.write(Buffer.from([0xff, 10])));
    await assert.rejects(client.request('status'), code('malformed'));
  });
});
