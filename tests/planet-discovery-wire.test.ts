import test from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {createRequire} from 'node:module';
import {encodeLoginCodeRequest, decodeLoginCode, queryLoginCode, encodeQuery, decodeQuery, queryNative, NativeObservationFailure, LOCAL_OBSERVATION_TIMEOUT_MS, type NativeQuery, type NativeObservationReason} from '../src/planet-discovery-wire';
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

const codeReply = (id = 73n, value: Noun = cord('lidlut-tabwed-pillex-ridrup'), failed = 0n, mark = cord('noun')) => frame(tup(id, cord('avow'), failed, mark, value));
test('login code request is one owner-guarded strand that only reads the ship\'s own code', () => {
  const [id, kind, desk, thread, output, input, source] = (function parts(n: Noun, k: number): Noun[] {const r: Noun[] = []; for (let i = 1; i < k; i++) {assert.ok(Array.isArray(n)); r.push(n[0]); n = n[1];} return [...r, n];})(cue(encodeLoginCodeRequest(73)), 7);
  assert.deepEqual([id, kind, desk, thread, output, input], [73n, cord('fyrd'), cord('base'), cord('khan-eval'), cord('noun'), cord('ted-eval')]);
  assert.equal(typeof source, 'bigint');
  let hex = (source as bigint).toString(16); if (hex.length % 2) hex = '0' + hex;
  const text = Buffer.from(hex, 'hex').reverse().toString('utf8');
  assert.match(text, /\?>  =\(our\.b src\.b\)/);
  assert.match(text, /\(scry @p \/j\/code\/\(scot %p our\.b\)\)/);
  assert.doesNotMatch(text, /poke|send-raw|%pass|%c |%dirk|%mont|\.\^/);
  assert.throws(() => encodeLoginCodeRequest(-1));
});
test('login code reply is accepted only as a correlated success holding one well-formed code', () => {
  assert.equal(decodeLoginCode(73, codeReply()), 'lidlut-tabwed-pillex-ridrup');
  for (const [name, bad] of [
    ['wrong request id', codeReply(74n)],
    ['reported thread failure', codeReply(73n, cord('lidlut-tabwed-pillex-ridrup'), 1n, cord('thread-fail'))],
    ['unexpected mark', codeReply(73n, cord('lidlut-tabwed-pillex-ridrup'), 0n, cord('json'))],
    ['ship name instead of a code', codeReply(73n, cord('~sampel-palnet'))],
    ['code with a leading sig', codeReply(73n, cord('~lidlut-tabwed-pillex-ridrup'))],
    ['cell payload', codeReply(73n, [1n, 2n])],
  ] as const) assert.throws(() => decodeLoginCode(73, bad), failure('envelope'), name);
  assert.throws(() => decodeLoginCode(73, Buffer.from([0, 9, 0, 0, 0, 1])), failure('frame-or-decode'));
});
test('login code query uses the socket once and returns only a matching reply', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rm-code-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const socket = path.join(root, 'conn.sock'); let requests = 0, mode: 'good' | 'fail' = 'good';
  const server = net.createServer(connection => {
    connection.once('data', request => {
      requests++; const id = (cue(request) as [bigint, Noun])[0];
      connection.end(mode === 'good' ? codeReply(id) : codeReply(id, 0n, 1n, cord('thread-fail')));
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve)); t.after(() => server.close());
  assert.equal(await queryLoginCode(socket), 'lidlut-tabwed-pillex-ridrup');
  mode = 'fail'; await assert.rejects(queryLoginCode(socket), failure('envelope'));
  assert.equal(requests, 2, 'A refused reply is never retried');
  await assert.rejects(queryLoginCode(path.join(root, 'absent.sock')), failure('connection'));
});
