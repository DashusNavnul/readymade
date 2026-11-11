const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {stageProgress, compileProgress, status, run} = require('../backend/install/install-all.cjs');

const STEPS = ['receiver', 'create', 'mount', 'stage', 'commit', 'verify'];
const statuses = rows => rows.map(row => row.status);
function compileFixture(t, checks = ['00-source', '01-app-graf', '02-marks']) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rm-install-all-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'compilation'));
  for (const name of checks) fs.writeFileSync(path.join(root, 'compilation', name + '.hoon'), '~');
  fs.writeFileSync(path.join(root, 'compilation', 'packet.json'), '{}');
  const finish = (name, result = {status: 'native-success', executionSuccess: true}) => {
    fs.mkdirSync(path.join(root, name), {recursive: true}); fs.writeFileSync(path.join(root, name, 'result.json'), JSON.stringify(result));
  };
  return {root, finish, start: name => fs.mkdirSync(path.join(root, name))};
}

test('staging rows follow the journal: done, in flight, waiting, and a blocked step needs attention', () => {
  const done = step => ({step, intent: {}, outcome: {status: 'success'}});
  assert.deepEqual(statuses(stageProgress(undefined)), Array(6).fill('waiting'));
  assert.deepEqual(statuses(stageProgress({steps: STEPS.map(done), blocked: false})), Array(6).fill('done'));
  // The journal reports every open step as blocked (seen live: six false warnings during one good run).
  // Only the held run lock distinguishes a step in progress from one that was cut off.
  const open = {steps: [done('receiver'), {step: 'create', intent: {}}], blocked: true, inFlight: 'create'};
  assert.deepEqual(statuses(stageProgress(open, true)), ['done', 'running', 'waiting', 'waiting', 'waiting', 'waiting']);
  assert.deepEqual(statuses(stageProgress(open, false)), ['done', 'needs-attention', 'waiting', 'waiting', 'waiting', 'waiting']);
  assert.deepEqual(statuses(stageProgress(open)), ['done', 'needs-attention', 'waiting', 'waiting', 'waiting', 'waiting']);
  assert.deepEqual(statuses(stageProgress({steps: [done('receiver'), {step: 'create', intent: {}, outcome: {status: 'refused'}}], blocked: true})),
    ['done', 'needs-attention', 'waiting', 'waiting', 'waiting', 'waiting']);
  assert.equal(stageProgress(undefined)[0].label, 'Checking your ship');
});

test('compile rows come from retained results and never call an unfinished check done', t => {
  const {root, finish, start} = compileFixture(t);
  assert.deepEqual(compileProgress(path.join(root, 'absent')).map(row => row.id), ['compile:baseline', 'compile:activation']);
  assert.deepEqual(statuses(compileProgress(root)), ['waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
  finish('00-source'); start('01-app-graf');
  let rows = compileProgress(root);
  assert.deepEqual(statuses(rows), ['done', 'running', 'waiting', 'waiting', 'waiting']);
  assert.deepEqual(rows.map(row => row.label).slice(0, 3), ['Re-checking the saved files', 'Building graf', 'Checking data formats']);
  // A transport success whose execution is unverified is not done.
  finish('01-app-graf', {status: 'response-retained', executionSuccess: 'unverified', reason: 'Decode large response separately'});
  rows = compileProgress(root);
  assert.equal(rows[1].status, 'needs-attention'); assert.equal(rows[1].reason, 'Decode large response separately');
  finish('01-app-graf', {status: 'native-success', executionSuccess: false});
  assert.equal(compileProgress(root)[1].status, 'needs-attention');
});

test('a stopped run names the check that was in flight; a finished run is activation-prepared and still not ready', t => {
  const {root, finish, start} = compileFixture(t);
  finish('00-source'); start('01-app-graf'); fs.writeFileSync(path.join(root, 'stopped.json'), '{}');
  let rows = compileProgress(root);
  assert.equal(rows[1].status, 'needs-attention'); assert.match(rows[1].reason, /stopped before a result/);
  assert.equal(rows.at(-1).status, 'needs-attention');
  fs.rmSync(path.join(root, 'stopped.json'));
  for (const name of ['01-app-graf', '02-marks', 'baseline']) finish(name);
  fs.mkdirSync(path.join(root, 'activation')); fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({phase: 'activation-prepared', ready: false}));
  rows = compileProgress(root);
  assert.ok(rows.every(row => row.status === 'done'));
  // No journal at this path: staging rows stay waiting, yet the compile result is what the phase reports.
  const report = status(path.join(root, 'no-journal'), root);
  assert.equal(report.phase, 'activation-prepared'); assert.equal(report.ready, false);
});

test('status explains a stop in words and run refuses anything but an exact approved digest', async t => {
  const {root, finish, start} = compileFixture(t);
  finish('00-source'); start('01-app-graf'); fs.writeFileSync(path.join(root, 'stopped.json'), '{}');
  const report = status(path.join(root, 'no-journal'), root);
  assert.equal(report.phase, 'needs-attention'); assert.equal(report.stoppedAt, 'Building graf'); assert.ok(report.reason.length > 0);
  assert.equal(status(path.join(root, 'no-journal')).phase, 'not-started');
  await assert.rejects(run({state: root, output: path.join(root, 'out'), approvedDigest: 'short'}), /approved plan digest/);
  await assert.rejects(run({state: path.join(root, 'no-journal'), output: path.join(root, 'out'), approvedDigest: 'a'.repeat(64)}), /does not match this plan/);
  assert.equal(fs.existsSync(path.join(root, 'out')), false, 'A refused run writes nothing');
});

test('a held run lock means running, between steps too; without it an idle journal is paused', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rm-install-all-lock-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  assert.equal(status(root).phase, 'not-started');
  fs.writeFileSync(path.join(root, 'run.lock'), 'held');
  assert.equal(status(root).phase, 'running');
});
