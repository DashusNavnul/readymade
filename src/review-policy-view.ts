import * as vscode from 'vscode';
import type { ShipClient } from './ship-client';
import type { MediaTreeRow } from './media-workbench';
import { reviewPolicy, type ReviewPolicy } from './review-policy';
import { ReviewPolicyJournal } from './review-policy-journal';

export class ReviewPolicyView implements vscode.Disposable {
  private client?: ShipClient;
  private held?: {owner: string; project: string; session: string; policy: ReviewPolicy};
  private context = '';
  private busy = false;
  private text = 'Observe a session to configure its project reviewer.';
  private readonly uri = vscode.Uri.parse('readymade-review-policy:/policy.json');
  private readonly event = new vscode.EventEmitter<vscode.Uri>();
  private readonly registration: vscode.Disposable;
  constructor(private readonly project: () => string | undefined, private readonly changed: () => void,
    private readonly journal: ReviewPolicyJournal, private readonly confirm: (detail: string) => Thenable<boolean> = async detail =>
      (await vscode.window.showWarningMessage('Change project review policy?', {modal: true, detail}, 'Confirm')) === 'Confirm') {
    this.registration = vscode.workspace.registerTextDocumentContentProvider('readymade-review-policy', {
      onDidChange: this.event.event, provideTextDocumentContent: uri => {
        if (uri.toString() !== this.uri.toString()) throw vscode.FileSystemError.FileNotFound(uri);
        return this.text;
      }
    });
  }
  connect(client: ShipClient): void {this.client = client; this.context = ''; this.sync();}
  private sync(): void {
    const key = JSON.stringify([this.client?.origin, this.client?.snapshot?.owner, this.project()]);
    if (key === this.context) return;
    this.context = key; this.held = undefined; this.text = 'Observe the selected project review policy.'; this.event.fire(this.uri);
  }
  private entries() {return this.client && this.project() ? this.journal.entries().filter(i =>
    i.origin === this.client?.origin && i.owner === this.client?.snapshot?.owner && i.project === this.project()) : [];}
  rows(): MediaTreeRow[] {
    this.sync();
    const children: MediaTreeRow[] = [{label: 'Observe project reviewer…', command: {command: 'readymade.reviewPolicy', title: 'Observe reviewer'}}];
    let entries: ReturnType<ReviewPolicyView['entries']>;
    try {entries = this.entries();} catch {return [{label: 'Reviewer journal unavailable'}];}
    if (this.held) {
      const {scope, providers, possiblyTruncated} = this.held.policy;
      children.push({label: scope?.enabled ? 'Review enabled' : 'Review disabled', description: scope?.model});
      if (possiblyTruncated) children.push({label: 'Only the first 64 reviewers are listed'});
      if (!entries.some(i => i.change.previous === (scope?.generation ?? '0'))) {
        if (providers.length) children.push({label: 'Choose reviewer and enable…', command: {command: 'readymade.configureReviewer', title: 'Choose reviewer'}});
        if (scope?.enabled) children.push({label: 'Disable review…', command: {command: 'readymade.disableReviewer', title: 'Disable review'}});
      }
    }
    for (const i of entries) children.push({label: 'Observe retained policy change', description: `Generation ${i.change.previous}`,
      command: {command: 'readymade.recoverReviewer', title: 'Observe retained policy', arguments: [i.change.previous]}});
    return [{id: 'review-policy', label: 'Project Reviewer', icon: 'settings-gear', children}];
  }
  async observe(session?: string): Promise<void> {
    this.sync(); const client = this.client, project = this.project(), context = this.context;
    if (!client || !project || this.busy) throw new Error('Connect, select a project and wait for the current operation.');
    this.busy = true;
    try {
      const state = await client.codingState(), choices = state.sessions.filter(s => s.project === project);
      const selected = session ?? (await vscode.window.showQuickPick(choices.map(s => ({label: String(s.id)})), {title: 'Project reviewer session'}))?.label;
      if (!selected) return;
      if (!choices.some(s => s.id === selected)) throw new Error('Session is outside the selected project.');
      const fresh = await client.codingState(selected), policy = reviewPolicy(fresh, selected, project);
      this.sync(); if (client !== this.client || context !== this.context) throw new Error('Project changed during observation.');
      this.held = {owner: fresh.owner, project, session: selected, policy};
      await this.show(this.held);
    } finally {this.busy = false; this.changed();}
  }
  async configure(disable = false, key?: string): Promise<void> {
    this.sync(); const client = this.client, held = this.held, context = this.context;
    if (!client || !held || this.busy) throw new Error('Observe the project reviewer first.');
    this.busy = true;
    try {
      const previous = held.policy.scope?.generation ?? '0';
      if (this.entries().some(i => i.change.previous === previous)) throw new Error('Observe the retained policy change; it will not be submitted again.');
      const providers = held.policy.providers.filter(p => !['unknown', 'model-unreported'].includes(p.model));
      const selected = disable ? undefined : key ?? (await vscode.window.showQuickPick(providers.map(p =>
        ({label: p.key, description: `${p.provider} · ${p.model}`})), {title: 'Choose native reviewer'}))?.label;
      if (!disable && !selected) return;
      const provider = disable ? undefined : providers.find(p => p.key === selected);
      if (!disable && !provider || disable && !held.policy.scope?.enabled) throw new Error('Reviewer selection is unavailable.');
      const detail = disable ? `Project ${held.project}\nDisable review for future starts. This does not cancel an existing review.` :
        `Project ${held.project}\nReviewer ${provider!.key}\n${provider!.provider} · ${provider!.model}\n\nEnable native review until you disable it. A passing native decision can apply code changes. This does not deploy an application.`;
      if (!await this.confirm(detail)) return;
      this.sync(); if (client !== this.client || context !== this.context || held !== this.held) throw new Error('Project changed. Observe the reviewer again.');
      const result = await this.journal.configure(client, {version: 1, origin: client.origin, owner: held.owner, project: held.project,
        session: held.session, change: {previous, ...(provider ? {provider} : {})}}, true);
      this.sync(); if (client !== this.client || context !== this.context) throw new Error('Project changed during submission.');
      this.held = {...held, policy: result.observed}; await this.show(result);
    } finally {this.busy = false; this.changed();}
  }
  async recover(previous: string): Promise<void> {
    this.sync(); const client = this.client, context = this.context, entries = this.entries().filter(i => i.change.previous === previous);
    if (!client || this.busy || entries.length !== 1) throw new Error('Select a retained policy change.');
    this.busy = true;
    try {
      const result = await this.journal.recover(client, entries[0]);
      this.sync(); if (client !== this.client || context !== this.context) throw new Error('Project changed during observation.');
      this.held = {owner: entries[0].owner, project: entries[0].project, session: entries[0].session, policy: result.observed};
      await this.show(result);
    } finally {this.busy = false; this.changed();}
  }
  private async show(value: unknown): Promise<void> {
    this.text = JSON.stringify(value, null, 2); this.event.fire(this.uri);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(this.uri), {preview: false});
  }
  dispose(): void {this.client = undefined; this.held = undefined; this.context = ''; this.registration.dispose(); this.event.dispose();}
}
