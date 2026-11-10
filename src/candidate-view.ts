import * as vscode from 'vscode';
import { observeCandidates } from './candidate-store';
import { CandidateJournal, CandidateDecisionJournal } from './candidate-journal';
import { join } from 'node:path';
import { digest } from './source-store';
import { isUx } from './protocol';
import type { ShipClient } from './ship-client';
import type { MediaTreeRow } from './media-workbench';
import type { CheckDocumentJournal } from './check-document-journal';

/** Inspect native code review separately from local draft diffs and answer completion. */
export class CandidateView implements vscode.Disposable {
  private client?: ShipClient;
  private held?: Awaited<ReturnType<typeof observeCandidates>>;
  private scope = '';
  private busy = false;
  private readonly documents = new Map<string, string>();
  private readonly provider: vscode.Disposable;
  private readonly closed: vscode.Disposable;
  private readonly decisions: CandidateDecisionJournal;
  constructor(private readonly project: () => string | undefined, private readonly changed: () => void, private readonly journal: CandidateJournal,
    private readonly confirm: (detail: string) => Thenable<boolean> = async detail =>
      (await vscode.window.showWarningMessage('Start governed code review?', {modal: true, detail}, 'Start review')) === 'Start review',
    private readonly archive?: Pick<CheckDocumentJournal, 'read' | 'retain' | 'recent'>,
    private readonly confirmApply: (detail: string) => Thenable<boolean> = async detail =>
      (await vscode.window.showWarningMessage('Apply reviewed change?', {modal: true, detail}, 'Apply change')) === 'Apply change') {
    this.decisions = new CandidateDecisionJournal(join(journal.directory, 'apply'));
    this.provider = vscode.workspace.registerTextDocumentContentProvider('readymade-candidate', {
      provideTextDocumentContent: uri => {
        const match = /^readymade-candidate:\/([a-f0-9]{64})\/(candidate|recovery)\.json$/.exec(uri.toString());
        if (!match || uri.authority || uri.query || uri.fragment) throw vscode.FileSystemError.FileNotFound(uri);
        const text = this.documents.get(uri.toString()) ?? this.archive?.read(match[1]);
        if (text === undefined) throw vscode.FileSystemError.FileNotFound(uri);
        if (JSON.parse(text).snapshotKind !== match[2]) throw vscode.FileSystemError.FileNotFound(uri);
        return text;
      }
    });
    this.closed = vscode.workspace.onDidCloseTextDocument(document => this.documents.delete(document.uri.toString()));
  }
  connect(client: ShipClient): void {this.client = client; this.scope = ''; this.sync();}
  private sync(): void {
    const scope = JSON.stringify([this.client?.origin, this.client?.snapshot?.owner, this.project()]);
    if (scope === this.scope) return;
    this.scope = scope; this.held = undefined;
  }
  async observe(session?: string): Promise<void> {
    this.sync(); const client = this.client, project = this.project(), scope = this.scope;
    if (!client || !project || this.busy) throw new Error('Connect, select a project and wait for the current observation.');
    this.busy = true;
    try {
      const state = await client.codingState(), choices = state.sessions.filter(s => s.project === project);
      const selected = session ?? (await vscode.window.showQuickPick(choices.map(s => ({label: String(s.id)})), {title: 'Inspect code candidates'}))?.label;
      if (!selected) return;
      if (!choices.some(s => s.id === selected)) throw new Error('Session is outside the selected project.');
      const result = await observeCandidates(client, selected, project);
      this.sync(); if (client !== this.client || scope !== this.scope) throw new Error('Project changed during candidate observation.');
      this.held = result;
    } catch (error) {this.held = undefined; throw error;}
    finally {this.busy = false; this.changed();}
  }
  rows(): MediaTreeRow[] {
    this.sync();
    const children: MediaTreeRow[] = [{label: 'Observe code candidates…', command: {command: 'readymade.reviewCode', title: 'Observe code candidates'}}];
    let retained: ReturnType<CandidateView['entries']> | undefined;
    try {retained = this.entries();} catch {children.push({label: 'Review start journal unavailable'});}
    let applications: ReturnType<CandidateView['applyEntries']> | undefined;
    try {applications = this.applyEntries();} catch {children.push({label: 'Apply journal unavailable'});}
    if (this.held) {
      const review = this.held.review;
      children.push({label: !review?.available ? 'Native review process unavailable' : !review.scope ? 'Review scope not configured' :
        review.scope.enabled ? 'Review scope enabled' : 'Review scope disabled', description: review?.scope?.model});
      if (review?.scope?.enabled && !review.scope.binding) children.push({label: 'Update backend to start policy-bound review'});
      if (!this.held.candidates.length) children.push({label: 'No candidates in this native summary'});
      if (this.held.possiblyTruncated) children.push({label: 'Only the first eight candidates are available'});
      for (const c of this.held.candidates) {
        const campaign = review?.campaigns.find(r => r.candidate === c.id);
        const status = campaign ? campaign.reason || (campaign.pending ? `Waiting for ${campaign.mode}` : campaign.outcome ? `Review: ${campaign.outcome}` : campaign.mode) : c.decision;
        children.push({label: `${c.edits.length} file changes · ${c.stage}`, description: status,
          tooltip: `Candidate ${c.id}\n${c.basis.desk} revision ${c.basis.number}`, command: {command: 'readymade.showCandidate', title: 'Inspect candidate', arguments: [c.id]}});
        if (retained && !retained.some(i => i.session === this.held?.session && i.candidate.id === c.id) &&
            review?.available && review.scope?.enabled && review.scope.binding && !campaign && c.stage === 'review' && c.decision === 'pending')
          children.push({label: 'Start governed review…', description: c.id, command: {command: 'readymade.startCodeReview', title: 'Start review', arguments: [c.id]}});
        if (c.stage === 'review' && c.decision === 'approve' && this.client?.snapshot?.candidateDecide !== true)
          children.push({label: 'Update backend to apply this reviewed change'});
        if (applications && this.client?.snapshot?.candidateDecide === true && c.stage === 'review' && c.decision === 'approve' && !c.landed &&
            !applications.some(i => i.session === this.held?.session && i.candidate.id === c.id))
          children.push({label: 'Apply reviewed change…', description: c.id, command: {command: 'readymade.applyCandidate', title: 'Apply reviewed change', arguments: [c.id]}});
      }
    }
    for (const i of retained ?? []) children.push({label: 'Observe retained review start', description: i.candidate.id,
        command: {command: 'readymade.recoverCodeReview', title: 'Observe review start', arguments: [i.session, i.candidate.id]}});
    for (const i of applications ?? []) children.push({label: 'Check applied change', description: i.candidate.id,
      command: {command: 'readymade.checkAppliedCandidate', title: 'Check applied change', arguments: [i.session, i.candidate.id]}});
    return [{id: 'code-review', label: 'Code Review', icon: 'git-pull-request', children}];
  }
  private entries() {
    if (!this.client || !this.project()) return [];
    return this.journal.entries().filter(i => i.origin === this.client?.origin && i.owner === this.client?.snapshot?.owner && i.project === this.project());
  }
  private applyEntries() {
    if (!this.client || !this.project()) return [];
    return this.decisions.entries().filter(i => i.origin === this.client?.origin && i.owner === this.client?.snapshot?.owner && i.project === this.project());
  }
  async apply(id: string): Promise<void> {
    this.sync(); const held = this.held, client = this.client, scope = this.scope, candidate = held?.candidates.find(c => c.id === id);
    if (!client || !held || !candidate || this.busy || candidate.stage !== 'review' || candidate.decision !== 'approve' || candidate.landed) throw new Error('Observe a natively approved change first.');
    if (this.applyEntries().some(i => i.session === held.session && i.candidate.id === id)) throw new Error('Check the retained apply request; it will not be sent again.');
    this.busy = true;
    try {
      await this.show(id);
      if (!await this.confirmApply(`Project ${held.project}\n${candidate.edits.length} changed files\n${candidate.basis.desk} revision ${candidate.basis.number}\n\nApply the reviewed source to the working project. Urbit rechecks the original permission, review, checks and current revision. Running applications are deployed separately.`)) return;
      this.sync(); if (scope !== this.scope || client !== this.client || held !== this.held) throw new Error('Project changed. Review the change again.');
      const result = await this.decisions.apply(client, {version: 1, origin: client.origin, owner: held.owner, project: held.project, session: held.session, candidate}, true,
        () => {this.sync(); return scope === this.scope && client === this.client && held === this.held;});
      this.sync(); if (scope === this.scope && client === this.client) await this.display('recovery', result);
    } finally {this.busy = false; this.changed();}
  }
  async checkApplied(session: string, id: string): Promise<void> {
    this.sync(); const client = this.client, scope = this.scope, entries = this.applyEntries().filter(i => i.session === session && i.candidate.id === id);
    if (!client || this.busy || entries.length !== 1) throw new Error('Select one retained apply request.');
    this.busy = true;
    try {
      const result = await this.decisions.recover(client, entries[0]);
      this.sync(); if (scope !== this.scope || client !== this.client) throw new Error('Project changed during observation.');
      await this.display('recovery', result);
    } finally {this.busy = false; this.changed();}
  }
  async start(id: string): Promise<void> {
    this.sync(); const held = this.held, client = this.client, scope = this.scope, candidate = held?.candidates.find(c => c.id === id);
    if (!client || !held?.review?.scope?.enabled || !candidate || this.busy) throw new Error('Observe a candidate with an enabled native review scope first.');
    if (!held.review.scope.binding) throw new Error('Update the backend to support exact review policy binding.');
    if (this.entries().some(i => i.session === held.session && i.candidate.id === id)) throw new Error('Observe the retained review start; it will not be submitted again.');
    this.busy = true;
    try {
      await this.show(id);
      if (!await this.confirm(`Project ${held.project}\nCandidate ${id}\n${candidate.edits.length} changed files\nReviewer ${held.review.scope.model}\n\nUrbit runs challenge and resolution. A passing native decision can apply these changes. This does not deploy an application.`)) return;
      this.sync(); if (scope !== this.scope || client !== this.client || held !== this.held) throw new Error('Project changed. Review the candidate again.');
      await this.journal.start(client, {version: 1, origin: client.origin, owner: held.owner, project: held.project, session: held.session,
        candidate, scope: held.review.scope}, true);
      const result = await observeCandidates(client, held.session, held.project);
      this.sync(); if (scope === this.scope && client === this.client) {this.held = result; await this.show(id);}
    } finally {this.busy = false; this.changed();}
  }
  async recover(session: string, id: string): Promise<void> {
    this.sync(); const client = this.client, scope = this.scope, entries = this.entries().filter(i => i.session === session && i.candidate.id === id);
    if (!client || this.busy || entries.length !== 1) throw new Error('Select one retained review start.');
    this.busy = true;
    try {
      const result = await this.journal.recover(client, entries[0]);
      this.sync(); if (scope !== this.scope || client !== this.client) throw new Error('Project changed during review observation.');
      await this.display('recovery', {snapshotNotice: 'Snapshot of review observation when opened. This document does not refresh or authorize another submission.', ...result});
    } finally {this.busy = false; this.changed();}
  }
  async show(id: string): Promise<void> {
    this.sync(); const c = this.held?.candidates.find(c => c.id === id);
    if (!c || !this.held) throw new Error('Observe this candidate in the selected project first.');
    await this.display('candidate', {notice: 'Snapshot of native candidate summary when opened. This document does not refresh. Check details are clipped to 512 bytes; at most eight checks are shown. This view does not accept or deploy changes.',
      origin: this.client?.origin, owner: this.held.owner, project: this.held.project, ...c,
      reviewProcess: {available: this.held.review?.available ?? false, scope: this.held.review?.scope ?? null,
        campaign: this.held.review?.campaigns.find(r => r.candidate === id) ?? null,
        notice: 'Review acceptance and landed source are separate evidence. Only landed identifies applied source.'}});
  }
  private async display(kind: 'candidate' | 'recovery', value: unknown): Promise<void> {
    const text = JSON.stringify({...value as Record<string, unknown>, snapshotKind: kind}, null, 2), uri = vscode.Uri.parse(`readymade-candidate:/${digest(text)}/${kind}.json`);
    this.archive?.retain(text);
    this.documents.set(uri.toString(), text);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {preview: false});
  }
  async openSaved(): Promise<void> {
    const choices = (this.archive?.recent() ?? []).map(({key, text}) => {
      const row = JSON.parse(text), kind = row?.snapshotKind;
      const context = kind === 'candidate' ? row : kind === 'recovery' ? row.intent : undefined;
      const id = kind === 'candidate' ? row.id : context?.candidate?.id;
      if (!context || !['project', 'owner', 'origin'].every(k => typeof context[k] === 'string' && context[k].length > 0) ||
          !isUx(id) || id === '0x0') throw new Error('Invalid saved candidate snapshot.');
      return {label: `${context.project} · ${id}`, description: `${context.owner} · ${context.origin}`,
        detail: `Saved ${kind === 'candidate' ? 'proposal' : 'review observation'}; not current ship state`,
        uri: vscode.Uri.parse(`readymade-candidate:/${key}/${kind}.json`)};
    });
    if (!choices.length) {await vscode.window.showInformationMessage('No saved candidate reviews. Open a candidate or review observation to retain it.'); return;}
    const selected = await vscode.window.showQuickPick(choices, {title: 'Open Saved Candidate Review — latest 64 snapshots', matchOnDescription: true});
    if (selected) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(selected.uri), {preview: false});
  }
  dispose(): void {this.client = undefined; this.held = undefined; this.scope = ''; this.provider.dispose(); this.closed.dispose(); this.documents.clear();}
}
