import * as vscode from 'vscode';
import {randomBytes} from 'node:crypto';
import {fetchPlanetCatalog, type PlanetCatalog} from './planet-catalog';
import type {WelcomeState} from './welcome-view';

const viewType = 'readymade.planetSetup';
const checkout = 'https://www.orraah.com/store/checkout/planet-identity';
const setup = 'https://www.orraah.com/download';
const actions = new Set(['ready', 'refresh', 'checkout', 'setup', 'connect', 'newWindow']);

/** Native onboarding around public availability; purchasing and issuing stay with Orraah. */
export class PlanetSetupView implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private events: vscode.Disposable[] = [];
  private readonly serializer: vscode.Disposable;
  private read?: AbortController;
  private catalog?: PlanetCatalog;
  private loading = false;
  private opening = false;
  private error = '';
  private lastState = '';
  private closed = false;
  constructor(private readonly connection: () => WelcomeState, private readonly connect: () => Promise<boolean>) {
    this.serializer = vscode.window.registerWebviewPanelSerializer(viewType, {deserializeWebviewPanel: async panel => {
      if (this.closed || this.panel) {panel.dispose(); return;}
      this.attach(panel); // Restoring presentation never repeats a request or opens a website.
    }});
  }
  async start(): Promise<void> {
    const choice = await vscode.window.showQuickPick([
      {label: 'I already have an Urbit', description: 'Connect with your ship’s web address', value: 'existing'},
      {label: 'Get a new planet', description: 'See hosted plans or get a planet yourself', value: 'new'},
    ], {title: 'Connect your Urbit', placeHolder: 'How would you like to get started?'});
    if (this.closed || !choice) return;
    if (choice.value === 'existing') await this.connect();
    else this.show();
  }
  show(): void {
    if (this.closed) return;
    if (this.panel) this.panel.reveal(this.panel.viewColumn, false);
    else this.attach(vscode.window.createWebviewPanel(viewType, 'Get an Urbit', vscode.ViewColumn.Active,
      {enableScripts: true, enableCommandUris: false, localResourceRoots: [], retainContextWhenHidden: true}));
    void this.load();
  }
  get inventory(): PlanetCatalog | undefined {return this.catalog && structuredClone(this.catalog);}
  private presentation() {
    return {ship: this.connection().ship, planets: this.catalog?.planets.filter(p => p.status === 'available').map(p => p.patp) ?? [],
      observedAt: this.catalog?.observedAt, loading: this.loading, opening: this.opening, error: this.error};
  }
  refresh(): void {
    if (!this.panel || this.closed) return;
    const value = this.presentation(), encoded = JSON.stringify(value), panel = this.panel;
    if (encoded === this.lastState) return;
    this.lastState = encoded;
    const retry = () => {if (this.panel === panel && this.lastState === encoded) this.lastState = '';};
    void panel.webview.postMessage(value).then(delivered => {if (!delivered) retry();}, retry);
  }
  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel; this.catalog = undefined; this.error = ''; this.lastState = '';
    panel.title = 'Get an Urbit'; panel.webview.options = {enableScripts: true, enableCommandUris: false, localResourceRoots: []};
    this.events = [panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.read?.abort(); this.read = undefined; this.loading = false; this.panel = undefined; this.catalog = undefined;
      this.events.splice(0).forEach(event => event.dispose());
    }), panel.webview.onDidReceiveMessage((value: unknown) => {void this.receive(panel, value);})];
    const initial = this.presentation(); this.lastState = JSON.stringify(initial); panel.webview.html = this.html(initial);
  }
  private async load(): Promise<void> {
    if (!this.panel || this.closed || this.loading) return;
    const panel = this.panel, read = new AbortController(); this.read = read;
    this.catalog = undefined; this.loading = true; this.error = ''; this.refresh();
    try {
      const catalog = await fetchPlanetCatalog(undefined, read.signal);
      if (!this.closed && this.panel === panel && this.read === read) this.catalog = catalog;
    } catch (error) {
      if (!read.signal.aborted && !this.closed && this.panel === panel && this.read === read)
        this.error = error instanceof Error ? error.message : 'Could not check Orraah’s available planets. Try again.';
    } finally {
      if (this.read === read) {this.read = undefined; this.loading = false; this.refresh();}
    }
  }
  private async receive(panel: vscode.WebviewPanel, value: unknown): Promise<void> {
    if (this.closed || this.panel !== panel || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== 1 || !Object.hasOwn(row, 'action') || typeof row.action !== 'string' || !actions.has(row.action)) return;
    if (row.action === 'ready') {this.lastState = ''; this.refresh(); return;}
    if (this.opening) return;
    if (row.action === 'refresh') {await this.load(); return;}
    this.opening = true; this.error = ''; this.refresh();
    try {
      if (row.action === 'checkout' || row.action === 'setup') {
        if (!await vscode.env.openExternal(vscode.Uri.parse(row.action === 'checkout' ? checkout : setup)))
          throw Error('The website could not open. Try again.');
      } else if (row.action === 'newWindow') await vscode.commands.executeCommand('workbench.action.newWindow');
      else if (this.connection().ship) await vscode.commands.executeCommand('workbench.action.newWindow');
      else await this.connect();
    } catch (error) {if (this.panel === panel) this.error = error instanceof Error ? error.message.slice(0, 512) : 'That step could not open. Try again.';}
    finally {this.opening = false; this.refresh();}
  }
  private html(initial: ReturnType<PlanetSetupView['presentation']>): string {
    const nonce = randomBytes(24).toString('base64');
    const data = JSON.stringify(initial).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'">
<title>Get an Urbit</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font:14px/1.55 var(--vscode-font-family,system-ui,sans-serif)}main{max-width:1050px;margin:auto;padding:30px 38px}.brand{font-weight:600;margin-bottom:28px}h1{font-size:38px;line-height:1.15;font-weight:500;letter-spacing:-.035em;margin:0 0 14px}.intro{color:var(--vscode-descriptionForeground);font-size:16px;margin:0 0 24px}.steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.step{border:1px solid var(--vscode-widget-border,var(--vscode-panel-border,transparent));background:var(--vscode-sideBar-background);border-radius:10px;padding:20px;display:flex;flex-direction:column;min-width:0}.number{font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:8px}h2{font-size:18px;font-weight:600;margin:0 0 8px}p{margin:0 0 12px}.muted{color:var(--vscode-descriptionForeground);font-size:13px}.inventory{padding:0;list-style:none;margin:0 0 12px}.inventory li{padding:6px 9px;border:1px solid var(--vscode-panel-border);border-radius:5px;margin-bottom:6px;font-family:var(--vscode-editor-font-family,monospace);font-size:13px;overflow-wrap:anywhere}.actions{margin-top:auto;padding-top:12px;display:grid;gap:9px}button{font:inherit;cursor:pointer;border:1px solid transparent;border-radius:5px;padding:9px 12px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);text-align:center}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}button:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}button:disabled{opacity:.65;cursor:not-allowed}.quiet{font-size:12px;line-height:1.5;color:var(--vscode-descriptionForeground);margin:10px 0 0}.notice{padding:16px 0;display:flex;align-items:center;gap:18px}.notice p{margin:0}.connect{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:20px 0;border-top:1px solid var(--vscode-panel-border)}.connect button{flex-shrink:0}.connect p{margin:0}.connect .muted{margin-top:4px}details{border-top:1px solid var(--vscode-panel-border);padding-top:16px}summary{cursor:pointer;font-weight:600;list-style-position:inside}details .steps{grid-template-columns:repeat(2,minmax(0,1fr));margin-top:16px}.status{color:var(--vscode-errorForeground);margin-top:20px;overflow-wrap:anywhere}.status:empty{display:none}footer{font-size:12px;color:var(--vscode-descriptionForeground);margin-top:20px}.vscode-high-contrast .step,.vscode-high-contrast-light .step{border-color:var(--vscode-contrastBorder)}@media(max-width:760px){main{padding:26px 22px}.steps,details .steps{grid-template-columns:1fr}.brand{margin-bottom:22px}h1{font-size:32px}.notice,.connect{align-items:flex-start;flex-direction:column;gap:12px}}
</style></head><body><main><div class="brand">Readymade / Get an Urbit</div><h1>A home for your work.</h1><p class="intro">A proposed hosted service: start with a free planet identity, subscribe to hosting and support, and leave with your work.</p>
<div class="steps" aria-label="Proposed hosted service"><section class="step" aria-labelledby="identity-heading"><div class="number">START · $0 IDENTITY</div><h2 id="identity-heading">Your own place</h2><p>A free planet identity on signup.</p><p class="muted">Until you buy it out, the issuing star operator would retain ownership of the identity.</p></section>
<section class="step" aria-labelledby="services-heading"><div class="number">STAY · MONTHLY SERVICES</div><h2 id="services-heading">Help with the work</h2><p>Hosting and compute, arbitration, and workspace guidance through QPC and its corpus.</p><p class="muted">Monthly pricing and service terms are not set yet.</p></section>
<section class="step" aria-labelledby="exit-heading"><div class="number">LEAVE · $10 ONE TIME</div><h2 id="exit-heading">Take it with you</h2><p>The proposed $10 ownership buyout would transfer the planet to you.</p><p class="muted">Then export your keys and data and host it yourself.</p></section></div>
<div class="notice"><button id="signup" disabled aria-describedby="signup-reason">Sign up — unavailable</button><p id="signup-reason" class="muted">This is a proposal, not an active offer. No signup provider is connected, and provisioning, billing, ownership transfer, and service terms are not in place. No personal details or payment are collected here.</p></div>
<section class="connect" aria-labelledby="connect-heading"><div><h2 id="connect-heading">Already running an Urbit?</h2><p id="connection">Connect using your ship’s web address.</p><p id="connection-help" class="muted">You’ll enter the ship’s login code in Readymade’s private password field.</p></div><button id="connect" data-action="connect">Connect my Urbit</button></section>
<details><summary>Prefer to set it up yourself? Buy directly from Orraah</summary><p class="quiet">This separate, direct-purchase option is available through Orraah’s website. Its checkout price is not the proposed $10 hosted-service buyout.</p><div class="steps"><section class="step" aria-labelledby="planet-heading"><h2 id="planet-heading">Choose a planet</h2><p class="muted">Orraah handles its own pricing, checkout, and identity delivery.</p><p id="availability" class="muted" aria-live="polite">Check Orraah’s available planets.</p><ul id="inventory" class="inventory" aria-label="Planets listed as available by Orraah"></ul><p id="checked" class="quiet"></p><div class="actions"><button data-action="checkout">Open Orraah checkout ↗</button><button class="secondary" data-action="refresh">Refresh availability</button></div><p class="quiet">Listings are not reservations. Checkout opens in your browser.</p></section>
<section class="step" aria-labelledby="server-heading"><h2 id="server-heading">Start your server</h2><p>Your planet needs a running server before you can connect it.</p><p class="muted">Run it on your computer or arrange hosting separately. Orraah’s setup is a starting point for running it locally.</p><div class="actions"><button class="secondary" data-action="setup">Set up with Orraah ↗</button></div><p class="quiet">Return here when your server is running and you have its web address.</p></section></div></details>
<p id="status" class="status" role="status" aria-live="polite"></p><footer>Connecting gives access to your installed apps. Shared coding also needs its own backend and project access. This page does not issue a planet, confirm payment, or start a server.</footer></main>
<script nonce="${nonce}">
const api=acquireVsCodeApi();const allowed=new Set(['refresh','checkout','setup','connect','newWindow']);let opening=false,loading=false;
function render(s){if(!s||typeof s!=='object'||!Array.isArray(s.planets)||!s.planets.every(p=>typeof p==='string')||typeof s.loading!=='boolean'||typeof s.opening!=='boolean'||typeof s.error!=='string'||['ship','observedAt'].some(k=>s[k]!==undefined&&typeof s[k]!=='string'))return;opening=s.opening;loading=s.loading;for(const b of document.querySelectorAll('button[data-action]'))b.disabled=opening||(loading&&b.dataset.action==='refresh');document.getElementById('availability').textContent=loading?'Checking Orraah’s availability…':s.observedAt?(s.planets.length?'Orraah lists '+s.planets.length+' available planet'+(s.planets.length===1?'': 's')+'.':'Orraah currently lists no available planets.'):'Refresh availability to see the current listings.';const list=document.getElementById('inventory');list.replaceChildren(...s.planets.map(name=>{const li=document.createElement('li');li.textContent=name;return li}));document.getElementById('checked').textContent=s.observedAt?'Last checked '+new Date(s.observedAt).toLocaleString():'';document.getElementById('connection').textContent=s.ship?'This window is connected as '+s.ship+'.':'Connect using your ship’s web address.';document.getElementById('connection-help').textContent=s.ship?'Use another Readymade window for a different Urbit.':'You’ll enter the ship’s login code in Readymade’s private password field.';const connect=document.getElementById('connect');connect.textContent=s.ship?'New Readymade window':'Connect my Urbit';connect.dataset.action=s.ship?'newWindow':'connect';document.getElementById('status').textContent=s.error;}
for(const b of document.querySelectorAll('button[data-action]'))b.addEventListener('click',()=>{const action=b.dataset.action;if(opening||!allowed.has(action)||(loading&&action==='refresh'))return;api.postMessage({action})});window.addEventListener('message',e=>render(e.data));render(${data});api.setState({});api.postMessage({action:'ready'});
</script></body></html>`;
  }
  dispose(): void {
    if (this.closed) return; this.closed = true; this.read?.abort(); this.serializer.dispose(); this.panel?.dispose();
    this.events.splice(0).forEach(event => event.dispose()); this.panel = undefined;
  }
}
