import {observeWorkspaceSession, type WorkspaceSessionObservation} from './workspace-session';
import { createHash } from 'node:crypto';
import type { ShipClient, WorkspaceRequestParameters } from './ship-client';
import { asRecord, isInteger, validUnicode, type JsonObject } from './protocol';

export type WorkspaceRequestStatus = 'reserved' | 'submitted' | 'unknown' | 'recorded' | 'refused';
export interface WorkspaceRequestRow {
  requester: string; nonce: string; requestDigest: string; project: string; session: string; status: WorkspaceRequestStatus;
}
export interface WorkspaceRequestDetail extends WorkspaceRequestRow, JsonObject {
  owner: string; binding: string; generation: string; authority: string; noteHost: string; note: string;
  nativeRequest: string; text: string; sourceDesk: string; sourceRevision: string; sourceRoot: string; sourceCommit: string;
  evidence: string | null; recoveryRequired: boolean; taskCompleted: false; executionAuthorized: false;
}
export interface WorkspaceRequestCompletion extends JsonObject {
  status: 'unverified' | 'pending' | 'superseded' | 'complete' | 'refused';
  instruction: string | null; judgment: string | null; evidence: string[]; reason: string; taskCompleted: boolean;
}
interface Marker {
  requester: string; nonce: string; requestDigest: string; fingerprint?: string; attempted: boolean;
  settled?: {status: 'recorded' | 'refused'; evidence: string};
}
export interface WorkspaceRequestJournal { version: 1; owner: string; entries: Marker[] }
export interface WorkspaceRequestPersistence { saved?: unknown; save(journal: WorkspaceRequestJournal): Promise<void>; claim?(row: WorkspaceRequestRow): Promise<void> }
interface RecordState { marker: Marker; value?: WorkspaceRequestDetail; fresh: boolean; uncertain: boolean }
const statuses = ['reserved', 'submitted', 'unknown', 'recorded', 'refused'];
const ship = (v: unknown): v is string => typeof v === 'string' && v.length <= 128 && /^~(?:[a-z]{3}|[a-z]{6}(?:-[a-z]{6}){0,3}(?:--[a-z]{6}(?:-[a-z]{6}){3})?)$/.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && v.length <= 81 && /^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(v) && BigInt(v.replaceAll('.', '')) < 1n << 256n;
const decimal = (v: unknown): v is string => typeof v === 'string' && v.length <= 26 && /^[1-9][0-9]{0,2}(?:\.[0-9]{3})*$/.test(v) && BigInt(v.replaceAll('.', '')) < 1n << 64n;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && validUnicode(v) && !v.includes('\0') && Buffer.byteLength(v) <= max;
const uv = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && /^0v(?:0|[1-9a-v][0-9a-v]{0,4}(?:\.[0-9a-v]{5})*)$/.test(v) && [...v.slice(2).replaceAll('.', '')].reduce((n, c) => n * 32n + BigInt(parseInt(c, 32)), 0n) < 1n << 256n;
const key = (row: {requester: string; nonce: string}) => JSON.stringify([row.requester, row.nonce]);
const identity = (row: JsonObject) => ship(row.requester) && uuid(row.nonce) && digest(row.requestDigest);
const rowValid = (v: JsonObject) => identity(v) && digest(v.session) && text(v.project, 128) && !!v.project && statuses.includes(String(v.status));
const immutable = ['owner', 'requester', 'nonce', 'requestDigest', 'binding', 'generation', 'authority', 'project', 'noteHost', 'note', 'session', 'nativeRequest', 'text', 'sourceDesk', 'sourceRevision', 'sourceRoot', 'sourceCommit'];
function fingerprint(v: WorkspaceRequestDetail): string {
  const m = v.message as JsonObject | null | undefined;
  return createHash('sha256').update(JSON.stringify([...immutable.map(k => v[k]), m ? [m.author, m.eid, m.revision, m.content] : null])).digest('hex');
}
function detail(value: JsonObject, owner: string, row: WorkspaceRequestRow): WorkspaceRequestDetail {
  const m = value.message === null || value.message === undefined ? null : asRecord(value.message);
  if (value.schema !== 'readymade-workspace-request-v1' || value.owner !== owner || !rowValid(value) ||
      !['requester', 'nonce', 'requestDigest', 'project', 'session'].every(k => value[k] === row[k as keyof WorkspaceRequestRow]) ||
      ![value.binding, value.nativeRequest].every(digest) || ![value.authority, value.noteHost].every(ship) ||
      ![value.generation, value.sourceRevision].every(decimal) || !text(value.note, 256) || !value.note || !text(value.text, 32768) || !value.text ||
      typeof value.sourceDesk !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/.test(value.sourceDesk) || ![value.sourceRoot, value.sourceCommit].every(uv) ||
      value.retainedOnly !== true || value.executionAuthorized !== false || value.taskCompleted !== false || value.mayResubmit !== false ||
      value.recoveryRequired !== ['submitted', 'unknown'].includes(String(value.status)) ||
      (['recorded', 'refused'].includes(String(value.status)) ? !digest(value.evidence) : value.evidence !== null) ||
      m && (!ship(m.author) || !uv(m.eid) || !(m.revision === '0' || decimal(m.revision)) || !(m.content === '0x0' || digest(m.content)))) throw new Error('Mismatched native request.');
  return structuredClone(value) as WorkspaceRequestDetail;
}

/** Presentation projection. Only native admission/receipts authorize or attest work. */
export class WorkspaceRequestStore {
  private rows: WorkspaceRequestRow[] = [];
  private linked?: WorkspaceSessionObservation;
  private completion?: WorkspaceRequestCompletion;
  private page?: {catalog: string; total: number; next: number | null};
  private selected?: WorkspaceRequestRow;
  private readonly records = new Map<string, RecordState>();
  private permission?: {scope: string; admission: string};
  private reviewed?: {fingerprint: string; scope: string};
  private working = false;
  private closed = false;
  private stale = false;
  notice = 'Load retained requests to begin.';
  constructor(readonly owner: string, private readonly transport: Pick<ShipClient, 'workspaceRequest'> & Partial<Pick<ShipClient, 'codingState'>>, private readonly persistence?: WorkspaceRequestPersistence) {
    if (!ship(owner)) throw new Error('Invalid workspace owner.');
    if (persistence?.saved !== undefined) {
      const saved = asRecord(persistence.saved);
      if (saved.version !== 1 || saved.owner !== owner || !Array.isArray(saved.entries) || saved.entries.length > 512 || Object.keys(saved).some(k => !['version', 'owner', 'entries'].includes(k))) throw new Error('Invalid request journal.');
      for (const value of saved.entries) {
        const m = asRecord(value), settled = m.settled === undefined ? undefined : asRecord(m.settled);
        if (!identity(m) || typeof m.attempted !== 'boolean' || Object.keys(m).some(k => !['requester', 'nonce', 'requestDigest', 'fingerprint', 'attempted', 'settled'].includes(k)) ||
            m.fingerprint !== undefined && (typeof m.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(m.fingerprint)) ||
            settled && (!m.attempted || Object.keys(settled).some(k => !['status', 'evidence'].includes(k)) || !['recorded', 'refused'].includes(String(settled.status)) || !digest(settled.evidence))) throw new Error('Invalid request journal marker.');
        const marker = structuredClone(m) as unknown as Marker;
        if (this.records.has(key(marker))) throw new Error('Duplicate request journal identity.');
        this.records.set(key(marker), {marker, fresh: false, uncertain: marker.attempted && !marker.settled});
      }
    }
  }
  get requests(): readonly WorkspaceRequestRow[] { return structuredClone(this.rows); }
  get selection(): WorkspaceRequestRow | undefined { return this.selected && structuredClone(this.selected); }
  get observation(): WorkspaceRequestDetail | undefined { const value = this.active()?.value; return value && structuredClone(value); }
  get catalog(): Readonly<{catalog: string; total: number; next: number | null}> | undefined { return this.page && {...this.page}; }
  get codingOutcome(): WorkspaceSessionObservation | undefined { return this.linked && structuredClone(this.linked); }
  get requestOutcome(): WorkspaceRequestCompletion | undefined { return this.completion && structuredClone(this.completion); }
  get busy(): boolean { return this.working; }
  get uncertain(): boolean { return this.active()?.uncertain ?? false; }
  get canReview(): boolean { const r = this.active(); return !this.closed && !this.working && !!(r?.fresh && r.value?.status === 'reserved' && !r.marker.attempted && !r.uncertain && this.permission); }
  get canSubmit(): boolean { return this.canReview && !!this.reviewed && this.reviewed.scope === this.permission?.scope && this.reviewed.fingerprint === this.active()?.marker.fingerprint; }
  get canRecover(): boolean { const r = this.active(); return !this.closed && !this.working && !!(r && (r.marker.attempted || r.value?.recoveryRequired)); }
  exportJournal(): WorkspaceRequestJournal { return {version: 1, owner: this.owner, entries: [...this.records.values()].map(r => structuredClone(r.marker))}; }
  exportSelection(): WorkspaceRequestRow | undefined { return this.selection; }
  private active(): RecordState | undefined { return this.selected && this.records.get(key(this.selected)); }
  private idle(): void { if (this.closed || this.working) throw new Error('Workspace request view is closed or busy.'); }
  private invalidate(): void { this.completion = undefined; this.linked = undefined; this.permission = undefined; this.reviewed = undefined; }
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    this.idle(); this.working = true;
    try { const result = await operation(); if (this.closed) throw new Error('Workspace request view closed.'); return result; }
    catch (error) { this.invalidate(); this.notice = error instanceof Error ? error.message : 'Native request unavailable.'; throw error; }
    finally { this.working = false; }
  }
  private async request<K extends keyof WorkspaceRequestParameters>(operation: K, params: WorkspaceRequestParameters[K], statuses = [200]): Promise<JsonObject> {
    const reply = await this.transport.workspaceRequest(operation, params);
    if (this.closed || !statuses.includes(reply.status)) throw new Error('Native observation unavailable or changed.');
    const value = asRecord(reply.body);
    if (Buffer.byteLength(JSON.stringify(value)) > 65536) throw new Error('Native observation exceeded its bound.');
    return value;
  }
  async load(next = false): Promise<void> {
    await this.run(async () => {
      this.invalidate(); if (this.active()) this.active()!.fresh = false;
      if (next && (this.stale || !this.page || this.page.next === null)) throw new Error('Load requests again before paging.');
      const offset = next ? this.page!.next! : 0, catalog = next ? this.page!.catalog : undefined;
      this.stale = true;
      const v = await this.request('catalog', {offset, ...(catalog ? {catalog} : {})});
      if (v.schema !== 'readymade-workspace-catalog-v1' || v.owner !== this.owner || !digest(v.catalog) || catalog && v.catalog !== catalog ||
          v.executionAuthorized !== false || v.offset !== offset || !isInteger(v.total, 0, 512) || offset > v.total || next && v.total !== this.page!.total ||
          !Array.isArray(v.requests) || v.requests.length !== Math.min(64, v.total - offset) || !v.requests.every(r => rowValid(asRecord(r))) ||
          v.next !== (offset + v.requests.length === v.total ? null : offset + v.requests.length)) throw new Error('Invalid or changed request catalog.');
      const rows = (next ? [...this.rows, ...v.requests] : v.requests) as WorkspaceRequestRow[];
      if (new Set(rows.map(key)).size !== rows.length || rows.some(r => {
        const old = this.records.get(key(r))?.marker; return old && old.requestDigest !== r.requestDigest;
      }) || this.selected && rows.some(r => key(r) === key(this.selected!) && ['requestDigest', 'project', 'session'].some(k => r[k as keyof WorkspaceRequestRow] !== this.selected![k as keyof WorkspaceRequestRow]))) throw new Error('Retained request identity changed.');
      this.rows = structuredClone(rows); this.page = {catalog: v.catalog, total: v.total, next: v.next as number | null}; this.stale = false;
      this.notice = `${rows.length} of ${v.total} retained requests loaded. No execution submitted.`;
    });
  }
  select(row?: WorkspaceRequestRow): void {
    this.idle(); this.invalidate();
    if (!row) { this.selected = undefined; return; }
    const found = this.rows.find(r => key(r) === key(row));
    if (this.stale || !found || ['requestDigest', 'project', 'session'].some(k => found[k as keyof WorkspaceRequestRow] !== row[k as keyof WorkspaceRequestRow])) throw new Error('Select an exact current catalog request.');
    let record = this.records.get(key(found));
    if (!record) {
      if (this.records.size >= 512) throw new Error('Request view capacity reached.');
      record = {marker: {requester: found.requester, nonce: found.nonce, requestDigest: found.requestDigest, attempted: false}, fresh: false, uncertain: false};
      this.records.set(key(found), record);
    }
    record.fresh = false; this.selected = structuredClone(found); this.notice = 'Read the retained request and check execution permissions.';
  }
  private context(): {row: WorkspaceRequestRow; record: RecordState} {
    const record = this.active(); if (!this.selected || !record) throw new Error('Select a retained request.');
    return {row: this.selected, record};
  }
  private async accept(value: JsonObject, row: WorkspaceRequestRow, record: RecordState): Promise<void> {
    const v = detail(value, this.owner, row), hash = fingerprint(v), marker = record.marker;
    if (marker.fingerprint && marker.fingerprint !== hash || marker.attempted && v.status === 'reserved' || marker.settled && (marker.settled.status !== v.status || marker.settled.evidence !== v.evidence)) throw new Error('Native request changed or submission remains unconfirmed.');
    marker.fingerprint = hash;
    if (v.status !== 'reserved') marker.attempted = true;
    if (v.status === 'recorded' || v.status === 'refused') marker.settled = {status: v.status, evidence: v.evidence!};
    if (this.persistence) await this.persistence.save(this.exportJournal());
    record.value = v; record.fresh = true; record.uncertain = v.status === 'unknown';
    this.notice = ({reserved: 'Request retained; execution has not been submitted.', submitted: 'Submission retained; instruction acceptance is unconfirmed.', unknown: 'Outcome unknown. Check native outcome; do not submit again.', recorded: 'Instruction recorded. Task completion has not been verified.', refused: 'Instruction refused. No task completion is claimed.'})[v.status];
  }
  async read(): Promise<void> {
    await this.run(async () => { this.invalidate(); const {row, record} = this.context(); record.fresh = false;
      await this.accept(await this.request('read', {requester: row.requester, nonce: row.nonce}, [200, 202, 409]), row, record); });
  }
  async observeCompletion(): Promise<void> {
    await this.run(async () => {
      this.invalidate(); const {row, record} = this.context(), original = record.value;
      if (!record.fresh || !original || original.status !== 'recorded' || !original.evidence) throw new Error('Read a recorded request before checking its completion.');
      const v = await this.request('completion', {requester: row.requester, nonce: row.nonce});
      const states = ['unverified', 'pending', 'superseded', 'complete', 'refused'];
      if (v.schema !== 'readymade-workspace-completion-v1' ||
          !['owner', 'requester', 'nonce', 'requestDigest', 'nativeRequest', 'session'].every(k => v[k] === original[k]) ||
          v.submissionEvidence !== original.evidence || !states.includes(String(v.status)) ||
          v.executionAuthorized !== false || v.taskCompleted !== (v.status === 'complete') ||
          ![v.instruction, v.judgment].every(id => id === null || digest(id)) ||
          !Array.isArray(v.evidence) || v.evidence.length > 4096 || !v.evidence.every(digest) ||
          typeof v.reason !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/.test(v.reason) ||
          (v.status === 'unverified' ? v.instruction !== null : !digest(v.instruction)) ||
          (['complete', 'refused'].includes(String(v.status)) ? !digest(v.judgment) : v.judgment !== null) ||
          v.status === 'complete' && (!v.evidence.length || v.reason !== 'native-completion') ||
          v.status === 'superseded' && v.reason !== 'later-owner-instruction') throw new Error('Mismatched native request completion.');
      this.completion = structuredClone(v) as WorkspaceRequestCompletion;
      this.notice = `Request ${v.status}: ${v.reason}.`;
    });
  }
  async observeCoding(): Promise<void> {
    await this.run(async () => {
      this.invalidate(); const {record} = this.context();
      if (!record.fresh || !record.value || !this.transport.codingState) throw new Error('Read the request before observing its linked coding session.');
      const observed = await observeWorkspaceSession({codingState: this.transport.codingState.bind(this.transport)}, record.value);
      if (this.closed) throw new Error('Workspace request view closed.');
      this.linked = observed;
    });
  }
  async preview(): Promise<void> {
    await this.run(async () => { this.invalidate(); const {row} = this.context();
      const v = await this.request('preview', {requester: row.requester, nonce: row.nonce});
      if (v.schema !== 'readymade-workspace-preview-v1' || v.owner !== this.owner || !['requester', 'nonce', 'requestDigest'].every(k => v[k] === row[k as keyof WorkspaceRequestRow]) ||
          !digest(v.scope) || !digest(v.admission) || v.executionAuthorized !== false || v.taskCompleted !== false || v.requiresFreshAdmission !== true) throw new Error('Invalid execution permission observation.');
      this.permission = {scope: v.scope, admission: v.admission}; this.notice = 'Permissions observed. Review this exact request before submitting.';
    });
  }
  review(): Readonly<{fingerprint: string; scope: string}> {
    this.idle(); if (!this.canReview) throw new Error('Read the reserved request and check current permissions before review.');
    this.reviewed = {fingerprint: this.active()!.marker.fingerprint!, scope: this.permission!.scope}; return {...this.reviewed};
  }
  async submit(): Promise<void> { this.idle(); if (!this.canSubmit) throw new Error('Review this exact request and scope before submitting.'); await this.mutate('submit'); }
  async recover(): Promise<void> { this.idle(); if (!this.canRecover) throw new Error('No attempted native submission to recover.'); await this.mutate('recover'); }
  private async mutate(operation: 'submit' | 'recover'): Promise<void> {
    await this.run(async () => {
      if (!this.persistence) throw new Error('Durable request journal required before submission or recovery.');
      const {row, record} = this.context(), scope = this.reviewed?.scope;
      this.invalidate(); record.fresh = false; record.marker.attempted = true; record.uncertain = true;
      await this.persistence.save(this.exportJournal()); // Must finish before the one allowed POST.
      if (operation === 'submit') {
        if (!this.persistence.claim) throw new Error('An exclusive shared request claim is required before submission.');
        await this.persistence.claim(structuredClone(row));
      }
      if (this.closed) throw new Error('Workspace request view closed before submission.');
      const params = {requester: row.requester, nonce: row.nonce};
      const value = operation === 'submit' ? await this.request('submit', {...params, requestDigest: row.requestDigest, scope: scope!}, [200, 202, 409]) : await this.request('recover', params, [200, 202, 409]);
      await this.accept(value, row, record);
    });
  }
  dispose(): void { this.closed = true; this.invalidate(); }
}
