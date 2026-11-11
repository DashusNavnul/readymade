#!/usr/bin/env node
'use strict';

// One consented installation run reported as plain progress events, for a button to drive.
// This adds no authority and no native request of its own: every write is still made by
// install-local.cjs and compile-local.cjs under the exact approved plan digest. It never
// retries, resumes a partial run, or activates anything.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const journal = require('./install-state.cjs');
const {compile} = require('./compile-local.cjs');

const STAGE_LABELS = {
  receiver: 'Checking your ship', create: 'Making a place for Pataphor', mount: 'Opening it',
  stage: 'Copying the files', commit: 'Saving them to your ship', verify: 'Checking every file arrived',
};
const STEPS = Object.keys(STAGE_LABELS); // the six staging steps, in order
const need = (ok, message) => {if (!ok) throw Error(message);};
const readJSON = file => {try {return JSON.parse(fs.readFileSync(file, 'utf8'));} catch {return undefined;}};

/**
 * Six staging rows from an inspected journal. Pure. The journal calls any step with an intent and no
 * outcome "blocked": it cannot tell a step that is running from one that was cut off. `active` (the
 * run lock is held) is what tells them apart; without it an open step needs attention.
 */
function stageProgress(inspected, active = false) {
  const rows = inspected?.steps ?? [];
  const done = new Set(rows.filter(row => row.outcome?.status === 'success').map(row => row.step));
  const failed = new Set(rows.filter(row => row.outcome && row.outcome.status !== 'success').map(row => row.step));
  // A step with a recorded intent and no outcome is in flight, or was cut off; a blocked journal says which.
  const open = rows.find(row => row.intent && !row.outcome)?.step ?? inspected?.inFlight?.step;
  return STEPS.map(step => ({
    id: 'stage:' + step, label: STAGE_LABELS[step],
    status: failed.has(step) || (open === step && !active) ? 'needs-attention' : done.has(step) ? 'done' : open === step ? 'running' : 'waiting',
  }));
}
function checkLabel(name) {
  const app = /^\d\d-app-(.+)$/.exec(name);
  if (app) return 'Building ' + app[1];
  if (/^\d\d-source$/.test(name)) return 'Re-checking the saved files';
  if (/^\d\d-marks$/.test(name)) return 'Checking data formats';
  if (/^\d\d-runtime$/.test(name)) return 'Checking background tasks';
  return name;
}
/** Compile rows read from a compile-local output directory. Reads only; safe while a run is active. */
function compileProgress(output) {
  let planned = [];
  try {planned = fs.readdirSync(path.join(output, 'compilation')).filter(name => /^\d\d-[a-z0-9-]+\.hoon$/.test(name)).map(name => name.slice(0, -5)).sort();} catch { /* not started */ }
  const row = (id, label, directory) => {
    const result = readJSON(path.join(directory, 'result.json'));
    const status = result ? (result.status === 'native-success' && result.executionSuccess === true ? 'done' : 'needs-attention') : fs.existsSync(directory) ? 'running' : 'waiting';
    return {id, label, status, ...(status === 'needs-attention' ? {reason: String(result.reason ?? result.status ?? 'unknown').slice(0, 200)} : {})};
  };
  const rows = planned.map(name => row('compile:' + name, checkLabel(name), path.join(output, name)));
  rows.push(row('compile:baseline', 'Recording what is already on your ship', path.join(output, 'baseline')));
  const finished = readJSON(path.join(output, 'result.json')), stopped = fs.existsSync(path.join(output, 'stopped.json'));
  rows.push({id: 'compile:activation', label: 'Getting ready to switch it on',
    status: finished?.phase === 'activation-prepared' ? 'done' : stopped ? 'needs-attention' : fs.existsSync(path.join(output, 'activation')) ? 'running' : 'waiting'});
  // A stop leaves the check that was in flight without a result: name it instead of leaving it "running".
  if (stopped) for (const item of rows) if (item.status === 'running') {item.status = 'needs-attention'; item.reason = 'stopped before a result was recorded';}
  return rows;
}
// Read-only: the same bounded-evaluation probe activate.hoon asserts, asked before any work is done,
// so a ship on a runtime that cannot run the backend hears it in seconds instead of after compilation.
const RUNTIME_PROBE = `=/  m  (strand ,vase)
=/  probe=tone  (mink [0 [11 [%jinx [1 [%soft 1]]] [4 [1 0]]]] ~)
=/  bounded=?
  ?.  ?=(%2 -.probe)  %.n
  ?~  trace.probe  %.n
  =([%mean 'evaluation-budget-exceeded'] i.trace.probe)
(pure:m !>(?:(bounded %readymade-runtime-bounded %readymade-runtime-unbounded)))
`;
const preflightDirectory = state => state + '-preflight';
/** Two rows for the checks made before staging. Reads only. */
function preflightProgress(state) {
  const directory = preflightDirectory(state);
  if (!fs.existsSync(directory)) return [];
  const row = (id, label, name, verdict) => {
    const result = readJSON(path.join(directory, name, 'result.json'));
    const ok = result?.status === 'native-success' && result.executionSuccess === true;
    const refused = ok && verdict && !verdict();
    return {id: 'preflight:' + id, label, status: ok && !refused ? 'done' : result || refused ? 'needs-attention' : fs.existsSync(path.join(directory, name)) ? 'running' : 'waiting',
      ...(refused ? {reason: 'This ship runs a version of Urbit that cannot run Pataphor yet. It needs the Readymade runtime.'} :
        result && !ok ? {reason: String(result.reason ?? result.status ?? 'unknown').slice(0, 200)} : {})};
  };
  const bounded = () => {try {return /%readymade-runtime-bounded\]\s*$/.test(fs.readFileSync(path.join(directory, 'runtime/response.hoon'), 'utf8').trim());} catch {return false;}};
  const rows = [row('mount', 'Preparing your ship', 'mount'), row('runtime', 'Checking your ship can run Pataphor', 'runtime', bounded)];
  if (fs.existsSync(path.join(directory, 'stopped.json'))) for (const item of rows) if (item.status === 'running') {item.status = 'needs-attention'; item.reason = 'stopped before a result was recorded';}
  return rows;
}
const ACTIVATION = [
  ['preflight', '00-preflight.hoon', 'Final check before switching on'],
  ['submit', '01-activate.hoon', 'Switching Pataphor on'],
  ['post', '02-post-install.hoon', 'Checking the new apps started'],
  ['snapshot', '03-snapshot.hoon', 'Recording the result'],
];
const POST_ATTEMPTS = 9, POST_WAIT_MS = 20000; // the new apps start asynchronously after the switch
/** Activation rows from an activation-run directory. Reads only. */
function activationProgress(output) {
  const directory = path.join(output, 'activation-run');
  if (!fs.existsSync(directory)) return [];
  const stopped = fs.existsSync(path.join(directory, 'stopped.json')), finished = readJSON(path.join(directory, 'result.json'));
  const rows = ACTIVATION.map(([id, , label]) => {
    // The read-only post check may be repeated while apps start; its newest attempt is the one that counts.
    const attempts = id === 'post' ? fs.readdirSync(directory).filter(name => /^post-\d+$/.test(name)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))) : [id];
    const current = attempts.at(-1), result = current ? readJSON(path.join(directory, current, 'result.json')) : undefined;
    const ok = result?.status === 'native-success' && result.executionSuccess === true;
    const waitingOnApps = id === 'post' && result && !ok && !stopped && !finished;
    return {id: 'activate:' + id, label,
      status: ok ? 'done' : waitingOnApps ? 'running' : result ? 'needs-attention' : current && fs.existsSync(path.join(directory, current)) ? 'running' : 'waiting',
      ...(result && !ok && !waitingOnApps ? {reason: String(result.reason ?? result.status ?? 'unknown').slice(0, 200)} : {})};
  });
  const preservation = readJSON(path.join(directory, 'preservation-verdict.json'));
  rows.push({id: 'activate:preservation', label: 'Checking your existing apps are unchanged',
    status: preservation ? (preservation.passed === true ? 'done' : 'needs-attention') : fs.existsSync(path.join(directory, 'preservation.log')) ? 'running' : 'waiting',
    ...(preservation && preservation.passed !== true ? {reason: 'The before and after records differ. See the private preservation report.'} : {})});
  if (stopped) for (const item of rows) if (item.status === 'running') {item.status = 'needs-attention'; item.reason = 'stopped before a result was recorded';}
  return rows;
}
function inspect(state) {try {return journal.inspectState(state);} catch {return undefined;}}
/** Everything a reopened window needs: where the run stands, from retained evidence only. */
function status(state, output) {
  const active = fs.existsSync(path.join(state, 'run.lock')); // held for the whole staging run, between steps too
  const inspected = inspect(state), items = [...preflightProgress(state), ...stageProgress(inspected, active), ...(output ? [...compileProgress(output), ...activationProgress(output)] : [])];
  const attention = items.find(item => item.status === 'needs-attention');
  const finished = output ? readJSON(path.join(output, 'result.json')) : undefined;
  const activated = output ? readJSON(path.join(output, 'activation-run/result.json')) : undefined;
  const activating = !!output && fs.existsSync(path.join(output, 'activation-run'));
  return {
    phase: activated?.phase === 'activated' ? 'activated' : attention ? 'needs-attention' : activating ? 'running' : finished?.phase === 'activation-prepared' ? 'activation-prepared' : attention ? 'needs-attention' : active || items.some(item => item.status === 'running') ? 'running' : items.every(item => item.status === 'waiting') ? 'not-started' : 'paused',
    ready: false, items,
    ...(attention ? {stoppedAt: attention.label, reason: attention.reason ?? 'This step did not finish. Nothing was retried.'} : {}),
  };
}
/** Run staging then compilation under one approved digest, calling report(status) on every change. */
async function run({state, output, approvedDigest}, report = () => {}) {
  need(typeof state === 'string' && typeof output === 'string' && /^[0-9a-f]{64}$/.test(approvedDigest ?? ''), 'Run requires state, output and the approved plan digest');
  let last = '';
  const emit = () => {const now = status(state, fs.existsSync(output) ? output : undefined), text = JSON.stringify(now); if (text !== last) {last = text; try {report(now);} catch { /* presentation cannot affect the run */ }} return now;};
  const timer = setInterval(emit, 500);
  try {
    const before = inspect(state); need(before && before.digest === approvedDigest, 'Approved digest does not match this plan');
    if (before.steps.length === 0 && !fs.existsSync(preflightDirectory(state))) {
      const directory = preflightDirectory(state), plan = before.plan; fs.mkdirSync(directory, {mode: 0o700});
      const native = (args, name) => child([process.execPath, path.join(__dirname, 'run-native.cjs'), '--ship', plan.ship, '--pier', plan.pier, '--vere', plan.vere, ...args,
        '--output', path.join(directory, name), '--timeout', '60'], path.join(directory, name + '.log'));
      const halt = () => {fs.writeFileSync(path.join(directory, 'stopped.json'), '{}', {mode: 0o600, flag: 'wx'}); return emit();};
      if (await native(['--operation', 'mount-base'], 'mount') !== 0) return halt();
      fs.writeFileSync(path.join(directory, 'runtime-probe.hoon'), RUNTIME_PROBE, {mode: 0o600, flag: 'wx'});
      if (await native(['--source', path.join(directory, 'runtime-probe.hoon')], 'runtime') !== 0) return halt();
      if (preflightProgress(state).some(item => item.status !== 'done')) return halt();
    }
    if (before.steps.length < STEPS.length) {
      // A separate process: staging hashes and copies synchronously, which would freeze progress here.
      const code = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'install-local.cjs'), 'execute', '--state', state, '--approve', approvedDigest], {stdio: 'ignore'});
        child.once('error', reject); child.once('exit', (exit, signal) => signal ? reject(Error('Staging was interrupted')) : resolve(exit));
      });
      if (code !== 0) return emit();
    }
    try {await compile({state, output, approvedDigest});} catch { /* compile-local recorded stopped.json; status explains it */ }
    return emit();
  } finally {clearInterval(timer);}
}

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function child(args, log) {
  return new Promise((resolve, reject) => {
    const fd = log ? fs.openSync(log, 'wx', 0o600) : 'ignore';
    let started;
    try {started = spawn(args[0], args.slice(1), {stdio: ['ignore', fd, fd]});} finally {if (log) fs.closeSync(fd);}
    started.once('error', reject); started.once('exit', (code, signal) => signal ? reject(Error('Interrupted')) : resolve(code));
  });
}
/**
 * Switch on a compiled, activation-prepared install: preflight, the one supported submission,
 * the structural post check, a complete snapshot, then the before/after preservation verdict.
 * A separate owner approval of the same plan digest. The submission is sent once and never repeated;
 * only the read-only post check is repeated while the new apps start.
 */
async function activate({state, output, approvedDigest}, report = () => {}) {
  need(typeof state === 'string' && typeof output === 'string' && /^[0-9a-f]{64}$/.test(approvedDigest ?? ''), 'Activation requires state, output and the approved plan digest');
  const inspected = journal.inspectState(state), plan = inspected.plan, compiled = readJSON(path.join(output, 'result.json'));
  need(inspected.digest === approvedDigest && compiled?.phase === 'activation-prepared' && compiled.planDigest === approvedDigest, 'This install is not compiled and prepared under the approved plan');
  const packetDirectory = path.join(output, 'activation/packet'), packet = readJSON(path.join(packetDirectory, 'packet.json'));
  need(packet && packet.ship === plan.ship && packet.desk === plan.desk && packet.files && typeof packet.files === 'object', 'Prepared activation packet differs from the plan');
  for (const [, file] of ACTIVATION) need(packet.files[file] === sha(fs.readFileSync(path.join(packetDirectory, file))), 'Prepared activation strand changed');
  need(!fs.existsSync(path.join(plan.pier, '.urb/readymade-operation.lock')), 'An earlier operation on this ship is unresolved');
  const directory = path.join(output, 'activation-run');
  need(!fs.existsSync(directory), 'Activation was already started for this install; it is never repeated');
  fs.mkdirSync(directory, {mode: 0o700});
  let last = '';
  const emit = () => {const now = status(state, output), text = JSON.stringify(now); if (text !== last) {last = text; try {report(now);} catch { /* presentation only */ }} return now;};
  const timer = setInterval(emit, 500);
  const native = (file, name) => child([process.execPath, path.join(__dirname, 'run-native.cjs'), '--ship', plan.ship, '--pier', plan.pier, '--vere', plan.vere,
    '--source', path.join(packetDirectory, file), '--output', path.join(directory, name), '--timeout', '1200'], path.join(directory, name + '.log'));
  const stop = why => {fs.writeFileSync(path.join(directory, 'stopped.json'), JSON.stringify({phase: 'activation-needs-inspection', why, automaticRetry: false}), {mode: 0o600, flag: 'wx'}); return emit();};
  try {
    if (await native('00-preflight.hoon', 'preflight') !== 0) return stop('preflight');
    if (await native('01-activate.hoon', 'submit') !== 0) return stop('submit');
    let started = false;
    for (let attempt = 1; attempt <= POST_ATTEMPTS && !started; attempt++) {
      if (attempt > 1) await new Promise(resolve => setTimeout(resolve, POST_WAIT_MS));
      const code = await native('02-post-install.hoon', 'post-' + attempt);
      // Anything but a decoded success or a decoded thread failure leaves the operation lock: stop, do not loop.
      if (code === 0) started = true;
      else if (fs.existsSync(path.join(plan.pier, '.urb/readymade-operation.lock'))) return stop('post');
    }
    if (!started) return stop('post');
    if (await native('03-snapshot.hoon', 'snapshot') !== 0) return stop('snapshot');
    const verdictFile = path.join(directory, 'preservation.json');
    const code = await child(['python3', '-I', path.join(__dirname, 'verify-preservation.py'), '--before', path.join(directory, 'preflight/response.newt'),
      '--after', path.join(directory, 'snapshot/response.newt'), '--output', verdictFile], path.join(directory, 'preservation.log'));
    fs.writeFileSync(path.join(directory, 'preservation-verdict.json'), JSON.stringify({passed: code === 0, exit: code}), {mode: 0o600, flag: 'wx'});
    if (code !== 0) return stop('preservation');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({schema: 'readymade-local-activation-result-v1', phase: 'activated', planDigest: approvedDigest,
      preservation: 'passed', firstTaskVerified: false}), {mode: 0o600, flag: 'wx'});
    return emit();
  } catch (error) {
    if (!fs.existsSync(path.join(directory, 'stopped.json'))) stop('interrupted');
    throw error;
  } finally {clearInterval(timer);}
}

if (require.main === module) {
  (async () => {
    const [action, ...args] = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {const name = args[i]?.slice(2); need(args[i]?.startsWith('--') && args[i + 1] && !Object.hasOwn(options, name), 'Invalid arguments'); options[name] = args[i + 1];}
    if (action === 'status') {need(options.state, 'Status requires --state'); console.log(JSON.stringify(status(options.state, options.output)));}
    else if (action === 'run') {
      need(Object.keys(options).sort().join(',') === 'approve,output,state', 'Run requires --state, --output and --approve');
      const final = await run({state: options.state, output: options.output, approvedDigest: options.approve}, now => console.log(JSON.stringify(now)));
      if (final.phase !== 'activation-prepared') process.exitCode = 2;
    } else if (action === 'activate') {
      need(Object.keys(options).sort().join(',') === 'approve,output,state', 'Activate requires --state, --output and --approve');
      const final = await activate({state: options.state, output: options.output, approvedDigest: options.approve}, now => console.log(JSON.stringify(now)));
      if (final.phase !== 'activated') process.exitCode = 2;
    } else throw Error('Use status, run or activate. Create and review the plan with install-local.cjs plan first.');
  })().catch(error => {console.error(error.message); process.exitCode = 1;});
}
module.exports = {run, activate, status, stageProgress, compileProgress, activationProgress, preflightProgress};
