'use strict';

// Offline diagnostics only. A saved Spider carrier has no completion journal.
const {createHash} = require('node:crypto');
const MAX_BYTES = 32 * 1024 * 1024, MAX_NODES = 1_000_000, MAX_ITEMS = 100_000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function need(ok, message) {if (!ok) throw new Error(message);}
function cord(text) {return BigInt('0x' + Buffer.from(text).reverse().toString('hex'));}
function cell(noun) {need(Array.isArray(noun), 'Malformed native cell'); return noun;}
function tuple(noun, length) {
  const out = [];
  for (let i = 1; i < length; i++) {const pair = cell(noun); out.push(pair[0]); noun = pair[1];}
  return [...out, noun];
}
function atom(noun) {need(typeof noun === 'bigint', 'Malformed native atom'); return noun;}
function text(noun, max = 256) {
  let hex = atom(noun).toString(16); if (hex.length % 2) hex = '0' + hex;
  need(hex.length <= max * 2, 'Native text exceeds limit');
  const bytes = noun === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex').reverse();
  const value = bytes.toString('utf8');
  need(Buffer.from(value).equals(bytes) && !/[\u0000-\u001f\u007f]/u.test(value), 'Invalid native text');
  return value;
}
function list(noun, limit = MAX_ITEMS) {
  const out = [];
  while (Array.isArray(noun)) {need(out.length < limit, 'Native list exceeds limit'); out.push(noun[0]); noun = noun[1];}
  need(noun === 0n, 'Malformed native list'); return out;
}
function tree(noun) {
  const pending = [noun], out = [];
  while (pending.length) {
    const node = pending.pop(); if (node === 0n) continue;
    need(out.length < MAX_ITEMS, 'Native tree exceeds limit');
    const [value, left, right] = tuple(node, 3); out.push(value); pending.push(left, right);
  }
  return out;
}
function cue(frame) {
  need(Buffer.isBuffer(frame) && frame.length >= 6 && frame.length <= MAX_BYTES && frame[0] === 0 &&
    frame.readUInt32LE(1) === frame.length - 5, 'Invalid native frame');
  const data = frame.subarray(5), memo = new Map(), stack = []; let cursor = 0, nodes = 0;
  const bits = count => {
    need(Number.isSafeInteger(count) && count >= 0 && count <= data.length * 8 - cursor, 'Truncated jam');
    if (!count) return 0n;
    const start = cursor, offset = start % 8; cursor += count;
    if (count === 1) return BigInt((data[Math.floor(start / 8)] >> offset) & 1);
    const bytes = Buffer.from(data.subarray(Math.floor(start / 8), Math.ceil(cursor / 8))).reverse();
    return (BigInt('0x' + bytes.toString('hex')) >> BigInt(offset)) & ((1n << BigInt(count)) - 1n);
  };
  const mat = () => {
    let width = 0;
    while (bits(1) === 0n) {width++; need(width < 30, 'Jam atom width exceeds limit');}
    return width ? bits(2 ** (width - 1) + Number(bits(width - 1))) : 0n;
  };
  for (;;) {
    need(++nodes <= MAX_NODES, 'Jam node limit exceeded');
    const position = cursor; let noun;
    if (bits(1) === 0n) {noun = mat(); memo.set(position, noun);}
    else if (bits(1) === 0n) {stack.push([position]); continue;}
    else {
      const reference = mat();
      need(reference < BigInt(position) && memo.has(Number(reference)), 'Invalid jam reference');
      noun = memo.get(Number(reference));
    }
    while (stack.length && stack.at(-1).length === 2) {
      const [at, head] = stack.pop(); noun = [head, noun]; memo.set(at, noun);
    }
    if (!stack.length) {
      const remaining = data.length * 8 - cursor;
      need(remaining < 8 && bits(remaining) === 0n, 'Trailing jam data'); return noun;
    }
    stack.at(-1).push(noun);
  }
}
// Shape-independent Merkle digest: domain-separated atom bytes and cell hashes.
function nounHash(noun) {
  const memo = new Map(), pending = [[noun, false]];
  while (pending.length) {
    const [node, ready] = pending.pop(); if (memo.has(node)) continue;
    if (!Array.isArray(node)) {
      let hex = atom(node).toString(16); if (hex.length % 2) hex = '0' + hex;
      memo.set(node, createHash('sha256').update('atom:').update(Buffer.from(hex, 'hex')).digest());
    } else if (ready) memo.set(node, createHash('sha256').update('cell:').update(memo.get(node[0])).update(memo.get(node[1])).digest());
    else pending.push([node, true], [node[1], false], [node[0], false]);
  }
  return memo.get(noun).toString('hex');
}
function mapped(noun, keyOf, valueOf) {
  const seen = new Set();
  return tree(noun).map(entry => {
    const [key, value] = cell(entry), id = keyOf(key);
    need(!seen.has(id), 'Duplicate native map key'); seen.add(id); valueOf(value); return id;
  });
}
const path = noun => list(noun, 128).map(part => text(part));
const tid = noun => {const id = text(noun); need(/^[a-z0-9._~-]{1,256}$/.test(id), 'Invalid Spider thread ID'); return id;};
const yarn = noun => {const ids = list(noun, 128).map(tid); need(ids.length > 0, 'Empty Spider yarn'); return ids;};
const duct = noun => {list(noun, 128).forEach(path); return nounHash(noun);};
const route = noun => {const [wire, ship, app] = tuple(noun, 3); path(wire); atom(ship); text(app); return nounHash(noun);};
function timestamp(value) {
  const m = /^~([1-9][0-9]{0,11})(-?)\.([0-9]{2})\.([0-9]{2})(?:\.\.([0-9]{2})\.([0-9]{2})\.([0-9]{2})(?:\.\.([0-9a-f]{4}(?:\.[0-9a-f]{4}){0,3}))?)?$/.exec(value);
  need(m, 'Invalid native observation timestamp');
  const year = 292277024400n + (m[2] ? 1n - BigInt(m[1]) : BigInt(m[1]));
  const month = Number(m[3]), day = Number(m[4]), hour = Number(m[5] ?? 0), minute = Number(m[6] ?? 0), second = Number(m[7] ?? 0);
  const leap = year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  need(year >= 0n && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour < 24 && minute < 60 && second < 60 &&
    m[8]?.split('.').at(-1) !== '0000' && !(m[5] !== undefined && !hour && !minute && !second && !m[8]), 'Invalid native observation timestamp');
}

function inspectSpider(frame, expectedShip) {
  need(typeof expectedShip === 'string' && /^~[a-z-]{3,127}$/.test(expectedShip), 'Expected ship is required');
  const [request, kind, unit, omen, location, mark, carrier] = tuple(cue(frame), 7);
  need(request === 0n && kind === cord('peek') && unit === 0n && omen === cord('omen') && mark === cord('noun'), 'Unrelated native response');
  const place = path(location);
  need(place.length === 5 && place[0] === 'gv' && place[1] === expectedShip && place[2] === 'spider' && place[4] === '', 'Wrong Spider observation address');
  timestamp(place[3]);
  const [version, egg] = cell(carrier); need(version === 20n, 'Unsupported Gall carrier');
  const fields = tuple(egg, 16);
  need(fields[0] === cord('live') && fields[8] === 0n, 'Expected saved live Gall carrier');
  duct(fields[1]); atom(fields[2]); atom(fields[3]); tuple(fields[4], 3).forEach(atom);
  const incoming = mapped(fields[5], duct, value => {const [ship, p] = cell(value); atom(ship); path(p);});
  const outgoing = mapped(fields[6], route, value => {const [acked, p] = cell(value); need(acked === 0n || acked === 1n, 'Invalid subscription flag'); path(p);});
  const nonces = mapped(fields[7], route, atom);
  const [saved, vase] = cell(fields[9]); need(saved === 1n, 'Carrier contains executable agent');
  const [type, state] = cell(vase); need(Array.isArray(type) || typeof type === 'bigint', 'Missing native type');
  const [stateVersion, starting, running, tids, serving, scrying] = tuple(state, 6);
  need(stateVersion === 8n, 'Unsupported Spider saved state');
  const starts = mapped(starting, value => JSON.stringify(yarn(value)), value => {
    const [trying, body] = cell(value); need(trying === cord('build') || trying === cord('none'), 'Invalid Spider starting state'); cell(body);
  }).map(value => JSON.parse(value));
  const runs = list(running, 1024).map(yarn);
  need(new Set(runs.map(value => JSON.stringify(value))).size === runs.length, 'Duplicate running Spider yarn');
  const ids = mapped(tids, tid, yarn);
  mapped(serving, tid, value => {
    const [request, mark, desk] = tuple(value, 3); text(mark); text(desk);
    if (request !== 0n) {const [unit, body] = cell(request); need(unit === 0n, 'Invalid serving unit'); const [rid, take] = cell(body); text(rid); need(take === cord('json') || take === cord('noun'), 'Invalid serving format');}
  });
  const scries = mapped(scrying, tid, value => {tree(value).forEach(entry => {const [wire, ship, p] = tuple(entry, 3); path(wire); atom(ship); path(p);});});
  const [ship, desk, revision] = tuple(fields[10], 3); atom(ship); text(desk); const [revisionKind, revisionValue] = cell(revision); text(revisionKind); atom(revisionValue);
  mapped(fields[11], duct, text);
  const [farm] = tuple(fields[12], 3); need(farm === cord('plot') || farm === cord('coop'), 'Invalid Gall farm');
  for (const index of [13, 14, 15]) tree(fields[index]).forEach(entry => cell(entry));
  need(starts.reduce((n, row) => n + row.length, 0) + runs.reduce((n, row) => n + row.length, 0) + ids.length <= 1024, 'Spider summary exceeds thread limit');
  return {schema: 'readymade-spider-inspection-v1', ship: expectedShip, observedAt: place[3],
    responseSHA256: hash(frame), stateSHA256: nounHash(state), carrierSHA256: nounHash(carrier), hashFormat: 'sha256-noun-merkle-v1',
    counts: {starting: starts.length, running: runs.length, tid: ids.length, serving: tree(serving).length, scrying: scries.length,
      incomingSubscriptions: incoming.length, outgoingSubscriptions: outgoing.length, subscriptionNonces: nonces.length},
    threads: {starting: starts, running: runs, mapped: ids}, previousOperationOutcome: 'unknown', replayAuthorized: false, operationLockUntouched: true};
}
module.exports = {inspectSpider, cue, tuple, list, text, cord};
