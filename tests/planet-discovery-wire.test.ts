import test from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {createRequire} from 'node:module';
import {encodeQuery, decodeQuery, queryNative, NativeObservationFailure, LOCAL_OBSERVATION_TIMEOUT_MS, type NativeQuery, type NativeObservationReason} from '../src/planet-discovery-wire';
const failure = (reason: NativeObservationReason) => (error: unknown) => error instanceof NativeObservationFailure && error.reason === reason && error.message === 'Local planet observation unavailable.';
// Independent existing offline decoder checks the generated fixed query nouns.
const {cue} = createRequire(__filename)('../../backend/install/inspect-spider.cjs') as {cue(frame: Buffer): Noun};
type Noun = bigint | [Noun, Noun];
const cord = (s: string) => BigInt('0x' + Buffer.from(s).reverse().toString('hex'));
const tup = (...v: Noun[]): Noun => v.slice(0, -1).reduceRight<Noun>((t, h) => [h, t], v.at(-1)!);
function frame(noun: Noun): Buffer {
  const bits: number[] = [];
  const put = (n: bigint, width: number) => {for (let i = 0; i < width; i++) bits.push(Number(n >> BigInt(i) & 1n));};
  const encode = (v: Noun): void => {
    if (Array.isArray(v)) {bits.push(1, 0); encode(v[0]); encode(v[1]); return;}
    bits.push(0); if (!v) {bits.push(1); return;}
    const width = v.toString(2).length, size = width.toString(2).length;
    bits.push(...Array<number>(size).fill(0), 1); put(BigInt(width), size - 1); put(v, width);
  };
  encode(noun); const b = Buffer.alloc(5 + Math.ceil(bits.length / 8)); b.writeUInt32LE(b.length - 5, 1);
  bits.forEach((v, i) => {b[5 + (i >> 3)] |= v << (i % 8);}); return b;
}
const reality = (id = 73n, value = 1n, location = tup(cord('j'), cord('~sampel-palnet'), cord('fake'), cord('~2026.11.10..02.40.05..acc0'), 0n)) => frame(tup(id, cord('peek'), 0n, cord('omen'), location, cord('noun'), value));
test('only four fixed read requests are encoded with native loobean and exact paths', () => {
  assert.deepEqual(cue(encodeQuery('identity', 73)), tup(73n, cord('peel'), [cord('who'), 0n]));
  assert.deepEqual(cue(encodeQuery('live', 73)), tup(73n, cord('peel'), [cord('live'), 0n]));
  assert.deepEqual(cue(encodeQuery('http', 73)), tup(73n, cord('peel'), tup(cord('port'), cord('http'), 0n)));
  assert.deepEqual(cue(encodeQuery('real', 73)), tup(73n, cord('peek'), tup(1n, cord('once'), cord('j'), cord('fake'), 0n)));
  assert.throws(() => encodeQuery('arbitrary' as NativeQuery, 73)); assert.throws(() => encodeQuery('real', -1));
});
test('native real/fake identity comes from exact Jael location and strict correlated envelope', () => {
  assert.deepEqual(decodeQuery('real', 73, reality()), {ship: '~sampel-palnet', fake: false});
  assert.equal(decodeQuery('real', 73, reality(73n, 0n)).fake, true);
  for (const bad of [reality(74n), reality(73n, 2n), reality(73n, 1n, tup(cord('j'), cord('~sampel-palnet'), cord('other'), cord('~2026.11.10..02.40.05..acc0'), 0n)), frame(tup(73n, cord('peek'), 1n, cord('omen'), 0n, cord('noun'), 1n))]) assert.throws(() => decodeQuery('real', 73, bad), failure('envelope'));
  assert.equal(decodeQuery('identity', 73, frame(tup(73n, 0n, 0xabcdefn))), 0xabcdefn);
  assert.equal(decodeQuery('live', 73, frame(tup(73n, 0n, 0n))), 0n);
  for (const value of [0n, 65536n]) assert.throws(() => decodeQuery('http', 73, frame(tup(73n, 0n, value))));
});
test('truncated, trailing, oversized, invalid back-reference and excessive-depth frames are refused', () => {
  const good = reality(), extra = Buffer.concat([good, Buffer.from([0])]); extra.writeUInt32LE(extra.length - 5, 1);
  const ref = Buffer.from([0, 1, 0, 0, 0, 7]);
  let deep: Noun = 0n; for (let i = 0; i < 130; i++) deep = [deep, 0n];
  for (const bad of [good.subarray(0, -1), extra, Buffer.alloc(65537), ref, frame(deep)]) assert.throws(() => decodeQuery('real', 73, bad), failure('frame-or-decode'));
});
async function socketFixture(t: test.TestContext, respond: (socket: net.Socket, request: Noun) => void): Promise<{socket: string; count: () => number}> {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pwire-')), socket = path.join(root, 'c');
  let calls = 0; const connections = new Set<net.Socket>();
  const server = net.createServer(client => {
    connections.add(client); client.on('error', () => {}); client.on('close', () => connections.delete(client)); let b = Buffer.alloc(0);
    client.on('data', chunk => {b = Buffer.concat([b, chunk]); if (b.length >= 5 && b.length === b.readUInt32LE(1) + 5) {calls++; respond(client, cue(b));}});
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  t.after(async () => {for (const client of connections) client.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, {recursive: true, force: true});});
  return {socket, count: () => calls};
}
test('owned UNIX fixture receives one query, fragmented reply works, and no resend follows refusal', async t => {
  const good = await socketFixture(t, (socket, request) => {assert.ok(Array.isArray(request)); const reply = reality(request[0] as bigint); socket.write(reply.subarray(0, 3)); setImmediate(() => socket.write(reply.subarray(3)));});
  assert.deepEqual(await queryNative(good.socket, 'real'), {ship: '~sampel-palnet', fake: false}); assert.equal(good.count(), 1);
  const bad = await socketFixture(t, (socket, request) => {assert.ok(Array.isArray(request)); const reply = reality(request[0] as bigint); socket.write(Buffer.concat([reply, Buffer.from([0])]));});
  await assert.rejects(queryNative(bad.socket, 'real'), failure('frame-or-decode')); assert.equal(bad.count(), 1);
  const foreign = await socketFixture(t, (socket, request) => {assert.ok(Array.isArray(request)); socket.end(reality((request[0] as bigint) + 1n));});
  await assert.rejects(queryNative(foreign.socket, 'real'), failure('envelope')); assert.equal(foreign.count(), 1);
  const partial = await socketFixture(t, socket => {socket.end(Buffer.from([0, 1, 0]));});
  await assert.rejects(queryNative(partial.socket, 'real'), failure('frame-or-decode')); assert.equal(partial.count(), 1);
  await assert.rejects(queryNative(path.join(path.dirname(partial.socket), 'missing'), 'real'), failure('connection'));
});
test('abort and finite timeout close only the query socket and never retry', async t => {
  const fixture = await socketFixture(t, () => {}), abort = new AbortController();
  const pending = queryNative(fixture.socket, 'http', abort.signal); setTimeout(() => abort.abort(), 30);
  await assert.rejects(pending, failure('connection')); assert.equal(fixture.count(), 1);
  const started = Date.now();
  await assert.rejects(queryNative(fixture.socket, 'identity'), failure('timeout')); assert.equal(fixture.count(), 2);
  assert.equal(LOCAL_OBSERVATION_TIMEOUT_MS, 5000); assert.ok(Date.now() - started >= LOCAL_OBSERVATION_TIMEOUT_MS - 100);
  await assert.rejects(queryNative(fixture.socket, 'identity', abort.signal), failure('connection')); assert.equal(fixture.count(), 2);
});
test('a busy native worker may return one real observation after the former 1500ms deadline', async t => {
  let timer: NodeJS.Timeout | undefined;
  const fixture = await socketFixture(t, (socket, request) => {
    assert.ok(Array.isArray(request));
    timer = setTimeout(() => socket.end(reality(request[0] as bigint)), 1700);
  });
  t.after(() => clearTimeout(timer));
  assert.deepEqual(await queryNative(fixture.socket, 'real'), {ship: '~sampel-palnet', fake: false});
  assert.equal(fixture.count(), 1);
});
