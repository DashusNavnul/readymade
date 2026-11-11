import * as vscode from 'vscode';
import {mergeDraft} from './draft-merge';
import {createHash} from 'node:crypto';
import {ShipClientError, type ShipClient} from './ship-client';
import type {RemoteSuggestionJournal} from './remote-suggestion-journal';
import type {RemoteDraftStore, RemoteDraftRecord} from './remote-draft-store';
import type {ActivityReply} from './editing-activity';
import type {MediaTreeRow} from './media-workbench';
import {remoteShip, remoteProjectViewTarget, type RemoteProjectViewTarget, type RemoteProjectViewSelector, type RemoteProjectViewReply, type RemoteSourceObservation} from './remote-project-view';
import {remoteProjectSessionsObserve, remoteProjectSessionRows, type RemoteProjectSessionsReply} from './remote-project-sessions';

export interface SharedProjectLink extends RemoteProjectViewTarget {readonly peer: string; readonly file?: string}
export function sharedProjectLink(uri: vscode.Uri, authority: string): SharedProjectLink {
  if (uri.toString().length > 2048 || uri.scheme !== vscode.env.uriScheme || uri.authority !== authority || uri.path !== '/shared-project' || uri.fragment) throw new Error('Invalid shared project link.');
  const query = new URLSearchParams(uri.query), keys = [...query.keys()];
  if (keys.length !== (query.has('file') ? 5 : 4) || new Set(keys).size !== keys.length || keys.some(k => !['owner', 'project', 'generation', 'peer', 'file'].includes(k))) throw new Error('Invalid shared project fields.');
  const target = remoteProjectViewTarget({owner: query.get('owner'), project: query.get('project'), generation: query.get('generation')});
  const peer = query.get('peer');
  if (!remoteShip(peer) || peer === target.owner) throw new Error('Invalid shared project recipient.');
  const file = query.get('file');
  if (file !== null && !/^\/(?:app|lib|ted)\/(?:[a-z0-9-]{1,63}\/){1,6}hoon$/.test(file)) throw new Error('Invalid shared file path.');
  return Object.freeze({...target, peer, ...(file === null ? {} : {file})});
}
const scheme = 'readymade-remote-source';
interface RetainedRead {client: ShipClient; link: SharedProjectLink; selector?: RemoteProjectViewSelector; observation?: RemoteSourceObservation; state: string; settled: boolean}
interface SessionList {client: ShipClient; reply?: RemoteProjectSessionsReply; note?: string; busy: boolean}
/** Presentation only: remote observations never become local coding sessions or source authority. */
export class RemoteSourceView implements vscode.Disposable, vscode.TextDocumentContentProvider {
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(scheme, this);
  private readonly documents = new Map<string, string>();
  private readonly histories = new Set<string>();
  private readonly reads: RetainedRead[] = [];
  private link?: SharedProjectLink;
  private client?: ShipClient;
  private selector?: RemoteProjectViewSelector;
  private observation?: RemoteSourceObservation;
  private state = 'No shared project open';
  private settled = false;
  private busy = false;
  private sending = false;
  private closed = false;
  private activityBusy = false;
  private activity?: {client: ShipClient; link: SharedProjectLink; source: RemoteSourceObservation; rows: Extract<ActivityReply, {status: 'ready'}>['rows']; expires: number};
  private activityExpiry?: ReturnType<typeof setTimeout>;
  private readonly sessionLists = new Map<string, SessionList>();
  constructor(private readonly authority: string, private readonly current: () => ShipClient | undefined,
    private readonly connect: (origin?: string) => Promise<ShipClient | undefined>, private readonly changed: () => void, private readonly drafts?: RemoteDraftStore, private readonly suggestions?: RemoteSuggestionJournal) {}
  private peer(client: ShipClient): string {
    const cookies = client.browserCookies(client.origin);
    if (cookies.length !== 1 || !cookies[0].name.startsWith('urbauth-') || !remoteShip(cookies[0].name.slice(8))) throw new Error('One authenticated ship identity is required.');
    return cookies[0].name.slice(8);
  }
  private valid(client: ShipClient, link: SharedProjectLink): boolean {
    return !this.closed && this.current() === client && this.client === client && this.link === link && this.peer(client) === link.peer;
  }
  private sameTarget(a: SharedProjectLink, b: SharedProjectLink): boolean {
    return a.owner === b.owner && a.project === b.project && a.generation === b.generation && a.peer === b.peer;
  }
  private retain(): void {
    if (!this.client || !this.link || !this.selector && this.settled) return;
    const prior = this.reads.findIndex(row => row.client === this.client && row.link === this.link && row.selector === this.selector && row.state === this.state);
    if (prior >= 0) {this.reads.push(this.reads.splice(prior, 1)[0]); return;}
    if (this.reads.length >= 32) throw new Error('This window retains 32 shared reads. Open a new window for more.');
    this.reads.push({client: this.client, link: this.link, selector: this.selector, observation: this.observation, state: this.state, settled: this.settled});
  }
  async resume(id?: string): Promise<void> {
    if (!this.drafts) throw new Error('Saved shared drafts are unavailable.');
    if (!id) {
      const rows = this.drafts.list();
      const selected = await vscode.window.showQuickPick(rows.map(row => ({label: row.observation.project, description: row.observation.owner,
        detail: row.observation.origin + ' · ' + row.path, id: row.id})), {title: 'Resume Shared Project from a Saved Draft'});
      if (!selected) return; id = selected.id;
    }
    const {origin, owner, project, generation, peer} = this.drafts.get(id).observation;
    const link = vscode.Uri.from({scheme: vscode.env.uriScheme, authority: this.authority, path: '/shared-project',
      query: new URLSearchParams({owner, project, generation, peer}).toString()});
    await this.open(link, origin);
  }
  async open(value?: string | vscode.Uri, retainedOrigin?: string): Promise<void> {
    const supplied = value ?? await vscode.window.showInputBox({title: 'Open Shared Project', prompt: 'Paste the project link from its owner.'});
    if (!supplied) return;
    const link = sharedProjectLink(typeof supplied === 'string' ? vscode.Uri.parse(supplied, true) : supplied, this.authority);
    if (this.closed || this.busy || this.sending) throw new Error('A shared project operation is already running.');
    this.busy = true;
    let restored = false;
    try {
      const client = await this.connect(retainedOrigin); if (!client || this.closed) return;
      if (retainedOrigin && client.origin !== retainedOrigin) throw new Error(`This draft belongs to ${retainedOrigin}. Connect that origin before resuming.`);
      if (this.peer(client) !== link.peer) throw new Error(`This project link is for ${link.peer}. Connect that ship in another window.`);
      if (this.current() !== client) throw new Error('Shared project connection changed.');
      this.retain();
      const saved = [...this.reads].reverse().find(row => row.client === client && this.sameTarget(row.link, link));
      if (saved) {
        this.link = saved.link; this.client = client; this.selector = saved.selector; this.observation = saved.observation;
        this.state = saved.state; this.settled = saved.settled; restored = true;
      } else {
        this.link = link; this.client = client; this.selector = undefined; this.observation = undefined; this.settled = true;
      }
    } finally {this.busy = false; this.changed();}
    if (!restored || (retainedOrigin || link.file) && this.settled) await this.refresh();
    const source = this.observation, client = this.client, activeLink = this.link;
    await vscode.commands.executeCommand('workbench.view.extension.readymade');
    if ((retainedOrigin || link.file) && this.state !== 'Read-only shared files') return;
    if (link.file) {
      if (!source || !client || !activeLink || this.observation !== source || !this.sameTarget(activeLink, link) || !this.valid(client, activeLink) || !source.files.some(file => file.path === link.file)) throw new Error('The requested file is not currently shared.');
      const document = await vscode.workspace.openTextDocument(this.uri(source, link.file));
      if (!this.valid(client, activeLink) || this.observation !== source) throw new Error('Shared project connection changed.');
      await vscode.window.showTextDocument(document, {preview: false});
    } else await this.revealFirst();
  }
  private async revealFirst(): Promise<void> {
    if (!this.closed && this.observation?.files[0]) await this.openFile(this.uri(this.observation, this.observation.files[0].path).toString());
  }
  async refresh(): Promise<void> {
    const client = this.client, link = this.link;
    if (!client || !link || !this.valid(client, link) || this.busy || this.sending || !this.settled) throw new Error('Check the pending request before refreshing.');
    if (this.histories.size >= 32) throw new Error('This window retains 32 observations. Open a new window for more.');
    this.retain();
    this.busy = true; this.settled = false; this.selector = undefined; this.state = 'Reading shared files…'; this.changed();
    try {
      const result = await client.projectViewSubmit({owner: link.owner, project: link.project, generation: link.generation});
      if (!this.valid(client, link)) throw new Error('Shared project connection changed.');
      this.selector = {owner: result.owner, project: result.project, generation: result.generation, request: result.request};
      this.accept(result); await this.observe(client, link);
    } catch (error) {
      this.settled = error instanceof ShipClientError && error.code === 'refused';
      this.state = this.settled ? 'Read refused before submission' : 'Outcome unknown — no automatic retry'; throw error;
    }
    finally {this.busy = false; this.changed();}
  }
  async check(): Promise<void> {
    const client = this.client, link = this.link;
    if (!client || !link || !this.selector || !this.valid(client, link) || this.busy || this.sending || this.settled) throw new Error('No pending shared project observation to check.');
    this.busy = true;
    try {await this.observe(client, link);}
    catch (error) {this.state = 'Observation unavailable — no automatic retry'; throw error;}
    finally {this.busy = false; this.changed();}
  }
  private async observe(client: ShipClient, link: SharedProjectLink): Promise<void> {
    // A finite foreground adapter: only start reads during 15s; each HTTP read is bounded to 15s.
    const until = Date.now() + 15000;
    for (let reads = 0; reads < 15; reads++) {
      if (!this.valid(client, link) || !this.selector) throw new Error('Shared project connection changed.');
      const reply = await client.projectViewResult(this.selector);
      if (!this.valid(client, link)) throw new Error('Shared project connection changed.');
      this.accept(reply);
      if (reply.status !== 'pending' || Date.now() + 1000 >= until) return;
      await new Promise<void>(resolve => setTimeout(resolve, 1000));
      if (Date.now() >= until) return;
    }
  }
  private accept(reply: RemoteProjectViewReply): void {
    this.state = {pending: 'Waiting for owner — Check for result', ready: 'Read-only shared files', refused: 'Owner refused this read',
      uncertain: 'Outcome unknown — no automatic retry', missing: 'Observation not retained — Refresh starts a new read', expired: 'Observation expired — Refresh starts a new read'}[reply.status];
    this.settled = ['ready', 'refused', 'missing', 'expired'].includes(reply.status);
    if (reply.status === 'ready' && reply.observation) {
      this.observation = reply.observation;
      for (const file of reply.observation.files) {
        const uri = this.uri(reply.observation, file.path).toString(), retained = this.documents.get(uri);
        if (retained !== undefined && retained !== file.text) throw new Error('Historical source observation changed.');
        this.documents.set(uri, file.text);
      }
      this.histories.add(reply.request);
    }
    this.changed();
  }
  private uri(observation: RemoteSourceObservation, path: string): vscode.Uri {
    const key = createHash('sha256').update(JSON.stringify([observation.origin, observation.peer, observation.owner, observation.project, observation.generation, observation.request, observation.root, observation.snapshotDigest])).digest('hex');
    return vscode.Uri.from({scheme, path: `/${key}${path}`});
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    const text = this.documents.get(uri.toString());
    if (this.closed || uri.scheme !== scheme || text === undefined) throw vscode.FileSystemError.FileNotFound(uri);
    return text;
  }
  async openFile(value: unknown): Promise<void> {
    if (typeof value !== 'string') throw new Error('Choose a shared file.');
    const uri = vscode.Uri.parse(value, true); this.provideTextDocumentContent(uri);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {preview: false});
  }
  async editDraft(path?: string): Promise<void> {
    const source = this.observation;
    if (!source || !this.drafts) throw new Error('Open shared files before editing a draft.');
    const selected = path ?? source.files.find(file => this.uri(source, file.path).toString() === vscode.window.activeTextEditor?.document.uri.toString())?.path ??
      (await vscode.window.showQuickPick(source.files.map(file => ({label: file.path})), {title: 'Edit shared file draft'}))?.label;
    if (!selected) return;
    const draft = this.drafts.create(source, selected);
    await this.openDraft(draft.id); this.changed();
  }
  private selectedDraft(id?: string): RemoteDraftRecord {
    if (!this.drafts) throw new Error('Shared draft storage is unavailable.');
    const uri = id ?? vscode.window.activeTextEditor?.document.uri.toString();
    if (!uri) throw new Error('Choose a shared draft.');
    const draft = this.drafts.get(uri), client = this.current();
    if (client && (draft.observation.origin !== client.origin || draft.observation.peer !== this.peer(client))) throw new Error('This draft belongs to another ship connection.');
    return draft;
  }
  async openDraft(id: string): Promise<void> {
    const draft = this.selectedDraft(id);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.parse(draft.uri)), {preview: false});
  }
  async compare(id?: string): Promise<void> {
    const draft = this.selectedDraft(id);
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.parse(draft.originalUri), vscode.Uri.parse(draft.uri),
      draft.path + ' · Observed source ↔ local draft', {preview: false});
  }
  async reconcile(id?: string): Promise<void> {
    const draft = this.selectedDraft(id), client = this.current(), link = this.link;
    if (!this.drafts || !client || !link || this.closed || this.busy || this.sending || !this.valid(client, link) ||
        draft.observation.owner !== link.owner || draft.observation.project !== link.project || draft.observation.generation !== link.generation)
      throw new Error('Open this draft’s shared project before reconciling.');
    const held = this.suggestions?.list().find(row => row.draftId === draft.id);
    if (held && held.recoveries?.at(-1)?.phase !== 'recorded' && !['recorded', 'refused', 'refused-before-submit'].includes(held.phase)) throw new Error('Check the retained suggestion before reconciling this draft.');
    const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === draft.uri && !doc.isClosed);
    const local = document?.getText() ?? draft.text; this.drafts.save(draft.id, local);
    await this.refresh();
    const fresh = this.observation;
    if (!this.valid(client, link) || this.state !== 'Read-only shared files' || !fresh) throw new Error('A fresh source observation is required to reconcile.');
    if ((document?.getText() ?? this.drafts.get(draft.id).text) !== local) throw new Error('Draft changed during observation; reconcile again after editing.');
    const original = draft.observation.files.find(file => file.path === draft.path)!, current = fresh.files.find(file => file.path === draft.path);
    if (!current) throw new Error('This file is no longer shared. The original draft is retained.');
    const merged = mergeDraft(original.text, local, current.text);
    if (merged.kind === 'merged' && Buffer.byteLength(merged.text) > 32768) throw new Error('Merged draft exceeds the shared source limit. Both versions are retained.');
    const next = this.drafts.create(fresh, draft.path);
    if (next.text !== current.text) throw new Error('A draft for this observation already has edits. Open it before reconciling.');
    if (merged.kind === 'merged') {
      this.drafts.save(next.id, merged.text); await this.openDraft(next.id);
      void vscode.window.showInformationMessage('Reconciled into a new draft. The original draft is retained.');
    } else {
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.parse(draft.uri), vscode.Uri.parse(next.uri), draft.path + ' · Resolve changes in the new draft on the right', {preview: false});
      void vscode.window.showInformationMessage('Changes overlap. Edit the new draft on the right; the original draft is retained.');
    }
    this.changed();
  }
  async sendSuggestion(id?: string): Promise<void> {
    const draft = this.selectedDraft(id), client = this.current(), link = this.link;
    if (!this.drafts || !this.suggestions || !client || !link || this.closed || this.busy || this.sending ||
        !this.valid(client, link) || draft.observation.owner !== link.owner || draft.observation.project !== link.project || draft.observation.generation !== link.generation)
      throw new Error('Open this draft’s shared project before sending a suggestion.');
    if (this.suggestions.list().some(row => row.draftId === draft.id)) throw new Error('This draft has a retained suggestion. Check its result; do not resend.');
    const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === draft.uri && !doc.isClosed);
    const source = document?.getText() ?? draft.text, captured = this.drafts.save(draft.id, source);
    if (source === draft.observation.files.find(file => file.path === draft.path)!.text) throw new Error('This draft has no changes to suggest.');
    await this.refresh();
    const fresh = this.observation, old = draft.observation;
    if (!this.valid(client, link) || this.state !== 'Read-only shared files' || !fresh) throw new Error('A fresh shared source observation is required before sending.');
    if ((document?.getText() ?? this.drafts.get(draft.id).text) !== source) throw new Error('Draft changed during source observation. Review it before sending.');
    const before = old.files.find(file => file.path === draft.path)!, after = fresh.files.find(file => file.path === draft.path);
    if (['origin', 'peer', 'owner', 'project', 'generation', 'grant', 'root', 'snapshotDigest', 'desk', 'revision'].some(key => old[key as keyof RemoteSourceObservation] !== fresh[key as keyof RemoteSourceObservation]) ||
        !after || before.hash !== after.hash || before.text !== after.text) throw new Error('Shared source changed. Reconcile this draft before sending.');
    this.sending = true; this.changed();
    try {
      const claim = this.suggestions.claim(captured, source, fresh);
      await this.suggestions.submit(client, claim.request);
    } finally {this.sending = false; this.changed();}
  }
  async checkSuggestion(request: string): Promise<void> {
    const client = this.current();
    if (!this.suggestions || !client || this.closed || this.busy || this.sending) throw new Error('Connect the recipient ship before checking this suggestion.');
    const record = this.suggestions.get(request), source = record.intent.observation;
    if (client.origin !== source.origin || this.peer(client) !== source.peer) throw new Error('This suggestion belongs to another ship connection.');
    this.sending = true; this.changed();
    try {
      const latest = record.recoveries?.at(-1)?.phase ?? record.phase;
      if (latest === 'missing' || latest === 'expired') await this.suggestions.recover(client, request, true);
      else await this.suggestions.observe(client, request);
    } finally {this.sending = false; this.changed();}
  }
  private activityContext(): {client: ShipClient; link: SharedProjectLink; source: RemoteSourceObservation} {
    const client = this.client, link = this.link, source = this.observation;
    if (!client || !link || !source || !this.valid(client, link) || this.busy || this.sending || !this.settled ||
        this.state !== 'Read-only shared files' || this.selector?.request !== source.request || source.origin !== client.origin ||
        source.owner !== link.owner || source.project !== link.project || source.generation !== link.generation || source.peer !== link.peer)
      throw new Error('Finish a current shared project read before observing activity. Check unresolved reads; do not resend them.');
    return {client, link, source};
  }
  private currentActivity(context: {client: ShipClient; link: SharedProjectLink; source: RemoteSourceObservation}): boolean {
    try {const current = this.activityContext(); return current.client === context.client && current.link === context.link && current.source === context.source;}
    catch {return false;}
  }
  async refreshActivity(): Promise<void> {
    if (this.activityBusy) throw new Error('Shared project activity is already being observed.');
    const context = this.activityContext(), {client, link} = context;
    this.activityBusy = true;
    try {
      const command = {owner: link.owner, project: link.project, operation: 'query' as const}, until = Date.now() + 15000;
      let reply = await client.activitySubmit(command);
      for (let count = 0; reply.status === 'pending' && count < 15 && Date.now() < until; count++) {
        if (!this.currentActivity(context)) throw new Error('Shared project changed while observing activity.');
        if (count) await new Promise(resolve => setTimeout(resolve, 250));
        if (!this.currentActivity(context) || Date.now() >= until) break;
        reply = await client.activityResult({owner: link.owner, project: link.project, request: reply.request}, command);
      }
      if (!this.currentActivity(context)) throw new Error('Shared project changed while observing activity.');
      if (reply.status !== 'ready') throw new Error('Shared activity is unavailable. No file read or publication was sent.');
      this.activity = {...context, rows: reply.rows, expires: Date.now() + 30000};
      clearTimeout(this.activityExpiry); this.activityExpiry = setTimeout(() => this.changed(), 30000);
    } finally {this.activityBusy = false; this.changed();}
  }
  async openActivityFile(ship: string): Promise<void> {
    const activity = this.activity;
    if (!activity || !this.currentActivity(activity) || Date.now() >= activity.expires) throw new Error('Refresh this shared project’s activity first.');
    const row = activity.rows.find(value => value.ship === ship);
    if (!row) throw new Error('Collaborator is not in this project activity observation.');
    await this.refreshActivity();
    const current = this.activity?.rows.find(value => value.ship === ship);
    if (!this.currentActivity(activity) || !current || current.desk !== row.desk || current.path !== row.path) throw new Error('Collaborator moved or stopped sharing. Choose their current file again.');
    await this.refresh();
    const fresh = this.activityContext();
    if (fresh.client !== activity.client || fresh.link !== activity.link || fresh.source === activity.source || fresh.source.desk !== row.desk || !fresh.source.files.some(file => file.path === row.path))
      throw new Error('This file is not in the fresh owner-granted source. No historical file was opened.');
    const document = await vscode.workspace.openTextDocument(this.uri(fresh.source, row.path));
    if (!this.currentActivity(fresh)) throw new Error('Shared project changed before opening the file.');
    await vscode.window.showTextDocument(document, {preview: false});
  }
  private sessionLinks(client: ShipClient | undefined, peer: string | undefined): SharedProjectLink[] {
    const links = new Map<string, SharedProjectLink>();
    for (const link of [...(this.link && this.client === client ? [this.link] : []), ...this.reads.filter(row => row.client === client).map(row => row.link)]) {
      const key = JSON.stringify([link.owner, link.project]);
      if (client && link.peer === peer && !links.has(key)) links.set(key, link);
    }
    return [...links.values()];
  }
  /** One explicit request per call, held in memory only. A request still pending is read again, never resubmitted. */
  async refreshSessions(owner?: unknown, project?: unknown): Promise<void> {
    const client = this.current();
    if (this.closed || !client) throw new Error('Connect your ship before listing shared sessions.');
    const links = this.sessionLinks(client, this.peer(client));
    let link = links.find(row => row.owner === owner && row.project === project);
    if (!link && owner === undefined && project === undefined) {
      link = links.find(row => this.client === client && row.owner === this.link?.owner && row.project === this.link.project) ?? (links.length === 1 ? links[0] : undefined);
      if (!link && links.length) {
        const picked = await vscode.window.showQuickPick(links.map(row => ({label: row.project, description: row.owner, row})), {title: 'Refresh Shared Sessions'});
        if (!picked) return; link = picked.row;
      }
    }
    if (!link) throw new Error('Open the shared project before listing its sessions.');
    if (this.closed || this.current() !== client) throw new Error('Shared project connection changed.');
    const key = JSON.stringify([link.peer, link.owner, link.project]), prior = this.sessionLists.get(key), held = prior?.client === client ? prior : undefined;
    if (held?.busy) throw new Error('This shared session list is already being read.');
    for (const [id, row] of this.sessionLists) if (row.client !== client) this.sessionLists.delete(id);
    const entry: SessionList = {client, reply: held?.reply, busy: true}; this.sessionLists.set(key, entry); this.changed();
    try {
      await remoteProjectSessionsObserve(client, link, held?.reply?.status === 'pending' ? held.reply.request : undefined, reply => {
        if (this.closed || this.current() !== client || this.sessionLists.get(key) !== entry) throw new Error('Shared project connection changed.');
        entry.reply = reply; this.changed();
      });
    } catch (error) {
      const code = error instanceof ShipClientError ? error.code : '';
      entry.note = code === 'outcomeUnknown' ? 'Outcome unknown; nothing was retried' : code === 'refused' ? 'Your ship refused this request; nothing was sent to the owner' :
        code === 'commandBusy' ? 'Not sent: an earlier request is unresolved or your ship is busy' : 'List unavailable; nothing was retried';
      throw error;
    } finally {entry.busy = false; this.changed();}
  }
  private sessionRow(link: SharedProjectLink): MediaTreeRow {
    const held = this.sessionLists.get(JSON.stringify([link.peer, link.owner, link.project])), list = held?.client === this.current() ? held : undefined;
    const rows: MediaTreeRow[] = list?.busy ? [] : [{label: 'Refresh shared sessions', tooltip: 'Asks the owner once, or reads a request that is still waiting. Nothing is retried automatically.',
      command: {command: 'readymade.refreshSharedSessions', title: 'Refresh Shared Sessions', arguments: [link.owner, link.project]}}];
    if (list?.note) rows.push({label: list.note});
    if (list?.reply) rows.push(...remoteProjectSessionRows(list.reply));
    return {label: 'Sessions · ' + link.owner + ' / ' + link.project,
      description: list?.busy ? 'Asking the owner' : list?.reply?.status === 'ready' ? 'Past observation' : 'Read-only', children: rows};
  }
  rows(): MediaTreeRow[] {
    const children: MediaTreeRow[] = [{label: 'Open Shared Project…', command: {command: 'readymade.openSharedProject', title: 'Open Shared Project'}}];
    if (this.link) {
      const active = this.client === this.current();
      children.push({label: this.link.project, description: this.link.owner, tooltip: `Owner ${this.link.owner}\nRecipient ${this.link.peer}\nGrant generation ${this.link.generation}`});
      children.push({label: active ? this.state : 'Connection changed — historical observation'});
      if (active && !this.busy && !this.sending) {
        if (this.settled) children.push({label: 'Refresh shared files', command: {command: 'readymade.refreshSharedProject', title: 'Refresh'}});
        else if (this.selector) children.push({label: 'Check shared project', command: {command: 'readymade.checkSharedProject', title: 'Check'}});
      }
      try {
        const scope = this.activityContext(), activityRows: MediaTreeRow[] = [{label: 'Refresh activity', command: {command: 'readymade.refreshSharedActivity', title: 'Refresh shared activity'}}];
        if (this.activity && this.currentActivity(this.activity) && Date.now() < this.activity.expires) for (const row of this.activity.rows)
          activityRows.push({label: row.ship, description: '%' + row.desk + row.path, command: {command: 'readymade.openSharedActivityFile', title: 'Open collaborator file', arguments: [row.ship]}});
        children.push({label: 'Activity · ' + scope.link.owner + ' / ' + scope.link.project, description: this.activityBusy ? 'Observing' : 'Read-only', children: activityRows});
      } catch { /* Historical and unresolved source reads do not admit activity navigation. */ }
      if (this.observation) {
        children.push({label: `${this.observation.desk} · revision ${this.observation.revision}`, description: this.state === 'Read-only shared files' ? 'Observed snapshot' : 'Previous observation'});
        for (const file of this.observation.files) children.push({label: file.path, description: 'read-only',
          command: {command: 'readymade.openSharedSource', title: 'Open shared file', arguments: [this.uri(this.observation, file.path).toString()]}});
        children.push({label: 'Edit Draft…', command: {command: 'readymade.editSharedDraft', title: 'Edit Draft'}});
      }
    }
    const client = this.current();
    const projects = new Map<string, RetainedRead>();
    for (const read of this.reads) if (read.client === client) projects.set(JSON.stringify(read.link), read);
    for (const read of projects.values()) if (!this.link || !this.sameTarget(read.link, this.link)) {
      const uri = vscode.Uri.from({scheme: vscode.env.uriScheme, authority: this.authority, path: '/shared-project', query: new URLSearchParams({...read.link}).toString()});
      children.push({label: 'Open ' + read.link.project, description: read.link.owner, tooltip: read.state,
        command: {command: 'readymade.openSharedProject', title: 'Open retained project', arguments: [uri.toString()]}});
    }
    let peer: string | undefined; try {if (client) peer = this.peer(client);} catch { /* No current authenticated presentation scope. */ }
    for (const link of this.sessionLinks(client, peer)) children.push(this.sessionRow(link));
    const allSaved = this.drafts?.list().filter(row => !client || row.observation.origin === client.origin && row.observation.peer === peer) ?? [];
    const resumable = new Map<string, RemoteDraftRecord>();
    for (const draft of allSaved) {
      const o = draft.observation;
      resumable.set(JSON.stringify([o.origin, o.peer, o.owner, o.project, o.generation]), draft);
    }
    for (const draft of resumable.values()) children.push({label: 'Resume ' + draft.observation.project, description: draft.observation.owner,
      tooltip: draft.observation.origin + '\nSaved draft context; resume checks current native access. Pending requests are not resent.',
      command: {command: 'readymade.resumeSharedProject', title: 'Resume Shared Project', arguments: [draft.id]}});
    const saved = allSaved.filter(row => !this.link || row.observation.owner === this.link.owner && row.observation.project === this.link.project);
    const suggestions = new Map(this.suggestions?.list().map(row => [row.draftId, row]) ?? []);
    for (const draft of saved) {
      const suggestion = suggestions.get(draft.id);
      const actions: MediaTreeRow[] = [];
      if (suggestion) {
        const phase = suggestion.phase, recovery = suggestion.recoveries?.at(-1)?.phase;
        actions.push({label: phase === 'recorded' ? 'Recorded on owner — awaiting review' : 'Suggestion: ' + phase, description: 'Not committed'});
        if (recovery) actions.push({label: recovery === 'recorded' ? 'Owner receipt recovered — awaiting review' : 'Receipt recovery: ' + recovery,
          description: 'Original send record retained · Not committed'});
        if (recovery !== 'recorded' && !['recorded', 'refused', 'refused-before-submit'].includes(phase)) {
          const latest = recovery ?? phase, label = latest === 'missing' || latest === 'expired' ? 'Recover Owner Receipt' : 'Check Result';
          actions.push({label, tooltip: 'Read the existing owner receipt. This does not resend your suggestion.',
            command: {command: 'readymade.checkSharedSuggestion', title: label, arguments: [suggestion.request]}});
        }
      } else if (client && this.suggestions) actions.push({label: 'Send Suggestion', command: {command: 'readymade.sendSharedSuggestion', title: 'Send Suggestion', arguments: [draft.id]}});
      children.push({label: draft.path, description: 'Local draft · ' + draft.observation.owner + ' / ' + draft.observation.project,
      tooltip: draft.observation.origin + '\nRecipient ' + draft.observation.peer + '\nGeneration ' + draft.observation.generation + ' · revision ' + draft.observation.revision,
      children: [{label: 'Open Draft', command: {command: 'readymade.openSharedDraft', title: 'Open Draft', arguments: [draft.id]}},
        {label: 'Compare', command: {command: 'readymade.compareSharedDraft', title: 'Compare', arguments: [draft.id]}},
        {label: 'Reconcile', command: {command: 'readymade.reconcileSharedDraft', title: 'Reconcile', arguments: [draft.id]}}, ...actions]});
    }
    return [{id: 'shared-project', label: 'Shared Project', icon: 'organization', children}];
  }
  dispose(): void {this.closed = true; clearTimeout(this.activityExpiry); this.registration.dispose(); this.documents.clear(); this.histories.clear(); this.reads.length = 0; this.sessionLists.clear();}
}
