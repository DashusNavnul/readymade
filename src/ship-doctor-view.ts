import * as vscode from 'vscode';
import {randomBytes} from 'node:crypto';
import type {LocalPlanet} from './planet-discovery';
import {doctorFindings, nativeFindings, recoveryRecipe, type DoctorFacts, type Finding} from './ship-doctor';
import {answerTime, bundledKelvin, EVENT_WATCH_SECONDS, gatherFacts} from './ship-doctor-probe';
import {storageInventory, storageSize, type StorageReading} from './ship-storage';
import {DownloadCleanup, type CleanupPreview} from './ship-storage-cleanup';

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
  /** The ship's own native diagnostics page (workers, queues, reviewers, storage, grants, recovery). */
  private native: Finding[] = [];
  private storage?: StorageReading[];
  private readonly cleanup: DownloadCleanup;
  private cleanupPreview?: CleanupPreview;
  private cleanupBusy = false;
  private cleanupNote = '';
  private checking = false;
  private watchSeconds = EVENT_WATCH_SECONDS;
  private closed = false;
  private epoch = 0;
  constructor(private readonly extensionPath: string, private readonly current: () => DoctorTarget | undefined,
    private readonly gather: (planet: LocalPlanet, extensionPath: string, watchSeconds?: number) => Promise<DoctorFacts> = gatherFacts,
    private readonly storageDirectory?: string,
    private readonly nativePage?: () => Promise<unknown>) {this.cleanup = new DownloadCleanup(extensionPath);}
  private findings(): Finding[] {return [...(this.facts ? doctorFindings(this.facts) : []), ...this.native];}
  get state(): {ship?: string; checking: boolean; findings: Finding[]} {return {ship: this.target?.ship, checking: this.checking, findings: this.findings()};}
  async show(): Promise<void> {
    if (this.closed) return;
    const target = this.current();
    if (!target) {void vscode.window.showInformationMessage('Connect a ship first; the doctor checks the ship this window is connected to.'); return;}
    if (this.target?.ship !== target.ship || this.target?.origin !== target.origin || this.target?.planet?.pier !== target.planet?.pier) {
      this.epoch++; this.checking = false; this.facts = undefined; this.storage = undefined; this.native = [];
    }
    this.target = target;
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel('readymade.doctor', 'Ship Doctor', vscode.ViewColumn.Active, {enableScripts: true, enableCommandUris: false, localResourceRoots: [], retainContextWhenHidden: true});
      this.panel = panel;
      this.events = [panel.onDidDispose(() => {if (this.panel === panel) {this.epoch++; this.panel = undefined; this.facts = undefined; this.storage = undefined; this.checking = false; this.events.splice(0).forEach(e => e.dispose());}}),
        panel.webview.onDidReceiveMessage((message: unknown) => {void this.receive(panel, message);})];
    } else this.panel.reveal();
    await this.check();
  }
  private async check(watchSeconds = EVENT_WATCH_SECONDS): Promise<void> {
    const target = this.target, panel = this.panel;
    if (!target || !panel || this.checking) return;
    const epoch = ++this.epoch; this.checking = true; this.storage = undefined; this.watchSeconds = watchSeconds; this.render();
    let facts: DoctorFacts | undefined;
    try {
      facts = target.planet ? await this.gather(target.planet, this.extensionPath, watchSeconds) :
        {ship: target.ship, httpMs: await answerTime(target.origin), bundledKelvin: await bundledKelvin(this.extensionPath)};
    } catch {facts = undefined;}
    if (this.closed || this.panel !== panel || this.epoch !== epoch) return;
    const storage = await storageInventory(target.planet?.pier, this.storageDirectory).catch(() => undefined);
    if (this.closed || this.panel !== panel || this.epoch !== epoch) return;
    // One read-only GET; a ship without the page (or not answering) adds nothing rather than a guess.
    const native = this.nativePage ? nativeFindings(await this.nativePage().catch(() => undefined), target.ship) : [];
    if (this.closed || this.panel !== panel || this.epoch !== epoch) return;
    this.facts = facts; this.storage = storage; this.native = native; this.checking = false; this.render();
  }
  private async receive(panel: vscode.WebviewPanel, message: unknown): Promise<void> {
    if (this.closed || panel !== this.panel || !message || typeof message !== 'object' || Array.isArray(message)) return;
    const row = message as Record<string, unknown>;
    if (typeof row.action !== 'string') return;
    if (row.action === 'cleanup-preview' && Object.keys(row).length === 1 ||
        row.action === 'cleanup-trash' && Object.keys(row).length === 2 && typeof row.id === 'string') {
      if (this.cleanupBusy || vscode.env.remoteName) return;
      this.cleanupBusy = true; this.cleanupNote = ''; this.render();
      try {
        if (row.action === 'cleanup-preview') this.cleanupPreview = await this.cleanup.preview();
        else {
          const folder = await this.cleanup.trash(row.id as string, async item => {
            const answer = await vscode.window.showWarningMessage('Move this verified download to Trash?', {modal: true,
              detail: `${item.file}\n\n${item.logicalBytes.toLocaleString()} bytes · SHA256 ${item.sha256}\n\nThe next package build will download it again. Space is not reclaimed until you empty Trash. A restore record stays beside the file. Ship data, runtimes, drafts, journals, evidence and signing state are excluded.`}, 'Move to Trash');
            return answer === 'Move to Trash' && !this.closed && this.panel === panel;
          });
          this.cleanupPreview = undefined;
          this.cleanupNote = folder ? `Moved to ${folder}. Space is not reclaimed until you empty Trash. Restore instructions are beside the download.` : 'Canceled. Nothing was moved.';
        }
      } catch (error) {this.cleanupPreview = undefined; this.cleanupNote = error instanceof Error ? error.message : 'Cleanup unavailable; nothing was retried.';}
      finally {this.cleanupBusy = false; this.render();}
      return;
    }
    if (Object.keys(row).length !== 1) return;
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
    const nonce = randomBytes(24).toString('base64'), findings = this.findings();
    const rows = findings.map(f => `<li class="${f.level}"><span class="mark" aria-hidden="true">${marks[f.level]}</span><div><strong>${escape(f.title)}</strong><p>${escape(f.detail)}</p></div></li>`).join('');
    const trouble = findings.filter(f => f.level === 'warning' || f.level === 'problem').length;
    const storage = `<section><h2>Storage</h2><p>Regular-file space allocated on this computer, read from file metadata. Sparse files use their allocated size. Shared blocks, snapshots and backups can make these figures differ from space recoverable by deleting files. No contents are read and nothing is deleted.</p>${this.storage ? '<ul>' + this.storage.map(row => `<li><div><strong>${escape(row.title)}</strong><p>${escape(storageSize(row))}</p><p>${escape(row.note)}</p>${row.roots.length ? `<details><summary>Counted locations</summary><pre>${escape(row.roots.join('\n'))}</pre></details>` : ''}</div></li>`).join('') + '</ul>' : '<p>Storage could not be measured.</p>'}</section>`;
    const cleanup = `<section><h2>Downloaded package files</h2><p>Preview checks only the editor ZIP and boot-pill download pinned by this package. It reads their bytes to verify them. Piers, runtime executables, source, drafts, journals, installation evidence, build stages and signing state are preserved.</p><p>Moving a download to Trash does not reclaim space until you empty Trash. Nothing is cleaned automatically.</p><button data-action="cleanup-preview"${this.cleanupBusy || !!vscode.env.remoteName ? ' disabled' : ''}>${this.cleanupBusy ? 'Checking…' : 'Preview disposable downloads'}</button>${this.cleanupNote ? `<p role="status">${escape(this.cleanupNote)}</p>` : ''}${this.cleanupPreview ? '<ul>' + this.cleanupPreview.items.map(item => `<li><div><strong>${escape(item.file)}</strong><p>${item.allocatedBytes === null ? 'Allocated size unknown' : (item.allocatedBytes / 1024 ** 2).toFixed(1) + ' MiB allocated'} · ${item.logicalBytes.toLocaleString()} file bytes</p><p>SHA256 ${escape(item.sha256)}</p><button data-action="cleanup-trash" data-id="${escape(item.id)}"${this.cleanupBusy ? ' disabled' : ''}>Move this download to Trash…</button></div></li>`).join('') + '</ul>' + this.cleanupPreview.notes.map(note => `<p>${escape(note)}</p>`).join('') : ''}</section>`;
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
<button data-action="again"${this.checking ? ' disabled' : ''}>Check again</button>${this.target.planet ? ` <button data-action="watch"${this.checking ? ' disabled' : ''}>Watch events for 2 minutes</button>` : ''}<ul aria-label="Findings">${rows}</ul>${storage}${cleanup}${recipe}
</main><script nonce="${nonce}">const api=acquireVsCodeApi();document.querySelectorAll('button[data-action]').forEach(b=>b.addEventListener('click',()=>{if(!b.disabled)api.postMessage({action:b.dataset.action,...(b.dataset.id?{id:b.dataset.id}:{})});}));</script></body></html>`;
  }
  dispose(): void {this.closed = true; this.epoch++; this.panel?.dispose(); this.events.splice(0).forEach(e => e.dispose()); this.panel = undefined; this.facts = undefined; this.storage = undefined;}
}
