import * as vscode from 'vscode';
import {randomBytes} from 'node:crypto';
import {REPORT_ACTION, reportHtml, unreadable, type Report} from './report';

/**
 * One webview that shows a report and passes button presses back. `load` reads the ship once per press of
 * "Read again"; `act` runs one action and returns a sentence to show, and the report is then read again.
 * A read that is overtaken by a newer one, or by the panel closing, is dropped.
 */
export class ReportPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private events: vscode.Disposable[] = [];
  private epoch = 0;
  private busy = false;
  private closed = false;
  private last?: Report;
  constructor(private readonly viewType: string, private readonly title: string, private readonly load: () => Promise<Report>,
    private readonly act?: (id: string) => Promise<string | void>) {}
  get shown(): Report | undefined {return this.last;}
  async show(): Promise<void> {
    if (this.closed) return;
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel(this.viewType, this.title, vscode.ViewColumn.Active, {enableScripts: true, enableCommandUris: false, localResourceRoots: [], retainContextWhenHidden: true});
      this.panel = panel;
      this.events = [panel.onDidDispose(() => {if (this.panel === panel) {this.epoch++; this.panel = undefined; this.busy = false; this.events.splice(0).forEach(e => e.dispose());}}),
        panel.webview.onDidReceiveMessage((message: unknown) => {void this.receive(panel, message);})];
    } else this.panel.reveal();
    await this.refresh();
  }
  async refresh(note?: string): Promise<void> {
    const panel = this.panel; if (!panel || this.closed) return;
    const epoch = ++this.epoch; this.busy = true; this.render();
    let report: Report;
    try {report = await this.load();} catch (error) {report = unreadable(this.title, error instanceof Error ? error.message.slice(0, 300) : 'The ship could not be read.');}
    if (this.closed || this.panel !== panel || this.epoch !== epoch) return;
    this.last = note ? {...report, note: report.note ? `${note}\n${report.note}` : note} : report; this.busy = false; this.render();
  }
  private async receive(panel: vscode.WebviewPanel, message: unknown): Promise<void> {
    if (this.closed || panel !== this.panel || this.busy || !message || typeof message !== 'object' || Array.isArray(message)) return;
    const row = message as Record<string, unknown>;
    if (Object.keys(row).length !== 1 || typeof row.action !== 'string' || !REPORT_ACTION.test(row.action)) return;
    if (row.action === 'again' || !this.act) {await this.refresh(); return;}
    this.busy = true; this.render();
    let said: string | void;
    try {said = await this.act(row.action);} catch (error) {said = error instanceof Error ? error.message.slice(0, 300) : 'That did not finish; nothing was sent again.';}
    if (this.closed || this.panel !== panel) return;
    this.busy = false; await this.refresh(said || undefined);
  }
  private render(): void {
    if (!this.panel) return;
    this.panel.webview.html = reportHtml(this.last ?? {title: this.title, status: 'Reading the ship…', sections: []}, randomBytes(24).toString('base64'), this.busy);
  }
  dispose(): void {this.closed = true; this.epoch++; this.panel?.dispose(); this.events.splice(0).forEach(e => e.dispose()); this.panel = undefined;}
}
