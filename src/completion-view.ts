import * as vscode from 'vscode';
import { CompletionJournal, type CompletionResult } from './completion-journal';
import { observeCompletion, type CompletionObservation } from './completion-store';
import type { ShipClient } from './ship-client';
import type { MediaTreeRow } from './media-workbench';

export interface AnswerDialogs {
  reason(): Thenable<string | undefined>;
  confirm(project: string, detail: string): Thenable<boolean>;
}
const nativeDialogs: AnswerDialogs = {
  reason: () => vscode.window.showInputBox({title: 'Accept answer as owner', prompt: 'Why is this answer complete?', ignoreFocusOut: true}),
  confirm: async (project, detail) => (await vscode.window.showWarningMessage(`Accept this answer for ${project}?`,
    {modal: true, detail}, 'Accept answer')) === 'Accept answer'
};

/** Answer judgments are separate from accepting source changes and deploying apps. */
export class CompletionView implements vscode.Disposable {
  private client?: ShipClient;
  private observation?: CompletionObservation;
  private scope = '';
  private busy = false;
  private text = 'Select a project and observe answer review.';
  private readonly uri = vscode.Uri.parse('readymade-answer-review:/answer-review.json');
  private readonly changedDocument = new vscode.EventEmitter<vscode.Uri>();
  private readonly provider: vscode.Disposable;
  constructor(private readonly journal: CompletionJournal, private readonly project: () => string | undefined, private readonly changed: () => void,
    private readonly dialogs: AnswerDialogs = nativeDialogs) {
    this.provider = vscode.workspace.registerTextDocumentContentProvider('readymade-answer-review', {onDidChange: this.changedDocument.event,
      provideTextDocumentContent: uri => {if (uri.toString() !== this.uri.toString()) throw vscode.FileSystemError.FileNotFound(uri); return this.text;}});
  }
  connect(client: ShipClient): void {this.client = client; this.scope = ''; this.sync();}
  private sync(): void {
    const scope = JSON.stringify([this.client?.origin, this.client?.snapshot?.owner, this.project()]);
    if (scope === this.scope) return;
    this.scope = scope; this.observation = undefined; this.text = 'No answer review observed for this project.'; this.changedDocument.fire(this.uri);
  }
  private entries(): CompletionResult[] {
    return this.journal.entries().filter(e => e.intent.origin === this.client?.origin && e.intent.context.owner === this.client?.snapshot?.owner && e.intent.context.project === this.project());
  }
  private async show(value: unknown): Promise<void> {
    this.text = JSON.stringify({notice: 'Answer completion only. This does not accept code changes or deploy an application.', evidence: value}, null, 2);
    this.changedDocument.fire(this.uri); await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(this.uri), {preview: false});
  }
  async observe(session?: string): Promise<void> {
    this.sync(); const client = this.client, project = this.project(), scope = this.scope;
    if (!client || !project || this.busy) throw new Error('Select a project and wait for the current review operation.');
    this.busy = true;
    try {
      const state = await client.codingState(), choices = state.sessions.filter(s => s.project === project);
      const selected = session ?? (await vscode.window.showQuickPick(choices.map(s => ({label: String(s.id)})), {title: 'Review an answer'}))?.label;
      if (!selected) return;
      if (!choices.some(s => s.id === selected)) throw new Error('Session belongs to another project.');
      const observed = await observeCompletion(client, {owner: state.owner, project, session: selected});
      this.sync(); if (scope !== this.scope || client !== this.client) throw new Error('Project changed during review.');
      this.observation = observed; await this.show(observed);
    } catch (error) {
      this.observation = undefined; this.text = 'Answer review unavailable. Observe again before making a decision.';
      this.changedDocument.fire(this.uri); throw error;
    }
    finally {this.busy = false; this.changed();}
  }
  async accept(): Promise<void> {
    this.sync(); const held = this.observation, client = this.client, scope = this.scope;
    if (!held?.proposal || !client || this.busy) throw new Error('Observe a ready answer proposal first.');
    this.busy = true;
    try {
      await this.show(held);
      const reason = await this.dialogs.reason();
      if (!reason) return;
      const approved = await this.dialogs.confirm(held.context.project,
        `Session ${held.context.session}\nProposal ${held.proposal.digest}\n\n${held.proposal.objective}\n\nReason: ${reason}\n\nThis records answer completion. It does not accept code changes or deploy an app.`);
      if (!approved) return;
      this.sync(); if (scope !== this.scope || client !== this.client || held !== this.observation) throw new Error('Project changed. Review the answer again.');
      const result = await this.journal.accept(client, held.context, held.proposal, reason, true);
      this.observation = undefined; this.sync(); if (scope === this.scope) await this.show(result);
    } catch (error) {this.observation = undefined; throw error;}
    finally {this.busy = false; this.changed();}
  }
  async recover(attempt: string): Promise<void> {
    this.sync(); const scope = this.scope, client = this.client;
    if (!client || this.busy) throw new Error('Wait for the current review operation.');
    const held = this.entries().filter(e => e.intent.attempt === attempt);
    if (held.length !== 1) throw new Error('Select an exact retained answer decision.');
    this.busy = true;
    try {const result = await this.journal.recover(client, held[0].intent); this.sync(); if (scope === this.scope && client === this.client) await this.show(result);}
    finally {this.busy = false; this.changed();}
  }
  /** Whether the last observed answer review holds a proposal to accept; undefined when none was observed. */
  get waiting(): boolean | undefined {this.sync(); return this.observation ? !!this.observation.proposal : undefined;}
  rows(): MediaTreeRow[] {
    this.sync(); const children: MediaTreeRow[] = [{label: 'Observe answer review…', command: {command: 'readymade.reviewAnswer', title: 'Review answer'}}];
    if (this.observation) children.push(this.observation.proposal ?
      {label: 'Accept answer as owner…', command: {command: 'readymade.acceptAnswer', title: 'Accept answer'}} :
      {label: this.observation.reason || 'No ready answer proposal'});
    try {
      if (this.client && this.project()) for (const e of this.entries()) children.push({label: e.receipt ? 'Recorded answer decision' : e.refusal ? 'Answer decision refused before dispatch' : 'Observe pending answer decision',
        description: e.intent.context.session, command: {command: 'readymade.recoverAnswer', title: 'Observe exact decision', arguments: [e.intent.attempt]}});
    } catch (error) {children.push({label: 'Answer decision journal unavailable', tooltip: error instanceof Error ? error.message : 'Journal could not be read'});}
    return [{id: 'answer-review', label: 'Answer Review', icon: 'check', children}];
  }
  dispose(): void {this.client = undefined; this.observation = undefined; this.scope = ''; this.provider.dispose(); this.changedDocument.dispose();}
}
