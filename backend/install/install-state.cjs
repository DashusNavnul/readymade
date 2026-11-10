'use strict';
// A finite adapter's append-only evidence, never native installation authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const STEPS = ['receiver', 'create', 'mount', 'stage', 'commit', 'verify'];
const LIMIT = 65536;
const held = new Map();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
function requireThat(ok, message) { if (!ok) throw Error(message); }
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  requireThat(value && Object.getPrototypeOf(value) === Object.prototype, 'Expected JSON object');
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function keys(value, names) { requireThat(value && canonical(Object.keys(value).sort()) === canonical(names.sort()), 'Unexpected record fields'); }
function absolute(value) { requireThat(typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value), 'Expected absolute clean path'); }
function noLinks(file) {
  absolute(file);
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split('/').filter(Boolean)) {
    current = path.join(current, part);
    requireThat(!fs.lstatSync(current).isSymbolicLink(), 'Symlink refused');
  }
}
function owned(file, directory = false, privateMode = true) {
  noLinks(file);
  const stat = fs.lstatSync(file);
  requireThat((directory ? stat.isDirectory() : stat.isFile()) && stat.uid === process.getuid() && (directory || stat.nlink === 1), 'Foreign or nonregular path');
  if (privateMode) requireThat((stat.mode & 0o777) === (directory ? 0o700 : 0o600), 'Private permissions required');
  return stat;
}
function syncDirectory(directory) { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function write(directory, name, value) {
  owned(directory, true);
  const bytes = canonical(value) + '\n';
  requireThat(Buffer.byteLength(bytes) <= LIMIT, 'Record too large');
  const fd = fs.openSync(path.join(directory, name), 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(directory);
}
function read(directory, name) {
  const file = path.join(directory, name);
  requireThat(owned(file).size <= LIMIT, 'Record too large');
  const bytes = fs.readFileSync(file, 'utf8');
  const value = JSON.parse(bytes);
  requireThat(bytes === canonical(value) + '\n', 'Noncanonical or partial record');
  return value;
}
function planValue(plan) {
  keys(plan, ['schema', 'ship', 'desk', 'pier', 'vere', 'runtimeSHA256', 'bundle', 'bundleManifestSHA256', 'toolchainSHA256', 'hostBindingSHA256', 'steps']);
  requireThat(plan.schema === 'readymade-local-install-v1' && typeof plan.ship === 'string' && plan.ship.length <= 128 && /^~[a-z]+(?:-[a-z]+)*(?![\s\S])/.test(plan.ship) && typeof plan.desk === 'string' && /^[a-z][a-z0-9-]{0,63}(?![\s\S])/.test(plan.desk), 'Invalid installation identity');
  requireThat(!['base', 'noltbook-data', 'host-law', 'host-viki', 'hot-viki', 'glass-desktop-build'].includes(plan.desk), 'Protected desk');
  for (const field of ['pier', 'vere', 'bundle']) absolute(plan[field]);
  requireThat(hash(plan.runtimeSHA256) && hash(plan.bundleManifestSHA256) && hash(plan.toolchainSHA256) && hash(plan.hostBindingSHA256) && canonical(plan.steps) === canonical(STEPS), 'Invalid installation pins or steps');
  return JSON.parse(canonical(plan));
}
function createState(directory, plan) {
  absolute(directory); noLinks(path.dirname(directory));
  plan = planValue(plan);
  fs.mkdirSync(directory, {mode: 0o700});
  const digest = sha(canonical(plan));
  write(directory, 'plan.json', {plan, digest});
  syncDirectory(path.dirname(directory));
  return {plan, digest};
}
function evidenceValue(evidence) {
  requireThat(Array.isArray(evidence) && evidence.length > 0 && evidence.length <= 32, 'Evidence required');
  const seen = new Set();
  for (const row of evidence) {
    keys(row, ['path', 'sha256']); absolute(row.path);
    requireThat(hash(row.sha256) && !seen.has(row.path), 'Invalid evidence binding');
    seen.add(row.path); owned(row.path, false, false);
    requireThat(sha(fs.readFileSync(row.path)) === row.sha256, 'Evidence changed');
  }
  return evidence;
}
function inspectState(directory) {
  owned(directory, true);
  const saved = read(directory, 'plan.json'); keys(saved, ['plan', 'digest']);
  const plan = planValue(saved.plan), digest = sha(canonical(plan));
  requireThat(saved.digest === digest, 'Plan digest mismatch');
  const allowed = new Set(['plan.json', 'run.lock']);
  const steps = []; let nextStep, blocked = false, inFlight;
  for (const step of STEPS) {
    const name = step + '.intent.json', outcomeName = step + '.outcome.json';
    allowed.add(name); allowed.add(outcomeName);
    const exists = fs.existsSync(path.join(directory, name));
    const hasOutcome = fs.existsSync(path.join(directory, outcomeName));
    if (!exists) { requireThat(!hasOutcome, 'Orphan outcome'); nextStep ??= step; continue; }
    requireThat(!nextStep && !blocked, 'Out-of-order step');
    const intent = read(directory, name); keys(intent, ['schema', 'digest', 'step', 'input']);
    requireThat(intent.schema === 'readymade-install-intent-v1' && intent.digest === digest && intent.step === step, 'Intent binding mismatch');
    requireThat(intent.input && !Array.isArray(intent.input) && typeof intent.input === 'object', 'Invalid step input');
    let outcome;
    if (hasOutcome) {
      outcome = read(directory, outcomeName); keys(outcome, ['schema', 'digest', 'step', 'intentDigest', 'status', 'evidence']);
      requireThat(outcome.schema === 'readymade-install-outcome-v1' && outcome.digest === digest && outcome.step === step && outcome.intentDigest === sha(canonical(intent)), 'Outcome binding mismatch');
      requireThat(['success', 'refused', 'unknown'].includes(outcome.status), 'Invalid outcome');
      evidenceValue(outcome.evidence); blocked = outcome.status !== 'success';
    } else { blocked = true; inFlight = step; }
    steps.push({step, intent, outcome});
  }
  for (const name of fs.readdirSync(directory)) {
    requireThat(allowed.has(name), 'Unexpected journal file');
    owned(path.join(directory, name));
  }
  if (fs.existsSync(path.join(directory, 'run.lock'))) {
    const lock = read(directory, 'run.lock'); keys(lock, ['digest', 'token']);
    requireThat(lock.digest === digest && hash(lock.token), 'Run lock binding mismatch');
  }
  return {plan, digest, steps, nextStep: blocked ? undefined : nextStep, blocked, inFlight};
}
function requireLock(directory) {
  const token = held.get(directory); requireThat(token, 'Run lock required');
  requireThat(canonical(read(directory, 'run.lock')) === canonical(token), 'Run lock changed');
}
function startStep(directory, step, input) {
  requireLock(directory);
  const state = inspectState(directory);
  requireThat(!state.blocked && state.nextStep === step, 'Step unavailable; no replay');
  requireThat(input && typeof input === 'object' && !Array.isArray(input), 'Step input required');
  const intent = {schema: 'readymade-install-intent-v1', digest: state.digest, step, input};
  write(directory, step + '.intent.json', intent);
  return JSON.parse(canonical(intent));
}
function finishStep(directory, step, result) {
  requireLock(directory); keys(result, ['status', 'evidence']);
  const state = inspectState(directory);
  requireThat(state.inFlight === step && ['success', 'refused', 'unknown'].includes(result.status), 'No matching unfinished step');
  evidenceValue(result.evidence);
  const intent = state.steps.at(-1).intent;
  const outcome = {schema: 'readymade-install-outcome-v1', digest: state.digest, step, intentDigest: sha(canonical(intent)), ...result};
  write(directory, step + '.outcome.json', outcome);
  return outcome;
}
async function withRunLock(directory, callback) {
  const state = inspectState(directory);
  requireThat(!state.blocked, 'Unresolved or refused installation; observe only');
  const token = {digest: state.digest, token: crypto.randomBytes(32).toString('hex')};
  write(directory, 'run.lock', token); held.set(directory, token);
  try {
    const result = await callback();
    requireLock(directory);
    const after = inspectState(directory);
    if (!after.inFlight && !after.steps.some(row => row.outcome?.status === 'unknown')) {
      fs.unlinkSync(path.join(directory, 'run.lock')); syncDirectory(directory);
    }
    return result;
  } finally { held.delete(directory); }
}
module.exports = {createState, inspectState, startStep, finishStep, withRunLock};
