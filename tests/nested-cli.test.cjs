const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {patchNestedCli} = require('../platform/nested-cli.cjs');

// The pinned upstream's actual root-discovery and invocation structure.
const upstream = `#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. Licensed under the MIT License.
function app_realpath() {
 SOURCE=$1
 while [ -h "$SOURCE" ]; do
  DIR=$(dirname "$SOURCE")
  SOURCE=$(readlink "$SOURCE")
  [[ $SOURCE != /* ]] && SOURCE=$DIR/$SOURCE
 done
 SOURCE_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
 echo "\${SOURCE_DIR%%\${SOURCE_DIR#*.app}}"
}
APP_PATH="$(app_realpath "\${BASH_SOURCE[0]}")"
CONTENTS="$APP_PATH/Contents"
ELECTRON="$CONTENTS/MacOS/VSCodium"
CLI="$CONTENTS/Resources/app/out/cli.js"
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI" "$@"
exit $?
`;

test('nested CLI finds the inner app, including relative symlink chains and paths containing .app', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-cli-'));
  try {
    const app = path.join(root, 'Projects.app folder', 'Readymade Workspace.app', 'Contents/Resources/VSCodium.app');
    const bin = path.join(app, 'Contents/Resources/app/bin/codium');
    const executable = path.join(app, 'Contents/MacOS/VSCodium');
    fs.mkdirSync(path.dirname(bin), {recursive: true}); fs.mkdirSync(path.dirname(executable), {recursive: true});
    fs.writeFileSync(executable, '#!' + process.execPath + '\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),asNode:process.env.ELECTRON_RUN_AS_NODE}));\n', {mode: 0o700});
    fs.writeFileSync(bin, upstream, {mode: 0o700});
    assert.notEqual(spawnSync(bin, ['--version'], {encoding: 'utf8'}).status, 0, 'Reproduce the upstream failure first');
    fs.writeFileSync(bin, patchNestedCli(upstream));
    const alias = path.join(root, 'readymade'), hop = path.join(root, 'cli link');
    fs.symlinkSync(path.relative(root, bin), hop); fs.symlinkSync('cli link', alias);
    for (const cli of [bin, alias]) {
      const args = ['--wait', 'file with spaces.ts', '--goto', 'colon:name.ts:2:3'];
      const result = spawnSync(cli, args, {encoding: 'utf8'});
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {args: [path.join(fs.realpathSync(app), 'Contents/Resources/app/out/cli.js'), ...args], asNode: '1'});
    }
    assert.ok(patchNestedCli(upstream).includes('# Copyright (c) Microsoft Corporation. Licensed under the MIT License.'));
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('changed upstream discovery and duplicate markers refuse packaging', () => {
  assert.throws(() => patchNestedCli('#!/bin/sh\n'), /Unexpected upstream/);
  assert.throws(() => patchNestedCli(upstream + upstream), /Unexpected upstream/);
  assert.throws(() => patchNestedCli(patchNestedCli(upstream)), /Unexpected upstream/);
});
