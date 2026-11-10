import * as vscode from 'vscode';
import {join} from 'node:path';
import type {ShipClient} from './ship-client';
import type {MediaTreeRow} from './media-workbench';
import type {WorkspaceRequestDetail} from './workspace-request-store';
import {WorkspaceImportStore, type WorkspaceImportContext, type WorkspaceImportPreview} from './workspace-import-store';

export interface WorkspaceImportBinding extends WorkspaceImportContext {client: ShipClient}
/** Import retains one native request. Execution stays in the separate request review. */
export class WorkspaceImportView implements vscode.Disposable {
  private busy = false;
  private closed = false;
  private readonly previews = new Map<string, string>();
  private readonly registrations: vscode.Disposable[];
  constructor(private readonly context: vscode.ExtensionContext, private readonly binding: () => WorkspaceImportBinding | undefined,
    private readonly changed: () => void, private readonly selected: (detail: WorkspaceRequestDetail) => Promise<void>) {
    const command = (name: string, run: (...args: unknown[]) => Promise<void>) => vscode.commands.registerCommand(name, async (...args: unknown[]) => {
      try {await run(...args);} catch (error) {void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Shared message import unavailable.'); throw error;}
    });
    this.registrations = [vscode.workspace.registerTextDocumentContentProvider('readymade-import-preview', {
      provideTextDocumentContent: uri => {const value = this.previews.get(uri.toString()); if (value === undefined) throw new Error('Import preview is not retained.'); return value;},
    }), command('readymade.importSharedMessage', () => this.start()), command('readymade.checkSharedMessageImport', nonce => this.check(String(nonce)))];
  }
  private current(b: WorkspaceImportBinding): boolean {
    const now = this.binding(); return !this.closed && !!now && now.client === b.client && now.owner === b.owner && now.project === b.project && now.session === b.session;
  }
  private store(b: WorkspaceImportBinding): WorkspaceImportStore {
    return new WorkspaceImportStore(join(this.context.globalStorageUri.fsPath, 'workspace-imports'), b.client,
      {owner: b.owner, project: b.project, session: b.session}, () => this.current(b));
  }
  private requireBinding(): WorkspaceImportBinding {
    const b = this.binding(); if (this.closed || !b) throw new Error('Select a current project coding session before importing a shared message.'); return b;
  }
  private guard(b: WorkspaceImportBinding): void {if (!this.current(b)) throw new Error('Project or session changed. Start a new import preview in the selected session.');}
  private async inspect(p: WorkspaceImportPreview): Promise<void> {
    if (this.previews.size >= 64) throw new Error('This window retains 64 import previews. Open a new window.');
    const uri = vscode.Uri.parse('readymade-import-preview:/' + p.nonce + '.json');
    this.previews.set(uri.toString(), JSON.stringify(p, null, 2));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {preview: false});
  }
  confirmImport = async (preview: WorkspaceImportPreview, b: WorkspaceImportBinding): Promise<boolean> => (await vscode.window.showWarningMessage('Import this exact shared message?', {modal: true,
        detail: `This retains a request only. Review and execution are separate.\n\nProject: ${b.project}\nSession: ${b.session}\nAuthor: ${preview.author}\nMessage revision: ${preview.revision}\nGrant: ${preview.grant}\nSource: %${preview.sourceDesk} revision ${preview.sourceRevision}\nPreview: ${preview.previewDigest}\n\n${preview.text}`}, 'Import once')) === 'Import once';
  async start(): Promise<void> {
    if (this.busy) throw new Error('A shared message import is already open.');
    const b = this.requireBinding(), store = this.store(b); this.busy = true; this.changed();
    try {
      const options = await store.options(); this.guard(b);
      if (!options.notes.length || !options.grants.length) throw new Error('This session has no importable groups or native grants. Configure them on the ship first.');
      const note = await vscode.window.showQuickPick(options.notes.map(row => ({label: row.title || 'Untitled group', description: row.id, row})), {title: 'Import Shared Message — Choose Group'});
      this.guard(b); if (!note) return;
      let page = await store.messages(note.row.id); this.guard(b);
      let selected: (typeof page.messages)[number] | undefined;
      for (;;) {
        const choices: {label: string; description: string; detail: string; row?: (typeof page.messages)[number]; next: boolean}[] = page.messages.map(row => ({label: row.text.replace(/\s+/g, ' ').slice(0, 100), description: row.author, detail: 'Message ' + row.eid + ' · revision ' + row.revision, row, next: false}));
        if (page.next !== null) choices.push({label: 'Next messages…', description: '', detail: '', row: undefined, next: true});
        if (!choices.length) throw new Error('No importable messages in this group.');
        const pick = await vscode.window.showQuickPick(choices, {title: 'Import Shared Message — Choose Message', matchOnDescription: true});
        this.guard(b); if (!pick) return;
        if (!pick.next) {selected = pick.row; break;}
        page = await store.messages(note.row.id, page.next!, page.catalog); this.guard(b);
      }
      if (!selected) return;
      const grant = await vscode.window.showQuickPick(options.grants.map(row => ({label: row.label, description: row.operations.join(', '), detail: 'Session ' + row.session, row})), {title: 'Import Shared Message — Choose Grant'});
      this.guard(b); if (!grant) return;
      const preview = await store.preview({note: note.row.id, eid: selected.eid, grant: grant.row.id}); this.guard(b);
      await this.inspect(preview); this.guard(b);
      const confirm = await this.confirmImport(preview, b);
      this.guard(b); if (!confirm) return;
      const detail = await store.confirm(preview); this.guard(b);
      await this.selected(detail); void vscode.window.showInformationMessage('Message imported as a retained request. Review execution permissions separately before submitting work.');
    } finally {this.busy = false; this.changed();}
  }
  async check(nonce: string): Promise<void> {
    if (this.busy) throw new Error('Wait for the current import operation.');
    const b = this.requireBinding(), store = this.store(b); this.busy = true;
    try {const detail = await store.recover(nonce); this.guard(b); await this.selected(detail);}
    finally {this.busy = false; this.changed();}
  }
  rows(): MediaTreeRow[] {
    const rows: MediaTreeRow[] = [{label: 'Import Shared Message…', description: this.busy ? 'In progress' : 'Retain a request; do not execute', command: {command: 'readymade.importSharedMessage', title: 'Import Shared Message'}}];
    const b = this.binding(); if (!b || this.closed) return rows;
    try {for (const intent of this.store(b).list().slice(-8).reverse()) rows.push({label: 'Check message import', description: intent.events.at(-1)?.status === 'observed' ? 'Native receipt observed' : 'Outcome unconfirmed — no resend',
      tooltip: intent.preview.author + ' · ' + intent.preview.text.slice(0, 160), command: {command: 'readymade.checkSharedMessageImport', title: 'Check Import Result', arguments: [intent.preview.nonce]}});}
    catch {rows.push({label: 'Import journal unavailable. Existing intents were preserved.'});}
    return rows;
  }
  dispose(): void {this.closed = true; this.previews.clear(); this.registrations.forEach(row => row.dispose());}
}
