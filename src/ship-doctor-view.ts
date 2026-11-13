import * as vscode from 'vscode';
import {randomBytes} from 'node:crypto';
import type {LocalPlanet} from './planet-discovery';
import {doctorFindings, recoveryRecipe, type DoctorFacts, type Finding} from './ship-doctor';
import {answerTime, bundledKelvin, EVENT_WATCH_SECONDS, gatherFacts} from './ship-doctor-probe';

/** The long watch: recurring work every two minutes or so (measured: a %noltbook poke of 216-278 ms) fits in it. */
const LONG_WATCH_SECONDS = 130;

const escape = (v: string) => v.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
const marks: Record<Finding['level'], string> = {ok: '✓', note: '·', warning: '!', problem: '✕'};
export interface DoctorTarget {ship: string; origin: string; planet?: LocalPlanet}

/** The doctor screen. It measures and explains; it never changes a ship. */
export class ShipDoctorView implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private events: vscode.Disposable[] = [];
  private target?: DoctorTarget;
  private facts?: DoctorFacts;
  private checking = false;
  private watchSeconds = EVENT_WATCH_SECONDS;
  private closed = false;
  private epoch = 0;
  constructor(private readonly extensionPath: string, private readonly current: () => DoctorTarget | undefined,
    private readonly gather: (planet: LocalPlanet, extensionPath: string, watchSeconds?: number) => Promise<DoctorFacts> = gatherFacts) {}
  get state(): {ship?: string; checking: boolean; findings: Finding[]} {return {ship: this.target?.ship, checking: this.checking, findings: this.facts ? doctorFindings(this.facts) : []};}
  async show(): Promise<void> {
    if (this.closed) return;
    const target = this.current();
    if (!target) {void vscode.window.showInformationMessage('Connect a ship first; the doctor checks the ship this window is connected to.'); return;}
    this.target = target;
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel('readymade.doctor', 'Ship Doctor', vscode.ViewColumn.Active, {enableScripts: true, enableCommandUris: false, localResourceRoots: [], retainContextWhenHidden: true});
      this.panel = panel;
      this.events = [panel.onDidDispose(() => {if (this.panel === panel) {this.epoch++; this.panel = undefined; this.facts = undefined; this.checking = false; this.events.splice(0).forEach(e => e.dispose());}}),
        panel.webview.onDidReceiveMessage((message: unknown) => {void this.receive(panel, message);})];
    } else this.panel.reveal();
    await this.check();
  }
  private async check(watchSeconds = EVENT_WATCH_SECONDS): Promise<void> {
    const target = this.target, panel = this.panel;
    if (!target || !panel || this.checking) return;
    const epoch = ++this.epoch; this.checking = true; this.watchSeconds = watchSeconds; this.render();
    let facts: DoctorFacts | undefined;
    try {
      facts = target.planet ? await this.gather(target.planet, this.extensionPath, watchSeconds) :
        {ship: target.ship, httpMs: await answerTime(target.origin), bundledKelvin: await bundledKelvin(this.extensionPath)};
    } catch {facts = undefined;}
    if (this.closed || this.panel !== panel || this.epoch !== epoch) return;
    this.facts = facts; this.checking = false; this.render();
  }
  private async receive(panel: vscode.WebviewPanel, message: unknown): Promise<void> {
    if (this.closed || panel !== this.panel || !message || typeof message !== 'object' || Array.isArray(message)) return;
    const row = message as Record<string, unknown>;
    if (Object.keys(row).length !== 1 || typeof row.action !== 'string') return;
    if (row.action === 'again' || row.action === 'watch') {
      const target = this.current(); if (target && target.ship === this.target?.ship) this.target = target;
      await this.check(row.action === 'watch' && this.target?.planet ? LONG_WATCH_SECONDS : EVENT_WATCH_SECONDS);
    }
    else if (row.action === 'recipe' && this.target?.planet) {
      await vscode.env.clipboard.writeText(recoveryRecipe(this.target.ship, this.target.planet.pier, this.facts?.command));
      void vscode.window.showInformationMessage('Recovery recipe copied. Keep it somewhere outside this computer.');
    }
  }
  private render(): void {
    if (!this.panel || !this.target) return;
    const nonce = randomBytes(24).toString('base64'), findings = this.facts ? doctorFindings(this.facts) : [];
    const rows = findings.map(f => `<li class="${f.level}"><span class="mark" aria-hidden="true">${marks[f.level]}</span><div><strong>${escape(f.title)}</strong><p>${escape(f.detail)}</p></div></li>`).join('');
    const trouble = findings.filter(f => f.level === 'warning' || f.level === 'problem').length;
    const summary = this.checking ? (this.target.planet && this.watchSeconds > EVENT_WATCH_SECONDS ? 'Watching the ship\'s events for about two minutes, then measuring the rest…' : 'Measuring…') : !this.facts ? 'The ship could not be measured. Check again in a moment.' :
      trouble ? `${trouble} thing${trouble === 1 ? '' : 's'} to look at.` : 'Nothing needs attention.';
    const recipe = this.target.planet ? `<section><h2>Recovery recipe</h2><p>How to back this ship up, restore it, and which runtime it must be started with, written with its real paths.</p><pre>${escape(recoveryRecipe(this.target.ship, this.target.planet.pier, this.facts?.command))}</pre><button data-action="recipe">Copy the recipe</button></section>` :
      '<section><h2>Recovery recipe</h2><p>This ship does not run on this computer, so its files cannot be read here. Ask whoever hosts it how it is backed up.</p></section>';
    this.panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);line-height:1.55;margin:0}main{max-width:820px;margin:auto;padding:32px}h1{font-size:28px;font-weight:500;margin-bottom:4px}h2{font-size:18px;font-weight:500;margin-top:32px}
ul{list-style:none;padding:0}li{display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--vscode-panel-border)}li p{margin:2px 0 0;color:var(--vscode-descriptionForeground)}.mark{width:1.4em;text-align:center;font-weight:600}
.warning .mark,.problem .mark{color:var(--vscode-errorForeground)}.ok .mark{color:var(--vscode-testing-iconPassed)}pre{white-space:pre-wrap;background:var(--vscode-textCodeBlock-background);padding:12px;border-radius:4px;font-size:12px}
button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:6px 14px;border-radius:2px;cursor:pointer}button:disabled{opacity:.5;cursor:default}</style></head><body><main>
<h1>Ship Doctor</h1><p role="status"><strong>${escape(this.target.ship)}</strong> · ${escape(summary)}</p><p>These are measurements, read once. Nothing on the ship is changed.</p>
<button data-action="again"${this.checking ? ' disabled' : ''}>Check again</button>${this.target.planet ? ` <button data-action="watch"${this.checking ? ' disabled' : ''}>Watch events for 2 minutes</button>` : ''}<ul aria-label="Findings">${rows}</ul>${recipe}
</main><script nonce="${nonce}">const api=acquireVsCodeApi();document.querySelectorAll('button[data-action]').forEach(b=>b.addEventListener('click',()=>{if(!b.disabled)api.postMessage({action:b.dataset.action});}));</script></body></html>`;
  }
  dispose(): void {this.closed = true; this.epoch++; this.panel?.dispose(); this.events.splice(0).forEach(e => e.dispose()); this.panel = undefined; this.facts = undefined;}
}
