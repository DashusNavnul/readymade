'use strict';
// Format admission only. Native dawn still verifies current networking keys.
// These are adapter resource limits, not limits of Urbit atom molds.
const MAX_BYTES = 64 * 1024, MAX_KEYS = 64, MAX_NODES = 8192, MAX_DEPTH = 128;
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-~';
const need = ok => {if (!ok) throw Error('Invalid networking keyfile');};

function decode(data) {
  let cursor = 0, nodes = 0;
  const memo = new Map(), stack = [];
  const bits = count => {
    need(Number.isSafeInteger(count) && count >= 0 && count <= data.length * 8 - cursor);
    if (!count) return 0n;
    const start = cursor, offset = start % 8; cursor += count;
    if (count === 1) return BigInt((data[start >> 3] >> offset) & 1);
    const bytes = Buffer.from(data.subarray(start >> 3, Math.ceil(cursor / 8))).reverse();
    return (BigInt('0x' + bytes.toString('hex')) >> BigInt(offset)) & ((1n << BigInt(count)) - 1n);
  };
  const mat = () => {
    let width = 0;
    while (bits(1) === 0n) {need(++width < 30);}
    return width ? bits(2 ** (width - 1) + Number(bits(width - 1))) : 0n;
  };
  for (;;) {
    need(++nodes <= MAX_NODES);
    const at = cursor; let noun;
    if (bits(1) === 0n) {noun = mat(); memo.set(at, noun);}
    else if (bits(1) === 0n) {need(stack.length < MAX_DEPTH); stack.push([at]); continue;}
    else {
      const ref = mat(); need(ref < BigInt(at) && memo.has(Number(ref)));
      noun = memo.get(Number(ref));
    }
    while (stack.length && stack.at(-1).length === 2) {
      const [position, head] = stack.pop(); noun = [head, noun]; memo.set(position, noun);
    }
    if (!stack.length) {
      const remaining = data.length * 8 - cursor;
      need(remaining < 8 && bits(remaining) === 0n); return noun;
    }
    stack.at(-1).push(noun);
  }
}
const atom = value => typeof value === 'bigint' && value >= 0n;
function tuple(noun, size) {
  const fields = [];
  for (let i = 1; i < size; i++) {need(Array.isArray(noun)); fields.push(noun[0]); noun = noun[1];}
  return [...fields, noun];
}
function validateKey(bytes, expectedShipAtom) {
  try {
    need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_BYTES);
    need(typeof expectedShipAtom === 'bigint' || (typeof expectedShipAtom === 'string' && /^[1-9][0-9]*(?![\s\S])/.test(expectedShipAtom) && expectedShipAtom.length <= 10));
    const expected = BigInt(expectedShipAtom); need(expected >= 65536n && expected < 2n ** 32n);
    let input = bytes.toString('ascii'); need(Buffer.from(input, 'ascii').equals(bytes));
    if (input.endsWith('\n')) input = input.slice(0, -1);
    need(/^0w[1-9a-zA-Z~-][0-9a-zA-Z~-]{0,4}(?:\.[0-9a-zA-Z~-]{5})*(?![\s\S])/.test(input));
    let packed = 0n;
    for (const group of input.slice(2).split('.')) {
      let value = 0n; for (const digit of group) value = value * 64n + BigInt(DIGITS.indexOf(digit));
      packed = (packed << BigInt(group.length * 6)) | value;
    }
    let hex = packed.toString(16); if (hex.length % 2) hex = '0' + hex;
    const feed = decode(Buffer.from(hex, 'hex').reverse()); need(Array.isArray(feed));
    let ship, version = 0, count = 1;
    if (atom(feed[0])) {
      const [who, life, key, signature] = tuple(feed, 4); ship = who;
      need(atom(life) && atom(key));
      need(signature === 0n || (Array.isArray(signature) && signature[0] === 0n && atom(signature[1])));
    } else {
      const [tag, zero] = tuple(feed[0], 2); need((tag === 1n || tag === 2n) && zero === 0n);
      version = Number(tag);
      const fields = tuple(feed, version === 1 ? 3 : 4); ship = fields[1];
      if (version === 2) need(atom(fields[2]));
      let keys = fields.at(-1); count = 0;
      while (Array.isArray(keys)) {
        need(++count <= MAX_KEYS);
        const [life, key] = tuple(keys[0], 2); need(atom(life) && atom(key)); keys = keys[1];
      }
      need(keys === 0n && count > 0);
    }
    need(ship === expected);
    return {shipAtom: String(ship), feedVersion: version, keyCount: count};
  } catch {throw Error('Networking keyfile refused: invalid format, identity or adapter limit');}
}
module.exports = {validateKey};
