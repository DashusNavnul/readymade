const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const journal = require('../backend/install/install-state.cjs');
const {sequence, execute, createPlan, validateBundle, nativeEvidence} = require('../backend/install/install-local.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rm-install-controller-'));
  fs.chmodSync(root, 0o700);
  const directory = path.join(root, 'state');
  const plan = {schema: 'readymade-local-install-v1', ship: '~zod', desk: 'readymade', pier: path.join(root, 'pier'),
    vere: path.join(root, 'vere'), bundle: path.join(root, 'bundle'), runtimeSHA256: '1'.repeat(64),
    bundleManifestSHA256: '2'.repeat(64), toolchainSHA256: '3'.repeat(64), hostBindingSHA256: '4'.repeat(64), steps: ['receiver', 'create', 'mount', 'stage', 'commit', 'verify']};
  const saved = journal.createState(directory, plan);
  const proof = (folder, step) => {
    const file = path.join(folder, 'fixture-proof.json');
    fs.writeFileSync(file, JSON.stringify({fixture: true, step}), {flag: 'wx', mode: 0o600});
    return [{path: file, sha256: sha(fs.readFileSync(file))}];
  };
  return {root, directory, plan, ...saved, proof, close: () => fs.rmSync(root, {recursive: true, force: true})};
}

test('controller sequences durable intents before handlers and never calls staged source ready', async () => {
  const f = fixture(), calls = [];
  try {
    const actions = Object.fromEntries(f.plan.steps.map(step => [step, async folder => {
      calls.push(step);
      assert.equal(journal.inspectState(f.directory).inFlight, step);
      return f.proof(folder, step);
    }]));
    const result = await sequence(f.directory, f.digest, actions);
    assert.deepEqual(calls, f.plan.steps);
    assert.equal(result.phase, 'source-staged-not-activated'); assert.equal(result.ready, false);
    assert.equal(journal.inspectState(f.directory).blocked, false);
    assert.equal(fs.existsSync(path.join(f.directory, 'run.lock')), false);
    assert.equal((await sequence(f.directory, f.digest, actions)).phase, result.phase);
    assert.deepEqual(calls, f.plan.steps, 'Completed operations must not be replayed');
  } finally {f.close();}
});

test('uncertain handler retains its intent, all evidence and lock; rerun performs no more operations', async () => {
  const f = fixture(), calls = [];
  try {
    const actions = Object.fromEntries(f.plan.steps.map(step => [step, async folder => {
      calls.push(step);
      if (step === 'create') throw Error('Connection ended without an outcome');
      return f.proof(folder, step);
    }]));
    const result = await sequence(f.directory, f.digest, actions);
    assert.equal(result.phase, 'unknown'); assert.equal(result.step, 'create'); assert.equal(result.ready, false);
    assert.deepEqual(calls, ['receiver', 'create']);
    assert.equal(journal.inspectState(f.directory).blocked, true);
    assert.ok(fs.existsSync(path.join(f.directory, 'run.lock')));
    const before = fs.readdirSync(f.directory).map(name => [name, fs.readFileSync(path.join(f.directory, name)).toString('hex')]);
    await assert.rejects(sequence(f.directory, f.digest, actions));
    assert.deepEqual(calls, ['receiver', 'create']);
    assert.deepEqual(fs.readdirSync(f.directory).map(name => [name, fs.readFileSync(path.join(f.directory, name)).toString('hex')]), before);
  } finally {f.close();}
});

test('a mismatched approval cannot reserve a pier or start any handler', async () => {
  const f = fixture(); let calls = 0;
  try {
    await assert.rejects(sequence(f.directory, '0'.repeat(64), {receiver: () => {calls++;}}), /approval/);
    await assert.rejects(execute(f.directory, '0'.repeat(64)), /approval/);
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(f.directory + '-receipts'), false);
    assert.equal(fs.existsSync(path.join(f.directory, 'run.lock')), false);
    assert.equal(fs.existsSync(path.join(f.plan.pier, '.urb/readymade-install.lock')), false);
  } finally {f.close();}
});

test('fresh admission before each step stops pin drift before another operation intent', async () => {
  const f = fixture(); let source = 'approved'; const calls = [];
  try {
    const actions = Object.fromEntries(f.plan.steps.map(step => [step, async folder => {
      calls.push(step); source = 'changed'; return f.proof(folder, step);
    }]));
    await assert.rejects(sequence(f.directory, f.digest, actions, () => assert.equal(source, 'approved')));
    assert.deepEqual(calls, ['receiver']);
    assert.equal(journal.inspectState(f.directory).steps.length, 1);
    assert.equal(fs.existsSync(path.join(f.directory, 'create.intent.json')), false);
    assert.ok(fs.existsSync(path.join(f.directory, 'run.lock')));
  } finally {f.close();}
});

test('a refused journal cannot reserve a pier on another execute attempt', async () => {
  const f = fixture();
  try {
    await journal.withRunLock(f.directory, async () => {
      journal.startStep(f.directory, 'receiver', {});
      journal.finishStep(f.directory, 'receiver', {status: 'refused', evidence: f.proof(f.root, 'receiver')});
    });
    await assert.rejects(execute(f.directory, f.digest), /held/);
    assert.equal(fs.existsSync(path.join(f.directory, 'run.lock')), false);
    assert.equal(fs.existsSync(path.join(f.plan.pier, '.urb/readymade-install.lock')), false);
  } finally {f.close();}
});

test('native evidence retains request, source and raw response; later deletion or mutation fails inspection', async () => {
  const f = fixture();
  try {
    const output = path.join(f.root, 'native-fixture'); fs.mkdirSync(output, {mode: 0o700});
    for (const name of ['plan.json', 'source.hoon', 'request.newt', 'submitted.json', 'response.newt', 'result.json'])
      fs.writeFileSync(path.join(output, name), 'fixture ' + name, {mode: 0o600});
    const proof = nativeEvidence(output);
    assert.equal(proof.length, 6);
    await journal.withRunLock(f.directory, async () => {
      journal.startStep(f.directory, 'receiver', {}); journal.finishStep(f.directory, 'receiver', {status: 'success', evidence: proof});
    });
    fs.writeFileSync(path.join(output, 'response.newt'), 'substitution');
    assert.throws(() => journal.inspectState(f.directory), /Evidence changed/);
    fs.unlinkSync(path.join(output, 'response.newt'));
    assert.throws(() => journal.inspectState(f.directory));
    assert.throws(() => nativeEvidence(output));
  } finally {f.close();}
});

function bundleFixture(root) {
  const manifest = {schema: 'readymade-backend-assembly-v1', files: {}, notices: {}}, files = {};
  for (const [name, bytes] of [['desk/app/a.hoon', 'first'], ['desk/app/a/x.hoon', 'nested'], ['notices/LICENSE.txt', 'license']]) {
    const full = path.join(root, name); fs.mkdirSync(path.dirname(full), {recursive: true});
    fs.writeFileSync(full, bytes, {mode: 0o600});
    const [prefix, ...parts] = name.split('/');
    manifest[prefix === 'desk' ? 'files' : 'notices'][parts.join('/')] = {bytes: Buffer.byteLength(bytes), sha256: sha(bytes)};
    files[name] = sha(bytes);
  }
  fs.writeFileSync(path.join(root, 'assembly.json'), JSON.stringify({schema: 'readymade-backend-assembly-receipt-v1', files}), {mode: 0o600});
  return manifest;
}
test('bundle admission verifies exact contents, notices and assembly receipt, including nested sorting', () => {
  const f = fixture(), bundle = path.join(f.root, 'payload'); fs.mkdirSync(bundle, {mode: 0o700});
  try {
    const manifest = bundleFixture(bundle);
    assert.equal(validateBundle(bundle, manifest), 3);
    fs.writeFileSync(path.join(bundle, 'private-extra'), 'unexpected');
    assert.throws(() => validateBundle(bundle, manifest), /path set/);
    fs.unlinkSync(path.join(bundle, 'private-extra'));
    fs.writeFileSync(path.join(bundle, 'desk/app/a.hoon'), 'altered');
    assert.throws(() => validateBundle(bundle, manifest), /pinned source/);
  } finally {f.close();}
});
test('bundle admission rejects linked files, traversal pins and substituted assembly receipts', () => {
  const f = fixture(), bundle = path.join(f.root, 'payload'); fs.mkdirSync(bundle, {mode: 0o700});
  try {
    const manifest = bundleFixture(bundle);
    const traversal = structuredClone(manifest); traversal.files['../outside'] = {bytes: 1, sha256: 'a'.repeat(64)};
    assert.throws(() => validateBundle(bundle, traversal), /assembly path/);
    fs.linkSync(path.join(bundle, 'notices/LICENSE.txt'), path.join(f.root, 'linked-notice'));
    assert.throws(() => validateBundle(bundle, manifest), /local file/);
    fs.unlinkSync(path.join(f.root, 'linked-notice'));
    fs.writeFileSync(path.join(bundle, 'assembly.json'), JSON.stringify({schema: 'readymade-backend-assembly-receipt-v1', files: {}}));
    assert.throws(() => validateBundle(bundle, manifest), /receipt/);
  } finally {f.close();}
});
test('plan admission refuses unsupported desks and unknown inputs before reading a runtime', () => {
  const f = fixture();
  try {
    assert.throws(() => createPlan(path.join(f.root, 'other'), {ship: '~zod', desk: 'desk1', pier: f.root, vere: f.root, bundle: f.root}), /literal ship or desk/);
    assert.throws(() => createPlan(path.join(f.root, 'other'), {ship: '~zod', desk: 'readymade', pier: f.root, vere: f.root, bundle: f.root, command: 'unsafe'}), /Unexpected/);
  } finally {f.close();}
});

test('the worker is the single process holding the pier lock, whatever the lock file says', () => {
  const {lockHolders} = require('../backend/install/install-local.cjs');
  const lock = '/pier/.vere.lock';
  // One holder, reported once per open descriptor.
  assert.deepEqual(lockHolders(`p4133\nf10\nn${lock}\nf11\nn${lock}\n`, lock), [4133]);
  // Other files of the same process and other piers' locks do not count.
  assert.deepEqual(lockHolders(`p7\nn/other/.vere.lock\np4133\nn/pier/.urb/conn.sock\nn${lock}\n`, lock), [4133]);
  // Two holders are reported as two, so the caller refuses.
  assert.deepEqual(lockHolders(`p12\nn${lock}\np13\nn${lock}\n`, lock), [12, 13]);
  // A deleted lock, a name before any pid, a malformed pid and empty output hold nothing.
  for (const text of [`p13\nn${lock} (deleted)\n`, `n${lock}\n`, `p0\nn${lock}\n`, `p-4\nn${lock}\n`, ''])
    assert.deepEqual(lockHolders(text, lock), []);
});
