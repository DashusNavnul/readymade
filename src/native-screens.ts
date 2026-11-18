import * as vscode from 'vscode';
import type {ShipClient} from './ship-client';
import {OutcomeUnknownError, ShipClientError} from './ship-client';
import {nativeRefusal, refusalSentence, shortHex, type NativeReply, type NativeRequest} from './native-pages';
import {ReportPanel} from './report-panel';
import {unreadable, type Report} from './report';
import {admissionsLeft, answerCommand, proposalDismiss, handoffDocument, memoryLabel, memorySupersede, memoryUnsupersede, memoryView, overviewProblems, overviewReport, overviewWaiting, ownerOverview, ownerTasks, policyReport, policySet, standingPolicy, tasksReport,
  POLICY_TOOLS, type OwnerOverview, type PolicyBody} from './owner-pages';
import {boardReport, collabNotices, historyReport, noticeLines, noticeRetry, noticesReport, noticesSeen, noticesUnseen, noticeText, presenceBoard, presencePlan, presenceReport, presenceTarget, presenceText, rolesReport, sessionRoles, sessionStreams,
  streamClose, streamOpen, streamText, suggestionHistory, workAsk, workDismiss, workJournal, workJournalAdd, workQueue, workReport, workWithdraw, type Notice, type PresenceTarget, type PresenceTold, type SessionStream} from './collab-pages';
import type {MediaTreeRow} from './media-workbench';

/** What the screens need from the window they live in. Nothing here holds a ship connection of its own. */
export interface NativeHost {
  client(): Pick<ShipClient, 'nativePage'> | undefined;
  /** The connected ship's name, once it is signed in. */
  ship(): string | undefined;
  /** The owner's selected project on the connected ship. */
  project(): string | undefined;
  /** A file another owner shared with this ship, by its document URI. */
  shared(uri: string): {owner: string; project: string; path: string} | undefined;
  /** Sessions other owners shared with this ship, as last listed. */
  sessions(): readonly {owner: string; project: string; generation: string; session: string; inspection: string; phase: string}[];
  readonly state: vscode.Memento;
  /** The file of a suggestion this computer sent, by the owner, project and this ship's own request id. */
  suggestionFile?(owner: string, project: string, request: string): string | undefined;
  /** Sign in again after the ship signed this window out. True when the window is signed in again. */
  recover?(error: unknown): Promise<boolean>;
  changed(): void;
}
const CODING = '/apps/pataphor-native/coding/', COLLAB = '/apps/readymade-collab/';
const SEEN = 'readymade.nativeNoticesSeen', CURSORS = 'readymade.sessionStreamCursors', ASKED = 'readymade.workAsked';
const PROJECT = 'x-readymade-project', OWNER = 'x-readymade-project-owner';
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The ship's native pages as Readymade screens and commands: the owner overview, tasks and questions, notices,
 * suggestion history, work requests and roles, the standing policy, memory handoffs, session streams and file
 * presence. Every screen states what the ship answered; a refusal is shown with the ship's own reason.
 */
/** The ship has no such page: a guest ship, or a backend older than this app. Not a failure to read one. */
class PageMissing extends Error {}
export class NativeScreens implements vscode.Disposable {
  private readonly panels: ReportPanel[] = [];
  private readonly badge = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  private readonly watching = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  private readonly presence = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  private readonly events: vscode.Disposable[] = [];
  private overviewSeen?: OwnerOverview;
  /** Why the overview could not be read on a ship that has one. The owner's rows stay, with this as the reason. */
  private overviewFault?: string;
  private streams: SessionStream[] = [];
  private streamTimer?: NodeJS.Timeout;
  private presenceTimer?: NodeJS.Timeout;
  private told?: PresenceTold & {authority: string; project: string};
  private presenceBusy = false;
  private refusalShown = '';
  private closed = false;
  private lastClient?: Pick<ShipClient, 'nativePage'>;
  readonly overview: ReportPanel; readonly tasks: ReportPanel; readonly notices: ReportPanel; readonly history: ReportPanel;
  readonly work: ReportPanel; readonly roles: ReportPanel; readonly policy: ReportPanel; readonly board: ReportPanel;
  /** `answerWaitMs`: how long to give an owner's ship to acknowledge a work request before reading its answer once. */
  constructor(private readonly host: NativeHost, private readonly answerWaitMs = 4000) {
    const panel = (type: string, title: string, load: () => Promise<Report>, act?: (id: string) => Promise<string | void>): ReportPanel => {
      const made = new ReportPanel('readymade.' + type, title, load, act); this.panels.push(made); return made;
    };
    this.overview = panel('overview', 'Overview', async () => overviewReport(await this.readOverview()));
    this.tasks = panel('tasks', 'Tasks and Questions', async () => {
      const read = ownerTasks(this.answered(await this.get(CODING + 'tasks')).value);
      return read ? tasksReport(read) : unreadable('Tasks and Questions', 'This ship has no task store yet, so agents cannot claim tasks or ask you questions.');
    }, id => this.answerQuestion(id));
    this.notices = panel('notices', 'Notices', async () => {
      const read = collabNotices(this.answered(await this.get(COLLAB + 'notices')).value, this.me());
      return read ? noticesReport(read, this.fileOf) : unreadable('Notices', 'This ship has no notice store yet, so it cannot tell collaborators anything durably.');
    }, id => this.retryNotice(id));
    this.history = panel('suggestionHistory', 'Suggestion History', async () => {
      const project = this.chosenProject();
      return historyReport(suggestionHistory(this.answered(await this.get(COLLAB + 'suggestion-history', {[PROJECT]: project})).value, this.me(), project));
    });
    this.work = panel('workRequests', 'Work Requests', async () => {
      const queue = workQueue(this.answered(await this.get(COLLAB + 'work-queue')).value, this.me());
      // Counted here from the policy and this queue: two light reads, and always current.
      const policy = await this.get(CODING + 'policy.json').then(reply => nativeRefusal(reply) ? undefined : standingPolicy(reply.value), () => undefined);
      const left = admissionsLeft(policy, queue.requests);
      // What this computer asked is kept here; its progress comes from the owners' notices.
      const inbox = await this.get(COLLAB + 'notices').then(reply => nativeRefusal(reply) ? [] : collabNotices(reply.value, this.me())?.inbox ?? [], () => []);
      return workReport(queue, left, workJournal(this.host.state.get(this.kept(ASKED))), inbox);
    }, id => this.endWork(id));
    this.roles = panel('sessionRoles', 'Session Roles', async () => {
      const project = this.chosenProject();
      return rolesReport(project, sessionRoles(this.answered(await this.get(COLLAB + 'session-roles', {[PROJECT]: project})).value, this.me(), project));
    });
    this.policy = panel('standingPolicy', 'Standing Policy', async () => {
      const read = standingPolicy(this.answered(await this.get(CODING + 'policy.json')).value);
      return read ? policyReport(read) : unreadable('Standing Policy', 'This ship has no policy store, so no standing policy can be set.');
    }, id => this.changePolicy(id));
    this.board = panel('presenceBoard', 'Who Has What Open', async () => {
      // The file in front of the person decides which project: a shared one, or else this ship's own.
      const want = this.target(), authority = want?.authority ?? this.me(), project = want?.project ?? this.chosenProject();
      return boardReport(presenceBoard(this.answered(await this.get(COLLAB + 'presence', {[PROJECT]: project, [OWNER]: authority})).value, authority, project), this.me());
    });
    this.badge.name = 'Readymade Decisions'; this.badge.command = 'readymade.overview';
    this.watching.name = 'Readymade Shared Session'; this.watching.command = 'readymade.followSession';
    this.presence.name = 'Readymade File Presence';
    this.events.push(vscode.window.onDidChangeActiveTextEditor(() => {void this.tellPresence();}),
      vscode.workspace.onDidChangeTextDocument(event => {if (event.document === vscode.window.activeTextEditor?.document && event.contentChanges.length) void this.tellPresence();}),
      vscode.workspace.onDidChangeConfiguration(event => {if (event.affectsConfiguration('readymade.sharePresence')) {void this.tellPresence(); this.host.changed();}}));
    this.presenceTimer = setInterval(() => {void this.tellPresence();}, 60_000);
  }
  private readonly fileOf = (n: Notice): string | undefined => this.host.suggestionFile?.(n.from, n.project, n.subject);
  // ---- transport
  /** The connected ship's name, or nothing. Asking can throw once the window holds no live sign-in; that is "no ship", not an error. */
  private named(): string | undefined {try {return this.host.ship() || undefined;} catch {return undefined;}}
  private me(): string {const ship = this.named(); if (!ship) throw new Error('Connect your ship first.'); return ship;}
  /**
   * What this computer remembers is kept per ship. Someone with a planet and a moon uses both from one app: one
   * ship's seen mark must not hide the other's notices, and one ship's asked requests are not the other's to withdraw.
   */
  private kept(key: string): string {return `${key}:${this.me()}`;}
  private chosenProject(): string {const project = this.host.project(); if (!project) throw new Error('Open one of your projects first.'); return project;}
  private async page(path: string, request?: NativeRequest): Promise<NativeReply> {
    const client = this.host.client(); if (this.closed || !client) throw new Error('Connect your ship first.');
    try {return await client.nativePage(path, request);}
    catch (error) {
      // A guest ship, or one whose Pataphor is older than this page: say so rather than "request failed".
      if (error instanceof ShipClientError && error.code === 'unavailable' && error.status === 404) throw new PageMissing('This ship does not have this page. It may be a guest ship, or its backend may be older than this app. A ship that follows its publisher takes the update by itself. If it has not after half an hour: a hosting ship runs Readymade: Follow Pataphor Updates; a guest ship removes the collaboration service and joins again.');
      if (error instanceof ShipClientError && error.code === 'authenticationRequired' && !this.closed && await this.host.recover?.(error)) {
        // The ship refused before doing anything. A read is asked once more; a command is left for the person to press again.
        if ((request?.method ?? 'GET') === 'GET' && this.host.client() === client) return client.nativePage(path, request);
        throw new Error('Your ship had signed this window out, so nothing was sent. It is signed in again now; press the button once more.');
      }
      throw error;
    }
  }
  private get(path: string, headers?: Record<string, string>): Promise<NativeReply> {return this.page(path, headers ? {headers} : undefined);}
  /** A read the ship refused becomes its own words; a page this ship does not have says so plainly. */
  private answered(reply: NativeReply): NativeReply {
    const why = nativeRefusal(reply); if (!why) return reply;
    const said = `The ship did not answer this page: ${refusalSentence(why)}`;
    throw why === 'owner-pages-unavailable' ? new PageMissing(said) : new Error(said);
  }
  /**
   * The read that follows a command the ship has already answered. If that read fails, the command's own answer
   * still stands and is what the person is told: a failure here once read as "the request failed", which invites
   * pressing the button again and sending the same command a second time.
   */
  private async thenRead(said: string, read: () => Promise<unknown>): Promise<string> {
    try {await read(); return said;} catch {return `${said} The page could not be read again just now; nothing was sent twice. Read it again to see where it stands.`;}
  }
  /** One command. Returns the sentence to show: what the ship did, or exactly why it refused. Never sent twice. */
  private async send(path: string, body: Record<string, unknown>, done: string): Promise<string> {
    try {const why = nativeRefusal(await this.page(path, {method: 'POST', body})); return why ? `Refused by the ship: ${refusalSentence(why)} Nothing changed.` : done;}
    catch (error) {
      if (error instanceof OutcomeUnknownError) return 'The ship gave no answer this app could read, so the outcome is unknown. It was not sent again; read the page again to see what happened.';
      throw error;
    }
  }
  // ---- overview and the decisions badge
  private async readOverview(): Promise<OwnerOverview> {
    const client = this.host.client();
    const read = ownerOverview(this.answered(await this.get(CODING + 'overview')).value);
    // An answer that arrives after the window moved to another ship says nothing about that ship.
    if (this.host.client() !== client) throw new Error('The connection changed while the overview was being read. Read it again.');
    this.overviewSeen = read; this.overviewFault = undefined; this.renderBadge(); this.host.changed(); return read;
  }
  private renderBadge(): void {
    const o = this.overviewSeen; if (!o) {this.badge.hide(); return;}
    const waiting = o.decisions.length, partial = o.unavailable.length > 0;
    // "Nothing waiting" is said only when the ship could read every source a decision can come from.
    this.badge.text = waiting ? `$(bell-dot) ${waiting} waiting${partial ? ' (incomplete)' : ''}` : partial ? '$(warning) Overview incomplete' : '$(bell) Nothing waiting';
    this.badge.tooltip = `${overviewWaiting(o)}, read at ${o.observedAt}.${partial ? ` The ship could not read: ${o.unavailable.join(', ')}.` : ''} Open the overview.`;
    this.badge.show();
  }
  /** Read once after connecting. A ship without the page simply shows no badge. */
  async connected(): Promise<void> {
    this.overviewSeen = undefined; this.overviewFault = undefined; this.told = undefined; this.renderBadge();
    // A ship without the page (a guest, or an older backend) shows no badge and no owner rows. Any other failure,
    // a slow read or one line this app cannot take, is not that: the owner's rows stay and the row says why.
    try {await this.readOverview();}
    catch (error) {if (!(error instanceof PageMissing) && this.host.client()) {this.overviewFault = error instanceof Error && error.message ? error.message.slice(0, 300) : 'The overview could not be read.'; this.host.changed();}}
    try {await this.readStreams();} catch { /* No streams page on an older ship. */ }
    // What owners told this ship while the app was closed is said once, without being asked for.
    try {await this.readInbox(true);} catch { /* No notice store on this ship. */ }
  }
  /** Rows for the workspace tree: the overview with its count, and each blocker as a project problem. */
  rows(): MediaTreeRow[] {
    const client = this.host.client();
    if (client !== this.lastClient) {
      // Another ship, or none: what was read from the last one is dropped, and nothing keeps polling it.
      this.lastClient = client; this.overviewSeen = undefined; this.overviewFault = undefined; this.streams = []; this.told = undefined;
      clearInterval(this.streamTimer); this.streamTimer = undefined; this.watching.hide(); this.presence.hide(); this.renderBadge();
      // An open screen still shows the last ship, with its buttons. Each is read again now, from the ship connected
      // now (or says none is), so no button built from one ship's page is ever pressed against another ship.
      for (const open of this.panels) void open.refresh();
      if (client && this.named()) void this.connected();
    }
    if (!client || !this.named()) return [];
    const row = (label: string, command: string, tooltip: string, description?: string): MediaTreeRow => ({label, description, tooltip, command: {title: label, command: 'readymade.' + command}});
    const o = this.overviewSeen, owner = !!o || !!this.overviewFault, project = !!this.host.project(), shared = this.host.sessions().length, sharing = vscode.workspace.getConfiguration('readymade').get<boolean>('sharePresence', false);
    // Collaboration pages exist on any ship with the service; the owner's pages only where the overview answered.
    const pages: MediaTreeRow = {id: 'native-pages', label: 'Ship', icon: 'server', children: [
      ...(owner ? [row('Tasks and Questions', 'tasksAndQuestions', 'What agents have claimed, proposed, and asked you.'),
        row('Work Requests', 'workRequests', 'What collaborators asked this ship\'s agents to do, and what this ship asked of others.'),
        row('Standing Policy', 'standingPolicy', 'What your ship\'s agents may do without asking.'),
        row('Memory Handoff', 'memoryHandoff', 'A bounded packet of the ship\'s memory for a new or returning model.'),
        row('Label or Replace a Memory', 'memoryLabel', 'Say what a memory is: a fact, a hypothesis, an open question, or replaced by a newer one.')] : []),
      ...(owner && project ? [row('Suggestion History', 'suggestionHistory', 'Each suggestion: authored, reviewed, landed, acknowledged.'), row('Session Roles', 'sessionRoles', 'Who controls, asks for work in, and watches each session.')] : []),
      row('Notices', 'notices', 'What this ship told collaborators and what owners told this ship, each told once.'),
      row('Who Has What Open', 'presenceBoard', 'Who is viewing, editing or has claimed each shared file, as the owner\'s ship shows it.'),
      ...(shared ? [row('Follow a Shared Session', 'followSession', 'Watch a session another owner shared, live.', `${shared} listed`), row('Ask the Owner\'s Agent for Work', 'askWork', 'One request in a session shared with you; the owner\'s policy decides.')] : []),
      row(sharing ? 'Stop Showing Which Shared File I Have Open' : 'Show Collaborators Which Shared File I Have Open', 'togglePresence', 'Only files already shared are reported, and each report expires after a few minutes.', sharing ? 'on' : 'off')]};
    const open = {title: 'Open the Overview', command: 'readymade.overview'};
    if (!o) return this.overviewFault ? [pages, {id: 'native-overview', label: 'Overview', icon: 'warning', description: 'could not be read; open it to read again', tooltip: this.overviewFault, command: open}] : [pages];
    const partial = o.unavailable.length > 0;
    return [pages, {id: 'native-overview', label: 'Overview', icon: 'checklist', description: o.decisions.length ? `${o.decisions.length} waiting on you${partial ? ' (incomplete)' : ''}` : partial ? 'incomplete: the ship could not read every part' : 'nothing waiting', tooltip: `Read from the ship at ${o.observedAt}`, command: open,
      children: overviewProblems(o).map((b, i) => ({label: b.title, description: b.detail, tooltip: b.detail, command: open,
        problem: {key: `overview-${i}-${b.title}`, category: /review/i.test(b.title) ? 'review' as const : /check/i.test(b.title) ? 'check' as const : 'delivery' as const, status: 'blocked' as const, label: `${b.title}: ${b.detail}`.slice(0, 200)}}))}];
  }
  // ---- questions, notices, policy actions
  private async answerQuestion(id: string): Promise<string | void> {
    const [action, question] = id.split(':'); if (!question) return;
    if (action === 'dismiss-proposal') {
      const sure = await vscode.window.showWarningMessage(`Dismiss this proposal on ${this.me()}?`, {modal: true, detail: 'It stays in the record, marked as dismissed. No work was started by it.'}, 'Dismiss');
      return sure === 'Dismiss' ? this.dismissProposal(question) : 'Nothing changed.';
    }
    if (action !== 'answer') return;
    const answer = await vscode.window.showInputBox({title: 'Answer this question', prompt: 'Your answer is stored on your ship and unblocks the task. It cannot be changed afterwards.', ignoreFocusOut: true,
      validateInput: v => !v.trim() ? 'Write an answer.' : Buffer.byteLength(v) > 2048 ? 'Keep it under 2,048 bytes.' : undefined});
    if (!answer) return 'No answer was sent.';
    return this.answer(question, answer);
  }
  /** The owner sets one proposal aside. It stays readable, marked as dismissed. */
  async dismissProposal(id: string): Promise<string> {
    return this.send(CODING + 'tasks', proposalDismiss(id), 'Dismissed. The proposal stays in the record.');
  }
  /** Store the owner's answer to one question. The ship refuses a second answer. */
  async answer(question: string, answer: string): Promise<string> {
    return this.send(CODING + 'tasks', answerCommand(question, answer), 'Your answer is stored. The task can be claimed again.');
  }
  private async retryNotice(id: string): Promise<string | void> {
    const [action, notice] = id.split(':'); if (action !== 'retry' || !notice) return;
    const sure = await vscode.window.showWarningMessage(`Send this notice again from ${this.me()}?`, {modal: true, detail: 'Its outcome is unknown: their ship may already have it. Their ship keeps one copy either way.'}, 'Send Again');
    if (sure !== 'Send Again') return 'Nothing was sent.';
    return this.retry(notice);
  }
  /** Ask the ship to send one notice again. It agrees only when that notice's outcome is unknown. */
  async retry(notice: string): Promise<string> {
    return this.send(COLLAB + 'notice-retry', noticeRetry(notice), 'Sent again. It shows as pending until their ship acknowledges it.');
  }
  private async changePolicy(id: string): Promise<string | void> {
    if (id === 'revoke') {
      const sure = await vscode.window.showWarningMessage(`Revoke the standing policy on ${this.me()}?`, {modal: true, detail: 'Agents will not start work on their own, and collaborators\' work requests will be refused, until you set a policy again. The history is kept.'}, 'Revoke');
      return sure === 'Revoke' ? this.revokePolicy() : 'Nothing changed.';
    }
    if (id !== 'set') return;
    const now = standingPolicy(this.answered(await this.get(CODING + 'policy.json')).value)?.inForce;
    const ask = (title: string, value: string, prompt: string): Thenable<string | undefined> => vscode.window.showInputBox({title, value, prompt, ignoreFocusOut: true});
    const project = await ask('Policy: project', now?.project ?? this.host.project() ?? '', 'The one project this policy covers.'); if (!project) return 'Nothing changed.';
    const objectives = await ask('Policy: objectives', now?.objectives.join('; ') ?? '', 'What agents should work toward. Separate several with a semicolon.'); if (!objectives) return 'Nothing changed.';
    const paths = await ask('Policy: paths', now?.paths.join(' ') ?? '', 'Files agents may touch, as ship paths like /lib/a/hoon, separated by spaces.'); if (paths === undefined) return 'Nothing changed.';
    const tools = await vscode.window.showQuickPick(POLICY_TOOLS.map(t => ({label: t, picked: now ? now.tools.includes(t) : ['list', 'read', 'search', 'diff', 'check'].includes(t)})), {title: 'Policy: tools', canPickMany: true, ignoreFocusOut: true});
    if (!tools?.length) return 'Nothing changed.';
    const res = now?.resources ?? {maxTurns: 4, maxSeconds: 900, maxEvalWork: 1_000_000, maxAdmissions: 1};
    const numbers = await ask('Policy: resources', `${res.maxTurns} ${res.maxSeconds} ${res.maxEvalWork} ${res.maxAdmissions}`, 'Four whole numbers: turns, seconds, evaluation work, admissions.'); if (!numbers) return 'Nothing changed.';
    const parts = numbers.trim().split(/\s+/).map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isSafeInteger(n) || n < 1)) return 'Four whole numbers above zero are needed. Nothing changed.';
    const escalation = await ask('Policy: escalation', now?.escalation ?? '', 'When an agent must stop and ask you.'); if (!escalation) return 'Nothing changed.';
    let body: PolicyBody;
    try {
      body = {project: project.trim(), objectives: objectives.split(';').map(s => s.trim()).filter(Boolean), paths: paths.trim() ? paths.trim().split(/\s+/) : [], tools: tools.map(t => t.label),
        resources: {maxTurns: parts[0]!, maxSeconds: parts[1]!, maxEvalWork: parts[2]!, maxAdmissions: parts[3]!}, escalation: escalation.trim()};
      return await this.setPolicy(body);
    } catch (error) {return error instanceof OutcomeUnknownError ? undefined : `${error instanceof Error ? error.message : 'That policy is not valid.'} Nothing was sent.`;}
  }
  /** Revoke the policy in force. Every version stays in the ship's record. */
  async revokePolicy(): Promise<string> {
    return this.send(CODING + 'policy', {action: 'revoke'}, 'Revoked. No policy is in force.');
  }
  /** Send one policy version. The body is checked here first; Cantrip decides, and its refusal is returned in words. */
  async setPolicy(body: PolicyBody): Promise<string> {
    return this.send(CODING + 'policy', policySet(body), 'Sent. The new version is in force once it appears below.');
  }
  // ---- received notices (peer inbox)
  /** New notices from owners since the last look, shown once as plain sentences. Returns how many were new. */
  async readInbox(quiet = false): Promise<number> {
    const read = collabNotices(this.answered(await this.get(COLLAB + 'notices')).value, this.me()); if (!read) return 0;
    const fresh = noticesUnseen(read, this.host.state.get(this.kept(SEEN)));
    if (!fresh.length) {if (!quiet) void vscode.window.showInformationMessage('No new notices from owners.'); return 0;}
    await this.host.state.update(this.kept(SEEN), noticesSeen(read));
    const shown = fresh.slice(0, 4).map(n => noticeText(n, this.fileOf)).join('\n'), more = fresh.length > 4 ? `\n…and ${fresh.length - 4} more.` : '';
    void vscode.window.showInformationMessage(shown + more, 'Open Notices').then(choice => {if (choice) void this.notices.show();});
    return fresh.length;
  }
  /** What owners told this ship about landings and work, as dated lines; empty on a ship without the page. */
  async inboxLines(): Promise<{readonly day: string; readonly text: string}[]> {
    const read = collabNotices(this.answered(await this.get(COLLAB + 'notices')).value, this.me());
    return read ? noticeLines(read, this.fileOf) : [];
  }
  // ---- memory
  async handoff(): Promise<void> {
    const first = memoryView(this.answered(await this.get(CODING + 'memory?view=since&since=~2000.1.1')).value);
    const who = await vscode.window.showQuickPick([{label: 'Everything recent', description: 'the last day', who: ''}, ...first.agents.map(a => ({label: a.who, description: `${a.turns} turns, last ${a.newest}`, who: a.who}))],
      {title: 'Handoff: who is returning?', placeHolder: 'The account starts at that agent\'s last recorded turn.'});
    if (!who) return;
    const topic = await vscode.window.showInputBox({title: 'Handoff: topic', prompt: 'A few words to choose memories by, or leave empty for the newest. Letters, digits and spaces.', value: this.host.project() ?? '',
      validateInput: v => /^[A-Za-z0-9 ._-]{0,120}$/.test(v) ? undefined : 'Letters, digits, spaces, dots and dashes only.'});
    if (topic === undefined) return;
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({language: 'markdown', content: await this.handoffText(who.who, topic)}));
  }
  /** The handoff document for one returning agent (or the last day) and a topic, within 12,000 bytes of memory. */
  async handoffText(who: string, topic: string): Promise<string> {
    const query = ['view=handoff', 'bytes=12000', ...(who ? [`who=${who}`] : []), ...(topic.trim() ? [`topic=${topic.trim().split(/\s+/).join('+')}`] : [])].join('&');
    return handoffDocument(memoryView(this.answered(await this.get(`${CODING}memory?${query}`)).value), this.me());
  }
  /** Label one exact version of a memory. The ship refuses a version that is no longer current. */
  async label(item: {name: string; hash: string}, standing: 'fact' | 'hypothesis' | 'question'): Promise<string> {
    return this.send(CODING + 'memory', memoryLabel(item, standing), `Labelled ${item.name} as a ${standing}.`);
  }
  /** Take back a replacement made by mistake: the older memory counts as current again. */
  async unsupersede(newer: string, older: string): Promise<string> {
    return this.send(CODING + 'memory', memoryUnsupersede(newer, older), `${older} is no longer replaced by ${newer}. Both the link and this correction stay in the record.`);
  }
  async labelMemory(): Promise<void> {
    const all = memoryView(this.answered(await this.get(CODING + 'memory')).value).memories ?? [];
    const pick = (title: string) => vscode.window.showQuickPick(all.map(m => ({label: m.name, description: `${m.standing}${m.supersededBy ? `, replaced by ${m.supersededBy}` : ''}`, detail: m.description.slice(0, 160), item: m})), {title, matchOnDescription: true, matchOnDetail: true});
    const chosen = await pick('Memory: which one?'); if (!chosen) return;
    const what = await vscode.window.showQuickPick([{label: 'It is a fact', value: 'fact' as const}, {label: 'It is a hypothesis', value: 'hypothesis' as const}, {label: 'It is an open question', value: 'question' as const},
      {label: 'A newer memory replaces it…', value: 'superseded' as const},
      ...(chosen.item.supersededBy ? [{label: `It is not replaced by ${chosen.item.supersededBy} after all`, value: 'restored' as const}] : [])], {title: `What is ${chosen.label}?`, placeHolder: 'A ruling can only be made on the ship\'s own memory page.'});
    if (!what) return;
    if (what.value === 'restored') {void vscode.window.showInformationMessage(await this.unsupersede(chosen.item.supersededBy!, chosen.label)); return;}
    if (what.value !== 'superseded') {void vscode.window.showInformationMessage(await this.label(chosen.item, what.value)); return;}
    const newer = await pick(`Which memory replaces ${chosen.label}?`); if (!newer || newer.label === chosen.label) return;
    const reason = await vscode.window.showInputBox({title: 'Why does it replace it?', ignoreFocusOut: true, validateInput: v => v.trim() ? undefined : 'Give the reason.'}); if (!reason) return;
    void vscode.window.showInformationMessage(await this.send(CODING + 'memory', memorySupersede(newer.label, chosen.label, reason), `${newer.label} now replaces ${chosen.label}. Both are kept.`));
  }
  // ---- shared sessions: follow a live stream, ask for work
  private async pickSession(title: string): Promise<{owner: string; project: string; generation: string; session: string; inspection: string} | undefined> {
    const list = this.host.sessions();
    if (!list.length) {void vscode.window.showInformationMessage('No shared session is listed yet. Open the shared project and refresh its shared sessions first.'); return undefined;}
    return (await vscode.window.showQuickPick(list.map(s => ({label: `Session ${shortHex(s.session)}`, description: `${s.project} · ${s.owner}`, detail: `Last listed as ${s.phase}`, s})), {title}))?.s;
  }
  private cursors(): Record<string, number> {
    const held = this.host.state.get<Record<string, unknown>>(this.kept(CURSORS)) ?? {};
    return Object.fromEntries(Object.entries(held).filter(([, n]) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0).slice(-64)) as Record<string, number>;
  }
  async followSession(): Promise<void> {
    const open = this.streams.filter(s => s.phase !== 'ended');
    if (open.length) {
      const choice = await vscode.window.showQuickPick([...open.map(s => ({label: `Stop following ${shortHex(s.session)}`, description: streamText(s), stop: s})), {label: 'Follow another shared session…', stop: undefined}], {title: 'Shared Sessions'});
      if (!choice) return;
      if (choice.stop) {void vscode.window.showInformationMessage(await this.unfollow(choice.stop)); return;}
    }
    const s = await this.pickSession('Follow a Shared Session'); if (!s) return;
    void vscode.window.showInformationMessage(await this.follow(s));
  }
  /** Open one live stream, from the sequence this computer last saw if it followed this session before. */
  async follow(s: {owner: string; project: string; generation: string; session: string; inspection: string}): Promise<string> {
    const cursor = this.cursors()[`${s.owner}/${s.session}`] ?? 0;
    const said = await this.send(COLLAB + 'session-stream', streamOpen(s.owner, s.project, s.generation, s.inspection, s.session, cursor), cursor ? `Following again from sequence ${cursor}.` : 'Following. Its status appears in the status bar.');
    return this.thenRead(said, () => this.readStreams());
  }
  async unfollow(s: {owner: string; session: string}): Promise<string> {
    return this.thenRead(await this.send(COLLAB + 'session-stream', streamClose(s.owner, s.session), 'Stopped following.'), () => this.readStreams());
  }
  /** The streams as this ship last reported them. */
  get followed(): readonly SessionStream[] {return this.streams;}
  private async readStreams(): Promise<void> {
    const client = this.host.client();
    const reply = await this.get(COLLAB + 'session-stream'); if (nativeRefusal(reply) || this.host.client() !== client) return;
    this.streams = sessionStreams(reply.value, this.me());
    // Kept only when a sequence moved: this runs every few seconds while a session is followed.
    const cursors = this.cursors(), before = JSON.stringify(cursors);
    for (const s of this.streams) if (s.sequence) cursors[`${s.owner}/${s.session}`] = s.sequence;
    if (JSON.stringify(cursors) !== before) await this.host.state.update(this.kept(CURSORS), cursors);
    const live = this.streams.filter(s => s.phase !== 'ended'), shown = live[0] ?? this.streams[0];
    if (shown) {this.watching.text = `$(broadcast) ${shortHex(shown.session)}: ${streamText(shown)}`; this.watching.tooltip = this.streams.map(s => `${s.owner} ${shortHex(s.session)} in ${s.project}: ${streamText(s)}`).join('\n'); this.watching.show();}
    else this.watching.hide();
    // Poll this ship's own page only while a stream is open; the owner's ship pushes the changes to it.
    if (live.length && !this.streamTimer) this.streamTimer = setInterval(() => {void this.readStreams().catch(() => undefined);}, 5000);
    if (!live.length && this.streamTimer) {clearInterval(this.streamTimer); this.streamTimer = undefined;}
  }
  async askWork(): Promise<void> {
    const s = await this.pickSession('Ask the Owner\'s Agent for Work'); if (!s) return;
    const request = await vscode.window.showInputBox({title: `Ask ${s.owner}'s agent`, prompt: 'One instruction for the shared session. The owner\'s policy decides whether it is taken.', ignoreFocusOut: true,
      validateInput: v => !v.trim() ? 'Write the request.' : Buffer.byteLength(v) > 4096 ? 'Keep it under 4,096 bytes.' : undefined});
    if (!request) return;
    const answer = await this.ask(s, request);
    if (answer.refused) void vscode.window.showWarningMessage(answer.said); else void vscode.window.showInformationMessage(answer.said);
  }
  /** Send one work request and read the owner's answer once. It is never sent again, whatever the answer. */
  async ask(s: {owner: string; project: string; session: string}, request: string): Promise<{said: string; refused: boolean; nonce: string}> {
    const command = workAsk(s.owner, s.project, s.session, request), nonce = command.nonce as string;
    // Which ship asks is fixed before anything is sent. If the window disconnects or moves to another ship while the
    // request is in flight, it is still kept, and kept under the ship that sent it.
    const me = this.me(), key = this.kept(ASKED);
    const keep = (answer: 'queued' | 'refused' | 'unanswered' | 'unknown', reason?: string): Thenable<void> =>
      this.host.state.update(key, workJournalAdd(workJournal(this.host.state.get(key)), {nonce, owner: s.owner, project: s.project, session: s.session, text: command.text as string, at: Date.now(), answer, ...(reason ? {reason} : {})}));
    let why: string | undefined;
    try {why = nativeRefusal(await this.page(COLLAB + 'work-request', {method: 'POST', body: command}));}
    catch (error) {
      if (!(error instanceof OutcomeUnknownError)) throw error;
      // It may have reached the owner. It is kept, so its progress can still be read and it can still be withdrawn.
      await keep('unknown');
      return {said: `The ship gave no answer this app could read, so it is unknown whether request ${shortHex(nonce)} was sent. It is kept under Work Requests and was not sent again.`, refused: false, nonce};
    }
    if (why) return {said: `Refused by the ship: ${refusalSentence(why)} Nothing changed.`, refused: true, nonce};
    // Kept before the answer is read, so a request that left this computer is never forgotten.
    await keep('unanswered');
    // The owner's answer is an acknowledgement that arrives a moment later; read it once rather than assume.
    await sleep(this.answerWaitMs);
    const sent = `Request ${shortHex(nonce)} was sent`;
    let asked: ReturnType<typeof workQueue>['asked'][number] | undefined;
    // The request has left this computer. A failure to read its answer is said as that, never as a failed request.
    try {asked = workQueue(this.answered(await this.get(COLLAB + 'work-queue')).value, me).asked.find(a => a.nonce === nonce);}
    catch {return {said: `${sent}, but ${s.owner}'s answer could not be read just now. It is kept under Work Requests and will not be sent again.`, refused: false, nonce};}
    if (asked?.status === 'refused') {await keep('refused', asked.reason); return {said: `${s.owner} refused the request: ${refusalSentence(asked.reason)} Nothing was queued.`, refused: true, nonce};}
    if (asked?.status === 'accepted') {await keep('queued'); return {said: `${s.owner} queued your request ${shortHex(nonce)}. Progress arrives as notices.`, refused: false, nonce};}
    return {said: `${sent}; ${s.owner} has not answered yet. Open Work Requests to see its answer. It will not be sent again.`, refused: false, nonce};
  }
  // ---- ending a request before it starts
  private async endWork(id: string): Promise<string | void> {
    const [action, which] = id.split(':'); if (!which) return;
    if (action === 'dismiss') {
      const sure = await vscode.window.showWarningMessage(`Dismiss this request on ${this.me()}?`, {modal: true, detail: 'It has not started. Its requester is told it was dismissed, and nothing runs.'}, 'Dismiss');
      return sure === 'Dismiss' ? this.dismiss(which) : 'Nothing changed.';
    }
    if (action === 'withdraw') {
      const sure = await vscode.window.showWarningMessage(`Withdraw this request, as ${this.me()}?`, {modal: true, detail: 'The owner\'s ship removes it if it has not started yet.'}, 'Withdraw');
      return sure === 'Withdraw' ? this.withdraw(which) : 'Nothing changed.';
    }
  }
  /** The owner ends one request that has not started. The ship refuses once it has. */
  async dismiss(id: string): Promise<string> {
    return this.send(COLLAB + 'work-dismiss', workDismiss(id), 'Dismissed. Its requester is told, and nothing runs.');
  }
  /** Take back one request this computer asked. The owner's ship decides; its answer is read once. */
  async withdraw(nonce: string): Promise<string> {
    const me = this.me(), asked = workJournal(this.host.state.get(this.kept(ASKED))).find(a => a.nonce === nonce);
    if (!asked) return 'This computer has no record of that request, so it cannot withdraw it.';
    const said = await this.send(COLLAB + 'work-withdraw', workWithdraw(asked), '');
    if (said) return said;
    await sleep(this.answerWaitMs);
    const unread = `Asked ${asked.owner} to withdraw it, but the answer could not be read just now. It was not sent again; read the page again to see.`;
    let refused: ReturnType<typeof workQueue>['withdrawRefused'][number] | undefined;
    try {refused = workQueue(this.answered(await this.get(COLLAB + 'work-queue')).value, me).withdrawRefused.find(w => w.nonce === nonce);} catch {return unread;}
    if (refused) return `${asked.owner} did not withdraw it: ${refusalSentence(refused.reason)}`;
    const told = await this.get(COLLAB + 'notices').then(reply => nativeRefusal(reply) ? [] : collabNotices(reply.value, me)?.inbox ?? [], () => []);
    return told.some(n => n.from === asked.owner && n.subject === nonce && n.kind === 'work-finished' && n.detail.startsWith('Withdrawn'))
      ? `${asked.owner} withdrew your request. Nothing ran.` : `Asked ${asked.owner} to withdraw it; its ship has not answered yet. Read the page again to see.`;
  }
  // ---- file presence
  private wanted(): PresenceTarget | undefined {
    return vscode.workspace.getConfiguration('readymade').get<boolean>('sharePresence', false) ? this.target() : undefined;
  }
  /** The project file in front of the person, whether or not presence is being reported. */
  private target(): PresenceTarget | undefined {
    const me = this.named(), editor = vscode.window.activeTextEditor;
    if (!me || !editor) return undefined;
    const uri = editor.document.uri;
    return presenceTarget(uri, me, this.host.project(), uri.scheme.startsWith('readymade-remote-') ? this.host.shared(uri.toString()) : undefined);
  }
  /** Turn file presence on or off for this computer. It is off until the person turns it on. */
  async togglePresence(): Promise<void> {
    const settings = vscode.workspace.getConfiguration('readymade'), next = !settings.get<boolean>('sharePresence', false);
    await settings.update('sharePresence', next, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(next ? 'Owners of projects shared with you now see which shared file you have open. Each report expires after a few minutes.' : 'Stopped. Your last report is withdrawn now.');
    await this.tellPresence(); this.host.changed();
  }
  /** What the presence item in the status bar says now. */
  get presenceShown(): {text: string; tooltip: string} {return {text: this.presence.text, tooltip: String(this.presence.tooltip ?? '')};}
  /** Tell the project's owner what this window has open, renew the lease, and show who else is there. */
  async tellPresence(): Promise<void> {
    if (this.closed || this.presenceBusy || !this.host.client()) return;
    this.presenceBusy = true;
    try {
      const want = this.wanted(), told = this.told, same = told && want && told.authority === want.authority && told.project === want.project;
      const plan = presencePlan(same ? told : undefined, want, Date.now());
      if (told && !same) await this.page(COLLAB + 'presence', {method: 'POST', body: presenceReport(told.authority, told.project, told.path, 'closed')}).catch(() => undefined);
      for (const step of plan) {
        const target = step.mode === 'closed' ? told! : want!;
        await this.page(COLLAB + 'presence', {method: 'POST', body: presenceReport(target.authority, target.project, step.path, step.mode)}).catch(() => undefined);
      }
      if (plan.some(step => step.mode !== 'closed') && want) this.told = {...want, at: Date.now()};
      else if (!want) this.told = undefined;
      if (!want) {this.presence.hide(); return;}
      const reply = await this.get(COLLAB + 'presence', {[PROJECT]: want.project, [OWNER]: want.authority}); if (nativeRefusal(reply)) {this.presence.hide(); return;}
      const board = presenceBoard(reply.value, want.authority, want.project), others = presenceText(board, want.path, this.me());
      const refused = board.refused.find(r => r.path === want.path);
      this.presence.text = refused ? '$(eye-closed) Presence refused' : others ? `$(eye) ${others}` : '$(eye) Only you';
      this.presence.tooltip = refused ? `${want.authority} refused your presence on ${want.path}: ${refusalSentence(refused.reason)}` : `${want.path} in ${want.project}. ${others || 'Nobody else has this file open.'}`;
      this.presence.show();
      if (refused && this.refusalShown !== `${want.path}@${refused.at}`) {
        this.refusalShown = `${want.path}@${refused.at}`;
        void vscode.window.showWarningMessage(`${want.authority} does not show you on ${want.path}: ${refusalSentence(refused.reason)}`);
      }
    } catch { this.presence.hide(); }
    finally {this.presenceBusy = false;}
  }
  dispose(): void {
    this.closed = true; clearInterval(this.streamTimer); clearInterval(this.presenceTimer);
    this.panels.forEach(p => p.dispose()); this.events.forEach(e => e.dispose()); this.badge.dispose(); this.watching.dispose(); this.presence.dispose();
  }
}
