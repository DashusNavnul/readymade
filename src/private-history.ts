import * as fs from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';

/**
 * Finished records of one private store, kept for good beside its open ones.
 *
 * A store keeps its open records as `<name>.json` in its own folder, at most 64 of them. This is the folder
 * `history/` inside it: the same files, byte for byte, moved there when their work is finished. Nothing in history
 * is ever sent, changed or counted against the 64; it is what proves, for ever, that a piece of work was already
 * sent. A record is also reachable under a second name (`history/<kind>/<key>.json`, a hard link to the same file),
 * so "was this draft sent in some suggestion?" is one lookup by name and never a read of every record.
 *
 * Moving is safe to interrupt at any point: the record is written to history first and removed from the open
 * folder last, so there is always at least one complete copy, and doing the move again finishes it. A record that
 * is both open and in history is therefore an unfinished move: the open one is the record, and whatever it has
 * become since replaces the copy left in history when the move is done again.
 * Every caller holds the store's own write lock around move() and restore().
 */
const LIMIT = 524288, NAME = /^[a-f0-9]{64}$/;
function missing(error: unknown): boolean {return (error as NodeJS.ErrnoException).code === 'ENOENT';}
function fsyncDirectory(directory: string): void {const fd = fs.openSync(directory, fs.constants.O_RDONLY); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}}
export class RecordHistory {
  readonly directory: string;
  /** `what` names the store in errors, as its own messages do ("Suggestion storage", "Remote draft storage"). */
  constructor(private readonly store: string, private readonly what: string) {this.directory = path.join(store, 'history');}
  private secure(info: fs.Stats, directory = false): void {
    if ((directory ? !info.isDirectory() : !info.isFile()) || info.isSymbolicLink() ||
        process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new Error(`${this.what} must be private and owned by you.`);
  }
  private file(name: string, kind?: string): string {
    if (!NAME.test(name) || kind !== undefined && !/^[a-z-]{1,32}$/.test(kind)) throw new Error(`Invalid ${this.what.toLowerCase()} history name.`);
    return path.join(this.directory, ...(kind ? [kind] : []), name + '.json');
  }
  /** The folder, checked; created private when asked. Undefined when history does not exist yet. */
  private folder(kind?: string, create = false): string | undefined {
    const directory = kind ? path.join(this.directory, kind) : this.directory;
    try {this.secure(fs.lstatSync(directory), true); return directory;}
    catch (error) {if (!missing(error)) throw error;}
    if (!create) return undefined;
    if (kind) this.folder(undefined, true);
    fs.mkdirSync(directory, {mode: 0o700}); this.secure(fs.lstatSync(directory), true);
    return directory;
  }
  private bytes(file: string): Buffer | undefined {
    let fd: number;
    try {fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);} catch (error) {if (missing(error)) return undefined; throw error;}
    try {
      const info = fs.fstatSync(fd); this.secure(info);
      if (info.size > LIMIT) throw new Error(`${this.what} history record exceeds its limit.`);
      return fs.readFileSync(fd);
    } finally {fs.closeSync(fd);}
  }
  /** Is anything held under this name? Whatever sits there counts: a damaged entry still refuses a second send. */
  has(name: string, kind?: string): boolean {
    const file = this.file(name, kind);
    if (!this.folder(kind)) return false;
    try {fs.lstatSync(file); return true;} catch (error) {if (missing(error)) return false; throw error;}
  }
  /** The exact bytes that were moved here, or undefined. */
  read(name: string, kind?: string): Buffer | undefined {
    const file = this.file(name, kind);
    return this.folder(kind) ? this.bytes(file) : undefined;
  }
  /** A whole file or none: written beside its place, then linked in (new) or renamed over a leftover (replace). */
  private write(directory: string, target: string, bytes: Buffer, replace = false): void {
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try {fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    try {if (replace) fs.renameSync(temporary, target); else fs.linkSync(temporary, target);} finally {fs.rmSync(temporary, {force: true});}
  }
  /**
   * Move one open record into history under `name`, reachable also under each `[kind, key]`. The open file is
   * removed last. A copy already in history under the same name is what an interrupted move left: the same bytes
   * are kept as they are, older bytes are replaced by the open record.
   */
  move(name: string, keys: readonly (readonly [string, string])[] = []): void {
    const open = path.join(this.store, name + '.json'), target = this.file(name);
    for (const [kind, key] of keys) this.file(key, kind);
    const bytes = this.bytes(open);
    if (!bytes) throw new Error(`${this.what} record is not open.`);
    const history = this.folder(undefined, true)!, held = this.bytes(target);
    if (!held?.equals(bytes)) this.write(history, target, bytes, held !== undefined);
    for (const [kind, key] of keys) {
      const folder = this.folder(kind, true)!, link = this.file(key, kind), linked = this.bytes(link);
      if (linked && !linked.equals(bytes)) fs.unlinkSync(link);
      if (!linked?.equals(bytes)) fs.linkSync(target, link);
      fsyncDirectory(folder);
    }
    fsyncDirectory(history);
    fs.unlinkSync(open); fsyncDirectory(this.store);
  }
  /**
   * Put one record back among the open ones, byte for byte, and remove it from history last. A record that is
   * already open is the record (see above): only the copy left in history is removed.
   */
  restore(name: string): void {
    const open = path.join(this.store, name + '.json'), target = this.file(name);
    const bytes = this.folder() ? this.bytes(target) : undefined;
    if (!bytes) throw new Error(`${this.what} history does not hold this record.`);
    if (!this.bytes(open)) {this.write(this.store, open, bytes); fsyncDirectory(this.store);}
    fs.unlinkSync(target); fsyncDirectory(this.directory);
  }
  /** Names in history, newest move first, one page at a time. No record is opened to list them. */
  page(offset = 0, limit = 16): {total: number; names: string[]} {
    const directory = this.folder();
    if (!directory) return {total: 0, names: []};
    const rows = fs.readdirSync(directory).filter(n => n.endsWith('.json') && NAME.test(n.slice(0, -5))).map(n => {
      try {return {name: n.slice(0, -5), at: fs.lstatSync(path.join(directory, n)).mtimeMs};} catch (error) {if (missing(error)) return undefined; throw error;}
    }).filter(row => row !== undefined);
    rows.sort((a, b) => b.at - a.at || (a.name < b.name ? -1 : 1));
    return {total: rows.length, names: rows.slice(offset, offset + limit).map(row => row.name)};
  }
}
