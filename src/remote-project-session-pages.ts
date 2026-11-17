import {randomBytes} from 'node:crypto';
import {asRecord, type JsonObject} from './protocol';
import {remoteShip} from './remote-project-view';
import {remoteProjectSessionsSelector, remoteProjectSessionsReply, remoteSessionShortId,
  type RemoteProjectSessionsTarget, type RemoteProjectSessionsSelector, type RemoteSharedSession, type RemoteSessionRow} from './remote-project-sessions';

export const SESSION_PAGE_BYTES = 65536;
export interface SessionPageSelector extends RemoteProjectSessionsSelector {readonly offset: number; readonly grantCatalog: string}
export interface SessionPageObservation {
  readonly owner: string; readonly peer: string; readonly observedAt: string; readonly grantCatalog: string;
  readonly catalogKind: 'standing-grants'; readonly totalGrants: number; readonly examined: number;
  readonly offset: number; readonly nextOffset: number | null; readonly sessions: readonly RemoteSharedSession[];
}
export interface SessionPageReply extends SessionPageSelector {
  readonly peer: string; readonly status: 'pending' | 'ready' | 'refused' | 'uncertain' | 'missing' | 'expired';
  readonly observation: SessionPageObservation | null;
}
export class SessionPageError extends Error {
  constructor(readonly code: 'invalid' | 'upgrade' | 'refused' | 'changed') {
    super(code === 'upgrade' ? 'Update this ship’s collaboration service to read all shared sessions.' :
      code === 'refused' ? 'Your ship refused this page request; no complete list was accepted.' :
      code === 'changed' ? 'The shared session list or connection changed. Refresh to start a new observation.' :
      'Invalid or uncorrelated shared session page; no complete list was accepted.');
  }
}
function invalid(): never {throw new SessionPageError('invalid');}
function exact(value: unknown, keys: readonly string[]): JsonObject {
  const row = asRecord(value);
  if (Object.getPrototypeOf(row) !== Object.prototype || Object.keys(row).length !== keys.length || keys.some(k => !Object.hasOwn(row, k))) invalid();
  return row;
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 81 && /^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(value) && value.replaceAll('.', '').length <= 66;
}
export function sessionPageSelector(value: unknown): SessionPageSelector {
  const r = exact(value, ['owner', 'project', 'request', 'offset', 'grantCatalog']);
  const key = remoteProjectSessionsSelector({owner: r.owner, project: r.project, request: r.request});
  if (!Number.isInteger(r.offset) || (r.offset as number) < 0 || (r.offset as number) >= 512 ||
      !(digest(r.grantCatalog) || r.grantCatalog === '0x0' && r.offset === 0)) invalid();
  return Object.freeze({...key, offset: r.offset as number, grantCatalog: r.grantCatalog as string});
}
export function sessionPageHeaders(value: SessionPageSelector): Record<string, string> {
  const s = sessionPageSelector(value);
  return {'x-readymade-project-owner': s.owner, 'x-readymade-project': Buffer.from(s.project).toString('latin1'),
    'x-readymade-project-session-page-request': s.request, 'x-readymade-session-offset': String(s.offset), 'x-readymade-grant-catalog': s.grantCatalog};
}
/** Reuse the established row/source/date validator, after checking the exact v2 envelope. */
export function sessionPageReply(status: number, value: unknown, expected: SessionPageSelector, peer: string, get: boolean): SessionPageReply {
  const key = sessionPageSelector(expected);
  if (!remoteShip(peer) || peer === key.owner || Buffer.byteLength(JSON.stringify(value)) > SESSION_PAGE_BYTES) invalid();
  if (get && (status === 404 || status === 410)) {
    const r = exact(value, ['status', 'message']);
    if (!(status === 404 && r.status === 'unknown' && r.message === 'Page not retained; no retry was issued.' ||
          status === 410 && r.status === 'expired' && r.message === 'Historical page expired.')) invalid();
    return Object.freeze({...key, peer, status: status === 404 ? 'missing' : 'expired', observation: null});
  }
  const r = exact(value, ['schema', 'owner', 'peer', 'project', 'request', 'offset', 'expectedGrantCatalog', 'status', 'reason', 'deadline', 'retainedUntil', 'permissionGranted', 'observation']);
  if (r.schema !== 'readymade-project-session-page-result-v2' || r.offset !== key.offset || r.expectedGrantCatalog !== key.grantCatalog) invalid();
  let observation: JsonObject | null = null;
  if (r.status === 'ready') {
    observation = exact(r.observation, ['owner', 'peer', 'observedAt', 'grantCatalog', 'catalogKind', 'totalGrants', 'examined', 'offset', 'nextOffset', 'sessions']);
    const o = observation, total = o.totalGrants, examined = o.examined;
    if (!digest(o.grantCatalog) || o.catalogKind !== 'standing-grants' || !Number.isInteger(total) || (total as number) < 0 || (total as number) > 512 ||
        !(total === 0 && key.offset === 0 || key.offset < (total as number)) || o.offset !== key.offset ||
        examined !== Math.min(64, (total as number) - key.offset) || !Array.isArray(o.sessions) || o.sessions.length > (examined as number) ||
        o.nextOffset !== (key.offset + (examined as number) === total ? null : key.offset + (examined as number)) ||
        key.grantCatalog !== '0x0' && key.grantCatalog !== o.grantCatalog) invalid();
  } else if (r.observation !== null) invalid();
  const legacy = remoteProjectSessionsReply(status, {
    schema: 'readymade-project-sessions-result-v1', owner: r.owner, peer: r.peer, project: r.project, request: r.request,
    status: r.status, reason: r.reason, deadline: r.deadline, retainedUntil: r.retainedUntil, permissionGranted: r.permissionGranted,
    observation: observation && {owner: observation.owner, peer: observation.peer, observedAt: observation.observedAt, sessions: observation.sessions, truncated: false},
  }, {owner: key.owner, project: key.project, request: key.request}, peer);
  if (!('observation' in legacy)) invalid();
  const rows = legacy.observation?.sessions;
  if (rows && new Set(rows.map(row => row.inspection)).size !== rows.length) invalid();
  return Object.freeze({...key, peer, status: legacy.status, observation: observation && Object.freeze({...observation, sessions: rows}) as unknown as SessionPageObservation});
}
export interface SessionPageClient {
  projectSessionPageScope(): string;
  projectSessionPageSubmit(selector: SessionPageSelector, timeoutMs?: number): Promise<SessionPageReply>;
  projectSessionPageResult(selector: SessionPageSelector, timeoutMs?: number): Promise<SessionPageReply>;
}
function nonce(): string {
  const hex = BigInt('0x' + randomBytes(16).toString('hex')).toString(16);
  return '0x' + (hex === '0' ? '1' : hex).replace(/\B(?=(?:[0-9a-f]{4})+$)/g, '.');
}
/** Finite discovery only. Every page observes current authority; the digest describes grants,
 * not an atomic snapshot of session activity. An unanswered POST retains its exact GET selector. */
export class SharedSessionPages {
  private readonly scope: string;
  private selector?: SessionPageSelector;
  private submitted = false;
  private catalog?: string;
  private total?: number;
  private examined = 0;
  private readonly pages: SessionPageObservation[] = [];
  private stopped = false;
  complete = false;
  note = 'Shared session list has not been read.';
  constructor(private readonly client: SessionPageClient, private readonly target: RemoteProjectSessionsTarget, private readonly peer: string) {
    this.scope = client.projectSessionPageScope();
    if (!remoteShip(peer) || peer === target.owner) invalid();
  }
  get resumable(): boolean {return !this.complete && !this.stopped;}
  /** Every session on the pages read so far, in the order the owner's ship listed them. */
  get sessions(): readonly RemoteSharedSession[] {return this.pages.flatMap(page => page.sessions);}
  private current(): void {
    if (this.client.projectSessionPageScope() !== this.scope) {this.stopped = true; throw new SessionPageError('changed');}
  }
  async observe(changed: () => void, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)), budget = 60000): Promise<void> {
    const until = Date.now() + Math.min(60000, Math.max(0, budget));
    if (!this.resumable) return;
    this.note = 'Reading shared sessions'; changed();
    try {
      while (Date.now() < until && this.resumable) {
        this.current();
        this.selector ??= sessionPageSelector({...this.target, request: nonce(), offset: this.examined, grantCatalog: this.catalog ?? '0x0'});
        const recover = this.submitted; this.submitted = true;
        // Notify before dispatch so presentation retains the selector even if transport fails.
        changed();
        const remaining = Math.max(1, until - Date.now());
        const reply = await (recover ? this.client.projectSessionPageResult(this.selector, remaining) : this.client.projectSessionPageSubmit(this.selector, remaining));
        this.current(); changed();
        if (reply.peer !== this.peer || reply.owner !== this.selector.owner || reply.project !== this.selector.project || reply.request !== this.selector.request ||
            reply.offset !== this.selector.offset || reply.grantCatalog !== this.selector.grantCatalog) invalid();
        if (reply.status === 'pending') {this.note = 'Waiting for the owner; refresh observes this same page'; await wait(Math.min(1000, Math.max(0, until - Date.now()))); continue;}
        if (reply.status !== 'ready' || !reply.observation) {
          this.stopped = true;
          this.note = reply.status === 'refused' ? 'The owner refused this page. It may need a collaboration update or a current sharing grant.' :
            reply.status === 'missing' || reply.status === 'expired' ? 'This page is no longer retained. Refresh to start a new observation.' :
            'The owner did not provide this page. Refresh to start a new observation.';
          break;
        }
        const o = reply.observation;
        if (this.catalog !== undefined && (this.catalog !== o.grantCatalog || this.total !== o.totalGrants)) throw new SessionPageError('changed');
        const inspections = new Set(this.pages.flatMap(page => page.sessions.map(row => row.inspection)));
        if (o.sessions.some(row => inspections.has(row.inspection))) invalid();
        this.catalog = o.grantCatalog; this.total = o.totalGrants; this.pages.push(o); this.examined += o.examined;
        this.selector = undefined; this.submitted = false;
        this.complete = o.nextOffset === null;
        this.note = this.complete ? `Complete observation · ${this.examined} sharing grants examined` : `Incomplete observation · ${this.examined} of ${this.total} sharing grants examined`;
        changed();
      }
      if (this.resumable) this.note = `Incomplete observation · ${this.examined} grants examined; refresh continues this read`;
    } catch (error) {
      if (error instanceof SessionPageError) {this.stopped = true; this.note = error.message;}
      else this.note = 'Page unanswered; refresh checks this exact request without resending it';
      throw error;
    } finally {changed();}
  }
  rows(): RemoteSessionRow[] {
    const rows: RemoteSessionRow[] = [{label: this.note}];
    for (const page of this.pages) for (const s of page.sessions) rows.push({label: remoteSessionShortId(s.id), description: s.phase,
      tooltip: `${s.working.desk} @ ${s.working.revision}\nObserved ${page.observedAt}\nSession ${s.id}\nInspection grant ${s.inspection}\nPast observation; actions recheck current permission.`});
    if (this.complete && this.pages.every(page => !page.sessions.length)) rows.push({label: 'No sessions are shared with you in this project'});
    return rows;
  }
}
