import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { candidateCommand } from './candidate-command';
import { mergeDraft, type DraftMerge } from './draft-merge';
import type { ShipClient } from './ship-client';
import { asRecord, isInteger, isUv, isUx, validUnicode, type CodingSnapshot, type JsonObject } from './protocol';
import { digest, FILE_LIMIT, originOf, sameBasis, snapshotFrom, sourceBasis, type SourceSnapshot } from './source-store';

export interface CandidateIntent {
  nonce: string; input: string; text: string; phase: 'issued' | 'submitted' | 'unknown' | 'candidate' | 'refused';
  request?: string; candidate?: string; reason?: string;
}
export interface DraftRecord { id: string; uri: string; snapshot: SourceSnapshot; text: string; updatedAt: number; pending?: CandidateIntent }
export type DraftReconciliation = {kind: 'merged'; draft: DraftRecord} | Extract<DraftMerge, {kind: 'conflict'}>;
interface Saved extends DraftRecord { version: 1 }
type CandidateClient = Pick<ShipClient, 'origin' | 'snapshot' | 'codingTool'> & {assertIdle?(): void};
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function editable(text: string): boolean { return validUnicode(text) && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(text); }
function uid(): number | undefined { return process.getuid?.(); }
function present(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function secure(info: fs.Stats, directory = false): void {
  if ((directory ? !info.isDirectory() : !info.isFile()) || info.isSymbolicLink() ||
      (uid() !== undefined && (info.uid !== uid() || (info.mode & 0o077) !== 0))) throw new Error('Private draft storage is not owned and private.');
}
function readPrivate(file: string): Buffer {
  secure(fs.lstatSync(file)); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const info = fs.fstatSync(fd); secure(info); if (info.size > 32 * 1024 * 1024) throw new Error('Private draft journal is oversized.'); return fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
}
function validSaved(value: unknown): Saved {
  const row = asRecord(value), snapshot = snapshotFrom(row.snapshot), id = digest(snapshot.uri);
  if (row.version !== 1 || row.id !== id || row.uri !== `readymade-draft:/${id}${snapshot.path}` ||
      typeof row.text !== 'string' || !validUnicode(row.text) || Buffer.byteLength(row.text) > FILE_LIMIT || !isInteger(row.updatedAt)) throw new Error('Invalid private draft journal.');
  if (row.pending !== undefined) {
    const pending = asRecord(row.pending);
    if (!isUv(pending.nonce) || typeof pending.text !== 'string' || !editable(pending.text) || Buffer.byteLength(pending.text) > FILE_LIMIT ||
        pending.input !== candidateCommand(snapshot, pending.text) ||
        typeof pending.phase !== 'string' || !['issued', 'submitted', 'unknown', 'candidate', 'refused'].includes(pending.phase) ||
        (pending.request !== undefined && (!isUx(pending.request) || pending.request === '0x0')) ||
        (pending.candidate !== undefined && (!isUx(pending.candidate) || pending.candidate === '0x0')) ||
        (pending.reason !== undefined && (typeof pending.reason !== 'string' || !validUnicode(pending.reason) || pending.reason.length > 2048)) ||
        typeof pending.input !== 'string' || Buffer.byteLength(pending.input) > 65_536) throw new Error('Invalid retained candidate intent.');
    if (['submitted', 'candidate', 'refused'].includes(pending.phase) && !pending.request) throw new Error('Candidate intent lost its request identity.');
    if (pending.phase === 'candidate' && !pending.candidate) throw new Error('Candidate intent lost its candidate identity.');
  }
  return { ...row, snapshot } as unknown as Saved;
}

/** Private drafts only. A persisted issued/unknown intent is never automatically replayed or applied. */
export class DraftStore {
  private readonly records = new Map<string, Saved>();
  private readonly baselines = new Map<string, Buffer>();
  constructor(readonly directory: string) { this.restore(); }
  private ensureDirectory(): void {
    if (!present(this.directory)) fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    secure(fs.lstatSync(this.directory), true);
  }
  private restore(): void {
    if (!present(this.directory)) return;
    secure(fs.lstatSync(this.directory), true);
    const files = fs.readdirSync(this.directory).filter(file => /^[a-f0-9]{64}\.json$/.test(file));
    if (files.length > 64) throw new Error('Private draft capacity exceeded.');
    const staged: Saved[] = [];
    for (const file of files) {
      const bytes = readPrivate(path.join(this.directory, file));
      const row = validSaved(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)));
      if (file !== `${row.id}.json`) throw new Error('Private draft filename does not match its source.');
      staged.push(row); this.baselines.set(row.id, bytes);
    }
    for (const row of staged) this.records.set(row.id, row);
  }
  private key(id: string): string {
    if (/^[a-f0-9]{64}$/.test(id)) return id;
    const uri = new URL(id), key = uri.pathname.split('/')[1], row = this.records.get(key);
    if (uri.protocol !== 'readymade-draft:' || uri.host || uri.search || uri.hash || !row || row.uri !== id) throw new Error('Unknown source-bound draft URI.');
    return key;
  }
  private current(id: string): Saved { const row = this.records.get(this.key(id)); if (!row) throw new Error('Private draft not found.'); return row; }
  list(): readonly DraftRecord[] { return [...this.records.values()].map(row => clone(row)); }
  get(id: string): DraftRecord { return clone(this.current(id)); }
  create(value: SourceSnapshot): DraftRecord {
    const snapshot = snapshotFrom(value), id = digest(snapshot.uri), existing = this.records.get(id);
    if (existing) { if (existing.snapshot.uri !== snapshot.uri || existing.snapshot.text !== snapshot.text) throw new Error('Source identity conflict.'); return clone(existing); }
    if (this.records.size >= 64) throw new Error('64 private draft buffers are retained.');
    const row: Saved = { version: 1, id, uri: `readymade-draft:/${id}${snapshot.path}`, snapshot, text: snapshot.text, updatedAt: Date.now() };
    this.commit(row); return clone(row);
  }
  save(id: string, text: string): DraftRecord {
    if (!validUnicode(text) || Buffer.byteLength(text) > FILE_LIMIT) throw new Error('Draft exceeds 1 MiB of UTF-8 bytes or contains invalid Unicode.');
    const row = this.current(id); this.commit({ ...row, text, updatedAt: Math.max(Date.now(), row.updatedAt + 1) }); return this.get(id);
  }
  /** Creates a separate local draft. The supplied observation must be freshly read by the caller. */
  reconcile(id: string, value: SourceSnapshot, localText: string, observed: CodingSnapshot, project: string): DraftReconciliation {
    const old = this.current(id), snapshot = snapshotFrom(value), base = old.snapshot;
    if (old.pending) throw new Error('Observe the retained candidate intent before reconciling this draft.');
    if (snapshot.origin !== base.origin || snapshot.ship !== base.ship || snapshot.session !== base.session ||
        snapshot.path !== base.path || snapshot.mark !== base.mark || snapshot.source.owner !== base.source.owner ||
        snapshot.source.desk !== base.source.desk) throw new Error('Reconciliation requires the same ship, session, source desk and file.');
    const sessions = observed.sessions.filter(row => row.id === base.session);
    if (!observed.ready || observed.owner !== base.ship || observed.session !== base.session || !project ||
        sessions.length !== 1 || sessions[0].project !== project ||
        !sameBasis(snapshot.source, sessions[0].source) || sourceBasis(sessions[0].source).id !== snapshot.source.id) {
      throw new Error('Observe the current project source before reconciling.');
    }
    if (snapshot.source.id === base.source.id || sameBasis(base.source, {...snapshot.source, id: undefined})) throw new Error('Read a changed source revision before reconciling.');
    const target = digest(snapshot.uri);
    if (this.records.has(target)) throw new Error('A draft for the current source already exists. Review it without overwriting it.');
    if (this.records.size >= 64) throw new Error('64 private draft buffers are retained.');
    this.ensureDirectory();
    const file = path.join(this.directory, `${old.id}.json`), lock = `${file}.lock`;
    const guard = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const baseline = this.baselines.get(old.id);
      if (!baseline || !readPrivate(file).equals(baseline)) throw new Error('Original draft changed outside this editor. Reopen it before reconciling.');
      const result = mergeDraft(base.text, localText, snapshot.text);
      if (result.kind === 'conflict') return result;
      const next: Saved = {version: 1, id: target, uri: `readymade-draft:/${target}${snapshot.path}`,
        snapshot, text: result.text, updatedAt: Date.now()};
      this.commit(next);
      return {kind: 'merged', draft: clone(next)};
    } finally { fs.closeSync(guard); fs.unlinkSync(lock); }
  }
  private commit(next: Saved): void {
    const bytes = Buffer.from(JSON.stringify(next), 'utf8'); if (bytes.length > 32 * 1024 * 1024) throw new Error('Private draft journal capacity exceeded.');
    validSaved(next); this.ensureDirectory();
    const file = path.join(this.directory, `${next.id}.json`), lock = `${file}.lock`, temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    const guard = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const baseline = this.baselines.get(next.id);
      if (present(file)) { if (!baseline || !readPrivate(file).equals(baseline)) throw new Error('Private draft changed outside this editor.'); }
      else if (baseline) throw new Error('Private draft journal disappeared.');
      const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
      const directory = fs.openSync(this.directory, fs.constants.O_RDONLY); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      this.baselines.set(next.id, bytes); this.records.set(next.id, clone(next));
    } finally { fs.closeSync(guard); fs.rmSync(temporary, { force: true }); fs.unlinkSync(lock); }
  }
  async prepare(id: string, client: CandidateClient): Promise<DraftRecord> {
    const row = this.current(id), snapshot = row.snapshot, current = client.snapshot;
    if (row.pending) throw new Error('A candidate intent is retained. Inspect its native evidence; it will not be resent.');
    if (originOf(client.origin) !== snapshot.origin || !current?.ready || current.owner !== snapshot.ship || current.session !== snapshot.session || !isUv(current.nonce)) throw new Error('Observe this exact ship/session before preparing.');
    const sessions = current.sessions.filter(item => item.id === snapshot.session);
    if (sessions.length !== 1 || !sameBasis(snapshot.source, sessions[0].source) || sourceBasis(sessions[0].source).id !== snapshot.source.id) throw new Error('Draft source changed. Read the current source first.');
    if (row.text === snapshot.text || !editable(row.text) || !editable(snapshot.text)) throw new Error('A changed LF-only draft without control characters is required. Original bytes are retained.');
    const input = candidateCommand(snapshot, row.text);
    if (Buffer.byteLength(input) > 65_536) throw new Error('Candidate command exceeds the native byte limit.');
    const pending: CandidateIntent = { nonce: current.nonce, input, text: row.text, phase: 'issued' };
    // A client that could not send now would leave a recorded intent that was never sent and is never sent again.
    client.assertIdle?.();
    this.commit({ ...row, pending, updatedAt: Date.now() });
    try {
      const reply = await client.codingTool(snapshot.session, snapshot.source.id, input);
      if (originOf(client.origin) !== snapshot.origin || reply.owner !== snapshot.ship || reply.session !== snapshot.session) throw new Error('Candidate response belongs to another ship/session.');
      const receipt = asRecord(reply.commandReceipt);
      if (receipt.version !== 'native-coding-command-receipt-v1' || receipt.target !== 'viki' || receipt.session !== snapshot.session || receipt.source !== snapshot.source.id ||
          !isUx(receipt.request) || receipt.request === '0x0' || !isUx(receipt.delivery) || reply.delivery !== `${receipt.delivery}: submitted; observing native retention`) throw new Error('Candidate receipt is unconfirmed.');
      this.mark(id, { phase: 'submitted', request: receipt.request }); this.observe(id, reply); return this.get(id);
    } catch (error) {
      this.mark(id, { phase: 'unknown', reason: error instanceof Error ? error.message.slice(0, 2048) : 'Unconfirmed candidate outcome.' }); throw error;
    }
  }
  private mark(id: string, update: Partial<CandidateIntent>): void {
    const row = this.current(id); if (!row.pending) throw new Error('Candidate intent is missing.');
    this.commit({ ...row, pending: { ...row.pending, ...update }, updatedAt: Date.now() });
  }
  observe(id: string, reply: CodingSnapshot): void {
    const row = this.current(id), pending = row.pending, source = row.snapshot;
    if (!pending?.request || pending.phase === 'candidate' || reply.owner !== source.ship) return;
    for (const record of reply.records) {
      if (record.kind !== 'tool' || typeof record.text !== 'string') continue;
      let result: JsonObject; try { result = asRecord(JSON.parse(record.text)); } catch { continue; }
      if (result.version !== 'native-coding-tool-result-v1' || result.call_id !== pending.request) continue;
      const context = asRecord(result.context), output = asRecord(result.output);
      if (context.request !== pending.request || context.session !== source.session || !sameBasis(source.source, context.source)) continue;
      if (output.kind === 'candidate') {
        const nested = asRecord(output.context), edits = output.edits;
        if (!isUx(output.id) || output.id === '0x0' || output.previous !== null || !sameBasis(source.source, output.basis) ||
            nested.request !== pending.request || nested.session !== source.session || !sameBasis(source.source, nested.source) || !Array.isArray(edits) || edits.length !== 1) throw new Error('Candidate evidence does not match the frozen intent.');
        const edit = asRecord(edits[0]);
        if (edit.kind !== 'modify' || edit.path !== source.path || edit.before !== source.blob || !isUx(edit.after) || edit.after === '0x0') throw new Error('Candidate edit does not match the source blob.');
        this.mark(id, { phase: 'candidate', candidate: output.id, reason: 'Candidate prepared. Native review, acceptance and deployment remain separate.' }); return;
      }
      if (output.kind === 'refused') { this.mark(id, { phase: 'refused', reason: 'The ship refused this exact candidate request.' }); return; }
    }
  }
}
