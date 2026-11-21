import * as vscode from 'vscode';
import {mergeDraft} from './draft-merge';
import {createHash, randomUUID} from 'node:crypto';
import {ShipClientError, type ShipClient} from './ship-client';
import type {RemoteSuggestionJournal} from './remote-suggestion-journal';
import {bundleStanding, remoteBundleOutcome, type RemoteBundleJournal, type SavedBundle} from './remote-bundle-suggest';
import {suggestionSettled, suggestionStanding, type SavedSuggestion} from './remote-suggestion-journal';
import {SEND_ACTIONS, bundleStatus, suggestionStatus} from './remote-send-status';
import {draftStanding, fullWords, makeRoom, moveAllFinished, moveFinished, finishedWork, movedWords, type Room, type WorkStores} from './remote-work-history';
import type {RemoteDraftStore, RemoteDraftRecord} from './remote-draft-store';
import type {ActivityReply} from './editing-activity';
import type {MediaTreeRow} from './media-workbench';
import {remoteShip, remoteProjectViewTarget, type RemoteProjectViewTarget, type RemoteProjectViewSelector, type RemoteProjectViewReply, type RemoteSourceObservation} from './remote-project-view';
import {SharedSessionPages} from './remote-project-session-pages';

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
interface SessionList {client: ShipClient; pages: SharedSessionPages; busy: boolean}
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
  /** Requests whose result could not be read at the last try, with why. It is not an outcome: the send is as unresolved as before. */
  private readonly unread = new Map<string, string>();
  /** One page of history, read when the person asks for it; never read while the tree is drawn. */
  private history?: {page: number; drafts: {total: number; drafts: RemoteDraftRecord[]}; suggestions: {total: number; suggestions: SavedSuggestion[]}; bundles: {total: number; bundles: SavedBundle[]}; restorable: Map<string, string>};
  constructor(private readonly authority: string, private readonly current: () => ShipClient | undefined,
    private readonly connect: (origin?: string) => Promise<ShipClient | undefined>, private readonly changed: () => void, private readonly drafts?: RemoteDraftStore, private readonly suggestions?: RemoteSuggestionJournal,
    private readonly bundles?: RemoteBundleJournal) {}
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
      await this.showHistorical(this.uri(source, link.file), () => {
        if (!this.valid(client, activeLink) || this.observation !== source) throw new Error('Shared project connection changed.');
      });
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
    // Retain the exact request before dispatch so a lost POST answer is recoverable by GET.
    const request = '0x' + BigInt('0x' + randomUUID().replaceAll('-', '')).toString(16).replace(/\B(?=(?:[0-9a-f]{4})+$)/g, '.');
    this.selector = {owner: link.owner, project: link.project, generation: link.generation, request};
    this.busy = true; this.settled = false; this.state = 'Reading shared files…'; this.changed();
    try {
      const result = await client.projectViewSubmit(this.selector);
      if (!this.valid(client, link)) throw new Error('Shared project connection changed.');
      this.selector = {owner: result.owner, project: result.project, generation: result.generation, request: result.request};
      this.accept(result); await this.observe(client, link);
    } catch (error) {
      this.settled = error instanceof ShipClientError && ['refused', 'commandBusy'].includes(error.code);
      this.state = error instanceof ShipClientError && error.code === 'refused' && error.status === 400
        ? 'Update the collaboration service on your ship to recover shared-file reads'
        : this.settled ? 'Read not submitted — Refresh to try again' : 'Outcome unknown — Check shared project to read its result';
      throw error;
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
  private verifyHistorical(document: vscode.TextDocument, expected: string, guard: () => void): void {
    guard();
    if (this.closed || document.getText() !== expected) throw new Error('Historical evidence buffer changed. Reopen a new window to inspect the retained evidence.');
  }
  private async showHistorical(uri: vscode.Uri, guard: () => void = () => {}): Promise<void> {
    guard(); const expected = this.provideTextDocumentContent(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    this.verifyHistorical(document, expected, guard);
    await vscode.window.showTextDocument(document, {preview: false});
    this.verifyHistorical(document, expected, guard);
  }
  async openFile(value: unknown): Promise<void> {
    if (typeof value !== 'string') throw new Error('Choose a shared file.');
    await this.showHistorical(vscode.Uri.parse(value, true));
  }
  private stores(): WorkStores {
    if (!this.drafts) throw new Error('Shared draft storage is unavailable.');
    return {drafts: this.drafts, suggestions: this.suggestions, bundles: this.bundles};
  }
  /** A draft open in an editor is left where it is by any move the person did not ask for by name. */
  private inEditor(id: string): boolean {
    return vscode.workspace.textDocuments.some(doc => !doc.isClosed && doc.uri.scheme === 'readymade-remote-draft' && doc.uri.path.startsWith(`/${id}/`));
  }
  /**
   * Before one more draft or suggestion: when all 64 open places of a store are taken, the oldest finished work
   * moves to history, and the person is told. Work that `keep` names, or that is open in an editor, stays. When
   * nothing in a full store is finished, the reason is said and nothing is discarded.
   */
  private room(need: Room, keep: readonly string[] = []): void {
    const made = makeRoom(this.stores(), need, id => keep.includes(id) || this.inEditor(id));
    if (made.sends + made.drafts) {
      this.history = undefined;
      void vscode.window.showInformationMessage(`Moved ${movedWords(made)} to history to make room. Nothing was deleted; see Shared Work History.`);
    }
    if (made.short.length) throw new Error(fullWords(made.short[0]));
  }
  private idle(): void {if (this.closed || this.busy || this.sending) throw new Error('Wait for the running shared-project operation to finish.');}
  /**
   * Before a send is recorded: a connection that is answering another request would refuse this one, so say so
   * now, while nothing is recorded. From here to the send there is no pause in which that could change.
   */
  private sendable(client: ShipClient): void {
    try {client.assertIdle();}
    catch (error) {throw error instanceof ShipClientError && error.code === 'commandBusy' ? new Error('Your ship is answering another request right now. Nothing was recorded or sent; send again in a moment.') : error;}
  }
  /** Move every finished suggestion and its drafts to history now. Unsent drafts and unsettled sends stay. */
  async moveFinishedToHistory(): Promise<void> {
    this.idle();
    const moved = moveAllFinished(this.stores(), id => this.inEditor(id));
    this.history = undefined; this.changed();
    void vscode.window.showInformationMessage(moved.sends + moved.drafts ? `Moved ${movedWords(moved)} to history. Nothing was deleted; see Shared Work History.`
      : 'Nothing is finished yet: unsent drafts and suggestions without a settled result stay open.');
  }
  /**
   * Move one draft to history. A draft whose suggestion is finished goes with that suggestion. A draft that was
   * never sent is the person's own unsent work: it moves only after they confirm, keeps its text, and can be restored.
   * A draft whose suggestion is not settled stays, so its result can still be checked.
   */
  async moveDraftToHistory(id: string): Promise<void> {
    this.idle();
    const stores = this.stores(), draft = stores.drafts.get(id), standing = draftStanding(stores, draft.id);
    if (standing === 'unsettled') throw new Error('This draft has a suggestion whose result is not settled. Check its result first; then it can move to history.');
    const ended = standing === 'ended' ? stores.suggestions?.list().find(row => row.draftId === draft.id) : undefined;
    if (standing === 'ended' && !ended) throw new Error('This draft went in a multi-file suggestion that ended without a result. Move that suggestion to history; its drafts go with it.');
    const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === draft.uri && !doc.isClosed);
    if (document) stores.drafts.save(draft.id, document.getText());
    if (ended) {
      // The owner was asked for its receipt and did not confirm one. Whether it arrived is not known, and that is what history will say.
      const answer = await vscode.window.showWarningMessage('Move this suggestion to history without a result?', {modal: true,
        detail: `${draft.path}: ${suggestionStatus(ended).label}. History keeps it exactly so; the draft goes with it and is never sent again. The owner’s answer, if one comes, still arrives as a notice.`}, 'Move to History');
      if (answer !== 'Move to History') return;
      this.idle(); stores.suggestions!.archive(ended.request, true); stores.drafts.archive(draft.id);
    } else if (standing === 'unsent') {
      const answer = await vscode.window.showWarningMessage('Move this unsent draft to history?', {modal: true,
        detail: `${draft.path} was never sent. It moves out of your open drafts with its text exactly as it is, and can be restored from Shared Work History.`}, 'Move to History');
      if (answer !== 'Move to History') return;
      this.idle(); stores.drafts.archive(draft.id);
    } else {
      const unit = finishedWork(stores).find(unit => unit.drafts.includes(draft.id));
      if (unit) moveFinished(stores, unit);
    }
    this.history = undefined; this.changed();
  }
  /** Move one multi-file suggestion and its drafts to history. One that ended without a result moves only after the person confirms. */
  async moveBundleToHistory(request: string): Promise<void> {
    this.idle();
    const stores = this.stores(), bundles = this.bundles;
    if (!bundles) throw new Error('Shared suggestion storage is unavailable.');
    const held = bundles.get(request), standing = bundleStanding(held);
    if (standing === 'open') throw new Error('This suggestion can still be checked. Check its result first; then it can move to history.');
    if (standing === 'ended') {
      const answer = await vscode.window.showWarningMessage('Move this suggestion to history without a result?', {modal: true,
        detail: `It ended as “${remoteBundleOutcome(held.phase, held.reason)}”. History keeps it exactly so, and its ${held.drafts.length} drafts stay marked as sent: they are never sent again.`}, 'Move to History');
      if (answer !== 'Move to History') return;
      this.idle(); bundles.archive(request, true);
      const open = new Set(stores.drafts.list().map(draft => draft.id));
      for (const id of held.drafts) if (open.has(id)) stores.drafts.archive(id);
    } else moveFinished(stores, {kind: 'bundle', request, drafts: held.drafts, at: held.updatedAt});
    this.history = undefined; this.changed();
  }
  /** Read one page of history (eight of each kind, most recently moved first) for the tree to show. */
  async showHistory(page = 0): Promise<void> {
    const stores = this.stores(), offset = Math.max(0, Math.floor(page)) * 8;
    const drafts = stores.drafts.archivedPage(offset, 8);
    const suggestions = stores.suggestions?.archivedPage(offset, 8) ?? {total: 0, suggestions: []}, bundles = stores.bundles?.archivedPage(offset, 8) ?? {total: 0, bundles: []};
    // Which sent drafts are themselves in history, so a suggestion row can offer to bring its draft back.
    const restorable = new Map<string, string>();
    for (const id of [...suggestions.suggestions.map(row => row.draftId), ...bundles.bundles.flatMap(row => row.drafts)]) {
      const draft = stores.drafts.archived(id); if (draft) restorable.set(id, draft.path);
    }
    this.history = {page: offset / 8, drafts, suggestions, bundles, restorable}; this.changed();
  }
  /** Bring one draft back from history among the open drafts, exactly as it was, and open it. A sent draft stays marked as sent. */
  async restoreDraft(id: string): Promise<void> {
    this.idle();
    const stores = this.stores();
    if (!stores.drafts.archived(id)) throw new Error('This draft is not in history.');
    this.room({drafts: 1});
    const draft = stores.drafts.restore(id);
    if (this.history) await this.showHistory(this.history.page); else this.changed();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.parse(draft.uri)), {preview: false});
  }
  async editDraft(path?: string): Promise<void> {
    const source = this.observation;
    if (!source || !this.drafts) throw new Error('Open shared files before editing a draft.');
    const selected = path ?? source.files.find(file => this.uri(source, file.path).toString() === vscode.window.activeTextEditor?.document.uri.toString())?.path ??
      (await vscode.window.showQuickPick(source.files.map(file => ({label: file.path})), {title: 'Edit shared file draft'}))?.label;
    if (!selected) return;
    // A draft of this file of this read that is already open is simply opened; only a new one needs a place.
    if (!this.drafts.opened(source, selected)) this.room({drafts: 1});
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
    const draft = this.selectedDraft(id), client = this.current();
    const expected = draft.observation.files.find(file => file.path === draft.path)!.text;
    const guard = () => {
      if (this.closed || this.current() !== client) throw new Error('Shared project connection changed.');
      this.selectedDraft(draft.id);
    };
    guard();
    const original = await vscode.workspace.openTextDocument(vscode.Uri.parse(draft.originalUri));
    this.verifyHistorical(original, expected, guard);
    await vscode.commands.executeCommand('vscode.diff', original.uri, vscode.Uri.parse(draft.uri),
      draft.path + ' · Observed source ↔ local draft', {preview: false});
    this.verifyHistorical(original, expected, guard);
  }
  async reconcile(id?: string): Promise<void> {
    const draft = this.selectedDraft(id), client = this.current(), link = this.link;
    if (!this.drafts || !client || !link || this.closed || this.busy || this.sending || !this.valid(client, link) ||
        draft.observation.owner !== link.owner || draft.observation.project !== link.project || draft.observation.generation !== link.generation)
      throw new Error('Open this draft’s shared project before reconciling.');
    const held = this.suggestions?.list().find(row => row.draftId === draft.id), standing = held && suggestionStatus(held);
    // A draft is continued as a new draft only when its suggestion is resolved: recorded, refused, or never sent.
    if (standing && !standing.resolved) throw new Error(standing.action === 'none' ? `This draft’s suggestion is not resolved (${standing.label}).`
      : `This draft’s suggestion is not resolved (${standing.label}). Use ${SEND_ACTIONS[standing.action].label} first; a draft is reconciled into a new one only after that.`);
    // The same for a draft that went in a multi-file suggestion which can still be checked or closed.
    const together = this.bundles?.list().find(row => row.drafts.includes(draft.id)), shared = together && bundleStatus(together);
    if (shared && shared.action !== 'none') throw new Error(`This draft went in a multi-file suggestion that is not resolved (${shared.label}). Use ${SEND_ACTIONS[shared.action].label} on it first; a draft is reconciled into a new one only after that.`);
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
    if (!this.drafts.opened(fresh, draft.path)) this.room({drafts: 1}, [draft.id]);
    const next = this.drafts.create(fresh, draft.path);
    if (next.text !== current.text) throw new Error('A draft for this observation already has edits. Open it before reconciling.');
    if (next.id !== draft.id) this.drafts.continues(next.id, draft.id);
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
    if (this.suggestions.holds(draft.id) || this.bundles?.holdsDraft(draft.id))
      throw new Error('This draft has a retained suggestion. Check its result; do not resend.');
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
      this.sendable(client);
      this.room({suggestions: 1}, [draft.id]);
      const claim = this.suggestions.claim(captured, source, fresh);
      await this.suggestions.submit(client, claim.request);
    } finally {this.sending = false; this.changed();}
  }
  /** Drafts of this shared project that no single-file or multi-file suggestion has taken. */
  private bundleCandidates(link: SharedProjectLink): RemoteDraftRecord[] {
    const sent = this.bundles?.claimedDrafts() ?? new Set<string>();
    return (this.drafts?.list() ?? []).filter(d => d.observation.owner === link.owner && d.observation.project === link.project &&
      d.observation.generation === link.generation && d.observation.peer === link.peer && !this.suggestions?.holds(d.id) && !(this.bundles?.holdsDraft(d.id, sent) ?? false));
  }
  /** Sends two or more changed drafts as ONE suggestion, bound to one fresh owner source observation. Never resent. */
  async sendBundle(ids?: readonly string[]): Promise<void> {
    const client = this.current(), link = this.link, drafts = this.drafts, bundles = this.bundles;
    if (!drafts || !bundles || !client || !link || this.closed || this.busy || this.sending || !this.valid(client, link))
      throw new Error('Open the shared project before sending a multi-file suggestion.');
    const eligible = this.bundleCandidates(link);
    if (eligible.length < 2) throw new Error('Edit at least two shared files, then send them together.');
    // Called with draft ids (command arguments), the choice is exact and no picker is shown.
    if (ids && ids.some(id => !eligible.some(draft => draft.id === id))) throw new Error('A chosen draft is not an unsent draft of this shared project.');
    const picked = ids ? eligible.filter(draft => ids.includes(draft.id)).map(draft => ({draft})) :
      await vscode.window.showQuickPick(eligible.map(draft => ({label: draft.path, description: 'revision ' + draft.observation.revision, picked: true, draft})),
        {title: 'Send these drafts as one suggestion', canPickMany: true});
    if (!picked || !this.valid(client, link)) return;
    if (picked.length < 2) throw new Error('Choose at least two drafts. Send a single draft with Send Suggestion.');
    const chosen = picked.map(row => row.draft), old = chosen[0].observation;
    if (chosen.some(d => d.observation.request !== old.request)) throw new Error('These drafts come from different observations. Reconcile them onto the current shared files first.');
    const text = (d: RemoteDraftRecord) => vscode.workspace.textDocuments.find(doc => doc.uri.toString() === d.uri && !doc.isClosed)?.getText() ?? drafts.get(d.id).text;
    const files = chosen.map(d => {const source = text(d); drafts.save(d.id, source); return {path: d.path, source};});
    const unchanged = chosen.find((d, i) => files[i].source === old.files.find(f => f.path === d.path)?.text);
    if (unchanged) throw new Error(`${unchanged.path} has no changes to suggest.`);
    await this.refresh();
    const fresh = this.observation;
    if (!this.valid(client, link) || this.state !== 'Read-only shared files' || !fresh) throw new Error('A fresh shared source observation is required before sending.');
    if (chosen.some((d, i) => text(d) !== files[i].source)) throw new Error('A draft changed during source observation. Review it before sending.');
    const fields = ['origin', 'peer', 'owner', 'project', 'generation', 'grant', 'root', 'snapshotDigest', 'desk', 'revision'] as const;
    if (fields.some(key => old[key] !== fresh[key]) || chosen.some(d => {
      const before = old.files.find(f => f.path === d.path), after = fresh.files.find(f => f.path === d.path);
      return !before || !after || before.hash !== after.hash || before.text !== after.text;
    })) throw new Error('Shared source changed. Reconcile these drafts before sending.');
    this.sending = true; this.changed();
    try {
      this.sendable(client);
      this.room({bundles: 1}, chosen.map(d => d.id));
      const claim = bundles.claim(chosen.map(d => d.id), files, fresh);
      await bundles.submit(client, claim.request);
    } finally {this.sending = false; this.changed();}
  }
  /**
   * Goal item 27: the owner refused this suggestion because its shared files moved (stale-parent). Read the current files
   * once, merge each sent draft onto them (original → sent → current), and write NEW drafts; the refused drafts stay.
   * Overlaps open side by side. Nothing is sent: the collaborator sends the new drafts as one suggestion when ready.
   */
  async rebaseBundle(request: string): Promise<void> {
    const client = this.current(), link = this.link, drafts = this.drafts, bundles = this.bundles;
    if (!drafts || !bundles || !client || !link || this.closed || this.busy || this.sending || !this.valid(client, link))
      throw new Error('Open the shared project before rebasing this suggestion.');
    const held = bundles.get(request), old = held.intent.observation;
    if (old.owner !== link.owner || old.project !== link.project || old.peer !== this.peer(client)) throw new Error('This suggestion belongs to another shared project.');
    if (held.phase !== 'refused' || held.reason !== 'stale-parent') throw new Error('Only a suggestion refused because the shared files moved can be rebased.');
    await this.refresh();
    const fresh = this.observation;
    if (!this.valid(client, link) || this.state !== 'Read-only shared files' || !fresh) throw new Error('A fresh source observation is required to rebase.');
    // Preflight every file before writing any draft: all-or-nothing.
    const plan = held.intent.files.map(file => {
      const original = old.files.find(f => f.path === file.path), current = fresh.files.find(f => f.path === file.path);
      if (!original) throw new Error(`${file.path} is missing from the refused suggestion's observation. Nothing was rebased.`);
      if (!current) throw new Error(`${file.path} is no longer shared. Nothing was rebased; the refused drafts are kept.`);
      const merged = mergeDraft(original.text, file.source, current.text);
      if (merged.kind === 'merged' && Buffer.byteLength(merged.text) > 32768) throw new Error(`${file.path} would exceed the shared source limit. Nothing was rebased.`);
      return {path: file.path, sent: file.source, current: current.text, merged};
    });
    if (plan.some(row => drafts.list().some(d => d.observation.request === fresh.request && d.path === row.path && d.text !== row.current)))
      throw new Error('A draft for these current files already has edits. Open it before rebasing. Nothing was rebased.');
    // Room for every new draft before the first is written; the refused suggestion and its drafts are what is being rebased and stay.
    const places = plan.filter(row => !drafts.opened(fresh, row.path)).length;
    if (places) this.room({drafts: places}, held.drafts);
    let conflicts = 0;
    for (const row of plan) {
      const next = drafts.create(fresh, row.path);
      if (row.merged.kind === 'merged') {drafts.save(next.id, row.merged.text); continue;}
      conflicts++;
      const refused = held.drafts.map(id => {try {return drafts.get(id);} catch {return undefined;}}).find(d => d?.path === row.path);
      if (!refused) continue;
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.parse(refused.uri), vscode.Uri.parse(next.uri),
        `${row.path} · your refused suggestion ↔ new draft on the current files (resolve on the right)`, {preview: false});
    }
    void vscode.window.showInformationMessage(conflicts
      ? `Rebased ${plan.length - conflicts} of ${plan.length} files cleanly; ${conflicts} overlap and are open side by side. Nothing was sent; the refused drafts are kept.`
      : `All ${plan.length} files rebased onto revision ${fresh.revision}. Nothing was sent: review the new drafts, then Send Drafts as One Suggestion.`);
    this.changed();
  }
  async checkBundle(request: string): Promise<void> {
    const client = this.current();
    if (!this.bundles || !client || this.closed || this.busy || this.sending) throw new Error('Connect the recipient ship before checking this suggestion.');
    const o = this.bundles.get(request).intent.observation;
    if (client.origin !== o.origin || this.peer(client) !== o.peer) throw new Error('This suggestion belongs to another ship connection.');
    if (this.bundles.get(request).phase === 'claimed') throw new Error(RemoteSourceView.neverSent);
    this.sending = true; this.changed();
    try {await this.bundles.observe(client, request); this.unread.delete(request);}
    catch (error) {throw this.unreadable(request, error);}
    finally {this.sending = false; this.changed();}
  }
  private static readonly neverSent = 'This suggestion was recorded on this computer and never sent, so there is no result to read. Use Close as Not Sent; then reconcile the draft to send a new suggestion.';
  /** A result that could not be read: said in plain words, kept beside the row, and never taken for an outcome. */
  private unreadable(request: string, error: unknown): Error {
    const code = error instanceof ShipClientError ? error.code : '';
    const why = ['transport', 'unavailable', 'closed'].includes(code) ? 'Your ship did not answer.' : code === 'authenticationRequired' ? 'Your ship asks you to sign in again.'
      : code === 'contextChanged' ? 'The connection changed while reading.' : code === 'commandBusy' ? 'Another request to your ship was running.'
      : code === 'malformed' ? 'Your ship answered with something Readymade could not verify.' : error instanceof Error ? error.message : 'The result could not be read.';
    const message = `${why} The result could not be read just now. Nothing was sent and your draft is unchanged; the outcome is still not known. Check again.`;
    this.unread.set(request, message); return new Error(message);
  }
  /**
   * Close a suggestion that was recorded on this computer and never sent (Readymade stopped in between). Nothing is
   * sent or read; its record says not sent from then on, and its draft can be reconciled into a new one.
   */
  async closeUnsent(request: string): Promise<void> {
    this.idle();
    if (this.suggestions?.list().some(row => row.request === request)) this.suggestions.release(request);
    else if (this.bundles?.list().some(row => row.request === request)) this.bundles.release(request);
    else throw new Error('This suggestion is not among the open ones.');
    this.unread.delete(request); this.changed();
    void vscode.window.showInformationMessage('Closed as not sent; nothing was sent. Reconcile the draft onto the current shared files to send a new suggestion.');
  }
  async checkSuggestion(request: string): Promise<void> {
    const client = this.current();
    if (!this.suggestions || !client || this.closed || this.busy || this.sending) throw new Error('Connect the recipient ship before checking this suggestion.');
    const record = this.suggestions.get(request), source = record.intent.observation;
    if (client.origin !== source.origin || this.peer(client) !== source.peer) throw new Error('This suggestion belongs to another ship connection.');
    if (record.phase === 'claimed' && !record.recoveries?.length) throw new Error(RemoteSourceView.neverSent);
    this.sending = true; this.changed();
    try {
      const latest = record.recoveries?.at(-1)?.phase ?? record.phase;
      if (latest === 'missing' || latest === 'expired') await this.suggestions.recover(client, request, true);
      else await this.suggestions.observe(client, request);
      this.unread.delete(request);
    } catch (error) {throw this.unreadable(request, error);}
    finally {this.sending = false; this.changed();}
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
    await this.showHistorical(this.uri(fresh.source, row.path), () => {
      if (!this.currentActivity(fresh)) throw new Error('Shared project changed before opening the file.');
    });
  }
  private sessionLinks(client: ShipClient | undefined, peer: string | undefined): SharedProjectLink[] {
    const links = new Map<string, SharedProjectLink>();
    for (const link of [...(this.link && this.client === client ? [this.link] : []), ...this.reads.filter(row => row.client === client).map(row => row.link)]) {
      const key = JSON.stringify([link.owner, link.project]);
      if (client && link.peer === peer && !links.has(key)) links.set(key, link);
    }
    return [...links.values()];
  }
  /** The shared file a read-only source document shows, when it belongs to the project open here now. */
  sharedFile(uri: vscode.Uri): {owner: string; project: string; path: string} | undefined {
    const seen = this.observation; if (this.closed || !seen || uri.scheme !== scheme) return undefined;
    const file = seen.files.find(f => this.uri(seen, f.path).toString() === uri.toString());
    return file && {owner: seen.owner, project: seen.project, path: file.path};
  }
  /** Sessions other owners shared with this ship, as last listed here. Presentation only: no authority is implied. */
  sharedSessions(): {owner: string; project: string; generation: string; session: string; inspection: string; phase: string}[] {
    const client = this.current(); if (this.closed || !client) return [];
    return this.sessionLinks(client, this.peer(client)).flatMap(link => {
      const held = this.sessionLists.get(JSON.stringify([link.peer, link.owner, link.project]));
      return held?.client !== client ? [] : held.pages.sessions.map(s => ({owner: link.owner, project: link.project, generation: link.generation, session: s.id, inspection: s.inspection, phase: s.phase}));
    });
  }
  /** A bounded catalog traversal, held in memory only. Unanswered pages resume by exact observation. */
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
    const entry: SessionList = {client, pages: held?.pages.resumable ? held.pages : new SharedSessionPages(client, {owner: link.owner, project: link.project}, link.peer), busy: true};
    this.sessionLists.set(key, entry); this.changed();
    try {
      await entry.pages.observe(() => {
        if (this.closed || this.current() !== client || this.sessionLists.get(key) !== entry) throw new Error('Shared project connection changed.');
        this.changed();
      });
    } finally {entry.busy = false; this.changed();}
  }
  private sessionRow(link: SharedProjectLink): MediaTreeRow {
    const held = this.sessionLists.get(JSON.stringify([link.peer, link.owner, link.project])), list = held?.client === this.current() ? held : undefined;
    const rows: MediaTreeRow[] = list?.busy ? [] : [{label: 'Refresh shared sessions', tooltip: 'Reads all sharing-grant pages, or observes the exact unanswered page. Session activity is observed separately on each page.',
      command: {command: 'readymade.refreshSharedSessions', title: 'Refresh Shared Sessions', arguments: [link.owner, link.project]}}];
    if (list) rows.push(...list.pages.rows());
    return {label: 'Sessions · ' + link.owner + ' / ' + link.project,
      description: list?.busy ? 'Reading pages' : list?.pages.complete ? 'Complete past observation' : 'Read-only · incomplete', children: rows};
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
    const openBundles = this.bundles?.list() ?? [], none: ReadonlySet<string> = new Set();
    const suggestions = new Map(this.suggestions?.list().map(row => [row.draftId, row]) ?? []), bundled = new Map(openBundles.flatMap(row => row.drafts.map(id => [id, row] as const)));
    for (const draft of saved) {
      const suggestion = suggestions.get(draft.id), inBundle = bundled.get(draft.id);
      const sentEarlier = !suggestion && !inBundle && ((this.suggestions?.holds(draft.id) ?? false) || (this.bundles?.holdsDraft(draft.id, none) ?? false));
      const actions: MediaTreeRow[] = [];
      if (suggestion) {
        // What is known about the send, what is not, and the one next step. No step here sends the suggestion again.
        const status = suggestionStatus(suggestion), unread = this.unread.get(suggestion.request);
        actions.push({label: status.label, description: suggestion.recoveries?.length ? 'Original send record retained · Not committed' : 'Not committed', tooltip: status.detail});
        if (unread) actions.push({label: 'The result could not be read just now', description: 'Your suggestion was not sent again', tooltip: unread});
        if (status.action !== 'none') {
          const next = SEND_ACTIONS[status.action];
          actions.push({label: next.label, tooltip: next.tooltip,
            command: {command: status.action === 'close-unsent' ? 'readymade.closeUnsentSharedSuggestion' : 'readymade.checkSharedSuggestion', title: next.label, arguments: [suggestion.request]},
            problem: {key: JSON.stringify([draft.observation.origin, draft.observation.owner, draft.observation.project, suggestion.request]),
              category: 'delivery', status: status.state === 'local' ? 'blocked' : 'unknown',
              label: `${draft.observation.owner} / ${draft.observation.project}: ${status.label}`}});
        }
      } else if (bundled.has(draft.id)) actions.push({label: 'Sent in a multi-file suggestion', description: 'See its result below'});
      else if (sentEarlier) {
        // What history holds for this draft, in its own words: it may have been recorded, refused, or closed as never sent.
        const kept = this.suggestions?.archived(draft.id);
        actions.push({label: kept ? 'In history: ' + suggestionStatus(kept).label : 'In history with its multi-file suggestion', description: 'This draft is never sent again'});
      }
      else if (client && this.suggestions) actions.push({label: 'Send Suggestion', command: {command: 'readymade.sendSharedSuggestion', title: 'Send Suggestion', arguments: [draft.id]}});
      // What may leave the open list: finished work freely, a never-sent draft when the person confirms, an unsettled send not at all.
      const standing = suggestion ? suggestionStanding(suggestion) : inBundle ? 'with-bundle' : sentEarlier ? 'finished' : 'unsent';
      if (standing === 'finished' || standing === 'unsent' || standing === 'ended') actions.push({label: standing === 'finished' ? 'Move to History' : 'Move to History…',
        tooltip: standing === 'unsent' ? 'This draft was never sent. It leaves your open drafts with its text exactly as it is, and can be restored. Asks first.'
          : standing === 'ended' ? 'The owner did not confirm a receipt, so the outcome is not known. History keeps the suggestion exactly so, with its draft. Asks first.'
          : 'This work is finished. It leaves the open list and stays readable in history; it is never sent again.',
        command: {command: 'readymade.moveSharedDraftToHistory', title: 'Move to History', arguments: [draft.id]}});
      const earlier = this.drafts?.continued(draft.id);
      if (earlier) actions.unshift({label: 'Continues an earlier draft', description: suggestions.has(earlier) ? suggestionStatus(suggestions.get(earlier)!).label : 'the earlier draft and its suggestion are kept',
        tooltip: 'Made by reconciling an earlier draft of this file onto newer shared files. The earlier draft and what became of its suggestion are kept, open or in history.'});
      children.push({label: draft.path, description: 'Local draft · ' + draft.observation.owner + ' / ' + draft.observation.project,
      tooltip: draft.observation.origin + '\nRecipient ' + draft.observation.peer + '\nGeneration ' + draft.observation.generation + ' · revision ' + draft.observation.revision,
      children: [{label: 'Open Draft', command: {command: 'readymade.openSharedDraft', title: 'Open Draft', arguments: [draft.id]},
        problem: suggestion && ['refused', 'refused-before-submit'].includes(suggestion.phase) ? {
          key: JSON.stringify([draft.observation.origin, draft.observation.owner, draft.observation.project, suggestion.request]),
          category: 'delivery', status: 'blocked', label: `${draft.observation.owner} / ${draft.observation.project}: suggestion ${suggestion.phase}`} : undefined},
        {label: 'Compare', command: {command: 'readymade.compareSharedDraft', title: 'Compare', arguments: [draft.id]}},
        {label: 'Reconcile', command: {command: 'readymade.reconcileSharedDraft', title: 'Reconcile', arguments: [draft.id]}}, ...actions]});
    }
    if (client && this.link && this.bundles && !this.busy && !this.sending && this.valid(client, this.link) && this.bundleCandidates(this.link).length >= 2)
      children.push({label: 'Send Drafts as One Suggestion…', tooltip: 'One suggestion covering several shared files, bound to the current owner source.',
        command: {command: 'readymade.sendSharedBundle', title: 'Send Drafts as One Suggestion'}});
    for (const bundle of openBundles) {
      const o = bundle.intent.observation, standing = bundleStanding(bundle);
      if (client && (o.origin !== client.origin || o.peer !== peer) || this.link && (o.owner !== this.link.owner || o.project !== this.link.project)) continue;
      const open = !['recorded', 'refused', 'uncertain', 'refused-before-submit'].includes(bundle.phase);
      const key = JSON.stringify([o.origin, o.owner, o.project, bundle.request]), status = bundleStatus(bundle), unread = this.unread.get(bundle.request);
      children.push({label: `Suggestion · ${bundle.intent.files.length} files`, description: o.owner + ' / ' + o.project,
        tooltip: bundle.intent.files.map(f => f.path).join('\n') + `\nBased on revision ${o.revision} · not committed` + (bundle.receiptHash ? `\nOwner receipt ${bundle.receiptHash}` : ''),
        children: [{label: status.label, description: 'Not committed', tooltip: status.detail,
          problem: bundle.phase === 'recorded' ? undefined : {key, category: 'delivery', status: open && status.state !== 'local' ? 'unknown' : 'blocked',
            label: `${o.owner} / ${o.project}: multi-file suggestion: ${status.label}`}},
        ...(unread ? [{label: 'The result could not be read just now', description: 'Your suggestion was not sent again', tooltip: unread}] : []),
        ...bundle.intent.files.map(f => ({label: f.path, description: status.state === 'local' || status.state === 'not-sent' ? 'not sent' : 'sent'})),
        ...(status.action === 'none' ? [] : [{label: SEND_ACTIONS[status.action].label, tooltip: SEND_ACTIONS[status.action].tooltip,
          command: {command: status.action === 'close-unsent' ? 'readymade.closeUnsentSharedSuggestion' : 'readymade.checkSharedBundle', title: SEND_ACTIONS[status.action].label, arguments: [bundle.request]}}]),
        ...(bundle.phase === 'refused' && bundle.reason === 'stale-parent' ? [{label: 'Rebase onto Current Files',
          tooltip: 'Read the current files once and write new drafts with your changes merged in. Nothing is sent.',
          command: {command: 'readymade.rebaseSharedBundle', title: 'Rebase onto Current Files', arguments: [bundle.request]}}] : []),
        ...(standing === 'open' ? [] : [{label: standing === 'ended' ? 'Move to History…' : 'Move to History',
          tooltip: standing === 'ended' ? 'This suggestion ended without a result. History keeps it exactly so and its drafts stay marked as sent. Asks first.'
            : 'This suggestion is finished. It and its drafts leave the open list and stay readable in history.',
          command: {command: 'readymade.moveSharedBundleToHistory', title: 'Move to History', arguments: [bundle.request]}}])]});
    }
    const done = [...suggestions.values()].filter(row => suggestionSettled(row)).length + openBundles.filter(row => bundleStanding(row) === 'finished').length;
    if (done) children.push({label: 'Move Finished Work to History', description: `${done} finished`,
      tooltip: 'Suggestions with a settled result, and their drafts, leave the open list and stay readable in history. Unsent drafts and unsettled suggestions stay. Nothing is deleted.',
      command: {command: 'readymade.moveFinishedSharedWork', title: 'Move Finished Work to History'}});
    if (this.drafts) children.push(this.historyRow());
    return [{id: 'shared-project', label: 'Shared Project', icon: 'organization', children}];
  }
  /** History as last read by showHistory(); the tree never reads history files itself. */
  private historyRow(): MediaTreeRow {
    const show = (page: number, title: string) => ({command: 'readymade.sharedWorkHistory', title, arguments: [page]});
    const held = this.history;
    if (!held) return {label: 'Shared Work History', description: 'Drafts and suggestions moved out of the open list', command: show(0, 'Shared Work History')};
    const day = (at: number) => new Date(at).toISOString().slice(0, 10), rows: MediaTreeRow[] = [];
    const restore = (id: string, label = 'Restore Draft'): MediaTreeRow => ({label, tooltip: 'Brings the draft back among your open drafts exactly as it was. A draft that was sent stays marked as sent.',
      command: {command: 'readymade.restoreSharedDraft', title: 'Restore Draft', arguments: [id]}});
    for (const draft of held.drafts.drafts) {
      const o = draft.observation;
      rows.push({label: draft.path, description: `Draft · ${o.owner} / ${o.project} · revision ${o.revision} · ${day(draft.updatedAt)}`,
        tooltip: o.origin + '\nRecipient ' + o.peer + '\nGeneration ' + o.generation, children: [restore(draft.id)]});
    }
    for (const row of held.suggestions.suggestions) {
      const o = row.intent.observation;
      rows.push({label: row.intent.path, description: `Suggestion · ${suggestionStatus(row).label} · ${o.owner} / ${o.project} · ${day(row.updatedAt)}`,
        tooltip: `Request ${row.request}\nBased on revision ${o.revision} · not committed`,
        children: [{label: 'Never sent again', description: 'Not committed'}, ...(held.restorable.has(row.draftId) ? [restore(row.draftId, 'Restore Its Draft')] : [])]});
    }
    for (const row of held.bundles.bundles) {
      const o = row.intent.observation;
      rows.push({label: `Suggestion · ${row.intent.files.length} files`, description: `${bundleStatus(row).label} · ${o.owner} / ${o.project} · ${day(row.updatedAt)}`,
        tooltip: row.intent.files.map(f => f.path).join('\n') + `\nBased on revision ${o.revision} · not committed` + (row.receiptHash ? `\nOwner receipt ${row.receiptHash}` : ''),
        children: [...row.intent.files.map(f => ({label: f.path, description: 'sent'})), ...row.drafts.filter(id => held.restorable.has(id)).map(id => restore(id, 'Restore Draft ' + held.restorable.get(id)))]});
    }
    if (!rows.length) rows.push({label: held.page ? 'Nothing older' : 'Nothing has been moved to history yet'});
    if (held.page > 0) rows.push({label: 'Newer…', command: show(held.page - 1, 'Newer')});
    if (Math.max(held.drafts.total, held.suggestions.total, held.bundles.total) > (held.page + 1) * 8) rows.push({label: 'Older…', command: show(held.page + 1, 'Older')});
    return {label: 'Shared Work History', description: `${held.drafts.total} drafts · ${held.suggestions.total + held.bundles.total} suggestions`, children: rows};
  }
  dispose(): void {this.closed = true; clearTimeout(this.activityExpiry); this.registration.dispose(); this.documents.clear(); this.histories.clear(); this.reads.length = 0; this.sessionLists.clear();}
}
