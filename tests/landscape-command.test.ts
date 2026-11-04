import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLandscapeCommand } from '../src/landscape-command';

const execute = promisify(execFile), URI = 'vscodium://pataphor.readymade-ship-workspace/landscape';
async function fixture(run: (paths: { root: string; cli: string; userData: string; directory: string; output: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "readymade landscape's "));
  const cli = join(root, "CLI's executable"), userData = join(root, "profile's data"), directory = join(root, "storage's directory"), output = join(root, 'captured.json');
  try {
    await mkdir(userData, { mode: 0o700 });
    await writeFile(cli, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$LANDSCAPE_TEST_OUTPUT"\n', { mode: 0o700 });
    await run({ root, cli, userData, directory, output });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('Landscape executable quotes spaced/apostrophe paths and targets the explicit profile once', async () => {
  await fixture(async ({ cli, userData, directory, output }) => {
    const bin = await installLandscapeCommand(directory, cli, userData, URI), command = join(bin, 'landscape');
    assert.equal(bin, join(directory, 'terminal-bin'));
    assert.equal((await lstat(command)).mode & 0o777, 0o700); assert.equal((await lstat(bin)).mode & 0o777, 0o700);
    await execute(command, [], { env: { ...process.env, LANDSCAPE_TEST_OUTPUT: output } });
    assert.deepEqual((await readFile(output, 'utf8')).trimEnd().split('\n'), ['--user-data-dir', userData, '--open-url', URI]);
    const original = await readFile(command, 'utf8');
    assert.equal(await installLandscapeCommand(directory, cli, userData, URI), bin);
    assert.equal(await readFile(command, 'utf8'), original);
    await assert.rejects(execute(command, ['unexpected'], { env: { ...process.env, LANDSCAPE_TEST_OUTPUT: output } }), error => {
      assert.equal((error as { code: number }).code, 2); assert.match((error as { stderr: string }).stderr, /Usage: landscape/); return true;
    });
    assert.deepEqual((await readFile(output, 'utf8')).trimEnd().split('\n'), ['--user-data-dir', userData, '--open-url', URI]);
    const nextURI = 'readymade://pataphor.readymade-ship-workspace/landscape';
    await installLandscapeCommand(directory, cli, userData, nextURI);
    await execute(command, [], { env: { ...process.env, LANDSCAPE_TEST_OUTPUT: output } });
    assert.equal((await readFile(output, 'utf8')).trimEnd().split('\n').at(-1), nextURI);
  });
});

test('Landscape installer preserves foreign commands and refuses symlink files/directories', async () => {
  await fixture(async ({ root, cli, userData, directory }) => {
    await mkdir(directory, { mode: 0o700 }); const bin = join(directory, 'terminal-bin'); await mkdir(bin, { mode: 0o700 });
    const command = join(bin, 'landscape'); await writeFile(command, '#!/bin/sh\nexit 9\n', { mode: 0o700 });
    await assert.rejects(installLandscapeCommand(directory, cli, userData, URI)); assert.equal(await readFile(command, 'utf8'), '#!/bin/sh\nexit 9\n');
    await rm(command); await symlink(cli, command); await assert.rejects(installLandscapeCommand(directory, cli, userData, URI));
    await rm(command); await rm(bin, { recursive: true }); await symlink(userData, bin);
    await assert.rejects(installLandscapeCommand(directory, cli, userData, URI));
    const linkedCLI = join(root, 'linked-cli'); await symlink(cli, linkedCLI);
    await assert.rejects(installLandscapeCommand(directory, linkedCLI, userData, URI));
    const linkedProfile = join(root, 'linked-profile'); await symlink(userData, linkedProfile);
    await assert.rejects(installLandscapeCommand(directory, cli, linkedProfile, URI));
    const linkedStorage = join(root, 'linked-storage'); await symlink(directory, linkedStorage);
    await assert.rejects(installLandscapeCommand(linkedStorage, cli, userData, URI));
  });
});

test('Landscape installer rejects nonprivate profiles/storage, relative paths and control characters', async () => {
  await fixture(async ({ cli, userData, directory }) => {
    await chmod(userData, 0o755); await assert.rejects(installLandscapeCommand(directory, cli, userData, URI)); await chmod(userData, 0o700);
    await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o755);
    await assert.rejects(installLandscapeCommand(directory, cli, userData, URI)); await chmod(directory, 0o700);
    for (const args of [[directory, 'relative-cli', userData, URI], [directory, cli, 'relative-profile', URI],
      [directory + '\n', cli, userData, URI], [directory, cli + '\0', userData, URI], [directory, cli, userData, URI + '\n'],
      [directory, cli, userData, 'https://example.test/landscape'], [directory, cli, userData, URI + '?other=app']])
      await assert.rejects(installLandscapeCommand(...args as [string, string, string, string]));
    await chmod(cli, 0o777); await assert.rejects(installLandscapeCommand(directory, cli, userData, URI));
  });
});
