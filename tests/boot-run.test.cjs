const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const {prepare, status, shippedRuntime, planetFromKeyfile, firstFree, tcpFree} = require('../backend/install/boot-run.cjs');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rm-boot-run-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, {recursive: true, force: true})); return root;
}
const statuses = report => report.items.map(item => item.status);

test('a planet name is read only from a well-formed keyfile name', () => {
  assert.equal(planetFromKeyfile('/Users/someone/Downloads/sampel-palnet-1.key'), '~sampel-palnet');
  assert.equal(planetFromKeyfile('sampel-palnet.key'), '~sampel-palnet');
  for (const bad of ['sampel.key', 'sampel-palnet-1.txt', 'Sampel-Palnet-1.key', 'sampel-palnet-dozzod-dozzod-1.key', 'passport.zip', '', undefined])
    assert.equal(planetFromKeyfile(bad), undefined, String(bad));
});

test('the shipped runtime is used only with both recorded hashes', t => {
  const root = workspace(t);
  assert.throws(() => shippedRuntime(root), /does not include the Urbit runtime/);
  fs.writeFileSync(path.join(root, 'runtime.json'), JSON.stringify({runtimeSHA256: 'a'.repeat(64)}));
  assert.throws(() => shippedRuntime(root), /does not include the Urbit runtime/);
  fs.writeFileSync(path.join(root, 'runtime.json'), JSON.stringify({runtimeSHA256: 'a'.repeat(64), pillSHA256: 'b'.repeat(64)}));
  assert.deepEqual(shippedRuntime(root), {vere: path.join(root, 'urbit'), pill: path.join(root, 'brass.pill'), runtimeSHA256: 'a'.repeat(64), pillSHA256: 'b'.repeat(64)});
});

test('port choice skips a port that is in use and gives up after its bound', async t => {
  const server = net.createServer(); await new Promise(resolve => server.listen({port: 0, host: '127.0.0.1'}, resolve)); t.after(() => server.close());
  const taken = server.address().port;
  const free = port => new Promise(resolve => {const probe = net.createServer(); probe.once('error', () => resolve(false)); probe.listen({port, host: '127.0.0.1', exclusive: true}, () => probe.close(() => resolve(true)));});
  assert.notEqual(await firstFree(taken, free), taken);
  await assert.rejects(firstFree(taken, async () => false, 3), /No free local port/);
});

test('preparing refuses, before reading any key, a bad name, a missing confirmation and an existing setup', async t => {
  const root = workspace(t), runtime = {vere: '/none', pill: '/none', runtimeSHA256: 'a'.repeat(64), pillSHA256: 'b'.repeat(64)};
  const base = {ship: '~sampel-palnet', keyfile: path.join(root, 'absent.key'), root: path.join(root, 'ships'), singleInstanceConfirmed: true};
  await assert.rejects(prepare({...base, ship: '~zod'}, runtime), /planet name/);
  await assert.rejects(prepare({...base, ship: 'sampel-palnet'}, runtime), /planet name/);
  await assert.rejects(prepare({...base, singleInstanceConfirmed: false}, runtime), /not running anywhere else/);
  await assert.rejects(prepare({...base, root: 'relative'}, runtime), /private folder/);
  assert.equal(fs.existsSync(base.root), false, 'Refusals create nothing');
  fs.mkdirSync(path.join(base.root, 'sampel-palnet'), {recursive: true});
  await assert.rejects(prepare(base, runtime), /already set up here/);
  fs.rmSync(path.join(base.root, 'sampel-palnet'), {recursive: true});
  // With everything else in order, the missing runtime is what stops it: nothing is launched or reserved.
  await assert.rejects(prepare(base, runtime));
  assert.equal(fs.existsSync(path.join(base.root, 'sampel-palnet')), false);
});

test('boot rows follow retained evidence and a stop names the step without a second start', t => {
  const root = workspace(t), write = (name, value) => {fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true}); fs.writeFileSync(path.join(root, name), JSON.stringify(value));};
  assert.equal(status(root).phase, 'not-started'); assert.deepEqual(statuses(status(root)), Array(4).fill('waiting'));
  write('launch-intent.json', {});
  assert.deepEqual(statuses(status(root)), ['running', 'waiting', 'waiting', 'waiting']);
  write('started.json', {pid: 7});
  assert.deepEqual(statuses(status(root)), ['done', 'running', 'waiting', 'waiting']); assert.equal(status(root).phase, 'running');
  write('stopped.json', {});
  let report = status(root);
  assert.equal(report.phase, 'needs-attention'); assert.match(report.stoppedAt, /Waiting for it to come up/); assert.match(report.reason, /not started a second time/);
  fs.rmSync(path.join(root, 'stopped.json'));
  write('base/result.json', {baseExportsVerified: false});
  assert.deepEqual(statuses(status(root)), ['done', 'done', 'running', 'waiting'], 'A mount without verified files is not done');
  write('base/result.json', {baseExportsVerified: true});
  write('result.json', {phase: 'ship-booted-not-installed', identityVerified: true, url: 'http://127.0.0.1:8080'});
  report = status(root);
  assert.equal(report.phase, 'booted'); assert.equal(report.url, 'http://127.0.0.1:8080'); assert.ok(statuses(report).every(value => value === 'done'));
});

test('a port held on every address, or only on loopback, is not offered to a new planet', async t => {
  for (const host of ['0.0.0.0', '127.0.0.1']) {
    const server = net.createServer(); await new Promise(resolve => server.listen({port: 0, host}, resolve));
    const port = server.address().port;
    assert.equal(await tcpFree(port), false, 'held on ' + host);
    await new Promise(resolve => server.close(resolve));
    assert.equal(await tcpFree(port), true, 'released from ' + host);
  }
  t.diagnostic('wildcard and loopback listeners both refused');
});
