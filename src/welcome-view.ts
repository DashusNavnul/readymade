import * as vscode from 'vscode';
import {randomBytes} from 'node:crypto';

export type WelcomeAction = 'openProject'|'connect'|'getUrbit'|'join'|'noltbook'|'glurff'|'lattice'|'groups'|'landscape';
export interface WelcomeState {ship?: string; origin?: string; project?: string}
const actions = new Set<WelcomeAction>(['openProject','connect','getUrbit','join','noltbook','glurff','lattice','groups','landscape']);
const viewType = 'readymade.welcome';
/** Presentation only: every action delegates to an existing explicit workspace flow. */
export class WelcomeView implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private panelEvents: vscode.Disposable[] = [];
  private readonly serializer: vscode.Disposable;
  private closed = false;
  private busy = false;
  private error = '';
  private lastState = '';
  constructor(private readonly state: () => WelcomeState, private readonly run: (action: WelcomeAction) => Promise<unknown>) {
    this.serializer = vscode.window.registerWebviewPanelSerializer(viewType, {deserializeWebviewPanel: async panel => {
      if (this.closed || this.panel) {panel.dispose(); return;}
      this.attach(panel);
    }});
  }
  show(): void {
    if (this.closed) return;
    if (this.panel) {this.panel.reveal(this.panel.viewColumn, false); this.refresh(); return;}
    this.attach(vscode.window.createWebviewPanel(viewType, 'Home', vscode.ViewColumn.Active,
      {enableScripts: true, enableCommandUris: false, localResourceRoots: [], retainContextWhenHidden: true}));
  }
  showOnStartup(): void {
    if (!vscode.workspace.workspaceFolders?.length && !vscode.window.terminals.length && !vscode.window.tabGroups.all.some(group => group.tabs.length)) this.show();
  }
  refresh(): void {
    if (!this.panel || this.closed) return;
    const value = this.presentation(), serialized = JSON.stringify(value);
    if (serialized === this.lastState) return;
    const panel = this.panel; this.lastState = serialized;
    const retryOnRefresh = () => {if (this.panel === panel && this.lastState === serialized) this.lastState = '';};
    void panel.webview.postMessage(value).then(delivered => {if (!delivered) retryOnRefresh();}, retryOnRefresh);
  }
  private presentation(): WelcomeState & {busy: boolean; error: string} {
    const state = this.state();
    return {ship: state.ship, origin: state.origin, project: state.project, busy: this.busy, error: this.error};
  }
  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel; this.lastState = '';
    panel.title = 'Home';
    panel.webview.options = {enableScripts: true, enableCommandUris: false, localResourceRoots: []};
    this.panelEvents = [panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.panel = undefined; this.lastState = '';
      this.panelEvents.splice(0).forEach(event => event.dispose());
    }), panel.webview.onDidReceiveMessage((message: unknown) => {void this.receive(panel, message);})];
    const initial = this.presentation(); this.lastState = JSON.stringify(initial);
    panel.webview.html = this.html(initial);
  }
  private async receive(panel: vscode.WebviewPanel, message: unknown): Promise<void> {
    if (this.closed || panel !== this.panel || this.busy || !message || typeof message !== 'object' || Array.isArray(message)) return;
    const row = message as Record<string, unknown>;
    if (Object.keys(row).length !== 1 || !Object.hasOwn(row, 'action') || typeof row.action !== 'string' || !actions.has(row.action as WelcomeAction)) return;
    this.busy = true; this.error = ''; this.refresh();
    try {await this.run(row.action as WelcomeAction);}
    catch (error) {if (this.panel === panel) this.error = error instanceof Error ? error.message.slice(0,512) : 'That action could not be completed. Please try again.';}
    finally {this.busy = false; this.refresh();}
  }
  private html(initial: WelcomeState & {busy: boolean; error: string}): string {
    const nonce = randomBytes(24).toString('base64');
    const data = JSON.stringify(initial).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
    const icon = (path: string) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    const folder = icon('<path d="M3 6h7l2 2h9v11H3z"/><path d="M3 6V4h7l2 2"/>');
    const ship = icon('<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c5 4 5 12 0 16-5-4-5-12 0-16z"/>');
    const join = icon('<path d="M4 12h15m-5-5 5 5-5 5M5 5H3v14h2"/>');
    const apps: [WelcomeAction,string,string,string][] = [
      ['noltbook','Noltbook','Messages & calls','<path d="M4 5h16v12H9l-5 4z"/><path d="M8 9h8m-8 4h5"/>'],
      ['glurff','Glurff','Shared world','<path d="m12 3 9 5-9 5-9-5zM3 8v9l9 5 9-5V8M12 13v9"/>'],
      ['lattice','Lattice','Notes & reading','<path d="M12 5C9 3 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1zM12 5v15"/>'],
      ['groups','Groups','Communities','<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2"/>'],
      ['landscape','Landscape','Your apps','<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'],
    ];
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Readymade Home</title><style nonce="${nonce}">
.get-urbit{background:transparent;border:0;padding:12px 0;color:var(--vscode-textLink-foreground)}
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family,system-ui,sans-serif);font-size:14px;line-height:1.55}main{max-width:1050px;margin:auto;padding:32px 42px 24px}header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:42px}.brand{font-weight:600;letter-spacing:.02em;font-size:16px;display:flex;align-items:center;gap:11px}.brand-mark{width:26px;height:26px;border:1.5px solid currentColor;display:grid;place-items:center;border-radius:7px}.brand-mark:after{content:'';width:8px;height:8px;background:currentColor;border-radius:2px}.identity{font-size:12px;color:var(--vscode-descriptionForeground);max-width:55%;text-align:right;overflow-wrap:anywhere}.identity:empty{display:none}h1{font-size:clamp(34px,5.2vw,48px);font-weight:500;letter-spacing:-.045em;line-height:1.12;margin:0 0 18px;max-width:680px}.intro{font-size:16px;color:var(--vscode-descriptionForeground);margin:0 0 28px;max-width:650px}.starts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}button{font:inherit;color:inherit;cursor:pointer}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:4px}button:disabled{cursor:progress;opacity:.65}.start{background:var(--vscode-sideBar-background,var(--vscode-editor-background));border:1px solid var(--vscode-widget-border,var(--vscode-panel-border,transparent));border-radius:10px;text-align:left;padding:22px;min-height:160px;display:flex;flex-direction:column;align-items:flex-start;gap:8px}.start:hover{background:var(--vscode-list-hoverBackground);border-color:var(--vscode-focusBorder)}.start.primary{border-color:var(--vscode-button-background);box-shadow:inset 0 3px 0 var(--vscode-button-background)}svg{width:25px;height:25px;flex:none}.start svg{margin-bottom:8px}.label{font-weight:600;font-size:15px}.detail{font-size:13px;color:var(--vscode-descriptionForeground)}.apps{margin-top:32px;border-top:1px solid var(--vscode-panel-border);padding-top:22px}.section-top{display:flex;justify-content:space-between;gap:20px;align-items:baseline;margin-bottom:16px}h2{font-size:14px;font-weight:600;margin:0}.hint{color:var(--vscode-descriptionForeground);font-size:12px;margin:0;max-width:470px;text-align:right}.app-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}.app{display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:7px;border:1px solid transparent;border-radius:8px;background:transparent;padding:12px 10px}.app:hover{background:var(--vscode-list-hoverBackground)}.app svg{color:var(--vscode-descriptionForeground);margin-bottom:3px}.app .label{font-size:14px}.app .detail{font-size:12px}.status{min-height:44px;margin:22px 0 0;color:var(--vscode-errorForeground);font-size:13px;overflow-wrap:anywhere}.status:empty{min-height:0;margin:0}footer{color:var(--vscode-descriptionForeground);font-size:12px;margin-top:20px}.vscode-high-contrast .start,.vscode-high-contrast-light .start,.vscode-high-contrast .app,.vscode-high-contrast-light .app{border-color:var(--vscode-contrastBorder)}@media(max-width:650px){main{padding:28px 22px}header{margin-bottom:48px}.starts{grid-template-columns:1fr}.start{min-height:0;padding:20px}.start svg{margin-bottom:4px}.app-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.section-top{display:block}.hint{text-align:left;margin-top:8px}.apps{margin-top:36px}.intro{font-size:15px}}
</style></head><body><main><header><div class="brand"><span class="brand-mark" aria-hidden="true"></span>Readymade</div><div id="identity" class="identity" aria-live="polite"></div></header>
<section aria-labelledby="heading"><h1 id="heading">Make something together.</h1><p class="intro">Your code, conversations, and apps — in one place.</p><div class="starts">
<button class="start primary" data-action="openProject">${folder}<span class="label">Open a project</span><span class="detail">Pick a folder and start working.</span></button>
<button class="start" data-action="connect">${ship}<span class="label">Connect your Urbit</span><span class="detail">Choose a running ship or add a hosted one.</span></button>
<button class="start" data-action="join">${join}<span class="label">Join a workspace</span><span class="detail">Start from a shared invitation.</span></button></div><p class="detail"><button class="get-urbit" data-action="getUrbit">Need a planet? Get an Urbit</button></p></section>
<section class="apps" aria-labelledby="apps-heading"><div class="section-top"><h2 id="apps-heading">Your shared spaces</h2><p id="apps-hint" class="hint">Connect your Urbit to open the apps installed on your ship.</p></div><div class="app-grid">${apps.map(([action,name,detail,path])=>`<button class="app" data-action="${action}">${icon(path)}<span class="label">${name}</span><span class="detail">${detail}</span></button>`).join('')}</div></section>
<p id="status" class="status" role="status" aria-live="polite" aria-atomic="true"></p><footer>Open Readymade Home from the sidebar whenever you need a starting point.</footer></main>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const allowed=new Set(['openProject','connect','getUrbit','join','noltbook','glurff','lattice','groups','landscape']);let busy=false;
function render(state){if(!state||typeof state!=='object'||Array.isArray(state)||typeof state.busy!=='boolean'||typeof state.error!=='string'||['ship','origin','project'].some(key=>state[key]!==undefined&&typeof state[key]!=='string')||Object.keys(state).some(key=>!['ship','origin','project','busy','error'].includes(key)))return;busy=state.busy;for(const button of document.querySelectorAll('button[data-action]'))button.disabled=busy;document.getElementById('identity').textContent=state.ship?'Connected as '+state.ship+(state.project?' · '+state.project:''):'';document.getElementById('identity').title=state.ship&&typeof state.origin==='string'?state.origin:'';document.getElementById('apps-hint').textContent=state.ship?'Open the apps installed on your ship.':'Connect your Urbit to open the apps installed on your ship.';document.getElementById('status').textContent=state.error||(busy?'Opening…':'');}
for(const button of document.querySelectorAll('button[data-action]'))button.addEventListener('click',()=>{const action=button.dataset.action;if(busy||!allowed.has(action))return;busy=true;for(const other of document.querySelectorAll('button[data-action]'))other.disabled=true;vscode.postMessage({action});});
window.addEventListener('message',event=>render(event.data));render(${data});vscode.setState({});
</script></body></html>`;
  }
  dispose(): void {
    if (this.closed) return; this.closed = true; this.serializer.dispose();
    this.panel?.dispose(); this.panelEvents.splice(0).forEach(event => event.dispose()); this.panel = undefined;
  }
}
