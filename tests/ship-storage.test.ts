import test from 'node:test';
import assert from 'node:assert/strict';
import {link, lstat, mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {measureStorage, storageScopes, storageSize, type StorageScope} from '../src/ship-storage';

const scope = (...roots: string[]): StorageScope => ({id: 'test', title: 'Test', roots, note: 'Preserve it.'});
async function directory(t: {after(fn: () => Promise<void>): void}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'readymade-storage-')));
  t.after(() => rm(root, {recursive: true, force: true})); return root;
}

test('inventory names only known roots and separates live data, evidence, journals and rebuildable cache', () => {
  const rows = storageScopes('/piers/ship', '/profile', '/home/user');
  assert.deepEqual(rows.map(row => row.id), ['ship', 'evidence', 'journals', 'builds']);
  assert.deepEqual(rows[0].roots, ['/piers/ship/.urb/chk', '/piers/ship/.urb/log']);
  assert.deepEqual(rows[1].roots, ['/profile/backend-install']);
  assert.ok(rows[2].roots.includes('/profile/drafts'));
  assert.ok(rows[2].roots.includes('/profile/shared-request-claims'));
  assert.ok(rows[3].roots.includes('/home/user/.cache/readymade/runtime'));
  assert.ok(rows.every(row => row.roots.every(root => !/Signing|codes.json|\.key|credentials/.test(root))));
  assert.deepEqual(storageScopes(undefined, undefined, '/home/user')[0].roots, []);
});

test('allocated bytes count sparse files accurately and hard links only once', async t => {
  const root = await directory(t), file = join(root, 'image.bin'), ordinary = join(root, 'record.json');
  await writeFile(file, ''); await truncate(file, 1024 ** 3); await link(file, join(root, 'same-image'));
  await writeFile(ordinary, 'receipt');
  const [image, record] = await Promise.all([lstat(file), lstat(ordinary)]);
  const row = await measureStorage(scope(root));
  assert.equal(row.status, 'complete'); assert.equal(row.files, 2);
  assert.equal(row.logicalBytes, image.size + record.size);
  assert.equal(row.allocatedBytes, (image.blocks + record.blocks) * 512);
  assert.match(storageSize(row), /allocated/); assert.doesNotMatch(storageSize(row), /1.0 GiB/);
});

test('symlink targets and linked ancestors are not traversed', async t => {
  const root = await directory(t), actual = join(root, 'actual'), inspected = join(root, 'inspected');
  await mkdir(actual); await mkdir(inspected); await writeFile(join(actual, 'secret'), 'never read');
  await symlink(actual, join(inspected, 'escape')); await symlink(join(actual, 'secret'), join(inspected, 'file'));
  const row = await measureStorage(scope(inspected));
  assert.equal(row.status, 'partial'); assert.equal(row.files, 0); assert.match(row.note, /linked paths skipped/);
  const ancestor = await measureStorage(scope(join(inspected, 'escape', 'secret')));
  assert.equal(ancestor.status, 'unknown'); assert.equal(ancestor.files, 0);
});

test('entry and depth limits return partial counts without claiming the unvisited files are absent', async t => {
  const root = await directory(t); await mkdir(join(root, 'nested'));
  for (let i = 0; i < 12; i++) await writeFile(join(root, `f${i}`), 'data');
  await writeFile(join(root, 'nested', 'record'), 'data');
  const limited = await measureStorage(scope(root), {entries: 4});
  assert.equal(limited.status, 'partial'); assert.ok(limited.files <= 3); assert.match(storageSize(limited), /At least .*partial scan/);
  const shallow = await measureStorage(scope(root), {depth: 0});
  assert.equal(shallow.status, 'partial'); assert.equal(shallow.files, 0); assert.match(shallow.note, /depth limit reached/);
});

test('missing known paths are empty while unconfigured or invalid scopes stay unknown', async t => {
  const root = await directory(t);
  const absent = await measureStorage(scope(join(root, 'not-created')));
  assert.equal(absent.status, 'complete'); assert.equal(absent.allocatedBytes, 0);
  assert.equal((await measureStorage(scope())).status, 'unknown');
  const invalid = await measureStorage(scope('../outside'));
  assert.equal(invalid.status, 'unknown'); assert.equal(storageSize(invalid), 'Not measured');
});
