'use strict';
// Finite local source staging. Native strands retain installation authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const journal = require('./install-state.cjs');
const steps = ['receiver', 'create', 'mount', 'stage', 'commit', 'verify'];
const tools = ['install-local.cjs', 'install-state.cjs', 'run-native.cjs', 'prepare-operation.py',
  'verify-operation.py', 'compare-snapshots.py', 'stage-files.py', 'prepare-verification.py', 'receiver-check.hoon', 'stage.hoon'];
const manifestPath = path.join(__dirname, '../assembly-manifest.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function requireThat(ok, message) {if (!ok) throw Error(message);}
function safePath(file) {
  requireThat(typeof file === 'string' && path.isAbsolute(file) && path.normalize(file) === file && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(file), 'Expected a clean absolute path');
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split('/').filter(Boolean)) {
    current = path.join(current, part); requireThat(!fs.lstatSync(current).isSymbolicLink(), 'Linked path refused');
  }
}
function read(file, limit = 256 * 1024 * 1024) {
  safePath(file); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    requireThat(info.isFile() && info.nlink === 1 && info.uid === process.getuid() && info.size <= limit, 'Invalid or oversized local file');
    return fs.readFileSync(fd);
  } finally {fs.closeSync(fd);}
}
function json(file) {return JSON.parse(read(file, 4 * 1024 * 1024));}
function save(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}
function evidence(file) {return {path: file, sha256: sha(read(file))};}
function nativeEvidence(output) {return ['plan.json', 'source.hoon', 'request.newt', 'submitted.json', 'response.newt', 'result.json'].map(name => evidence(path.join(output, name)));}
function toolchainDigest() {return sha(Buffer.concat(tools.map(name => Buffer.concat([Buffer.from(name + '\0'), read(path.join(__dirname, name)), Buffer.from('\0')]))));}
function inventory(directory, prefix = '') {
  safePath(directory); requireThat(fs.lstatSync(directory).isDirectory(), 'Expected a directory');
  return fs.readdirSync(directory).sort().flatMap(name => {
    const full = path.join(directory, name), relative = prefix + name, info = fs.lstatSync(full);
    requireThat(!info.isSymbolicLink(), 'Linked bundle entry refused');
    return info.isDirectory() ? inventory(full, relative + '/') : (read(full), [relative]);
  });
}
function validateBundle(bundle, manifest) {
  requireThat(manifest.schema === 'readymade-backend-assembly-v1', 'Unsupported assembly manifest');
  const expected = new Map();
  for (const [kind, prefix] of [['files', 'desk/'], ['notices', 'notices/']]) {
    requireThat(manifest[kind] && typeof manifest[kind] === 'object' && !Array.isArray(manifest[kind]), 'Missing assembly inventory');
    for (const [name, pin] of Object.entries(manifest[kind])) {
      requireThat(name && !path.isAbsolute(name) && path.posix.normalize(name) === name && !name.split('/').some(v => v === '.' || v === '..') && !/[\\\x00-\x1f\x7f]/.test(name), 'Invalid assembly path');
      requireThat(pin && /^[a-f0-9]{64}$/.test(pin.sha256) && Number.isSafeInteger(pin.bytes) && pin.bytes >= 0, 'Invalid assembly pin');
      const bytes = read(path.join(bundle, prefix + name));
      requireThat(bytes.length === pin.bytes && sha(bytes) === pin.sha256, 'Bundle differs from pinned source');
      expected.set(prefix + name, pin.sha256);
    }
  }
  requireThat(Object.keys(manifest.files).length > 0, 'Empty candidate');
  const actual = inventory(bundle).sort(), names = [...expected.keys(), 'assembly.json'].sort();
  requireThat(JSON.stringify(actual) === JSON.stringify(names), 'Bundle path set differs');
  const receipt = json(path.join(bundle, 'assembly.json'));
  requireThat(receipt.schema === 'readymade-backend-assembly-receipt-v1' && receipt.files &&
    Object.keys(receipt.files).length === expected.size && [...expected].every(([name, digest]) => receipt.files[name] === digest), 'Assembly receipt differs');
  return expected.size;
}
function disjoint(left, right) {return left !== right && !left.startsWith(right + '/') && !right.startsWith(left + '/');}
function programDigest(file) {
  safePath(file); const info = fs.lstatSync(file);
  requireThat(info.isFile() && info.nlink === 1 && [0, process.getuid()].includes(info.uid) && !(info.mode & 0o022) && (info.mode & 0o111) && info.size < 256 * 1024 * 1024, 'Unsafe executable');
  return sha(fs.readFileSync(file));
}
function captureHost(plan, selectedPython) {
  requireThat(process.platform === 'darwin', 'Local installer host binding is currently macOS-only');
  const lock = path.join(plan.pier, '.vere.lock'), raw = read(lock, 64).toString('utf8');
  requireThat(/^[1-9][0-9]{0,9}\n?(?![\s\S])/.test(raw), 'Invalid native worker PID');
  const pid = Number(raw.trim()), query = field => execFileSync('/bin/ps', ['-p', String(pid), '-o', field + '='], {encoding: 'utf8', timeout: 5000, maxBuffer: 65536}).trim();
  const started = query('lstart'), executable = fs.realpathSync(query('comm'));
  requireThat(executable === plan.vere, 'Selected runtime is not the live worker executable');
  const openFiles = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-Fpn', '--', lock], {encoding: 'utf8', timeout: 5000, maxBuffer: 65536}).split('\n');
  requireThat(openFiles.includes('p' + pid) && openFiles.includes('n' + lock), 'Worker does not hold this pier lock');
  const python = selectedPython || fs.realpathSync(execFileSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], {encoding: 'utf8', timeout: 5000, maxBuffer: 65536}).trim());
  const node = fs.realpathSync(process.execPath);
  return {pid, started, executable, executableSHA256: programDigest(executable), node, nodeSHA256: programDigest(node), python, pythonSHA256: programDigest(python)};
}
function pins(plan, host) {
  requireThat(sha(read(plan.vere)) === plan.runtimeSHA256 && toolchainDigest() === plan.toolchainSHA256 && sha(read(manifestPath)) === plan.bundleManifestSHA256, 'Approved runtime or source changed');
  requireThat(sha(Buffer.from(JSON.stringify(host))) === plan.hostBindingSHA256 && sha(Buffer.from(JSON.stringify(captureHost(plan, host.python)))) === plan.hostBindingSHA256, 'Live worker or interpreter binding changed');
  requireThat((fs.statSync(plan.vere).mode & 0o111) !== 0, 'Runtime is not executable');
  validateBundle(plan.bundle, json(manifestPath)); safePath(plan.pier); safePath(path.join(plan.pier, '.urb'));
  requireThat(fs.lstatSync(path.join(plan.pier, '.urb/conn.sock')).isSocket(), 'Native connection socket is not ready');
  requireThat(!fs.existsSync(path.join(plan.pier, '.urb/readymade-operation.lock')), 'A native operation is unresolved; no operation submitted');
}
function createPlan(directory, options) {
  requireThat(Object.keys(options).sort().join(',') === ['bundle', 'desk', 'pier', 'ship', 'vere'].join(','), 'Unexpected installation options');
  requireThat(typeof options.ship === 'string' && /^~[a-z]+(?:-[a-z]+)*(?![\s\S])/.test(options.ship) && typeof options.desk === 'string' && /^[a-z]+(?:-[a-z0-9]+)*(?![\s\S])/.test(options.desk), 'Invalid literal ship or desk');
  for (const field of ['pier', 'vere', 'bundle']) safePath(options[field]);
  requireThat(disjoint(options.pier, options.bundle) && disjoint(directory, options.pier) && disjoint(directory, options.bundle), 'Install paths must be disjoint');
  requireThat(!fs.existsSync(directory) && !fs.existsSync(directory + '-host.json'), 'Installation state already exists');
  const host = captureHost(options);
  const plan = {...options, schema: 'readymade-local-install-v1', runtimeSHA256: sha(read(options.vere)), hostBindingSHA256: sha(Buffer.from(JSON.stringify(host))),
    bundleManifestSHA256: sha(read(manifestPath)), toolchainSHA256: toolchainDigest(), steps};
  // Admission is local and read-only. It never treats a filename as ship identity.
  pins(plan, host); requireThat(!fs.existsSync(directory + '-receipts'), 'Receipt directory already exists');
  const result = journal.createState(directory, plan); save(directory + '-host.json', host); return result;
}
class Refusal extends Error {constructor(proof) {super('Native or eligibility check refused'); this.proof = proof;}}
function command(binary, args, log, timeout = 1200000) {
  const fd = fs.openSync(log, 'wx', 0o600), env = {...process.env, PYTHONNOUSERSITE: '1'};
  delete env.NODE_OPTIONS; delete env.PYTHONPATH; delete env.PYTHONSTARTUP;
  try {
    execFileSync(binary, args, {stdio: ['ignore', fd, fd], timeout, env, killSignal: 'SIGTERM'});
    return 0;
  } catch (error) {return Number.isInteger(error.status) ? error.status : -1;}
  finally {fs.fsyncSync(fd); fs.closeSync(fd);}
}
function handlers(plan, host, hostFile) {
  let observed, committed;
  function python(script, args, log) {
    requireThat(command(host.python, ['-I', path.join(__dirname, script), ...args], log) === 0, 'Preparation or evidence verification failed');
  }
  function native(source, output, operation) {
    pins(plan, host);
    const args = [path.join(__dirname, 'run-native.cjs'), '--ship', plan.ship, '--pier', plan.pier, '--vere', plan.vere,
      '--output', output, '--timeout', '600', ...(operation ? ['--operation', operation] : ['--source', source])];
    const code = command(host.node, args, output + '.log'), file = path.join(output, 'result.json');
    requireThat(fs.existsSync(file), 'Native outcome requires observation');
    const value = json(file), binding = json(path.join(output, 'plan.json'));
    requireThat(binding.ship === plan.ship && binding.pier === plan.pier && binding.vere === plan.vere && binding.vereSHA256 === plan.runtimeSHA256 &&
      binding.operation === (operation || 'strand') && (!source || binding.sourceSHA256 === sha(read(source))), 'Native receipt input differs');
    requireThat(value.responseSHA256 === sha(read(path.join(output, 'response.newt'))), 'Native response binding differs');
    const proof = nativeEvidence(output);
    if (value.executionSuccess === false && value.lockRetained === false) throw new Refusal(proof);
    requireThat(code === 0 && value.status === 'native-success' && value.executionSuccess === true && value.lockRetained === false, 'Native outcome requires observation');
    if (operation === 'mount-base') requireThat(value.baseExportsVerified === true, 'Required base exports missing');
    return [...proof, ...(operation === 'mount-base' ? [evidence(path.join(output, 'base-exports.json'))] : [])];
  }
  function prepared(operation, root, revision) {
    const packet = path.join(root, 'packet'), result = path.join(root, 'native');
    python('prepare-operation.py', ['--ship', plan.ship, '--desk', plan.desk, '--operation', operation, '--output', packet,
      ...(revision ? ['--revision', String(revision)] : [])], path.join(root, 'prepare.log'));
    const proof = native(path.join(packet, 'operation.hoon'), result);
    if (!['receiver', 'observe'].includes(operation)) return {proof};
    const file = path.join(root, 'verified.json');
    python('verify-operation.py', ['--packet', packet, '--receipt', result, '--output', file], path.join(root, 'verify.log'));
    const value = json(file);
    requireThat(value.schema === 'readymade-verified-observation-v1' && value.ship === plan.ship && value.desk === plan.desk &&
      value.operation === operation && value.executionSuccess === true && value.responseSHA256 === json(path.join(result, 'result.json')).responseSHA256, 'Observation binding differs');
    return {proof: [...proof, evidence(path.join(packet, 'packet.json')), evidence(path.join(packet, 'operation.hoon')), evidence(file)], observation: value.observation};
  }
  async function settle(root, expectedRevision) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const folder = path.join(root, 'observe-' + attempt); fs.mkdirSync(folder, {mode: 0o700});
      const value = prepared('observe', folder), row = value.observation;
      if (row.present && row.state === 'dead' && row.pendingClayWork === false) {
        requireThat(Number.isSafeInteger(row.revision) && row.revision > 0 && /^[a-f0-9]{64}$/.test(row.root), 'Invalid immutable desk observation');
        if (expectedRevision !== undefined) requireThat(row.revision === expectedRevision, 'Desk revision changed unexpectedly');
        return {row, proof: value.proof};
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw Error('Native desk operation has not settled; observe without resubmission');
  }
  return {
    receiver: async root => {
      const base = [evidence(hostFile), ...native(undefined, path.join(root, 'base'), 'mount-base')];
      const value = prepared('receiver', root);
      if (value.observation?.eligible !== true) throw new Refusal([...base, ...value.proof]);
      return [...base, ...value.proof];
    },
    create: async root => {const value = prepared('create', root); observed = await settle(root); return [...value.proof, ...observed.proof];},
    mount: async root => {const value = prepared('mount', root, observed.row.revision); const next = await settle(root, observed.row.revision); return [...value.proof, ...next.proof];},
    stage: async root => {
      const mount = path.join(plan.pier, plan.desk), output = path.join(root, 'filesystem');
      python('stage-files.py', ['--source', path.join(plan.bundle, 'desk'), '--mount', mount, '--receipt', output], path.join(root, 'stage.log'));
      const file = path.join(output, 'complete.json'), value = json(file);
      requireThat(value.mount === mount && value.nativeCommitSubmitted === false && value.verifiedFiles === Object.keys(json(manifestPath).files).length, 'Staging readback differs');
      return [evidence(file), evidence(path.join(output, 'plan.json'))];
    },
    commit: async root => {const value = prepared('commit', root, observed.row.revision); committed = await settle(root, observed.row.revision + 1); return [...value.proof, ...committed.proof];},
    verify: async root => {
      const source = path.join(root, 'complete-source.hoon');
      python('prepare-verification.py', ['--source', path.join(plan.bundle, 'desk'), '--ship', plan.ship, '--desk', plan.desk,
        '--revision', String(committed.row.revision), '--output', source], path.join(root, 'prepare.log'));
      return [...native(source, path.join(root, 'native')), evidence(source)];
    },
  };
}
async function sequence(directory, approvedDigest, actions, beforeStep = () => {}) {
  const state = journal.inspectState(directory);
  requireThat(typeof approvedDigest === 'string' && approvedDigest === state.digest, 'Explicit approval must match this exact plan');
  const receipts = directory + '-receipts';
  return journal.withRunLock(directory, async () => {
    const current = journal.inspectState(directory);
    requireThat(current.digest === approvedDigest && !current.blocked, 'Changed or unresolved installation; no replay');
    if (!state.nextStep) return {phase: 'source-staged-not-activated', ready: false, digest: state.digest};
    fs.mkdirSync(receipts, {mode: 0o700});
    for (const step of steps) {
      requireThat(journal.inspectState(directory).digest === approvedDigest, 'Approved plan changed');
      beforeStep(state.plan);
      const root = path.join(receipts, step); fs.mkdirSync(root, {mode: 0o700});
      journal.startStep(directory, step, {receiptDirectory: root});
      try {journal.finishStep(directory, step, {status: 'success', evidence: await actions[step](root)});}
      catch (error) {
        const file = path.join(root, 'stopped.json');
        save(file, {step, status: error instanceof Refusal ? 'refused' : 'unknown', automaticRetry: false});
        const proof = [evidence(file), ...(error instanceof Refusal ? error.proof : [])];
        journal.finishStep(directory, step, {status: error instanceof Refusal ? 'refused' : 'unknown', evidence: proof});
        return {phase: error instanceof Refusal ? 'refused' : 'unknown', ready: false, step, digest: state.digest};
      }
    }
    return {phase: 'source-staged-not-activated', ready: false, digest: state.digest};
  });
}
async function execute(directory, approvedDigest) {
  const state = journal.inspectState(directory);
  requireThat(typeof approvedDigest === 'string' && approvedDigest === state.digest, 'Explicit approval must match this exact plan');
  requireThat(!state.blocked && !fs.existsSync(path.join(directory, 'run.lock')), 'Installation is held; inspect without replay');
  if (!state.nextStep) return {phase: 'source-staged-not-activated', ready: false, digest: state.digest};
  requireThat(state.steps.length === 0 && !fs.existsSync(directory + '-receipts'), 'Installation already progressed; inspect without replay');
  const host = json(directory + '-host.json'); pins(state.plan, host);
  const lock = path.join(state.plan.pier, '.urb/readymade-install.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {fs.writeFileSync(fd, state.digest); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  let result;
  try {result = await sequence(directory, approvedDigest, handlers(state.plan, host, directory + '-host.json'), plan => pins(plan, host));}
  catch (error) {
    if (journal.inspectState(directory).steps.length === 0 && fs.readFileSync(lock, 'utf8') === state.digest) fs.unlinkSync(lock);
    throw error;
  }
  if (result.phase !== 'unknown') {
    requireThat(fs.readFileSync(lock, 'utf8') === state.digest, 'Installation lock changed'); fs.unlinkSync(lock);
  }
  return result;
}
if (require.main === module) {
  (async () => {
    const [action, ...args] = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i]?.slice(2); requireThat(args[i]?.startsWith('--') && args[i + 1] && !Object.hasOwn(options, name), 'Invalid arguments'); options[name] = args[i + 1];
    }
    if (action === 'plan') {
      requireThat(Object.keys(options).sort().join(',') === 'bundle,desk,pier,ship,state,vere', 'Plan requires explicit state, ship, desk, pier, vere and bundle');
      const {state, ...target} = options; console.log(JSON.stringify(createPlan(state, target)));
    } else if (action === 'inspect') {
      requireThat(Object.keys(options).join(',') === 'state', 'Inspect accepts only state'); console.log(JSON.stringify(journal.inspectState(options.state)));
    } else if (action === 'execute') {
      requireThat(Object.keys(options).sort().join(',') === 'approve,state', 'Execute requires state and exact approved plan digest');
      const result = await execute(options.state, options.approve); console.log(JSON.stringify(result));
      if (result.phase !== 'source-staged-not-activated') process.exitCode = 2;
    } else throw Error('Use plan, inspect or execute. Source staging is not compilation, activation, payment or first-use readiness.');
  })().catch(() => {console.error('Local installation stopped. Inspect private retained receipts; do not resubmit an uncertain operation.'); process.exitCode = 1;});
}
module.exports = {createPlan, execute, sequence, validateBundle, toolchainDigest, captureHost, nativeEvidence};
