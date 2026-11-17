const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function directory(file, privateMode) {
  const info = fs.lstatSync(file);
  if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid() ||
      (info.mode & (privateMode ? 0o077 : 0o022))) throw Error('Host evidence directory must be owned, unlinked and safely permissioned');
}
function createRun(root = path.join(os.homedir(), '.readymade-test-evidence')) {
  if (!path.isAbsolute(root) || path.normalize(root) !== root) throw Error('Host evidence root must be an absolute normalized path');
  directory(path.dirname(root), false);
  try { fs.mkdirSync(root, {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  directory(root, true);
  const run = fs.mkdtempSync(path.join(fs.realpathSync(root), 'host-'));
  fs.chmodSync(run, 0o700);
  fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({started: new Date().toISOString(),
    scope: 'Host test process evidence; exit status alone is not acceptance', automaticallyDeleted: false}, null, 2), {flag: 'wx', mode: 0o600});
  return run;
}
function finish(run, code) {
  directory(run, true);
  if (!Number.isInteger(code) || code < 0 || code > 255) throw Error('Invalid host exit status');
  const fd = fs.openSync(path.join(run, 'exit.json'), 'wx', 0o600);
  // The editor profile a passing run leaves in `user` is about 17 MB and is not evidence: the result and the logs
  // are. It is removed after a pass (a few hundred runs had filled the disk); a failed run keeps it for diagnosis,
  // and READYMADE_KEEP_TEST_PROFILE=1 keeps it always. Only this run's own unlinked `user` folder is ever removed.
  const profile = path.join(run, 'user');
  let profileRemoved = false;
  if (code === 0 && process.env.READYMADE_KEEP_TEST_PROFILE !== '1') {
    const info = fs.lstatSync(profile, {throwIfNoEntry: false});
    if (info?.isDirectory() && !info.isSymbolicLink()) { fs.rmSync(profile, {recursive: true, force: true}); profileRemoved = true; }
  }
  try { fs.writeFileSync(fd, JSON.stringify({ended: new Date().toISOString(), exitCode: code, profileRemoved,
    scope: 'Runner exit; inspect result.json and logs for test acceptance'}, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
if (require.main === module) {
  if (process.argv[2] === 'create' && process.argv.length <= 4) console.log(createRun(process.argv[3]));
  else if (process.argv[2] === 'finish' && process.argv.length === 5) finish(process.argv[3], Number(process.argv[4]));
  else throw Error('Expected create [ROOT] or finish RUN EXIT_CODE');
}
module.exports = {createRun, finish};
