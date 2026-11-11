import {dateAtom} from './editing-activity';
import {asRecord, validUnicode, type JsonObject} from './protocol';
import {remoteShip} from './remote-project-view';

export interface RemoteProjectSessionsTarget {readonly owner: string; readonly project: string}
export interface RemoteProjectSessionsSelector extends RemoteProjectSessionsTarget {readonly request: string}
export const REMOTE_SESSION_PHASES = ['idle', 'ready', 'inference', 'tools', 'judgment', 'paused', 'unknown', 'complete', 'refused'] as const;
export type RemoteSessionPhase = typeof REMOTE_SESSION_PHASES[number];
export interface RemoteSessionWorking {readonly ship: string; readonly desk: string; readonly revision: string; readonly root: string; readonly commit: string}
export interface RemoteSharedSession {readonly id: string; readonly inspection: string; readonly phase: RemoteSessionPhase; readonly working: RemoteSessionWorking}
export interface RemoteSessionsObservation {
  readonly owner: string; readonly peer: string; readonly observedAt: string; readonly truncated: boolean;
  readonly sessions: readonly RemoteSharedSession[];
}
export type RemoteProjectSessionsReply = RemoteProjectSessionsSelector & {readonly peer: string; readonly permissionGranted: false} & (
  {readonly status: 'missing' | 'expired'} |
  {readonly status: 'pending' | 'ready' | 'refused' | 'uncertain'; readonly reason: string;
    readonly deadline: string; readonly retainedUntil: string; readonly observation: RemoteSessionsObservation | null}
);
export interface RemoteProjectSessionsClient {
  projectSessionsSubmit(owner: string, project: string): Promise<RemoteProjectSessionsReply>;
  projectSessionsResult(owner: string, project: string, request: string): Promise<RemoteProjectSessionsReply>;
}
export interface RemoteSessionRow {readonly label: string; readonly description?: string; readonly tooltip?: string}
export const REMOTE_PROJECT_SESSIONS_MAX = 64;
function invalid(): never {throw new Error('Invalid or uncorrelated shared session list.');}
function exact(value: unknown, keys: readonly string[]): JsonObject {
  const row = asRecord(value);
  if (Object.getPrototypeOf(row) !== Object.prototype || Object.keys(row).length !== keys.length || !keys.every(k => Object.hasOwn(row, k))) invalid();
  return row;
}
/** Canonical @ux text as scot prints it: lower-case, dotted every four digits, no leading zero. */
function ux(value: unknown, bits: number): value is string {
  if (typeof value !== 'string' || value.length > 82 || !/^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(value)) return false;
  return BigInt(value.replaceAll('.', '')) < (1n << BigInt(bits));
}
/** Canonical @uv text; zero is admitted because an empty root or commit is a valid atom. */
function uv(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || !/^0v(?:0|[1-9a-v][0-9a-v]{0,4}(?:\.[0-9a-v]{5})*)$/.test(value)) return false;
  let n = 0n; for (const c of value.slice(2).replaceAll('.', '')) n = n * 32n + BigInt(parseInt(c, 32));
  return n < (1n << 256n);
}
function ud(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 26 && /^(?:0|[1-9][0-9]{0,2}(?:\.[0-9]{3})*)$/.test(value) && BigInt(value.replaceAll('.', '')) < (1n << 64n);
}
export function remoteProjectSessionsTarget(value: unknown): RemoteProjectSessionsTarget {
  const r = exact(value, ['owner', 'project']);
  if (!remoteShip(r.owner) || typeof r.project !== 'string' || !validUnicode(r.project) ||
      !Buffer.byteLength(r.project) || Buffer.byteLength(r.project) > 128 || /[\u0000-\u001f\u007f:]/u.test(r.project)) invalid();
  return Object.freeze({owner: r.owner, project: r.project});
}
export function remoteProjectSessionsSelector(value: unknown): RemoteProjectSessionsSelector {
  const r = exact(value, ['owner', 'project', 'request']);
  const target = remoteProjectSessionsTarget({owner: r.owner, project: r.project});
  if (!ux(r.request, 128)) invalid(); return Object.freeze({...target, request: r.request});
}
export function remoteProjectSessionsHeaders(value: unknown): Record<string, string> {
  const s = remoteProjectSessionsSelector(value);
  return {'x-readymade-project-owner': s.owner, 'x-readymade-project': Buffer.from(s.project, 'utf8').toString('latin1'),
    'x-readymade-project-sessions-request': s.request};
}
/** Refusals the peer's own ship issues before anything reaches the owner. */
export function remoteProjectSessionsRefused(status: number, value: unknown): boolean {
  const r = asRecord(value);
  if (Object.keys(r).length !== 2 || r.status !== 'refused') return false;
  return status === 403 && r.message === 'Owner login required.' ||
    status === 400 && r.message === 'Exact owner-origin shared session list command required.' ||
    status === 409 && ['sessions-selector-invalid', 'sessions-request-reused', 'sessions-capacity'].includes(String(r.message));
}
function sessionsObservation(value: unknown, owner: string, peer: string): RemoteSessionsObservation {
  const o = exact(value, ['owner', 'peer', 'observedAt', 'truncated', 'sessions']);
  if (o.owner !== owner || o.peer !== peer || typeof o.truncated !== 'boolean' || !Array.isArray(o.sessions) || o.sessions.length > REMOTE_PROJECT_SESSIONS_MAX) invalid();
  dateAtom(o.observedAt);
  const sessions = o.sessions.map(value => {
    const s = exact(value, ['id', 'inspection', 'phase', 'working']), w = exact(s.working, ['ship', 'desk', 'revision', 'root', 'commit']);
    if (!ux(s.id, 256) || !ux(s.inspection, 256) || typeof s.phase !== 'string' || !(REMOTE_SESSION_PHASES as readonly string[]).includes(s.phase) ||
        w.ship !== owner || typeof w.desk !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/.test(w.desk) || !ud(w.revision) || !uv(w.root) || !uv(w.commit)) invalid();
    return Object.freeze({id: s.id, inspection: s.inspection, phase: s.phase as RemoteSessionPhase,
      working: Object.freeze({ship: owner, desk: w.desk, revision: w.revision, root: w.root, commit: w.commit})});
  });
  return Object.freeze({owner, peer, observedAt: o.observedAt as string, truncated: o.truncated, sessions: Object.freeze(sessions)});
}
/** A list is what the owner disclosed once. It never asserts that permission continues. */
export function remoteProjectSessionsReply(status: number, value: unknown, expected: RemoteProjectSessionsTarget | RemoteProjectSessionsSelector,
  peer: string): RemoteProjectSessionsReply {
  if (!remoteShip(peer)) invalid();
  const get = Object.hasOwn(expected, 'request'), selected = get ? remoteProjectSessionsSelector(expected) : undefined;
  const wanted = selected ?? remoteProjectSessionsTarget(expected);
  if (peer === wanted.owner) invalid();
  if (get && (status === 404 || status === 410)) {
    const r = exact(value, ['status', 'message']);
    if (!(status === 404 && r.status === 'unknown' && r.message === 'List not retained; no retry was issued.' ||
          status === 410 && r.status === 'expired' && r.message === 'Historical list expired.')) invalid();
    return Object.freeze({...selected!, peer, permissionGranted: false, status: status === 404 ? 'missing' : 'expired'});
  }
  const r = exact(value, ['schema', 'owner', 'peer', 'project', 'request', 'status', 'reason', 'deadline', 'retainedUntil', 'permissionGranted', 'observation']);
  const key = remoteProjectSessionsSelector({owner: r.owner, project: r.project, request: r.request});
  if (r.schema !== 'readymade-project-sessions-result-v1' || r.permissionGranted !== false || r.peer !== peer ||
      key.owner !== wanted.owner || key.project !== wanted.project || selected && key.request !== selected.request) invalid();
  const reasons: Record<string, readonly string[]> = {pending: ['awaiting-owner'], ready: ['observed'], refused: ['watch-refused'],
    uncertain: ['sessions-timeout', 'closed-without-list', 'invalid-list', 'list-mismatch', 'unexpected-poke-ack']};
  if (typeof r.status !== 'string' || typeof r.reason !== 'string' || !Object.hasOwn(reasons, r.status) || !reasons[r.status].includes(r.reason) ||
      (!get && r.status !== 'pending') || status !== (r.status === 'pending' ? 202 : 200)) invalid();
  const deadline = dateAtom(r.deadline), retained = dateAtom(r.retainedUntil);
  if (retained - deadline !== (300n << 64n)) invalid();
  let observation: RemoteSessionsObservation | null = null;
  if (r.status === 'ready') observation = sessionsObservation(r.observation, key.owner, peer);
  else if (r.observation !== null) invalid();
  return Object.freeze({...key, peer, permissionGranted: false, status: r.status as 'pending' | 'ready' | 'refused' | 'uncertain',
    reason: r.reason, deadline: r.deadline as string, retainedUntil: r.retainedUntil as string, observation});
}
/** At most one submission. A supplied pending request is only read again. The ship settles a
 *  request 30 s after it starts, so reads begin for 32 s; each HTTP read is itself bounded. */
export async function remoteProjectSessionsObserve(client: RemoteProjectSessionsClient, target: RemoteProjectSessionsTarget, pending: string | undefined,
  accept: (reply: RemoteProjectSessionsReply) => void, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  budget = 32000): Promise<void> {
  const until = Date.now() + budget;
  let reply = pending === undefined ? await client.projectSessionsSubmit(target.owner, target.project)
    : await client.projectSessionsResult(target.owner, target.project, pending);
  for (accept(reply); reply.status === 'pending' && Date.now() + 1000 < until; accept(reply)) {
    await wait(1000);
    reply = await client.projectSessionsResult(target.owner, target.project, reply.request);
  }
}
export function remoteSessionShortId(id: string): string {
  const groups = id.split('.');
  return groups.length <= 3 ? id : `${groups[0]}.${groups[1]}…${groups.at(-1)}`;
}
/** Plain-language presentation of one reply. Nothing here requests, retries or renews anything. */
export function remoteProjectSessionRows(reply: RemoteProjectSessionsReply): RemoteSessionRow[] {
  if (reply.status === 'pending') return [{label: 'Waiting for the owner', description: 'Refresh reads this same request again'}];
  if (reply.status === 'refused') return [{label: 'The owner did not share a session list with this ship'}];
  if (reply.status === 'uncertain') return [{label: 'No answer from the owner; nothing was retried'}];
  if (reply.status === 'missing') return [{label: 'Your ship no longer holds this list; nothing was retried'}];
  if (reply.status === 'expired') return [{label: 'This list expired; nothing was retried'}];
  const seen = reply.status === 'ready' ? reply.observation : null;
  if (!seen) return [];
  const rows: RemoteSessionRow[] = seen.sessions.map(s => ({label: remoteSessionShortId(s.id), description: s.phase,
    tooltip: `${s.working.desk} @ ${s.working.revision}\nObserved ${seen.observedAt}\nSession ${s.id}`}));
  if (!rows.length && !seen.truncated) rows.push({label: 'No sessions are shared with you in this project'});
  if (seen.truncated) rows.push({label: 'Showing the first ' + seen.sessions.length, description: 'The owner has more shared sessions'});
  return rows;
}
