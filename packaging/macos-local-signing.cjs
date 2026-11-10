const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const nativeSource = path.join(__dirname, 'macos-signing.c');
const names = {password: 'password', key: 'identity-key.pem', cert: 'identity-cert.pem', p12: 'identity.p12', native: 'native', keychain: 'readymade-local-signing.keychain-db', manifest: 'manifest.json'};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function refuse(stage) {throw new Error('Readymade local signer refused: ' + stage);}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, ...options});
  if (result.error || result.status !== 0) {
    const nativeStage = path.basename(command) === 'native' && /^([a-z-]+):-?\d+\n$/.test(result.stderr ?? '') ? result.stderr.trim() : '';
    refuse(path.basename(command) + (nativeStage ? ' ' + nativeStage : ''));
  }
  return result.stdout ?? '';
}
function stat(name) {try {return fs.lstatSync(name);} catch (error) {if (error.code === 'ENOENT') return undefined; throw error;}}
function directory(name, mode, create = false) {
  if (!stat(name) && create) fs.mkdirSync(name, {mode});
  const value = stat(name);
  if (!value || !value.isDirectory() || value.isSymbolicLink() || value.uid !== process.getuid() || value.mode & 0o022 || mode === 0o700 && (value.mode & 0o777) !== mode || fs.realpathSync(name) !== name) refuse('private directory');
}
function rootPath(options, create) {
  const home = os.homedir(), parent = path.join(home, 'Library', 'Application Support', 'Readymade');
  const root = options.root ?? path.join(parent, 'Signing');
  if (!path.isAbsolute(root) || path.resolve(root) !== root || /[\x00-\x1f\x7f]/.test(root)) refuse('signer path');
  if (!options.root) {
    for (const name of [home, path.join(home, 'Library'), path.join(home, 'Library', 'Application Support')]) directory(name, 0o755, create);
    if (!stat(parent) && !create) return undefined;
    if (!stat(parent) && create) fs.mkdirSync(parent, {mode: 0o700});
    directory(parent, 0o755);
  } else directory(path.dirname(root), 0o755);
  if (!stat(root) && !create) return undefined;
  directory(root, 0o700, create); return root;
}
function file(name, mode = 0o600) {
  const value = stat(name);
  if (!value || !value.isFile() || value.isSymbolicLink() || value.uid !== process.getuid() || value.nlink !== 1 || (value.mode & 0o777) !== mode) refuse('private file');
  return value;
}
function locked(root, action) {
  const lock = path.join(root, '.prepare-lock');
  try {fs.mkdirSync(lock, {mode: 0o700});} catch {refuse('another signer operation or retained lock');}
  const held = fs.lstatSync(lock);
  try {return action();} finally {
    const current = fs.lstatSync(lock);
    if (current.dev !== held.dev || current.ino !== held.ino) refuse('lock changed');
    fs.rmdirSync(lock);
  }
}
function paths(root) {return Object.fromEntries(Object.entries(names).map(([key, name]) => [key, path.join(root, name)]));}
function passwordFD(name) {file(name); return fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);}
function openssl(args, passwords) {
  const fds = passwords.map(passwordFD);
  try {return run('/usr/bin/openssl', args, {stdio: ['ignore', 'pipe', 'pipe', ...fds]});}
  finally {fds.forEach(fd => fs.closeSync(fd));}
}
function native(p, operation, secret = false) {
  const args = operation === 'create' ? [operation, p.keychain, p.p12] : [operation, p.keychain];
  let bytes;
  try {if (secret) {file(p.password); bytes = fs.readFileSync(p.password);} run(p.native, args, {input: bytes});}
  finally {bytes?.fill(0);}
}
function provision(p) {
  const root = path.dirname(p.manifest), entries = fs.readdirSync(root).filter(name => name !== '.prepare-lock');
  if (entries.length) refuse('partial signer state; preserve it for inspection');
  fs.writeFileSync(p.password, crypto.randomBytes(32).toString('hex') + '\n', {mode: 0o600, flag: 'wx'});
  const cn = 'Readymade Local Signing ' + crypto.randomBytes(12).toString('hex');
  openssl(['req', '-new', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '3650', '-keyout', p.key, '-out', p.cert,
    '-subj', '/CN=' + cn, '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'keyUsage=critical,digitalSignature',
    '-addext', 'extendedKeyUsage=codeSigning', '-passout', 'fd:3'], [p.password]);
  for (const name of [p.key, p.cert]) fs.chmodSync(name, 0o600);
  openssl(['pkcs12', '-export', '-inkey', p.key, '-in', p.cert, '-out', p.p12, '-passin', 'fd:3', '-passout', 'fd:4', '-name', cn], [p.password, p.password]);
  fs.chmodSync(p.p12, 0o600);
  run('/usr/bin/xcrun', ['clang', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations', nativeSource, '-framework', 'Security', '-framework', 'CoreFoundation', '-o', p.native]);
  fs.chmodSync(p.native, 0o700); native(p, 'create', true); file(p.keychain);
  const cert = new crypto.X509Certificate(fs.readFileSync(p.cert));
  const manifest = {format: 1, identity: cert.fingerprint.replaceAll(':', ''), certificateSHA256: cert.fingerprint256.replaceAll(':', ''), nativeSourceSHA256: digest(fs.readFileSync(nativeSource)), files: {}};
  for (const key of ['password', 'key', 'cert', 'p12', 'native']) manifest.files[key] = digest(fs.readFileSync(p[key]));
  fs.writeFileSync(p.manifest, JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
}
function existing(p, unlock) {
  file(p.manifest); const manifest = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
  if (manifest.format !== 1 || !/^[A-F0-9]{40}$/.test(manifest.identity) || manifest.nativeSourceSHA256 !== digest(fs.readFileSync(nativeSource))) refuse('manifest or native source changed');
  for (const key of ['password', 'key', 'cert', 'p12', 'native']) {
    file(p[key], key === 'native' ? 0o700 : 0o600);
    if (!(key === 'password' && !unlock) && manifest.files?.[key] !== digest(fs.readFileSync(p[key]))) refuse('signer file changed');
  }
  file(p.keychain);
  const cert = new crypto.X509Certificate(fs.readFileSync(p.cert));
  if (cert.fingerprint.replaceAll(':', '') !== manifest.identity || cert.fingerprint256.replaceAll(':', '') !== manifest.certificateSHA256 || Date.parse(cert.validTo) <= Date.now()) refuse('certificate continuity');
  if (unlock) {
    const bytes = fs.readFileSync(p.password);
    try {
      if (!/^[a-f0-9]{64}\n$/.test(bytes.toString('ascii'))) refuse('password format');
      const key = crypto.createPrivateKey({key: fs.readFileSync(p.key), passphrase: bytes.subarray(0, 64)});
      if (!cert.checkPrivateKey(key)) refuse('certificate key mismatch');
    } catch {refuse('encrypted signing key');} finally {bytes.fill(0);}
    native(p, 'unlock', true);
    const identities = run('/usr/bin/security', ['find-identity', '-p', 'codesigning', p.keychain]);
    const hashes = new Set([...identities.matchAll(/^\s*\d+\)\s+([A-F0-9]{40})\b/gm)].map(match => match[1]));
    if (hashes.size !== 1 || !hashes.has(manifest.identity)) refuse('keychain identity changed');
  }
  return {identity: manifest.identity, kind: 'local certificate', team: null, keychain: p.keychain};
}
function prepare(root) {
  const p = paths(root); if (!stat(p.manifest)) provision(p);
  return existing(p, true);
}
function owner(options) {
  const pid = options.owner ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) refuse('activation owner');
  const output = run('/bin/ps', ['-p', String(pid), '-o', 'uid=,lstart=']).trim();
  if (!output.startsWith(String(process.getuid()) + ' ')) refuse('activation owner');
  return {pid, start: output};
}
function getLocalSigner(options = {}) {
  if (process.platform !== 'darwin') refuse('macOS required');
  const root = rootPath(options, true); return locked(root, () => prepare(root));
}
function activateLocalSigner(options = {}) {
  const root = rootPath(options, true);
  return locked(root, () => {
    const signer = prepare(root), lock = path.join(root, '.activation-lock'), record = path.join(lock, 'owner.json');
    try {fs.mkdirSync(lock, {mode: 0o700});} catch {refuse('another build owns signing activation');}
    fs.writeFileSync(record, JSON.stringify(owner(options)) + '\n', {mode: 0o600, flag: 'wx'});
    native(paths(root), 'activate'); return signer;
  });
}
function deactivateLocalSigner(options = {}) {
  const root = rootPath(options, false); if (!root) return;
  return locked(root, () => {
    const lock = path.join(root, '.activation-lock');
    if (!stat(lock)) {
      const listed = run('/usr/bin/security', ['list-keychains', '-d', 'user']);
      if (listed.includes(JSON.stringify(paths(root).keychain))) refuse('unowned active signing keychain');
      return;
    }
    directory(lock, 0o700); const record = path.join(lock, 'owner.json'); file(record);
    const held = JSON.parse(fs.readFileSync(record, 'utf8'));
    if (JSON.stringify(held) !== JSON.stringify(owner(options))) refuse('different activation owner');
    existing(paths(root), false); native(paths(root), 'deactivate');
    fs.unlinkSync(record); fs.rmdirSync(lock);
  });
}
if (require.main === module) {
  const action = process.argv[2];
  try {
    if (process.argv.length !== 3 || !['prepare', 'get', 'activate', 'deactivate'].includes(action)) refuse('action');
    const options = {owner: process.ppid};
    const result = action === 'activate' ? activateLocalSigner(options) : action === 'deactivate' ? deactivateLocalSigner(options) : getLocalSigner(options);
    if (result) process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {process.stderr.write((error.message.startsWith('Readymade local signer refused:') ? error.message : 'Readymade local signer refused: private state validation') + '\n'); process.exitCode = 1;}
}
module.exports = {getLocalSigner, activateLocalSigner, deactivateLocalSigner};
