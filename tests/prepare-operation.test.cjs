const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const script = path.join(root, 'backend/install/prepare-operation.py');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('installation operation preparation binds explicit identity/revision and preserves complete native templates', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-operation-'));
  try {
    for (const operation of ['receiver', 'observe', 'create', 'mount', 'commit']) {
      const output = path.join(temp, operation), mutating = ['create', 'mount', 'commit'].includes(operation);
      const revision = ['mount', 'commit'].includes(operation) ? ['--revision', '1234'] : [];
      const args = [script, '--ship', '~lus', '--desk', 'readymade', '--operation', operation, ...revision, '--output', output];
      const run = spawnSync('python3', args, {encoding: 'utf8'}); assert.equal(run.status, 0, run.stderr);
      const packet = JSON.parse(fs.readFileSync(path.join(output, 'packet.json')));
      const source = fs.readFileSync(path.join(output, 'operation.hoon'));
      assert.equal(packet.executed, false); assert.equal(packet.mutating, mutating);
      assert.equal(packet.sourceSHA256, sha(source));
      const template = fs.readFileSync(path.join(root, 'backend/install', packet.template));
      assert.equal(packet.templateSHA256, sha(template));
      assert.equal(source.subarray(source.indexOf(10) + 1).equals(template), true);
      assert.equal(source.toString().split('\n')[0], `=/  arg=vase  !>([~lus %readymade${operation === 'receiver' ? '' : ` %${operation} ${revision.length ? '1.234' : '0'}`}])`);
      assert.equal(fs.statSync(output).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(output, 'operation.hoon')).mode & 0o777, 0o600);
      assert.notEqual(spawnSync('python3', args).status, 0);
      assert.equal(fs.readFileSync(path.join(output, 'operation.hoon')).equals(source), true);
    }
    for (const [index, extra] of [['--desk', 'base'], ['--ship', '~lus])\n(poke'], ['--operation', 'mount'],
      ['--operation', 'commit', '--revision', '0'], ['--revision', '1']].entries()) {
      const output = path.join(temp, `refused-${index}`);
      const run = spawnSync('python3', [script, '--ship', '~lus', '--desk', 'readymade', '--operation', 'observe', ...extra, '--output', output]);
      assert.notEqual(run.status, 0); assert.equal(fs.existsSync(output), false);
    }
  } finally {fs.rmSync(temp, {recursive: true, force: true});}
});
