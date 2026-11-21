import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * One writer of a private store folder at a time: `.write.lock`, created exclusively and removed when the work is
 * done. Every holder is a short stretch of synchronous file work, so a lock is normally gone within milliseconds,
 * and a second window that meets one fails at once instead of interleaving its write.
 *
 * A lock that outlived its holder (Readymade was killed, or the computer lost power, inside that stretch) used to
 * stop every later write of the store for good. A lock now names its holder, and is taken over when that process
 * no longer exists, or when the lock is more than ten minutes old, which no stretch of work reaches. A lock held
 * by a living process is never taken over.
 */
const STALE_MS = 10 * 60 * 1000;
const CREATE = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW;
function alive(pid: number): boolean {
  try {process.kill(pid, 0); return true;} catch (error) {return (error as NodeJS.ErrnoException).code === 'EPERM';}
}
/** Is this lock left by a holder that is gone? Anything that is not a plain file of ours is never judged stale. */
function stale(file: string): boolean {
  let fd: number;
  try {fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);} catch {return false;}
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || process.getuid && info.uid !== process.getuid()) return false;
    if (Date.now() - info.mtimeMs > STALE_MS) return true;
    const pid = /^(\d{1,10})\n/.exec(fs.readFileSync(fd, 'utf8').slice(0, 64))?.[1];
    return pid !== undefined && Number(pid) !== process.pid && !alive(Number(pid));
  } catch {return false;} finally {fs.closeSync(fd);}
}
/**
 * Remove a lock whose holder is gone. Only one process judges and removes at a time (a second file, held for the
 * moment of judging), so a lock another process has just taken afresh is never removed in place of the stale one.
 */
function takeOver(directory: string, file: string): boolean {
  const judging = path.join(directory, '.write.lock.takeover');
  let fd: number;
  try {fd = fs.openSync(judging, CREATE, 0o600);}
  catch {
    // Someone else is judging right now. A judging file left by a process that died there is removed once it is old.
    try {if (Date.now() - fs.lstatSync(judging).mtimeMs > STALE_MS) fs.unlinkSync(judging);} catch { /* gone, or not ours to remove */ }
    return false;
  }
  try {if (!stale(file)) return false; fs.unlinkSync(file); return true;}
  catch {return false;}
  finally {fs.closeSync(fd); try {fs.unlinkSync(judging);} catch { /* already gone */ }}
}
/** Run `work` as the only writer of `directory`. Throws the lock's EEXIST when a living writer holds it. */
export function withWriteLock<T>(directory: string, work: () => T): T {
  const file = path.join(directory, '.write.lock');
  let fd: number;
  try {fd = fs.openSync(file, CREATE, 0o600);}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !takeOver(directory, file)) throw error;
    fd = fs.openSync(file, CREATE, 0o600);      // Another process may have taken it meanwhile: then this fails like any held lock.
  }
  const held = fs.fstatSync(fd);
  try {fs.writeSync(fd, `${process.pid}\n${Date.now()}\n`); return work();}
  finally {
    fs.closeSync(fd);
    try {const now = fs.lstatSync(file); if (now.ino === held.ino && now.dev === held.dev) fs.unlinkSync(file);} catch { /* already gone */ }
  }
}
