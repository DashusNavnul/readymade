import {dateAtom} from './editing-activity';
import {asRecord, validUnicode, type JsonObject} from './protocol';
import {remoteShip} from './remote-project-view';

export const SESSION_SHARING_PHASES = ['idle', 'ready', 'inference', 'tools', 'judgment', 'paused', 'unknown', 'complete', 'refused'] as const;
export const SESSION_SHARING_ROLES = ['operator', 'maintainer', 'contributor', 'observer', 'model'] as const;
export const SESSION_SHARING_REASONS = ['session-sharing-owner-required', 'session-sharing-native-unavailable', 'session-sharing-project-missing',
  'session-sharing-foreign-project', 'session-sharing-sessions-invalid', 'session-sharing-self', 'session-sharing-project-unregistered',
  'session-sharing-not-inspectable', 'session-sharing-session-missing', 'session-sharing-grant-invalid', 'session-sharing-grant-collision',
  'session-sharing-policy-invalid', 'session-sharing-project-not-private', 'session-sharing-project-desk-missing', 'session-sharing-work-not-isolated'] as const;
export const SESSION_SHARING_BLOCKERS = ['project-not-private', 'project-desk-missing', 'work-not-isolated'] as const;
export const SESSION_SHARING_MAX = 128;
/** `sharing-on` / `sharing-off` set the whole project's policy; like `remove` they name no session (0x0). */
export type SessionSharingOperation = 'share' | 'unshare' | 'remove' | 'sharing-on' | 'sharing-off';
const PROJECT_WIDE = ['remove', 'sharing-on', 'sharing-off'];
export interface SessionSharingTarget {readonly owner: string; readonly project: string; readonly peer: string}
/** `session` is the id exactly as a read returned it; removal names no session and carries the literal 0x0. */
export interface SessionSharingCommand extends SessionSharingTarget {readonly operation: SessionSharingOperation; readonly session: string}
export interface SessionSharingRow {
  readonly id: string; readonly phase: typeof SESSION_SHARING_PHASES[number]; readonly desk: string; readonly revision: string;
  readonly shared: boolean; readonly inspection: string | null;
}
export interface SessionSharingSnapshot extends SessionSharingTarget {
  readonly observedAt: string; readonly member: boolean; readonly role: typeof SESSION_SHARING_ROLES[number] | null; readonly inspectable: boolean;
  readonly viewGrant: 'none' | 'live' | 'revoked'; readonly truncated: boolean; readonly sessions: readonly SessionSharingRow[];
  /** The project's own setting: may any of its sessions be shared at all. */
  readonly sessionSharing: 'unregistered' | 'off' | 'on';
  /** Why the owner's ship would refuse to change that setting now, if it would. */
  readonly sessionSharingBlocked: typeof SESSION_SHARING_BLOCKERS[number] | null;
}
/** What was sent, never what happened. */
export interface SessionSharingReceipt {readonly status: 'submitted' | 'unchanged'; readonly operation: SessionSharingOperation; readonly pokes: number; readonly confirmed: false}
/** `holds` says whether the last read showed the requested state. Only `confirmed` and `unchanged` assert that it does. */
export type SessionSharingOutcome =
  {readonly status: 'confirmed' | 'unchanged' | 'not-confirmed' | 'unknown'; readonly holds: boolean; readonly snapshot?: SessionSharingSnapshot} |
  {readonly status: 'refused'; readonly reason: string};
export interface SessionSharingClient {
  sessionSharingRead(project: string, peer: string): Promise<SessionSharingSnapshot>;
  sessionSharingSubmit(command: SessionSharingCommand): Promise<SessionSharingReceipt>;
}
function invalid(): never {throw new Error('Invalid or uncorrelated session sharing state.');}
function exact(value: unknown, keys: readonly string[]): JsonObject {
  const row = asRecord(value);
  if (Object.getPrototypeOf(row) !== Object.prototype || Object.keys(row).length !== keys.length || !keys.every(k => Object.hasOwn(row, k))) invalid();
  return row;
}
/** Canonical nonzero @ux text as scot prints it, at most 256 bits. */
function ux(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 82 && /^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(value) && BigInt(value.replaceAll('.', '')) < (1n << 256n);
}
function ud(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 26 && /^(?:0|[1-9][0-9]{0,2}(?:\.[0-9]{3})*)$/.test(value) && BigInt(value.replaceAll('.', '')) < (1n << 64n);
}
export function sessionSharingTarget(value: unknown): SessionSharingTarget {
  const r = exact(value, ['owner', 'project', 'peer']);
  if (!remoteShip(r.owner) || !remoteShip(r.peer) || r.owner === r.peer || typeof r.project !== 'string' || !validUnicode(r.project) ||
      !Buffer.byteLength(r.project) || Buffer.byteLength(r.project) > 128 || /[\u0000-\u001f\u007f:]/u.test(r.project)) invalid();
  return Object.freeze({owner: r.owner, project: r.project, peer: r.peer});
}
export function sessionSharingCommand(value: unknown): SessionSharingCommand {
  const r = exact(value, ['owner', 'project', 'peer', 'operation', 'session']);
  const target = sessionSharingTarget({owner: r.owner, project: r.project, peer: r.peer});
  if (PROJECT_WIDE.includes(String(r.operation)) ? r.session !== '0x0' : !(r.operation === 'share' || r.operation === 'unshare') || !ux(r.session)) invalid();
  return Object.freeze({...target, operation: r.operation as SessionSharingOperation, session: r.session as string});
}
export function sessionSharingHeaders(value: unknown): Record<string, string> {
  const t = sessionSharingTarget(value);
  return {'x-readymade-project': Buffer.from(t.project, 'utf8').toString('latin1'), 'x-readymade-project-peer': t.peer};
}
/** The exact refusals the owner's ship issues. Each one means nothing was changed by this request. */
export function sessionSharingRefusal(status: number, value: unknown, post: boolean): string | undefined {
  let r: JsonObject; try {r = asRecord(value);} catch {return undefined;}
  if (Object.keys(r).length !== 2 || typeof r.message !== 'string') return undefined;
  if (status === 409 && r.status === 'refused' && (SESSION_SHARING_REASONS as readonly string[]).includes(r.message)) return r.message;
  if (status === 400 && r.status === 'refused') {
    if (post && r.message === 'Explicit owner-origin session sharing command required.') return 'session-sharing-command-required';
    if (!post && r.message === 'Project and peer required.') return 'session-sharing-selector-required';
  }
  if (status === 503 && r.status === 'unavailable' && r.message === 'Session sharing state unavailable.') return 'session-sharing-unavailable';
  return undefined;
}
/** One collaborator's standing. Listing a session shares nothing and proves no continuing permission. */
export function sessionSharingSnapshot(value: unknown, expected: SessionSharingTarget): SessionSharingSnapshot {
  const wanted = sessionSharingTarget(expected);
  const r = exact(value, ['schema', 'owner', 'project', 'peer', 'observedAt', 'member', 'role', 'inspectable', 'viewGrant', 'truncated', 'sessionSharing', 'sessionSharingBlocked', 'sessions']);
  if (r.schema !== 'readymade-session-sharing-v1' || r.owner !== wanted.owner || r.project !== wanted.project || r.peer !== wanted.peer ||
      typeof r.member !== 'boolean' || typeof r.inspectable !== 'boolean' || typeof r.truncated !== 'boolean' ||
      (r.member ? typeof r.role !== 'string' || !(SESSION_SHARING_ROLES as readonly string[]).includes(r.role) : r.role !== null) ||
      typeof r.viewGrant !== 'string' || !['none', 'live', 'revoked'].includes(r.viewGrant) ||
      typeof r.sessionSharing !== 'string' || !['unregistered', 'off', 'on'].includes(r.sessionSharing) || r.inspectable && r.sessionSharing !== 'on' ||
      r.sessionSharingBlocked !== null && (r.sessionSharing === 'unregistered' || !(SESSION_SHARING_BLOCKERS as readonly unknown[]).includes(r.sessionSharingBlocked)) ||
      !Array.isArray(r.sessions) || r.sessions.length > SESSION_SHARING_MAX || r.truncated && r.sessions.length !== SESSION_SHARING_MAX) invalid();
  dateAtom(r.observedAt);
  let prior = 0n;
  const sessions = r.sessions.map(value => {
    const s = exact(value, ['id', 'phase', 'desk', 'revision', 'shared', 'inspection']);
    if (!ux(s.id) || typeof s.phase !== 'string' || !(SESSION_SHARING_PHASES as readonly string[]).includes(s.phase) ||
        typeof s.desk !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/.test(s.desk) || !ud(s.revision) || typeof s.shared !== 'boolean' ||
        (s.shared ? !ux(s.inspection) : s.inspection !== null)) invalid();
    const id = BigInt(s.id.replaceAll('.', ''));
    if (id <= prior) invalid(); prior = id; // Ascending, so an id can appear only once.
    return Object.freeze({id: s.id, phase: s.phase as SessionSharingRow['phase'], desk: s.desk, revision: s.revision, shared: s.shared, inspection: s.inspection as string | null});
  });
  return Object.freeze({...wanted, observedAt: r.observedAt as string, member: r.member, role: r.role as SessionSharingSnapshot['role'], inspectable: r.inspectable,
    viewGrant: r.viewGrant as SessionSharingSnapshot['viewGrant'], truncated: r.truncated, sessionSharing: r.sessionSharing as SessionSharingSnapshot['sessionSharing'],
    sessionSharingBlocked: r.sessionSharingBlocked as SessionSharingSnapshot['sessionSharingBlocked'],
    sessions: Object.freeze(sessions)});
}
export function sessionSharingReceipt(status: number, value: unknown, command: SessionSharingCommand): SessionSharingReceipt {
  const r = exact(value, ['schema', 'status', 'operation', 'pokes', 'confirmed']);
  if (status !== 202 || r.schema !== 'readymade-session-sharing-receipt-v1' || r.operation !== sessionSharingCommand(command).operation || r.confirmed !== false ||
      !(r.status === 'submitted' || r.status === 'unchanged') || typeof r.pokes !== 'number' || !Number.isSafeInteger(r.pokes) || r.pokes < 0 || r.pokes > 256 ||
      (r.status === 'unchanged') !== (r.pokes === 0)) invalid();
  return Object.freeze({status: r.status, operation: r.operation as SessionSharingOperation, pokes: r.pokes, confirmed: false});
}
/** Does this read show what the command asked for? A session that is not listed proves nothing. */
export function sessionSharingHolds(command: SessionSharingCommand, snapshot: SessionSharingSnapshot): boolean {
  if (command.operation === 'remove') return !snapshot.member && snapshot.viewGrant !== 'live' && !snapshot.sessions.some(row => row.shared);
  if (command.operation === 'sharing-on') return snapshot.sessionSharing === 'on';
  if (command.operation === 'sharing-off') return snapshot.sessionSharing === 'off';
  const row = snapshot.sessions.find(row => row.id === command.session);
  return row !== undefined && row.shared === (command.operation === 'share');
}
/** Reads until the requested state shows or about ten seconds pass. It never sends anything. */
export async function sessionSharingConfirm(client: SessionSharingClient, command: SessionSharingCommand, seen: (snapshot: SessionSharingSnapshot) => void = () => {},
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)), budget = 10000): Promise<{holds: boolean; snapshot?: SessionSharingSnapshot}> {
  const until = Date.now() + budget; let snapshot: SessionSharingSnapshot | undefined;
  for (let reads = 0; reads < 11; reads++) {
    let read: SessionSharingSnapshot | undefined;
    try {read = await client.sessionSharingRead(command.project, command.peer);} catch { /* A failed read changes nothing and is simply read again. */ }
    if (read) {seen(read); snapshot = read; if (sessionSharingHolds(command, read)) return {holds: true, snapshot};}
    if (Date.now() + 1000 > until) break;
    await wait(1000);
  }
  return {holds: false, ...(snapshot ? {snapshot} : {})};
}
/**
 * One submission, then reads. The command is never sent twice: a refusal is final, an unknown
 * submission is only observed, and anything the ship has not shown in time is "not confirmed".
 * An error raised before anything was sent (busy, signed out, invalid command) is rethrown.
 */
export async function sessionSharingSettle(client: SessionSharingClient, value: SessionSharingCommand, seen: (snapshot: SessionSharingSnapshot) => void = () => {},
  wait?: (ms: number) => Promise<void>, budget?: number): Promise<SessionSharingOutcome> {
  const command = sessionSharingCommand(value);
  let receipt: SessionSharingReceipt | undefined;
  try {receipt = await client.sessionSharingSubmit(command);}
  catch (error) {
    const code = (error as {code?: unknown} | null)?.code, reason = (error as {reason?: unknown} | null)?.reason;
    if (code === 'refused') return {status: 'refused', reason: typeof reason === 'string' ? reason : 'refused'};
    if (code !== 'outcomeUnknown') throw error;
  }
  const {holds, snapshot} = await sessionSharingConfirm(client, command, seen, wait, budget);
  const status = !receipt ? 'unknown' : !holds ? 'not-confirmed' : receipt.status === 'unchanged' ? 'unchanged' : 'confirmed';
  return {status, holds, ...(snapshot ? {snapshot} : {})};
}
/** One plain sentence for the owner. `session` is the label shown for the session, not necessarily its full id. */
export function sessionSharingMessage(command: SessionSharingCommand, outcome: SessionSharingOutcome, session = command.session): string {
  const {peer, project, operation} = command;
  if (outcome.status === 'refused') {
    const why: Record<string, string> = {
      'session-sharing-not-inspectable': `Sessions cannot be shared with ${peer} right now.`,
      'session-sharing-session-missing': 'That session is no longer in this project.',
      'session-sharing-self': 'You cannot share with or remove your own ship.',
      'session-sharing-owner-required': 'Only the project owner can change this.',
      'session-sharing-native-unavailable': 'The coding agents on your ship are not running.',
      'session-sharing-unavailable': 'Your ship could not read its sharing state.',
      'session-sharing-project-missing': 'Your ship does not know this project.',
      'session-sharing-foreign-project': 'This project belongs to another ship.',
      'session-sharing-project-unregistered': 'This project is not set up for coding on your ship.',
      'session-sharing-sessions-invalid': 'Your ship could not read its sessions.',
      'session-sharing-grant-invalid': 'Your ship could not issue the sharing grant.',
      'session-sharing-grant-collision': 'Your ship could not issue the sharing grant.',
      'session-sharing-policy-invalid': 'Your ship could not change this project\'s policy.',
      'session-sharing-project-not-private': 'This project\'s source desk is readable by other ships, and your ship only changes coding policy for private projects.',
      'session-sharing-project-desk-missing': 'One of this project\'s desks is missing on your ship.',
      'session-sharing-work-not-isolated': 'This project\'s work desk is running or claimed, so its policy cannot be changed now.'};
    return `Your ship refused. ${why[outcome.reason] ?? `Reason: ${outcome.reason}.`} Nothing was changed.`;
  }
  const done = operation === 'share' ? [`Session ${session} is now shared with ${peer}.`, `Session ${session} was already shared with ${peer}.`] :
    operation === 'unshare' ? [`Session ${session} is no longer shared with ${peer}.`, `Session ${session} was not shared with ${peer}.`] :
      operation === 'sharing-on' ? [`Sessions of ${project} can now be shared with its members.`, `Sessions of ${project} could already be shared.`] :
        operation === 'sharing-off' ? [`Session sharing is off for ${project}; every shared session stopped at once.`, `Session sharing was already off for ${project}.`] :
          [`${peer} was removed from ${project}.`, `${peer} was already out of ${project}.`];
  if (outcome.status === 'confirmed') return done[0];
  if (outcome.status === 'unchanged') return done[1];
  if (!outcome.snapshot && !outcome.holds && (outcome.status === 'not-confirmed' || outcome.status === 'unknown')) return 'Your ship could not be read afterwards, so the result is not known. Check again; nothing was resent.';
  if (outcome.status === 'not-confirmed') return 'Not confirmed yet. Your ship took the request but does not show the change. Check again; nothing was resent.';
  return `The request may not have reached your ship. ${outcome.holds ? 'Your ship shows the requested state.' : 'Your ship does not show the change.'} Check again; nothing was resent.`;
}
