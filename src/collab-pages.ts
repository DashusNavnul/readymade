import {randomBytes} from 'node:crypto';
import {count, fail, hex, projectName, record, refusalSentence, rows, ship, shortHex, text, when} from './native-pages';
import {dateAtom, dateAtomMillis} from './editing-activity';
import type {JsonObject} from './protocol';
import type {Report, ReportLine} from './report';

/** Strict readers for the collaboration agent's pages, the sentences they become, and the commands they take. */
const optional = <T>(value: unknown, read: (v: unknown) => T): T | undefined => value === null || value === undefined ? undefined : read(value);
const project = (v: unknown): string => {if (!projectName(v)) fail('project'); return v as string;};
const shipPath = (v: unknown): string => {const p = text(v, 'path', 512); if (!/^(?:\/[a-z0-9~._-]+){1,16}$/.test(p)) fail('path'); return p;};
const word = (v: unknown, what: string): string => {const t = text(v, what, 64); if (!/^[a-z][a-z0-9-]*$/.test(t)) fail(what); return t;};

// ---- notices: what this ship told collaborators, and what owners told this ship
export const NOTICE_KINDS = ['suggestion-taken', 'suggestion-declined', 'suggestion-landed', 'work-queued', 'work-started', 'work-finished'] as const;
export const NOTICE_STATUSES = ['pending', 'delivered', 'refused', 'unknown'] as const;
export interface Notice {
  readonly id: string; readonly from: string; readonly to: string; readonly project: string; readonly kind: typeof NOTICE_KINDS[number];
  readonly subject: string; readonly at: string; readonly detail: string;
}
export interface SentNotice extends Notice {readonly status: typeof NOTICE_STATUSES[number]; readonly answeredAt?: string; readonly retryable: boolean}
export interface CollabNotices {readonly ship: string; readonly observedAt: string; readonly capacity: number; readonly outbox: readonly SentNotice[]; readonly inbox: readonly Notice[]}
/** A kind this app does not know yet (a newer ship) is left out, never guessed at. */
function notice(value: unknown): Notice | undefined {
  const n = record(value, 'notice'), kind = word(n.kind, 'notice kind');
  const read: Notice = {id: hex(n.id, 'notice id'), from: ship(n.from, 'notice sender'), to: ship(n.to, 'notice receiver'), project: project(n.project),
    kind: kind as Notice['kind'], subject: hex(n.subject, 'notice subject'), at: when(n.at, 'notice time'), detail: text(n.detail, 'notice detail', 1024, true)};
  if (read.from === read.to) fail('notice');
  return (NOTICE_KINDS as readonly string[]).includes(kind) ? read : undefined;
}
/** Undefined when this ship has no notice store. */
export function collabNotices(value: unknown, me: string): CollabNotices | undefined {
  const r = record(value, 'notices');
  if (r.schema !== 'readymade-collab-notices-v1' || typeof r.available !== 'boolean') fail('notices');
  if (!r.available) return undefined;
  if (ship(r.ship, 'notices') !== me) fail('notices');
  const outbox = rows(r.outbox, 'notices', 512, v => {
    const n = notice(v), raw = record(v, 'notice');
    if (!(NOTICE_STATUSES as readonly unknown[]).includes(raw.status) || typeof raw.retryable !== 'boolean' || raw.retryable !== (raw.status === 'unknown')) fail('notice');
    if (n && n.from !== me) fail('notice');
    return n ? [Object.freeze({...n, status: raw.status as SentNotice['status'], answeredAt: optional(raw.answeredAt, a => when(a, 'notice answer')), retryable: raw.retryable as boolean})] : [];
  }).flat();
  const inbox = rows(r.inbox, 'notices', 512, v => {const n = notice(v); if (n && n.to !== me) fail('notice'); return n ? [Object.freeze(n)] : [];}).flat();
  const newest = <T extends Notice>(list: T[]): T[] => list.sort((a, b) => dateAtom(a.at) < dateAtom(b.at) ? 1 : dateAtom(a.at) > dateAtom(b.at) ? -1 : 0);
  return Object.freeze({ship: me, observedAt: when(r.observedAt, 'notices time'), capacity: count(r.capacity, 'notices', 4096), outbox: Object.freeze(newest(outbox)), inbox: Object.freeze(newest(inbox))});
}
/**
 * One plain sentence for a notice this ship received. The owner's ship said this; nothing here was checked again.
 * `fileOf` names the file of a suggestion this computer sent, when it still remembers the request.
 */
export function noticeText(n: Notice, fileOf: (n: Notice) => string | undefined = () => undefined): string {
  const file = n.kind.startsWith('suggestion-') ? fileOf(n) : undefined;
  const yours = `your suggestion ${file ? `for ${file}` : shortHex(n.subject)} in ${n.project}`, work = `your work request ${shortHex(n.subject)} in ${n.project}`;
  switch (n.kind) {
    case 'suggestion-taken': return `${n.from} took ${yours}.`;
    case 'suggestion-declined': return `${n.from} did not take ${yours}.`;
    case 'suggestion-landed': return `${n.from} landed ${yours}.${n.detail ? ` ${n.detail}` : ''}`;
    case 'work-queued': return `${n.from} queued ${work}.`;
    case 'work-started': return `${n.from} started ${work}.${n.detail ? ` ${n.detail}` : ''}`;
    case 'work-finished': return `${n.from} finished ${work}.${n.detail ? ` ${n.detail}` : ''}`;
  }
}
/**
 * Received notices this computer has not shown yet, newest first. `seen` is the ids it has shown. Compared by id,
 * never by time: a notice carries its sender's clock, and one made earlier can arrive later (a retried notice, a
 * second owner), so a "newest time seen" mark would hide it for good.
 */
export function noticesUnseen(list: CollabNotices, seen: unknown): Notice[] {
  const shown = new Set(Array.isArray(seen) ? seen.filter((v): v is string => typeof v === 'string') : []);
  return list.inbox.filter(n => !shown.has(n.id));
}
/** What to remember after showing them: every notice the ship holds now. One the ship has dropped needs no mark. */
export function noticesSeen(list: CollabNotices): string[] {return list.inbox.map(n => n.id);}
/**
 * Landed and work notices as dated lines for a record a person reads later. Answers to suggestions (taken, declined)
 * are left out here: the ship also lists those among its share notices, and each should be read once.
 */
export function noticeLines(list: CollabNotices, fileOf?: (n: Notice) => string | undefined): {readonly day: string; readonly text: string}[] {
  return list.inbox.filter(n => n.kind !== 'suggestion-taken' && n.kind !== 'suggestion-declined')
    .map(n => ({day: new Date(dateAtomMillis(n.at)).toISOString().slice(0, 10), text: noticeText(n, fileOf)}));
}
const STATUS_WORDS: Record<SentNotice['status'], string> = {pending: 'Sent; waiting for their ship to acknowledge', delivered: 'Their ship acknowledged it', refused: 'Their ship refused it', unknown: 'Unknown: this ship restarted before an acknowledgement arrived. It is not sent again unless you retry it.'};
/**
 * The ship keeps a fixed number of notices and records no new one once that many are held. Said from nine tenths
 * full, so progress that stops arriving is not mistaken for nothing having happened.
 */
export function noticesRoom(list: CollabNotices): string {
  // The limit is per direction: this many sent, and this many received.
  if (!list.capacity) return '';
  const side = (held: number, what: string): string => held >= list.capacity ? ` This ship holds as many ${what} notices as it keeps (${held} of ${list.capacity}): it records no new one, so newer outcomes are missing here.`
    : held >= list.capacity * 0.9 ? ` This ship's store of ${what} notices is nearly full (${held} of ${list.capacity}); when it is full no new one is recorded.` : '';
  return side(list.outbox.length, 'sent') + side(list.inbox.length, 'received');
}
export function noticesReport(list: CollabNotices, fileOf?: (n: Notice) => string | undefined): Report {
  const unknown = list.outbox.filter(n => n.status === 'unknown').length;
  const sent = (n: SentNotice): ReportLine => ({text: `To ${n.to}: ${n.kind.replace('-', ' ')} ${shortHex(n.subject)} in ${n.project}`,
    detail: `${STATUS_WORDS[n.status]}${n.answeredAt ? ` at ${n.answeredAt}` : ''}\nSent ${n.at}${n.detail ? `\n${n.detail}` : ''}`,
    mark: n.status === 'delivered' ? 'ok' : n.status === 'pending' ? 'note' : 'warning', action: n.retryable ? {id: `retry:${n.id}`, label: 'Send it again'} : undefined});
  return {title: 'Notices', status: `${list.outbox.length} sent, ${list.inbox.length} received${unknown ? `, ${unknown} with an unknown outcome` : ''}. Read from the ship at ${list.observedAt}.`,
    note: `Each outcome is told once. A notice is never sent again by itself.${noticesRoom(list)}`,
    sections: [{title: 'Sent to collaborators', empty: 'Nothing has been sent.', lines: list.outbox.map(sent)},
      {title: 'Received from owners', empty: 'Nothing has been received.', lines: list.inbox.map(n => ({text: noticeText(n, fileOf), detail: n.at}))}]};
}
export function noticeRetry(id: string): JsonObject {return {schema: 'readymade-notice-retry-v1', id: hex(id, 'notice id')};}

// ---- suggestion history: authored, reviewed, landed, acknowledged
export interface NoticeOutcome {readonly kind: string; readonly status: SentNotice['status']; readonly acknowledgedAt?: string}
export interface SuggestionRow {
  readonly request: string; readonly peer: string; readonly kind: 'single-file' | 'multi-file'; readonly files: number; readonly authoredAt: string; readonly baseRevision: number;
  readonly reviewed?: {readonly candidate: string; readonly verdict: string; readonly at: string; readonly stage: string};
  readonly landed?: {readonly candidate: string; readonly revision: number; readonly desk: string};
  readonly answer?: NoticeOutcome; readonly landedNotice?: NoticeOutcome;
}
/** `archiveComplete` false: the ship's archive is longer than it reads at once, so some suggestions (not necessarily the oldest) are missing. */
export interface SuggestionHistory {readonly owner: string; readonly project: string; readonly observedAt: string; readonly suggestions: number; readonly archiveComplete: boolean; readonly rows: readonly SuggestionRow[]}
const outcome = (value: unknown): NoticeOutcome => {
  const o = record(value, 'notice outcome');
  if (!(NOTICE_STATUSES as readonly unknown[]).includes(o.status)) fail('notice outcome');
  return Object.freeze({kind: word(o.kind, 'notice kind'), status: o.status as SentNotice['status'], acknowledgedAt: optional(o.acknowledgedAt, a => when(a, 'acknowledgement'))});
};
export function suggestionHistory(value: unknown, owner: string, wanted: string): SuggestionHistory {
  const r = record(value, 'suggestion history');
  if (r.schema !== 'readymade-suggestion-history-v1' || ship(r.owner, 'history') !== owner || project(r.project) !== wanted) fail('suggestion history');
  const list = rows(r.rows, 'suggestion history', 64, v => {
    const s = record(v, 'suggestion');
    if (s.kind !== 'single-file' && s.kind !== 'multi-file') fail('suggestion');
    return Object.freeze({request: hex(s.request, 'request'), peer: ship(s.peer, 'peer'), kind: s.kind as SuggestionRow['kind'], files: count(s.files, 'files', 4096),
      authoredAt: when(s.authoredAt, 'authored'), baseRevision: count(s.baseRevision, 'revision'),
      reviewed: optional(s.reviewed, x => {const d = record(x, 'review'); return Object.freeze({candidate: hex(d.candidate, 'candidate'), verdict: word(d.verdict, 'verdict'), at: when(d.at, 'review time'), stage: word(d.stage, 'stage')});}),
      landed: optional(s.landed, x => {const d = record(x, 'landing'); return Object.freeze({candidate: hex(d.candidate, 'candidate'), revision: count(d.revision, 'revision'), desk: text(d.desk, 'desk', 128)});}),
      answer: optional(s.answer, outcome), landedNotice: optional(s.landedNotice, outcome)});
  });
  if (count(r.shown, 'history', 64) !== list.length) fail('suggestion history');
  // A ship from before this field read its whole archive or did not answer at all, so a missing field means complete.
  if (r.archiveComplete !== undefined && typeof r.archiveComplete !== 'boolean') fail('suggestion history');
  return Object.freeze({owner, project: wanted, observedAt: when(r.observedAt, 'history time'), suggestions: count(r.suggestions, 'history'), archiveComplete: r.archiveComplete !== false, rows: Object.freeze(list)});
}
/** The four steps of one suggestion, each as it stands: authored, reviewed, landed, acknowledged. */
export function suggestionSteps(s: SuggestionRow): string[] {
  const told = s.landedNotice ?? s.answer;
  return [`Authored by ${s.peer} at ${s.authoredAt} on revision ${s.baseRevision} (${s.files} file${s.files === 1 ? '' : 's'})`,
    s.reviewed ? `Reviewed: ${s.reviewed.verdict} at ${s.reviewed.at} (candidate ${shortHex(s.reviewed.candidate)})` : 'Not reviewed',
    s.landed ? `Landed in ${s.landed.desk} at revision ${s.landed.revision}` : 'Not landed',
    !told ? 'Nothing told to the author yet' : told.status === 'delivered' ? `Acknowledged by their ship at ${told.acknowledgedAt ?? 'an unrecorded time'} (${told.kind.replace('-', ' ')})`
      : `Told (${told.kind.replace('-', ' ')}): ${told.status}`];
}
export function historyReport(h: SuggestionHistory): Report {
  const landed = h.rows.filter(s => s.landed).length;
  return {title: `Suggestions in ${h.project}`, status: `${h.suggestions} suggestion${h.suggestions === 1 ? '' : 's'}, ${landed} landed${h.suggestions > h.rows.length ? `; the newest ${h.rows.length} are shown` : ''}. Read from the ship at ${h.observedAt}.${h.archiveComplete ? '' : ' The ship\'s archive is longer than it reads at once, so some suggestions may be missing here.'}`,
    note: 'Landed means an applied candidate holds every suggested file exactly. Each author is told once.',
    sections: [{title: 'Newest first', empty: 'Nobody has suggested anything.', lines: h.rows.map(s => ({text: `${shortHex(s.request)} from ${s.peer}`, detail: suggestionSteps(s).join('\n'), mark: s.landed ? 'ok' as const : 'note' as const}))}]};
}

// ---- file presence
export const PRESENCE_MODES = ['viewing', 'editing', 'agent'] as const;
export interface PresenceEntry {readonly ship: string; readonly path: string; readonly mode: typeof PRESENCE_MODES[number]; readonly label: string; readonly at: string; readonly until: string}
export interface PresenceBoard {readonly authority: string; readonly project: string; readonly observedAt: string; readonly entries: readonly PresenceEntry[]; readonly refused: readonly {readonly path: string; readonly reason: string; readonly at: string}[]}
/** The ship's refusal name out of an acknowledgement trace (`%presence-path-not-shared`), or the trace's first line. */
export function refusalName(reason: string): string {
  const named = /%([a-z][a-z0-9-]{2,63})/.exec(reason);
  return named ? named[1]! : reason.split('\n')[0]!.slice(0, 120) || 'refused';
}
export function presenceBoard(value: unknown, authority: string, wanted: string): PresenceBoard {
  const r = record(value, 'presence');
  if (r.schema !== 'readymade-file-presence-v1' || ship(r.authority, 'presence') !== authority || project(r.project) !== wanted) fail('presence');
  const entries = rows(r.entries, 'presence', 64, v => {
    const e = record(v, 'presence entry');
    if (!(PRESENCE_MODES as readonly unknown[]).includes(e.mode)) fail('presence mode');
    return Object.freeze({ship: ship(e.ship, 'presence ship'), path: shipPath(e.path), mode: e.mode as PresenceEntry['mode'], label: text(e.label, 'presence label', 64, true),
      at: when(e.at, 'presence time'), until: when(e.until, 'presence lease')});
  });
  const refused = rows(r.refused ?? [], 'presence', 64, v => {const x = record(v, 'presence refusal'); return Object.freeze({path: shipPath(x.path), reason: refusalName(text(x.reason, 'refusal', 2048)), at: when(x.at, 'refusal time')});});
  return Object.freeze({authority, project: wanted, observedAt: when(r.observedAt, 'presence time'), entries: Object.freeze(entries), refused: Object.freeze(refused)});
}
export function presenceReport(authority: string, wanted: string, path: string, mode: PresenceEntry['mode'] | 'closed', label = '', seconds = 240): JsonObject {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) fail('presence lease');
  return {schema: 'readymade-file-presence-v1', authority: ship(authority, 'authority'), project: project(wanted), path: shipPath(path), mode, label: text(label, 'label', 64, true), seconds: String(seconds)};
}
const MODE_WORDS: Record<PresenceEntry['mode'], string> = {viewing: 'viewing', editing: 'editing (a private draft)', agent: 'claimed by an agent'};
/** Everyone the owner's ship shows on the project's files now, file by file, and any report of this ship it refused. */
export function boardReport(board: PresenceBoard, me: string): Report {
  const paths = [...new Set(board.entries.map(e => e.path))].sort();
  return {title: `Who Has What Open in ${board.project}`, status: `${board.entries.length} open on ${paths.length} file${paths.length === 1 ? '' : 's'}. Read from the ship at ${board.observedAt}.`,
    note: `As ${board.authority}'s ship shows it to you: only files shared with you, and only reports that have not expired (a report lasts a few minutes).`,
    sections: [{title: 'Files', empty: 'Nobody has a shared file open, or nobody is showing it.', lines: paths.map(path => ({text: path,
      detail: board.entries.filter(e => e.path === path).map(e => `${e.ship === me ? 'You' : e.ship}: ${MODE_WORDS[e.mode]}${e.label ? ` (${e.label})` : ''}, until ${e.until}`).join('\n'),
      mark: board.entries.some(e => e.path === path && e.mode === 'agent') ? 'warning' as const : 'note' as const}))},
      ...(board.refused.length ? [{title: 'Not shown', note: 'Reports of yours the owner\'s ship refused.', lines: board.refused.map(r => ({text: r.path, detail: refusalSentence(r.reason), mark: 'warning' as const}))}] : [])]};
}
/** Who else has this file open, in words: "~zod is editing (a private draft); ~nec's agent has claimed it". */
export function presenceText(board: PresenceBoard, path: string, me: string): string {
  const others = board.entries.filter(e => e.path === path && e.ship !== me);
  return others.map(e => e.mode === 'viewing' ? `${e.ship} is viewing` : e.mode === 'editing' ? `${e.ship} is editing (a private draft)` : `${e.ship}'s agent has claimed it${e.label ? ` (${e.label})` : ''}`).join('; ');
}
export interface PresenceTarget {readonly authority: string; readonly project: string; readonly path: string; readonly mode: 'viewing' | 'editing'}
const SHARED_SCHEMES = ['readymade-remote-source', 'readymade-remote-original', 'readymade-remote-draft'];
/**
 * The project file a document shows, for presence. A file another owner shared is reported to that owner (a draft
 * of it is editing, the rest viewing); one of this ship's own project files is reported to this ship (a private
 * draft is editing). Any other document, or a shared document this window cannot place, reports nothing.
 */
export function presenceTarget(doc: {readonly scheme: string; readonly path: string}, me: string, ownProject: string | undefined,
  shared: {readonly owner: string; readonly project: string; readonly path: string} | undefined): PresenceTarget | undefined {
  const ok = (p: string): boolean => /^(?:\/[a-z0-9~._-]+){1,16}$/.test(p);
  if (SHARED_SCHEMES.includes(doc.scheme)) {
    return shared && ok(shared.path) && shared.owner !== me ? {authority: shared.owner, project: shared.project, path: shared.path, mode: doc.scheme === 'readymade-remote-draft' ? 'editing' : 'viewing'} : undefined;
  }
  if (!ownProject || doc.scheme !== 'urbit-source' && doc.scheme !== 'readymade-draft') return undefined;
  // Both schemes are /<key>/<ship path>: the first segment is this computer's own key for the snapshot.
  const path = '/' + doc.path.split('/').slice(2).join('/');
  return ok(path) ? {authority: me, project: ownProject, path, mode: doc.scheme === 'readymade-draft' ? 'editing' : 'viewing'} : undefined;
}
/**
 * What to tell the owner's ship now, given what was last told and what the editor shows. A lease is renewed at half
 * its life; a file that is no longer open is closed once. Pure: the caller sends the commands and records them.
 */
export interface PresenceTold {readonly path: string; readonly mode: 'viewing' | 'editing'; readonly at: number}
export function presencePlan(told: PresenceTold | undefined, wanted: {path: string; mode: 'viewing' | 'editing'} | undefined, now: number, leaseSeconds = 240):
  {readonly path: string; readonly mode: 'viewing' | 'editing' | 'closed'}[] {
  const out: {path: string; mode: 'viewing' | 'editing' | 'closed'}[] = [];
  if (told && (!wanted || wanted.path !== told.path)) out.push({path: told.path, mode: 'closed'});
  if (wanted && (!told || told.path !== wanted.path || told.mode !== wanted.mode || now - told.at >= leaseSeconds * 500)) out.push({path: wanted.path, mode: wanted.mode});
  return out;
}

// ---- session streams
export interface SessionStream {
  readonly owner: string; readonly session: string; readonly project: string; readonly phase: 'connecting' | 'live' | 'ended'; readonly reason: string;
  readonly sequence: number; readonly reconnects: number; readonly updated: string; readonly status?: {readonly phase: string; readonly at: string; readonly source: string};
}
export function sessionStreams(value: unknown, me: string): SessionStream[] {
  const r = record(value, 'session streams');
  if (r.schema !== 'readymade-session-streams-v1' || ship(r.peer, 'streams') !== me) fail('session streams');
  when(r.observedAt, 'streams time');
  return rows(r.streams, 'session streams', 8, v => {
    const s = record(v, 'session stream');
    if (!['connecting', 'live', 'ended'].includes(s.phase as string)) fail('session stream');
    when(s.opened, 'stream time');
    return Object.freeze({owner: ship(s.owner, 'stream owner'), session: hex(s.session, 'session'), project: project(s.project), phase: s.phase as SessionStream['phase'], reason: word(s.reason, 'stream reason'),
      sequence: count(s.sequence, 'sequence'), reconnects: count(s.reconnects, 'reconnects', 64), updated: when(s.updated, 'stream time'),
      status: optional(s.status, x => {const d = record(x, 'stream status'); return Object.freeze({phase: word(d.phase, 'session phase'), at: when(d.at, 'status time'), source: text(d.source, 'source', 200)});})});
  });
}
/**
 * A whole number the way the ship reads one: digits in groups of three with dots between ("1.024"). The ship parses
 * both numbers of the open command this way; plain digits ("1024") are refused from 1,000 upward, which made a
 * session impossible to follow again once its sequence passed 999.
 */
export function udText(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) fail('number');
  return String(n).replace(/\B(?=(\d{3})+$)/g, '.');
}
const UD = /^(?:0|[1-9][0-9]{0,2}(?:\.[0-9]{3})*)$/;
/** `generation` is passed on exactly as the owner's ship listed it (already in the ship's own form), or as a number. */
export function streamOpen(owner: string, wanted: string, generation: string | number, inspection: string, session: string, cursor = 0): JsonObject {
  const listed = typeof generation === 'number' ? udText(generation) : generation;
  if (typeof listed !== 'string' || listed.length > 26 || !UD.test(listed) || !Number.isSafeInteger(cursor) || cursor < 0) fail('stream');
  return {schema: 'readymade-session-stream-v1', action: 'open', owner: ship(owner, 'owner'), project: project(wanted), generation: listed,
    inspection: hex(inspection, 'inspection'), session: hex(session, 'session'), ...(cursor ? {cursor: udText(cursor)} : {})};
}
export function streamClose(owner: string, session: string): JsonObject {return {schema: 'readymade-session-stream-v1', action: 'close', owner: ship(owner, 'owner'), session: hex(session, 'session')};}
/** One line for a list: "paused · sequence 11 · pataphor-demo-mp-work/8", or why the stream ended. */
export function streamText(s: SessionStream): string {
  if (s.phase === 'ended') return `Stream ended: ${refusalSentence(s.reason)}`;
  if (!s.status) return s.phase === 'live' ? `Live; nothing has changed since sequence ${s.sequence}` : 'Connecting…';
  return `${s.status.phase} · sequence ${s.sequence} · ${s.status.source}`;
}

// ---- peer work requests, the owner's queue, and session roles
export interface WorkRow {
  readonly id: string; readonly peer: string; readonly nonce: string; readonly project: string; readonly session: string; readonly at: string;
  readonly status: 'queued' | 'dispatched' | 'finished'; readonly dispatchedAt?: string; readonly policyVersion?: number;
  readonly outcome?: {readonly phase: string; readonly sequence: number; readonly revision: number; readonly at: string};
}
export interface WorkAsk {readonly nonce: string; readonly owner: string; readonly project: string; readonly session: string; readonly status: 'sent' | 'accepted' | 'refused'; readonly reason: string; readonly at: string}
export interface WorkQueue {
  readonly ship: string; readonly observedAt: string; readonly store: boolean; readonly requests: readonly WorkRow[]; readonly asked: readonly WorkAsk[];
  /** Withdrawals an owner's ship refused, by this ship's own request nonce. */
  readonly withdrawRefused: readonly {readonly nonce: string; readonly reason: string}[];
}
const workRow = (value: unknown): WorkRow => {
  const w = record(value, 'work request');
  if (!['queued', 'dispatched', 'finished'].includes(w.status as string)) fail('work request');
  return Object.freeze({id: hex(w.id, 'work id'), peer: ship(w.peer, 'work peer'), nonce: hex(w.nonce, 'work nonce'), project: project(w.project), session: hex(w.session, 'session'), at: when(w.at, 'work time'),
    status: w.status as WorkRow['status'], dispatchedAt: optional(w.dispatchedAt, d => when(d, 'dispatch time')), policyVersion: optional(w.policyVersion, p => count(p, 'policy version', 4096)),
    outcome: optional(w.outcome, x => {const o = record(x, 'work outcome'); return Object.freeze({phase: word(o.phase, 'phase'), sequence: count(o.sequence, 'sequence'), revision: count(o.revision, 'revision'), at: when(o.at, 'outcome time')});})});
};
export function workQueue(value: unknown, me: string): WorkQueue {
  const r = record(value, 'work queue');
  if (r.schema !== 'readymade-work-queue-v1' || ship(r.ship, 'work queue') !== me || typeof r.store !== 'boolean') fail('work queue');
  const asked = rows(r.asked, 'work queue', 512, v => {
    const a = record(v, 'work ask');
    if (!['sent', 'accepted', 'refused'].includes(a.status as string)) fail('work ask');
    return Object.freeze({nonce: hex(a.nonce, 'work nonce'), owner: ship(a.owner, 'work owner'), project: project(a.project), session: hex(a.session, 'session'), status: a.status as WorkAsk['status'],
      reason: a.status === 'refused' ? refusalName(text(a.reason, 'refusal', 2048, true)) : '', at: when(a.at, 'ask time')});
  });
  const withdrawRefused = rows(r.withdrawRefused ?? [], 'work queue', 64, v => {const w = record(v, 'withdrawal'); when(w.at, 'withdrawal time'); return Object.freeze({nonce: hex(w.nonce, 'work nonce'), reason: refusalName(text(w.reason, 'refusal', 2048))});});
  return Object.freeze({ship: me, observedAt: when(r.observedAt, 'work time'), store: r.store as boolean, requests: Object.freeze(rows(r.requests, 'work queue', 512, workRow)), asked: Object.freeze(asked),
    withdrawRefused: Object.freeze(withdrawRefused)});
}
const workLine = (w: WorkRow): ReportLine => ({text: `${shortHex(w.nonce)} from ${w.peer} in ${w.project}`,
  detail: `${w.status === 'queued' ? 'Queued' : w.status === 'dispatched' ? `Running since ${w.dispatchedAt ?? 'an unknown time'}`
    : w.outcome?.phase === 'not-started' ? 'Not started: the session did not take it, so no run began. Its requester was told.'
    : w.outcome?.phase === 'not-run' ? 'Taken, not run: the session holds this instruction and has not started a run of it. Run the session to do it. Its requester was told.'
    : w.outcome?.phase === 'stopped' ? `Stopped: the session began it and then sat ready without running for ten minutes (revision ${w.outcome.revision}). Run the session to continue. Its requester was told.`
    : w.outcome?.phase === 'session-gone' ? 'Not finished: its session no longer exists on this ship. Its requester was told.'
    : w.outcome?.phase === 'dismissed' ? 'Dismissed by you before it started. Nothing ran.' : w.outcome?.phase === 'withdrawn' ? 'Withdrawn by its requester before it started. Nothing ran.' : w.outcome?.phase === 'revoked' ? 'Not started: its requester lost access to the session while it waited. Nothing ran.' : `Finished: ${w.outcome?.phase ?? 'unknown'} at revision ${w.outcome?.revision ?? '?'}`}` +
    `${w.policyVersion ? ` · policy version ${w.policyVersion}` : ''}\nSession ${shortHex(w.session)} · asked ${w.at}`, mark: ['not-started', 'not-run', 'stopped', 'session-gone'].includes(w.outcome?.phase ?? '') ? 'warning' : w.status === 'finished' ? 'ok' : 'note',
  action: w.status === 'queued' ? {id: `dismiss:${w.id}`, label: 'Dismiss…'} : undefined});
/**
 * `inbox` is what owners told this ship. `null` means the notices could not be read: progress is then said to
 * be unknown and no Withdraw is offered, instead of showing every request as queued with nothing reported.
 */
export function workReport(q: WorkQueue, admissionsLeft?: number, journal: readonly WorkAsked[] = [], inbox: readonly Notice[] | null = [], room = ''): Report {
  const open = q.requests.filter(w => w.status !== 'finished'), kept = new Set(journal.map(a => a.nonce));
  const unread = inbox === null, told = inbox ?? [];
  const progress = (a: WorkAsked): string => unread && a.answer !== 'refused' && a.answer !== 'unknown' ? 'Progress unknown: the notices could not be read just now.' : workProgress(a, told);
  const mine: ReportLine[] = journal.map(a => workCurrent(a, q.asked)).map(a => ({text: a.text, action: !unread && workWithdrawable(a, told) ? {id: `withdraw:${a.nonce}`, label: 'Withdraw…'} : undefined, detail: `${progress(a)}\n${shortHex(a.nonce)} to ${a.owner} in ${a.project}, session ${shortHex(a.session)}, asked ${new Date(a.at).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    mark: a.answer === 'refused' || a.answer === 'unknown' ? 'warning' as const : told.some(n => n.from === a.owner && n.subject === a.nonce && n.kind === 'work-finished') ? 'ok' as const : 'note' as const}));
  return {title: 'Work Requests', status: `${open.length} open on this ship, ${new Set([...kept, ...q.asked.map(a => a.nonce)]).size} asked of other owners. Read from the ship at ${q.observedAt}.`,
    note: `${q.store ? '' : 'This ship has no work store, so it cannot take requests. '}A request is admitted only under your standing policy, from a contributor, for a session you shared with them.` +
      `${admissionsLeft === undefined ? '' : ` Your policy has ${admissionsLeft} admission${admissionsLeft === 1 ? '' : 's'} left.`}` +
      `${unread && journal.length ? ' The notices could not be read just now, so the progress of what this ship asked is not shown and nothing can be withdrawn from here. Read again.' : ''}${room}`,
    sections: [{title: 'Asked of this ship', empty: 'Nobody has asked this ship for work.', lines: q.requests.map(workLine)},
      {title: 'This ship asked', empty: 'This ship has asked nobody for work.', lines: [...mine, ...q.asked.filter(a => !kept.has(a.nonce)).map(a => ({text: `${shortHex(a.nonce)} to ${a.owner} in ${a.project}`,
        detail: `${a.status === 'sent' ? 'Sent; waiting for their answer' : a.status === 'accepted' ? 'Accepted; progress arrives as notices' : `Refused: ${refusalSentence(a.reason)}`}\n${a.at}`,
        mark: a.status === 'refused' ? 'warning' as const : 'note' as const}))]}]};
}
/**
 * What this computer asked of other owners, kept here because the ship's own list of asks does not survive its
 * restart. Newest first, at most 64. The answer is what the owner's ship said when it was read once; progress after
 * that comes from the durable notices, matched by the request's nonce.
 */
export interface WorkAsked {
  readonly nonce: string; readonly owner: string; readonly project: string; readonly session: string; readonly text: string; readonly at: number;
  /** `unanswered`: sent, and the owner had not answered when it was read once. `unknown`: the ship gave no readable answer when it was sent, so it may never have left. */
  readonly answer: 'queued' | 'refused' | 'unanswered' | 'unknown'; readonly reason?: string;
}
export const WORK_JOURNAL_MAX = 64;
/** A stored journal read strictly: anything that is not an entry this version wrote is dropped, never repaired. */
export function workJournal(value: unknown): WorkAsked[] {
  if (!Array.isArray(value)) return [];
  const out: WorkAsked[] = [], seen = new Set<string>();
  for (const item of value.slice(0, WORK_JOURNAL_MAX)) {
    try {
      const r = record(item, 'work journal');
      if (!['queued', 'refused', 'unanswered', 'unknown'].includes(r.answer as string) || typeof r.at !== 'number' || !Number.isSafeInteger(r.at) || r.at < 0) continue;
      const entry: WorkAsked = {nonce: hex(r.nonce, 'nonce'), owner: ship(r.owner, 'owner'), project: project(r.project), session: hex(r.session, 'session'), text: text(r.text, 'request', 4096),
        at: r.at, answer: r.answer as WorkAsked['answer'], ...(typeof r.reason === 'string' && r.reason ? {reason: text(r.reason, 'reason', 200)} : {})};
      if (seen.has(entry.nonce)) continue;
      seen.add(entry.nonce); out.push(Object.freeze(entry));
    } catch { /* not an entry: dropped */ }
  }
  return out;
}
export function workJournalAdd(list: readonly WorkAsked[], entry: WorkAsked): WorkAsked[] {
  return workJournal([entry, ...list.filter(row => row.nonce !== entry.nonce)]);
}
/**
 * An entry whose first answer this computer never read, brought up to what this ship holds now: the owner's answer
 * arrives a moment after sending, and the ship keeps it until its next restart. Nothing is guessed when it holds none.
 */
export function workCurrent(asked: WorkAsked, held: readonly WorkAsk[]): WorkAsked {
  if (asked.answer !== 'unanswered' && asked.answer !== 'unknown') return asked;
  const now = held.find(a => a.nonce === asked.nonce && a.owner === asked.owner);
  if (now?.status === 'refused') return {...asked, answer: 'refused', reason: now.reason};
  if (now?.status === 'accepted') return {...asked, answer: 'queued'};
  return now && asked.answer === 'unknown' ? {...asked, answer: 'unanswered'} : asked;
}
/** Where one asked request stands: the newest notice the owner sent about it, else the owner's first answer. */
export function workProgress(asked: WorkAsked, inbox: readonly Notice[]): string {
  const told = inbox.filter(n => n.from === asked.owner && n.subject === asked.nonce && n.kind.startsWith('work-'))
    .sort((a, b) => dateAtom(a.at) < dateAtom(b.at) ? 1 : dateAtom(a.at) > dateAtom(b.at) ? -1 : 0)[0];
  if (told) return told.kind === 'work-finished' ? told.detail || 'Finished.' : told.kind === 'work-started' ? told.detail || 'Started.' : 'Queued; waiting for the session to be free.';
  if (asked.answer === 'refused') return `Refused: ${refusalSentence(asked.reason ?? 'refused')}`;
  if (asked.answer === 'unknown') return 'Unknown whether it was sent: the ship gave no readable answer. It was not sent again.';
  return asked.answer === 'queued' ? 'Queued; no progress has been reported yet.' : 'Sent; the owner\'s ship had not answered when it was read. It was not sent again.';
}
/** A request this computer asked that the owner queued and has not reported as started or finished. */
export function workWithdrawable(asked: WorkAsked, inbox: readonly Notice[]): boolean {
  // Queued by the owner's own word: its first answer, or its durable notice when that answer was never read here.
  const about = inbox.filter(n => n.from === asked.owner && n.subject === asked.nonce);
  return (asked.answer === 'queued' || asked.answer !== 'refused' && about.some(n => n.kind === 'work-queued')) && !about.some(n => n.kind === 'work-started' || n.kind === 'work-finished');
}
export function workDismiss(id: string): JsonObject {return {schema: 'readymade-work-dismiss-v1', id: hex(id, 'work id')};}
export function workWithdraw(asked: Pick<WorkAsked, 'owner' | 'nonce' | 'project' | 'session'>): JsonObject {
  return {schema: 'readymade-work-withdraw-v1', owner: ship(asked.owner, 'owner'), nonce: hex(asked.nonce, 'nonce'), project: project(asked.project), session: hex(asked.session, 'session')};
}
export function workNonce(): string {
  const raw = randomBytes(16).toString('hex').replace(/^0+/, '') || '1', lead = raw.length % 4 || 4;
  return '0x' + [raw.slice(0, lead), ...(raw.slice(lead).match(/.{4}/g) ?? [])].join('.');
}
export function workAsk(owner: string, wanted: string, session: string, request: string, nonce = workNonce()): JsonObject {
  return {schema: 'readymade-work-request-v1', owner: ship(owner, 'owner'), nonce: hex(nonce, 'nonce'), project: project(wanted), session: hex(session, 'session'), text: text(request.trim(), 'request', 4096)};
}
export interface SessionRoles {readonly session: string; readonly controller: string; readonly requesters: readonly string[]; readonly observers: readonly string[]; readonly requests: readonly WorkRow[]}
export function sessionRoles(value: unknown, owner: string, wanted: string): SessionRoles[] {
  const r = record(value, 'session roles');
  if (r.schema !== 'readymade-session-roles-v1' || ship(r.owner, 'roles') !== owner || project(r.project) !== wanted) fail('session roles');
  when(r.observedAt, 'roles time');
  return rows(r.sessions, 'session roles', 512, v => {
    const s = record(v, 'session roles');
    return Object.freeze({session: hex(s.session, 'session'), controller: ship(s.controller, 'controller'), requesters: Object.freeze(rows(s.requesters, 'roles', 64, x => ship(x, 'requester'))),
      observers: Object.freeze(rows(s.observers, 'roles', 64, x => ship(x, 'observer'))), requests: Object.freeze(rows(s.requests, 'roles', 64, workRow))});
  });
}
export function rolesReport(wanted: string, roles: readonly SessionRoles[]): Report {
  return {title: `Session Roles in ${wanted}`, status: `${roles.length} session${roles.length === 1 ? '' : 's'} shared or asked about.`,
    note: 'The controller runs the session. A requester has asked for work in it. An observer may only watch.',
    sections: [{title: 'Sessions', empty: 'No session is shared and nobody has asked for work.', lines: roles.map(s => ({text: `Session ${shortHex(s.session)}`,
      detail: `Controller: ${s.controller}\nRequesters: ${s.requesters.join(', ') || 'none'}\nObservers: ${s.observers.join(', ') || 'none'}` +
        `${s.requests.length ? `\nOpen requests: ${s.requests.map(w => `${shortHex(w.nonce)} ${w.status}`).join(', ')}` : ''}`}))}]};
}
