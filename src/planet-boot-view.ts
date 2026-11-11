import * as vscode from 'vscode';
import {randomBytes} from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import {PlanetBoot, PlanetBootError, planetFromKeyfile, type BootPlan, type BootReport} from './planet-boot';

const viewType = 'readymade.planetBoot';
type Step = 'checking' | 'unavailable' | 'choose' | 'confirm' | 'working' | 'report';
interface Presentation {step: Step; ship?: string; busy: boolean; message?: string; report?: BootReport}

/**
 * "Start a planet from its keyfile": choose the file, confirm it is not running anywhere else, then the
 * bundled boot's own progress. One explicit click starts one planet once; nothing is retried.
 */
export class PlanetBootView implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private events: vscode.Disposable[] = [];
  private state: Presentation = {step: 'checking', busy: false};
  private readonly boot: PlanetBoot;
  private keyfile?: string;
  private plan?: BootPlan;
  private closed = false;
  private last = '';
  constructor(extensionPath: string, private readonly connect: () => Promise<boolean>, shipsRoot = path.join(os.homedir(), '.readymade', 'ships')) {
    // A short folder: the planet's native socket path has a 104-byte limit.
    this.boot = new PlanetBoot(path.join(extensionPath, 'backend/install'), shipsRoot);
  }
  get presentation(): Presentation {return structuredClone(this.state);}

  async show(): Promise<void> {
    if (this.closed) return;
    if (this.panel) this.panel.reveal(this.panel.viewColumn, false);
    else {
      const panel = vscode.window.createWebviewPanel(viewType, 'Start a planet', vscode.ViewColumn.Active, {enableScripts: true, enableCommandUris: false, localResourceRoots: [], retainContextWhenHidden: true});
      this.panel = panel;
      this.events = [panel.onDidDispose(() => {
        if (this.panel !== panel) return;
        this.panel = undefined; this.last = ''; this.events.splice(0).forEach(event => event.dispose());
      }), panel.webview.onDidReceiveMessage((message: unknown) => {void this.receive(panel, message);})];
      panel.webview.html = this.html();
    }
    if (this.state.busy || this.state.step === 'report' || this.state.step === 'confirm') return;
    this.set(await this.boot.available() ? {step: 'choose', busy: false} :
      {step: 'unavailable', busy: false, message: 'This build of Readymade does not include the Urbit runtime, so it cannot start a planet.'});
  }

  private async choose(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({title: 'Choose your planet’s keyfile', canSelectMany: false, canSelectFiles: true, canSelectFolders: false,
      filters: {Keyfile: ['key']}, openLabel: 'Use this keyfile'});
    if (this.closed || !picked?.length || picked[0].scheme !== 'file') return;
    const file = picked[0].fsPath;
    const ship = planetFromKeyfile(file) ?? await vscode.window.showInputBox({title: 'Which planet is this keyfile for?', prompt: 'The planet’s name, such as ~sampel-palnet',
      ignoreFocusOut: true, validateInput: value => /^~[a-z]{6}-[a-z]{6}$/.test(value.trim()) ? undefined : 'A planet name looks like ~sampel-palnet'});
    if (this.closed || !ship) return;
    this.keyfile = file; this.plan = undefined;
    this.set({step: 'confirm', ship: ship.trim(), busy: false});
  }

  private async start(): Promise<void> {
    const ship = this.state.ship, keyfile = this.keyfile;
    if (!ship || !keyfile || this.state.busy || this.state.step !== 'confirm') return;
    this.set({step: 'working', ship, busy: true, message: 'Checking the keyfile…'});
    try {
      const plan = this.plan = await this.boot.prepare(ship, keyfile);
      this.keyfile = undefined;
      const final = await this.boot.launch(plan, report => {if (!this.closed) this.set({step: 'working', ship, busy: true, report});});
      this.set({step: 'report', ship, busy: false, report: final});
    } catch (error) {
      this.set({step: this.plan ? 'report' : 'confirm', ship, busy: false, report: this.state.report,
        message: error instanceof PlanetBootError ? error.message : 'The planet could not be started. Nothing was started twice.'});
    }
  }

  private async receive(panel: vscode.WebviewPanel, message: unknown): Promise<void> {
    if (this.closed || panel !== this.panel || !message || typeof message !== 'object' || Array.isArray(message)) return;
    const row = message as Record<string, unknown>;
    if (Object.keys(row).length !== 1 || typeof row.action !== 'string') return;
    if (row.action === 'ready') {this.last = ''; this.post(); return;}
    if (this.state.busy) return;
    if (row.action === 'choose') await this.choose();
    else if (row.action === 'start') await this.start();
    else if (row.action === 'connect') await this.connect();
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
<title>Start a planet</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font:14px/1.55 var(--vscode-font-family,system-ui,sans-serif)}
main{max-width:720px;margin:auto;padding:30px 38px}h1{font-size:22px;font-weight:600;margin:0 0 6px}p{margin:8px 0}.muted{opacity:.75}
button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:3px;padding:7px 16px;cursor:pointer;margin:10px 8px 0 0}
button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
ul{list-style:none;padding:0;margin:16px 0}li{display:flex;gap:10px;padding:3px 0}.mark{width:1.4em;text-align:center}.running{font-weight:600}.waiting{opacity:.55}
.needs-attention{color:var(--vscode-errorForeground)}.notice{border-left:3px solid var(--vscode-focusBorder);padding:6px 12px;margin:14px 0}.problem{border-left-color:var(--vscode-errorForeground)}
</style></head><body><main><h1 id="title">Start a planet</h1><div id="body" role="status" aria-live="polite"></div>
<script nonce="${nonce}">
const api=acquireVsCodeApi(),body=document.getElementById('body'),title=document.getElementById('title');
const marks={done:'✓',running:'●','needs-attention':'!',waiting:'·'};
function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e}
function button(label,action,cls){const b=el('button',label,cls);b.addEventListener('click',()=>api.postMessage({action}));return b}
function rows(report){const ul=el('ul');for(const item of report.items){const li=el('li',undefined,item.status);li.append(el('span',marks[item.status]||'·','mark'),el('span',item.label+(item.reason?' — '+item.reason:'')));ul.append(li)}return ul}
function render(s){
  if(!s||typeof s!=='object'||typeof s.step!=='string')return;
  body.replaceChildren();title.textContent=s.ship?'Start '+s.ship:'Start a planet';
  if(s.step==='checking'){body.append(el('p','Checking…','muted'));return}
  if(s.step==='unavailable'){body.append(el('p',s.message||'Starting a planet is not available.'));return}
  if(s.step==='choose'){
    body.append(el('p','If you have a planet’s keyfile, Readymade can start that planet on this Mac.'),
      el('p','A keyfile is a small file ending in “.key”. When you claim a planet in Bridge it is inside the passport download.','muted'),
      button('Choose your keyfile','choose'));return}
  if(s.message)body.append(el('p',s.message,s.step==='working'?'muted':'notice problem'));
  if(s.step==='confirm'){
    body.append(el('p','A planet must only ever run in one place. If '+(s.ship||'this planet')+' is running on another computer or a hosting service, stop it there first. Running it in two places can break it permanently.'),
      el('p','Readymade will keep the planet in a private folder on this Mac and reach it only from this Mac. The first start takes a few minutes.','muted'),
      button('It is not running anywhere else — start it','start'),button('Choose a different keyfile','choose','secondary'));return}
  if(s.report){
    const r=s.report;
    if(s.step==='report'&&r.phase==='booted')body.append(el('p','Your planet is running on this Mac.','notice'));
    else if(s.step==='report')body.append(el('p','Stopped at “'+(r.stoppedAt||'a step')+'”. '+(r.reason||'')+' Do not start it again from another app; ask for help with this screen open.','notice problem'));
    body.append(rows(r));
    if(s.step==='report'&&r.phase==='booted')body.append(button('Connect to it','connect'));
  }
}
window.addEventListener('message',e=>render(e.data));
api.postMessage({action:'ready'});
</script></main></body></html>`;
  }

  dispose(): void {
    if (this.closed) return; this.closed = true;
    this.panel?.dispose(); this.events.splice(0).forEach(event => event.dispose()); this.panel = undefined;
  }
}
