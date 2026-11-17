import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, lstat, realpath, rm, symlink, link, chmod, rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {DownloadCleanup, cleanupPins, cleanupProcessesClear, type CleanupEnvironment} from '../src/ship-storage-cleanup';

const zip = Buffer.from('fixture editor download'), pill = Buffer.from('fixture boot pill');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const metadata = () => ({schema: 'readymade-cache-downloads-v1', editor: {name: 'VSCodium-darwin-arm64-1.2.3.zip', sha256: sha(zip)}, pill: {name: sha(pill) + '.pill', sha256: sha(pill)}});
interface Fixture {home: string; root: string; extension: string; editor: string; pill: string; cleanup: DownloadCleanup; env: CleanupEnvironment}
async function fixture(run: (f: Fixture) => Promise<void>, idle: CleanupEnvironment['idle'] = async () => {}): Promise<void> {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'readymade-cleanup-fixture-'))), root = path.join(home, '.cache/readymade'), extension = path.join(home, 'extension');
  try {
    for (const dir of ['.cache', '.cache/readymade', '.cache/readymade/codeoss-package', '.cache/readymade/pills', '.Trash', 'extension', 'extension/backend', 'extension/backend/runtime'])
      await mkdir(path.join(home, dir), {mode: 0o700});
    const pins = metadata(), editor = path.join(root, 'codeoss-package', pins.editor.name), boot = path.join(root, 'pills', pins.pill.name);
    await writeFile(editor, zip, {mode: 0o600}); await writeFile(boot, pill, {mode: 0o600});
    await writeFile(path.join(extension, 'backend/runtime/cache-downloads.json'), JSON.stringify(pins), {mode: 0o600});
    const env: CleanupEnvironment = {home, uid: process.getuid!(), platform: 'darwin', idle};
    await run({home, root, extension, editor, pill: boot, env, cleanup: new DownloadCleanup(extension, env)});
  } finally {await rm(home, {recursive: true, force: true});}
}

test('pins admit only the two packaged download classes, never runtime or arbitrary paths', () => {
  assert.deepEqual(cleanupPins(metadata()).map(p => p.directory), ['codeoss-package', 'pills']);
  for (const value of [null, {}, {...metadata(), schema: 'unknown'}, {...metadata(), extra: 1},
    {...metadata(), editor: {name: '../Signing/identity.p12', sha256: sha(zip)}},
    {...metadata(), editor: {name: 'urbit', sha256: sha(zip)}},
    {...metadata(), pill: {name: 'other.pill', sha256: sha(pill)}},
    {...metadata(), pill: {...metadata().pill, sha256: '0'.repeat(63)}}]) assert.throws(() => cleanupPins(value));
});

test('an ordinary cached runtime does not block download cleanup; builders and unknown observations do', () => {
  const root = '/fixture/.cache/readymade';
  assert.equal(cleanupProcessesClear(` 12 501 ${root}/runtime/hash/urbit /fixture/pier\n 13 501 Readymade --user-data-dir ${root}/workspace-v02/user\n`, root), true);
  for (const command of ['bash /checkout/package.sh', 'bash "/checkout with spaces/package.sh"',
    `curl --output ${root}/pills/hash.pill`, `ditto ${root}/codeoss-package/editor.zip /fixture/unpacked`])
    assert.equal(cleanupProcessesClear('12 501 ' + command + '\n', root), false);
  for (const output of ['', '\n', 'truncated process output', '12 501', '12 501 /bin/zsh\nbroken line']) assert.equal(cleanupProcessesClear(output, root), false);
});

test('preview is read-only and excludes unknown cache entries and every protected data category', () => fixture(async f => {
  const preserved = ['runtime/urbit', 'workspace-v02/drafts/unsent.json', 'evidence/receipt.json', 'Signing/identity.p12', 'pier/.urb/log/data.mdb', 'codeoss-package/unknown.zip'];
  for (const name of preserved) {await mkdir(path.dirname(path.join(f.root, name)), {recursive: true, mode: 0o700}); await writeFile(path.join(f.root, name), 'preserve', {mode: 0o600});}
  const before = await lstat(f.editor), preview = await f.cleanup.preview();
  assert.equal(preview.items.length, 2); assert.equal(preview.notes.length, 0);
  assert.deepEqual(new Set(preview.items.map(i => i.file)), new Set([f.editor, f.pill]));
  assert.equal((await lstat(f.editor)).ino, before.ino); assert.deepEqual(await readdir(path.join(f.home, '.Trash')), []);
  for (const name of preserved) assert.equal(await readFile(path.join(f.root, name), 'utf8'), 'preserve');
  assert.ok(Object.isFrozen(preview) && Object.isFrozen(preview.items) && Object.isFrozen(preview.items[0]));
}));

test('cancel and unknown IDs cannot move a file; a preview is consumed once', () => fixture(async f => {
  const preview = await f.cleanup.preview(); let asked = 0;
  await assert.rejects(f.cleanup.trash('not-a-preview', async () => {asked++; return true;}));
  assert.equal(await f.cleanup.trash(preview.items[0].id, async () => {asked++; return false;}), undefined);
  await assert.rejects(f.cleanup.trash(preview.items[0].id, async () => true));
  assert.equal(asked, 1); assert.deepEqual(await readFile(f.editor), zip); assert.deepEqual(await readdir(path.join(f.home, '.Trash')), []);
}));

test('one owner-selected fixture moves reversibly with its inode and restore receipt; other files stay', () => fixture(async f => {
  const before = await lstat(f.editor), preview = await f.cleanup.preview();
  const item = preview.items.find(i => i.file === f.editor)!;
  const folder = await f.cleanup.trash(item.id, async p => {assert.equal(p.file, f.editor); assert.equal(p.sha256, sha(zip)); return true;});
  assert.ok(folder?.startsWith(path.join(f.home, '.Trash/Readymade-')));
  await assert.rejects(lstat(f.editor), {code: 'ENOENT'});
  const moved = path.join(folder!, path.basename(f.editor)); assert.deepEqual(await readFile(moved), zip); assert.equal((await lstat(moved)).ino, before.ino);
  const receipt = JSON.parse(await readFile(path.join(folder!, 'restore.json'), 'utf8'));
  assert.equal(receipt.original, f.editor); assert.equal(receipt.destination, moved); assert.equal(receipt.sha256, sha(zip));
  assert.deepEqual(await readFile(f.pill), pill); await assert.rejects(lstat(path.join(f.root, '.package-cache-lock')), {code: 'ENOENT'});
  await assert.rejects(f.cleanup.trash(item.id, async () => true));
  // Restore only this fixture into its absent original location, as the receipt instructs.
  await rename(moved, f.editor); assert.deepEqual(await readFile(f.editor), zip);
}));

test('changed content or replaced inode after preview prevents the move', async () => {
  for (const replace of [false, true]) await fixture(async f => {
    const item = (await f.cleanup.preview()).items.find(i => i.file === f.editor)!;
    await assert.rejects(f.cleanup.trash(item.id, async () => {
      if (replace) {await rename(f.editor, f.editor + '.original'); await writeFile(f.editor, zip, {mode: 0o600});}
      else await writeFile(f.editor, 'changed', {mode: 0o600});
      return true;
    }));
    assert.deepEqual(await readdir(path.join(f.home, '.Trash')), []); await lstat(f.editor);
  });
});

test('symlinks, hardlinks, unsafe permissions and unfinished downloads are not offered', async () => {
  for (const kind of ['symlink', 'hardlink', 'permissions', 'partial', 'ancestor'] as const) await fixture(async f => {
    if (kind === 'symlink') {await rename(f.editor, f.editor + '.original'); await symlink(f.editor + '.original', f.editor);}
    if (kind === 'hardlink') await link(f.editor, f.editor + '.link');
    if (kind === 'permissions') await chmod(f.editor, 0o644);
    if (kind === 'partial') await writeFile(path.join(f.root, 'codeoss-package/.download.retained'), 'unfinished');
    if (kind === 'ancestor') {await rename(path.dirname(f.editor), path.dirname(f.editor) + '-original'); await symlink(path.dirname(f.editor) + '-original', path.dirname(f.editor));}
    const preview = await f.cleanup.preview(); assert.ok(preview.items.every(i => i.file !== f.editor)); assert.ok(preview.notes.length);
    assert.deepEqual(await readdir(path.join(f.home, '.Trash')), []);
  });
});

test('retained builder lock and unknown active work refuse without reclaiming anything', async () => {
  await fixture(async f => {
    const lock = path.join(f.root, '.package-cache-lock'); await mkdir(lock, {mode: 0o700});
    await assert.rejects(f.cleanup.preview(), /lock/); assert.ok((await lstat(lock)).isDirectory());
  });
  await fixture(async f => {await assert.rejects(f.cleanup.preview(), /active/); assert.deepEqual(await readFile(f.editor), zip);}, async () => {throw Error('active work unknown');});
  let active = false;
  await fixture(async f => {
    const item = (await f.cleanup.preview()).items[0]; active = true;
    await assert.rejects(f.cleanup.trash(item.id, async () => true), /active/); await lstat(item.file);
    assert.deepEqual(await readdir(path.join(f.home, '.Trash')), []);
  }, async () => {if (active) throw Error('active builder');});
});

test('missing Trash and a lock acquired after preview do not fall back to permanent removal', async () => {
  for (const kind of ['trash', 'lock']) await fixture(async f => {
    const item = (await f.cleanup.preview()).items[0];
    if (kind === 'trash') await rename(path.join(f.home, '.Trash'), path.join(f.home, 'retained-trash'));
    else await mkdir(path.join(f.root, '.package-cache-lock'), {mode: 0o700});
    await assert.rejects(f.cleanup.trash(item.id, async () => true)); await lstat(item.file);
    if (kind === 'lock') assert.ok((await lstat(path.join(f.root, '.package-cache-lock'))).isDirectory());
  });
});

test('a replaced maintenance lock stops the move and is never removed by the old owner', async () => {
  let replace = false;
  await fixture(async f => {
    const item = (await f.cleanup.preview()).items[0]; replace = true;
    await assert.rejects(f.cleanup.trash(item.id, async () => true), /lock changed/);
    await lstat(item.file); assert.ok((await lstat(path.join(f.root, '.package-cache-lock'))).isDirectory());
    assert.deepEqual(await readdir(path.join(f.home, '.Trash')), []);
  }, async (_files, root) => {
    if (!replace) return; replace = false;
    await rename(path.join(root, '.package-cache-lock'), path.join(root, '.retained-original-lock'));
    await mkdir(path.join(root, '.package-cache-lock'), {mode: 0o700});
  });
});
