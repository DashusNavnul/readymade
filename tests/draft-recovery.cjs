#!/usr/bin/env node
'use strict';
// Two normal launches, one private profile. No ship connection or process signal.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {createHash} = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function main() {
  const args = process.argv.slice(2), options = {};
  assert.equal(args.length, 8, 'Supply --code CLI --extension BUNDLED_EXTENSION --snapshot JSON --output NEW_DIRECTORY');
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--code', '--extension', '--snapshot', '--output'].includes(args[i]) && !options[args[i]] && args[i + 1]);
    options[args[i]] = path.resolve(args[i + 1]);
  }
  const code = fs.realpathSync(options['--code']), extension = fs.realpathSync(options['--extension']);
  const snapshotBytes = fs.readFileSync(options['--snapshot']), snapshot = JSON.parse(snapshotBytes);
  const root = options['--output']; fs.mkdirSync(root, {mode: 0o700});
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  for (const name of ['user', 'user/User', 'extensions', 'extensions/readymade-test.draft-recovery-driver-0.0.1']) fs.mkdirSync(path.join(root, name), {mode: 0o700});
  const driver = 'extensions/readymade-test.draft-recovery-driver-0.0.1';
  const driverBytes = fs.readFileSync(path.join(__dirname, 'draft-recovery-driver.cjs'));
  fs.writeFileSync(path.join(root, driver, 'index.cjs'), driverBytes, {flag: 'wx', mode: 0o600});
  write(driver + '/package.json', {name: 'draft-recovery-driver', publisher: 'readymade-test', version: '0.0.1',
    engines: {vscode: '^1.143.0'}, main: 'index.cjs', activationEvents: ['onStartupFinished']});
  write('user/User/settings.json', {'update.mode': 'none', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false,
    'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'window.restoreWindows': 'all'});
  write('plan.json', {code, extension, snapshotSHA256: hash(snapshotBytes), driverSHA256: hash(driverBytes),
    scope: 'Normal quit/reopen and unsaved recovery only; no crash, disk-loss or ship-reconnect claim.'});
  write('config.json', {stage: 'write', snapshot, extension});
  async function launch(stage) {
    const fd = fs.openSync(path.join(root, stage + '.log'), 'wx', 0o600);
    try {
      const exit = await new Promise((resolve, reject) => {
        const child = spawn(code, ['--verbose', ...(stage === 'write' ? ['--new-window'] : []),
          '--user-data-dir', path.join(root, 'user'), '--extensions-dir', path.join(root, 'extensions'),
          '--enable-proposed-api', 'pataphor.readymade-ship-workspace', '--skip-welcome', '--skip-release-notes',
          '--disable-workspace-trust', '--disable-telemetry', '--use-inmemory-secretstorage'], {stdio: ['ignore', fd, fd]});
        child.on('error', reject); child.on('close', (code, signal) => resolve({code, signal}));
      });
      write(stage + '-exit.json', exit); assert.deepEqual(exit, {code: 0, signal: null});
    } finally {fs.closeSync(fd);}
    assert.equal(fs.existsSync(path.join(root, 'failure-' + stage + '.json')), false, 'Inspect retained failure receipt');
  }
  await launch('write'); assert.ok(fs.existsSync(path.join(root, 'before.json')));
  fs.renameSync(path.join(root, 'config.json'), path.join(root, 'config-write.json'));
  write('config.json', {stage: 'read', snapshot, extension});
  await launch('read');
  const result = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8')); assert.equal(result.passed, true);
  console.log(JSON.stringify({passed: true, evidence: root, scope: 'Unsaved draft survived normal offline app restart'}));
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
