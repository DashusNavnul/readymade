const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {getLocalSigner, activateLocalSigner, deactivateLocalSigner} = require('../packaging/macos-local-signing.cjs');
const {verifyIdentity} = require('../packaging/macos-signing.cjs');
const mac = process.platform === 'darwin';
const temporary = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'readymade-signing-'));
function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024});
  assert.equal(result.error, undefined); assert.equal(result.status, 0, path.basename(command) + ' fixture failed'); return result.stdout ?? '';
}
test('local signer refuses unsafe directories, partial state, symlinks and retained locks', {skip: !mac}, () => {
  const parent = temporary(), root = path.join(parent, 'Signing'), options = {root};
  fs.mkdirSync(root, {mode: 0o755});
  fs.chmodSync(root, 0o755);
  assert.throws(() => getLocalSigner(options), /private directory/);
  fs.chmodSync(root, 0o700); fs.writeFileSync(path.join(root, 'password'), 'partial', {mode: 0o600});
  assert.throws(() => getLocalSigner(options), /partial signer state/);
  assert.equal(fs.readFileSync(path.join(root, 'password'), 'utf8'), 'partial');
  const target = path.join(parent, 'target'); fs.mkdirSync(target, {mode: 0o700});
  const linked = path.join(parent, 'linked'); fs.symlinkSync(target, linked);
  assert.throws(() => getLocalSigner({root: linked}), /private directory/);
  const locked = path.join(parent, 'Locked'); fs.mkdirSync(locked, {mode: 0o700}); fs.mkdirSync(path.join(locked, '.prepare-lock'), {mode: 0o700});
  assert.throws(() => getLocalSigner({root: locked}), /retained lock/);
  const absent = path.join(parent, 'Absent'); deactivateLocalSigner({root: absent}); assert.equal(fs.existsSync(absent), false);
});
test('persistent local signer keeps identity and fixture credential access across changed binaries without UI', {skip: !mac, timeout: 120000}, () => {
  const parent = temporary(), root = path.join(parent, 'Signing'), options = {root};
  fs.chmodSync(parent, 0o755);
  const before = run('/usr/bin/security', ['list-keychains', '-d', 'user']);
  const defaultBefore = run('/usr/bin/security', ['default-keychain', '-d', 'user']);
  const first = getLocalSigner(options), again = getLocalSigner(options);
  assert.deepEqual(again, first); assert.equal(first.kind, 'local certificate'); assert.equal(first.team, null);
  assert.match(first.identity, /^[A-F0-9]{40}$/);
  assert.equal(run('/usr/bin/security', ['list-keychains', '-d', 'user']), before);
  assert.equal(run('/usr/bin/security', ['default-keychain', '-d', 'user']), defaultBefore);
  const manifestFile = path.join(root, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  assert.equal(manifest.identity, first.identity); assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  for (const name of ['password', 'identity-key.pem', 'identity-cert.pem', 'identity.p12', 'manifest.json']) assert.equal(fs.statSync(path.join(root, name)).mode & 0o777, 0o600);
  const one = path.join(parent, 'one'), two = path.join(parent, 'two'), negative = path.join(parent, 'negative');
  const fixture = path.join(__dirname, 'fixtures', 'macos-keychain-smoke.c');
  for (const [version, target] of [[1, one], [2, two]]) run('/usr/bin/xcrun', ['clang', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations', '-DBUILD_VERSION=' + version, fixture, '-framework', 'Security', '-framework', 'CoreFoundation', '-o', target]);
  assert.notEqual(crypto.createHash('sha256').update(fs.readFileSync(one)).digest('hex'), crypto.createHash('sha256').update(fs.readFileSync(two)).digest('hex'));
  try {
    assert.deepEqual(activateLocalSigner(options), first);
    assert.throws(() => activateLocalSigner(options), /another build owns/);
    assert.throws(() => deactivateLocalSigner({root, owner: process.ppid}), /different activation owner/);
    assert.ok(run('/usr/bin/security', ['list-keychains', '-d', 'user']).includes(JSON.stringify(first.keychain)));
    const id = 'org.pataphor.readymade.keychain-local-signer-test';
    const requirement = `=designated => certificate leaf = H"${first.identity}" and identifier "${id}"`;
    for (const target of [one, two]) run('/usr/bin/codesign', ['--force', '--sign', first.identity, '--keychain', first.keychain, '--identifier', id, '--requirements', requirement, '--timestamp=none', target]);
    assert.equal(verifyIdentity(one, first), verifyIdentity(two, first));
    assert.throws(() => verifyIdentity(two, {...first, identity: 'A'.repeat(40)}));
    fs.copyFileSync(two, negative); run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', negative]);
  } finally {deactivateLocalSigner(options);}
  assert.equal(run('/usr/bin/security', ['list-keychains', '-d', 'user']), before);
  const service = 'readymade-signing-smoke-' + crypto.randomUUID();
  assert.equal(run(one, [first.keychain, 'create', service]).trim(), 'pass');
  assert.equal(run(one, [first.keychain, 'read', service]).trim(), 'pass');
  assert.equal(run(two, [first.keychain, 'read', service]).trim(), 'pass');
  const refused = spawnSync(negative, [first.keychain, 'read', service], {encoding: 'utf8', timeout: 10000});
  assert.equal(refused.error, undefined); assert.equal(refused.status, 1); assert.equal(refused.stdout.trim(), 'fail');
  const p12 = path.join(root, 'identity.p12'), original = fs.readFileSync(p12);
  try {fs.appendFileSync(p12, 'changed'); assert.throws(() => getLocalSigner(options), /signer file changed/);}
  finally {fs.writeFileSync(p12, original, {mode: 0o600});}
  assert.deepEqual(getLocalSigner(options), first);
  assert.equal(fs.existsSync(path.join(root, '.activation-lock')), false);
  assert.equal(run('/usr/bin/security', ['list-keychains', '-d', 'user']), before);
  assert.equal(run('/usr/bin/security', ['default-keychain', '-d', 'user']), defaultBefore);
});
