'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const {prepare, launch, argumentsFor} = require('../backend/install/boot-local.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const host = process.platform === 'darwin' && process.arch === 'arm64';
function jam(noun) {
  const bits = [], put = (n, count) => {for (let i = 0; i < count; i++) bits.push(Number((n >> BigInt(i)) & 1n));};
  const mat = n => {if (!n) {bits.push(1); return;} const width = n.toString(2).length, size = width.toString(2).length; bits.push(...Array(size).fill(0), 1); put(BigInt(width), size - 1); put(n, width);};
  const write = n => {if (Array.isArray(n)) {bits.push(1, 0); write(n[0]); write(n[1]);} else {bits.push(0); mat(n);}};
  write(noun); const data = Buffer.alloc(Math.ceil(bits.length / 8)); bits.forEach((b, i) => {data[i >> 3] |= b << (i % 8);}); return data;
}
function uw(data) {
  let n = BigInt('0x' + Buffer.from(data).reverse().toString('hex')), s = ''; const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-~';
  do {s = alphabet[Number(n & 63n)] + s; n >>= 6n;} while (n); return '0w' + s.replace(/\B(?=(.{5})+(?!.))/g, '.');
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'planet-boot-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true})); fs.chmodSync(root, 0o700);
  const data = jam([65536n, 0n]), frame = Buffer.alloc(5 + data.length); frame.writeUInt32LE(data.length, 1); data.copy(frame, 5);
  const vere = path.join(root, 'vere-fixture');
  // Only the public-name parsing subprocess is simulated. No ship is launched.
  fs.writeFileSync(vere, '#!' + process.execPath + '\nprocess.stdin.resume();process.stdin.on("end",()=>{if(process.argv.slice(2).join(" ")!=="eval -jn")process.exit(91);process.stdout.write(Buffer.from("' + frame.toString('hex') + '","hex"));});\n', {mode: 0o700});
  const pill = path.join(root, 'pill'), keyfile = path.join(root, 'download.key');
  fs.writeFileSync(pill, 'synthetic-pill-not-a-real-bootstrap', {mode: 0o600});
  const key = Buffer.from(uw(jam([65536n, [1n, [42n, 0n]]])) + '\n'); fs.writeFileSync(keyfile, key, {mode: 0o600});
  const options = {ship: '~dashus-navnul', pier: path.join(root, 'pier'), vere, pill, keyfile, output: path.join(root, 'boot'), httpPort: 18779, amesPort: 31779,
    runtimeSHA256: sha(fs.readFileSync(vere)), pillSHA256: sha(fs.readFileSync(pill)), singleInstanceConfirmed: true};
  return {root, options, key};
}
test('real planet arguments use key file and loopback HTTP, without fake/local/daemon/inline secrets', () => {
  const args = argumentsFor({ship: '~dashus-navnul', keyfile: '/private/network.key', pier: '/new/pier', pill: '/private/pill', httpPort: 18801, amesPort: 31339});
  assert.deepEqual(args, ['--name', 'dashus-navnul', '--key-file', '/private/network.key', '--pier', '/new/pier', '--bootstrap', '/private/pill', '--loom', '33', '--http-ip', '127.0.0.1', '--http-port', '18801', '--ames-port', '31339', '--no-tty']);
  for (const flag of ['-F', '--fake', '-L', '--local', '-G', '--key-string', '-d', '--daemon']) assert.ok(!args.includes(flag));
});
test('prepares private exact key copy and public metadata only; does not boot a pier', {skip: !host}, t => {
  const f = fixture(t), result = prepare(f.options), saved = JSON.parse(fs.readFileSync(f.options.output + '/plan.json'));
  assert.equal(result.phase, 'boot-prepared'); assert.equal(result.ready, false); assert.equal(result.digest, saved.digest);
  assert.ok(!fs.existsSync(f.options.pier)); assert.ok(!fs.existsSync(saved.plan.reservation)); assert.ok(!fs.existsSync(f.options.output + '/launch-intent.json'));
  assert.deepEqual(fs.readFileSync(saved.plan.keyfile), f.key); assert.equal(fs.statSync(saved.plan.keyfile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.options.output).mode & 0o777, 0o700); assert.equal(fs.statSync(f.options.output + '/plan.json').mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(result).includes(f.key.toString().trim())); assert.ok(!JSON.stringify(result).includes(saved.plan.keySHA256));
  assert.throws(() => prepare(f.options), /new destination/);
});
test('same planet reserves one per-user identity across independent pier folders', {skip: !host}, t => {
  const a = fixture(t), b = fixture(t); prepare(a.options); prepare(b.options);
  const left = JSON.parse(fs.readFileSync(a.options.output + '/plan.json')).plan;
  const right = JSON.parse(fs.readFileSync(b.options.output + '/plan.json')).plan;
  assert.notEqual(left.pier, right.pier); assert.equal(left.reservation, right.reservation);
  assert.equal(left.reservation, path.join(os.userInfo().homedir, '.cache/readymade/local-planet-boots/dashus-navnul'));
  assert.ok(!fs.existsSync(left.pier)); assert.ok(!fs.existsSync(right.pier));
});
test('single-instance confirmation, literal identity, digest and unsafe paths refuse before effects', {skip: !host}, t => {
  const f = fixture(t);
  for (const change of [{singleInstanceConfirmed: false}, {ship: '~dashus-navnul\n'}, {httpPort: 1}, {amesPort: '31339'}, {runtimeSHA256: 'f'.repeat(64)}, {pillSHA256: 'f'.repeat(64)}, {extra: true}]) {
    assert.throws(() => prepare({...f.options, ...change})); assert.ok(!fs.existsSync(f.options.output)); assert.ok(!fs.existsSync(f.options.pier));
  }
  fs.symlinkSync(f.options.keyfile, f.root + '/linked.key'); assert.throws(() => prepare({...f.options, keyfile: f.root + '/linked.key'}), /Linked/);
  fs.chmodSync(f.options.keyfile, 0o644); assert.throws(() => prepare(f.options), /Private/); assert.ok(!fs.existsSync(f.options.output));
});
test('malformed and wrong-identity secrets never reach a boot process or exception', {skip: !host}, t => {
  const f = fixture(t), sentinel = 'PRIVATE_SENTINEL_NOT_IN_ERRORS';
  for (const bytes of [Buffer.from(sentinel), Buffer.from(uw(jam([65537n, [1n, [42n, 0n]]])))]) {
    fs.writeFileSync(f.options.keyfile, bytes);
    assert.throws(() => prepare(f.options), error => !String(error.stack).includes(sentinel) && !String(error.stack).includes(bytes.toString()));
    assert.ok(!fs.existsSync(f.options.output)); assert.ok(!fs.existsSync(f.options.pier));
  }
});
test('unapproved, altered or previously attempted plans cannot launch', {skip: !host}, async t => {
  const f = fixture(t), result = prepare(f.options);
  await assert.rejects(launch(f.options.output, '0'.repeat(64)), /approval/);
  fs.appendFileSync(f.options.vere, '\n'); await assert.rejects(launch(f.options.output, result.digest), /changed/);
  assert.ok(!fs.existsSync(f.options.output + '/launch-intent.json')); assert.ok(!fs.existsSync(f.options.pier));
  fs.writeFileSync(f.options.output + '/launch-intent.json', '{}', {mode: 0o600});
  await assert.rejects(launch(f.options.output, result.digest), /already attempted/); assert.ok(!fs.existsSync(f.options.pier));
});
test('occupied HTTP port refuses before reservation or launch intent', {skip: !host}, async t => {
  const f = fixture(t), server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve))); f.options.httpPort = server.address().port;
  const result = prepare(f.options); await assert.rejects(launch(f.options.output, result.digest), /EADDRINUSE/);
  const saved = JSON.parse(fs.readFileSync(f.options.output + '/plan.json'));
  assert.ok(!fs.existsSync(saved.plan.reservation)); assert.ok(!fs.existsSync(f.options.output + '/launch-intent.json')); assert.ok(!fs.existsSync(f.options.pier));
});
