'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {admit, orderedChecks, exchangeBudget, compile} = require('../backend/install/compile-local.cjs');
const completed = () => ({digest: 'a'.repeat(64), blocked: false, inFlight: undefined, nextStep: undefined,
  steps: ['receiver', 'create', 'mount', 'stage', 'commit', 'verify'].map(step => ({step, outcome: {status: 'success'}}))});
test('compilation admission requires the exact completed staging approval, never an unresolved or reordered history', () => {
  const state = completed(); assert.doesNotThrow(() => admit(state, state.digest));
  assert.throws(() => admit(state, 'b'.repeat(64)), /approval/);
  for (const field of ['blocked', 'inFlight', 'nextStep']) assert.throws(() => admit({...state, [field]: true}, state.digest), /complete/);
  for (const status of ['unknown', 'refused']) {const changed = completed(); changed.steps[4].outcome.status = status; assert.throws(() => admit(changed, changed.digest), /complete/);}
  const reordered = completed(); [reordered.steps[3], reordered.steps[4]] = [reordered.steps[4], reordered.steps[3]];
  assert.throws(() => admit(reordered, reordered.digest), /complete/);
  assert.throws(() => admit({...state, steps: state.steps.slice(0, 5)}, state.digest), /complete/);
});
test('source, ten applications, marks and runtime execute in fixed order regardless of object insertion order', () => {
  const names = ['00-source.hoon', '01-app-graf.hoon', '02-app-cantrip.hoon', '03-app-viki.hoon', '04-app-cli-inference.hoon', '05-app-multiplayer-runtime.hoon', '06-app-readymade-collab.hoon', '07-app-native-coding-source-import.hoon', '08-app-pataphor-native-console.hoon', '09-app-pataphor-page.hoon', '10-app-readymade-editing.hoon', '10-marks.hoon', '11-runtime.hoon'];
  const packet = {files: Object.fromEntries([...names].reverse().map(name => [name, 'a'.repeat(64)]))};
  assert.deepEqual(orderedChecks(packet), names);
  delete packet.files['02-app-cantrip.hoon']; assert.throws(() => orderedChecks(packet), /thirteen/);
  packet.files['02-app-cantrip.hoon'] = 'a'; packet.files['12-extra.hoon'] = 'b'; assert.throws(() => orderedChecks(packet), /thirteen/);
});
test('aggregate submission budget reserves encoding and decoding time and never extends a hung operation', () => {
  assert.equal(exchangeBudget(3600000, 0), 1200);
  assert.equal(exchangeBudget(3600000, 3000000), 420);
  assert.equal(exchangeBudget(3600000, 3419000), 1);
  for (const now of [3420000, 3600000, 4000000]) assert.throws(() => exchangeBudget(3600000, now), /exhausted/);
  assert.throws(() => exchangeBudget(Infinity, 0), /deadline/);
});
test('public compile API refuses incomplete state without creating output or starting any adapter', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'compile-admission-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const journal = require('../backend/install/install-state.cjs'), state = path.join(root, 'state'), output = path.join(root, 'new-output');
  const plan = {schema: 'readymade-local-install-v1', ship: '~zod', desk: 'readymade', pier: path.join(root, 'pier'), vere: path.join(root, 'vere'), bundle: path.join(root, 'bundle'), runtimeSHA256: '1'.repeat(64), bundleManifestSHA256: '2'.repeat(64), toolchainSHA256: '3'.repeat(64), hostBindingSHA256: '4'.repeat(64), steps: ['receiver', 'create', 'mount', 'stage', 'commit', 'verify']};
  const created = journal.createState(state, plan);
  await assert.rejects(compile({state, output, approvedDigest: created.digest}), /complete/);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(path.join(root, 'pier')), false);
  await assert.rejects(compile({state, output, approvedDigest: created.digest, retry: true}), /Unexpected/);
});
