const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('runtime preparation refuses existing output and corrupt package before fetching or modifying source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-runtime-prepare-'));
  try {
    const runtime = path.join(root, 'checkout/runtime'); fs.mkdirSync(runtime, {recursive: true});
    for (const name of ['prepare.py', 'source-manifest.json', 'readymade-vere.patch', 'bounded-evaluation-proof.hoon']) {
      fs.copyFileSync(path.resolve(__dirname, '../runtime', name), path.join(runtime, name));
    }
    const output = path.join(root, 'output'); fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'keep'), 'preserved');
    const run = target => spawnSync('python3', [path.join(runtime, 'prepare.py'), '--output', target], {encoding: 'utf8'});
    assert.match(run(output).stderr, /Output already exists/);
    assert.equal(fs.readFileSync(path.join(output, 'keep'), 'utf8'), 'preserved');
    assert.match(run(path.join(runtime, 'nested')).stderr, /outside the source checkout/);
    fs.symlinkSync(output, path.join(root, 'linked'));
    assert.match(run(path.join(root, 'linked')).stderr, /Output already exists/);
    fs.appendFileSync(path.join(runtime, 'readymade-vere.patch'), '\ncorrupt');
    const fresh = path.join(root, 'fresh');
    const corrupt = run(fresh);
    assert.notEqual(corrupt.status, 0); assert.match(corrupt.stderr, /Package hash mismatch/);
    assert.equal(fs.existsSync(fresh), false);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});
