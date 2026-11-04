import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ShipClient, ShipClientError, OutcomeUnknownError, type RequestOptions } from '../src/ship-client';
import { type JsonObject } from '../src/protocol';
import { ShipTerminalSession, terminalApps, terminalState, type TerminalOutput } from '../src/terminal-session';
import { HistoricalTerminalFilter } from '../src/terminal-filter';

function state(changes: JsonObject = {}): JsonObject {
  return { phase: 2, generation: 7, inputNext: 3, offset: 4, connected: true, nonce: '0v1', cursor: '0v2',
    control: { revision: 5, viewer: '' }, driver: { revision: '0', fault: null }, ...changes };
}
function events(snapshot = state(), text = 'old\n', reset = false): JsonObject {
  return { state: snapshot, offset: snapshot.offset, reset, data: Buffer.from(text).toString('base64') };
}
class MockTransport {
  readonly origin = 'https://terminal.fixture';
  readonly calls: { path: string; options?: RequestOptions }[] = [];
  steps: ((path: string, options?: RequestOptions) => Promise<JsonObject> | JsonObject)[] = [];
  async requestJSON(path: string, options?: RequestOptions): Promise<JsonObject> {
    this.calls.push({ path, options }); const step = this.steps.shift(); assert.ok(step, 'Unexpected request'); return step(path, options);
  }
  observe(snapshot = state(), text = 'old\n'): void {
    this.steps.push((path, options) => { assert.ok(path.endsWith('/state')); assert.equal(options?.method, undefined); return snapshot; });
    this.steps.push(path => { assert.match(path, /\/events\?offset=0&cursor=0v2$/); return events(snapshot, text); });
  }
}
async function ready(watch = false): Promise<{ transport: MockTransport; session: ShipTerminalSession }> {
  const transport = new MockTransport(), session = new ShipTerminalSession(transport);
  transport.observe(); await session.observe(watch);
  transport.steps.push((_path, options) => { assert.equal(options?.body?.kind, 6); return state(); }); await session.attach();
  transport.steps.push((_path, options) => { assert.equal(options?.body?.kind, 11); return state({ control: { revision: 6, viewer: session.viewer } }); });
  await session.takeControl(); assert.equal(session.canInput, true); return { transport, session };
}

test('strict terminal state excludes malformed counters, control and faults', () => {
  for (const change of [{ phase: 5 }, { generation: true }, { inputNext: -1 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { nonce: '0v0' },
    { control: { revision: 1, viewer: 'fake' } }, { driver: { revision: '01', fault: null } }, { driver: { revision: '1', fault: { generation: 8, errno: 5 } } }]) {
    assert.throws(() => terminalState(state(change)));
  }
  assert.equal(terminalState(state()).offset, 4);
});

test('all four real HTTP routes observe retained bytes and close aborts GET without Stop', async () => {
  const requests: string[] = []; let held = false, cancelled = false;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    requests.push(`${request.method} ${request.url}`); assert.equal(request.method, 'GET');
    if (request.url?.endsWith('/state')) response.end(JSON.stringify(state()));
    else if (request.url?.includes('offset=0')) response.end(JSON.stringify(events()));
    else { held = true; request.on('close', () => { cancelled = true; }); return; }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ShipClient(`http://127.0.0.1:${address.port}`, async () => undefined);
  try {
    for (const app of terminalApps) {
      const session = new ShipTerminalSession(client, app), output: TerminalOutput[] = [];
      session.onOutput = value => output.push(value); await session.observe(false);
      assert.equal(output.length, 1); assert.equal(output[0]!.historical, true); assert.equal(Buffer.from(output[0]!.data).toString(), 'old\n');
      assert.equal(session.attached, false); await assert.rejects(session.input('no')); session.close();
    }
    const watching = new ShipTerminalSession(client); await watching.observe();
    for (let i = 0; i < 300 && !held; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(held); watching.close();
    for (let i = 0; i < 100 && !cancelled; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(cancelled); const count = requests.length; await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(requests.length, count); assert.equal(count, 11); assert.ok(requests.every(value => value.startsWith('GET ')));
  } finally { client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('explicit attach/take serialize input and resize with actual wire fences', async () => {
  const { transport, session } = await ready();
  for (let index = 0; index < 3; index++) transport.steps.push((path, options) => {
    assert.equal(path, '/apps/pataphor-terminal/action'); assert.equal(options?.terminalNonce, '0v1');
    const packet = options?.body; assert.ok(packet); assert.equal(packet.kind, 2); assert.equal(packet.generation, 7); assert.equal(packet.sequence, 3 + index);
    assert.equal(packet.viewer, session.viewer); assert.equal(packet.controlRevision, 6); assert.match(packet.controlKey as string, /^[a-f0-9]{32}$/);
    assert.equal(Buffer.from(packet.data as string, 'base64').length, [2048, 2048, 1][index]);
    return state({ inputNext: 4 + index, control: { revision: 6, viewer: session.viewer } });
  });
  transport.steps.push((_path, options) => {
    assert.equal(options?.body?.kind, 3); assert.equal(options?.body?.sequence, 6); assert.equal(options?.body?.rows, 40); assert.equal(options?.body?.cols, 120);
    return state({ inputNext: 7, control: { revision: 6, viewer: session.viewer } });
  });
  await Promise.all([session.input('x'.repeat(4097)), session.resize(40, 120)]);
  assert.equal(session.state?.inputNext, 7); assert.equal(transport.steps.length, 0);
  const count = transport.calls.length; await assert.rejects(session.resize(0, 90)); assert.equal(transport.calls.length, count);
  transport.steps.push(() => state({ inputNext: 7, control: { revision: 7, viewer: '' } })); await session.release();
  assert.equal(session.canInput, false); session.close(); assert.equal(transport.calls.length, count + 1);
});

test('unknown delivery drops queued bytes and observation never replays or settles old action', async () => {
  const { transport, session } = await ready();
  transport.steps.push(() => { throw new OutcomeUnknownError(); });
  const before = transport.calls.length; await assert.rejects(session.input('x'.repeat(5000)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transport.calls.length, before + 1); assert.equal(session.locked, true); assert.equal(session.attached, false); assert.equal(session.outcomeUnconfirmed, true);
  transport.steps.push(() => state({ inputNext: 4, control: { revision: 6, viewer: session.viewer } }));
  transport.steps.push(() => events(state({ inputNext: 4, control: { revision: 6, viewer: session.viewer } }), ''));
  await session.observe(false); assert.equal(session.outcomeUnconfirmed, true); assert.equal(session.canInput, false);
  assert.equal(transport.calls.length, before + 3); session.close();
});

test('ownership, generation and driver drift lock pending input', async () => {
  for (const changed of [state({ control: { revision: 7, viewer: 'f'.repeat(32) } }),
    state({ generation: 8, offset: 0, inputNext: 1, control: { revision: 6, viewer: '' } }),
    state({ driver: { revision: '1', fault: { generation: 7, errno: 5 } }, control: { revision: 6, viewer: '' } })]) {
    const { transport, session } = await ready(); transport.steps.push(() => events(changed, ''));
    await session.pollOutputOnce(); assert.equal(session.canInput, false); assert.equal(session.locked, true);
    await assert.rejects(session.input('blocked')); session.close();
  }
});

test('semantic ACK failures pin packet identity even when later typing has different bytes', async () => {
  const { transport, session } = await ready();
  transport.steps.push(() => state({ inputNext: 3, control: { revision: 6, viewer: session.viewer } }));
  await assert.rejects(session.input('first')); assert.equal(session.outcomeUnconfirmed, true);
  transport.steps.push(() => state({ control: { revision: 6, viewer: session.viewer } }));
  transport.steps.push(() => events(state({ control: { revision: 6, viewer: session.viewer } }), ''));
  await session.observe(false);
  transport.steps.push(() => state({ control: { revision: 6, viewer: session.viewer } })); await session.attach();
  const count = transport.calls.length;
  await assert.rejects(session.input('different')); assert.equal(transport.calls.length, count); assert.equal(session.locked, true);
  session.close();
});

test('historical ANSI queries stay suppressed across splits, C1, embedded controls and UTF8', () => {
  const encode = (text: string): Buffer => Buffer.from(text), filter = new HistoricalTerminalFilter();
  assert.equal(filter.feed(encode('old\x1b[31mred\x1b[0m\r\n'), true), 'old\x1b[31mred\x1b[0m\r\n');
  for (const query of ['\x1b[6n', '\x1b[c', '\x1b[18t', '\x1b[?1$p', '\x1bP$qm\x1b\\', '\x1b]11;?\x07', '\x1bZ', '\u009b6n']) {
    const data = encode(query);
    for (let split = 1; split < data.length; split++) {
      filter.reset(); assert.equal(filter.feed(data.subarray(0, split), true) + filter.feed(data.subarray(split), false), '');
    }
  }
  for (const continuation of ['\x1b[6n', '\u009b6n', '\x00\x7f[6n']) {
    filter.reset(); assert.equal(filter.feed(encode('\x1b'), true) + filter.feed(encode(continuation), false), '');
  }
  filter.reset(); const emoji = encode('🛰️ hello');
  assert.equal(filter.feed(emoji.subarray(0, 2), true) + filter.feed(emoji.subarray(2), false), '🛰️ hello');
  assert.equal(filter.feed(encode('\x1b[6n'), false), '\x1b[6n');
  assert.equal(filter.feed(encode('\x1b]52;c;c2VjcmV0\x07'), false), '');
  filter.reset(); assert.equal(filter.feed(encode('\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\'), true), '\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\');
});

async function eventually(condition: () => boolean): Promise<void> {
  const until = Date.now() + 3000;
  while (!condition() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), 'Finite terminal fixture did not reach expected state');
}
test('quiet read expiry renews only GET and preserves explicit control; close cancels delayed renewal', async () => {
  const { transport, session } = await ready(true); let renewed = false;
  transport.steps.push((path, options) => {
    assert.ok(path.includes('/events?')); assert.equal(options?.timeoutMs, 45000); assert.equal(options?.method, undefined);
    throw new ShipClientError('pollExpired');
  });
  transport.steps.push(path => { assert.ok(path.includes('/events?offset=4')); renewed = true; return events(state({ control: { revision: 6, viewer: session.viewer } }), ''); });
  try {
    await eventually(() => renewed); assert.equal(session.canInput, true); assert.equal(session.outcomeUnconfirmed, false);
    const count = transport.calls.length; session.close(); await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(transport.calls.length, count); assert.equal(session.closed, true);
    assert.deepEqual(transport.calls.filter(call => call.options?.method === 'POST').map(call => call.options?.body?.kind), [6, 11]);
  } finally { session.close(); }
});
test('quiet expiry of the initial output read is harmless, while transport/protocol failures stop the watch', async () => {
  const transport = new MockTransport(), initial = new ShipTerminalSession(transport);
  transport.steps.push(() => state()); transport.steps.push(() => { throw new ShipClientError('pollExpired'); });
  await initial.observe(); assert.equal(initial.locked, false); initial.close();
  const count = transport.calls.length; await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(transport.calls.length, count);
  for (const error of [new ShipClientError('transport'), new ShipClientError('malformed'), Object.assign(new Error('untrusted'), { code: 'pollExpired' })]) {
    const { transport: mock, session } = await ready(true);
    mock.steps.push(() => { throw error; });
    try {
      await eventually(() => session.locked); assert.equal(session.canInput, false); assert.equal(session.attached, false);
      const stopped = mock.calls.length; await new Promise(resolve => setTimeout(resolve, 350)); assert.equal(mock.calls.length, stopped);
    } finally { session.close(); }
  }
});
test('immediate empty event responses have bounded frequency and close removes the pending delay', async () => {
  const transport = new MockTransport(), session = new ShipTerminalSession(transport); transport.observe();
  for (let i = 0; i < 10; i++) transport.steps.push(() => events(state(), ''));
  try {
    await session.observe(); await new Promise(resolve => setTimeout(resolve, 1100));
    const reads = transport.calls.filter(call => call.path.includes('/events?'));
    assert.ok(reads.length >= 3 && reads.length <= 6, 'Empty events must stay bounded to four background GETs/second');
    assert.ok(transport.calls.every(call => call.options?.method === undefined));
    session.close(); const count = transport.calls.length; await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(transport.calls.length, count);
  } finally { session.close(); }
});
