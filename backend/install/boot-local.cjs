'use strict';
// A bounded launcher for one new owned planet. Urbit is the persistent process.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const {spawn, spawnSync, execFileSync} = require('node:child_process');
const {isDeepStrictEqual: equal} = require('node:util');
const {validateKey} = require('./validate-keyfile.cjs');
const {cue, tuple, cord} = require('./inspect-spider.cjs');
const {captureHost} = require('./install-local.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const need = (ok, message) => {if (!ok) throw Error(message);};
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(value);
function safe(file, missing = false) {
  need(typeof file === 'string' && path.isAbsolute(file) && path.normalize(file) === file && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(file), 'Expected a clean absolute path');
  for (let p = missing ? path.dirname(file) : file;; p = path.dirname(p)) {need(!fs.lstatSync(p).isSymbolicLink(), 'Linked path refused'); if (p === path.dirname(p)) break;}
}
function read(file, limit = 256 * 1024 * 1024, privateMode = false) {
  safe(file); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    need(s.isFile() && s.nlink === 1 && [0, process.getuid()].includes(s.uid) && !(s.mode & 0o022) && s.size <= limit, 'Unsafe local file');
    if (privateMode) need(s.uid === process.getuid() && (s.mode & 0o777) === 0o600, 'Private key or receipt permissions required');
    const b = fs.readFileSync(fd), after = fs.fstatSync(fd);
    need(b.length === s.size && s.mtimeMs === after.mtimeMs && s.ctimeMs === after.ctimeMs, 'Input changed during read'); return b;
  } finally {fs.closeSync(fd);}
}
function save(directory, name, value) {
  const fd = fs.openSync(path.join(directory, name), 'wx', 0o600);
  try {fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  syncDirectory(directory);
}
function syncDirectory(directory) {const fd = fs.openSync(directory, 'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}}
function reservationFor(ship) {return path.join(os.userInfo().homedir, '.cache/readymade/local-planet-boots', ship.slice(1));}
function prepareRegistry() {
  const home = os.userInfo().homedir;
  for (const relative of ['.cache', '.cache/readymade', '.cache/readymade/local-planet-boots']) {
    const directory = path.join(home, relative);
    if (!fs.existsSync(directory)) {safe(directory, true); fs.mkdirSync(directory, {mode: 0o700}); syncDirectory(path.dirname(directory));}
    safe(directory); const s = fs.lstatSync(directory);
    need(s.isDirectory() && s.uid === process.getuid() && !(s.mode & 0o022), 'Unsafe local boot registry');
  }
  privateDirectory(path.join(home, '.cache/readymade/local-planet-boots'));
}
function privateDirectory(dir) {
  safe(dir); const s = fs.lstatSync(dir); need(s.isDirectory() && s.uid === process.getuid() && (s.mode & 0o777) === 0o700, 'Private owned directory required');
}
function argumentsFor(plan) {
  return ['--name', plan.ship.slice(1), '--key-file', plan.keyfile, '--pier', plan.pier, '--bootstrap', plan.pill,
    '--loom', '33', '--http-ip', '127.0.0.1', '--http-port', String(plan.httpPort), '--ames-port', String(plan.amesPort), '--no-tty'];
}
function identityAtom(vere, ship) {
  const child = spawnSync(vere, ['eval', '-jn'], {input: `[${ship} 0]`, encoding: null, timeout: 10000, maxBuffer: 65536, env: cleanEnvironment()});
  need(!child.error && child.status === 0 && !child.signal, 'Public ship name could not be parsed');
  const [identity, zero] = tuple(cue(child.stdout), 2);
  need(typeof identity === 'bigint' && identity >= 65536n && identity < 2n ** 32n && zero === 0n, 'Expected a canonical planet identity'); return identity;
}
function cleanEnvironment() {
  const env = {...process.env}; for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'PYTHONSTARTUP']) delete env[name]; return env;
}
function collisions(plan) {
  need(!fs.existsSync(plan.pier), 'Destination pier already exists');
  const processes = execFileSync('/bin/ps', ['-ww', '-axo', 'comm=,args='], {encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024}).split('\n');
  for (const line of processes) {
    const command = line.trim().split(/\s+/, 1)[0];
    if (!/(?:^|\/)(?:urbit|vere[^/]*)(?![\s\S])/.test(command)) continue;
    const words = line.trim().split(/\s+/);
    need(!words.includes(plan.pier) && !words.some((word, i) => ['-w', '--name', '-F', '--fake'].includes(word) && words[i + 1]?.replace(/^~/, '') === plan.ship.slice(1)), 'Another local runtime may own this identity');
  }
}
async function freePorts(httpPort, amesPort) {
  const dgram = require('node:dgram');
  const tcp = net.createServer(), udp = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => {tcp.once('error', reject); tcp.listen({host: '127.0.0.1', port: httpPort, exclusive: true}, resolve);});
    await new Promise((resolve, reject) => {udp.once('error', reject); udp.bind({address: '0.0.0.0', port: amesPort, exclusive: true}, resolve);});
  } finally {if (tcp.listening) await new Promise(resolve => tcp.close(resolve)); try {udp.close();} catch { /* Not bound after refusal. */ }}
}
function prepare(options) {
  need(process.platform === 'darwin' && process.arch === 'arm64', 'Local planet boot currently targets macOS arm64');
  need(equal(Object.keys(options).sort(), ['ship', 'pier', 'vere', 'pill', 'keyfile', 'output', 'httpPort', 'amesPort', 'runtimeSHA256', 'pillSHA256', 'singleInstanceConfirmed'].sort()), 'Unexpected boot options');
  need(options.singleInstanceConfirmed === true, 'Confirm this planet is stopped on every other host');
  need(typeof options.ship === 'string' && /^~[a-z]{6}-[a-z]{6}(?![\s\S])/.test(options.ship), 'Expected a literal planet name');
  for (const name of ['httpPort', 'amesPort']) need(Number.isInteger(options[name]) && options[name] >= 1024 && options[name] <= 65535, 'Invalid local port');
  need(hash(options.runtimeSHA256) && hash(options.pillSHA256), 'Expected pinned runtime and bootstrap');
  for (const name of ['pier', 'output']) {safe(options[name], true); need(!fs.existsSync(options[name]), 'Choose a new destination'); privateDirectory(path.dirname(options[name]));}
  need(options.pier !== options.output && !options.pier.startsWith(options.output + '/') && !options.output.startsWith(options.pier + '/'), 'Boot paths must be disjoint');
  need(Buffer.byteLength(path.join(options.pier, '.urb/conn.sock')) < 100, 'Pier path is too long for the native socket');
  const runtime = read(options.vere), pill = read(options.pill);
  need(sha(runtime) === options.runtimeSHA256 && sha(pill) === options.pillSHA256 && (fs.statSync(options.vere).mode & 0o111), 'Runtime or bootstrap pin differs');
  const atom = identityAtom(options.vere, options.ship), key = read(options.keyfile, 65536, true), metadata = validateKey(key, atom);
  collisions(options);
  const output = options.output; fs.mkdirSync(output, {mode: 0o700}); syncDirectory(path.dirname(output));
  const copiedKey = path.join(output, 'network.key'), fd = fs.openSync(copiedKey, 'wx', 0o600);
  try {fs.writeFileSync(fd, key); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  const plan = {schema: 'readymade-new-local-planet-v1', ship: options.ship, shipAtom: metadata.shipAtom, feedVersion: metadata.feedVersion, keyCount: metadata.keyCount,
    pier: options.pier, vere: options.vere, pill: options.pill, keyfile: copiedKey, httpPort: options.httpPort, amesPort: options.amesPort,
    runtimeSHA256: options.runtimeSHA256, pillSHA256: options.pillSHA256, keySHA256: sha(key), node: fs.realpathSync(process.execPath),
    nodeSHA256: sha(read(fs.realpathSync(process.execPath))), toolPins: Object.fromEntries(['boot-local.cjs', 'validate-keyfile.cjs', 'inspect-spider.cjs', 'run-native.cjs', 'install-local.cjs'].map(name => [name, sha(read(path.join(__dirname, name)))])),
    reservation: reservationFor(options.ship), singleInstanceConfirmed: true};
  const digest = sha(JSON.stringify(plan)); save(output, 'plan.json', {plan, digest});
  return {schema: 'readymade-local-boot-prepared-v1', ship: plan.ship, digest, ready: false, phase: 'boot-prepared'};
}
function checkFiles(plan) {
  for (const [file, expected] of [[plan.vere, plan.runtimeSHA256], [plan.pill, plan.pillSHA256], [plan.keyfile, plan.keySHA256], [plan.node, plan.nodeSHA256]]) need(sha(read(file, 256 * 1024 * 1024, file === plan.keyfile)) === expected, 'Boot input changed');
  for (const [name, expected] of Object.entries(plan.toolPins)) need(sha(read(path.join(__dirname, name))) === expected, 'Boot adapter changed');
  validateKey(read(plan.keyfile, 65536, true), plan.shipAtom);
}
function check(plan) {checkFiles(plan); collisions(plan);}
async function runAdapter(plan, output, args) {
  checkFiles(plan);
  const log = fs.openSync(output + '.log', 'wx', 0o600);
  const child = spawn(plan.node, [path.join(__dirname, 'run-native.cjs'), '--ship', plan.ship, '--pier', plan.pier, '--vere', plan.vere, '--output', output, '--timeout', '120', ...args], {stdio: ['ignore', log, log], env: cleanEnvironment()}); fs.closeSync(log);
  const code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', (code, signal) => signal ? reject(Error('Native adapter interrupted')) : resolve(code));});
  need(code === 0, 'Native readiness requires private receipt inspection');
  const result = JSON.parse(read(path.join(output, 'result.json'), 65536, true));
  need(result.status === 'native-success' && result.executionSuccess === true && result.lockRetained === false && result.responseSHA256 === sha(read(path.join(output, 'response.newt'))), 'Native readiness not established');
  return result;
}
async function launch(output, approvedDigest) {
  privateDirectory(output); const saved = JSON.parse(read(path.join(output, 'plan.json'), 65536, true)), {plan, digest} = saved;
  need(plan.schema === 'readymade-new-local-planet-v1' && sha(JSON.stringify(plan)) === digest && approvedDigest === digest && plan.reservation === reservationFor(plan.ship), 'Boot approval does not match the private plan');
  need(!fs.existsSync(path.join(output, 'launch-intent.json')), 'Boot already attempted; observe without replay');
  check(plan); await freePorts(plan.httpPort, plan.amesPort); check(plan);
  need(read(path.join(output, 'plan.json'), 65536, true).equals(Buffer.from(JSON.stringify(saved) + '\n')), 'Private boot plan changed');
  prepareRegistry();
  fs.mkdirSync(plan.reservation, {mode: 0o700}); syncDirectory(path.dirname(plan.reservation)); save(plan.reservation, 'owner.json', {digest, output, ship: plan.ship});
  save(output, 'launch-intent.json', {digest, at: new Date().toISOString(), arguments: argumentsFor(plan), automaticRetry: false});
  const log = fs.openSync(path.join(output, 'boot.log'), 'wx', 0o600);
  const child = spawn(plan.vere, argumentsFor(plan), {stdio: ['ignore', log, log], detached: true, env: cleanEnvironment()}); fs.closeSync(log);
  let ended = false; child.once('error', () => {ended = true;}); child.once('exit', () => {ended = true;}); child.unref();
  if (child.pid) save(output, 'started.json', {pid: child.pid, at: new Date().toISOString(), digest});
  try {
    const socket = path.join(plan.pier, '.urb/conn.sock'), deadline = Date.now() + 600000;
    while (!ended && !fs.existsSync(socket) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    need(!ended && fs.existsSync(socket) && fs.lstatSync(socket).isSocket(), 'Boot did not establish a native connection; inspect without starting another copy');
    // FIRST native operation after conn.sock: Clay %mont, then four file readbacks.
    const base = await runAdapter(plan, path.join(output, 'base'), ['--operation', 'mount-base']); need(base.baseExportsVerified === true, 'Required base exports missing');
    const source = path.join(output, 'identity.hoon');
    fs.writeFileSync(source, '=/  m  (strand ,vase)\n;<  b=bowl  bind:m  get-bowl\n(pure:m !>(our.b))\n', {flag: 'wx', mode: 0o600});
    await runAdapter(plan, path.join(output, 'identity'), ['--source', source]);
    const [id, kind, outcome, mark, identity] = tuple(cue(read(path.join(output, 'identity/response.newt'))), 5);
    need(id === 0n && kind === cord('avow') && outcome === 0n && mark === cord('noun') && identity === BigInt(plan.shipAtom), 'Native planet identity differs');
    const host = captureHost(plan); save(output, 'host.json', host);
    const result = {schema: 'readymade-local-planet-booted-v1', ship: plan.ship, pier: plan.pier, url: 'http://127.0.0.1:' + plan.httpPort, baseExportsVerified: true, identityVerified: true, phase: 'ship-booted-not-installed', ready: false, digest};
    save(output, 'result.json', result); return result;
  } catch {
    save(output, 'stopped.json', {phase: 'boot-needs-inspection', ready: false, automaticRetry: false, automaticSignal: false, digest});
    throw Error('Local boot stopped. Inspect private receipts before another operation.');
  }
}
module.exports = {prepare, launch, argumentsFor};
