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
const boot = require('./boot-local.cjs');

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
    else throw Error('Use prepare, launch or status.');
  })().catch(error => {console.error(error.message); process.exitCode = 1;});
}
module.exports = {prepare, launch, status, shippedRuntime, planetFromKeyfile, firstFree, tcpFree};
