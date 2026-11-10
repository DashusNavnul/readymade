import * as fs from 'node:fs';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {documentBody, documentSnapshot, documentSaveIntent, documentSaveResult, documentReceipt, type DocumentReceipt, type DocumentSnapshot, type DocumentSaveIntent, type DocumentSaveResult} from './noltbook-documents';

export interface DocumentDraft {
  readonly id: string; readonly title: string; readonly snapshot: DocumentSnapshot; readonly remote: DocumentSnapshot;
  readonly body: string; readonly pending?: DocumentSaveIntent;
  readonly reconciliations?: readonly {snapshot: DocumentSnapshot; body: string}[];
  readonly history: readonly {intent: DocumentSaveIntent; result: DocumentSaveResult; receipt?: DocumentReceipt}[];
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const identity = (s: DocumentSnapshot) => createHash('sha256').update(JSON.stringify([s.origin, s.peer, s.host, s.noteId])).digest('hex');
function snapshot(value: DocumentSnapshot): DocumentSnapshot {const {origin, peer, ...native} = value; return documentSnapshot(native, origin, peer);}
function intent(value: DocumentSaveIntent): DocumentSaveIntent {return documentSaveIntent(snapshot(value.snapshot), value.body, value.requestId, value.protocol);}
function evidence(value: DocumentReceipt, command: DocumentSaveIntent, result: DocumentSaveResult): DocumentReceipt {
  const receipt = documentReceipt(value, command), terminal = receipt.receipt;
  if (receipt.status !== 'recorded' || !terminal || terminal.result !== result.result || terminal.revision !== result.revision || terminal.limit !== result.limit) throw new Error('Document receipt does not prove this result.');
  return receipt;
}
function validate(value: DocumentDraft): DocumentDraft {
  const base = snapshot(value.snapshot), remote = snapshot(value.remote), id = identity(base);
  const title = value.title ?? base.noteId;
  if (typeof title !== 'string' || Buffer.byteLength(title) > 4096) throw new Error('Invalid document title.');
  if (value.id !== id || identity(remote) !== id || remote.revision < base.revision || !Array.isArray(value.history) || value.history.length > 32) throw new Error('Invalid document draft identity.');
  const pending = value.pending && intent(value.pending);
  if (pending && (identity(pending.snapshot) !== id || JSON.stringify(pending.snapshot) !== JSON.stringify(base))) throw new Error('Document save binding changed.');
  const seen = new Set<number>();
  const history = value.history.map(row => {
    const command = intent(row.intent), result = documentSaveResult(row.result);
    if (identity(command.snapshot) !== id || result.noteId !== base.noteId || command.requestId !== result.requestId || seen.has(result.requestId)) throw new Error('Document receipt binding changed.');
    if (command.protocol && !row.receipt) throw new Error('Durable save evidence missing.');
    seen.add(result.requestId); return {intent: command, result, ...(row.receipt ? {receipt: evidence(row.receipt, command, result)} : {})};
  });
  if (pending && seen.has(pending.requestId)) throw new Error('Document save request already settled.');
  const reconciliations = value.reconciliations ?? [];
  if (!Array.isArray(reconciliations) || reconciliations.length > 8) throw new Error('Invalid document reconciliation history.');
  const recovery = reconciliations.map(row => {
    const source = snapshot(row.snapshot);
    if (identity(source) !== id || source.revision > base.revision) throw new Error('Document recovery identity changed.');
    return {snapshot: source, body: documentBody(row.body)};
  });
  return {id, title, ...(recovery.length ? {reconciliations: recovery} : {}), snapshot: base, remote, body: documentBody(value.body), ...(pending ? {pending} : {}), history};
}
function secure(file: string, directory = false): void {
  const s = fs.lstatSync(file);
  if ((directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1) || s.isSymbolicLink() || process.getuid && (s.uid !== process.getuid() || (s.mode & 0o077))) throw new Error('Document storage must be private and owned.');
}
function read(file: string): Buffer {
  secure(file); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {if (fs.fstatSync(fd).size > 40 * 1024 * 1024) throw new Error('Document journal exceeds its bound.'); return fs.readFileSync(fd);} finally {fs.closeSync(fd);}
}
/** Private working copies and delivery evidence only. Native Noltbook owns revisions. */
export class NoltbookDocumentStore {
  private readonly records = new Map<string, DocumentDraft>();
  private readonly baselines = new Map<string, Buffer>();
  constructor(readonly directory: string) {
    if (!fs.existsSync(directory)) return;
    secure(directory, true);
    const names = fs.readdirSync(directory).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
    if (names.length > 64) throw new Error('Document draft capacity exceeded.');
    for (const name of names) {
      const bytes = read(join(directory, name)), row = validate(JSON.parse(bytes.toString('utf8')));
      if (name !== row.id + '.json') throw new Error('Document journal identity changed.');
      this.records.set(row.id, row); this.baselines.set(row.id, bytes);
    }
  }
  list(): readonly DocumentDraft[] {return [...this.records.values()].map(copy);}
  get(id: string): DocumentDraft {const row = this.records.get(id); if (!row) throw new Error('Unknown document draft.'); return copy(row);}
  open(value: DocumentSnapshot, preserveLocal = false, title?: string): DocumentDraft {
    const s = snapshot(value), id = identity(s);
    if (this.records.has(id)) {
      const row = this.observe(id, s, preserveLocal);
      if (title !== undefined && title !== row.title) this.commit({...row, title});
      return this.get(id);
    }
    this.commit({id, title: title ?? s.noteId, snapshot: s, remote: s, body: s.body, history: []}); return this.get(id);
  }
  save(id: string, body: string): void {this.commit({...this.get(id), body: documentBody(body)});}
  observe(id: string, value: DocumentSnapshot, preserveLocal = false): DocumentDraft {
    const row = this.get(id), remote = snapshot(value);
    if (identity(remote) !== id || remote.revision < row.remote.revision || remote.revision === row.remote.revision && remote.body !== row.remote.body) throw new Error('Document observation is stale or inconsistent.');
    const clean = !preserveLocal && !row.pending && row.body === row.snapshot.body;
    this.commit({...row, remote, ...(clean ? {snapshot: remote, body: remote.body} : {})}); return this.get(id);
  }
  begin(id: string, value: DocumentSaveIntent): void {
    const row = this.get(id), command = intent(value);
    if (row.pending || row.history.length >= 32 || command.body !== row.body || JSON.stringify(command.snapshot) !== JSON.stringify(row.snapshot) || row.history.some(h => h.intent.requestId === command.requestId)) throw new Error('Save is pending, changed or already retained. Check its result; do not resend.');
    this.commit({...row, pending: command});
  }
  settle(id: string, value: DocumentSaveResult, observed?: DocumentSnapshot, proof?: DocumentReceipt): void {
    const row = this.get(id), result = documentSaveResult(value), pending = row.pending;
    if (!pending || result.requestId !== pending.requestId || result.noteId !== pending.snapshot.noteId) throw new Error('Uncorrelated document save result.');
    const success = result.result === 'saved' || result.result === 'no-change', fresh = observed && snapshot(observed);
    const receipt = proof && evidence(proof, pending, result);
    if (pending.protocol && !receipt) throw new Error('Durable save evidence missing.');
    const exact = fresh && identity(fresh) === id && fresh.revision === result.revision && fresh.body === pending.body && fresh.revision >= row.remote.revision;
    if (success && !receipt && !exact) throw new Error('Saved document observation does not match the receipt.');
    if (fresh && (identity(fresh) !== id || fresh.revision < row.remote.revision || fresh.revision === row.remote.revision && fresh.body !== row.remote.body)) throw new Error('Current document observation changed.');
    const {pending: _pending, ...rest} = row;
    this.commit({...rest, ...(fresh ? {remote: fresh} : {}), ...(success && exact ? {snapshot: fresh!} : {}), history: [...row.history, {intent: pending, result, ...(receipt ? {receipt} : {})}]});
  }
  /** Retain the exact original before changing its editor, even if apply fails. */
  prepareReconciliation(id: string, expected: DocumentDraft): DocumentDraft {
    const row = this.get(id), copies = row.reconciliations ?? [];
    if (JSON.stringify(row) !== JSON.stringify(expected) || row.pending) throw new Error('Document changed during reconciliation.');
    if (copies.length >= 8) throw new Error('Eight original copies are retained. Reconciliation capacity reached; originals cannot be discarded here.');
    this.commit({...row, reconciliations: [...copies, {snapshot: row.snapshot, body: row.body}]});
    return this.get(id);
  }
  /** Atomic local text/basis transition after the original has been retained. */
  reconcile(id: string, expected: DocumentDraft, value: DocumentSnapshot, body: string): void {
    const row = this.get(id), fresh = snapshot(value), original = row.reconciliations?.at(-1);
    if (JSON.stringify(row) !== JSON.stringify(expected) || row.pending) throw new Error('Document changed during reconciliation.');
    if (!original || original.body !== row.body || JSON.stringify(original.snapshot) !== JSON.stringify(row.snapshot)) throw new Error('Retain the exact original before applying reconciliation.');
    if (identity(fresh) !== id || !fresh.canEdit || fresh.revision < row.remote.revision ||
        fresh.revision === row.remote.revision && fresh.body !== row.remote.body) throw new Error('Shared document changed or is read-only.');
    this.commit({...row, snapshot: fresh, remote: fresh, body: documentBody(body)});
  }
  /** Explicit rebase after comparison. Never overwrites the local text. */
  rebase(id: string): void {const row = this.get(id); if (row.pending) throw new Error('Check the pending save first.'); this.commit({...row, snapshot: row.remote});}
  private commit(value: DocumentDraft): void {
    const row = validate(value), bytes = Buffer.from(JSON.stringify(row));
    if (bytes.length > 40 * 1024 * 1024) throw new Error('Document journal exceeds its bound.');
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700}); secure(this.directory, true);
    const lock = join(this.directory, '.write.lock'), fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    const owned = fs.fstatSync(fd), file = join(this.directory, row.id + '.json'), temp = join(this.directory, '.' + randomUUID());
    try {
      const before = this.baselines.get(row.id);
      if (fs.existsSync(file) ? !before || !read(file).equals(before) : !!before) throw new Error('Document journal changed in another window. Reopen before saving.');
      if (!before && fs.readdirSync(this.directory).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).length >= 64) throw new Error('Document draft capacity exceeded.');
      const write = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      try {fs.writeFileSync(write, bytes); fs.fsyncSync(write);} finally {fs.closeSync(write);}
      fs.renameSync(temp, file); const dir = fs.openSync(this.directory, fs.constants.O_RDONLY); try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}
      this.records.set(row.id, row); this.baselines.set(row.id, bytes);
    } finally {fs.closeSync(fd); fs.rmSync(temp, {force: true}); const current = fs.lstatSync(lock); if (current.ino === owned.ino && current.dev === owned.dev) fs.unlinkSync(lock);}
  }
}
