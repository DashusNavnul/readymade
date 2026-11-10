import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {dateAtom} from './editing-activity';
import {remoteProjectViewSelector, remoteShip, remoteSourceHash, type RemoteSourceObservation} from './remote-project-view';
import {asRecord, type JsonObject} from './protocol';

export interface RemoteDraftRecord {
  readonly id: string; readonly uri: string; readonly originalUri: string;
  readonly observation: RemoteSourceObservation; readonly path: string;
  readonly text: string; readonly updatedAt: number;
}
interface Saved extends RemoteDraftRecord {readonly version: 1}
const LIMIT = 524288, CAPACITY = 64;
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
  constructor(readonly directory: string) {
    if (!exists(directory)) return;
    secure(fs.lstatSync(directory), true);
    const names = this.names();
    if (names.length > CAPACITY) throw new Error('Remote draft capacity exceeded.');
    for (const name of names) {
      const bytes = read(path.join(directory, name));
      const row = saved(JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes)));
      if (name !== `${row.id}.json`) invalid();
      this.records.set(row.id, row); this.baselines.set(row.id, bytes);
    }
  }
  private names(): string[] {return fs.readdirSync(this.directory).filter(n => /^[a-f0-9]{64}\.json$/.test(n));}
  private current(value: string): Saved {
    const row = this.records.get(value) ?? [...this.records.values()].find(r => r.uri === value || r.originalUri === value);
    if (!row) throw new Error('Unknown remote draft.'); return row;
  }
  get(value: string): RemoteDraftRecord {return copy(this.current(value));}
  list(): readonly RemoteDraftRecord[] {return [...this.records.values()].map(copy);}
  create(value: RemoteSourceObservation, file: string): RemoteDraftRecord {
    const source = observation(value), original = source.files.find(f => f.path === file);
    if (!original) invalid();
    const id = identity(source, file), old = this.records.get(id);
    if (old) return copy(old);
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
  private commit(value: Saved): void {
    const row = saved(value), bytes = Buffer.from(JSON.stringify(row)); if (bytes.length > LIMIT) invalid();
    if (!exists(this.directory)) fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    secure(fs.lstatSync(this.directory), true);
    const lock = path.join(this.directory, '.write.lock');
    const guard = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    const held = fs.fstatSync(guard), temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    try {
      const target = path.join(this.directory, `${row.id}.json`), baseline = this.baselines.get(row.id);
      if (exists(target)) {if (!baseline || !read(target).equals(baseline)) throw new Error('Remote draft changed in another window. Reopen it before saving.');}
      else if (baseline) throw new Error('Remote draft journal disappeared.');
      else if (this.names().length >= CAPACITY) throw new Error('64 remote drafts are retained.');
      // Even identical saves must validate the exclusive claim and unchanged on-disk journal.
      if (baseline && JSON.stringify(this.records.get(row.id)) === JSON.stringify(row)) return;
      const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      try {fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      fs.renameSync(temporary, target);
      const dir = fs.openSync(this.directory, fs.constants.O_RDONLY); try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}
      this.records.set(row.id, row); this.baselines.set(row.id, bytes);
    } finally {
      fs.closeSync(guard); fs.rmSync(temporary, {force: true});
      if (exists(lock)) {const now = fs.lstatSync(lock); if (now.ino === held.ino && now.dev === held.dev) fs.unlinkSync(lock);}
    }
  }
}
