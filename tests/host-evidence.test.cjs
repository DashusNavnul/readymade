const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {createRun, finish} = require('../platform/host-evidence.cjs');
test('Host evidence retains unique private runs and exclusive terminal outcomes', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'host-evidence-test-'));
  try {
    const root = path.join(parent, 'retained'), first = createRun(root), second = createRun(root);
    assert.notEqual(first, second); assert.equal(fs.statSync(first).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(first, 'run.json')).mode & 0o777, 0o600);
    finish(first, 1); finish(second, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(first, 'exit.json'))).exitCode, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(second, 'exit.json'))).exitCode, 0);
    assert.throws(() => finish(first, 0), /EEXIST/);
    assert.throws(() => finish(second, -1), /Invalid/);
  } finally {fs.rmSync(parent, {recursive: true, force: true});}
});
test('Host evidence refuses linked, exposed, relative and non-directory roots', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'host-evidence-input-'));
  try {
    const target = path.join(parent, 'target'); fs.mkdirSync(target, {mode: 0o700});
    const link = path.join(parent, 'link'); fs.symlinkSync(target, link);
    assert.throws(() => createRun(link), /directory/); assert.deepEqual(fs.readdirSync(target), []);
    assert.throws(() => createRun(path.join(link, 'nested')), /directory/);
    fs.chmodSync(target, 0o755); assert.throws(() => createRun(target), /directory/);
    assert.throws(() => createRun('relative'), /absolute/);
    const file = path.join(parent, 'file'); fs.writeFileSync(file, 'unchanged');
    assert.throws(() => createRun(file), /directory/); assert.equal(fs.readFileSync(file, 'utf8'), 'unchanged');
  } finally {fs.rmSync(parent, {recursive: true, force: true});}
});
