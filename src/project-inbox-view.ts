import * as vscode from 'vscode';
import {createHash} from 'node:crypto';
import type {ShipClient} from './ship-client';
import {sourceSessionChoice} from './session-selection';
import type {SourceStore, SourceSnapshot} from './source-store';
import {sameBasis, sourceBasis} from './source-store';
import type {SourceLoader} from './source-loader';
import type {DraftRecord, DraftStore} from './draft-store';
import type {MediaTreeRow} from './media-workbench';
import {ExistingInboxDraftError, importInboxSuggestion, mergeInboxSuggestion, inboxBasisMatches, projectInbox, type InboxDetail, type InboxImportContext, type ProjectInbox} from './project-inbox';

export interface InboxContext {client: ShipClient; project: string; sources: SourceStore; loader: SourceLoader; drafts: DraftStore}
export type InboxAnswer = 'taken' | 'declined';
/** What this computer remembers having told a collaborator about a suggestion. Not kept on the ship. */
export interface InboxAnswerMemory {get(key: string): InboxAnswer | undefined; set(key: string, answer: InboxAnswer): Thenable<void>}
/** Owner presentation. Import creates a local draft; existing candidate/review authority remains unchanged. */
export class ProjectInboxView implements vscode.Disposable {
  private held?: ProjectInbox;
  private scope = '';
  private busy = false;
  private closed = false;
  private readonly documents = new Map<string, string>();
  private readonly provider = vscode.workspace.registerTextDocumentContentProvider('readymade-inbox', {provideTextDocumentContent: uri => {
    const text = this.documents.get(uri.toString()); if (text === undefined || this.closed) throw vscode.FileSystemError.FileNotFound(uri); return text;
  }});
  constructor(private readonly current: () => InboxContext | undefined,
    private readonly fetch: (client: ShipClient, project: string, receipt?: string) => Promise<unknown>,
    private readonly beforeRead: () => Promise<unknown>, private readonly changed: () => void,
    private readonly confirmMerge: () => Promise<boolean> = async () => (await vscode.window.showInformationMessage('Review the proposed merge. Apply it to your draft as one undoable edit?', 'Apply Merge')) === 'Apply Merge',
    private readonly told?: InboxAnswerMemory) {}
  private toldKey(c: InboxContext, owner: string, receipt: string): string {return JSON.stringify([c.client.origin, owner, c.project, receipt]);}
  private toldAbout(receipt: string): InboxAnswer | undefined {
    const c = this.current(); return c && this.held && this.told ? this.told.get(this.toldKey(c, this.held.owner, receipt)) : undefined;
  }
  /**
   * Tells the collaborator what became of one suggestion: taken, or not taken. One request to the owner's ship,
   * which sends the word on once. It changes nothing in the project; taking a suggestion is still Import, then review.
   */
  async answer(receipt: string, answer: InboxAnswer): Promise<void> {
    this.sync(); const c = this.context(); if (this.busy) throw new Error('An inbox operation is already running.');
    const row = this.held?.receipts.find(row => row.receiptHash === receipt), owner = this.held?.owner;
    if (!row || !owner) throw new Error('Refresh the owner inbox before answering this suggestion.');
    if (answer !== 'taken' && answer !== 'declined') throw new Error('Choose taken or not taken.');
    this.busy = true; this.changed();
    try {
      try {await c.client.suggestionAnswer(c.project, receipt, answer);}
      catch (error) {
        const code = (error as {code?: unknown} | null)?.code, status = (error as {status?: unknown} | null)?.status;
        if (code === 'receiptMissing') throw new Error('Your ship no longer holds this suggestion. Refresh the inbox; nothing was sent.');
        if (code === 'refused') throw new Error(status === 409 ? 'Your ship could not read its suggestions just now. Nothing was sent; try again.' :
          'Your ship did not accept this. Its collaboration service may be older; update it and try again. Nothing was sent.');
        throw error;
      }
      await this.told?.set(this.toldKey(c, owner, receipt), answer);
      void vscode.window.showInformationMessage(`${row.peer} is being told its suggestion for ${row.path} was ${answer === 'taken' ? 'taken' : 'not taken'}. It reads this the next time its Readymade looks.`);
    } finally {this.busy = false; this.changed();}
  }
  private context(): InboxContext {const c = this.current(); if (!c || this.closed) throw new Error('Connect and select an owner project first.'); return c;}
  private active(c: InboxContext): boolean {
    const now = this.current(); return !this.closed && now?.client === c.client && now.project === c.project && now.sources === c.sources && now.loader === c.loader;
  }
  private sync(): void {
    const c = this.current(), scope = JSON.stringify([c?.client.origin, c?.client.snapshot?.owner, c?.project]);
    if (scope !== this.scope) {this.scope = scope; this.held = undefined;}
  }
  async observe(): Promise<void> {
    this.sync(); const c = this.context(); if (this.busy) throw new Error('An inbox operation is already running.');
    this.busy = true; this.changed();
    try {
      const state = await c.client.codingState();
      const value = await this.fetch(c.client, c.project);
      if (!this.active(c) || c.client.snapshot?.owner !== state.owner) throw new Error('Owner project changed during inbox observation.');
      this.sync(); this.held = projectInbox(value, state.owner, c.project);
    } finally {this.busy = false; this.changed();}
  }
  private async detail(c: InboxContext, receipt: string): Promise<InboxDetail> {
    this.sync();
    if (!this.held || !this.held.receipts.some(row => row.receiptHash === receipt)) throw new Error('Refresh the owner inbox before opening this receipt.');
    const owner = this.held.owner, value = await this.fetch(c.client, c.project, receipt);
    if (!this.active(c) || c.client.snapshot?.owner !== owner) throw new Error('Owner project changed.');
    return projectInbox(value, owner, c.project, receipt).receipts[0] as InboxDetail;
  }
  async show(receipt: string): Promise<void> {
    const c = this.context(); if (this.busy) throw new Error('An inbox operation is already running.');
    this.busy = true;
    try {
      const row = await this.detail(c, receipt);
      if (this.documents.size >= 64) throw new Error('Close this window to open more retained receipt previews.');
      const key = createHash('sha256').update(JSON.stringify([c.client.origin, c.project, row])).digest('hex');
      const uri = vscode.Uri.from({scheme: 'readymade-inbox', path: `/${key}${row.path}`});
      this.documents.set(uri.toString(), row.source);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {preview: false});
    } finally {this.busy = false; this.changed();}
  }
  private async openDraft(draft: DraftRecord): Promise<void> {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.parse(draft.uri)), {preview: false});
  }
  private preview(text: string, path: string): vscode.Uri {
    if (this.documents.size >= 64) throw new Error('Close this window to open more retained receipt previews.');
    const uri = vscode.Uri.from({scheme: 'readymade-inbox', path: `/${createHash('sha256').update(text).digest('hex')}${path}`});
    this.documents.set(uri.toString(), text); return uri;
  }
  private async merge(c: InboxContext, draft: DraftRecord, detail: InboxDetail, snapshot: SourceSnapshot, context: InboxImportContext): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(draft.uri));
    const text = document.getText(), version = document.version, baseline = JSON.stringify(c.drafts.get(draft.id));
    const unchanged = () => this.active(c) && c.client.snapshot?.owner === context.owner &&
      c.client.snapshot.sessions.some(row => row.id === context.session && row.project === context.project && sameBasis(sourceBasis(row.source), context.basis)) &&
      !document.isClosed && document.version === version && document.getText() === text && JSON.stringify(c.drafts.get(draft.id)) === baseline;
    if (!unchanged()) throw new Error('Owner draft changed. Open the suggestion again.');
    const result = mergeInboxSuggestion(c.drafts.get(draft.id), text, detail, snapshot, context);
    if (result.kind === 'conflict') {
      await vscode.commands.executeCommand('vscode.diff', this.preview(detail.source, detail.path), document.uri, 'Suggestion ↔ My Draft — resolve overlapping edits manually');
      void vscode.window.showInformationMessage('These edits overlap. The suggestion is read-only on the left; your draft is on the right. Both versions are preserved. Copy or edit the changes you want; nothing was applied or saved.');
      return;
    }
    await vscode.commands.executeCommand('vscode.diff', this.preview(text, detail.path), this.preview(result.text, detail.path), 'My Draft ↔ Proposed Merge');
    if (!await this.confirmMerge()) return;
    if (!unchanged()) throw new Error('Owner draft or project changed during preview. Nothing was applied.');
    const freshDetail = await this.detail(c, detail.receiptHash);
    if (JSON.stringify(freshDetail) !== JSON.stringify(detail)) throw new Error('Suggestion receipt changed. Nothing was applied.');
    const state = await c.client.codingState(context.session);
    if (!unchanged()) throw new Error('Owner draft or project changed during confirmation. Nothing was applied.');
    mergeInboxSuggestion(c.drafts.get(draft.id), text, freshDetail, snapshot, {...context, state});
    const editor = await vscode.window.showTextDocument(document, {preview: false});
    if (!unchanged()) throw new Error('Owner draft changed before applying the merge. Nothing was applied.');
    const applied = await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(0), document.positionAt(text.length)), result.text), {undoStopBefore: true, undoStopAfter: true});
    if (!applied) throw new Error('Editor refused the merge. No save or submission was sent.');
    void vscode.window.showInformationMessage('Merge applied to your unsaved draft. Undo restores your previous buffer. Save, prepare and review explicitly when ready.');
  }
  async import(receipt: string): Promise<void> {
    const c = this.context(); if (this.busy) throw new Error('An inbox operation is already running.');
    this.busy = true; this.changed();
    try {
      const detail = await this.detail(c, receipt), owner = this.held!.owner;
      await this.beforeRead();
      const state = await c.client.codingState();
      if (!this.active(c) || state.owner !== owner) throw new Error('Owner context changed.');
      const choices = state.sessions.filter(row => {
        try {return row.project === c.project && typeof row.id === 'string' && inboxBasisMatches(detail, sourceBasis(row.source), owner);} catch {return false;}
      });
      if (!choices.length) throw new Error('No current owner session matches this suggestion’s source revision. No draft was changed.');
      const choice = choices.length === 1 ? sourceSessionChoice(choices[0]) : await vscode.window.showQuickPick(choices.map(sourceSessionChoice),
        {title: 'Choose the task for this suggestion', matchOnDescription: true, matchOnDetail: true});
      const session = choice ? String(choice.session.id) : undefined;
      if (!session || !this.active(c)) return;
      const selected = await c.client.codingState(session), row = selected.sessions.find(row => row.id === session && row.project === c.project);
      if (!row || !this.active(c) || selected.owner !== owner) throw new Error('Owner session changed.');
      const basis = sourceBasis(row.source);
      if (!inboxBasisMatches(detail, basis, owner)) throw new Error('Suggestion source is stale. No draft was changed.');
      const loaded = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: 'Read original source for suggestion', cancellable: true},
        (progress, token) => c.loader.load(session, basis, detail.path, c.project, {active: () => this.active(c) && !token.isCancellationRequested,
          progress: value => progress.report({message: value ? `${value.lines}/${value.total} lines` : 'Reading original from owner ship…'})}));
      if (!loaded || !this.active(c)) return;
      const after = await c.client.codingState(session), current = after.sessions.find(row => row.id === session && row.project === c.project);
      if (!this.active(c) || after.owner !== owner || !current || !sameBasis(basis, current.source)) throw new Error('Owner source changed while loading the original. No draft was changed.');
      const snapshot = c.sources.openSnapshot(loaded);
      const existing = c.drafts.list().find(row => row.snapshot.uri === snapshot.uri);
      if (existing && (existing.pending || existing.text !== snapshot.text || vscode.workspace.textDocuments.some(doc => doc.uri.toString() === existing.uri && doc.isDirty))) {
        await this.merge(c, existing, detail, snapshot, {origin: c.client.origin, owner, project: c.project, session, basis, state: after}); return;
      }
      try {await this.openDraft(importInboxSuggestion(c.drafts, detail, snapshot, {origin: c.client.origin, owner, project: c.project, session, basis, state: after}));}
      catch (error) {if (error instanceof ExistingInboxDraftError) await this.openDraft(error.draft); throw error;}
      void vscode.window.showInformationMessage('Suggestion imported as a local draft. Prepare a candidate, run checks, and review before accepting.');
    } finally {this.busy = false; this.changed();}
  }
  /** The suggestion receipts held from the last read (peer, path, time), or undefined when not read for this project. */
  get receipts(): ProjectInbox['receipts'] | undefined {this.sync(); return this.held?.receipts;}
  /** Suggestions from the last read that this computer has not answered, or undefined when the inbox has not been read for this project. */
  get waiting(): number | undefined {this.sync(); return this.held?.receipts.filter(row => !this.toldAbout(row.receiptHash)).length;}
  rows(): MediaTreeRow[] {
    this.sync(); const children: MediaTreeRow[] = [{label: this.busy ? 'Reading owner inbox…' : 'Refresh Inbox',
      ...(!this.busy ? {command: {command: 'readymade.projectInbox', title: 'Refresh Inbox'}} : {})}];
    for (const row of this.held?.receipts ?? []) {
      const told = this.toldAbout(row.receiptHash), said = told === 'taken' ? 'taken' : 'not taken';
      children.push({label: row.path, description: told ? `${row.peer} · told: ${said}` : row.peer,
        tooltip: `${row.desk} · revision ${row.revision}\nHistorical suggestion — not committed${told ? `\nYou told ${row.peer} it was ${said} (remembered on this computer)` : ''}`,
        children: [{label: 'Open Suggestion', command: {command: 'readymade.openInboxSuggestion', title: 'Open Suggestion', arguments: [row.receiptHash]}},
          {label: 'Import or Merge into My Draft', command: {command: 'readymade.importInboxSuggestion', title: 'Import or Merge into My Draft', arguments: [row.receiptHash]}},
          {label: `Tell ${row.peer} It Was Taken`, tooltip: 'Sends word only. Taking a suggestion is still Import, then your own review.',
            command: {command: 'readymade.answerInboxSuggestion', title: 'Tell It Was Taken', arguments: [row.receiptHash, 'taken']}},
          {label: `Tell ${row.peer} It Was Not Taken`, command: {command: 'readymade.answerInboxSuggestion', title: 'Tell It Was Not Taken', arguments: [row.receiptHash, 'declined']}}]});
    }
    if (this.held && !this.held.receipts.length) children.push({label: 'No recorded suggestions'});
    return [{id: 'owner-inbox', label: 'Inbox', icon: 'inbox', children}];
  }
  dispose(): void {this.closed = true; this.documents.clear(); this.provider.dispose();}
}
