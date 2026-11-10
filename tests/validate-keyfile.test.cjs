'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {validateKey} = require('../backend/install/validate-keyfile.cjs');
const digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-~';
const tuple = (...v) => v.slice(0, -1).reduceRight((tail, head) => [head, tail], v.at(-1));
const list = (...v) => v.reduceRight((tail, head) => [head, tail], 0n);
function uw(n) {
  let s = ''; do {s = digits[Number(n & 63n)] + s; n >>= 6n;} while (n);
  return Buffer.from('0w' + s.replace(/\B(?=(.{5})+(?!.))/g, '.'));
}
function jam(noun, references = false) {
  const bits = [], seen = new Map();
  const put = (n, count) => {for (let i = 0; i < count; i++) bits.push(Number((n >> BigInt(i)) & 1n));};
  const mat = n => {
    if (!n) {bits.push(1); return;}
    const size = n.toString(2).length, width = size.toString(2).length;
    bits.push(...Array(width).fill(0), 1); put(BigInt(size), width - 1); put(n, size);
  };
  const write = n => {
    if (references && seen.has(n)) {bits.push(1, 1); mat(BigInt(seen.get(n))); return;}
    const position = bits.length;
    if (Array.isArray(n)) {bits.push(1, 0); write(n[0]); write(n[1]);} else {bits.push(0); mat(n);}
    seen.set(n, position);
  };
  write(noun); let n = 0n; bits.forEach((b, i) => {if (b) n |= 1n << BigInt(i);}); return n;
}
const key = noun => uw(jam(noun));
const legacy = tuple(65536n, 1n, 42n, 0n);
const refused = bytes => assert.throws(() => validateKey(bytes, '65536'), /^Error: Networking keyfile refused: invalid format, identity or adapter limit$/);
test('accepts synthetic legacy, v1 and current Bridge v2 shapes with sanitized metadata', () => {
  assert.deepEqual(validateKey(key(legacy), 65536n), {shipAtom: '65536', feedVersion: 0, keyCount: 1});
  const keys = list([1n, 42n], [2n, 99n]);
  assert.deepEqual(validateKey(key(tuple([1n, 0n], 65536n, keys)), '65536'), {shipAtom: '65536', feedVersion: 1, keyCount: 2});
  const bytes = key(tuple([2n, 0n], 65536n, 7n, keys)), saved = Buffer.from(bytes);
  assert.deepEqual(validateKey(bytes, '65536'), {shipAtom: '65536', feedVersion: 2, keyCount: 2});
  assert.deepEqual(bytes, saved);
});
test('accepts wide atom molds and signature unit without invented bit-width limits', () => {
  const large = 1n << 4096n;
  assert.equal(validateKey(key(tuple(65536n, large, large, [0n, large])), '65536').keyCount, 1);
  assert.equal(validateKey(key(tuple([2n, 0n], 65536n, large, list([large, large]))), '65536').feedVersion, 2);
});
test('accepts valid backward references to both atoms and completed cells', () => {
  const pair = [1n, 42n], feed = tuple([2n, 0n], 65536n, 1n, list(pair, pair));
  const compressed = jam(feed, true);
  assert.notEqual(compressed, jam(feed));
  assert.deepEqual(validateKey(uw(compressed), '65536'), {shipAtom: '65536', feedVersion: 2, keyCount: 2});
});
test('only one optional final LF; exact ASCII alphabet, prefix and canonical grouping', () => {
  const good = key(legacy);
  assert.equal(validateKey(Buffer.concat([good, Buffer.from('\n')]), '65536').feedVersion, 0);
  for (const suffix of ['\n\n', '\r\n', ' ', '\0', '\t']) refused(Buffer.concat([good, Buffer.from(suffix)]));
  for (const text of ['0w0', '0w01', '0w1.1', '0w123456', '0w1.123456', '0w1_2345', '0w1+2345', '0w1/2345', '0x123', ' 0w1', '0w1.']) refused(Buffer.from(text));
  refused(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good]));
  refused(Buffer.concat([good, Buffer.from([0x80])]));
});
test('refuses malformed feed versions, units, atom fields and improper/empty key lists', () => {
  for (const noun of [0n, [1n, 0n], tuple(65536n, [0n, 0n], 1n, 0n), tuple(65536n, 1n, [0n, 0n], 0n),
    tuple(65536n, 1n, 1n, 1n), tuple(65536n, 1n, 1n, [1n, 2n]), tuple(65536n, 1n, 1n, [0n, [0n, 0n]]),
    tuple([3n, 0n], 65536n, list([1n, 2n])), tuple([1n, 1n], 65536n, list([1n, 2n])),
    tuple([1n, 0n], 65536n, 0n), tuple([1n, 0n], 65536n, [[1n, 2n], 1n]),
    tuple([2n, 0n], 65536n, [0n, 0n], list([1n, 2n])), tuple([1n, 0n], 65536n, list(1n))]) refused(key(noun));
});
test('rejects invalid/truncated jam, invalid references and trailing encoded data', () => {
  for (const packed of [1n, 7n, 15n, 31n]) refused(uw(packed));
  const packed = jam(legacy), size = packed.toString(2).length;
  refused(uw(packed | (1n << BigInt(Math.ceil(size / 8) * 8))));
  refused(uw(packed >> 1n));
});
test('identity and bounded-resource failures never expose input or private material', () => {
  for (const expected of ['0', '65535', '4294967296', '065536', '65536\n', 65536, null]) assert.throws(() => validateKey(key(legacy), expected));
  assert.throws(() => validateKey(key(legacy), '65537'));
  refused(Buffer.alloc(65537, 65));
  const keys = Array.from({length: 64}, (_, i) => [BigInt(i), 42n]);
  assert.equal(validateKey(key(tuple([1n, 0n], 65536n, list(...keys))), '65536').keyCount, 64);
  refused(key(tuple([1n, 0n], 65536n, list(...keys, [65n, 42n]))));
  let deep = 0n; for (let i = 0; i < 140; i++) deep = [deep, 0n]; refused(key(deep));
  const sentinel = 'PRIVATE_SENTINEL_NEVER_LOG';
  const original = Buffer.from(sentinel); refused(original); assert.equal(original.toString(), sentinel);
  assert.throws(() => validateKey(sentinel, '65536'), e => !String(e.stack).includes(sentinel));
});
