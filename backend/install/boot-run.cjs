#!/usr/bin/env node
'use strict';

// Start one new planet from its keyfile with the runtime and boot pill shipped beside these tools,
// reported as plain progress for a button. It adds no authority: boot-local.cjs validates the key,
// reserves the identity, launches once and performs the first native operations. This only chooses
// a private folder and free local ports, supplies the shipped pins, and reads retained evidence.
const fs = require('node:fs');
const net = require('node:net');
const dgram = require('node:dgram');
const path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');
const boot = require('./boot-local.cjs');
const {lockHolders} = require('./install-local.cjs');

const need = (ok, message) => {if (!ok) throw Error(message);};
const readJSON = file => {try {return JSON.parse(fs.readFileSync(file, 'utf8'));} catch {return undefined;}};
const PLANET = /^~[a-z]{6}-[a-z]{6}(?![\s\S])/;

/** The runtime and pill the package step placed beside the tools, with the hashes it recorded. */
function shippedRuntime(directory = path.join(__dirname, '../runtime')) {
  const pins = readJSON(path.join(directory, 'runtime.json'));
  need(pins && /^[0-9a-f]{64}$/.test(pins.runtimeSHA256 ?? '') && /^[0-9a-f]{64}$/.test(pins.pillSHA256 ?? ''), 'This build does not include the Urbit runtime');
  return {vere: path.join(directory, 'urbit'), pill: path.join(directory, 'brass.pill'), runtimeSHA256: pins.runtimeSHA256, pillSHA256: pins.pillSHA256};
}
/** A planet name taken from a keyfile's name, e.g. sampel-palnet-1.key. The key's content is checked against it later. */
function planetFromKeyfile(file) {
  const match = /^([a-z]{6}-[a-z]{6})(?:-\d+)?\.key$/.exec(path.basename(String(file)));
  return match ? '~' + match[1] : undefined;
}
const bindable = (port, host) => new Promise(resolve => {const server = net.createServer(); server.once('error', () => resolve(false)); server.listen({port, host, exclusive: true}, () => server.close(() => resolve(true)));});
const answering = port => new Promise(resolve => {
  const socket = net.createConnection({port, host: '127.0.0.1'}); const done = value => {socket.destroy(); resolve(value);};
  socket.setTimeout(500, () => done(false)); socket.once('connect', () => done(true)); socket.once('error', () => done(false));
});
/**
 * Free for a loopback web server only if nothing answers on it and it can be bound both ways. A bind to
 * 127.0.0.1 alone succeeds on macOS while another ship listens on every address (seen: 8080 was offered
 * while a running planet held *:8080).
 */
async function tcpFree(port) {return !(await answering(port)) && await bindable(port, '0.0.0.0') && await bindable(port, '127.0.0.1');}
function udpFree(port) {
  return new Promise(resolve => {const socket = dgram.createSocket('udp4'); socket.once('error', () => {socket.close(); resolve(false);}); socket.bind({port, exclusive: true}, () => socket.close(() => resolve(true)));});
}
/** First free port at or after `from`, trying at most `tries`. */
async function firstFree(from, free, tries = 200) {
  for (let port = from; port < from + tries && port <= 65535; port++) if (await free(port)) return port;
  throw Error('No free local port was found');
}

/** Choose folder and ports and prepare the boot. Validates the key privately; starts nothing. */
async function prepare({ship, keyfile, root, singleInstanceConfirmed}, runtime = shippedRuntime()) {
  need(PLANET.test(ship ?? ''), 'Expected a planet name such as ~sampel-palnet');
  need(singleInstanceConfirmed === true, 'Confirm this planet is not running anywhere else');
  need(typeof root === 'string' && path.isAbsolute(root), 'Expected a private folder for ships');
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  const name = ship.slice(1), pier = path.join(root, name), output = path.join(root, name + '-boot');
  need(!fs.existsSync(pier) && !fs.existsSync(output), 'This planet was already set up here. Start it instead of setting it up again.');
  const httpPort = await firstFree(8080, tcpFree), amesPort = await firstFree(31400, udpFree);
  const prepared = boot.prepare({ship, pier, vere: runtime.vere, pill: runtime.pill, keyfile, output, httpPort, amesPort,
    runtimeSHA256: runtime.runtimeSHA256, pillSHA256: runtime.pillSHA256, singleInstanceConfirmed: true});
  return {ship, digest: prepared.digest, pier, output, httpPort};
}
const ROWS = [
  ['start', 'Starting your planet', output => fs.existsSync(path.join(output, 'started.json'))],
  ['up', 'Waiting for it to come up (first start takes a few minutes)', output => fs.existsSync(path.join(output, 'base'))],
  ['base', 'Preparing it', output => readJSON(path.join(output, 'base/result.json'))?.baseExportsVerified === true],
  ['identity', 'Checking it is your planet', output => readJSON(path.join(output, 'result.json'))?.identityVerified === true],
];
/** Where a boot stands, from retained evidence only. */
function status(output) {
  const stopped = fs.existsSync(path.join(output, 'stopped.json')), result = readJSON(path.join(output, 'result.json'));
  const begun = fs.existsSync(path.join(output, 'launch-intent.json'));
  let open = begun;
  const items = ROWS.map(([id, label, done]) => {
    const finished = done(output), running = open && !finished; if (!finished) open = false;
    return {id: 'boot:' + id, label, status: finished ? 'done' : running ? (stopped ? 'needs-attention' : 'running') : 'waiting',
      ...(running && stopped ? {reason: 'This step did not finish. Your planet was not started a second time.'} : {})};
  });
  const attention = items.find(item => item.status === 'needs-attention');
  return {phase: result?.phase === 'ship-booted-not-installed' ? 'booted' : attention ? 'needs-attention' : begun ? 'running' : 'not-started', items,
    ...(result?.url ? {url: result.url} : {}), ...(attention ? {stoppedAt: attention.label, reason: attention.reason} : {})};
}
/** Launch the prepared boot once, reporting every change. Never starts a second copy. */
async function launch({output, approvedDigest}, report = () => {}) {
  let last = '';
  const emit = () => {const now = status(output), text = JSON.stringify(now); if (text !== last) {last = text; try {report(now);} catch { /* presentation only */ }} return now;};
  const timer = setInterval(emit, 500);
  try {try {await boot.launch(output, approvedDigest);} catch { /* boot-local recorded stopped.json; status explains it */ } return emit();}
  finally {clearInterval(timer);}
}

/** Planets this app set up in `root`: those with a finished first-boot record. */
function ships(root) {
  let names = [];
  try {names = fs.readdirSync(root).filter(name => name.endsWith('-boot'));} catch {return [];}
  return names.map(name => {
    const output = path.join(root, name), result = readJSON(path.join(output, 'result.json')), plan = readJSON(path.join(output, 'plan.json'))?.plan;
    if (result?.phase !== 'ship-booted-not-installed' || !plan || result.ship !== plan.ship || path.join(root, plan.ship.slice(1)) !== plan.pier || !fs.existsSync(plan.pier)) return undefined;
    return {ship: plan.ship, pier: plan.pier, output, httpPort: plan.httpPort, amesPort: plan.amesPort, shipAtom: plan.shipAtom, running: holders(plan.pier).length > 0};
  }).filter(Boolean);
}
function holders(pier) {
  const lock = path.join(pier, '.vere.lock');
  try {return lockHolders(execFileSync('/usr/sbin/lsof', ['-nP', '-Fpn', '--', lock], {encoding: 'utf8', timeout: 5000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'ignore']}), lock);} catch {return [];}
}
const connects = socket => new Promise(resolve => {
  const connection = net.createConnection({path: socket}); const done = value => {connection.destroy(); resolve(value);};
  connection.setTimeout(1000, () => done(false)); connection.once('connect', () => done(true)); connection.once('error', () => done(false));
});
const RESTART_ROWS = [['start', 'Starting your planet'], ['up', 'Waiting for it to come up'], ['base', 'Preparing it'], ['identity', 'Checking it is your planet']];
function restartStatus(directory) {
  const marks = {start: fs.existsSync(path.join(directory, 'started.json')), up: fs.existsSync(path.join(directory, 'base')),
    base: readJSON(path.join(directory, 'base/result.json'))?.baseExportsVerified === true, identity: readJSON(path.join(directory, 'result.json'))?.identityVerified === true};
  const stopped = readJSON(path.join(directory, 'stopped.json')), begun = fs.existsSync(path.join(directory, 'intent.json'));
  let open = begun;
  const items = RESTART_ROWS.map(([id, label]) => {
    const finished = marks[id], running = open && !finished; if (!finished) open = false;
    return {id: 'restart:' + id, label, status: finished ? 'done' : running ? (stopped ? 'needs-attention' : 'running') : 'waiting',
      ...(running && stopped ? {reason: String(stopped.reason ?? 'This step did not finish. Your planet was not started a second time.').slice(0, 200)} : {})};
  });
  const attention = items.find(item => item.status === 'needs-attention'), result = readJSON(path.join(directory, 'result.json'));
  return {phase: result?.identityVerified === true ? 'booted' : attention ? 'needs-attention' : begun ? 'running' : 'not-started', items,
    ...(result?.url ? {url: result.url} : {}), ...(attention ? {stoppedAt: attention.label, reason: attention.reason} : {})};
}
/**
 * Start again a planet this app set up before (after a Mac restart, say). Starts at most one copy:
 * refused while any process holds the pier, and never repeated within one call. The planet keeps its
 * folder, ports, loopback-only web address and memory setting; %base is mounted and the identity is
 * checked against the first-boot record before it is reported as running.
 */
async function restart({ship, root}, report = () => {}, runtime = shippedRuntime()) {
  const known = ships(root).find(entry => entry.ship === ship);
  need(known, 'This planet was not set up by Readymade on this Mac');
  const directory = path.join(known.output, 'restarts', String(Date.now()));
  let last = '';
  const emit = () => {const now = restartStatus(directory), text = JSON.stringify(now); if (text !== last) {last = text; try {report(now);} catch { /* presentation only */ }} return now;};
  if (known.running) return {phase: 'booted', items: RESTART_ROWS.map(([id, label]) => ({id: 'restart:' + id, label, status: 'done'})), url: 'http://127.0.0.1:' + known.httpPort};
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const save = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value), {mode: 0o600, flag: 'wx'});
  const stop = reason => {save('stopped.json', {reason, automaticRetry: false}); return emit();};
  const timer = setInterval(emit, 500);
  try {
    save('intent.json', {ship, at: new Date().toISOString(), automaticRetry: false});
    if (!(await tcpFree(known.httpPort)) || !(await udpFree(known.amesPort))) return stop('Another program is using this planet’s network ports. Close it, then try again.');
    const log = fs.openSync(path.join(directory, 'boot.log'), 'wx', 0o600);
    const child = spawn(runtime.vere, ['--loom', '33', '--http-ip', '127.0.0.1', '--http-port', String(known.httpPort), '--ames-port', String(known.amesPort), '--no-tty', known.pier],
      {stdio: ['ignore', log, log], detached: true, env: {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? ''}});
    fs.closeSync(log);
    let ended = false; child.once('error', () => {ended = true;}); child.once('exit', () => {ended = true;}); child.unref();
    if (child.pid) save('started.json', {pid: child.pid, at: new Date().toISOString()});
    // A socket file can be left over from before; wait for a worker that holds the pier and answers on it.
    const socket = path.join(known.pier, '.urb/conn.sock'), deadline = Date.now() + 600000;
    while (!ended && Date.now() < deadline && !(holders(known.pier).length === 1 && await connects(socket))) await new Promise(resolve => setTimeout(resolve, 500));
    if (ended || !(holders(known.pier).length === 1 && await connects(socket))) return stop('The planet did not come up. It was not started a second time.');
    const adapter = (args, name) => new Promise((resolve, reject) => {
      const started = spawn(process.execPath, [path.join(__dirname, 'run-native.cjs'), '--ship', ship, '--pier', known.pier, '--vere', runtime.vere, ...args, '--output', path.join(directory, name), '--timeout', '120'], {stdio: 'ignore'});
      started.once('error', reject); started.once('exit', code => resolve(code));
    });
    if (await adapter(['--operation', 'mount-base'], 'base') !== 0 || readJSON(path.join(directory, 'base/result.json'))?.baseExportsVerified !== true) return stop('The planet came up but its system files could not be checked.');
    fs.writeFileSync(path.join(directory, 'identity.hoon'), '=/  m  (strand ,vase)\n;<  b=bowl  bind:m  get-bowl\n(pure:m !>(`@ud`our.b))\n', {flag: 'wx', mode: 0o600});
    if (await adapter(['--source', path.join(directory, 'identity.hoon')], 'identity') !== 0) return stop('The planet came up but its identity could not be read.');
    let text = ''; try {text = fs.readFileSync(path.join(directory, 'identity/response.hoon'), 'utf8').replace(/[.\s]/g, '');} catch { /* refused below */ }
    const seen = /^\[0%avow0%noun(\d+)\]$/.exec(text)?.[1];
    if (seen !== String(known.shipAtom)) return stop('The planet that came up is not the one that was set up here.');
    save('result.json', {ship, identityVerified: true, baseExportsVerified: true, url: 'http://127.0.0.1:' + known.httpPort});
    return emit();
  } catch (error) {
    if (!fs.existsSync(path.join(directory, 'stopped.json'))) stop('The start was interrupted. Your planet was not started a second time.');
    throw error;
  } finally {clearInterval(timer);}
}

if (require.main === module) {
  (async () => {
    const [action, ...args] = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {const name = args[i]?.slice(2); need(args[i]?.startsWith('--') && args[i + 1] && !Object.hasOwn(options, name), 'Invalid arguments'); options[name] = args[i + 1];}
    if (action === 'prepare') {
      need(Object.keys(options).sort().join(',') === 'confirm-not-running-elsewhere,keyfile,root,ship', 'Prepare requires --ship, --keyfile, --root and --confirm-not-running-elsewhere yes');
      console.log(JSON.stringify(await prepare({ship: options.ship, keyfile: options.keyfile, root: options.root, singleInstanceConfirmed: options['confirm-not-running-elsewhere'] === 'yes'})));
    } else if (action === 'launch') {
      need(Object.keys(options).sort().join(',') === 'approve,output', 'Launch requires --output and --approve');
      const final = await launch({output: options.output, approvedDigest: options.approve}, now => console.log(JSON.stringify(now)));
      if (final.phase !== 'booted') process.exitCode = 2;
    } else if (action === 'status') {need(options.output, 'Status requires --output'); console.log(JSON.stringify(status(options.output)));}
    else if (action === 'ships') {need(options.root, 'Ships requires --root'); console.log(JSON.stringify(ships(options.root).map(({ship, httpPort, running}) => ({ship, httpPort, running}))));}
    else if (action === 'restart') {
      need(Object.keys(options).sort().join(',') === 'root,ship', 'Restart requires --ship and --root');
      const final = await restart({ship: options.ship, root: options.root}, now => console.log(JSON.stringify(now)));
      console.log(JSON.stringify(final)); if (final.phase !== 'booted') process.exitCode = 2;
    }
    else throw Error('Use prepare, launch, status, ships or restart.');
  })().catch(error => {console.error(error.message); process.exitCode = 1;});
}
module.exports = {prepare, launch, status, ships, restart, restartStatus, shippedRuntime, planetFromKeyfile, firstFree, tcpFree};
