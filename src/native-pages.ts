import {asRecord, validUnicode, type JsonObject} from './protocol';
import {dateAtom} from './editing-activity';
import {remoteShip} from './remote-project-view';

/**
 * The ship's own pages this app may read or command: the owner overview, tasks, policy and memory on the native
 * console, and notices, history, presence, streams and work on the collaboration agent. Nothing else goes through
 * `ShipClient.nativePage`, and each page takes only the method, headers and query it is listed with.
 */
export interface NativePage {readonly methods: readonly ('GET' | 'POST')[]; readonly headers?: readonly string[]; readonly query?: readonly string[]}
const CODING = '/apps/pataphor-native/coding/', COLLAB = '/apps/readymade-collab/';
const PROJECT = 'x-readymade-project', OWNER = 'x-readymade-project-owner';
export const NATIVE_PAGES: Readonly<Record<string, NativePage>> = Object.freeze({
  [CODING + 'overview']: {methods: ['GET']},
  [CODING + 'tasks']: {methods: ['GET', 'POST']},
  [CODING + 'policy.json']: {methods: ['GET']},
  [CODING + 'policy']: {methods: ['POST']},
  [CODING + 'memory']: {methods: ['GET', 'POST'], query: ['view', 'topic', 'bytes', 'who', 'since']},
  [COLLAB + 'notices']: {methods: ['GET']},
  [COLLAB + 'notice-retry']: {methods: ['POST']},
  [COLLAB + 'suggestion-history']: {methods: ['GET'], headers: [PROJECT]},
  [COLLAB + 'presence']: {methods: ['GET', 'POST'], headers: [PROJECT, OWNER]},
  [COLLAB + 'session-stream']: {methods: ['GET', 'POST']},
  [COLLAB + 'work-request']: {methods: ['POST']},
  [COLLAB + 'work-dismiss']: {methods: ['POST']},
  [COLLAB + 'work-withdraw']: {methods: ['POST']},
  [COLLAB + 'work-queue']: {methods: ['GET']},
  [COLLAB + 'session-roles']: {methods: ['GET'], headers: [PROJECT]}
});
export interface NativeRequest {readonly method?: 'GET' | 'POST'; readonly headers?: Readonly<Record<string, string>>; readonly body?: JsonObject; readonly timeoutMs?: number}
/** What the ship answered. A refusal is a normal answer here: `status` and the ship's own words are kept. */
export interface NativeReply {readonly status: number; readonly value: JsonObject}

export function projectName(value: unknown): value is string {
  return typeof value === 'string' && validUnicode(value) && Buffer.byteLength(value) > 0 && Buffer.byteLength(value) <= 128 && !/[\u0000-\u001f\u007f:]/u.test(value);
}
/** True only for a listed page, with its listed method, exactly its listed headers when it is read, and a listed query. */
export function nativeRequestAllowed(path: string, request: NativeRequest = {}): boolean {
  const method = request.method ?? 'GET', [pathname, query, extra] = path.split('?');
  const page = Object.hasOwn(NATIVE_PAGES, pathname!) ? NATIVE_PAGES[pathname!] : undefined;
  if (!page || extra !== undefined || !page.methods.includes(method) || (method === 'POST') !== (request.body !== undefined)) return false;
  const headers = Object.entries(request.headers ?? {}), allowed = method === 'GET' ? page.headers ?? [] : [];
  if (headers.length !== allowed.length || !headers.every(([name, value]) => allowed.includes(name) &&
      (name === OWNER ? remoteShip(value) : projectName(value)))) return false;
  if (query === undefined) return true;
  if (method !== 'GET' || !page.query || !query) return false;
  const seen = new Set<string>();
  return query.split('&').every(pair => {
    const at = pair.indexOf('='), key = pair.slice(0, at), value = pair.slice(at + 1);
    if (at < 1 || !page.query!.includes(key) || seen.has(key) || !/^[A-Za-z0-9~._+-]{1,160}$/.test(value)) return false;
    seen.add(key); return true;
  });
}
/** The ship's own reason when it refused (4xx) or could not answer (5xx); undefined when it answered normally. */
export function nativeRefusal(reply: NativeReply): string | undefined {
  if (reply.status >= 200 && reply.status < 300) return undefined;
  const said = [reply.value.error, reply.value.message].find(v => typeof v === 'string' && v.length > 0 && v.length <= 400) as string | undefined;
  return said ?? `The ship answered ${reply.status}.`;
}

/**
 * What a refusal means for the person, for the reasons this version of the ship gives. The ship's own name for the
 * reason is always shown first; this adds what to do about it. A reason not listed here adds nothing.
 */
const REFUSAL_HELP: Readonly<Record<string, string>> = Object.freeze({
  'watch-refused': 'Your link to this shared project may be out of date. Open the newest link the owner sent, then refresh its shared sessions.',
  'inspection-grant-revoked': 'The owner stopped sharing this session with you.',
  'inspection-grant-missing': 'This session is no longer shared with you. Refresh the shared sessions.',
  'stream-capacity': 'This ship is already following as many sessions as it keeps open at once. Stop following one first.',
  'stream-already-open': 'You are already following this session.',
  'work-policy-not-in-force': 'The owner has no standing policy in force for this project, so their agents take no requests.',
  'work-role-not-contributing': 'Your role in this project allows watching, not asking for work. The owner can change your role.',
  'work-session-not-shared': 'That session is not shared with you.',
  'work-peer-limit': 'You already have two open requests in this project. Wait for one to finish.',
  'work-project-limit': 'This project already has eight open requests. Wait for one to finish.',
  'work-request-duplicate': 'This exact request was already taken.',
  'work-peer-rate': 'You have asked this owner for work thirty times in the last hour. Try again later.',
  'work-request-started': 'It has already started or ended, so it cannot be removed.',
  'work-request-missing': 'The owner\'s ship holds no such request.',
  'work-store-unavailable': 'The owner\'s ship is not set up to take work requests.',
  'work-capacity': 'The owner\'s ship holds as many work requests as it keeps, and none of them has finished. Try again when one has.',
  'work-request-own-ship': 'That session is on your own ship. Work requests are for sessions another owner shared with you.',
  'work-request-invalid': 'A request needs a shared session and up to 4,096 bytes of plain text.',
  'stream-own-ship': 'That session is on your own ship; it is followed from its own window, not as a shared session.',
  'stream-missing': 'You are not following that session.',
  'stream-ended': 'That stream has already ended. Follow the session again to reopen it.',
  'presence-capacity': 'The owner\'s ship is already showing as many open files as it keeps.',
  'presence-path-not-shared': 'That file is not shared with you, so the owner\'s ship will not show you on it.',
  'presence-not-shared': 'The owner shares no files of this project with you now.',
  'presence-claimed': 'Another ship\'s agent has already claimed this file.',
  'notice-not-unknown': 'Its outcome is already known, so there is nothing to send again.',
  'notice-missing': 'Your ship no longer holds that notice.',
  'notice-store-unavailable': 'This ship has no notice store yet.',
  'standing-policy-unchanged': 'That is already the policy in force.',
  'standing-policy-invalid': 'A field is missing or out of range: a policy needs a project, at least one objective and one tool, and four numbers above zero.',
  'standing-policy-not-in-force': 'No policy is in force, so there is nothing to revoke.',
  'claim-held': 'Another agent holds this task until its lease runs out or it releases it.',
  'claim-blocked-by-question': 'An agent left a question on this task. Nobody can claim it until the owner answers.',
  'question-answered': 'This question already has its answer; an answer cannot be changed.',
  'question-missing': 'Your ship holds no such question. Read the page again.',
  'question-not-yours': 'Only the agent that asked a question can withdraw it.',
  'answer-invalid': 'An answer needs up to 2,048 bytes of plain text.',
  'owner-tasks-store-unavailable': 'This ship has no task store yet, so nothing can be recorded there.',
  'memory-reason-required': 'Say why the newer memory replaces it, in up to 1,024 bytes.',
  'memory-version-changed': 'That memory was edited since you read it. Read the list again and label the current version.',
  'memory-missing': 'Your ship no longer holds that memory.',
  'memory-not-superseded': 'No such replacement stands, so there is nothing to take back.',
  'proposal-closed': 'That proposal was already withdrawn or dismissed.',
  'proposal-not-yours': 'Only the agent that made a proposal can withdraw it.',
  'proposal-missing': 'Your ship holds no such proposal. Read the page again.',
  'proposal-policy-not-in-force': 'No standing policy is in force, so no task can be proposed.',
  'proposal-path-outside-policy': 'The proposal touches a file the standing policy does not name.',
  'owner-pages-unavailable': 'This ship does not host projects with the full backend, so it has no such page.'
});
export function refusalHelp(reason: string): string | undefined {return Object.hasOwn(REFUSAL_HELP, reason) ? REFUSAL_HELP[reason] : undefined;}
/** The ship's reason in words, followed by what it means when this app knows: "work peer limit. You already have…". */
export function refusalSentence(reason: string): string {
  const help = refusalHelp(reason), words = /^[a-z][a-z0-9-]*$/.test(reason) ? reason.replaceAll('-', ' ') : reason;
  const stop = /[.!?]$/.test(words) ? '' : '.';
  return help ? `${words}${stop} ${help}` : `${words}${stop}`;
}

// Shared strict readers for the page decoders. Each throws on anything a ship of this version would not send.
export function fail(what: string): never {throw new Error(`Invalid ${what}.`);}
export function record(value: unknown, what: string): JsonObject {
  try {const row = asRecord(value); if (Object.getPrototypeOf(row) !== Object.prototype) fail(what); return row;} catch {return fail(what);}
}
export function text(value: unknown, what: string, max = 4096, empty = false): string {
  if (typeof value !== 'string' || !validUnicode(value) || Buffer.byteLength(value) > max || !empty && !value) fail(what);
  return value as string;
}
export function ship(value: unknown, what: string): string {if (!remoteShip(value)) fail(what); return value as string;}
export function when(value: unknown, what: string): string {try {dateAtom(value);} catch {fail(what);} return value as string;}
export function hex(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length > 82 || !/^0x(?:0|[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*)$/.test(value)) fail(what);
  return value as string;
}
export function count(value: unknown, what: string, max = 1_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) fail(what);
  return value as number;
}
export function rows<T>(value: unknown, what: string, max: number, each: (row: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) fail(what);
  return (value as unknown[]).map(each);
}
/** A short id a person can read and compare: the first two groups of a ship hex number. */
export function shortHex(value: string): string {return value.split('.').slice(0, 2).join('.');}
