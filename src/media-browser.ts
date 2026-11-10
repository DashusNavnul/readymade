import * as vscode from 'vscode';
import type { BrowserAdapter } from './media-controller';
import type { MediaClient } from './media-client';

/** Reuses the editor's native WebContentsView tabs, never a webview iframe. */
export class NativeMediaBrowser implements BrowserAdapter<vscode.BrowserTab> {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly editors = new WeakMap<vscode.BrowserTab, vscode.Tab>();
  private readonly companionEditors = new Set<vscode.Tab>();
  private readonly created = new Map<string, vscode.BrowserTab>();
  constructor(private readonly bridge: Pick<MediaClient, 'request'>, private readonly prepare?: (tab: vscode.BrowserTab) => Promise<void>) {}
  private pruneClosed(): void {
    for (const [url, tab] of this.created) if (this.isClosed(tab)) this.created.delete(url);
  }
  retained(url: string): vscode.BrowserTab | undefined {
    this.pruneClosed(); return this.created.get(url);
  }
  isActive(tab: vscode.BrowserTab): boolean { return vscode.window.activeBrowserTab === tab; }
  open(url: string): Promise<vscode.BrowserTab> {
    const result = this.queue.then(async () => {
      this.pruneClosed();
      if (typeof vscode.window.openBrowserTab !== 'function') throw new Error('This editor needs the Readymade browser integration enabled.');
      const config = vscode.workspace.getConfiguration('workbench.browser');
      const previous = config.inspect<string>('dataStorage')?.globalValue;
      const changed = config.get<string>('dataStorage') !== 'ephemeral';
      if (changed) await config.update('dataStorage', 'ephemeral', vscode.ConfigurationTarget.Global);
      let tab: vscode.BrowserTab;
      try {
        if (vscode.workspace.getConfiguration('workbench.browser').get<string>('dataStorage') !== 'ephemeral') throw new Error('Private media requires ephemeral browser storage; a workspace override is preventing it.');
        const previousEditors = new Set(vscode.window.tabGroups.all.flatMap(group => [...group.tabs]));
        for (const editor of this.companionEditors) if (!previousEditors.has(editor)) this.companionEditors.delete(editor);
        const companion = vscode.window.tabGroups.all.find(group => group.tabs.some(editor => this.companionEditors.has(editor)));
        tab = await vscode.window.openBrowserTab(url, { viewColumn: companion?.viewColumn ?? vscode.ViewColumn.Beside, preserveFocus: false });
        this.created.set(url, tab);
        // Opening beside an existing browser can leave that old browser active.
        // Focus the returned native identity before associating its editor handle.
        if (typeof tab.reveal === 'function') await tab.reveal();
        let editor: vscode.Tab | undefined;
        for (let n = 0; n < 100; n++) {
          const active = vscode.window.tabGroups.activeTabGroup.activeTab;
          if (vscode.window.activeBrowserTab === tab && active && !previousEditors.has(active)) { editor = active; break; }
          if (this.isClosed(tab)) break;
          await new Promise(r => setTimeout(r, 50));
        }
        if (!editor) throw new Error('The new browser editor could not be identified safely: ' + JSON.stringify({
          browserActive: vscode.window.activeBrowserTab === tab,
          editorPresent: !!vscode.window.tabGroups.activeTabGroup.activeTab,
          freshEditors: vscode.window.tabGroups.all.flatMap(group => [...group.tabs]).filter(item => !previousEditors.has(item)).length,
          activeFresh: !previousEditors.has(vscode.window.tabGroups.activeTabGroup.activeTab!)
        }));
        this.editors.set(tab, editor); this.companionEditors.add(editor);
        await vscode.commands.executeCommand('workbench.action.keepEditor');
        await this.awaitBootstrap(url, tab);
        await this.prepare?.(tab);
      } finally {
        if (changed && config.inspect<string>('dataStorage')?.globalValue === 'ephemeral') await config.update('dataStorage', previous, vscode.ConfigurationTarget.Global);
      }
      this.created.delete(url); return tab;
    });
    this.queue = result.catch(() => undefined); return result;
  }
  private async awaitBootstrap(url: string, tab: vscode.BrowserTab): Promise<void> {
    if (!/^about:blank#readymade-[a-f0-9]{32}$/.test(url)) throw new Error('Invalid private browser bootstrap.');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (this.isClosed(tab)) throw new Error('The private browser tab closed before native readiness.');
      let timer: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([this.bridge.request('status'), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Native browser readiness timed out. The new tab remains retained.')), Math.max(1, deadline - Date.now()));
        })]);
        if (Array.isArray(result.bootstrapViews)) {
          const matches = result.bootstrapViews.filter(row => row !== null && typeof row === 'object' && (row as { url?: unknown }).url === url);
          if (matches.length === 1 && (matches[0] as {bootstrapLoaded?: unknown}).bootstrapLoaded === true && !this.isClosed(tab)) return;
          if (matches.length > 1) throw new Error('More than one native browser matches this private bootstrap.');
        }
      } finally { if (timer) clearTimeout(timer); }
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
    throw new Error('Native browser readiness timed out. The new tab remains retained.');
  }
  async reveal(tab: vscode.BrowserTab): Promise<void> {
    if (!vscode.window.browserTabs.includes(tab)) throw new Error('This media tab was closed. Open a new tab explicitly.');
    if (typeof tab.reveal === 'function') { await tab.reveal(); return; }
    const groups = vscode.window.tabGroups.all;
    if (groups.length > 64 || groups.some(group => group.tabs.length > 512)) throw new Error('Too many editors to safely locate this app.');
    const rememberActive = (): boolean => {
      const editor = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (!editor || editor.input !== undefined || vscode.window.activeBrowserTab !== tab) return false;
      const previous = this.editors.get(tab);
      if (previous) this.companionEditors.delete(previous);
      this.editors.set(tab, editor); this.companionEditors.add(editor);
      return true;
    };
    // Moving to another group/window replaces Tab, but preserves BrowserTab.
    // Recover only by exact browser identity, never by a title or URL match.
    // Native window focus and extension-host tab updates arrive asynchronously.
    const deadline = Date.now() + 5000;
    const settle = async (check: () => boolean): Promise<void> => {
      while (!check()) {
        if (Date.now() >= deadline) throw new Error('Locating the retained app timed out; its page remains open.');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    if (rememberActive()) return;
    for (let groupIndex = 0; groupIndex < 64 && Date.now() < deadline; groupIndex++) {
      const group = vscode.window.tabGroups.activeTabGroup;
      await vscode.commands.executeCommand('workbench.action.firstEditorInGroup');
      if (group.tabs.length) await settle(() => group.activeTab === group.tabs[0]);
      for (let index = 0; index < group.tabs.length; index++) {
        if (Date.now() >= deadline) throw new Error('Locating the retained app timed out; its page remains open.');
        // Browser editors have no public Tab.input. Ordinary file editors cannot
        // match and must not each consume a browser-activation waiting period.
        if (group.activeTab?.input === undefined) {
          const activationDeadline = Math.min(deadline, Date.now() + 250);
          do {
            if (rememberActive()) return;
            await new Promise(resolve => setTimeout(resolve, 20));
          } while (Date.now() < activationDeadline);
        }
        if (index + 1 < group.tabs.length) {
          const next = group.tabs[index + 1];
          await vscode.commands.executeCommand('workbench.action.nextEditorInGroup');
          await settle(() => group.activeTab === next);
        }
      }
      if (vscode.window.tabGroups.all.length > 1) {
        await vscode.commands.executeCommand('workbench.action.focusNextGroup');
        // Native window focus can absorb this command while groups are moving.
        // Re-observe the current groups instead of spending the entire lookup
        // budget waiting for a transition that was never scheduled.
        const focusDeadline = Math.min(deadline, Date.now() + 250);
        while (vscode.window.tabGroups.activeTabGroup === group && vscode.window.tabGroups.all.length > 1 && !rememberActive() && Date.now() < focusDeadline) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        if (rememberActive()) return;
      } else {
        await settle(rememberActive);
        return;
      }
    }
    if (!rememberActive()) throw new Error('The retained media editor could not be revealed.');
  }

  async close(tab: vscode.BrowserTab): Promise<void> {
    try { if (!this.isClosed(tab)) await tab.close(); }
    catch (error) { if (vscode.window.browserTabs.includes(tab)) throw error; }
    this.pruneClosed();
  }
  isClosed(tab: vscode.BrowserTab): boolean { return !vscode.window.browserTabs.includes(tab); }
}
