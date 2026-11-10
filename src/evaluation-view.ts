import * as vscode from 'vscode';
import type {ShipClient} from './ship-client';
import type {MediaTreeRow} from './media-workbench';
import type {SourceSnapshot} from './source-store';
import {EvaluationStore, type EvaluationRecord} from './evaluation-store';

/** Explicit bounded evaluation of saved ship source; never local draft text or model execution. */
export class EvaluationView implements vscode.Disposable {
  private busy = false;
  private closed = false;
  private notice = 'Open an immutable Hoon source, then Run Expression.';
  private readonly provider: vscode.Disposable;
  private readonly updates = new vscode.EventEmitter<vscode.Uri>();
  constructor(readonly store: EvaluationStore, private readonly current: () => ShipClient | undefined,
    private readonly project: () => string | undefined, private readonly selectedSource: () => SourceSnapshot | undefined,
    private readonly changed: () => void) {
    this.provider = vscode.workspace.registerTextDocumentContentProvider('readymade-evaluation', {onDidChange: this.updates.event, provideTextDocumentContent: uri => {
      const match = /^\/([a-f0-9]{64})\/result\.txt$/.exec(uri.path);
      if (uri.authority || uri.query || uri.fragment || !match) throw vscode.FileSystemError.FileNotFound(uri);
      return this.document(this.store.get(match[1]));
    }});
  }
  private document(row: EvaluationRecord): string {
    return [`Native evaluation · ${row.phase}`, `${row.snapshot.ship} · ${row.snapshot.origin}`, `${row.project} · ${row.snapshot.path}`,
      `Immutable source: ${row.snapshot.source.desk} revision ${row.snapshot.source.number}`, `Source ID: ${row.snapshot.source.id}`,
      `Expression: ${row.expression}`, '', row.output ?? (row.request ? 'Submitted. Observe this exact request for its native result.' : 'Delivery unknown. No request ID was received; this evaluation will not be resent.'),
      '', `Request: ${row.request ?? 'unconfirmed'}`, `Budget: ${row.fuel} microseconds`,
      ...(row.result ? ['', 'Retained native evidence:', JSON.stringify(row.result, null, 2)] : [])].join('\n');
  }
  async show(id: string): Promise<void> {
    const expected = this.document(this.store.get(id));
    const uri = vscode.Uri.from({scheme: 'readymade-evaluation', path: `/${id}/result.txt`});
    const document = await vscode.workspace.openTextDocument(uri);
    // openTextDocument can return a cached pending result, including after provider
    // replacement. Content-provider invalidation is asynchronous: await its actual text.
    if (document.getText() !== expected) await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {clearTimeout(timer); listener.dispose(); if (error) reject(error); else resolve();};
      const listener = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.toString() === uri.toString() && event.document.getText() === expected) finish();
      });
      const timer = setTimeout(() => finish(new Error('Native result is saved, but its editor did not refresh. Reopen Show Result.')), 5000);
      this.updates.fire(uri);
    });
    if (this.closed) throw new Error('Evaluation view closed.');
    await vscode.window.showTextDocument(document, {preview: false});
  }
  async run(supplied?: string): Promise<void> {
    if (this.closed || this.busy) throw new Error('Wait for the current evaluation.');
    const client = this.current(), project = this.project(), source = this.selectedSource();
    if (!client || !project || !source) throw new Error('Select an immutable Hoon source in the connected project. Draft edits must be applied first.');
    const active = () => !this.closed && this.current() === client && this.project() === project && this.selectedSource()?.uri === source.uri;
    const expression = supplied ?? await vscode.window.showInputBox({title: 'Run Hoon expression', prompt: `Evaluate against ${source.source.desk} revision ${source.source.number} · ${source.path}`, placeHolder: '(. [3 20])', ignoreFocusOut: true});
    if (expression === undefined) return;
    if (!active()) throw new Error('Selected source changed.');
    if (this.busy) throw new Error('Wait for the current evaluation.');
    this.busy = true; this.changed();
    try {
      const row = await this.store.run(client, source, project, expression, active);
      this.notice = row.phase === 'complete' ? 'Native result retained.' : 'Submitted once. Observe the retained result.';
      if (active()) await this.show(row.id);
    } catch (error) {this.notice = error instanceof Error ? error.message : 'Evaluation unavailable.'; throw error;}
    finally {this.busy = false; this.changed();}
  }
  async observe(id: string): Promise<void> {
    if (this.closed || this.busy) throw new Error('Wait for the current evaluation.');
    const client = this.current(), project = this.project(), row = this.store.get(id);
    if (!client || row.snapshot.origin !== client.origin || row.project !== project) throw new Error('Connect to this evaluation’s original project.');
    const active = () => !this.closed && this.current() === client && this.project() === project;
    this.busy = true; this.changed();
    try {const observed = await this.store.observe(client, id, active); this.notice = observed.phase === 'complete' ? 'Native result retained.' : 'Outcome remains unconfirmed; nothing was resent.'; if (active()) await this.show(id);}
    finally {this.busy = false; this.changed();}
  }
  rows(): MediaTreeRow[] {
    const client = this.current(), project = this.project(); let held: EvaluationRecord[] = [];
    try {held = this.store.list().filter(r => r.snapshot.origin === client?.origin && r.project === project && r.snapshot.ship === client.snapshot?.owner);}
    catch (error) {this.notice = `Saved evaluations unavailable: ${String(error).slice(0, 512)}`;}
    return [{id: 'evaluations', label: 'Run Expression', description: this.busy ? 'Working…' : this.notice, children: [
      {label: 'Run Expression on Selected Source…', command: {command: 'readymade.runExpression', title: 'Run Expression'}},
      ...held.map(row => ({label: `${row.snapshot.path} · ${row.phase}`, description: row.output?.slice(0, 100) ?? row.expression.slice(0, 100), children: [
        {label: 'Show Result', command: {command: 'readymade.showEvaluation', title: 'Show Result', arguments: [row.id]}},
        ...(row.phase !== 'complete' ? [{label: 'Observe Result', command: {command: 'readymade.observeEvaluation', title: 'Observe Result', arguments: [row.id]}}] : [])]}))]}];
  }
  dispose(): void {this.closed = true; this.provider.dispose(); this.updates.dispose();}
}
