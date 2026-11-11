#!/usr/bin/env node
'use strict';

// One consented installation run reported as plain progress events, for a button to drive.
// This adds no authority and no native request of its own: every write is still made by
// install-local.cjs and compile-local.cjs under the exact approved plan digest. It never
// retries, resumes a partial run, or activates anything.
const fs = require('node:fs');
const path = require('node:path');
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
function inspect(state) {try {return journal.inspectState(state);} catch {return undefined;}}
/** Everything a reopened window needs: where the run stands, from retained evidence only. */
function status(state, output) {
  const active = fs.existsSync(path.join(state, 'run.lock')); // held for the whole staging run, between steps too
  const inspected = inspect(state), items = [...stageProgress(inspected, active), ...(output ? compileProgress(output) : [])];
  const attention = items.find(item => item.status === 'needs-attention');
  const finished = output ? readJSON(path.join(output, 'result.json')) : undefined;
  return {
    phase: finished?.phase === 'activation-prepared' ? 'activation-prepared' : attention ? 'needs-attention' : active || items.some(item => item.status === 'running') ? 'running' : items.every(item => item.status === 'waiting') ? 'not-started' : 'paused',
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

if (require.main === module) {
  (async () => {
    const [action, ...args] = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {const name = args[i]?.slice(2); need(args[i]?.startsWith('--') && args[i + 1] && !Object.hasOwn(options, name), 'Invalid arguments'); options[name] = args[i + 1];}
    if (action === 'status') {need(options.state, 'Status requires --state'); console.log(JSON.stringify(status(options.state, options.output)));}
    else if (action === 'run') {
      need(Object.keys(options).sort().join(',') === 'approve,output,state', 'Run requires --state, --output and --approve');
      const final = await run({state: options.state, output: options.output, approvedDigest: options.approve}, now => console.log(JSON.stringify(now)));
      if (final.phase !== 'activation-prepared') process.exitCode = 2;
    } else throw Error('Use status or run. Create and review the plan with install-local.cjs plan first.');
  })().catch(error => {console.error(error.message); process.exitCode = 1;});
}
module.exports = {run, status, stageProgress, compileProgress};
