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

test('activation rows: the read-only post check may repeat while apps start; the newest attempt counts', t => {
  const {activationProgress} = require('../backend/install/install-all.cjs');
  const {root} = compileFixture(t), run = path.join(root, 'activation-run');
  const result = (name, value) => {fs.mkdirSync(path.join(run, name), {recursive: true}); fs.writeFileSync(path.join(run, name, 'result.json'), JSON.stringify(value));};
  const ok = {status: 'native-success', executionSuccess: true}, failed = {status: 'native-failure', executionSuccess: false};
  assert.deepEqual(activationProgress(root), [], 'No activation rows before activation starts');
  fs.mkdirSync(run);
  assert.deepEqual(statuses(activationProgress(root)), Array(5).fill('waiting'));
  result('preflight', ok); result('submit', ok); result('post-1', failed);
  let rows = activationProgress(root);
  assert.deepEqual(statuses(rows), ['done', 'done', 'running', 'waiting', 'waiting'], 'A first failed post check means the apps are still starting');
  result('post-2', failed); result('post-10', ok);
  assert.equal(activationProgress(root)[2].status, 'done', 'Attempt 10 sorts after attempt 2');
  result('snapshot', ok); fs.writeFileSync(path.join(run, 'preservation.log'), '');
  assert.equal(activationProgress(root)[4].status, 'running');
  fs.writeFileSync(path.join(run, 'preservation-verdict.json'), JSON.stringify({passed: false, exit: 2}));
  rows = activationProgress(root);
  assert.equal(rows[4].status, 'needs-attention'); assert.match(rows[4].reason, /differ/);
  fs.writeFileSync(path.join(run, 'preservation-verdict.json'), JSON.stringify({passed: true, exit: 0}));
  assert.ok(activationProgress(root).every(row => row.status === 'done'));
});

test('a stopped activation names its step; activated is reported only from the final record', t => {
  const {activationProgress} = require('../backend/install/install-all.cjs');
  const {root, finish} = compileFixture(t), run = path.join(root, 'activation-run');
  for (const name of ['00-source', '01-app-graf', '02-marks', 'baseline']) finish(name);
  fs.mkdirSync(path.join(root, 'activation')); fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({phase: 'activation-prepared'}));
  fs.mkdirSync(path.join(run, 'preflight'), {recursive: true});
  assert.equal(status(path.join(root, 'no-journal'), root).phase, 'running');
  fs.writeFileSync(path.join(run, 'stopped.json'), '{}');
  const stopped = status(path.join(root, 'no-journal'), root);
  assert.equal(stopped.phase, 'needs-attention'); assert.equal(stopped.stoppedAt, 'Final check before switching on');
  assert.equal(activationProgress(root)[0].status, 'needs-attention');
  fs.rmSync(path.join(run, 'stopped.json'));
  fs.writeFileSync(path.join(run, 'preflight', 'result.json'), JSON.stringify({status: 'native-success', executionSuccess: true}));
  assert.notEqual(status(path.join(root, 'no-journal'), root).phase, 'activated');
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({phase: 'activated'}));
  assert.equal(status(path.join(root, 'no-journal'), root).phase, 'activated');
});

test('activation refuses anything but a compiled, prepared install under the exact digest', async t => {
  const {activate} = require('../backend/install/install-all.cjs');
  const {root} = compileFixture(t);
  await assert.rejects(activate({state: root, output: root, approvedDigest: 'short'}), /approved plan digest/);
  await assert.rejects(activate({state: path.join(root, 'no-journal'), output: root, approvedDigest: 'a'.repeat(64)}));
  assert.equal(fs.existsSync(path.join(root, 'activation-run')), false, 'A refused activation creates nothing');
});

test('the up-front checks name a ship that cannot run the backend before any work is done', t => {
  const {preflightProgress} = require('../backend/install/install-all.cjs');
  const {root} = compileFixture(t), state = path.join(root, 'state'), directory = state + '-preflight';
  assert.deepEqual(preflightProgress(state), []);
  const result = (name, value, text) => {fs.mkdirSync(path.join(directory, name), {recursive: true}); fs.writeFileSync(path.join(directory, name, 'result.json'), JSON.stringify(value)); if (text) fs.writeFileSync(path.join(directory, name, 'response.hoon'), text);};
  const ok = {status: 'native-success', executionSuccess: true};
  fs.mkdirSync(directory);
  assert.deepEqual(statuses(preflightProgress(state)), ['waiting', 'waiting']);
  result('mount', ok); fs.mkdirSync(path.join(directory, 'runtime'));
  assert.deepEqual(statuses(preflightProgress(state)), ['done', 'running']);
  result('runtime', ok, '[0 %avow 0 %noun %readymade-runtime-unbounded]\n');
  let rows = preflightProgress(state);
  assert.equal(rows[1].status, 'needs-attention'); assert.match(rows[1].reason, /needs the Readymade runtime/);
  // A successful transport with no readable verdict is not a pass either.
  fs.rmSync(path.join(directory, 'runtime/response.hoon'));
  assert.equal(preflightProgress(state)[1].status, 'needs-attention');
  result('runtime', ok, '[0 %avow 0 %noun %readymade-runtime-bounded]\n');
  assert.deepEqual(statuses(preflightProgress(state)), ['done', 'done']);
  result('runtime', {status: 'native-failure', executionSuccess: false});
  rows = preflightProgress(state);
  assert.equal(rows[1].status, 'needs-attention'); assert.equal(rows[1].reason, 'native-failure');
});

// ---- continuing an interrupted install (build checks only) ----
const crypto = require('node:crypto');
const journal = require('../backend/install/install-state.cjs');
const {resumable, resume} = require('../backend/install/install-all.cjs');
async function stagedFixture(t, finishSteps = STEPS) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rm-install-resume-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const state = path.join(root, 'journal'), pier = path.join(root, 'pier'); fs.mkdirSync(path.join(pier, '.urb'), {recursive: true});
  const plan = {schema: 'readymade-local-install-v1', ship: '~zod', desk: 'readymade', pier, vere: path.join(root, 'vere'), runtimeSHA256: 'a'.repeat(64),
    bundle: path.join(root, 'bundle'), bundleManifestSHA256: 'b'.repeat(64), toolchainSHA256: 'c'.repeat(64), hostBindingSHA256: '4'.repeat(64), steps: STEPS};
  const receipt = path.join(root, 'receipt.json'); fs.writeFileSync(receipt, '{"observed":true}\n', {mode: 0o600});
  const evidence = [{path: receipt, sha256: crypto.createHash('sha256').update(fs.readFileSync(receipt)).digest('hex')}];
  const created = journal.createState(state, plan);
  await journal.withRunLock(state, async () => {
    for (const step of finishSteps) {journal.startStep(state, step, {receiptDirectory: root}); journal.finishStep(state, step, {status: 'success', evidence});}
  });
  const previous = path.join(root, 'out'); fs.mkdirSync(previous);
  return {root, state, pier, previous, digest: created.digest ?? journal.inspectState(state).digest};
}
test('a stopped build can be continued only when staging finished and nothing of the earlier run is alive', async t => {
  const f = await stagedFixture(t);
  assert.deepEqual(Object.keys(resumable(f.state, f.previous)).sort(), ['digest', 'installLock', 'operationLock', 'resumable']);
  assert.equal(resumable(f.state, f.previous).resumable, true);
  assert.match(resumable(f.state, path.join(f.root, 'never')).reason, /had not started/);
  // A dead owner of the same build output: the lock can be released. A live owner, or another operation's lock: never.
  const lock = path.join(f.pier, '.urb/readymade-operation.lock'); fs.mkdirSync(lock);
  const owner = value => fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(value));
  owner({pid: 2 ** 22 + 12345, output: path.join(f.previous, '01-app-graf')}); assert.equal(resumable(f.state, f.previous).resumable, true); assert.equal(resumable(f.state, f.previous).operationLock, lock);
  owner({pid: process.pid, output: path.join(f.previous, '01-app-graf')}); assert.match(resumable(f.state, f.previous).reason, /still running/);
  owner({pid: 2 ** 22 + 12345, output: path.join(f.root, 'elsewhere', 'x')}); assert.match(resumable(f.state, f.previous).reason, /another operation/);
  owner({nonsense: true}); assert.match(resumable(f.state, f.previous).reason, /cannot be identified/);
  fs.rmSync(lock, {recursive: true});
  fs.writeFileSync(path.join(f.previous, 'result.json'), '{}'); assert.match(resumable(f.state, f.previous).reason, /already finished/); fs.rmSync(path.join(f.previous, 'result.json'));
  fs.mkdirSync(path.join(f.previous, 'activation-run')); assert.match(resumable(f.state, f.previous).reason, /never repeated/); fs.rmSync(path.join(f.previous, 'activation-run'), {recursive: true});
  fs.writeFileSync(path.join(f.state, 'run.lock'), 'held'); assert.match(resumable(f.state, f.previous).reason, /still held by a run/); fs.rmSync(path.join(f.state, 'run.lock'));
  const partial = await stagedFixture(t, STEPS.slice(0, 3));
  assert.match(resumable(partial.state, partial.previous).reason, /Copying the files to your ship did not finish/);
});
test('resume refuses before writing anything unless the digest is the approved one; a refused resume leaves the earlier run untouched', async t => {
  const f = await stagedFixture(t), next = path.join(f.root, 'out-2');
  await assert.rejects(resume({state: f.state, previous: f.previous, output: next, approvedDigest: 'f'.repeat(64)}), /does not match this plan/);
  await assert.rejects(resume({state: f.state, previous: f.previous, output: f.previous, approvedDigest: f.digest}), /new output/);
  await assert.rejects(resume({state: f.state, previous: path.join(f.root, 'never'), output: next, approvedDigest: f.digest}), /had not started/);
  assert.equal(fs.existsSync(next), false); assert.equal(fs.existsSync(path.join(f.previous, 'resumed.json')), false);
  // With the approved digest it marks the earlier run, releases the dead run's locks and starts the build driver,
  // which stops at its own first check here (this fixture has no bundle): the stop is recorded, never retried.
  const lock = path.join(f.pier, '.urb/readymade-operation.lock'); fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({pid: 2 ** 22 + 12345, output: path.join(f.previous, '01-app-graf')}));
  fs.writeFileSync(path.join(f.pier, '.urb/readymade-install.lock'), 'old-token');
  const final = await resume({state: f.state, previous: f.previous, output: next, approvedDigest: f.digest});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.previous, 'resumed.json'), 'utf8')), {schema: 'readymade-local-compilation-resumed-v1', continuedAs: next, releasedOperationLock: true});
  assert.equal(fs.existsSync(lock), false); assert.notEqual(final.phase, 'activation-prepared');
  assert.match(resumable(f.state, f.previous).reason, /already continued once/);
});
