import * as vscode from 'vscode';
import { observeChecks, type CheckObservation, type CheckReport } from './check-store';
import type { ShipClient } from './ship-client';
import type { MediaTreeRow } from './media-workbench';
import { digest, sameBasis } from './source-store';
import { CheckDocumentJournal } from './check-document-journal';
import {checkLocations, checkProblemReport, exactProblemSource, type CheckProblemReport, type CheckProblemLocation} from './check-problems';
import type {SourceSnapshot} from './source-store';

/** Read-only native check evidence, separate from accepting or deploying a proposal. */
export class CheckView implements vscode.Disposable {
  private client?: ShipClient;
  private observation?: CheckObservation;
  private busy = false;
  private scope?: string;
  private readonly documents = new Map<string, string>();
  private readonly provider: vscode.Disposable;
  private readonly closed: vscode.Disposable;
  private readonly problems = vscode.languages.createDiagnosticCollection('Readymade native checks');
  private readonly locations = new Map<string, {report: CheckProblemReport; location: CheckProblemLocation; diagnostic: vscode.Diagnostic; text?: string}>();
  private readonly sourceProvider: vscode.Disposable;
  private disposed = false;
  private archiveError?: string;
  constructor(private readonly project: () => string | undefined, private readonly changed: () => void,
    private readonly journal?: CheckDocumentJournal,
    private readonly source?: (report: CheckProblemReport, path: string) => Promise<SourceSnapshot | undefined>) {
    this.sourceProvider = vscode.workspace.registerTextDocumentContentProvider('readymade-check-source', {provideTextDocumentContent: async uri => {
      const held = this.locations.get(uri.toString());
      if (!held) throw vscode.FileSystemError.FileNotFound(uri);
      if (held.text !== undefined) return held.text;
      try {
        const snapshot = await this.source?.(held.report, held.location.path);
        if (this.disposed) throw new Error('Check view closed while loading source.');
        if (!snapshot) throw new Error('Exact source is unavailable offline or in this project. Open the saved report for its retained details.');
        exactProblemSource(held.report, held.location, snapshot); held.text = snapshot.text; return held.text;
      } catch (error) {
        if (!this.disposed) {
          if (!held.diagnostic.message.startsWith('Source unavailable:')) held.diagnostic.message = 'Source unavailable: ' + (error instanceof Error ? error.message.slice(0, 512) : 'Read failed') + '\n' + held.diagnostic.message;
          this.problems.set(uri, [held.diagnostic]);
        }
        throw error;
      }
    }});
    this.provider = vscode.workspace.registerTextDocumentContentProvider('readymade-checks', {
      provideTextDocumentContent: uri => {
        const match = /^readymade-checks:\/([a-f0-9]{64})\/check-(0|[1-9][0-9]*)\.json$/.exec(uri.toString());
        if (!match || uri.authority || uri.query || uri.fragment) throw vscode.FileSystemError.FileNotFound(uri);
        const document = this.documents.get(uri.toString()) ?? this.journal?.read(match[1]);
        if (document === undefined) throw vscode.FileSystemError.FileNotFound(uri);
        if (String(JSON.parse(document).sequence) !== match[2]) throw vscode.FileSystemError.FileNotFound(uri);
        return document;
      }
    });
    this.closed = vscode.workspace.onDidCloseTextDocument(document => this.documents.delete(document.uri.toString()));
    try {for (const saved of this.journal?.recent() ?? []) this.publishProblems(saved.text);}
    catch {this.archiveError = 'Saved Problems unavailable — check report storage is invalid.';}
  }
  private publishProblems(text: string): void {
    const report = checkProblemReport(text), raw = JSON.parse(text), key = digest(text);
    const reportUri = vscode.Uri.parse(`readymade-checks:/${key}/check-${raw.sequence}.json`), unlocated: vscode.Diagnostic[] = [];
    for (const [index, value] of report.values.entries()) {
      if (value.passed) continue;
      const spots = checkLocations(value.detail);
      if (!spots.length) {
        const at = text.indexOf(JSON.stringify(value.detail));
        const line = at < 0 ? 0 : text.slice(0, at).split('\n').length - 1;
        unlocated.push(new vscode.Diagnostic(new vscode.Range(line, 0, line, 0), `${value.name}: ${value.detail}\nNo usable source location; this entry opens the retained report.`, vscode.DiagnosticSeverity.Error));
      }
      for (const [spot, location] of spots.entries()) {
        const uri = vscode.Uri.parse(`readymade-check-source:/${key}/${index}/${spot}${location.path}`);
        if (!this.locations.has(uri.toString()) && this.locations.size >= 512) break;
        const diagnostic = new vscode.Diagnostic(new vscode.Range(location.line - 1, location.column - 1, location.endLine - 1, location.endColumn - 1),
          `${value.name}: ${value.detail}\nSaved revision ${report.source.number}; exact source is loaded only when opened.`, vscode.DiagnosticSeverity.Error);
        diagnostic.source = `Readymade · ${report.project} · ${report.owner}`;
        diagnostic.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(reportUri, new vscode.Position(0, 0)), 'Immutable native check report')];
        if (!this.locations.has(uri.toString())) this.locations.set(uri.toString(), {report, location, diagnostic});
        this.problems.set(uri, [this.locations.get(uri.toString())!.diagnostic]);
      }
    }
    this.problems.set(reportUri, unlocated);
  }
  connect(client: ShipClient): void { this.client = client; this.observation = undefined; this.scope = undefined; this.sync(); }
  private sync(): void {
    const scope = JSON.stringify([this.client?.origin, this.client?.snapshot?.owner, this.project()]);
    if (scope === this.scope) return;
    this.scope = scope; this.observation = undefined;
  }
  async observe(session?: string): Promise<void> {
    this.sync();
    if (this.busy) throw new Error('Check observation is already in progress.');
    const client = this.client, project = this.project();
    if (!client || !project) throw new Error('Connect and select a project first.');
    this.busy = true;
    try {
      const state = await client.codingState();
      const choices = state.sessions.filter(s => s.project === project);
      const selected = session ?? (await vscode.window.showQuickPick(choices.map(s => ({label: String(s.id), description: String(s.phase ?? '')})), {title: 'Observe checks for a coding session'}))?.label;
      if (!selected) return;
      if (!choices.some(s => s.id === selected)) throw new Error('Session is outside the selected project.');
      const observation = await observeChecks(client, selected, project);
      if (client !== this.client || project !== this.project()) throw new Error('Selected project changed during observation.');
      this.observation = observation;
      this.changed();
    } catch (error) {
      this.observation = undefined; this.changed(); throw error;
    } finally { this.busy = false; }
  }
  rows(): MediaTreeRow[] {
    this.sync(); const observation = this.observation;
    const children: MediaTreeRow[] = [{label: 'Observe retained checks…', command: {command: 'readymade.checks', title: 'Observe checks'}}];
    children.push({label: 'Open Problems', command: {command: 'workbench.actions.view.problems', title: 'Open Problems'}});
    if (this.archiveError) children.push({label: this.archiveError});
    if (observation) {
      if (!observation.reports.length) children.push({label: 'No retained diagnostics in this session'});
      for (const report of observation.reports) {
        const failures = report.values.filter(v => !v.passed).length;
        children.push({label: `Record ${report.sequence} · ${failures ? `${failures} failed` : `${report.values.length} passed`}`,
          icon: failures ? 'error' : 'pass', description: sameBasis(report.source, observation.source) ? 'observed session source' : 'historical source',
          tooltip: `Session ${report.session}\nRequest ${report.request}\nRecorded configuration ${report.configuration}`,
          command: {command: 'readymade.showCheck', title: 'Inspect check evidence', arguments: [report.key]}});
      }
    }
    return [{id: 'checks', label: 'Checks', icon: 'checklist', description: observation ? `${observation.reports.length} reports` : 'not observed', children}];
  }
  async show(key: string): Promise<void> {
    this.sync(); const observation = this.observation, report: CheckReport | undefined = observation?.reports.find(r => r.key === key);
    if (!observation || !report) throw new Error('Check is not available in the selected project. Observe its session again.');
    const document = JSON.stringify({notice: 'Snapshot of native retained diagnostics when opened. This document does not refresh. It is not an acceptance or deployment receipt. Only exact native compiler spots are linked to source.',
      origin: observation.origin, owner: observation.owner, sourceStatus: sameBasis(report.source, observation.source) ? 'Matches observed session source' : 'Historical source',
      configurationStatus: 'Recorded configuration; current configuration is not established by this observation.', ...report}, null, 2);
    const uri = vscode.Uri.parse(`readymade-checks:/${digest(document)}/check-${report.sequence}.json`);
    this.journal?.retain(document);
    this.documents.set(uri.toString(), document);
    this.publishProblems(document);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {preview: false});
  }
  async openSaved(): Promise<void> {
    const choices = (this.journal?.recent() ?? []).map(({key, text}) => {
      const row = JSON.parse(text);
      if (!row || typeof row.project !== 'string' || typeof row.owner !== 'string' || typeof row.origin !== 'string' ||
          !Number.isSafeInteger(row.sequence) || row.sequence < 0) throw new Error('Invalid saved check report.');
      return {label: `${row.project} · Record ${row.sequence}`, description: `${row.owner} · ${row.origin}`,
        detail: 'Saved snapshot; not current ship state', uri: vscode.Uri.parse(`readymade-checks:/${key}/check-${row.sequence}.json`)};
    });
    if (!choices.length) { await vscode.window.showInformationMessage('No saved check reports. Open a native check report to retain it.'); return; }
    const selected = await vscode.window.showQuickPick(choices, {title: 'Open Saved Check Report — latest 64 snapshots', matchOnDescription: true});
    if (selected) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(selected.uri), {preview: false});
  }
  dispose(): void { this.disposed = true; this.provider.dispose(); this.sourceProvider.dispose(); this.problems.dispose(); this.closed.dispose(); this.documents.clear(); this.locations.clear(); }
}
