import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bundleCandidateCommand, candidateCommand } from './candidate-command';
import { mergeDraft, type DraftMerge } from './draft-merge';
import type { ShipClient } from './ship-client';
import { asRecord, isInteger, isUv, isUx, validUnicode, type CodingSnapshot, type JsonObject } from './protocol';
import { digest, FILE_LIMIT, originOf, sameBasis, snapshotFrom, sourceBasis, type SourceSnapshot } from './source-store';
import {inboxBundleDetail, inboxBundleSources, type InboxBundleDetail} from './project-inbox';
import {remoteSourceHash} from './remote-project-view';

export interface CandidateIntent {
  nonce: string; input: string; text: string; phase: 'issued' | 'submitted' | 'unknown' | 'candidate' | 'refused';
  request?: string; candidate?: string; reason?: string;
}
export interface DraftRecord { id: string; uri: string; snapshot: SourceSnapshot; text: string; updatedAt: number; pending?: CandidateIntent }
export type DraftReconciliation = {kind: 'merged'; draft: DraftRecord} | Extract<DraftMerge, {kind: 'conflict'}>;
interface Saved extends DraftRecord { version: 1 }
export interface BundleCandidateIntent extends Omit<CandidateIntent, 'text'> {files: {path: string; text: string}[]}
export interface BundleDraftRecord {
  version: 2; id: string; owner: string; project: string; receipt: InboxBundleDetail;
  files: {snapshot: SourceSnapshot; text: string}[]; updatedAt: number; pending?: BundleCandidateIntent;
}
type Stored = Saved | BundleDraftRecord;
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
function bundleId(owner: string, project: string, receipt: InboxBundleDetail, first: SourceSnapshot): string {
  return digest(JSON.stringify([first.origin, owner, project, receipt.receiptHash]));
}
function validBundle(value: unknown): BundleDraftRecord {
  const r = asRecord(value);
  if (r.version !== 2 || typeof r.owner !== 'string' || typeof r.project !== 'string' || !isInteger(r.updatedAt) ||
      !Array.isArray(r.files) || !r.files.length || r.files.length > 8 ||
      Object.keys(r).some(key => !['version', 'id', 'owner', 'project', 'receipt', 'files', 'updatedAt', 'pending'].includes(key))) throw new Error('Invalid bundle draft.');
  const receipt = inboxBundleDetail(r.receipt, r.owner, r.project);
  let total = 0;
  const files = r.files.map(value => {
    const f = asRecord(value);
    if (Object.keys(f).length !== 2 || typeof f.text !== 'string' || !editable(f.text) || Buffer.byteLength(f.text) > 32768) throw new Error('Invalid bundle draft member.');
    total += Buffer.byteLength(f.text);
    return {snapshot: snapshotFrom(f.snapshot), text: f.text};
  });
  const sources = inboxBundleSources(receipt, files.map(f => f.snapshot), r.owner, r.project);
  if (total > 65536 || sources.some((s, i) => s.uri !== files[i].snapshot.uri) || r.id !== bundleId(r.owner, r.project, receipt, sources[0])) throw new Error('Bundle source or identity changed.');
  if (r.pending !== undefined) {
    const p = asRecord(r.pending);
    if (!isUv(p.nonce) || !Array.isArray(p.files) || p.files.length !== files.length || typeof p.phase !== 'string' ||
        !['issued', 'submitted', 'unknown', 'candidate', 'refused'].includes(p.phase) ||
        Object.keys(p).some(key => !['nonce', 'input', 'files', 'phase', 'request', 'candidate', 'reason'].includes(key)) ||
        p.request !== undefined && (!isUx(p.request) || p.request === '0x0') ||
        p.candidate !== undefined && (!isUx(p.candidate) || p.candidate === '0x0') ||
        p.reason !== undefined && (typeof p.reason !== 'string' || !validUnicode(p.reason) || p.reason.length > 2048)) throw new Error('Invalid bundle candidate intent.');
    const frozen = p.files.map((value, i) => {
      const f = asRecord(value);
      if (Object.keys(f).length !== 2 || f.path !== files[i].snapshot.path || typeof f.text !== 'string') throw new Error('Bundle intent member changed.');
      return {snapshot: files[i].snapshot, text: f.text};
    });
    if (p.input !== bundleCandidateCommand(frozen) || ['submitted', 'candidate', 'refused'].includes(String(p.phase)) && !p.request ||
        p.phase === 'candidate' && !p.candidate) throw new Error('Bundle intent lost its exact request.');
  }
  return {...r, receipt, files} as unknown as BundleDraftRecord;
}
function storedKey(row: Stored): string {return row.version === 1 ? row.id : `bundle-${row.id}`;}
function storedSources(row: Stored): SourceSnapshot[] {return row.version === 1 ? [row.snapshot] : row.files.map(f => f.snapshot);}
function sourceSlot(s: SourceSnapshot): string {return JSON.stringify([s.origin, s.ship, s.session, s.source, s.path]);}

/** Private drafts only. A persisted issued/unknown intent is never automatically replayed or applied. */
export class DraftStore {
  private readonly records = new Map<string, Saved>();
  private readonly bundles = new Map<string, BundleDraftRecord>();
  private readonly baselines = new Map<string, Buffer>();
  constructor(readonly directory: string) { this.restore(); }
  private ensureDirectory(): void {
    if (!present(this.directory)) fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    secure(fs.lstatSync(this.directory), true);
  }
  private restore(): void {
    if (!present(this.directory)) return;
    secure(fs.lstatSync(this.directory), true);
    for (const {key, row, bytes} of this.scan()) {
      this.baselines.set(key, bytes);
      if (row.version === 1) this.records.set(row.id, row); else this.bundles.set(row.id, row);
    }
  }
  private scan(): {key: string; row: Stored; bytes: Buffer}[] {
    const files = fs.readdirSync(this.directory).filter(file => /^(?:bundle-)?[a-f0-9]{64}\.json$/.test(file));
    if (files.length > 64) throw new Error('Private draft capacity exceeded.');
    const slots = new Set<string>();
    return files.map(file => {
      const bytes = readPrivate(path.join(this.directory, file));
      const value: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes));
      const row = file.startsWith('bundle-') ? validBundle(value) : validSaved(value), key = storedKey(row);
      if (file !== `${key}.json`) throw new Error('Private draft filename does not match its source.');
      for (const source of storedSources(row)) {const slot = sourceSlot(source); if (slots.has(slot)) throw new Error('Draft member already belongs to another draft.'); slots.add(slot);}
      return {key, row, bytes};
    });
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
  private commit(next: Stored): void {
    const bytes = Buffer.from(JSON.stringify(next), 'utf8'); if (bytes.length > 32 * 1024 * 1024) throw new Error('Private draft journal capacity exceeded.');
    if (next.version === 1) validSaved(next); else validBundle(next);
    this.ensureDirectory();
    const key = storedKey(next), file = path.join(this.directory, `${key}.json`), lock = path.join(this.directory, '.drafts.lock');
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    const guard = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    let recordGuard: number | undefined;
    try {
      recordGuard = fs.openSync(`${file}.lock`, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      const all = this.scan(), slots = new Set(storedSources(next).map(sourceSlot));
      for (const old of all.filter(old => old.key !== key)) {
        if (storedSources(old.row).some(s => slots.has(sourceSlot(s)))) throw new Error('Draft member already belongs to another draft.');
        if (old.row.version === 2 && next.version === 2 && old.row.owner === next.owner && old.row.project === next.project &&
            old.row.files[0].snapshot.origin === next.files[0].snapshot.origin && old.row.receipt.peer === next.receipt.peer &&
            old.row.receipt.generation === next.receipt.generation && old.row.receipt.request === next.receipt.request) throw new Error('Suggestion already has a retained bundle draft.');
      }
      if (!all.some(old => old.key === key) && all.length >= 64) throw new Error('Private draft capacity exceeded.');
      const baseline = this.baselines.get(key);
      if (present(file)) { if (!baseline || !readPrivate(file).equals(baseline)) throw new Error('Private draft changed outside this editor.'); }
      else if (baseline) throw new Error('Private draft journal disappeared.');
      const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
      const directory = fs.openSync(this.directory, fs.constants.O_RDONLY); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      this.baselines.set(key, bytes);
      if (next.version === 1) this.records.set(next.id, clone(next)); else this.bundles.set(next.id, clone(next));
    } finally {
      if (recordGuard !== undefined) {fs.closeSync(recordGuard); fs.unlinkSync(`${file}.lock`);}
      fs.closeSync(guard); fs.rmSync(temporary, {force: true}); fs.unlinkSync(lock);
    }
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
  listBundles(): readonly BundleDraftRecord[] {return [...this.bundles.values()].map(clone);}
  getBundle(id: string): BundleDraftRecord {
    const row = this.bundles.get(id); if (!row) throw new Error('Bundle draft not found.'); return clone(row);
  }
  createBundle(owner: string, project: string, value: InboxBundleDetail, values: readonly SourceSnapshot[]): BundleDraftRecord {
    const receipt = inboxBundleDetail(value, owner, project), sources = inboxBundleSources(receipt, values, owner, project);
    const id = bundleId(owner, project, receipt, sources[0]);
    if (this.bundles.has(id)) throw new Error('Suggestion already has a retained bundle draft.');
    const files = sources.map((snapshot, i) => ({snapshot, text: receipt.files[i].source}));
    // Import may be inspected even if the whole command is too large to submit.
    const row = validBundle({version: 2, id, owner, project, receipt, files, updatedAt: Date.now()});
    this.commit(row); return this.getBundle(id);
  }
  saveBundle(id: string, member: string, text: string): BundleDraftRecord {
    const row = this.getBundle(id), file = row.files.find(file => file.snapshot.path === member);
    if (!file) throw new Error('Unknown bundle member.');
    file.text = text;
    this.commit({...row, updatedAt: Math.max(Date.now(), row.updatedAt + 1)}); return this.getBundle(id);
  }
  /** Format opt-in only. Urbit still checks batch/path authority; a refusal never falls back to scalar writes. */
  async prepareBundle(id: string, client: CandidateClient, protocol?: 'native-coding-patches-v1'): Promise<BundleDraftRecord> {
    const row = this.getBundle(id), first = row.files[0].snapshot, state = client.snapshot;
    if (protocol !== 'native-coding-patches-v1') throw new Error('Native batch protocol is unsupported.');
    if (row.pending) throw new Error('A bundle candidate intent is retained. Observe it; it will not be resent.');
    if (client.origin !== first.origin || !state?.ready || state.owner !== row.owner || state.session !== first.session || !isUv(state.nonce)) throw new Error('Observe this exact owner/session before preparing the bundle.');
    const sessions = state.sessions.filter(s => s.id === first.session);
    if (sessions.length !== 1 || sessions[0].project !== row.project || !sameBasis(first.source, sessions[0].source) || sourceBasis(sessions[0].source).id !== first.source.id) throw new Error('Bundle source or project changed.');
    const pending: BundleCandidateIntent = {nonce: state.nonce, input: bundleCandidateCommand(row.files),
      files: row.files.map(f => ({path: f.snapshot.path, text: f.text})), phase: 'issued'};
    client.assertIdle?.();
    this.commit({...row, pending, updatedAt: Math.max(Date.now(), row.updatedAt + 1)});
    try {
      const reply = await client.codingTool(first.session, first.source.id, pending.input);
      if (client.origin !== first.origin || reply.owner !== row.owner || reply.session !== first.session) throw new Error('Bundle reply belongs to another connection.');
      const receipt = asRecord(reply.commandReceipt);
      if (receipt.version !== 'native-coding-command-receipt-v1' || receipt.target !== 'viki' || receipt.session !== first.session || receipt.source !== first.source.id ||
          !isUx(receipt.request) || receipt.request === '0x0' || !isUx(receipt.delivery) || reply.delivery !== `${receipt.delivery}: submitted; observing native retention`) throw new Error('Bundle candidate receipt is unconfirmed.');
      this.markBundle(id, {phase: 'submitted', request: receipt.request});
      this.observeBundle(id, reply); return this.getBundle(id);
    } catch (error) {
      this.markBundle(id, {phase: 'unknown', reason: error instanceof Error ? error.message.slice(0, 2048) : 'Unknown bundle outcome.'});
      throw error;
    }
  }
  private markBundle(id: string, update: Partial<BundleCandidateIntent>): void {
    const row = this.getBundle(id);
    if (!row.pending) throw new Error('Bundle intent is missing.');
    if (['candidate', 'refused'].includes(row.pending.phase)) return;
    this.commit({...row, pending: {...row.pending, ...update}, updatedAt: Math.max(Date.now(), row.updatedAt + 1)});
  }
  /** Read-only native evidence input; this method has no client and cannot dispatch a request. */
  observeBundle(id: string, reply: CodingSnapshot): void {
    const row = this.getBundle(id), pending = row.pending, first = row.files[0].snapshot;
    if (!pending?.request || ['candidate', 'refused'].includes(pending.phase)) return;
    if (reply.owner !== row.owner || reply.session !== first.session) throw new Error('Bundle observation belongs to another owner/session.');
    for (const record of reply.records) {
      if (record.kind !== 'tool' || typeof record.text !== 'string') continue;
      let result: JsonObject; try {result = asRecord(JSON.parse(record.text));} catch {continue;}
      if (result.version !== 'native-coding-tool-result-v1' || result.call_id !== pending.request) continue;
      const context = asRecord(result.context), output = asRecord(result.output);
      if (context.request !== pending.request || context.session !== first.session || context.project !== row.project || !sameBasis(first.source, context.source)) throw new Error('Bundle result context changed.');
      if (output.kind === 'refused') {
        // Keep the ship's own reason (e.g. a protected path), bounded; never a guess.
        const why = [output.reason, output.detail].filter(v => typeof v === 'string' && v).join(': ').slice(0, 512);
        this.markBundle(id, {phase: 'refused', reason: `The ship refused this exact whole-bundle request${why ? ' (' + why + ')' : ''}.`}); return;
      }
      if (output.kind !== 'candidate') continue;
      const nested = asRecord(output.context);
      if (!isUx(output.id) || output.id === '0x0' || output.previous !== null || !sameBasis(first.source, output.basis) || nested.request !== pending.request ||
          nested.session !== first.session || nested.project !== row.project || !sameBasis(first.source, nested.source) || !Array.isArray(output.edits) || output.edits.length !== row.files.length) throw new Error('Candidate does not match the whole bundle.');
      const seen = new Set<string>();
      for (const value of output.edits) {
        const edit = asRecord(value), member = row.files.find(f => f.snapshot.path === edit.path), frozen = pending.files.find(f => f.path === edit.path);
        if (!member || !frozen || seen.has(member.snapshot.path) || edit.kind !== 'modify' || edit.before !== member.snapshot.blob || !isUx(edit.after) || edit.after === '0x0') throw new Error('Candidate member or original Clay blob changed.');
        const content = asRecord(edit.content);
        if (content.mark !== member.snapshot.mark || content.bytes !== Buffer.byteLength(frozen.text) || content.digest !== remoteSourceHash(frozen.text) || content.sourceOmitted !== true) throw new Error('Candidate contents differ from the frozen bundle.');
        seen.add(member.snapshot.path);
      }
      this.markBundle(id, {phase: 'candidate', candidate: output.id, reason: 'Whole candidate prepared. Native checks, review and Apply remain separate.'}); return;
    }
  }
}
