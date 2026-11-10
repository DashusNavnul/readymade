import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { DraftStore, type DraftRecord } from './draft-store';
import { HistoricalDocuments } from './historical-documents';
import { originOf } from './source-store';

export interface DraftReviewContext {
  origin: string; ship: string; project?: string; sessions: ReadonlyMap<string, string>;
}
/** Restore presentation scope only; cached context never authorizes a ship operation. */
export function readDraftReviewContext(value: unknown): DraftReviewContext | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return;
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(key => !['origin', 'ship', 'project', 'sessions'].includes(key))) return;
    if (typeof row.origin !== 'string' || row.origin.length > 2048 || originOf(row.origin) !== row.origin ||
        typeof row.ship !== 'string' || !/^~(?:[a-z]{3}|[a-z]{6}(?:-[a-z]{6}){0,3}(?:--[a-z]{6}(?:-[a-z]{6}){3})?)$/.test(row.ship)) return;
    const project = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(id) && id !== '.' && id !== '..';
    if (row.project !== undefined && !project(row.project) || !Array.isArray(row.sessions) || row.sessions.length > 512) return;
    const sessions = new Map<string, string>();
    for (const entry of row.sessions) {
      if (!Array.isArray(entry) || entry.length !== 2) return;
      const [id, name] = entry;
      if (typeof id !== 'string' || id.length > 81 || !/^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(id) ||
          BigInt(id.replaceAll('.', '')) >= (1n << 256n) || !project(name) || sessions.has(id)) return;
      sessions.set(id, name);
    }
    return {origin: row.origin, ship: row.ship, ...(row.project === undefined ? {} : {project: row.project}), sessions};
  } catch { return; }
}
const scheme = 'readymade-review';
const phases = {
  issued: 'Intent retained; submission outcome unconfirmed',
  submitted: 'Submitted; candidate preparation unconfirmed',
  unknown: 'Outcome unknown; do not resubmit',
  candidate: 'Candidate prepared; not applied or deployed',
  refused: 'Native refusal; no applied change claimed',
};

/** Local comparison only. Original and submitted bytes come from the durable draft journal. */
export class DraftReviewView implements vscode.Disposable {
  readonly sourceControl = vscode.scm.createSourceControl('readymade-changes', 'Readymade Changes');
  readonly changes = this.sourceControl.createResourceGroup('changes', 'Changes');
  readonly submitted = this.sourceControl.createResourceGroup('submitted', 'Submitted');
  private readonly historical: HistoricalDocuments;
  private context?: DraftReviewContext;
  private closed = false;
  private readonly registrations: vscode.Disposable[];
  constructor(private readonly drafts: DraftStore) {
    this.historical = new HistoricalDocuments(scheme, uri => this.provideTextDocumentContent(uri), 128, 128 * 1024 * 1024);
    this.sourceControl.inputBox.visible = false;
    this.changes.hideWhenEmpty = false; this.submitted.hideWhenEmpty = false;
    this.registrations = [
      this.historical,
      vscode.workspace.onDidChangeTextDocument(event => { if (event.document.uri.scheme === 'readymade-draft') this.refresh(); }),
      vscode.workspace.onDidSaveTextDocument(document => { if (document.uri.scheme === 'readymade-draft') this.refresh(); }),
      vscode.workspace.onDidCloseTextDocument(document => { if (document.uri.scheme === 'readymade-draft') this.refresh(); }),
    ];
  }
  private visible(row: DraftRecord): boolean {
    const context = this.context;
    return !!context && row.snapshot.origin === context.origin && row.snapshot.ship === context.ship &&
      (context.project === undefined || context.sessions.get(row.snapshot.session) === context.project);
  }
  private row(id: string): DraftRecord {
    if (this.closed) throw new Error('Draft review is closed.');
    const row = this.drafts.get(id);
    if (!this.visible(row)) throw new Error('This draft does not belong to the current ship and project context.');
    return row;
  }
  private currentText(row: DraftRecord): string {
    return vscode.workspace.textDocuments.find(document => document.uri.toString() === row.uri && !document.isClosed)?.getText() ?? row.text;
  }
  private uri(row: DraftRecord, submitted: boolean): vscode.Uri {
    if (submitted && !row.pending) throw new Error('No submitted intent is retained for this draft.');
    const binding = submitted ? [row.id, 'submitted', row.pending!.nonce, row.pending!.text] : [row.id, 'original', row.snapshot.contentHash];
    const hash = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
    return vscode.Uri.from({scheme, path: `/${row.id}/${submitted ? 'submitted' : 'original'}/${hash}${row.snapshot.path}`});
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.scheme !== scheme || uri.authority || uri.query || uri.fragment) throw vscode.FileSystemError.FileNotFound(uri);
    const id = uri.path.split('/')[1];
    if (!/^[a-f0-9]{64}$/.test(id)) throw vscode.FileSystemError.FileNotFound(uri);
    let row: DraftRecord;
    try { row = this.row(id); } catch { throw vscode.FileSystemError.FileNotFound(uri); }
    if (uri.toString() === this.uri(row, false).toString()) return row.snapshot.text;
    if (row.pending && uri.toString() === this.uri(row, true).toString()) return row.pending.text;
    throw vscode.FileSystemError.FileNotFound(uri);
  }
  private resource(row: DraftRecord, submitted: boolean): vscode.SourceControlResourceState {
    const project = this.context!.sessions.get(row.snapshot.session) ?? 'Project association unknown';
    const pending = row.pending;
    const status = submitted ? phases[pending!.phase] : this.currentText(row) === row.text ? 'Saved local draft' : 'Unsaved local edits';
    return {
      resourceUri: submitted ? this.uri(row, true) : vscode.Uri.parse(row.uri),
      contextValue: submitted ? 'readymade.submittedChange' : 'readymade.draftChange',
      decorations: {tooltip: `${project} · ${row.snapshot.session}\n${status}\n${row.snapshot.path}`, iconPath: new vscode.ThemeIcon(submitted ? 'git-pull-request' : 'diff-modified')},
      command: {command: submitted ? 'readymade.reviewSubmitted' : 'readymade.reviewDraft', title: submitted ? 'Review submitted change' : 'Review local change', arguments: [row.id]},
    };
  }
  refresh(context?: DraftReviewContext): void {
    if (this.closed) return;
    if (context) {
      const next = {...context, origin: originOf(context.origin), sessions: new Map(context.sessions)}, prior = this.context;
      if (!prior || prior.origin !== next.origin || prior.ship !== next.ship || prior.project !== next.project ||
          prior.sessions.size !== next.sessions.size || [...next.sessions].some(([id, project]) => prior.sessions.get(id) !== project)) this.context = next;
    }
    const rows = this.drafts.list().filter(row => this.visible(row));
    this.changes.resourceStates = rows.filter(row => this.currentText(row) !== row.snapshot.text).map(row => this.resource(row, false));
    this.submitted.resourceStates = rows.filter(row => row.pending).map(row => this.resource(row, true));
    this.sourceControl.count = this.changes.resourceStates.length + this.submitted.resourceStates.length;
  }
  constrainOrigin(origin: string): void { if (this.context && this.context.origin !== origin) this.clearContext(); }
  clearContext(): void { this.context = undefined; this.refresh(); }
  async review(id?: string, submitted = false): Promise<void> {
    if (this.closed) throw new Error('Draft review is closed.');
    const context = this.context;
    const guard = (): void => { if (this.closed || !context || this.context !== context) throw Error('Draft review project or ship context changed.'); };
    guard();
    let selected = id;
    if (!selected) {
      const active = vscode.window.activeTextEditor?.document.uri;
      if (active?.scheme === 'readymade-draft') {
        const row = this.drafts.get(active.toString());
        if (this.visible(row) && (!submitted || row.pending)) selected = row.id;
      }
    }
    if (!selected) {
      const choices = this.drafts.list().filter(row => this.visible(row) && (!submitted || row.pending)).map(row => ({
        label: row.snapshot.path, description: this.context!.sessions.get(row.snapshot.session) ?? 'Project association unknown',
        detail: submitted ? phases[row.pending!.phase] : 'Original ship snapshot compared with current local buffer', id: row.id,
      }));
      if (!choices.length) { await vscode.window.showInformationMessage('No retained changes match this ship and project context.'); return; }
      selected = (await vscode.window.showQuickPick(choices, {title: submitted ? 'Review submitted change' : 'Review local draft'}))?.id;
    }
    guard();
    if (!selected) return;
    const row = this.row(selected), left = this.uri(row, false), right = submitted ? this.uri(row, true) : vscode.Uri.parse(row.uri);
    const label = submitted ? phases[row.pending!.phase] : 'Original ↔ local draft';
    const leftDoc = await this.historical.open(left, guard);
    const rightDoc = submitted ? await this.historical.open(right, guard) : undefined;
    this.historical.verify(leftDoc, guard); if (rightDoc) this.historical.verify(rightDoc, guard);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${row.snapshot.path} · ${label}`, {preview: false});
    this.historical.verify(leftDoc, guard); if (rightDoc) this.historical.verify(rightDoc, guard);
  }
  async reveal(): Promise<void> { await vscode.commands.executeCommand('workbench.view.scm'); }
  dispose(): void {
    if (this.closed) return; this.closed = true;
    this.registrations.forEach(item => item.dispose()); this.changes.dispose(); this.submitted.dispose(); this.sourceControl.dispose();
  }
}
