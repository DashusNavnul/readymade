import {dateAtom, dateAtomMillis} from './editing-activity';
import {asRecord, validUnicode, type JsonObject} from './protocol';
import {remoteShip} from './remote-project-view';
import {remoteSessionShortId} from './remote-project-sessions';

/**
 * What an owner told this ship: that it ended a share, or what it did with a suggestion this ship sent.
 * A notice grants nothing; the shared list and the project itself are the truth.
 */
export const SHARE_NOTICE_KINDS = ['stopped', 'expired', 'removed', 'sharing-off', 'suggestion-taken', 'suggestion-declined'] as const;
const ABOUT_A_SUGGESTION: readonly string[] = ['suggestion-taken', 'suggestion-declined'];
export interface ShareNotice {
  readonly at: string; readonly owner: string; readonly project: string;
  /** The session that was shared, or 0x0 when the notice is about the whole project. For an answer to a suggestion: this ship's own request id for it. */
  readonly session: string; readonly kind: typeof SHARE_NOTICE_KINDS[number];
}
export interface ShareNotices {readonly peer: string; readonly observedAt: string; readonly notices: readonly ShareNotice[]}
export interface ShareNoticesClient {shareNotices(): Promise<ShareNotices | null>}
export const SHARE_NOTICES_MAX = 64;
function invalid(): never {throw new Error('Invalid share notices.');}
function exact(value: unknown, keys: readonly string[]): JsonObject {
  const row = asRecord(value);
  if (Object.getPrototypeOf(row) !== Object.prototype || Object.keys(row).length !== keys.length || !keys.every(k => Object.hasOwn(row, k))) invalid();
  return row;
}
const session = (value: unknown): value is string => typeof value === 'string' && value.length <= 82 &&
  (value === '0x0' || /^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(value) && BigInt(value.replaceAll('.', '')) < (1n << 256n));
/** Strict: the list is this ship's own, newest first, and every notice comes from another ship. A kind this app does not know yet (a newer ship) is left out, never guessed at. */
export function shareNotices(value: unknown, peer: string): ShareNotices {
  const r = exact(value, ['schema', 'peer', 'observedAt', 'notices']);
  if (r.schema !== 'readymade-share-notices-v1' || !remoteShip(peer) || r.peer !== peer || !Array.isArray(r.notices) || r.notices.length > SHARE_NOTICES_MAX) invalid();
  try {dateAtom(r.observedAt);} catch {invalid();}
  const notices = (r.notices as unknown[]).flatMap(value => {
    const n = exact(value, ['at', 'owner', 'project', 'session', 'kind']);
    if (!remoteShip(n.owner) || n.owner === peer || typeof n.project !== 'string' || !validUnicode(n.project) || !Buffer.byteLength(n.project) ||
        Buffer.byteLength(n.project) > 128 || /[\u0000-\u001f\u007f:]/u.test(n.project) || !session(n.session) ||
        typeof n.kind !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(n.kind)) invalid();
    try {dateAtom(n.at);} catch {invalid();}
    if (!(SHARE_NOTICE_KINDS as readonly string[]).includes(n.kind)) return [];
    if (ABOUT_A_SUGGESTION.includes(n.kind) && (n.session === '0x0' || BigInt(n.session.replaceAll('.', '')) >= (1n << 128n))) invalid();
    return [Object.freeze({at: n.at as string, owner: n.owner, project: n.project, session: n.session, kind: n.kind as ShareNotice['kind']})];
  });
  return Object.freeze({peer, observedAt: r.observedAt as string, notices: Object.freeze(notices)});
}
/**
 * One plain sentence. The owner's ship said this; nothing here was checked against the shared list.
 * `fileOf` names the file of a suggestion this computer sent, when it still remembers the request.
 */
export function shareNoticeText(n: ShareNotice, fileOf: (n: ShareNotice) => string | undefined = () => undefined): string {
  if (ABOUT_A_SUGGESTION.includes(n.kind)) {
    const file = fileOf(n), what = `your suggestion${file ? ` for ${file}` : ''} in ${n.project}`;
    return n.kind === 'suggestion-taken' ? `${n.owner} took ${what}.` : `${n.owner} did not take ${what}.`;
  }
  const one = n.session === '0x0' ? 'a session' : `session ${remoteSessionShortId(n.session)}`;
  if (n.kind === 'stopped') return `${n.owner} stopped sharing ${one} of ${n.project} with you.`;
  if (n.kind === 'expired') return `The time limit ran out on ${one} of ${n.project}, shared by ${n.owner}. It is no longer shared with you.`;
  if (n.kind === 'removed') return `${n.owner} removed you from ${n.project}. Its shared files and sessions are closed to you.`;
  return `${n.owner} turned off session sharing for ${n.project}. None of its sessions is shared with you now.`;
}
/** The notices newer than the newest one already shown, newest first. `seen` is that notice's own `at`. */
export function shareNoticesUnseen(list: ShareNotices, seen: unknown): ShareNotice[] {
  let mark = 0n; try {mark = dateAtom(seen);} catch { /* Nothing shown yet, or an unreadable mark: everything is new. */ }
  return list.notices.filter(n => dateAtom(n.at) > mark);
}
/** Each notice as a dated line for a record a person reads later. */
export function shareNoticeLines(list: ShareNotices, fileOf?: (n: ShareNotice) => string | undefined): {readonly day: string; readonly text: string}[] {
  return list.notices.map(n => ({day: new Date(dateAtomMillis(n.at)).toISOString().slice(0, 10), text: shareNoticeText(n, fileOf)}));
}
