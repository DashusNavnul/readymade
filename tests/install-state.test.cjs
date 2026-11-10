'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const state = require('../backend/install/install-state.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'install-state-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const directory = path.join(root, 'journal');
  const plan = {schema: 'readymade-local-install-v1', ship: '~zod', desk: 'readymade',
    pier: path.join(root, 'pier'), vere: path.join(root, 'vere'), runtimeSHA256: 'a'.repeat(64),
    bundle: path.join(root, 'bundle'), bundleManifestSHA256: 'b'.repeat(64), toolchainSHA256: 'c'.repeat(64), hostBindingSHA256: '4'.repeat(64),
    steps: ['receiver', 'create', 'mount', 'stage', 'commit', 'verify']};
  const evidencePath = path.join(root, 'receipt.json');
  fs.writeFileSync(evidencePath, '{"observed":true}\n', {mode: 0o600});
  const evidence = [{path: evidencePath, sha256: sha(fs.readFileSync(evidencePath))}];
  return {root, directory, plan, evidence};
}
test('ordered durable steps survive reopening, and completed intent cannot replay', async t => {
  const f = fixture(t), created = state.createState(f.directory, f.plan);
  assert.equal(state.inspectState(f.directory).digest, created.digest);
  assert.throws(() => state.startStep(f.directory, 'receiver', {}), /lock required/);
  for (const step of f.plan.steps) {
    await state.withRunLock(f.directory, async () => {
      assert.equal(state.inspectState(f.directory).nextStep, step);
      state.startStep(f.directory, step, {receiptDirectory: f.root});
      assert.equal(state.inspectState(f.directory).inFlight, step);
      state.finishStep(f.directory, step, {status: 'success', evidence: f.evidence});
      assert.throws(() => state.startStep(f.directory, step, {}), /unavailable/);
    });
    assert.equal(fs.existsSync(path.join(f.directory, 'run.lock')), false);
  }
  const final = state.inspectState(f.directory);
  assert.equal(final.steps.length, 6); assert.equal(final.nextStep, undefined); assert.equal(final.blocked, false);
  assert.throws(() => state.createState(f.directory, f.plan), /EEXIST/);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(f.directory)) assert.equal(fs.statSync(path.join(f.directory, file)).mode & 0o777, 0o600);
});
test('unknown and crash-after-intent retain lock and prohibit another dispatch', async t => {
  for (const outcome of ['unknown', 'crash']) {
    const f = fixture(t); state.createState(f.directory, f.plan);
    const run = state.withRunLock(f.directory, async () => {
      state.startStep(f.directory, 'receiver', {sourceSHA256: 'c'.repeat(64)});
      if (outcome === 'crash') throw Error('simulated interruption');
      state.finishStep(f.directory, 'receiver', {status: 'unknown', evidence: f.evidence});
    });
    if (outcome === 'crash') await assert.rejects(run, /interruption/); else await run;
    const result = state.inspectState(f.directory);
    assert.equal(result.blocked, true); assert.equal(result.nextStep, undefined);
    assert.ok(fs.existsSync(path.join(f.directory, 'run.lock')));
    await assert.rejects(state.withRunLock(f.directory, () => assert.fail('must not run')), /observe only/);
  }
});
test('one lock owner, ordered steps, and known refusal releases only run lock', async t => {
  const f = fixture(t); state.createState(f.directory, f.plan);
  await state.withRunLock(f.directory, async () => {
    await assert.rejects(state.withRunLock(f.directory, () => assert.fail('concurrent callback')), /EEXIST/);
    assert.throws(() => state.startStep(f.directory, 'create', {}), /unavailable/);
    state.startStep(f.directory, 'receiver', {});
    state.finishStep(f.directory, 'receiver', {status: 'refused', evidence: f.evidence});
  });
  assert.equal(fs.existsSync(path.join(f.directory, 'run.lock')), false);
  assert.equal(state.inspectState(f.directory).blocked, true);
  await assert.rejects(state.withRunLock(f.directory, () => {}), /refused/);
});
test('evidence mutation, partial records, and altered plan bindings fail closed', async t => {
  const f = fixture(t); state.createState(f.directory, f.plan);
  await state.withRunLock(f.directory, async () => {
    state.startStep(f.directory, 'receiver', {});
    state.finishStep(f.directory, 'receiver', {status: 'success', evidence: f.evidence});
  });
  fs.writeFileSync(f.evidence[0].path, 'changed');
  assert.throws(() => state.inspectState(f.directory), /Evidence changed/);
  const partial = fixture(t); state.createState(partial.directory, partial.plan);
  fs.writeFileSync(path.join(partial.directory, 'receiver.intent.json'), '{', {mode: 0o600});
  assert.throws(() => state.inspectState(partial.directory));
  const altered = fixture(t); state.createState(altered.directory, altered.plan);
  const planPath = path.join(altered.directory, 'plan.json');
  fs.writeFileSync(planPath, fs.readFileSync(planPath, 'utf8').replace('~zod', '~nec'));
  assert.throws(() => state.inspectState(altered.directory), /digest mismatch/);
});
test('outcome cannot substitute another intent or cross installation', async t => {
  const f = fixture(t); state.createState(f.directory, f.plan);
  await state.withRunLock(f.directory, async () => {
    state.startStep(f.directory, 'receiver', {sequence: 1});
    state.finishStep(f.directory, 'receiver', {status: 'success', evidence: f.evidence});
  });
  const intent = path.join(f.directory, 'receiver.intent.json');
  fs.writeFileSync(intent, fs.readFileSync(intent, 'utf8').replace('"sequence":1', '"sequence":2'));
  assert.throws(() => state.inspectState(f.directory), /Outcome binding mismatch/);
  const other = fixture(t); state.createState(other.directory, other.plan);
  fs.copyFileSync(path.join(f.directory, 'receiver.outcome.json'), path.join(other.directory, 'receiver.outcome.json'));
  assert.throws(() => state.inspectState(other.directory), /Orphan outcome/);
});
test('symlink, hardlink, permissions and undeclared records are refused', async t => {
  const f = fixture(t); state.createState(f.directory, f.plan);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.directory, alias);
  assert.throws(() => state.inspectState(alias), /Symlink/);
  fs.chmodSync(f.directory, 0o755);
  assert.throws(() => state.inspectState(f.directory), /Private permissions/);
  fs.chmodSync(f.directory, 0o700);
  fs.linkSync(path.join(f.directory, 'plan.json'), path.join(f.root, 'hardlink'));
  assert.throws(() => state.inspectState(f.directory), /nonregular/);
  const g = fixture(t); state.createState(g.directory, g.plan);
  fs.writeFileSync(path.join(g.directory, 'unexpected.json'), '{}', {mode: 0o600});
  assert.throws(() => state.inspectState(g.directory), /Unexpected journal file/);
});
test('toolchain pin is required, canonical and part of approval digest', t => {
  const f = fixture(t);
  assert.throws(() => state.createState(f.directory, {...f.plan, toolchainSHA256: 'A'.repeat(64)}), /pins/);
  const {toolchainSHA256, ...missing} = f.plan;
  assert.ok(toolchainSHA256);
  assert.throws(() => state.createState(f.directory, missing), /fields/);
  const a = state.createState(f.directory, f.plan);
  const other = path.join(f.root, 'other');
  const b = state.createState(other, {...f.plan, toolchainSHA256: 'd'.repeat(64)});
  assert.notEqual(a.digest, b.digest);
});
test('plan literals reject trailing newlines, controls and coercible nonstrings before creating state', t => {
  const f = fixture(t);
  const fields = ['schema', 'ship', 'desk', 'pier', 'vere', 'bundle', 'runtimeSHA256', 'bundleManifestSHA256', 'toolchainSHA256', 'hostBindingSHA256'];
  for (const field of fields) {
    for (const suffix of ['\n', '\r', '\r\n', '\0', '\t', '\u2028', '\u2029']) {
      assert.throws(() => state.createState(f.directory, {...f.plan, [field]: f.plan[field] + suffix}), field + ' suffix');
      assert.equal(fs.existsSync(f.directory), false);
    }
    for (const value of [null, 1, true, [f.plan[field]], {toString: () => f.plan[field]}]) {
      assert.throws(() => state.createState(f.directory, {...f.plan, [field]: value}), field + ' type');
      assert.equal(fs.existsSync(f.directory), false);
    }
  }
  assert.throws(() => state.createState(f.directory, {...f.plan, steps: [...f.plan.steps.slice(0, 5), 'verify\n']}));
});
test('host binding is required and changes the approved plan digest', t => {
  const f = fixture(t);
  const {hostBindingSHA256, ...missing} = f.plan;
  assert.equal(hostBindingSHA256, '4'.repeat(64));
  assert.throws(() => state.createState(f.directory, missing), /fields/);
  assert.throws(() => state.createState(f.directory, {...f.plan, hostBindingSHA256: 'g'.repeat(64)}), /pins/);
  const a = state.createState(f.directory, f.plan);
  const b = state.createState(path.join(f.root, 'other'), {...f.plan, hostBindingSHA256: '5'.repeat(64)});
  assert.notEqual(a.digest, b.digest);
});
