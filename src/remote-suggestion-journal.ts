import * as fs from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {remoteDraftRecord, type RemoteDraftRecord} from './remote-draft-store';
import {remoteSuggestionIntent, newRemoteSuggestionRequest, remoteSuggestionReply, remoteSuggestionRecoveryReply,
  type RemoteSuggestionIntent, type RemoteSuggestionReply, type RemoteSuggestionRecoveryReply} from './remote-project-suggest';
import {remoteProjectViewJSON, type RemoteSourceObservation} from './remote-project-view';
import {asRecord} from './protocol';
import {ShipClientError, type ShipClient} from './ship-client';

export type SuggestionPhase = 'claimed' | 'submitting' | 'unknown' | 'refused-before-submit' | RemoteSuggestionReply['status'];
export interface RecoveryObservation {
  readonly at: number; readonly phase: 'requested' | 'unknown' | RemoteSuggestionRecoveryReply['status'];
  readonly reply?: RemoteSuggestionRecoveryReply;
}
export interface SavedSuggestion {
  readonly version: 1; readonly draftId: string; readonly request: string;
  readonly draft: RemoteDraftRecord; readonly intent: RemoteSuggestionIntent;
  readonly phase: SuggestionPhase; readonly updatedAt: number; readonly reply?: RemoteSuggestionReply;
  readonly recoveries?: readonly RecoveryObservation[];
}
type Client = Pick<ShipClient, 'origin' | 'browserCookies' | 'projectSuggestionSubmit' | 'projectSuggestionResult'> &
  Partial<Pick<ShipClient, 'projectSuggestionRecover' | 'projectSuggestionRecoveryResult'>>;
const phases: readonly string[] = ['claimed', 'submitting', 'unknown', 'refused-before-submit', 'watching', 'sent', 'recorded', 'refused', 'uncertain', 'missing', 'expired'];
function fail(): never {throw new Error('Invalid retained suggestion intent.');}
function copy<T>(value: T): T {return JSON.parse(JSON.stringify(value)) as T;}
function bind(draft: RemoteDraftRecord, intent: RemoteSuggestionIntent): void {
  const old = draft.observation, fresh = intent.observation;
  for (const field of ['origin', 'owner', 'peer', 'project', 'generation', 'grant', 'root', 'snapshotDigest', 'desk', 'revision'] as const) {
    if (old[field] !== fresh[field]) throw new Error('Shared source or grant changed. Review a new draft before suggesting.');
  }
  const before = old.files.find(f => f.path === draft.path), now = fresh.files.find(f => f.path === draft.path);
  if (!before || !now || before.hash !== now.hash || before.text !== now.text || intent.path !== draft.path ||
      intent.source !== draft.text || intent.source === before.text || old.request === fresh.request) fail();
}
function historical(value: unknown, intent: RemoteSuggestionIntent): RemoteSuggestionReply {
  const r = asRecord(value);
  let reply: RemoteSuggestionReply;
  if (r.status === 'missing' || r.status === 'expired') {
    reply = remoteSuggestionReply(r.status === 'missing' ? 404 : 410, r.status === 'missing'
      ? {status: 'unknown', message: 'Suggestion not retained; do not resend an unknown outcome.'}
      : {status: 'expired', message: 'Suggestion observation expired; no retry issued.'}, intent);
    if (Object.keys(r).length !== Object.keys(reply).length || Object.entries(reply).some(([k, v]) => r[k] !== v)) fail();
  } else reply = remoteSuggestionReply(r.status === 'watching' || r.status === 'sent' ? 202 : 200,
    {schema: 'readymade-project-suggest-result-v1', ...r}, intent);
  return reply;
}
function historicalRecovery(value: unknown, intent: RemoteSuggestionIntent): RemoteSuggestionRecoveryReply {
  const r = asRecord(value);
  if (r.status === 'missing' || r.status === 'expired') {
    const reply = remoteSuggestionRecoveryReply(r.status === 'missing' ? 404 : 410, r.status === 'missing'
      ? {status: 'unknown', message: 'Recovery observation not retained; original outcome stays unknown.'}
      : {status: 'expired', message: 'Recovery observation expired; no suggestion resent.'}, intent);
    if (Object.keys(r).length !== Object.keys(reply).length || Object.entries(reply).some(([k, v]) => r[k] !== v)) fail();
    return reply;
  }
  return remoteSuggestionRecoveryReply(r.status === 'watching' ? 202 : 200,
    {schema: 'readymade-project-suggest-recovery-result-v1', ...r}, intent);
}
function recoveryHistory(value: unknown, intent: RemoteSuggestionIntent): readonly RecoveryObservation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) fail();
  let previous = -1;
  return value.map(item => {
    const r = asRecord(item), keys = ['at', 'phase', ...(r.reply === undefined ? [] : ['reply'])];
    if (Object.keys(r).length !== keys.length || !keys.every(k => Object.hasOwn(r, k)) ||
        !Number.isSafeInteger(r.at) || (r.at as number) <= previous) fail();
    previous = r.at as number;
    const reply = r.reply === undefined ? undefined : historicalRecovery(r.reply, intent);
    if (reply ? reply.status !== r.phase : !['requested', 'unknown'].includes(String(r.phase))) fail();
    return {at: previous, phase: r.phase as RecoveryObservation['phase'], ...(reply ? {reply} : {})};
  });
}
function validate(value: unknown): SavedSuggestion {
  const r = asRecord(value), keys = ['version', 'draftId', 'request', 'draft', 'intent', 'phase', 'updatedAt', ...(r.reply === undefined ? [] : ['reply']), ...(r.recoveries === undefined ? [] : ['recoveries'])];
  if (Object.keys(r).length !== keys.length || !keys.every(k => Object.hasOwn(r, k))) fail();
  const draft = remoteDraftRecord(r.draft), intent = remoteSuggestionIntent(r.intent); bind(draft, intent);
  if (r.version !== 1 || r.draftId !== draft.id || r.request !== intent.request || typeof r.phase !== 'string' || !phases.includes(r.phase) ||
      !Number.isSafeInteger(r.updatedAt) || (r.updatedAt as number) < 0) fail();
  const reply = r.reply === undefined ? undefined : historical(r.reply, intent);
  if (reply ? reply.status !== r.phase : !['claimed', 'submitting', 'unknown', 'refused-before-submit'].includes(r.phase)) fail();
  return {version: 1, draftId: draft.id, request: intent.request, draft, intent,
    phase: r.phase as SuggestionPhase, updatedAt: r.updatedAt as number, ...(reply ? {reply} : {}),
    ...(r.recoveries === undefined ? {} : {recoveries: recoveryHistory(r.recoveries, intent)})};
}
function exists(file: string): boolean {
  try {fs.lstatSync(file); return true;} catch (e) {if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e;}
}
function secure(s: fs.Stats, directory = false): void {
  if ((directory ? !s.isDirectory() : !s.isFile()) || s.isSymbolicLink() ||
      process.getuid && (s.uid !== process.getuid() || (s.mode & 0o077) !== 0)) throw new Error('Suggestion storage must be private and owned.');
}

/** An immutable claim permits one live dispatch. Restored claims only permit observation. */
export class RemoteSuggestionJournal {
  private readonly permits = new Set<string>();
  private readonly busy = new Set<string>();
  constructor(readonly directory: string) {}
  private read(file: string): SavedSuggestion {
    secure(fs.lstatSync(file)); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const info = fs.fstatSync(fd); secure(info); if (info.size > 524288) fail();
      return validate(remoteProjectViewJSON(fs.readFileSync(fd)));
    } finally {fs.closeSync(fd);}
  }
  list(): readonly SavedSuggestion[] {
    if (!exists(this.directory)) return [];
    secure(fs.lstatSync(this.directory), true);
    const files = fs.readdirSync(this.directory).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
    if (files.length > 64) throw new Error('Suggestion journal capacity exceeded.');
    const requests = new Set<string>();
    return files.map(name => {
      const row = this.read(path.join(this.directory, name));
      if (name !== `${row.draftId}.json` || requests.has(row.request)) fail();
      requests.add(row.request); return copy(row);
    });
  }
  get(request: string): SavedSuggestion {
    const row = this.list().find(r => r.request === request);
    if (!row) throw new Error('Retained suggestion not found.'); return row;
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
  private write(value: SavedSuggestion, create = false): SavedSuggestion {
    const row = validate(value), bytes = Buffer.from(JSON.stringify(row)); if (bytes.length > 524288) fail();
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`), target = path.join(this.directory, `${row.draftId}.json`);
    const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try {fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    try {
      if (create) fs.linkSync(temporary, target); else fs.renameSync(temporary, target);
      const dir = fs.openSync(this.directory, fs.constants.O_RDONLY); try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}
    } finally {fs.rmSync(temporary, {force: true});}
    return copy(row);
  }
  claim(value: RemoteDraftRecord, source: string, freshObservation: RemoteSourceObservation): SavedSuggestion {
    const draft = remoteDraftRecord(value), intent = remoteSuggestionIntent({observation: freshObservation, path: draft.path, source, request: newRemoteSuggestionRequest()});
    bind(draft, intent);
    const row = this.locked(() => {
      const all = this.list();
      if (all.some(r => r.draftId === draft.id || r.request === intent.request)) throw new Error('This draft already has a retained suggestion. Check its result; it will not be sent again.');
      if (all.length >= 64) throw new Error('64 suggestion intents are retained.');
      return this.write({version: 1, draftId: draft.id, request: intent.request, draft, intent, phase: 'claimed', updatedAt: Date.now()}, true);
    });
    this.permits.add(row.request); return row;
  }
  private context(client: Client, row: SavedSuggestion): void {
    const cookies = client.browserCookies(client.origin), o = row.intent.observation;
    if (client.origin !== o.origin || cookies.length !== 1 || cookies[0].name !== `urbauth-${o.peer}`) throw new Error('Suggestion belongs to another ship connection.');
  }
  private update(row: SavedSuggestion, phase: SuggestionPhase, reply?: RemoteSuggestionReply): SavedSuggestion {
    return this.locked(() => {
      const held = this.get(row.request);
      if (JSON.stringify(held.intent) !== JSON.stringify(row.intent) || JSON.stringify(held.draft) !== JSON.stringify(row.draft)) fail();
      if (phase === 'submitting' && held.phase !== 'claimed') throw new Error('Suggestion was observed in another window; do not submit it again.');
      if (held.recoveries?.length || ['recorded', 'refused', 'refused-before-submit'].includes(held.phase)) return held;
      return this.write({version: 1, draftId: held.draftId, request: held.request, draft: held.draft, intent: held.intent,
        phase, updatedAt: Math.max(Date.now(), held.updatedAt + 1), ...(reply ? {reply} : {})});
    });
  }
  async submit(client: Client, request: string): Promise<SavedSuggestion> {
    const row = this.get(request); this.context(client, row);
    if (row.phase !== 'claimed' || !this.permits.has(request) || this.busy.has(request)) throw new Error('Only a newly claimed suggestion can be sent once. Observe this retained request instead.');
    this.permits.delete(request); this.busy.add(request);
    try {
      this.update(row, 'submitting'); // Requires the still-unobserved claim under the cross-window lock.
      try {
        const reply = await client.projectSuggestionSubmit(row.intent, true); this.context(client, row);
        return this.update(row, reply.status, historical(reply, row.intent));
      } catch (error) {
        this.update(row, error instanceof ShipClientError && error.code === 'refused' ? 'refused-before-submit' : 'unknown'); throw error;
      }
    } finally {this.busy.delete(request);}
  }
  async observe(client: Client, request: string): Promise<SavedSuggestion> {
    if (this.get(request).recoveries?.length) return this.observeRecovery(client, request);
    const row = this.get(request); this.context(client, row);
    if (this.busy.has(request)) throw new Error('This suggestion observation is already running.');
    if (['recorded', 'refused', 'refused-before-submit'].includes(row.phase)) return row;
    this.permits.delete(request); this.busy.add(request);
    try {
      const reply = await client.projectSuggestionResult(row.intent); this.context(client, row);
      return this.update(row, reply.status, historical(reply, row.intent));
    } catch (error) {this.update(row, 'unknown'); throw error;}
    finally {this.busy.delete(request);}
  }
  private appendRecovery(row: SavedSuggestion, phase: RecoveryObservation['phase'], reply?: RemoteSuggestionRecoveryReply): SavedSuggestion {
    return this.locked(() => {
      const held = this.get(row.request), history = held.recoveries ?? [], last = history.at(-1);
      if (JSON.stringify(held.intent) !== JSON.stringify(row.intent) || JSON.stringify(held.draft) !== JSON.stringify(row.draft)) fail();
      if (last?.phase === 'recorded') return held;
      if (phase === 'requested' && (!['missing', 'expired'].includes(held.phase) || last && !['missing', 'expired'].includes(last.phase))) {
        throw new Error('Observe the retained recovery; a new explicit recovery requires exact missing or expired evidence.');
      }
      if (history.length >= 32) throw new Error('Recovery observation history is full; retained evidence was not removed.');
      const at = Math.max(Date.now(), (last?.at ?? held.updatedAt) + 1);
      return this.write({...held, recoveries: [...history, {at, phase, ...(reply ? {reply} : {})}]});
    });
  }
  /** Start only an explicitly requested read after exact missing/expired send evidence. */
  async recover(client: Client, request: string, consent: boolean): Promise<SavedSuggestion> {
    if (consent !== true) throw new Error('Explicit receipt recovery consent required.');
    const row = this.get(request); this.context(client, row);
    if (!client.projectSuggestionRecover) throw new Error('Receipt recovery transport unavailable.');
    if (this.busy.has(request)) throw new Error('This suggestion observation is already running.');
    this.permits.delete(request); this.busy.add(request);
    try {
      const prepared = this.appendRecovery(row, 'requested');
      if (prepared.recoveries?.at(-1)?.phase === 'recorded') return prepared;
      try {
        const reply = await client.projectSuggestionRecover(row.intent, true); this.context(client, row);
        return this.appendRecovery(row, reply.status, historicalRecovery(reply, row.intent));
      } catch (error) {this.appendRecovery(row, 'unknown'); throw error;}
    } finally {this.busy.delete(request);}
  }
  async observeRecovery(client: Client, request: string): Promise<SavedSuggestion> {
    const row = this.get(request); this.context(client, row);
    if (!row.recoveries?.length || !client.projectSuggestionRecoveryResult) throw new Error('No retained recovery to observe.');
    if (row.recoveries.at(-1)?.phase === 'recorded') return row;
    if (this.busy.has(request)) throw new Error('This suggestion observation is already running.');
    this.busy.add(request);
    try {
      const reply = await client.projectSuggestionRecoveryResult(row.intent); this.context(client, row);
      return this.appendRecovery(row, reply.status, historicalRecovery(reply, row.intent));
    } catch (error) {this.appendRecovery(row, 'unknown'); throw error;}
    finally {this.busy.delete(request);}
  }

}
