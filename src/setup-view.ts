import * as vscode from 'vscode';
import {randomBytes} from 'node:crypto';
import type {ShipClient} from './ship-client';
import {checkSetup, type SetupReport} from './setup-check';
type Action = 'landscape' | 'glurff' | 'noltbook' | 'groups' | 'lattice' | 'coding' | 'join' | 'guide' | 'newWindow';
const apps: [Action, string, string][] = [['landscape', 'Landscape', 'Landscape'], ['glurff', 'Glurff', 'Glurff'], ['noltbook', 'Noltbook', 'Calls'], ['groups', 'Groups', 'Groups'], ['lattice', 'Lattice', 'Lattice']];
const escape = (v: string) => v.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
function identity(client: ShipClient): string {
  const cookies = client.browserCookies(client.origin);
  if (cookies.length !== 1 || !/^urbauth-~[a-z-]{3,128}(?![\s\S])/.test(cookies[0]!.name)) throw Error('Ship identity is unavailable.');
  return cookies[0]!.name.slice('urbauth-'.length);
}
export class SetupView implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private events: vscode.Disposable[] = [];
  private client?: ShipClient;
  private report?: SetupReport;
  private ship = '';
  private checking = false;
  private busy = false;
  private closed = false;
  private epoch = 0;
  private error = '';
  constructor(private readonly connect: () => Promise<ShipClient | undefined>, private readonly open: (action: Action) => Promise<unknown>) {}
  get state(): {ship: string; origin?: string; checking: boolean; report?: SetupReport} {
    return {ship: this.ship, origin: this.client?.origin, checking: this.checking, report: this.report && structuredClone(this.report)};
  }
  async show(supplied?: ShipClient): Promise<void> {
    if (this.closed) return;
    supplied ??= this.client;
    if (supplied && supplied === this.client && this.panel && identity(supplied) === this.ship) {this.panel.reveal(); return;}
    const epoch = ++this.epoch, client = supplied ?? await this.connect();
    if (!client || this.closed || epoch !== this.epoch) return;
    const ship = identity(client);
    this.client = client; this.ship = ship; this.error = '';
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel('readymade.setup', 'Your Urbit', vscode.ViewColumn.Active, {enableScripts: true, enableCommandUris: false, localResourceRoots: [], retainContextWhenHidden: true});
      this.panel = panel;
      this.events = [panel.onDidDispose(() => {
        if (this.panel !== panel) return;
        this.epoch++; this.panel = undefined; this.client = undefined; this.report = undefined; this.checking = false;
        this.events.splice(0).forEach(event => event.dispose());
      }), panel.webview.onDidReceiveMessage((message: unknown) => {void this.receive(panel, message);})];
    } else this.panel.reveal();
    this.report = undefined; this.checking = true; this.render();
    void this.probe(client, this.panel, epoch);
  }
  private async probe(client: ShipClient, panel: vscode.WebviewPanel, epoch: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let accepting = true;
    const current = () => accepting && !this.closed && this.panel === panel && this.client === client && this.epoch === epoch;
    try {
      const report = await Promise.race([checkSetup(client, partial => {
        if (current()) {this.report = partial; this.render();}
      }), new Promise<never>((_resolve, reject) => {timer = setTimeout(() => reject(Error()), 30000);})]);
      if (!current()) return;
      this.report = report;
    } catch {if (this.panel === panel && this.client === client && this.epoch === epoch) this.error = 'Some apps could not be checked. Your sign-in has not been replaced.';}
    finally {accepting = false; clearTimeout(timer); if (!this.closed && this.panel === panel && this.client === client && this.epoch === epoch) {this.checking = false; this.render();}}
  }
  private coding(): boolean {return this.report?.owner === this.ship && this.report.checks.some(c => c.name === 'Native coding protocol' && c.status === 'observed') === true;}
  private joining(): boolean {return this.report?.checks.some(c => c.name === 'Project invitations' && c.status === 'observed') === true;}
  private async receive(panel: vscode.WebviewPanel, message: unknown): Promise<void> {
    if (this.closed || panel !== this.panel || this.busy || !message || typeof message !== 'object' || Array.isArray(message)) return;
    const row = message as Record<string, unknown>, action = row.action;
    if (Object.keys(row).length !== 1 || typeof action !== 'string' || ![...apps.map(app => app[0]), 'coding', 'join', 'guide', 'newWindow'].includes(action)) return;
    if (action === 'coding' && !this.coding()) return;
    if (action === 'join' && !this.joining()) return;
    const app = apps.find(app => app[0] === action);
    if (app && !this.report?.checks.some(c => c.name === app[2] && c.status === 'observed')) return;
    const client = this.client, epoch = this.epoch; this.busy = true; this.error = ''; this.render();
    try {if (!client || identity(client) !== this.ship) throw Error('Ship identity changed.'); await this.open(action as Action);}
    catch {if (this.panel === panel && this.epoch === epoch) this.error = 'Could not open that page. Your other work is unchanged.';}
    finally {this.busy = false; if (this.panel === panel && this.epoch === epoch) this.render();}
  }
  private render(): void {
    if (!this.panel || !this.client) return;
    const nonce = randomBytes(24).toString('base64');
    const button = (action: Action, label: string, enabled = true) => `<button data-action="${action}"${!enabled || this.busy ? ' disabled' : ''}>${escape(label)}</button>`;
    const cards = apps.map(([action, label, name]) => {
      const status = this.report?.checks.find(c => c.name === name)?.status;
      return `<div>${button(action, label, status === 'observed')}<p>${status === 'observed' ? 'Page available' : status === 'missing' ? 'Not installed here' : this.checking && !status ? 'Checking…' : 'Could not confirm this page'}</p></div>`;
    }).join('');
    const details = this.report?.checks.map(c => `<li><strong>${escape(c.name)}</strong>: ${escape(c.detail)}</li>`).join('') ?? '';
    this.panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>Your Urbit</title><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);line-height:1.6;margin:0}main{max-width:850px;margin:auto;padding:36px}h1{font-size:32px;font-weight:500;margin-bottom:8px}p{color:var(--vscode-descriptionForeground)}.apps{display:flex;flex-wrap:wrap;gap:18px;margin:30px 0}.apps>div{min-width:120px}.apps p{font-size:12px}button{font:inherit;border:1px solid var(--vscode-contrastBorder,transparent);border-radius:5px;padding:9px 16px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}button:disabled{opacity:.55;cursor:default}.origin{overflow-wrap:anywhere}section{border-top:1px solid var(--vscode-panel-border);padding:20px 0}details{margin-top:24px}li{margin:10px 0;overflow-wrap:anywhere}.error{color:var(--vscode-errorForeground)}</style></head><body><main>
<h1>Your Urbit</h1><p role="status">Connected as <strong>${escape(this.ship)}</strong></p><p class="origin">${escape(this.client.origin)}</p><div class="apps" aria-label="Your apps">${cards}</div>
<section><h2>Join a shared project</h2><p>${this.joining() ? 'Use the project owner’s invitation to join with your own Urbit. You do not need a local coding worker to accept an invitation.' : this.checking ? 'Checking whether this ship can accept project invitations…' : 'This ship’s project-invitation service could not be confirmed. See the setup guide to prepare it for collaboration.'}</p>${button('join', 'Join a workspace', this.joining())}</section>
<section><h2>Your coding workspace</h2><p>${this.checking ? 'Checking whether this ship has Readymade coding apps…' : this.coding() ? 'Readymade coding apps are available. Open your workspace to choose a project.' : 'Your Urbit is connected. Coding needs the Readymade ship-side apps; signing in again will not install them.'}</p>${this.coding() ? button('coding', 'Open coding workspace') : button('guide', 'Read setup guide')}</section>
${button('newWindow', 'Connect another Urbit in a new window')}<p class="error" role="alert">${escape(this.error)}</p><details><summary>Connection details</summary><p>These checks only read pages. They do not install apps, run code, or prove that every app works.</p><ul>${details}</ul></details>
</main><script nonce="${nonce}">const api=acquireVsCodeApi();document.querySelectorAll('button[data-action]').forEach(button=>button.addEventListener('click',()=>{if(!button.disabled)api.postMessage({action:button.dataset.action});}));</script></body></html>`;
  }
  dispose(): void {this.closed = true; this.epoch++; this.panel?.dispose(); this.events.splice(0).forEach(event => event.dispose()); this.panel = undefined; this.client = undefined; this.report = undefined;}
}
