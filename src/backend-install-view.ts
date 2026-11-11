import * as vscode from 'vscode';
import {randomBytes} from 'node:crypto';
import {BackendInstall, BackendInstallError, locateInstaller, type InstallPlan, type InstallReport, type InstallTarget} from './backend-install';

const viewType = 'readymade.backendInstall';
type Step = 'checking' | 'unavailable' | 'no-ship' | 'consent' | 'working' | 'report';
interface Presentation {step: Step; ship?: string; busy: boolean; message?: string; report?: InstallReport}

/**
 * "Install Pataphor on this ship": consent, then the bundled installer's own progress, in plain words.
 * The page starts nothing by itself. One explicit click approves one plan for the connected local ship.
 */
export class BackendInstallView implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private events: vscode.Disposable[] = [];
  private state: Presentation = {step: 'checking', busy: false};
  private installer?: BackendInstall;
  private plan?: InstallPlan;
  private target?: InstallTarget;
  private closed = false;
  private epoch = 0;
  private last = '';
  constructor(private readonly extensionPath: string, private readonly storage: string,
    private readonly localShip: () => InstallTarget | undefined, private readonly connect: () => Promise<boolean>) {}

  /** What the page currently shows; for host tests and status surfaces. */
  get presentation(): Presentation {return structuredClone(this.state);}

  async show(): Promise<void> {
    if (this.closed) return;
    if (this.panel) this.panel.reveal(this.panel.viewColumn, false);
    else {
      const panel = vscode.window.createWebviewPanel(viewType, 'Install Pataphor', vscode.ViewColumn.Active, {enableScripts: true, enableCommandUris: false, localResourceRoots: [], retainContextWhenHidden: true});
      this.panel = panel;
      this.events = [panel.onDidDispose(() => {
        if (this.panel !== panel) return;
        // Closing the page does not stop a run: the installer finishes or stops by itself and keeps its record.
        this.panel = undefined; this.last = ''; this.events.splice(0).forEach(event => event.dispose());
      }), panel.webview.onDidReceiveMessage((message: unknown) => {void this.receive(panel, message);})];
      panel.webview.html = this.html();
    }
    if (!this.state.busy) await this.refreshFromShip();
  }

  /** Decide what to show from the connected ship and any retained record. Sends nothing to the ship. */
  private async refreshFromShip(): Promise<void> {
    const epoch = ++this.epoch, current = () => !this.closed && epoch === this.epoch;
    this.set({step: 'checking', busy: false});
    const files = await locateInstaller(this.extensionPath);
    if (!current()) return;
    if (!files) {this.set({step: 'unavailable', busy: false, message: 'This build of Readymade does not include the Pataphor installer.'}); return;}
    this.installer = new BackendInstall(files, this.storage);
    const target = this.localShip();
    if (!target) {this.target = undefined; this.set({step: 'no-ship', busy: false}); return;}
    this.target = target;
    const retained = await this.installer.retained(target.ship);
    if (!current()) return;
    if (retained) {
      try {
        const report = await this.installer.status(retained);
        if (!current()) return;
        // A plan that was made but never run is not worth showing as history: offer a fresh start.
        if (report.phase !== 'not-started') {this.plan = retained; this.set({step: 'report', ship: target.ship, busy: false, report}); return;}
      } catch { /* an unreadable record falls back to the consent screen */ }
    }
    this.set({step: 'consent', ship: target.ship, busy: false});
  }

  private async install(): Promise<void> {
    const installer = this.installer, target = this.target;
    if (!installer || !target || this.state.busy || this.state.step !== 'consent') return;
    const live = this.localShip();
    if (!live || live.ship !== target.ship || live.pier !== target.pier || live.workerPid !== target.workerPid) {
      this.set({step: 'no-ship', busy: false, message: 'The connected ship changed. Connect it again, then install.'}); return;
    }
    this.set({step: 'working', ship: target.ship, busy: true, message: 'Preparing…'});
    try {
      const plan = this.plan = await installer.plan(target);
      const final = await installer.run(plan, report => {if (!this.closed) this.set({step: 'working', ship: target.ship, busy: true, report});});
      this.set({step: 'report', ship: target.ship, busy: false, report: final});
    } catch (error) {
      this.set({step: 'report', ship: target.ship, busy: false, report: this.state.report,
        message: error instanceof BackendInstallError ? error.message : 'The installer could not start. Nothing was sent to your ship.'});
    }
  }

  /** The second consent: switch on an install that is compiled and checked. Sent once; never repeated. */
  private async activate(): Promise<void> {
    const installer = this.installer, target = this.target, plan = this.plan;
    if (!installer || !target || !plan || this.state.busy || this.state.step !== 'report' || this.state.report?.phase !== 'activation-prepared') return;
    const live = this.localShip();
    if (!live || live.ship !== target.ship || live.pier !== target.pier || plan.ship !== target.ship) {
      this.set({step: 'no-ship', busy: false, message: 'The connected ship changed. Connect it again first.'}); return;
    }
    this.set({step: 'working', ship: target.ship, busy: true, report: this.state.report, message: 'Switching Pataphor on…'});
    try {
      const final = await installer.activate(plan, report => {if (!this.closed) this.set({step: 'working', ship: target.ship, busy: true, report});});
      this.set({step: 'report', ship: target.ship, busy: false, report: final});
    } catch (error) {
      this.set({step: 'report', ship: target.ship, busy: false, report: this.state.report,
        message: error instanceof BackendInstallError ? error.message : 'Switching on could not start. Nothing was sent to your ship.'});
    }
  }

  private async receive(panel: vscode.WebviewPanel, message: unknown): Promise<void> {
    if (this.closed || panel !== this.panel || !message || typeof message !== 'object' || Array.isArray(message)) return;
    const row = message as Record<string, unknown>;
    if (Object.keys(row).length !== 1 || typeof row.action !== 'string') return;
    if (row.action === 'ready') {this.last = ''; this.post(); return;}
    if (this.state.busy) return;
    if (row.action === 'install') await this.install();
    else if (row.action === 'activate') await this.activate();
    else if (row.action === 'connect') {if (await this.connect()) await this.refreshFromShip();}
    else if (row.action === 'recheck') await this.refreshFromShip();
  }

  private set(next: Presentation): void {this.state = next; this.post();}
  private post(): void {
    if (!this.panel || this.closed) return;
    const text = JSON.stringify(this.state); if (text === this.last) return;
    this.last = text; const panel = this.panel;
    void panel.webview.postMessage(this.state).then(delivered => {if (!delivered && this.panel === panel) this.last = '';}, () => {if (this.panel === panel) this.last = '';});
  }

  private html(): string {
    const nonce = randomBytes(24).toString('base64');
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'">
<title>Install Pataphor</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font:14px/1.55 var(--vscode-font-family,system-ui,sans-serif)}
main{max-width:720px;margin:auto;padding:30px 38px}h1{font-size:22px;font-weight:600;margin:0 0 6px}p{margin:8px 0}.muted{opacity:.75}
button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:3px;padding:7px 16px;cursor:pointer;margin-top:10px}
button:disabled{opacity:.5;cursor:default}ul{list-style:none;padding:0;margin:16px 0}li{display:flex;gap:10px;padding:3px 0}
.mark{width:1.4em;text-align:center}.running{font-weight:600}.waiting{opacity:.55}.needs-attention{color:var(--vscode-errorForeground)}
.notice{border-left:3px solid var(--vscode-focusBorder);padding:6px 12px;margin:14px 0}.problem{border-left-color:var(--vscode-errorForeground)}
</style></head><body><main><h1 id="title">Install Pataphor</h1><div id="body" role="status" aria-live="polite"></div>
<script nonce="${nonce}">
const api=acquireVsCodeApi(),body=document.getElementById('body'),title=document.getElementById('title');
const marks={done:'✓',running:'●','needs-attention':'!',waiting:'·'};
function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e}
function button(label,action,disabled){const b=el('button',label);b.disabled=!!disabled;b.addEventListener('click',()=>api.postMessage({action}));return b}
function rows(report){const ul=el('ul');for(const item of report.items){const li=el('li',undefined,item.status);li.append(el('span',marks[item.status]||'·','mark'),el('span',item.label+(item.reason?' — '+item.reason:'')));ul.append(li)}return ul}
function render(s){
  if(!s||typeof s!=='object'||typeof s.step!=='string')return;
  body.replaceChildren();title.textContent=s.ship?'Install Pataphor on '+s.ship:'Install Pataphor';
  if(s.step==='checking'){body.append(el('p','Checking…','muted'));return}
  if(s.step==='unavailable'){body.append(el('p',s.message||'The installer is not available.'));return}
  if(s.step==='no-ship'){
    body.append(el('p',s.message||'Connect a ship that is running on this computer first.'),
      el('p','Installing works on a planet running on this Mac. A hosted or remote ship cannot be installed from here yet.','muted'),button('Connect your Urbit','connect'));return}
  if(s.step==='consent'){
    body.append(el('p','This adds Pataphor’s apps to your ship so you can use them from Readymade.'),
      el('p','Your existing apps and their data are left as they are. The files are copied to a new, separate place on your ship and checked there.'),
      el('p','It takes about 15 to 20 minutes and your Mac will be busy while it runs. You can keep using Readymade; closing this page does not stop it.','muted'),
      el('p','When it finishes, Pataphor is installed and checked but not switched on yet. Switching it on is a separate step.','muted'),
      button('Install','install',s.busy));return}
  if(s.message)body.append(el('p',s.message,s.step==='report'?'notice problem':'muted'));
  if(s.report){
    const r=s.report;
    if(s.step==='report'&&r.phase==='activated')body.append(el('p','Pataphor is on. Its apps are running on your ship, and your existing apps and their data were checked and are unchanged.','notice'));
    else if(s.step==='report'&&r.phase==='activation-prepared')body.append(el('p','Installed and checked. Pataphor’s apps are on your ship and every one of them built correctly. They are not switched on yet.','notice'),
      el('p','Switching on starts the ten new apps beside your existing ones. Your existing apps keep running; afterwards they are compared with a record taken just before. This is sent once and cannot be undone from here.','muted'),button('Switch Pataphor on','activate',s.busy));
    else if(s.step==='report'&&r.phase==='needs-attention')body.append(el('p','Stopped at “'+(r.stoppedAt||'a step')+'”. '+(r.reason||'')+' Nothing was retried, and your existing apps were not changed.','notice problem'));
    else if(s.step==='report'&&r.phase!=='running')body.append(el('p','This install did not finish. Nothing was retried.','notice problem'));
    body.append(rows(r));
  }
  if(s.step==='report'&&(!s.report||s.report.phase!=='activation-prepared'))body.append(button('Check again','recheck'));
}
window.addEventListener('message',e=>render(e.data));
api.postMessage({action:'ready'});
</script></main></body></html>`;
  }

  dispose(): void {
    if (this.closed) return; this.closed = true; this.epoch++;
    this.panel?.dispose(); this.events.splice(0).forEach(event => event.dispose()); this.panel = undefined;
  }
}
