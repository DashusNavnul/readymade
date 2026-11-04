import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import type { ShipClient } from './ship-client';
import type { MediaTreeRow } from './media-workbench';
import { WorkspaceRequestStore, type WorkspaceRequestRow } from './workspace-request-store';

/** Native presentation of retained ship requests. Local storage never grants permission. */
export class WorkspaceRequestView implements vscode.Disposable {
  private model?: WorkspaceRequestStore;
  private selectionKey?: string;
  private showing = false;
  private disposed = false;
  private snapshot = 'No retained request observed.';
  private readonly changedDocument = new vscode.EventEmitter<vscode.Uri>();
  private readonly uri = vscode.Uri.parse('readymade-request:/retained-request.json');
  private readonly registrations: vscode.Disposable[];
  constructor(private readonly context: vscode.ExtensionContext, private readonly changed: () => void,
    private readonly selectSession: (session: string) => Promise<void>) {
    this.registrations = [this.changedDocument,
      vscode.workspace.registerTextDocumentContentProvider('readymade-request', {
        onDidChange: this.changedDocument.event, provideTextDocumentContent: () => this.snapshot,
      }),
      vscode.commands.registerCommand('readymade.workspaceRequests', async (project?: unknown) => {
        try { await this.show(typeof project === 'string' ? project : undefined); }
        catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Retained requests unavailable.'); }
      }),
    ];
  }
  get store(): WorkspaceRequestStore | undefined { return this.model; }
  connect(client: ShipClient, owner: string): void {
    if (this.disposed) throw new Error('Request view is closed.');
    const binding = createHash('sha256').update(JSON.stringify([client.origin, owner])).digest('hex');
    this.disconnect();
    const journalKey = `readymade.requests.journal.${binding}`;
    // Corrupt journals must fail closed; never reset attempted markers to regain submission.
    const model = new WorkspaceRequestStore(owner, client, {
      saved: this.context.workspaceState.get<unknown>(journalKey),
      save: async journal => { await this.context.workspaceState.update(journalKey, journal); },
    });
    this.model = model; this.selectionKey = `readymade.requests.selection.${binding}`; this.changed();
  }
  disconnect(): void {
    this.model?.dispose(); this.model = undefined; this.selectionKey = undefined;
    this.snapshot = 'Disconnected. No current native request observation.'; this.changedDocument.fire(this.uri); this.changed();
  }
  rows(project?: string): MediaTreeRow[] {
    if (!this.model) return [];
    const selected = this.model.selection, requests = this.model.requests.filter(row => !project || row.project === project);
    return [{id: 'workspace-requests', label: project ? 'Shared coding requests' : 'Shared coding requests (all projects)', icon: 'comment-discussion',
      description: `${requests.length} loaded`, tooltip: this.model.notice,
      command: {command: 'readymade.workspaceRequests', title: 'Browse shared coding requests', arguments: project ? [project] : []},
      children: selected && (!project || selected.project === project) ? [{label: selected.project, icon: 'git-pull-request',
        description: this.model.uncertain ? 'Outcome unknown' : this.model.observation?.status ?? 'Read required',
        tooltip: this.model.notice, command: {command: 'readymade.workspaceRequests', title: 'Inspect retained request', arguments: [selected.project]}}] : undefined,
    }];
  }
  private current(model: WorkspaceRequestStore): void {
    if (this.disposed || this.model !== model) throw new Error('Workspace connection changed. Reopen shared requests.');
  }
  private async inspect(model: WorkspaceRequestStore, scope?: string): Promise<void> {
    this.current(model);
    this.snapshot = JSON.stringify({observation: 'Native retained request snapshot; task completion is not verified.',
      ...(scope ? {reviewedExecutionScope: scope} : {}), request: model.observation ?? null}, null, 2);
    this.changedDocument.fire(this.uri);
    const document = await vscode.workspace.openTextDocument(this.uri); this.current(model);
    await vscode.window.showTextDocument(document, {preview: false, preserveFocus: false}); this.current(model);
  }
  async show(project?: string): Promise<void> {
    if (this.showing) throw new Error('Shared request picker is already open.');
    const model = this.model;
    if (!model || !this.selectionKey) throw new Error('Connect Readymade before opening shared requests.');
    this.showing = true;
    try {
      const selectionKey = this.selectionKey;
      await model.load(); this.current(model);
      while (model.catalog?.next !== null && model.catalog?.next !== undefined) { await model.load(true); this.current(model); }
      const saved = this.context.workspaceState.get<WorkspaceRequestRow>(selectionKey);
      const previous = model.selection ?? saved;
      const restored = previous && model.requests.find(row => ['requester', 'nonce', 'requestDigest', 'project', 'session'].every(k => row[k as keyof WorkspaceRequestRow] === previous[k as keyof WorkspaceRequestRow]));
      if (restored) model.select(restored);
      this.changed();
      const items = model.requests.filter(row => !project || row.project === project).map(row => ({
        label: row.project, description: `${row.requester} · ${row.status}`, detail: `Session ${row.session} · Request ${row.nonce}`,
        picked: restored?.nonce === row.nonce && restored.requester === row.requester, row,
      }));
      if (!items.length) { await vscode.window.showInformationMessage(project ? `No retained requests for ${project}.` : 'No shared coding requests retained on this ship.'); return; }
      const picked = await vscode.window.showQuickPick(items, {title: 'Shared coding requests', placeHolder: 'Select a retained project request', matchOnDescription: true, matchOnDetail: true});
      this.current(model); if (!picked) return;
      model.select(picked.row); await this.context.workspaceState.update(selectionKey, model.exportSelection()); this.current(model);
      try { await this.selectSession(picked.row.session); }
      catch (error) {
        this.current(model);
        void vscode.window.showWarningMessage(`Coding source refresh failed; shared request observation and recovery remain available. ${error instanceof Error ? error.message : ''}`);
      }
      this.current(model);
      // Reading on explicit selection is observation only. Permission preview remains an explicit action.
      try { await model.read(); }
      catch (error) {
        this.current(model);
        if (!model.canRecover) throw error;
        await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Native outcome unavailable. Use explicit recovery.');
      }
      this.current(model); this.changed();
      await this.actions(model);
    } finally { this.showing = false; this.changed(); }
  }
  private async actions(model: WorkspaceRequestStore): Promise<void> {
    while (this.model === model && !this.disposed) {
      const actions = [
        {label: 'Inspect exact request', detail: 'Open a read-only native request snapshot', action: 'inspect'},
        {label: 'Refresh native outcome', detail: 'Read the retained instruction status without submitting', action: 'read'},
      ];
      if (model.observation?.status === 'reserved' && !model.uncertain) actions.push({label: 'Review execution permissions', detail: 'Check the current scope, review this exact instruction, then choose whether to submit', action: 'review'});
      if (model.canRecover) actions.push({label: 'Check submission outcome', detail: 'Ask the native recovery endpoint to observe the existing submission; never resend it', action: 'recover'});
      const picked = await vscode.window.showQuickPick(actions, {title: `${model.selection?.project ?? 'Shared request'} — ${model.observation?.status ?? 'unobserved'}`, placeHolder: model.notice});
      this.current(model); if (!picked) return;
      try {
        if (picked.action === 'inspect') await this.inspect(model);
        if (picked.action === 'read') await model.read();
        if (picked.action === 'recover') await model.recover();
        if (picked.action === 'review') await this.review(model);
        this.current(model);
      } catch (error) {
        this.current(model);
        await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Native request unavailable.');
      } finally { this.changed(); }
    }
  }
  private async review(model: WorkspaceRequestStore): Promise<void> {
    await model.read(); this.current(model); await model.preview(); this.current(model);
    const review = model.review(); await this.inspect(model, review.scope);
    const chosen = await vscode.window.showWarningMessage('Submit this exact shared coding request?', {
      modal: true,
      detail: `This submits once through native permission checks. Instruction acceptance does not prove task completion.\n\nExecution scope: ${review.scope}\nImmutable request fingerprint: ${review.fingerprint}\n\n${JSON.stringify(model.observation, null, 2)}`,
    }, 'Submit once');
    this.current(model); if (chosen !== 'Submit once') return;
    await model.submit(); this.current(model); await this.inspect(model);
    await vscode.window.showInformationMessage(model.notice);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.disconnect(); for (const registration of this.registrations) registration.dispose();
  }
}
