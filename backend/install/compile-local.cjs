'use strict';
// Finite compilation adapter. It never activates, retries or resumes a run.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {isDeepStrictEqual: equal} = require('node:util');
const journal = require('./install-state.cjs');
const local = require('./install-local.cjs');
const {reconstruct} = require('./verify-compilation.cjs');
const {cue, tuple, cord} = require('./inspect-spider.cjs');
const activation = require('./prepare-activation.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const need = (ok, message) => {if (!ok) throw Error(message);};
const STEPS = ['receiver', 'create', 'mount', 'stage', 'commit', 'verify'];
function admit(staged, approvedDigest) {
  need(typeof approvedDigest === 'string' && staged.digest === approvedDigest, 'Exact staged plan approval required');
  need(!staged.blocked && !staged.inFlight && !staged.nextStep && equal(staged.steps.map(row => row.step), STEPS) && staged.steps.every(row => row.outcome?.status === 'success'), 'Staging must be complete and resolved');
}
function orderedChecks(packet) {
  const names = ['00-source.hoon', ...['graf', 'cantrip', 'viki', 'cli-inference', 'multiplayer-runtime', 'readymade-collab', 'native-coding-source-import', 'pataphor-native-console', 'pataphor-page', 'readymade-editing'].map((name, i) => `${String(i + 1).padStart(2, '0')}-app-${name}.hoon`), '10-marks.hoon', '11-runtime.hoon'];
  need(packet?.files && equal(Object.keys(packet.files).sort(), [...names].sort()), 'Exact thirteen checks required'); return names;
}
function exchangeBudget(deadline, now) {
  need(Number.isSafeInteger(deadline) && Number.isSafeInteger(now), 'Invalid deadline');
  const seconds = Math.min(1200, Math.floor((deadline - now) / 1000) - 180);
  need(seconds >= 1, 'Aggregate budget exhausted; no further submission'); return seconds;
}
function safe(file) {
  need(typeof file === 'string' && path.isAbsolute(file) && path.normalize(file) === file && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(file), 'Unsafe path');
  for (let p = file;; p = path.dirname(p)) {need(!fs.lstatSync(p).isSymbolicLink(), 'Linked path refused'); if (p === path.dirname(p)) break;}
}
function privateDir(dir) {safe(dir); const s = fs.statSync(dir); need(s.isDirectory() && s.uid === process.getuid() && (s.mode & 0o777) === 0o700, 'Private directory required');}
function read(file, privateMode = false) {
  safe(file); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd); need(s.isFile() && s.nlink === 1 && [0, process.getuid()].includes(s.uid) && !(s.mode & 0o022) && s.size <= 256 * 1024 * 1024, 'Unsafe file');
    if (privateMode) need(s.uid === process.getuid() && (s.mode & 0o777) === 0o600, 'Private receipt required');
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    need(bytes.length === s.size && after.mtimeMs === s.mtimeMs && after.ctimeMs === s.ctimeMs, 'File changed'); return bytes;
  } finally {fs.closeSync(fd);}
}
const json = file => JSON.parse(read(file, true));
function sync(dir) {const fd = fs.openSync(dir, 'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}}
function write(file, bytes) {const fd = fs.openSync(file, 'wx', 0o600); try {fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);} sync(path.dirname(file));}
const save = (file, value) => write(file, JSON.stringify(value) + '\n');
function envelope(directory, plan, original) {
  privateDir(directory);
  const run = json(path.join(directory, 'plan.json')), result = json(path.join(directory, 'result.json'));
  need(run.ship === plan.ship && run.pier === plan.pier && run.vere === plan.vere && run.vereSHA256 === plan.runtimeSHA256 && run.operation === 'strand' && run.sourceSHA256 === sha(original), 'Runner binding differs');
  const guarded = `=/  readymade-transport  (strand ,vase)\n;<  readymade-bowl=bowl  bind:readymade-transport  get-bowl\n?>  &(=(${plan.ship} our.readymade-bowl) =(our.readymade-bowl src.readymade-bowl))\n${original}`;
  need(read(path.join(directory, 'source.hoon'), true).equals(Buffer.from(guarded)), 'Guarded source differs');
  const request = read(path.join(directory, 'request.newt'), true);
  need(equal(tuple(cue(request), 7), [0n, cord('fyrd'), cord('base'), cord('khan-eval'), cord('noun'), cord('ted-eval'), cord(guarded)]) && json(path.join(directory, 'submitted.json')).requestSHA256 === sha(request), 'Submitted request differs');
  const raw = read(path.join(directory, 'response.newt'), true);
  need(result.status === 'native-success' && result.executionSuccess === true && result.lockRetained === false && result.responseSHA256 === sha(raw), 'Native result unresolved or refused');
  const [id, tag, status, mark, payload] = tuple(cue(raw), 5);
  need(id === 0n && tag === cord('avow') && status === 0n && mark === cord('noun'), 'Native execution failed'); return payload;
}
function committed(staged) {
  const plan = staged.plan, evidence = staged.steps.find(row => row.step === 'commit').outcome.evidence;
  const files = new Set(evidence.map(row => row.path));
  const candidates = evidence.filter(row => path.basename(row.path) === 'verified.json').map(row => ({file: row.path, value: json(row.path)})).filter(row => row.value.operation === 'observe');
  need(candidates.length === 1, 'Final commit observation is ambiguous');
  const {file, value} = candidates[0], directory = path.dirname(file), packet = json(path.join(directory, 'packet/packet.json'));
  const original = `=/  arg=vase  !>([${plan.ship} %${plan.desk} %observe 0])\n` + read(path.join(__dirname, 'stage.hoon'));
  const receipt = path.join(directory, 'native');
  for (const name of ['plan.json', 'source.hoon', 'request.newt', 'submitted.json', 'response.newt', 'result.json']) need(files.has(path.join(receipt, name)), 'Commit raw evidence missing');
  need(files.has(path.join(directory, 'packet/packet.json')) && files.has(path.join(directory, 'packet/operation.hoon')) && read(path.join(directory, 'packet/operation.hoon'), true).equals(Buffer.from(original)) && packet.sourceSHA256 === sha(original), 'Commit source differs');
  const [tag, owner, desk, unit] = tuple(envelope(receipt, plan, original), 4), [some, revision, life, idle, rootUnit] = tuple(unit, 5), [hasRoot, root] = tuple(rootUnit, 2);
  need(tag === cord('readymade-stage-observed-v1') && typeof owner === 'bigint' && desk === cord(plan.desk) && some === 0n && revision >= 2n && revision <= 2n ** 31n && life === cord('dead') && idle === 0n && hasRoot === 0n && typeof root === 'bigint' && root > 0n && root < 2n ** 256n, 'Commit is not an immutable inactive revision');
  need(value.schema === 'readymade-verified-observation-v1' && value.ship === plan.ship && value.desk === plan.desk && value.executionSuccess === true && value.observation.revision === Number(revision) && value.observation.root === root.toString(16).padStart(64, '0') && value.responseSHA256 === json(path.join(receipt, 'result.json')).responseSHA256, 'Commit summary differs');
  return {revision: Number(revision), root: root.toString(16).padStart(64, '0')};
}
async function compile(options) {
  need(equal(Object.keys(options).sort(), ['state', 'output', 'approvedDigest'].sort()), 'Unexpected compilation options');
  const {state, output, approvedDigest} = options; privateDir(state);
  const staged = journal.inspectState(state); admit(staged, approvedDigest);
  need(!fs.existsSync(path.join(state, 'run.lock')), 'Staging run is held');
  need(typeof output === 'string' && path.isAbsolute(output) && path.normalize(output) === output && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(output), 'Invalid new output');
  privateDir(path.dirname(output)); need(!fs.existsSync(output), 'Compilation already exists; no replay');
  const plan = staged.plan, host = json(state + '-host.json'), bound = committed(staged);
  for (const protectedPath of [state, plan.pier, plan.bundle]) need(output !== protectedPath && !output.startsWith(protectedPath + '/') && !protectedPath.startsWith(output + '/'), 'Compilation output must be isolated');
  const helpers = ['compile-local.cjs', 'verify-compilation.cjs', 'prepare-activation.cjs', 'prepare-activation.py', 'compile-app.hoon', 'snapshot.hoon', 'activate.hoon', 'post-install.hoon', 'inspect-spider.cjs'];
  const helperPins = Object.fromEntries(helpers.map(name => [name, sha(read(path.join(__dirname, name)))]));
  function current() {
    need(equal(journal.inspectState(state), staged) && !fs.existsSync(path.join(state, 'run.lock')), 'Staging changed or held');
    need(sha(JSON.stringify(host)) === plan.hostBindingSHA256 && host.executable === plan.vere && host.executableSHA256 === plan.runtimeSHA256 && equal(local.captureHost(plan, host.python), host), 'Live host binding changed');
    need(local.toolchainDigest() === plan.toolchainSHA256, 'Staging toolchain changed');
    const manifest = read(path.join(__dirname, '../assembly-manifest.json'));
    need(sha(manifest) === plan.bundleManifestSHA256, 'Manifest changed'); local.validateBundle(plan.bundle, JSON.parse(manifest));
    for (const [name, digest] of Object.entries(helperPins)) need(sha(read(path.join(__dirname, name))) === digest, 'Compilation helper changed');
    need(!fs.existsSync(path.join(plan.pier, '.urb/readymade-operation.lock')), 'Native operation unresolved');
  }
  current(); const generated = reconstruct(path.join(plan.bundle, 'desk'), plan.ship, plan.desk, bound.revision), checks = orderedChecks(generated.packet);
  const lock = path.join(plan.pier, '.urb/readymade-install.lock'), token = crypto.randomBytes(32).toString('hex');
  safe(path.dirname(lock)); write(lock, token);
  try {
    fs.mkdirSync(output, {mode: 0o700}); sync(path.dirname(output));
    const deadline = Date.now() + 3600000;
    save(path.join(output, 'intent.json'), {schema: 'readymade-local-compilation-intent-v1', planDigest: staged.digest, hostBindingSHA256: plan.hostBindingSHA256, helperPins, ...bound, deadline, automaticRetry: false, activationAuthorized: false});
    const compilation = path.join(output, 'compilation'); fs.mkdirSync(compilation, {mode: 0o700});
    for (const [name, source] of Object.entries(generated.files)) write(path.join(compilation, name), source);
    save(path.join(compilation, 'packet.json'), generated.packet);
    const receipts = {};
    async function native(source, destination, expectedSource) {
      current(); need(read(lock, true).toString() === token, 'Installation lock changed');
      const timeout = exchangeBudget(deadline, Date.now()), original = read(source, true).toString();
      need(original === expectedSource, 'Prepared source changed before dispatch');
      const log = fs.openSync(destination + '.log', 'wx', 0o600);
      const env = {...process.env}; for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']) delete env[name];
      let child;
      try {child = spawn(host.node, [path.join(__dirname, 'run-native.cjs'), '--ship', plan.ship, '--pier', plan.pier, '--vere', plan.vere, '--source', source, '--output', destination, '--timeout', String(timeout)], {stdio: ['ignore', log, log], env});}
      finally {fs.closeSync(log);}
      const code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', (code, signal) => signal ? reject(Error('Adapter interrupted')) : resolve(code));});
      need(code === 0, 'Compilation requires retained outcome inspection'); envelope(destination, plan, original);
    }
    for (const name of checks) {const destination = path.join(output, name.slice(0, -5)); await native(path.join(compilation, name), destination, generated.files[name]); receipts[name] = destination;}
    const snapshot = path.join(output, 'snapshot.hoon'), revision = String(bound.revision).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const snapshotSource = `=/  arg=vase  !>([${plan.ship} %${plan.desk} ${revision}])\n` + read(path.join(__dirname, 'snapshot.hoon'));
    write(snapshot, snapshotSource);
    const baseline = path.join(output, 'baseline'); await native(snapshot, baseline, snapshotSource); current();
    const prepared = activation.prepare({state, compilation, receipts, baseline, output: path.join(output, 'activation')});
    current(); need(read(lock, true).toString() === token, 'Installation lock changed');
    const result = {schema: 'readymade-local-compilation-result-v1', phase: 'activation-prepared', ready: false, planDigest: staged.digest, activationAuthorized: false, packet: prepared.packet, compilationDigest: prepared.compilationDigest};
    save(path.join(output, 'result.json'), result); fs.unlinkSync(lock); sync(path.dirname(lock)); return result;
  } catch {
    if (fs.existsSync(output) && !fs.existsSync(path.join(output, 'stopped.json'))) save(path.join(output, 'stopped.json'), {phase: 'compilation-needs-inspection', ready: false, lockRetained: true, automaticRetry: false});
    throw Error('Compilation stopped; inspect retained receipts and locks without replay.');
  }
}
module.exports = {compile, admit, orderedChecks, exchangeBudget};
