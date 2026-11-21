import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {spawnSync} from 'node:child_process';
import {withWriteLock} from '../src/private-lock';
import {RemoteDraftStore} from '../src/remote-draft-store';
import {remoteSourceHash, type RemoteSourceObservation} from '../src/remote-project-view';

function folder(t: {after(fn: () => void): void}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-lock-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true})); return root;
}
/** The id of a process that has ended. */
const gone = () => spawnSync(process.execPath, ['-e', '']).pid;
const old = (file: string) => fs.utimesSync(file, new Date(Date.now() - 11 * 60 * 1000), new Date(Date.now() - 11 * 60 * 1000));

test('a lock is held for the work and gone after it; a lock of a living writer, or one that cannot be judged, is never taken over', t => {
  const directory = folder(t), lock = path.join(directory, '.write.lock');
  assert.equal(withWriteLock(directory, () => {
    assert.match(fs.readFileSync(lock, 'utf8'), new RegExp(`^${process.pid}\\n\\d+\\n$`));
    // A second writer meets the first one's lock and fails at once; the first one's lock is still there.
    assert.throws(() => withWriteLock(directory, () => 'second'), /EEXIST/);
    assert.equal(fs.existsSync(lock), true); return 'first';
  }), 'first');
  assert.equal(fs.existsSync(lock), false);
  assert.throws(() => withWriteLock(directory, () => {throw new Error('work failed');}), /work failed/); assert.equal(fs.existsSync(lock), false);
  // Written by an earlier Readymade (no holder named) and recent; naming this very process; naming a living other process.
  for (const text of ['', `${process.pid}\n1\n`, `${process.ppid}\n1\n`]) {
    fs.writeFileSync(lock, text, {mode: 0o600});
    assert.throws(() => withWriteLock(directory, () => 'x'), /EEXIST/); assert.equal(fs.readFileSync(lock, 'utf8'), text); fs.unlinkSync(lock);
  }
  // Not a plain file: never judged, never removed.
  fs.mkdirSync(lock); assert.throws(() => withWriteLock(directory, () => 'x'), /EEXIST/); fs.rmdirSync(lock);
  fs.writeFileSync(path.join(directory, 'elsewhere'), `${gone()}\n1\n`, {mode: 0o600}); fs.symlinkSync(path.join(directory, 'elsewhere'), lock);
  assert.throws(() => withWriteLock(directory, () => 'x'), /EEXIST/); assert.equal(fs.existsSync(path.join(directory, 'elsewhere')), true); fs.unlinkSync(lock);
});

test('a lock whose holder is gone is taken over: its process ended, or it is older than any stretch of work', t => {
  const directory = folder(t), lock = path.join(directory, '.write.lock');
  fs.writeFileSync(lock, `${gone()}\n${Date.now()}\n`, {mode: 0o600});
  assert.equal(withWriteLock(directory, () => 'after a dead holder'), 'after a dead holder'); assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(lock, '', {mode: 0o600}); old(lock);
  assert.equal(withWriteLock(directory, () => 'after an old lock'), 'after an old lock');
  assert.deepEqual(fs.readdirSync(directory), []);
  // While another process is judging the same lock, this one does not also remove it; a judging file left behind is cleared once old.
  fs.writeFileSync(lock, `${gone()}\n1\n`, {mode: 0o600}); fs.writeFileSync(lock + '.takeover', '', {mode: 0o600});
  assert.throws(() => withWriteLock(directory, () => 'x'), /EEXIST/);
  old(lock + '.takeover'); assert.throws(() => withWriteLock(directory, () => 'x'), /EEXIST/);
  assert.equal(withWriteLock(directory, () => 'cleared'), 'cleared'); assert.deepEqual(fs.readdirSync(directory), []);
});

test('Readymade killed in the middle of a move to history: after restart the move is finished and the store writes again', t => {
  const directory = path.join(folder(t), 'drafts'), text = 'original\n';
  const observed = (request: string): RemoteSourceObservation => ({origin: 'https://peer.example', owner: '~zod', peer: '~nec', project: 'shared', generation: '1', request,
    grant: '0x2', observedAt: '~2026.11.09', root: '0x3', snapshotDigest: '0x4', desk: 'shared', revision: '1', files: [{path: '/lib/a/hoon', text, hash: remoteSourceHash(text)}]});
  const before = new RemoteDraftStore(directory), moving = before.save(before.create(observed('0x1'), '/lib/a/hoon').id, 'being moved\n'), other = before.create(observed('0x2'), '/lib/a/hoon');
  // The process dies after the copy reached history and before the open file was removed: both exist, and its lock is left behind.
  const open = path.join(directory, moving.id + '.json'), bytes = fs.readFileSync(open);
  before.archive(moving.id); fs.writeFileSync(open, bytes, {mode: 0o600});
  fs.writeFileSync(path.join(directory, '.write.lock'), `${gone()}\n${Date.now()}\n`, {mode: 0o600});
  // Restarted.
  const after = new RemoteDraftStore(directory);
  assert.equal(after.get(moving.id).text, 'being moved\n');
  assert.equal(after.save(other.id, 'still writable\n').text, 'still writable\n');
  assert.equal(after.archive(moving.id).text, 'being moved\n');
  assert.equal(fs.existsSync(open), false); assert.equal(after.archived(moving.id)!.text, 'being moved\n');
  assert.equal(after.create(observed('0x3'), '/lib/a/hoon').text, text);
  assert.equal(fs.existsSync(path.join(directory, '.write.lock')), false);
});
