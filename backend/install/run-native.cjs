#!/usr/bin/env node
'use strict';

// One owner-authorized native operation. No discovery, boot, retries or daemon.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const BASE_FILES = ['sys/hoon.hoon', 'sys/zuse.hoon', 'sys/lull.hoon', 'sys/vane/clay.hoon'];
const MOUNT_BASE = `=/  m  (strand ,vase)
;<  b=bowl  bind:m  get-bowl
;<  ~  bind:m  (send-raw-card [%pass /readymade-base-mount %arvo %c [%mont %base [[our.b %base da+now.b] /]]])
(pure:m !>(%readymade-base-mount-submitted))
`;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function baseExports(pier) {
  return BASE_FILES.map(name => {
    try {
      const file = path.join(pier, 'base', name);
      if (!fs.statSync(file).isFile()) return {name, ready: false};
      const bytes = fs.readFileSync(file);
      return {name, ready: bytes.length > 0, bytes: bytes.length, sha256: digest(bytes)};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return {name, ready: false};
    }
  });
}
function save(directory, name, bytes) {
  const fd = fs.openSync(path.join(directory, name), 'wx', 0o600);
  try {fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}
function json(directory, name, value) {save(directory, name, JSON.stringify(value, null, 2) + '\n');}

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--pier', '--vere', '--ship', '--source', '--output', '--timeout', '--operation'].includes(key) || !args[i + 1] || key in result) throw Error('Invalid or repeated argument');
    result[key] = args[i + 1];
  }
  for (const key of ['--pier', '--vere', '--ship', '--output']) if (!result[key]) throw Error(`Missing ${key}`);
  const operation = result['--operation'] ?? 'strand';
  if (!['strand', 'mount-base'].includes(operation)) throw Error('Operation must be strand or mount-base');
  if (operation === 'mount-base' && result['--source']) throw Error('mount-base accepts no supplied source');
  if (operation === 'strand' && !result['--source']) throw Error('Missing --source');
  if (!/^~[a-z]+(?:-[a-z]+)*$/.test(result['--ship'])) throw Error('Expected a literal ship identity');
  const timeout = Number(result['--timeout'] ?? 1200);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1200) throw Error('Timeout must be 1–1200 seconds');
  return {pier: fs.realpathSync(result['--pier']), vere: fs.realpathSync(result['--vere']), ship: result['--ship'], operation, source: operation === 'strand' ? fs.realpathSync(result['--source']) : undefined, output: path.resolve(result['--output']), timeout};
}

function exchange(socketPath, request, output, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let header = Buffer.alloc(0), received = 0, length, fd, settled = false;
    const timer = setTimeout(() => finish(Error('Native operation deadline expired; outcome unknown')), timeout * 1000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (fd !== undefined) {fs.fsyncSync(fd); fs.closeSync(fd);}
      if (error) reject(error); else resolve(received + 5);
    }
    socket.on('error', finish);
    socket.on('end', () => finish(Error('Native connection ended before a complete response; outcome unknown')));
    socket.on('connect', () => {
      try {
        json(output, 'submitted.json', {at: new Date().toISOString(), requestSHA256: digest(request)});
        socket.write(request);
      } catch (error) {finish(error);}
    });
    socket.on('data', chunk => {
      try {
        if (length === undefined) {
          const take = Math.min(5 - header.length, chunk.length);
          header = Buffer.concat([header, chunk.subarray(0, take)]);
          chunk = chunk.subarray(take);
          if (header.length < 5) return;
          length = header.readUInt32LE(1);
          if (header[0] !== 0 || length === 0 || length > 256 * 1024 * 1024) throw Error('Invalid or oversized native frame; outcome unknown');
          fd = fs.openSync(path.join(output, 'response.newt'), 'wx', 0o600);
          fs.writeFileSync(fd, header);
        }
        if (received + chunk.length > length) throw Error('Unexpected trailing native response bytes');
        fs.writeFileSync(fd, chunk);
        received += chunk.length;
        if (received === length) finish();
      } catch (error) {finish(error);}
    });
  });
}

async function run(config) {
  const {pier, vere, ship, source, output, timeout, operation = 'strand'} = config;
  if (!['strand', 'mount-base'].includes(operation) || (operation === 'mount-base' && source)) throw Error('Invalid operation/source combination');
  if (operation !== 'mount-base' && !baseExports(pier).every(file => file.ready)) throw Error('Mount %base natively and verify its four exports first');
  const socketPath = path.join(pier, '.urb/conn.sock');
  if (Buffer.byteLength(socketPath) >= 100 || !fs.statSync(socketPath).isSocket()) throw Error('A local native socket with a path shorter than 100 bytes is required');
  const bytes = operation === 'mount-base' ? Buffer.from(MOUNT_BASE) : fs.readFileSync(source);
  if (!bytes.length || bytes.length > 1536 * 1024) throw Error('Source must be 1–1572864 bytes; split larger operations');
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  if (/\/cv\/|%cv\b/.test(text)) throw Error('Historical Clay scans are not supported by this bounded runner');
  const guarded = `=/  readymade-transport  (strand ,vase)\n;<  readymade-bowl=bowl  bind:readymade-transport  get-bowl\n?>  &(=(${ship} our.readymade-bowl) =(our.readymade-bowl src.readymade-bowl))\n${text}`;
  const hex = Buffer.from(guarded).reverse().toString('hex').replace(/^0+/, '') || '0';
  const first = hex.length % 4 || 4;
  const cord = '0x' + [hex.slice(0, first), ...hex.slice(first).match(/.{4}/g) ?? []].join('.');
  const requestSource = `[0 [%fyrd %base %khan-eval %noun %ted-eval ${cord}]]`;
  fs.mkdirSync(output, {mode: 0o700});
  json(output, 'plan.json', {ship, pier, vere, operation, sourceSHA256: digest(bytes), vereSHA256: digest(fs.readFileSync(vere)), timeoutSeconds: timeout});
  save(output, 'source.hoon', guarded);
  // Vere's piped stdout can truncate large frames. Capture directly to a file.
  const requestFD = fs.openSync(path.join(output, 'request.newt'), 'wx', 0o600);
  let encoded;
  // Complete source verifiers are larger than individual app checks. Keep
  // encoding finite without imposing the old 30-second small-request limit.
  try {encoded = spawnSync(vere, ['eval', '-jn'], {input: requestSource, stdio: ['pipe', requestFD, 'pipe'], timeout: 120000, maxBuffer: 1024 * 1024});}
  finally {fs.fsyncSync(requestFD); fs.closeSync(requestFD);}
  save(output, 'encode.stderr', encoded.stderr ?? Buffer.alloc(0));
  json(output, 'encode.json', {status: encoded.status, signal: encoded.signal, error: encoded.error?.code ?? null, timeoutSeconds: 120, submitted: false});
  if (encoded.error || encoded.status !== 0) throw Error('Request encoding failed before submission; see private receipt');
  const request = fs.readFileSync(path.join(output, 'request.newt'));
  if (request.length < 5 || request[0] !== 0 || request.readUInt32LE(1) !== request.length - 5) throw Error('Encoder returned an invalid native frame');
  const lock = path.join(pier, '.urb/readymade-operation.lock');
  fs.mkdirSync(lock, {mode: 0o700});
  json(lock, 'owner.json', {pid: process.pid, output, sourceSHA256: digest(bytes)});
  let complete = false, releaseLock = false;
  try {
    const size = await exchange(socketPath, request, output, timeout);
    complete = true;
    json(output, 'received.json', {bytes: size, at: new Date().toISOString(), executionSuccess: 'not-yet-decoded'});
    if (size > 1024 * 1024) {
      json(output, 'result.json', {status: 'response-retained', executionSuccess: 'unverified', lockRetained: true, reason: 'Decode large response separately; do not repeat the operation'});
      return 2;
    }
    const responseFD = fs.openSync(path.join(output, 'response.hoon'), 'wx', 0o600);
    let decoded;
    try {decoded = spawnSync(vere, ['eval', '-cn'], {input: fs.readFileSync(path.join(output, 'response.newt')), stdio: ['pipe', responseFD, 'pipe'], timeout: 30000, maxBuffer: 1024 * 1024});}
    finally {fs.fsyncSync(responseFD); fs.closeSync(responseFD);}
    save(output, 'decode.stderr', decoded.stderr ?? Buffer.alloc(0));
    const decodedText = !decoded.error && decoded.status === 0 ? fs.readFileSync(path.join(output, 'response.hoon'), 'utf8').trim() : '';
    const success = /^\[0\s+%avow\s+0\s+%noun(?:\s|\])/.test(decodedText);
    const failure = /^\[0\s+%avow\s+1\s+%thread-fail(?:\s|\])/.test(decodedText);
    let exported;
    if (success && operation === 'mount-base') {
      const deadline = Date.now() + 10000;
      do {
        exported = baseExports(pier);
        if (exported.every(file => file.ready)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      json(output, 'base-exports.json', {files: exported, ready: exported.every(file => file.ready)});
    }
    const ready = success && (!exported || exported.every(file => file.ready));
    json(output, 'result.json', {status: failure ? 'native-failure' : !success ? 'response-needs-inspection' : ready ? 'native-success' : 'base-readback-incomplete', executionSuccess: success ? true : failure ? false : 'unverified', lockRetained: !(success || failure), ...(exported ? {baseExportsVerified: ready} : {}), responseSHA256: digest(fs.readFileSync(path.join(output, 'response.newt')))});
    // A complete frame alone does not identify the submitted operation's outcome.
    // Release only after retaining a decoded, correlated terminal response.
    releaseLock = success || failure;
    return ready ? 0 : 2;
  } catch (error) {
    if (complete) {
      json(output, 'inspection-error.json', {message: error.message, responseRetained: true, automaticRetry: false, lockRetained: true});
      throw Error('Complete native response retained but inspection failed. Inspect it; do not resubmit.');
    }
    json(output, 'unknown.json', {message: error.message, automaticRetry: false, lockRetained: true});
    throw Error('Native outcome unknown. Receipt and lock retained; observe canonical state before another write.');
  } finally {
    if (releaseLock) {fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock);}
  }
}

if (require.main === module) {
  if (process.argv.includes('--help')) {
    console.log('node backend/install/run-native.cjs --pier PATH --vere PATH --ship ~ship (--source prepared.hoon | --operation mount-base) --output NEW_PRIVATE_DIRECTORY [--timeout 1200]\nExecutes one authorized strand through the local native socket. Never retries. Existing output or operation lock is refused. mount-base sends only the built-in native Clay mount and verifies all four exports.');
  } else {
    run(options(process.argv.slice(2))).then(code => {console.log(code === 0 ? 'Native success; inspect private receipt for the operation result.' : 'Response retained; inspect private receipt. Do not resubmit.'); process.exitCode = code;}).catch(error => {console.error(error.message); process.exitCode = 1;});
  }
}
module.exports = {options, exchange, run, baseExports};
