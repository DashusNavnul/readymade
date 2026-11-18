// Runs the unit tests with a temp folder of their own and removes it afterwards. Each run used to leave about ten
// folders behind in the system temp folder (1,930 of them, 278 MB, by 2026-11-17). It lives under /tmp, not under
// the per-user temp folder: some tests put Unix sockets and whole pier paths under it, a socket path may be at most
// 104 bytes, and 35 tests failed with 'path is too long' when the folder was nested one level deeper than usual.
'use strict';
const {spawnSync} = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const own = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === 'win32' ? os.tmpdir() : '/tmp'), 'rmt-'));
let status = 1;
try {
  status = spawnSync('node --test dist/tests/*.test.js tests/*.test.cjs', {shell: true, stdio: 'inherit', env: {...process.env, TMPDIR: own}}).status ?? 1;
} finally {
  fs.rmSync(own, {recursive: true, force: true});
}
process.exit(status);
