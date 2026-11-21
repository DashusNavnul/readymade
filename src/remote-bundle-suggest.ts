import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {dateAtom} from './editing-activity';
import {asRecord, type JsonObject} from './protocol';
import {remoteSourceObservation, remoteSourceHash, remoteProjectViewSelector, remoteProjectViewJSON, type RemoteSourceObservation} from './remote-project-view';
import {newRemoteSuggestionRequest, remoteSuggestionHeaders} from './remote-project-suggest';
import type {ShipClient} from './ship-client';
import {RecordHistory} from './private-history';

/** One suggestion covering several shared files, all bound to one owner source observation. */
export interface RemoteBundleIntent {
  readonly observation: RemoteSourceObservation; readonly files: readonly {readonly path: string; readonly source: string}[]; readonly request: string;
}
export type RemoteBundleReply = {readonly owner: string; readonly peer: string; readonly project: string; readonly generation: string;
  readonly request: string; readonly permissionGranted: false; readonly committed: false} & (
  {readonly status: 'missing'} |
  {readonly status: 'watching' | 'sent' | 'recorded' | 'refused' | 'uncertain'; readonly reason: string; readonly deadline: string;
    readonly retainedUntil: string; readonly receiptHash: string | null}
);
function invalid(): never {throw new Error('Invalid or uncorrelated shared multi-file suggestion.');}
function exact(value: unknown, fields: readonly string[]): JsonObject {
  const r = asRecord(value);
  if (Object.getPrototypeOf(r) !== Object.prototype || Object.keys(r).length !== fields.length || !fields.every(k => Object.hasOwn(r, k))) invalid();
  return r;
}
export function remoteBundleIntent(value: unknown): RemoteBundleIntent {
  const r = exact(value, ['observation', 'files', 'request']), o = remoteSourceObservation(r.observation);
  const key = remoteProjectViewSelector({owner: o.owner, project: o.project, generation: o.generation, request: r.request});
  if (!Array.isArray(r.files) || r.files.length < 2 || r.files.length > 8) invalid();
  const seen = new Set<string>(); let bytes = 0;
  const files = r.files.map(value => {
    const f = exact(value, ['path', 'source']), original = o.files.find(file => file.path === f.path);
    if (typeof f.path !== 'string' || !original || seen.has(f.path) || typeof f.source !== 'string' || f.source === original.text ||
        /[^\t\n\r\x20-\x7e]/.test(f.source) || Buffer.byteLength(f.source) > 32768) invalid();
    seen.add(f.path); bytes += Buffer.byteLength(f.source);
    return Object.freeze({path: f.path, source: f.source});
  });
  if (bytes > 65536) invalid();
  return Object.freeze({observation: o, files: Object.freeze(files), request: key.request});
}
export function remoteBundleBody(value: RemoteBundleIntent): JsonObject {
  const i = remoteBundleIntent(value), o = i.observation;
  return {schema: 'readymade-project-bundle-v1', owner: o.owner, project: o.project, generation: o.generation, viewRequest: o.request,
    request: i.request, files: Object.fromEntries(i.files.map(f => [f.path, f.source]))};
}
/** The bundle result route takes the same selector headers as the single-file one. */
export function remoteBundleHeaders(value: RemoteBundleIntent): Record<string, string> {
  const i = remoteBundleIntent(value);
  return remoteSuggestionHeaders({observation: i.observation, path: i.files[0].path, source: i.files[0].source, request: i.request});
}
/** A definite refusal before anything reached the owner: the collaborator's own ship would not start the send. */
export function remoteBundleRefused(status: number, value: unknown): string | undefined {
  const r = asRecord(value);
  if (Object.keys(r).length !== 2 || r.status !== 'refused' || typeof r.message !== 'string') return undefined;
  if (status === 403 && r.message === 'Owner login required.' || status === 400 && r.message === 'Exact bundle request required.') return r.message;
  return status === 409 && ['Exact retained source observation required.', 'ready-view-required', 'view-or-source-invalid', 'selector-invalid',
    'request-conflict', 'bundle-invalid', 'bundle-capacity'].includes(r.message) ? r.message : undefined;
}
export function remoteBundleReply(status: number, value: unknown, supplied: RemoteBundleIntent, post = false): RemoteBundleReply {
  const i = remoteBundleIntent(supplied), o = i.observation;
  const common = {owner: o.owner, peer: o.peer, project: o.project, generation: o.generation, request: i.request,
    permissionGranted: false as const, committed: false as const};
  if (!post && status === 404) {
    const r = exact(value, ['status', 'message']);
    if (r.status !== 'unknown' || r.message !== 'Bundle not retained; do not resend an unknown outcome.') invalid();
    return Object.freeze({...common, status: 'missing'});
  }
  const r = exact(value, ['schema', 'owner', 'peer', 'project', 'generation', 'request', 'viewRequest', 'grant', 'root', 'snapshotDigest',
    'status', 'reason', 'files', 'deadline', 'retainedUntil', 'permissionGranted', 'committed', 'receiptHash']);
  if (r.schema !== 'readymade-project-bundle-result-v1' || Object.entries(common).some(([k, v]) => r[k] !== v) ||
      r.viewRequest !== o.request || r.grant !== o.grant || r.root !== o.root || r.snapshotDigest !== o.snapshotDigest ||
      !Array.isArray(r.files) || r.files.length !== i.files.length) invalid();
  const sent = new Map(i.files.map(f => [f.path, remoteSourceHash(f.source)]));
  for (const value of r.files) {
    const f = exact(value, ['path', 'sourceHash']);
    if (typeof f.path !== 'string' || sent.get(f.path) !== f.sourceHash) invalid();
    sent.delete(f.path);
  }
  const statuses = ['watching', 'sent', 'recorded', 'refused', 'uncertain'];
  if (sent.size || typeof r.status !== 'string' || !statuses.includes(r.status) || typeof r.reason !== 'string' || !/^[a-z0-9-]{1,64}$/.test(r.reason) ||
      status !== (post || r.status === 'watching' || r.status === 'sent' ? 202 : 200) || dateAtom(r.retainedUntil) <= dateAtom(r.deadline)) invalid();
  if (r.status === 'recorded') {
    if (typeof r.receiptHash !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*)$/.test(r.receiptHash) || r.receiptHash.length > 82) invalid();
  } else if (r.receiptHash !== null) invalid();
  return Object.freeze({...common, status: r.status as 'watching' | 'sent' | 'recorded' | 'refused' | 'uncertain', reason: r.reason,
    deadline: r.deadline as string, retainedUntil: r.retainedUntil as string, receiptHash: r.receiptHash as string | null});
}
const refusals: Record<string, string> = {
  'stale-parent': 'The shared files changed after you read them. Reconcile your drafts onto the current files and send a new suggestion',
  'watch-refused': 'It would not open your request; your access or the project may have changed',
  'grant-revoked': 'Your access to this project was withdrawn', 'grant-missing': 'You no longer have access to these files',
};
/** Plain words for a settled or unsettled send. `poke-refused` means the owner's ship rejected it: nothing was recorded there. */
export function remoteBundleOutcome(phase: BundlePhase, reason?: string): string {
  if (phase === 'recorded') return 'Recorded on owner — awaiting review';
  if (phase === 'uncertain' && reason === 'poke-refused') return 'Owner’s ship refused it; nothing was recorded. If the shared files changed, reconcile your drafts and send again';
  if (phase === 'refused-before-submit') return reason === 'closed-unsent' ? 'Not sent: closed before it was sent; nothing left this computer' : 'Not sent: your ship refused to start it';
  if (phase === 'refused') return 'Owner’s ship refused it; nothing was recorded. ' + (refusals[reason ?? ''] ?? `Reason: ${reason ?? 'not given'}`);
  if (phase === 'missing') return 'Your ship no longer holds this send; the outcome is unknown. Do not resend';
  return 'Suggestion: ' + phase + (reason ? ` (${reason})` : '');
}

export type BundlePhase = 'claimed' | 'submitting' | 'unknown' | 'refused-before-submit' | RemoteBundleReply['status'];
export interface SavedBundle {
  readonly version: 1; readonly request: string; readonly drafts: readonly string[]; readonly intent: RemoteBundleIntent;
  readonly phase: BundlePhase; readonly updatedAt: number; readonly reason?: string; readonly receiptHash?: string;
}
type Client = Pick<ShipClient, 'origin' | 'browserCookies' | 'projectBundleSubmit' | 'projectBundleResult'>;
const phases = ['claimed', 'submitting', 'unknown', 'refused-before-submit', 'watching', 'sent', 'recorded', 'refused', 'uncertain', 'missing'];
/** Final on the collaborator's ship (`uncertain` included): later reads never overwrite this evidence. */
const settled = ['recorded', 'refused', 'uncertain', 'refused-before-submit'];
/**
 * How a multi-file suggestion may move to history. `finished`: the owner recorded it, the owner refused it, or it
 * never started; such a record moves by itself when room is needed. `ended`: final here but its outcome on the
 * owner's ship was never learned (`uncertain`); it moves only when the person says so, and history keeps saying
 * `uncertain`. Anything else can still be checked and stays open.
 */
export function bundleStanding(row: Pick<SavedBundle, 'phase' | 'reason'>): 'finished' | 'ended' | 'open' {
  if (['recorded', 'refused', 'refused-before-submit'].includes(row.phase) || row.phase === 'uncertain' && row.reason === 'poke-refused') return 'finished';
  return row.phase === 'uncertain' ? 'ended' : 'open';
}
function fail(): never {throw new Error('Invalid retained multi-file suggestion.');}
function validate(value: unknown): SavedBundle {
  const r = asRecord(value), keys = ['version', 'request', 'drafts', 'intent', 'phase', 'updatedAt',
    ...(r.reason === undefined ? [] : ['reason']), ...(r.receiptHash === undefined ? [] : ['receiptHash'])];
  if (Object.keys(r).length !== keys.length || !keys.every(k => Object.hasOwn(r, k))) fail();
  const intent = remoteBundleIntent(r.intent);
  if (r.version !== 1 || r.request !== intent.request || !Array.isArray(r.drafts) || r.drafts.length !== intent.files.length ||
      r.drafts.some(d => typeof d !== 'string' || !/^[a-f0-9]{64}$/.test(d)) || new Set(r.drafts).size !== r.drafts.length ||
      typeof r.phase !== 'string' || !phases.includes(r.phase) || !Number.isSafeInteger(r.updatedAt) ||
      r.reason !== undefined && (typeof r.reason !== 'string' || r.reason.length > 128) ||
      r.receiptHash !== undefined && (r.phase !== 'recorded' || typeof r.receiptHash !== 'string')) fail();
  return {version: 1, request: intent.request, drafts: [...r.drafts] as string[], intent, phase: r.phase as BundlePhase, updatedAt: r.updatedAt as number,
    ...(r.reason === undefined ? {} : {reason: r.reason as string}), ...(r.receiptHash === undefined ? {} : {receiptHash: r.receiptHash as string})};
}
function exists(file: string): boolean {
  try {fs.lstatSync(file); return true;} catch (e) {if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e;}
}
function secure(s: fs.Stats, directory = false): void {
  if ((directory ? !s.isDirectory() : !s.isFile()) || s.isSymbolicLink() ||
      process.getuid && (s.uid !== process.getuid() || (s.mode & 0o077) !== 0)) throw new Error('Suggestion storage must be private and owned.');
}
const name = (request: string) => createHash('sha256').update(request).digest('hex') + '.json';

/** A claim is written before the one send; a restored claim only permits observation, never a resend. */
export class RemoteBundleJournal {
  private readonly permits = new Set<string>();
  private readonly busy = new Set<string>();
  private readonly history: RecordHistory;
  constructor(readonly directory: string) {this.history = new RecordHistory(directory, 'Suggestion storage');}
  list(): readonly SavedBundle[] {
    if (!exists(this.directory)) return [];
    secure(fs.lstatSync(this.directory), true);
    const files = fs.readdirSync(this.directory).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
    if (files.length > 64) throw new Error('Multi-file suggestion journal capacity exceeded.');
    return files.map(file => {
      const full = path.join(this.directory, file); secure(fs.lstatSync(full));
      const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const info = fs.fstatSync(fd); secure(info); if (info.size > 524288) fail();
        const row = validate(remoteProjectViewJSON(fs.readFileSync(fd)));
        if (file !== name(row.request)) fail(); return row;
      } finally {fs.closeSync(fd);}
    });
  }
  get(request: string): SavedBundle {
    const row = this.list().find(r => r.request === request);
    if (!row) throw new Error('Retained multi-file suggestion not found.'); return row;
  }
  /** Draft ids sent in an open multi-file suggestion; such a draft is never sent again by any path. See holdsDraft for history. */
  claimedDrafts(): ReadonlySet<string> {return new Set(this.list().flatMap(r => r.drafts));}
  private kept(bytes: Buffer | undefined): SavedBundle | undefined {return bytes ? validate(remoteProjectViewJSON(bytes)) : undefined;}
  /** Was this draft ever sent in a multi-file suggestion, open or in history? History is one lookup by name; `open` spares reading the open ones again. */
  holdsDraft(id: string, open: ReadonlySet<string> = this.claimedDrafts()): boolean {return open.has(id) || this.history.has(id, 'draft');}
  /** One multi-file suggestion by request, open or in history. History is read for this record only. */
  find(request: string): SavedBundle | undefined {
    const open = this.list().find(r => r.request === request);
    if (open) return open;
    const row = this.kept(this.history.read(name(request).slice(0, -5)));
    if (row && row.request !== request) fail();
    return row;
  }
  /** Multi-file suggestions in history, most recently moved first, one page at a time; only that page is read. */
  archivedPage(offset = 0, limit = 16): {total: number; bundles: SavedBundle[]} {
    const page = this.history.page(offset, limit);
    // A suggestion that is also open is an unfinished move; it is listed with the open ones, not here.
    return {total: page.total, bundles: page.names.filter(n => !exists(path.join(this.directory, n + '.json'))).map(n => this.kept(this.history.read(n))).filter(row => row !== undefined)};
  }
  /**
   * Move one multi-file suggestion to history, exactly as recorded, with each of its drafts still marked as sent.
   * A finished one moves freely. One that ended without an outcome (`uncertain`) moves only when `asked` is true,
   * because that is the person's decision, and history keeps its state as it is. One that can still be checked stays.
   */
  archive(request: string, asked = false): SavedBundle {
    return this.locked(() => {
      const held = this.get(request), standing = bundleStanding(held);
      if (this.busy.has(request)) throw new Error('This suggestion is being checked. Move it to history when that is done.');
      if (standing === 'open' || standing === 'ended' && !asked) throw new Error('Only a finished suggestion moves to history. Check this one first.');
      this.history.move(name(request).slice(0, -5), held.drafts.map(id => ['draft', id] as const));
      this.permits.delete(request);
      return held;
    });
  }
  private locked<T>(run: () => T): T {
    if (!exists(this.directory)) fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    secure(fs.lstatSync(this.directory), true);
    const file = path.join(this.directory, '.write.lock');
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600), held = fs.fstatSync(fd);
    try {return run();} finally {
      fs.closeSync(fd);
      if (exists(file)) {const now = fs.lstatSync(file); if (held.ino === now.ino && held.dev === now.dev) fs.unlinkSync(file);}
    }
  }
  private write(value: SavedBundle, create = false): SavedBundle {
    const row = validate(value), bytes = Buffer.from(JSON.stringify(row)); if (bytes.length > 524288) fail();
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`), target = path.join(this.directory, name(row.request));
    const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try {fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    try {
      if (create) fs.linkSync(temporary, target); else fs.renameSync(temporary, target);
      const dir = fs.openSync(this.directory, fs.constants.O_RDONLY); try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}
    } finally {fs.rmSync(temporary, {force: true});}
    return validate(JSON.parse(bytes.toString('utf8')));
  }
  claim(drafts: readonly string[], files: readonly {path: string; source: string}[], fresh: RemoteSourceObservation): SavedBundle {
    const intent = remoteBundleIntent({observation: fresh, files, request: newRemoteSuggestionRequest()});
    const row = this.locked(() => {
      const all = this.list();
      if (all.some(r => r.drafts.some(d => drafts.includes(d)))) throw new Error('A chosen draft was already sent in a multi-file suggestion. Check its result; it will not be sent again.');
      if (drafts.some(d => this.history.has(d, 'draft')) || this.history.has(name(intent.request).slice(0, -5))) throw new Error('A chosen draft was already sent in a multi-file suggestion that is now in history. It will not be sent again.');
      if (all.length >= 64) throw new Error('64 multi-file suggestions are open. Move finished ones to history to make room; nothing was discarded.');
      return this.write({version: 1, request: intent.request, drafts: [...drafts], intent, phase: 'claimed', updatedAt: Date.now()}, true);
    });
    this.permits.add(row.request); return row;
  }
  /**
   * Close a send that was recorded here and never started (see RemoteSuggestionJournal.release: `claimed` on disk
   * means no window sent it, and closing takes the lock a send needs). Settled as not sent, with the reason kept.
   */
  release(request: string): SavedBundle {
    if (this.busy.has(request)) throw new Error('This suggestion is being sent or checked now.');
    const closed = this.locked(() => {
      const held = this.get(request);
      if (held.phase !== 'claimed') throw new Error('Only a suggestion that was never sent can be closed as not sent. This one was sent or checked; read its result instead.');
      return this.write({version: 1, request: held.request, drafts: held.drafts, intent: held.intent, phase: 'refused-before-submit', updatedAt: Math.max(Date.now(), held.updatedAt + 1), reason: 'closed-unsent'});
    });
    this.permits.delete(request);
    return closed;
  }
  private context(client: Client, row: SavedBundle): void {
    const cookies = client.browserCookies(client.origin), o = row.intent.observation;
    if (client.origin !== o.origin || cookies.length !== 1 || cookies[0].name !== `urbauth-${o.peer}`) throw new Error('Suggestion belongs to another ship connection.');
  }
  private update(row: SavedBundle, phase: BundlePhase, reply?: RemoteBundleReply, reason?: string): SavedBundle {
    return this.locked(() => {
      const held = this.get(row.request);
      if (JSON.stringify(held.intent) !== JSON.stringify(row.intent)) fail();
      if (phase === 'submitting' && held.phase !== 'claimed') throw new Error('Suggestion was observed in another window; do not submit it again.');
      if (settled.includes(held.phase)) return held;
      const why = reply && reply.status !== 'missing' ? reply.reason : reason, receipt = reply && reply.status === 'recorded' ? reply.receiptHash : null;
      return this.write({version: 1, request: held.request, drafts: held.drafts, intent: held.intent, phase, updatedAt: Math.max(Date.now(), held.updatedAt + 1),
        ...(why ? {reason: why.slice(0, 128)} : {}), ...(receipt ? {receiptHash: receipt} : {})});
    });
  }
  async submit(client: Client, request: string): Promise<SavedBundle> {
    const row = this.get(request); this.context(client, row);
    if (row.phase !== 'claimed' || !this.permits.has(request) || this.busy.has(request)) throw new Error('Only a newly claimed suggestion can be sent once. Check this retained request instead.');
    this.permits.delete(request); this.busy.add(request);
    try {
      this.update(row, 'submitting');
      try {
        const reply = await client.projectBundleSubmit(row.intent, true); this.context(client, row);
        return this.update(row, reply.status, reply);
      } catch (error) {
        this.update(row, (error as {code?: unknown} | null)?.code === 'refused' ? 'refused-before-submit' : 'unknown'); throw error;
      }
    } finally {this.busy.delete(request);}
  }
  async observe(client: Client, request: string): Promise<SavedBundle> {
    const row = this.get(request); this.context(client, row);
    if (this.busy.has(request)) throw new Error('This suggestion observation is already running.');
    if (settled.includes(row.phase)) return row;
    this.permits.delete(request); this.busy.add(request);
    try {
      const reply = await client.projectBundleResult(row.intent); this.context(client, row);
      return this.update(row, reply.status, reply);
    } catch (error) {this.update(row, 'unknown'); throw error;}
    finally {this.busy.delete(request);}
  }
}
