import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {dateAtom} from './editing-activity';
import {remoteProjectViewSelector, remoteShip, remoteSourceHash, type RemoteSourceObservation} from './remote-project-view';
import {asRecord, type JsonObject} from './protocol';
import {RecordHistory} from './private-history';
import {withWriteLock} from './private-lock';

export interface RemoteDraftRecord {
  readonly id: string; readonly uri: string; readonly originalUri: string;
  readonly observation: RemoteSourceObservation; readonly path: string;
  readonly text: string; readonly updatedAt: number;
}
interface Saved extends RemoteDraftRecord {readonly version: 1}
const LIMIT = 524288, CAPACITY = 64;
/** The 64 are the drafts open at once, not a lifetime total: a finished draft moves to history and stays readable there. */
const FULL = '64 remote drafts are open. Move finished drafts to history to make room; nothing was discarded.';
const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes));
function invalid(): never {throw new Error('Invalid remote draft or source provenance.');}
function exact(value: unknown, keys: string[]): JsonObject {
  const r = asRecord(value);
  if (Object.keys(r).length !== keys.length || !keys.every(k => Object.hasOwn(r, k))) invalid();
  return r;
}
function copy<T>(value: T): T {return JSON.parse(JSON.stringify(value)) as T;}
function ux(value: unknown, zero = false): value is string {
  if (typeof value !== 'string' || value.length > 82 || !/^0x(?:0|[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*)$/.test(value)) return false;
  const n = BigInt(value.replaceAll('.', '')); return (zero || n > 0n) && n < (1n << 256n);
}
function editable(value: unknown): value is string {
  return typeof value === 'string' && !/[^\t\n\r\x20-\x7e]/.test(value) && Buffer.byteLength(value) <= 32768;
}
/** Retained provenance is evidence of a past read, never current permission. */
function observation(value: unknown): RemoteSourceObservation {
  const r = exact(value, ['owner', 'project', 'generation', 'request', 'origin', 'peer', 'grant', 'observedAt', 'root', 'snapshotDigest', 'desk', 'revision', 'files']);
  const key = remoteProjectViewSelector({owner: r.owner, project: r.project, generation: r.generation, request: r.request});
  if (typeof r.origin !== 'string' || r.origin.length > 2048) invalid();
  const url = new URL(r.origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== r.origin || !remoteShip(r.peer) || r.peer === key.owner ||
      !ux(r.grant) || !ux(r.root) || !ux(r.snapshotDigest, true) || typeof r.desk !== 'string' || !/^[a-z0-9-]{1,63}$/.test(r.desk) ||
      typeof r.revision !== 'string' || r.revision.length > 26 || !/^[1-9][0-9]{0,2}(?:\.[0-9]{3})*$/.test(r.revision) ||
      BigInt(r.revision.replaceAll('.', '')) >= (1n << 64n) || !Array.isArray(r.files) || !r.files.length || r.files.length > 8) invalid();
  dateAtom(r.observedAt);
  const paths = new Set<string>(); let bytes = 0;
  const files = r.files.map(value => {
    const f = exact(value, ['path', 'text', 'hash']);
    if (typeof f.path !== 'string' || !/^\/(?:app|lib|ted)\/(?:[a-z0-9-]{1,63}\/){1,6}hoon$/.test(f.path) || paths.has(f.path) ||
        !editable(f.text) || !ux(f.hash, true) || f.hash !== remoteSourceHash(f.text)) invalid();
    paths.add(f.path); bytes += Buffer.byteLength(f.text);
    return {path: f.path, text: f.text, hash: f.hash};
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (bytes > 65536) invalid();
  return {...key, origin: r.origin, peer: r.peer, grant: r.grant, observedAt: r.observedAt as string,
    root: r.root, snapshotDigest: r.snapshotDigest, desk: r.desk, revision: r.revision, files};
}
function identity(source: RemoteSourceObservation, file: string): string {
  return createHash('sha256').update(JSON.stringify([source, file])).digest('hex');
}
function saved(value: unknown): Saved {
  const r = exact(value, ['version', 'id', 'uri', 'originalUri', 'observation', 'path', 'text', 'updatedAt']);
  const source = observation(r.observation);
  if (r.version !== 1 || typeof r.path !== 'string' || !source.files.some(f => f.path === r.path) || !editable(r.text) ||
      !Number.isSafeInteger(r.updatedAt) || (r.updatedAt as number) < 0) invalid();
  const id = identity(source, r.path);
  if (r.id !== id || r.uri !== `readymade-remote-draft:/${id}${r.path}` || r.originalUri !== `readymade-remote-original:/${id}${r.path}`) invalid();
  return {version: 1, id, uri: r.uri, originalUri: r.originalUri, observation: source, path: r.path, text: r.text, updatedAt: r.updatedAt as number};
}
/** Validates a retained draft without creating or changing private storage. */
export function remoteDraftRecord(value: unknown): RemoteDraftRecord {
  const row = asRecord(value);
  if (row.version !== undefined && row.version !== 1) invalid();
  return copy(saved({...row, version: 1}));
}
function exists(file: string): boolean {
  try {fs.lstatSync(file); return true;} catch (e) {if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e;}
}
function secure(info: fs.Stats, directory = false): void {
  if ((directory ? !info.isDirectory() : !info.isFile()) || info.isSymbolicLink() ||
      process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new Error('Remote draft storage must be private and owned by you.');
}
function read(file: string): Buffer {
  secure(fs.lstatSync(file)); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {const info = fs.fstatSync(fd); secure(info); if (info.size > LIMIT) invalid(); return fs.readFileSync(fd);}
  finally {fs.closeSync(fd);}
}

/** Local edits only: no ship calls, implicit consent, sessions or invented commits. */
export class RemoteDraftStore {
  private readonly records = new Map<string, Saved>();
  private readonly baselines = new Map<string, Buffer>();
  private readonly history: RecordHistory;
  /** New draft -> the draft it was reconciled from. Informational: it sends nothing and permits nothing. */
  private lineage = new Map<string, string>();
  constructor(readonly directory: string) {
    this.history = new RecordHistory(directory, 'Remote draft storage');
    if (!exists(directory)) return;
    secure(fs.lstatSync(directory), true);
    const names = this.names();
    if (names.length > CAPACITY) throw new Error('Remote draft capacity exceeded.');
    for (const name of names) {
      const bytes = read(path.join(directory, name));
      const row = saved(decode(bytes));
      if (name !== `${row.id}.json`) invalid();
      this.records.set(row.id, row); this.baselines.set(row.id, bytes);
    }
    this.lineage = this.links();
  }
  private links(): Map<string, string> {
    const file = path.join(this.directory, 'lineage.json');
    if (!exists(file)) return new Map();
    const value = asRecord(decode(read(file))), hex = /^[a-f0-9]{64}$/;
    if (Object.entries(value).some(([id, from]) => !hex.test(id) || typeof from !== 'string' || !hex.test(from))) invalid();
    return new Map(Object.entries(value) as [string, string][]);
  }
  /**
   * Record that draft `id` continues draft `from`: it was made by reconciling it onto newer shared files. Written
   * once per new draft and kept beside the drafts, so a suggestion sent from the new draft can be traced to the work
   * it replaces. The newest 4,096 links are kept.
   */
  continues(id: string, from: string): void {
    if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{64}$/.test(from) || id === from) invalid();
    this.locked(() => {
      const held = this.links();              // Another window may have added links since this one read them.
      if (!held.has(id)) held.set(id, from);
      const kept = new Map([...held].slice(-4096)), temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
      const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      try {fs.writeFileSync(fd, JSON.stringify(Object.fromEntries(kept))); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      try {fs.renameSync(temporary, path.join(this.directory, 'lineage.json'));} finally {fs.rmSync(temporary, {force: true});}
      const dir = fs.openSync(this.directory, fs.constants.O_RDONLY); try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}
      this.lineage = kept;
    });
  }
  /** The draft this one continues, if it was made by reconciling another. */
  continued(id: string): string | undefined {return this.lineage.get(id);}
  private names(): string[] {return fs.readdirSync(this.directory).filter(n => /^[a-f0-9]{64}\.json$/.test(n));}
  /**
   * What other windows did since this one last looked. A draft they moved to history leaves this window's list; a
   * draft they created or restored joins it. A draft both hold is left as this window read it: a stale copy is
   * caught when it is saved. Names only are read, and the files of drafts new to this window.
   */
  private refresh(): void {
    if (!exists(this.directory)) return;
    const names = new Set(this.names().map(name => name.slice(0, -5)));
    for (const id of [...this.records.keys()]) if (!names.has(id)) {this.records.delete(id); this.baselines.delete(id);}
    for (const id of names) if (!this.records.has(id)) {
      try {
        const bytes = read(path.join(this.directory, `${id}.json`)), row = saved(decode(bytes));
        if (row.id === id) {this.records.set(id, row); this.baselines.set(id, bytes);}
      } catch { /* Not a draft this window can show; opening the store afresh reports it. */ }
    }
  }
  private current(value: string): Saved {
    this.refresh();
    const row = this.records.get(value) ?? [...this.records.values()].find(r => r.uri === value || r.originalUri === value);
    if (row) return row;
    const id = /^[a-f0-9]{64}$/.test(value) ? value : /^readymade-remote-(?:draft|original):\/([a-f0-9]{64})\//.exec(value)?.[1];
    throw new Error(id && this.history.has(id) ? 'This draft was moved to history. Restore it from Shared Work History before editing.' : 'Unknown remote draft.');
  }
  get(value: string): RemoteDraftRecord {return copy(this.current(value));}
  list(): readonly RemoteDraftRecord[] {this.refresh(); return [...this.records.values()].map(copy);}
  /** Is a draft of this file of this read already open? Then opening it again needs no room. */
  opened(value: RemoteSourceObservation, file: string): boolean {this.refresh(); return this.records.has(identity(observation(value), file));}
  create(value: RemoteSourceObservation, file: string): RemoteDraftRecord {
    const source = observation(value), original = source.files.find(f => f.path === file);
    if (!original) invalid();
    this.refresh();
    const id = identity(source, file), old = this.records.get(id);
    if (old) return copy(old);
    // The same file of the same read was drafted before and moved to history: that draft comes back, exactly as it was.
    if (this.history.has(id)) return this.restore(id);
    this.commit({version: 1, id, uri: `readymade-remote-draft:/${id}${file}`, originalUri: `readymade-remote-original:/${id}${file}`,
      observation: source, path: file, text: original.text, updatedAt: Date.now()});
    return this.get(id);
  }
  save(value: string, text: string): RemoteDraftRecord {
    if (!editable(text)) throw new Error('Remote drafts support at most 32 KiB of ASCII text, tabs and line endings. Your editor buffer remains unchanged.');
    const old = this.current(value);
    if (value === old.originalUri) throw new Error('Original source is read-only.');
    this.commit(text === old.text ? old : {...old, text, updatedAt: Math.max(Date.now(), old.updatedAt + 1)}); return this.get(old.id);
  }
  /** The exclusive claim every write of this store takes; a second window's write fails instead of interleaving. */
  private locked<T>(run: () => T): T {
    if (!exists(this.directory)) fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    secure(fs.lstatSync(this.directory), true);
    return withWriteLock(this.directory, run);
  }
  /** Open drafts, as the folder holds them now (another window may have opened or moved some). */
  get open(): number {this.refresh(); return this.records.size;}
  /** Is this draft held at all, open or in history? */
  holds(id: string): boolean {this.refresh(); return this.records.has(id) || this.history.has(id);}
  /**
   * Move one draft to history exactly as it is saved. It leaves the 64 open drafts, keeps its text and the source
   * it was read from, and comes back with restore(). A draft another window changed since this one read it is not moved.
   */
  archive(value: string): RemoteDraftRecord {
    const row = this.current(value);
    this.locked(() => {
      const target = path.join(this.directory, `${row.id}.json`), baseline = this.baselines.get(row.id);
      if (!baseline || !exists(target) || !read(target).equals(baseline)) throw new Error('Remote draft changed in another window. Reopen it before moving it to history.');
      this.history.move(row.id);
      this.records.delete(row.id); this.baselines.delete(row.id);
    });
    return copy(row);
  }
  /** Bring one draft back from history among the open drafts, byte for byte. Needs room among the 64. */
  restore(id: string): RemoteDraftRecord {
    return this.locked(() => {
      const kept = this.history.read(id), target = path.join(this.directory, `${id}.json`);
      if (!kept) throw new Error('This draft is not in history.');
      // A draft that is also open is what an interrupted move left; the open file is the draft.
      const bytes = exists(target) ? read(target) : kept, row = saved(decode(bytes)); if (row.id !== id) invalid();
      if (!exists(target) && this.names().length >= CAPACITY) throw new Error(FULL);
      this.history.restore(id);
      this.records.set(id, row); this.baselines.set(id, bytes);
      return copy(row);
    });
  }
  /** One draft in history, validated like an open one, or undefined. */
  archived(id: string): RemoteDraftRecord | undefined {
    const bytes = this.history.read(id);
    if (!bytes) return undefined;
    const row = saved(decode(bytes)); if (row.id !== id) invalid();
    return copy(row);
  }
  /** Drafts in history, most recently moved first, one page at a time; only that page is read. */
  archivedPage(offset = 0, limit = 16): {total: number; drafts: RemoteDraftRecord[]} {
    const page = this.history.page(offset, limit);
    // A draft that is also open is an unfinished move; it is listed with the open drafts, not here.
    this.refresh();
    return {total: page.total, drafts: page.names.filter(name => !this.records.has(name)).map(name => this.archived(name)).filter(row => row !== undefined)};
  }
  private commit(value: Saved): void {
    const row = saved(value), bytes = Buffer.from(JSON.stringify(row)); if (bytes.length > LIMIT) invalid();
    if (!exists(this.directory)) fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    secure(fs.lstatSync(this.directory), true);
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    withWriteLock(this.directory, () => {try {
      const target = path.join(this.directory, `${row.id}.json`), baseline = this.baselines.get(row.id);
      if (exists(target)) {if (!baseline || !read(target).equals(baseline)) throw new Error('Remote draft changed in another window. Reopen it before saving.');}
      else if (baseline) throw new Error(this.history.has(row.id) ? 'This draft was moved to history in another window. Restore it before editing.' : 'Remote draft journal disappeared.');
      else if (this.names().length >= CAPACITY) throw new Error(FULL);
      // Even identical saves must validate the exclusive claim and unchanged on-disk journal.
      if (baseline && JSON.stringify(this.records.get(row.id)) === JSON.stringify(row)) return;
      const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      try {fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      fs.renameSync(temporary, target);
      const dir = fs.openSync(this.directory, fs.constants.O_RDONLY); try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}
      this.records.set(row.id, row); this.baselines.set(row.id, bytes);
    } finally {fs.rmSync(temporary, {force: true});}});
  }
}
