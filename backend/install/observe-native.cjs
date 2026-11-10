#!/usr/bin/env node
'use strict';

// Fixed read-only connection queries. Never starts a thread or releases a lock.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {exchange, baseExports} = require('./run-native.cjs');
const {inspectSpider} = require('./inspect-spider.cjs');
const QUERIES = Object.freeze({
  identity: '[0 %peel /who]',
  threads: '[0 %peek [%| %once %gx %spider /tree/noun]]',
  'spider-state': '[0 %peek [%| %once %gv %spider /$]]',
  'current-domes': '[0 %peek [%| %once %cx %$ /domes]]',
  'app-inventory': '[0 %peek [%| %once %gf %$ /$]]',
  'activity-agent': '[0 %peek [%| %once %gv %readymade-editing /$]]',
  'app-carrier': '[0 %peek [%| %once %gv %APP /$]]',
  'app-liveness': '[0 %peek [%| %once %gu %APP /$]]',
  'eyre-bindings': '[0 %peek [%| %once %e %bindings ~]]'
});
// Native namespaces also used by snapshot.hoon. These receipts require separate
// offline inspection; a syntactically plausible text prefix is not verification.
const RAW_QUERIES = new Set(['current-domes', 'app-inventory', 'activity-agent', 'app-carrier', 'app-liveness', 'eyre-bindings']);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function save(output, name, bytes) { fs.writeFileSync(path.join(output, name), bytes, {flag: 'wx', mode: 0o600}); }
function json(output, name, value) { save(output, name, JSON.stringify(value, null, 2) + '\n'); }
function options(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--pier', '--vere', '--query', '--ship', '--app', '--output', '--timeout'].includes(key) || !args[i + 1] || key in values) throw Error('Invalid or repeated argument');
    values[key] = args[i + 1];
  }
  for (const key of ['--pier', '--vere', '--query', '--output']) if (!values[key]) throw Error(`Missing ${key}`);
  const query = values['--query'];
  if (!Object.hasOwn(QUERIES, query)) throw Error(`Query must be one of: ${Object.keys(QUERIES).join(', ')}`);
  const timeout = Number(values['--timeout'] ?? 10);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60) throw Error('Timeout must be 1–60 seconds');
  expectedShip(query, values['--ship']);
  nativeRequest(query, values['--app']);
  return {pier: fs.realpathSync(values['--pier']), vere: fs.realpathSync(values['--vere']), query, ship: values['--ship'], app: values['--app'], output: path.resolve(values['--output']), timeout};
}
function expectedShip(query, ship) {
  const required = query === 'spider-state' || RAW_QUERIES.has(query);
  if (required && (typeof ship !== 'string' || ship.length > 128 || !/^~[a-z]{3}(?:[a-z]{3}(?:-[a-z]{6}){0,3}(?:--[a-z]{6}(?:-[a-z]{6}){3})?)?$/.test(ship))) throw Error(`${query} requires --ship with the expected literal identity`);
  if (!required && ship !== undefined) throw Error('--ship is only supported for state snapshot queries');
}
function nativeRequest(query, app) {
  if (query === 'app-carrier' || query === 'app-liveness') {
    if (typeof app !== 'string' || app.length > 64 || !/^[a-z][a-z0-9-]*$/.test(app)) throw Error(`${query} requires --app with a literal app name of 1–64 lowercase letters, digits or hyphens, starting with a letter`);
    return `[0 %peek [%| %once %${query === 'app-carrier' ? 'gv' : 'gu'} %${app} /$]]`;
  }
  if (app !== undefined) throw Error('--app is only supported for app-carrier and app-liveness');
  return QUERIES[query];
}
async function observe({pier, vere, query, ship, app, output, timeout = 10}) {
  if (!Object.hasOwn(QUERIES, query) || !Number.isInteger(timeout) || timeout < 1 || timeout > 60) throw Error('Invalid fixed query or timeout');
  expectedShip(query, ship);
  const requestText = nativeRequest(query, app);
  if (!baseExports(pier).every(file => file.ready)) throw Error('The four native base exports must be present');
  const socket = path.join(pier, '.urb/conn.sock');
  if (Buffer.byteLength(socket) >= 100 || !fs.statSync(socket).isSocket()) throw Error('A short local native socket path is required');
  fs.mkdirSync(output, {mode: 0o700});
  json(output, 'plan.json', {query, expectedShip: ship, app, request: requestText, pier, vereSHA256: hash(fs.readFileSync(vere)), timeoutSeconds: timeout,
    scope: 'Read-only observation; does not determine the outcome of an earlier operation', clearsOperationLock: false});
  const fd = fs.openSync(path.join(output, 'request.newt'), 'wx', 0o600);
  let encoded;
  try { encoded = spawnSync(vere, ['eval', '-jn'], {input: requestText, stdio: ['pipe', fd, 'pipe'], timeout: 30000, maxBuffer: 1024 * 1024}); }
  finally { fs.closeSync(fd); }
  save(output, 'encode.stderr', encoded.stderr ?? Buffer.alloc(0));
  if (encoded.error || encoded.status !== 0) throw Error('Observation encoding failed before submission');
  const request = fs.readFileSync(path.join(output, 'request.newt'));
  if (request.length < 6 || request[0] !== 0 || request.readUInt32LE(1) !== request.length - 5) throw Error('Invalid encoded frame; no query sent');
  try { await exchange(socket, request, output, timeout); }
  catch (error) {
    json(output, 'unavailable.json', {message: error.message, automaticRetry: false, previousOperationOutcome: 'unknown', operationLockUntouched: true});
    throw Error('Read-only observation unavailable; prior outcome remains unknown. No lock was cleared.');
  }
  const response = fs.readFileSync(path.join(output, 'response.newt'));
  if (RAW_QUERIES.has(query)) {
    json(output, 'result.json', {status: 'frame-retained', query, expectedShip: ship, app,
      decoded: false, textDecoded: false, envelopeVerified: false, identityVerified: false,
      responseBytes: response.length, responseSHA256: hash(response), previousOperationOutcome: 'unknown',
      replayAuthorized: false, operationLockUntouched: true,
      scope: 'Raw current-state frame only; separate bounded offline inspection required'});
    return 2;
  }
  if (response.length > 1024 * 1024) {
    let spiderState, inspectionError;
    if (query === 'spider-state') {
      try {spiderState = inspectSpider(response, ship);} catch (error) {inspectionError = error.message;}
    }
    json(output, 'result.json', {status: spiderState ? 'observation-retained' : 'frame-retained', decoded: !!spiderState,
      textDecoded: false, responseSHA256: hash(response), previousOperationOutcome: 'unknown', operationLockUntouched: true,
      ...(spiderState ? {spiderState} : {}), ...(inspectionError ? {inspectionError} : {})});
    return spiderState ? 0 : 2;
  }
  const responseFD = fs.openSync(path.join(output, 'response.hoon'), 'wx', 0o600);
  let decoded;
  try { decoded = spawnSync(vere, ['eval', '-cn'], {input: response, stdio: ['pipe', responseFD, 'pipe'], timeout: 15000, maxBuffer: 1024 * 1024}); }
  finally { fs.closeSync(responseFD); }
  save(output, 'decode.stderr', decoded.stderr ?? Buffer.alloc(0));
  const responseText = fs.readFileSync(path.join(output, 'response.hoon'), 'utf8').trim();
  // Synchronous /who is [request-id ~ ship-number], not a %peek cask.
  const shape = query === 'identity' ? /^\[0\s+0\s+(?:0|[1-9][0-9]*(?:\.[0-9]{3})*)\]$/ : /^\[0\s+%peek(?:\s|\])/;
  let valid = !decoded.error && decoded.status === 0 && shape.test(responseText), spiderState, inspectionError;
  if (query === 'spider-state') {
    try {spiderState = inspectSpider(response, ship);}
    catch (error) {valid = false; inspectionError = error.message;}
  }
  json(output, 'result.json', {status: valid ? 'observation-retained' : 'response-needs-inspection', decoded: valid,
    responseSHA256: hash(response), identityVerified: false, previousOperationOutcome: 'unknown', operationLockUntouched: true,
    ...(valid && spiderState ? {spiderState} : {}), ...(inspectionError ? {inspectionError} : {})});
  return valid ? 0 : 2;
}
if (require.main === module) {
  if (process.argv.includes('--help')) console.log(`node backend/install/observe-native.cjs --pier PATH --vere PATH --query ${Object.keys(QUERIES).join('|')} --output NEW_PRIVATE_DIRECTORY [--timeout 10] [--ship ~expected-ship] [--app literal-app-name]\nState snapshot queries require --ship. app-carrier and app-liveness additionally require --app. current-domes, app-inventory, activity-agent, app-carrier, app-liveness and eyre-bindings retain raw unverified frames and exit 2. Never retries, starts a thread, or clears an operation lock. Inspect the response; a missing thread is not proof of success.`);
  else observe(options(process.argv.slice(2))).then(code => {console.log('Read-only receipt retained. Inspect it; the prior operation remains unqualified.'); process.exitCode = code;}).catch(error => {console.error(error.message); process.exitCode = 1;});
}
module.exports = {QUERIES, options, observe};
