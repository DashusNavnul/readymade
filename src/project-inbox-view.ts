import * as vscode from 'vscode';
import {createHash} from 'node:crypto';
import type {ShipClient} from './ship-client';
import {sourceSessionChoice} from './session-selection';
import type {SourceStore, SourceSnapshot} from './source-store';
import {sameBasis, sourceBasis} from './source-store';
import type {SourceLoader} from './source-loader';
import type {DraftRecord, DraftStore} from './draft-store';
import type {MediaTreeRow} from './media-workbench';
import {ExistingInboxDraftError, importInboxSuggestion, importInboxBundle, bundleDrift, type BundleDrift, mergeInboxSuggestion, inboxBasisMatches, projectInbox, projectInboxHistory, inboxHistorySelector,
  projectInboxBundles, projectInboxDetail, bundleSummaryKey, type InboxDetail, type InboxReceipt, type InboxImportContext, type InboxHistoryPage,
  type ProjectInbox, type InboxBundleSummary, type InboxBundleDetail, type InboxBundlesPage} from './project-inbox';

export interface InboxContext {client: ShipClient; project: string; sources: SourceStore; loader: SourceLoader; drafts: DraftStore}
export type InboxAnswer = 'taken' | 'declined';
/** What this computer remembers having told a collaborator about a suggestion. Not kept on the ship. */
export interface InboxAnswerMemory {get(key: string): InboxAnswer | undefined; set(key: string, answer: InboxAnswer): Thenable<void>}
/** Owner presentation. Import creates a local draft; existing candidate/review authority remains unchanged. */
export class ProjectInboxView implements vscode.Disposable {
  private held?: ProjectInbox;
  private history?: InboxHistoryPage;
  private bundles?: InboxBundlesPage;
  private bundlesNote?: string;
  /** Per suggestion: the owner's current files compared with the collaborator's originals (last explicit comparison). */
  private readonly drift = new Map<string, {revision: number; rows: readonly BundleDrift[]; currents: readonly SourceSnapshot[]; suggested: ReadonlyMap<string, string>}>();
  /** Per suggestion and file: the owner's explicit choice. Both versions stay available until a draft is written. */
  private readonly choices = new Map<string, Map<string, 'suggested' | 'mine'>>();
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
    const c = this.current(), owner = this.held?.owner ?? this.history?.owner;
    return c && owner && this.told ? this.told.get(this.toldKey(c, owner, receipt)) : undefined;
  }
  private selected(receipt: string): {row: InboxReceipt; owner: string} | undefined {
    for (const page of [this.held, this.history]) {
      const row = page?.receipts.find(row => row.receiptHash === receipt);
      if (row && page) return {row, owner: page.owner};
    }
    return undefined;
  }
  private conflicts(rows: readonly InboxReceipt[], prior: readonly InboxReceipt[]): boolean {
    return rows.some(row => prior.some(old =>
      (old.receiptHash === row.receiptHash || old.peer === row.peer && old.generation === row.generation && old.request === row.request) &&
      Object.entries(old).some(([key, value]) => row[key as keyof InboxReceipt] !== value)));
  }
  private bundleConflicts(rows: readonly InboxBundleSummary[], prior: readonly InboxBundleSummary[]): boolean {
    return rows.some(row => prior.some(old =>
      (old.receiptHash === row.receiptHash || old.peer === row.peer && old.generation === row.generation && old.request === row.request) &&
      bundleSummaryKey(old) !== bundleSummaryKey(row)));
  }
  /**
   * Tells the collaborator what became of one suggestion: taken, or not taken. One request to the owner's ship,
   * which sends the word on once. It changes nothing in the project; taking a suggestion is still Import, then review.
   */
  async answer(receipt: string, answer: InboxAnswer): Promise<void> {
    this.sync(); const c = this.context(); if (this.busy) throw new Error('An inbox operation is already running.');
    const selected = this.selected(receipt);
    if (!selected) throw new Error('Read the inbox or history before answering this suggestion.');
    const {row, owner} = selected;
    if (answer !== 'taken' && answer !== 'declined') throw new Error('Choose taken or not taken.');
    this.busy = true; this.changed();
    try {
      try {await c.client.suggestionAnswer(c.project, receipt, answer);}
      catch (error) {
        const code = (error as {code?: unknown} | null)?.code, status = (error as {status?: unknown} | null)?.status;
        if (code === 'receiptMissing') throw new Error('Your ship no longer holds this suggestion. Refresh the inbox; nothing was sent.');
        if (code === 'alreadyTold') throw new Error(`You already told ${row.peer} this. Their ship keeps it once, so nothing was sent again. Notices shows whether it arrived.`);
        if (code === 'unavailable') throw new Error('Your ship cannot send notices yet: its notice store is missing or unreadable. Nothing was sent.');
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
    if (scope !== this.scope) {this.scope = scope; this.held = undefined; this.history = undefined; this.bundles = undefined; this.bundlesNote = undefined; this.drift.clear(); this.choices.clear();}
  }
  async observe(): Promise<void> {
    this.sync(); const c = this.context(); if (this.busy) throw new Error('An inbox operation is already running.');
    this.busy = true; this.changed();
    try {
      const state = await c.client.codingState();
      const value = await this.fetch(c.client, c.project);
      if (!this.active(c) || c.client.snapshot?.owner !== state.owner) throw new Error('Owner project changed during inbox observation.');
      this.sync();
      const page = projectInbox(value, state.owner, c.project);
      if (this.conflicts(page.receipts, this.history?.receipts ?? [])) throw new Error('Inbox and history disagree about a suggestion. Refresh both before opening it.');
      // Multi-file suggestions come from a separate owner route; an older ship without it still shows single-file ones.
      let bundles: InboxBundlesPage | undefined, note: string | undefined;
      try {bundles = projectInboxBundles(await c.client.projectInboxBundles(c.project), state.owner, c.project);}
      catch (error) {
        const code = (error as {code?: unknown} | null)?.code;
        if (code !== 'unsupported' && code !== 'refused') throw error;
        note = code === 'unsupported' ? 'Multi-file suggestions: update your ship to list them' : 'Multi-file suggestions: unavailable just now';
      }
      if (!this.active(c) || c.client.snapshot?.owner !== state.owner) throw new Error('Owner project changed during inbox observation.');
      if (this.bundleConflicts(bundles?.bundles ?? [], this.history?.bundles ?? [])) throw new Error('Inbox and history disagree about a suggestion. Refresh both before opening it.');
      this.sync(); this.held = page; this.bundles = bundles; this.bundlesNote = note;
    } finally {this.busy = false; this.changed();}
  }
  async observeHistory(next = false): Promise<void> {
    this.sync(); const c = this.context(); if (this.busy) throw new Error('An inbox operation is already running.');
    const previous = next ? this.history : undefined;
    if (next && (!previous?.more || previous.next === null)) throw new Error('Read history before requesting its next page.');
    const query = inboxHistorySelector(previous ? {revision: previous.revision, after: previous.next, limit: 8} : undefined);
    this.busy = true; this.changed();
    try {
      const state = await c.client.codingState();
      const raw = await c.client.projectInboxHistory(c.project, query);
      if (!this.active(c) || c.client.snapshot?.owner !== state.owner) throw new Error('Owner project changed during history observation.');
      const page = projectInboxHistory(raw, state.owner, c.project, query);
      if (previous && (page.desk !== previous.desk || page.revision !== previous.revision || page.commit !== previous.commit ||
          [...page.receipts, ...page.bundles].some(row => [...previous.receipts, ...previous.bundles].some(old => old.receiptHash === row.receiptHash ||
            old.peer === row.peer && old.generation === row.generation && old.request === row.request))))
        throw new Error('Suggestion history changed or repeated a page. Read History again.');
      if (this.conflicts(page.receipts, this.held?.receipts ?? []) || this.bundleConflicts(page.bundles, this.bundles?.bundles ?? []))
        throw new Error('Inbox and history disagree about a suggestion. Refresh both before opening it.');
      this.sync(); this.history = page;
    } catch (error) {
      if ((error as {code?: unknown} | null)?.code === 'historyChanged') throw new Error('Suggestion history changed. Read History again.');
      throw error;
    } finally {this.busy = false; this.changed();}
  }
  private async detail(c: InboxContext, receipt: string): Promise<InboxDetail> {
    this.sync();
    const selected = this.selected(receipt);
    if (!selected) throw new Error('Read the inbox or history before opening this receipt.');
    const {row, owner} = selected, value = await this.fetch(c.client, c.project, receipt);
    if (!this.active(c) || c.client.snapshot?.owner !== owner) throw new Error('Owner project changed.');
    const detail = projectInbox(value, owner, c.project, receipt).receipts[0] as InboxDetail;
    if (Object.entries(row).some(([key, value]) => detail[key as keyof InboxDetail] !== value)) throw new Error('Suggestion receipt changed. Read the inbox or history again.');
    return detail;
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
  /**
   * Opens one file of a multi-file suggestion read-only, exactly as the collaborator sent it. A hot suggestion carries its
   * sources; an archived one is read once from the owner's ship and must match the history row it was opened from.
   */
  async showBundleFile(receipt: string, path: string): Promise<void> {
    this.sync(); const c = this.context();
    const hot = this.bundles?.bundles.find(b => b.receiptHash === receipt), hotFile = hot?.files.find(f => f.path === path);
    if (hotFile) {await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(this.preview(hotFile.source, hotFile.path)), {preview: false}); return;}
    const owner = this.history?.owner, row = this.history?.bundles.find(b => b.receiptHash === receipt);
    if (!owner || !row?.files.some(f => f.path === path)) throw new Error('Refresh the inbox or history before opening this suggestion.');
    if (this.busy) throw new Error('An inbox operation is already running.');
    this.busy = true; this.changed();
    try {
      let raw: unknown;
      try {raw = await c.client.projectInboxDetail(c.project, receipt);}
      catch (error) {
        const code = (error as {code?: unknown} | null)?.code;
        if (code === 'receiptMissing') throw new Error('Your ship no longer holds this suggestion. Read History again.');
        if (code === 'unsupported') throw new Error('Your ship cannot open archived multi-file suggestions yet. Update its collaboration service.');
        throw error;
      }
      if (!this.active(c) || c.client.snapshot?.owner !== owner) throw new Error('Owner project changed.');
      const detail = projectInboxDetail(raw, owner, c.project, receipt);
      if (!('kind' in detail) || bundleSummaryKey(detail) !== bundleSummaryKey(row)) throw new Error('Suggestion receipt changed. Read History again.');
      const file = detail.files.find(f => f.path === path)!;
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(this.preview(file.source, file.path)), {preview: false});
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
      const detail = await this.detail(c, receipt), owner = this.selected(receipt)!.owner;
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
  /** The whole multi-file suggestion with sources: hot from the inbox, archived through one checked detail read. */
  private async bundleDetail(c: InboxContext, receipt: string): Promise<{detail: InboxBundleDetail; owner: string}> {
    const hot = this.bundles?.bundles.find(b => b.receiptHash === receipt);
    if (hot && this.bundles) return {detail: hot, owner: this.bundles.owner};
    const owner = this.history?.owner, row = this.history?.bundles.find(b => b.receiptHash === receipt);
    if (!owner || !row) throw new Error('Refresh the inbox or history before importing this suggestion.');
    const detail = projectInboxDetail(await c.client.projectInboxDetail(c.project, receipt), owner, c.project, receipt);
    if (!this.active(c) || c.client.snapshot?.owner !== owner) throw new Error('Owner project changed.');
    if (!('kind' in detail) || bundleSummaryKey(detail) !== bundleSummaryKey(row)) throw new Error('Suggestion receipt changed. Read History again.');
    return {detail, owner};
  }
  /**
   * Imports every file of one multi-file suggestion into ONE local draft whose origin (collaborator, receipt, revision)
   * is kept. Every original is read and checked first; a stale or failed read leaves no draft at all.
   */
  async importBundle(receipt: string): Promise<void> {
    this.sync(); const c = this.context(); if (this.busy) throw new Error('An inbox operation is already running.');
    this.busy = true; this.changed();
    try {
      const {detail, owner} = await this.bundleDetail(c, receipt);
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
      const snapshots: SourceSnapshot[] = [];
      for (const file of detail.files) {
        const loaded = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: `Read original ${file.path}`, cancellable: true},
          (progress, token) => c.loader.load(session, basis, file.path, c.project, {active: () => this.active(c) && !token.isCancellationRequested,
            progress: value => progress.report({message: value ? `${value.lines}/${value.total} lines` : 'Reading original from owner ship…'})}));
        if (!loaded || !this.active(c)) return;
        snapshots.push(c.sources.openSnapshot(loaded));
      }
      const after = await c.client.codingState(session), current = after.sessions.find(row => row.id === session && row.project === c.project);
      if (!this.active(c) || after.owner !== owner || !current || !sameBasis(basis, current.source)) throw new Error('Owner source changed while loading the originals. No draft was changed.');
      const draft = importInboxBundle(c.drafts, detail, snapshots, {origin: c.client.origin, owner, project: c.project, session, basis, state: after});
      void vscode.window.showInformationMessage(`${draft.files.length} files imported as one draft from ${detail.peer}. Prepare the whole candidate, check and review before accepting.`);
    } finally {this.busy = false; this.changed();}
  }
  /**
   * Compares every file of one multi-file suggestion with the owner's CURRENT source (newest owner session in the
   * project). A file whose current text no longer matches the collaborator's original is a conflict: the suggested and
   * current versions open side by side, read-only. Nothing is merged, saved or sent.
   */
  async compareBundle(receipt: string): Promise<void> {
    this.sync(); const c = this.context(); if (this.busy) throw new Error('An inbox operation is already running.');
    this.busy = true; this.changed();
    try {
      const {detail, owner} = await this.bundleDetail(c, receipt);
      const state = await c.client.codingState();
      if (!this.active(c) || state.owner !== owner) throw new Error('Owner context changed.');
      const mine = state.sessions.filter(row => row.project === c.project && typeof row.id === 'string');
      const numbered = mine.map(row => {try {return {row, basis: sourceBasis(row.source)};} catch {return undefined;}}).filter(x => x !== undefined);
      if (!numbered.length) throw new Error('No owner session in this project to read the current files from.');
      const newest = numbered.reduce((a, b) => b.basis.number > a.basis.number ? b : a), session = String(newest.row.id);
      const currents: SourceSnapshot[] = [];
      for (const file of detail.files) {
        const loaded = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: `Read current ${file.path}`, cancellable: true},
          (progress, token) => c.loader.load(session, newest.basis, file.path, c.project, {active: () => this.active(c) && !token.isCancellationRequested,
            progress: value => progress.report({message: value ? `${value.lines}/${value.total} lines` : 'Reading current source from owner ship…'})}));
        if (!loaded || !this.active(c)) return;
        currents.push(c.sources.openSnapshot(loaded));
      }
      const rows = bundleDrift(detail, currents);
      this.drift.set(receipt, {revision: newest.basis.number, rows, currents, suggested: new Map(detail.files.map(f => [f.path, f.source]))});
      // An unchanged file takes the suggestion as sent; a moved one waits for the owner's choice.
      this.choices.set(receipt, new Map(rows.filter(r => !r.changed).map(r => [r.path, 'suggested' as const])));
      for (const row of rows.filter(r => r.changed)) {
        const suggested = detail.files.find(f => f.path === row.path)!.source, current = currents.find(s => s.path === row.path)!.text;
        await vscode.commands.executeCommand('vscode.diff', this.preview(suggested, row.path), this.preview(current, row.path),
          `${row.path}: suggested (revision ${detail.revision}) ↔ your current (revision ${newest.basis.number})`);
      }
      const changed = rows.filter(r => r.changed).length;
      void vscode.window.showInformationMessage(changed
        ? `${changed} of ${rows.length} files changed since the collaborator's revision ${detail.revision}. Both versions are open side by side; nothing was changed.`
        : `None of the ${rows.length} files changed since revision ${detail.revision}; the suggestion applies to your current source as sent.`);
    } finally {this.busy = false; this.changed();}
  }
  /** Records the owner's choice for one moved file. Nothing is written until resolveBundle. */
  chooseBundleFile(receipt: string, path: string, choice: 'suggested' | 'mine'): void {
    this.sync();
    const held = this.drift.get(receipt), picks = this.choices.get(receipt);
    if (!held || !picks || !held.rows.some(r => r.path === path)) throw new Error('Compare this suggestion with your current files first.');
    if (choice !== 'suggested' && choice !== 'mine') throw new Error('Choose the suggested version or your own.');
    picks.set(path, choice); this.changed();
  }
  /** Shows the suggested and current versions of one file side by side again, read-only. */
  async showBundleChoice(receipt: string, path: string): Promise<void> {
    this.sync(); const held = this.drift.get(receipt), current = held?.currents.find(s => s.path === path), suggested = held?.suggested.get(path);
    if (!held || !current || suggested === undefined) throw new Error('Compare this suggestion with your current files first.');
    await vscode.commands.executeCommand('vscode.diff', this.preview(suggested, path), this.preview(current.text, path), `${path}: suggested ↔ your current (revision ${held.revision})`);
  }
  /**
   * Once every file has a choice, writes one local draft on the CURRENT source for each file that takes the suggested
   * version; files kept as the owner's stay untouched. A file already in another draft refuses the whole write.
   */
  resolveBundle(receipt: string): void {
    this.sync(); const c = this.context();
    const held = this.drift.get(receipt), picks = this.choices.get(receipt);
    if (!held || !picks) throw new Error('Compare this suggestion with your current files first.');
    const pending = held.rows.filter(r => !picks.has(r.path));
    if (pending.length) throw new Error(`Choose a version for ${pending.map(r => r.path).join(', ')} first.`);
    const taking = held.rows.filter(r => picks.get(r.path) === 'suggested');
    const busy = taking.filter(r => c.drafts.list().some(d => d.snapshot.uri === held.currents.find(s => s.path === r.path)!.uri));
    if (busy.length) throw new Error(`${busy.map(r => r.path).join(', ')} already has a draft. Nothing was written.`);
    for (const row of taking) {
      const current = held.currents.find(s => s.path === row.path)!;
      const draft = c.drafts.create(current); c.drafts.save(draft.id, held.suggested.get(row.path)!);
    }
    void vscode.window.showInformationMessage(taking.length
      ? `${taking.length} draft${taking.length === 1 ? '' : 's'} written on your revision ${held.revision} with the suggested text; ${held.rows.length - taking.length} file(s) kept as yours. Prepare, check and review before accepting.`
      : 'You kept your own version of every file; no draft was written.');
    this.changed();
  }
  /** Opens one file of a retained bundle draft read-only, with the text it holds now. */
  async showBundleDraftFile(id: string, path: string): Promise<void> {
    this.sync(); const c = this.context();
    const row = c.drafts.getBundle(id), file = row.files.find(f => f.snapshot.path === path);
    if (row.project !== c.project || !file) throw new Error('This draft does not belong to the selected project.');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(this.preview(file.text, path)), {preview: false});
  }
  private bundleDraftRows(): MediaTreeRow[] {
    const c = this.current(); if (!c) return [];
    let rows: readonly import('./draft-store').BundleDraftRecord[] = [];
    try {rows = c.drafts.listBundles().filter(row => row.project === c.project);} catch {return [];}
    return rows.map(row => ({label: `${row.files.length}-file draft`, description: `from ${row.receipt.peer}`,
      tooltip: `Imported suggestion ${row.receipt.receiptHash}\n${row.receipt.desk} · revision ${row.receipt.revision} · received ${row.receipt.receivedAt}\n` +
        (row.pending ? `Candidate: ${row.pending.phase}${row.pending.candidate ? ' ' + row.pending.candidate : ''}` : 'No candidate prepared yet'),
      children: [
        ...(row.pending ? [] : [{label: 'Prepare Whole Candidate', tooltip: 'One native candidate for every file; the ship checks them together.',
          command: {command: 'readymade.prepareBundleCandidate', title: 'Prepare Whole Candidate', arguments: [row.id]}}]),
        ...(row.pending?.candidate ? [{label: `Candidate ${row.pending.candidate.slice(0, 11)}…`, description: row.pending.phase,
          command: {command: 'readymade.showCandidate', title: 'Show Candidate', arguments: [row.pending.candidate]}}] : []),
        ...row.files.map(file => ({label: file.snapshot.path, description: 'draft',
          command: {command: 'readymade.openBundleDraftFile', title: 'Open Draft File', arguments: [row.id, file.snapshot.path]}}))]}));
  }
  /** The suggestion receipts held from the last read (peer, path, time), or undefined when not read for this project. */
  get receipts(): ProjectInbox['receipts'] | undefined {this.sync(); return this.held?.receipts;}
  /** Suggestions from the last read that this computer has not answered, or undefined when the inbox has not been read for this project. */
  get waiting(): number | undefined {this.sync(); return this.held?.receipts.filter(row => !this.toldAbout(row.receiptHash)).length;}
  rows(): MediaTreeRow[] {
    this.sync(); const children: MediaTreeRow[] = [{label: this.busy ? 'Reading owner inbox…' : 'Refresh Inbox',
      ...(!this.busy ? {command: {command: 'readymade.projectInbox', title: 'Refresh Inbox'}} : {})}];
    children.push(...this.receiptRows(this.held?.receipts ?? []));
    children.push(...this.bundleRows(this.bundles?.bundles ?? []));
    if (this.bundles?.more) children.push({label: `${this.bundles.total - this.bundles.bundles.length} older multi-file suggestions not shown`});
    if (this.bundlesNote) children.push({label: this.bundlesNote});
    const drafts = this.bundleDraftRows();
    if (drafts.length) children.push({label: 'Imported Multi-File Drafts', icon: 'files', children: drafts});
    if (this.held && !this.held.receipts.length && !this.bundles?.bundles.length) children.push({label: 'No recorded suggestions'});
    const history: MediaTreeRow[] = [{label: this.history ? 'Refresh History' : 'Read History',
      ...(!this.busy ? {command: {command: 'readymade.projectInbox', title: 'Read History', arguments: ['history']}} : {})}];
    history.push(...this.receiptRows(this.history?.receipts ?? []));
    history.push(...this.bundleRows(this.history?.bundles ?? []));
    if (this.history && !this.history.receipts.length && !this.history.bundles.length) history.push({label: this.history.more ? 'No suggestions on this page' : 'No suggestions on this final page'});
    if (this.history?.more) history.push({label: 'Next',
      ...(!this.busy ? {command: {command: 'readymade.projectInbox', title: 'Next History Page', arguments: ['next-history']}} : {})});
    children.push({label: 'History', icon: 'history', children: history});
    return [{id: 'owner-inbox', label: 'Inbox', icon: 'inbox', children}];
  }
  private receiptRows(receipts: readonly InboxReceipt[]): MediaTreeRow[] {
    return receipts.map(row => {
      const told = this.toldAbout(row.receiptHash), said = told === 'taken' ? 'taken' : 'not taken';
      return {label: row.path, description: told ? `${row.peer} · told: ${said}` : row.peer,
        tooltip: `${row.desk} · revision ${row.revision}\nHistorical suggestion — not committed${told ? `\nYou told ${row.peer} it was ${said} (remembered on this computer)` : ''}`,
        children: [{label: 'Open Suggestion', command: {command: 'readymade.openInboxSuggestion', title: 'Open Suggestion', arguments: [row.receiptHash]}},
          {label: 'Import or Merge into My Draft', command: {command: 'readymade.importInboxSuggestion', title: 'Import or Merge into My Draft', arguments: [row.receiptHash]}},
          {label: `Tell ${row.peer} It Was Taken`, tooltip: 'Sends word only. Taking a suggestion is still Import, then your own review.',
            command: {command: 'readymade.answerInboxSuggestion', title: 'Tell It Was Taken', arguments: [row.receiptHash, 'taken']}},
          {label: `Tell ${row.peer} It Was Not Taken`, command: {command: 'readymade.answerInboxSuggestion', title: 'Tell It Was Not Taken', arguments: [row.receiptHash, 'declined']}}]};
    });
  }
  private choiceRows(receipt: string): MediaTreeRow[] {
    const held = this.drift.get(receipt)!, picks = this.choices.get(receipt) ?? new Map<string, string>();
    const rows: MediaTreeRow[] = held.rows.map(r => {
      const pick = picks.get(r.path);
      return {label: r.path, description: pick ? (pick === 'suggested' ? 'use suggested' : 'keep mine') + (r.changed ? '' : ' (unchanged)') : 'changed since suggested: choose',
        children: [{label: 'Show Both Versions', command: {command: 'readymade.showBundleChoice', title: 'Show Both Versions', arguments: [receipt, r.path]}},
          {label: 'Use Suggested', command: {command: 'readymade.chooseBundleFile', title: 'Use Suggested', arguments: [receipt, r.path, 'suggested']}},
          {label: 'Keep Mine', command: {command: 'readymade.chooseBundleFile', title: 'Keep Mine', arguments: [receipt, r.path, 'mine']}}]};
    });
    if (held.rows.every(r => picks.has(r.path)))
      rows.push({label: 'Write Drafts from My Choices', command: {command: 'readymade.resolveInboxBundle', title: 'Write Drafts', arguments: [receipt]}});
    return rows;
  }
  private driftSummary(receipt: string): string {
    const held = this.drift.get(receipt)!, changed = held.rows.filter(r => r.changed).length;
    return changed ? `${changed} of ${held.rows.length} changed since suggested (vs revision ${held.revision})` : `unchanged (vs revision ${held.revision})`;
  }
  private bundleRows(bundles: readonly InboxBundleSummary[]): MediaTreeRow[] {
    return bundles.map(row => ({label: `${row.files.length} files`, description: row.peer,
      tooltip: `${row.desk} · revision ${row.revision}\nOne suggestion covering ${row.files.map(f => f.path).join(', ')}\nHistorical suggestion — not committed`,
      children: [{label: 'Import All Files into One Draft', command: {command: 'readymade.importInboxBundle', title: 'Import into One Draft', arguments: [row.receiptHash]}},
        {label: 'Compare with My Current Files', ...(this.drift.has(row.receiptHash) ? {description: this.driftSummary(row.receiptHash), children: this.choiceRows(row.receiptHash)} : {}),
          command: {command: 'readymade.compareInboxBundle', title: 'Compare with My Current Files', arguments: [row.receiptHash]}},
        ...row.files.map(file => ({label: file.path, description: 'suggested', tooltip: `Original ${file.originalHash}\nSuggested ${file.sourceHash}`,
          command: {command: 'readymade.openInboxBundleFile', title: 'Open Suggested File', arguments: [row.receiptHash, file.path]}}))]}));
  }
  dispose(): void {this.closed = true; this.documents.clear(); this.provider.dispose();}
}
