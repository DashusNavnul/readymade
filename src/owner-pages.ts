import {count, fail, hex, projectName, record, rows, shortHex, text, when} from './native-pages';
import type {JsonObject} from './protocol';
import type {Report, ReportLine, ReportSection} from './report';

/**
 * Strict readers for the owner's pages on the native console, and the report each one becomes. A reader throws on
 * anything this version of the ship would not send, so a screen never shows half-understood data.
 */
const optional = <T>(value: unknown, read: (v: unknown) => T): T | undefined => value === null || value === undefined ? undefined : read(value);

// ---- overview: running work, changes, blockers, decisions, what happens next
export interface OverviewLine {readonly kind: string; readonly what: string}
export interface OwnerOverview {
  readonly observedAt: string; readonly running: readonly OverviewLine[]; readonly changes: readonly OverviewLine[];
  readonly blockers: readonly OverviewLine[]; readonly decisions: readonly OverviewLine[]; readonly next: readonly OverviewLine[];
  readonly admissionsLeft?: number; readonly unavailable: readonly string[];
}
const overviewLine = (value: unknown): OverviewLine => {
  const r = record(value, 'overview line');
  // The ship builds a line from stored text: a question line alone can carry 2,048 bytes of question and 1,024 of
  // consequence. One long open question once made the whole overview unreadable at the old 2,048 limit.
  return Object.freeze({kind: text(r.kind, 'overview kind', 64), what: text(r.what, 'overview line', 8192)});
};
export function ownerOverview(value: unknown): OwnerOverview {
  const r = record(value, 'overview');
  if (r.schema !== 'owner-overview-v1') fail('overview');
  const list = (key: string) => Object.freeze(rows(r[key], 'overview', 512, overviewLine));
  return Object.freeze({observedAt: when(r.observedAt, 'overview time'), running: list('running'), changes: list('changes'), blockers: list('blockers'),
    decisions: list('decisions'), next: list('next'), admissionsLeft: optional(r.policyAdmissionsLeft, v => count(v, 'admissions')),
    unavailable: Object.freeze(rows(r.unavailable, 'overview', 32, v => text(v, 'overview source', 64)))});
}
export function overviewReport(o: OwnerOverview): Report {
  const part = (title: string, lines: readonly OverviewLine[], empty: string, mark: ReportLine['mark'] = 'note'): ReportSection =>
    ({title, empty, lines: lines.map(l => ({text: l.what, detail: l.kind, mark}))});
  const trouble = o.blockers.length;
  return {title: 'Overview', status: `${overviewWaiting(o)}${trouble ? `, ${trouble} blocker${trouble === 1 ? '' : 's'}` : ''}. Read from the ship at ${o.observedAt}.`,
    note: o.unavailable.length ? `The ship could not read: ${o.unavailable.join(', ')}. Those parts are missing below, not empty.` : undefined,
    sections: [part('Waiting on you', o.decisions, 'No decision is waiting.', 'warning'), part('Blockers', o.blockers, 'Nothing is blocked.', 'problem'),
      part('Running now', o.running, 'Nothing is running.'), part('Next', o.next, 'Nothing is queued.'),
      part('Changed in the last day', o.changes, 'Nothing landed or finished.', 'ok')]};
}
/**
 * How many decisions wait, in words. When the ship could not read some of its sources, "nothing" is not claimed:
 * the count covers only what it could read, and a decision may sit in a part it could not.
 */
export function overviewWaiting(o: OwnerOverview): string {
  const waiting = o.decisions.length, partial = o.unavailable.length > 0;
  if (waiting) return `${waiting} decision${waiting === 1 ? '' : 's'} waiting on you${partial ? ' in the parts the ship could read' : ''}`;
  return partial ? 'No decision found, but the ship could not read every part' : 'Nothing is waiting on you';
}
/** Blockers as problems a project list can show: one per line, titled by the area before the first colon. */
export function overviewProblems(o: OwnerOverview): {readonly title: string; readonly detail: string}[] {
  return o.blockers.map(b => {const at = b.what.indexOf(': '); return at > 0 ? {title: b.what.slice(0, at), detail: b.what.slice(at + 2)} : {title: b.kind, detail: b.what};});
}

// ---- tasks: claims, questions for the owner, proposals
export interface TaskRow {readonly task: string; readonly claims: number; readonly holder?: string; readonly until?: string; readonly blockedBy: readonly string[]}
export interface OwnerQuestion {
  readonly id: string; readonly task: string; readonly who: string; readonly text: string; readonly consequence: string; readonly at: string; readonly open: boolean; readonly answer?: string;
  /** Its asker took it back; it was never answered. */
  readonly withdrawn: boolean;
}
export interface TaskProposal {
  readonly id: string; readonly task: string; readonly who: string; readonly project: string; readonly evidence: string; readonly outcome: string;
  readonly depends: readonly string[]; readonly paths: readonly string[]; readonly policyVersion: number; readonly at: string;
  /** How it ended without becoming work: its proposer withdrew it, or the owner dismissed it. */
  readonly closed?: 'withdrawn' | 'dismissed';
}
export interface OwnerTasks {readonly observedAt: string; readonly tasks: readonly TaskRow[]; readonly questions: readonly OwnerQuestion[]; readonly proposals: readonly TaskProposal[]}
const taskName = (v: unknown): string => {const t = text(v, 'task', 128); if (!/^[a-z0-9~._-]+$/.test(t)) fail('task'); return t;};
/** Undefined when the ship has no task store yet. */
export function ownerTasks(value: unknown): OwnerTasks | undefined {
  const r = record(value, 'tasks');
  if (r.schema !== 'owner-tasks-v1' || typeof r.available !== 'boolean') fail('tasks');
  if (!r.available) return undefined;
  const tasks = rows(r.tasks, 'tasks', 1024, v => {
    const t = record(v, 'task');
    return Object.freeze({task: taskName(t.task), claims: count(t.claims, 'claims', 4096),   // the ship caps claims at 256 but counts each release too: 257 was unreadable at a limit of 256 holder: optional(t.holder, h => text(h, 'holder', 64)),
      until: optional(t.until, u => when(u, 'lease')), blockedBy: Object.freeze(rows(t.blockedBy, 'task', 64, b => hex(b, 'question id')))});
  });
  const questions = rows(r.questions, 'tasks', 1024, v => {
    const q = record(v, 'question');
    if (typeof q.open !== 'boolean' || q.withdrawn !== undefined && typeof q.withdrawn !== 'boolean' || q.withdrawn === true && (q.open || q.answer !== null)) fail('question');
    return Object.freeze({id: hex(q.id, 'question id'), task: taskName(q.task), who: text(q.who, 'asker', 64), text: text(q.text, 'question', 2048),
      consequence: text(q.consequence, 'consequence', 1024), at: when(q.at, 'question time'), open: q.open as boolean, answer: optional(q.answer, a => text(a, 'answer', 2048)), withdrawn: q.withdrawn === true});
  });
  const proposals = rows(r.proposals ?? [], 'tasks', 256, v => {
    const p = record(v, 'proposal');
    if (!projectName(p.project)) fail('proposal');
    return Object.freeze({id: hex(p.id, 'proposal id'), task: taskName(p.task), who: text(p.who, 'proposer', 64), project: p.project as string,
      evidence: text(p.evidence, 'evidence', 2048), outcome: text(p.outcome, 'outcome', 1024),
      depends: Object.freeze(rows(p.depends, 'proposal', 16, taskName)), paths: Object.freeze(rows(p.paths, 'proposal', 64, x => text(x, 'path', 512))),
      policyVersion: count(p.policyVersion, 'policy version', 4096), at: when(p.at, 'proposal time'),
      closed: optional(p.closed, x => {if (x !== 'withdrawn' && x !== 'dismissed') fail('proposal'); return x as 'withdrawn' | 'dismissed';})});
  });
  if (count(r.openQuestions, 'tasks', 1024) !== questions.filter(q => q.open).length) fail('tasks');
  return Object.freeze({observedAt: when(r.observedAt, 'tasks time'), tasks: Object.freeze(tasks), questions: Object.freeze(questions), proposals: Object.freeze(proposals)});
}
export function tasksReport(t: OwnerTasks): Report {
  const open = t.questions.filter(q => q.open);
  return {title: 'Tasks and Questions', status: `${open.length ? `${open.length} question${open.length === 1 ? '' : 's'} waiting on you` : 'No question is waiting on you'}. Read from the ship at ${t.observedAt}.`,
    note: 'A question blocks only its own task: nobody can claim that task until you answer. Every other task stays open.',
    sections: [
      {title: 'Questions for you', empty: 'No agent has asked you anything.', lines: [...open, ...t.questions.filter(q => !q.open)].map(q => ({
        text: q.text, mark: q.open ? 'warning' as const : 'ok' as const,
        detail: `${q.who} on ${q.task}, ${q.at}\nWhy it matters: ${q.consequence}${q.answer ? `\nYou answered: ${q.answer}` : q.withdrawn ? `\n${q.who} withdrew this question; it needs no answer.` : ''}`,
        action: q.open ? {id: `answer:${q.id}`, label: 'Answer…'} : undefined}))},
      {title: 'Tasks', empty: 'No task has been claimed.', lines: t.tasks.map(row => ({
        text: row.task, mark: row.blockedBy.length ? 'warning' as const : 'note' as const,
        detail: `${row.holder ? `Held by ${row.holder} until ${row.until ?? 'an unknown time'}` : 'Nobody holds it'} · ${row.claims} claim record${row.claims === 1 ? '' : 's'}${row.blockedBy.length ? `\nBlocked by ${row.blockedBy.length} open question${row.blockedBy.length === 1 ? '' : 's'}` : ''}`}))},
      {title: 'Proposals', note: 'Admitted through your standing policy. A proposal starts no work.', empty: 'No task has been proposed.', lines: t.proposals.map(p => ({
        text: `${p.task} (${p.project})`, mark: p.closed ? 'ok' as const : 'note' as const, action: p.closed ? undefined : {id: `dismiss-proposal:${p.id}`, label: 'Dismiss…'},
        detail: `${p.closed === 'withdrawn' ? `Withdrawn by ${p.who}. ` : p.closed === 'dismissed' ? 'Dismissed by you. ' : ''}${p.who}, ${p.at}, policy version ${p.policyVersion}\nEvidence: ${p.evidence}\nOutcome: ${p.outcome}\nPaths: ${p.paths.join(', ')}${p.depends.length ? `\nDepends on: ${p.depends.join(', ')}` : ''}`}))}]};
}
export function proposalDismiss(id: string): JsonObject {return {action: 'dismiss-proposal', id: hex(id, 'proposal id')};}
export function answerCommand(id: string, answer: string): JsonObject {
  return {action: 'answer', id: hex(id, 'question id'), text: text(answer.trim(), 'answer', 2048)};
}

// ---- standing policy
export interface PolicyBody {
  readonly project: string; readonly objectives: readonly string[]; readonly paths: readonly string[]; readonly tools: readonly string[];
  readonly resources: {readonly maxTurns: number; readonly maxSeconds: number; readonly maxEvalWork: number; readonly maxAdmissions: number};
  readonly escalation: string;
}
export interface PolicyVersion {readonly version: number; readonly at?: string; readonly revoked: boolean; readonly body?: PolicyBody; readonly error?: string}
export interface StandingPolicy {readonly chain: string; readonly storeRevision: number; readonly inForce?: PolicyBody; readonly versions: readonly PolicyVersion[]}
export const POLICY_TOOLS = ['list', 'read', 'search', 'create', 'replace', 'patch', 'patches', 'writes', 'move', 'delete', 'diff', 'undo', 'batch', 'compile', 'check', 'eval', 'inspect', 'jobs', 'observe', 'cancel'] as const;
const shipPath = (v: unknown): string => {const p = text(v, 'path', 512); if (!/^(?:\/[a-z0-9~._-]+){1,16}$/.test(p)) fail('path'); return p;};
/**
 * A path as a stored policy version may hold it. The ship accepts any path of one to sixteen parts, including an
 * empty part ("/lib/a/"), and every version is kept for good: one such version in the history made the whole
 * Standing Policy screen unreadable. Read as it is; a policy this app sends still needs proper parts (`shipPath`).
 */
const heldPath = (v: unknown): string => {const p = text(v, 'path', 2048); if (!/^(?:\/[a-z0-9~._-]*){1,16}$/.test(p)) fail('path'); return p;};
function policyBody(value: unknown, sending = false): PolicyBody {
  const b = record(value, 'policy'), res = record(b.resources, 'policy resources');
  if (!projectName(b.project)) fail('policy');
  const tools = rows(b.tools, 'policy', 32, t => {if (!(POLICY_TOOLS as readonly unknown[]).includes(t)) fail('policy tool'); return t as string;});
  return Object.freeze({project: b.project as string, objectives: Object.freeze(rows(b.objectives, 'policy', 16, o => text(o, 'objective', 1024))),
    paths: Object.freeze(rows(b.paths, 'policy', 256, sending ? shipPath : heldPath)), tools: Object.freeze(tools),
    resources: Object.freeze({maxTurns: count(res.maxTurns, 'policy', 2 ** 40), maxSeconds: count(res.maxSeconds, 'policy', 2 ** 40),
      maxEvalWork: count(res.maxEvalWork, 'policy', 2 ** 50), maxAdmissions: count(res.maxAdmissions, 'policy', 2 ** 40)}),
    escalation: text(b.escalation, 'escalation', 2048)});
}
/** Undefined when the ship has no policy store. */
export function standingPolicy(value: unknown): StandingPolicy | undefined {
  const r = record(value, 'policy');
  if (r.schema !== 'standing-policy-view-v1' || typeof r.available !== 'boolean') fail('policy');
  if (!r.available) return undefined;
  const versions = rows(r.versions, 'policy', 4096, v => {
    const row = record(v, 'policy version'), version = count(row.version, 'policy version', 4096);
    if (typeof row.error === 'string') return Object.freeze({version, revoked: false, error: text(row.error, 'policy error', 128)});
    if (typeof row.revoked !== 'boolean' || row.revoked !== (row.body === null)) fail('policy version');
    return Object.freeze({version, at: when(row.at, 'policy time'), revoked: row.revoked as boolean, body: optional(row.body, policyBody)});
  });
  return Object.freeze({chain: text(r.chain, 'policy chain', 128), storeRevision: count(r.storeRevision, 'policy'), inForce: optional(r.inForce, policyBody), versions: Object.freeze(versions)});
}
const bodyLines = (b: PolicyBody): string => `Objectives: ${b.objectives.join('; ')}\nPaths: ${b.paths.join(', ') || 'none'}\nTools: ${b.tools.join(' ')}\n` +
  `Resources: ${b.resources.maxTurns} turns, ${b.resources.maxSeconds} seconds, ${b.resources.maxEvalWork} evaluation work, ${b.resources.maxAdmissions} admissions\nEscalation: ${b.escalation}`;
export function policyReport(p: StandingPolicy): Report {
  return {title: 'Standing Policy', status: p.inForce ? `A policy is in force for ${p.inForce.project}.` : 'No policy is in force: agents may not start work on their own.',
    note: p.chain === 'valid' ? 'What your ship\'s agents may do without asking. Cantrip checks and stores every version; nothing is erased.' : `The stored history does not check out (${p.chain}). Do not rely on it.`,
    actions: [{id: 'set', label: p.inForce ? 'Change the policy…' : 'Set a policy…'}, ...(p.inForce ? [{id: 'revoke', label: 'Revoke it…'}] : [])],
    sections: [{title: 'In force', empty: 'Nothing.', lines: p.inForce ? [{text: p.inForce.project, detail: bodyLines(p.inForce), mark: 'ok'}] : []},
      {title: 'Versions', empty: 'No version has been stored.', lines: p.versions.map(v => ({text: `Version ${v.version}${v.revoked ? ': revoked' : v.error ? ': unreadable' : `: ${v.body!.project}`}`,
        detail: v.error ? v.error : `${v.at}${v.body ? `\n${bodyLines(v.body)}` : ''}`, mark: v.error ? 'problem' as const : 'note' as const}))}]};
}
/**
 * Admissions the policy in force still allows: its limit less the requests already dispatched under that same
 * version, counted the way the ship counts them. Undefined when the ship has no policy store; 0 when none is in force.
 */
export function admissionsLeft(policy: StandingPolicy | undefined, requests: readonly {readonly policyVersion?: number}[]): number | undefined {
  if (!policy) return undefined;
  const newest = policy.versions.reduce<PolicyVersion | undefined>((best, v) => !best || v.version > best.version ? v : best, undefined);
  if (!policy.inForce || !newest || newest.revoked || newest.error) return 0;
  return Math.max(0, policy.inForce.resources.maxAdmissions - requests.filter(w => w.policyVersion === newest.version).length);
}
/** The exact command the ship's policy page takes. Throws before sending if a field could not be valid. */
export function policySet(body: PolicyBody): JsonObject {
  const checked = policyBody({...body, resources: {...body.resources}}, true);
  if (!checked.objectives.length || !checked.tools.length || Object.values(checked.resources).some(n => n < 1)) fail('policy');
  return {action: 'set', project: checked.project, objectives: [...checked.objectives], paths: [...checked.paths], tools: [...checked.tools], resources: {...checked.resources}, escalation: checked.escalation};
}

// ---- memory: standing, supersession, packets, handoff
/** A moment exactly as the ship writes one: "~2026.11.07..03.05.09" (UTC, whole seconds, two digits for every part after the year). */
export function dateAtomText(ms: number): string {
  const d = new Date(ms), two = (n: number): string => String(n).padStart(2, '0');
  if (Number.isNaN(d.getTime())) fail('time');
  return `~${d.getUTCFullYear()}.${two(d.getUTCMonth() + 1)}.${two(d.getUTCDate())}..${two(d.getUTCHours())}.${two(d.getUTCMinutes())}.${two(d.getUTCSeconds())}`;
}
export const MEMORY_STANDINGS = ['ruling', 'fact', 'hypothesis', 'question', 'unlabelled'] as const;
export interface MemoryItem {
  readonly name: string; readonly hash: string; readonly standing: typeof MEMORY_STANDINGS[number]; readonly description: string; readonly at: string;
  readonly supersededBy?: string; readonly cite: string; readonly body?: string;
}
export interface MemoryAccount {readonly since: string; readonly memories: readonly MemoryItem[]; readonly more: number; readonly supersessions: readonly {readonly new: string; readonly old: string; readonly reason: string}[]; readonly labels: number; readonly rulings: number}
export interface MemoryPacket {readonly topic: string; readonly budget: number; readonly bytes: number; readonly leftOut: number; readonly items: readonly MemoryItem[]}
export interface MemoryView {
  readonly view: string; readonly observedAt: string; readonly standings: Readonly<Record<typeof MEMORY_STANDINGS[number], number>>;
  readonly agents: readonly {readonly who: string; readonly turns: number; readonly newest: string}[];
  readonly memories?: readonly MemoryItem[]; readonly account?: MemoryAccount; readonly packet?: MemoryPacket; readonly openQuestions?: readonly MemoryItem[];
}
const memoryName = (v: unknown): string => text(v, 'memory name', 256);
function memoryItem(value: unknown): MemoryItem {
  const m = record(value, 'memory');
  if (!(MEMORY_STANDINGS as readonly unknown[]).includes(m.standing)) fail('memory standing');
  return Object.freeze({name: memoryName(m.name), hash: text(m.hash, 'memory hash', 16), standing: m.standing as MemoryItem['standing'],
    description: text(m.description, 'memory description', 4096, true), at: when(m.at, 'memory time'), supersededBy: optional(m.supersededBy, memoryName),
    cite: text(m.cite, 'memory citation', 320), body: optional(m.body, b => text(b, 'memory body', 262144, true))});
}
export function memoryView(value: unknown): MemoryView {
  const r = record(value, 'memory view');
  if (r.schema !== 'operator-memory-view-v1' || typeof r.error === 'string') fail('memory view');
  const st = record(r.standings, 'memory standings');
  const standings = Object.freeze(Object.fromEntries(MEMORY_STANDINGS.map(k => [k, count(st[k], 'memory standings')]))) as MemoryView['standings'];
  const agents = rows(r.agents ?? [], 'memory view', 32, v => {const a = record(v, 'agent'); return Object.freeze({who: text(a.who, 'agent', 128), turns: count(a.turns, 'turns'), newest: when(a.newest, 'turn time')});});
  const account = optional(r.account, v => {
    const a = record(v, 'memory account');
    return Object.freeze({since: when(a.since, 'account time'), memories: Object.freeze(rows(a.memories, 'account', 64, memoryItem)), more: count(a.moreMemories, 'account'),
      supersessions: Object.freeze(rows(a.supersessions, 'account', 4096, x => {const l = record(x, 'supersession'); return Object.freeze({new: memoryName(l.new), old: memoryName(l.old), reason: text(l.reason, 'reason', 1024)});})),
      labels: rows(a.labels, 'account', 100000, x => x).length, rulings: rows(a.rulings, 'account', 100000, x => x).length});
  });
  const packet = optional(r.packet, v => {
    const p = record(v, 'memory packet');
    return Object.freeze({topic: text(p.topic, 'topic', 256, true), budget: count(p.budget, 'budget', 16000), bytes: count(p.bytes, 'bytes', 16000), leftOut: count(p.leftOut, 'left out'),
      items: Object.freeze(rows(p.items, 'packet', 4096, memoryItem))});
  });
  if (packet && packet.bytes > packet.budget) fail('memory packet');
  return Object.freeze({view: text(r.view, 'view', 16), observedAt: when(r.observedAt, 'memory time'), standings, agents: Object.freeze(agents),
    memories: optional(r.memories, v => Object.freeze(rows(v, 'memories', 100000, memoryItem))), account, packet,
    openQuestions: optional(r.openQuestions, v => Object.freeze(rows(v, 'questions', 16, memoryItem)))});
}
const STANDING_WORDS: Record<MemoryItem['standing'], string> = {ruling: 'RULING (the operator ruled this)', fact: 'FACT', hypothesis: 'HYPOTHESIS (not established)', question: 'OPEN QUESTION', unlabelled: 'UNLABELLED (a model wrote this; nobody has said what it is)'};
/** The handoff as one Markdown document a new model reads first. It says what each memory is, never more. */
export function handoffDocument(v: MemoryView, shipName: string): string {
  const lines = [`# Handoff from ${shipName}`, '', `Read from the ship at ${v.observedAt}. Each memory states what it is. Treat anything not marked RULING or FACT as unconfirmed.`, ''];
  if (v.account) {
    lines.push(`## What changed since ${v.account.since}`, '');
    if (!v.account.memories.length && !v.account.supersessions.length) lines.push('Nothing changed.', '');
    for (const m of v.account.memories) lines.push(`- ${m.name} (${m.standing}): ${m.description}`);
    if (v.account.more) lines.push(`- …and ${v.account.more} more memories changed.`);
    for (const s of v.account.supersessions) lines.push(`- ${s.new} replaced ${s.old}: ${s.reason}`);
    lines.push('');
  }
  if (v.openQuestions?.length) {lines.push('## Open questions', ''); for (const q of v.openQuestions) lines.push(`- ${q.name}: ${q.description}`); lines.push('');}
  if (v.packet) {
    lines.push(`## Current context${v.packet.topic ? `: ${v.packet.topic}` : ''}`, '', `${v.packet.items.length} memories in ${v.packet.bytes} of ${v.packet.budget} bytes; ${v.packet.leftOut} more did not fit and are not shown.`, '');
    for (const m of v.packet.items) lines.push(`### ${m.name}`, '', `${STANDING_WORDS[m.standing]} · ${m.cite}`, '', m.body ?? m.description, '');
  }
  return lines.join('\n');
}
export function memoryLabel(item: Pick<MemoryItem, 'name' | 'hash'>, standing: 'fact' | 'hypothesis' | 'question'): JsonObject {
  if (!['fact', 'hypothesis', 'question'].includes(standing)) fail('memory standing');
  return {kind: 'label', name: memoryName(item.name), hash: text(item.hash, 'memory hash', 16), standing};
}
export function memorySupersede(newer: string, older: string, reason: string): JsonObject {
  if (newer === older) fail('supersession');
  return {kind: 'supersede', new: memoryName(newer), old: memoryName(older), reason: text(reason.trim(), 'reason', 1024)};
}
/** Take back a supersession made by mistake. The link and its retraction both stay in the ship's record. */
export function memoryUnsupersede(newer: string, older: string): JsonObject {
  if (newer === older) fail('supersession');
  return {kind: 'unsupersede', new: memoryName(newer), old: memoryName(older)};
}
export {shortHex};
