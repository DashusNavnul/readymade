import * as vscode from 'vscode';
import { dirname, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { ShipClient, ShipClientError, readSavedCode } from './ship-client';
import { MediaClient } from './media-client';
import { MediaController, type MediaKind, type MediaRecord } from './media-controller';
import { NativeMediaBrowser } from './media-browser';
import { LegacyMedia, type LegacyMediaOwner } from './legacy-media';

export interface MediaTreeRow { label: string; id?: string; icon?: string; tooltip?: string; bindingId?: string; description?: string; command?: vscode.Command; children?: MediaTreeRow[] }
export class MediaWorkbench implements vscode.Disposable {
  readonly bridge: MediaClient;
  controller?: MediaController<vscode.BrowserTab>;
  private client?: ShipClient;
  private authenticatingClient?: ShipClient;
  private disposed = false;
  private ensureOpen(): void { if (this.disposed) throw new Error('This Readymade workspace is closed.'); }
  private clientConnecting?: Promise<ShipClient>;
  private connectingOrigin?: string;
  private readonly disposables: vscode.Disposable[] = [];
  private connecting?: Promise<MediaController<vscode.BrowserTab>>;
  private readonly lastApp = new Map<MediaKind, string>();
  private lastCode = vscode.window.activeTextEditor;
  private readonly navigation: { kind?: MediaKind; item: vscode.StatusBarItem }[] = [];
  private updateNavigation(): void {
    const active = this.controller?.state().find(state => state.active && !state.closed)?.kind;
    for (const {kind, item} of this.navigation) {
      const selected = kind ? kind === active : !!vscode.window.activeTextEditor;
      item.backgroundColor = selected ? new vscode.ThemeColor('statusBarItem.prominentBackground') : undefined;
    }
  }
  get connectedClient(): ShipClient | undefined { return this.client ?? this.currentClient(); }
  private releaseClient(): void { if (this.client !== this.currentClient()) this.client?.close(); this.client = undefined; }
  private rememberApp(): void {
    for (const state of this.controller?.state() ?? []) if (state.active && !state.closed) this.lastApp.set(state.kind, state.bindingId);
    this.updateNavigation(); this.changed();
  }
  constructor(private readonly context: vscode.ExtensionContext, private readonly currentClient: () => ShipClient | undefined, private readonly changed: () => void) {
    const globalStorage = dirname(context.globalStorageUri.fsPath), parent = dirname(globalStorage);
    if (basename(globalStorage) !== 'globalStorage') throw new Error('Unsupported editor profile storage layout.');
    let userDirectory: string;
    if (basename(parent) === 'User') userDirectory = parent;
    else if (basename(dirname(parent)) === 'profiles' && basename(dirname(dirname(parent))) === 'User') userDirectory = dirname(dirname(parent));
    else throw new Error('Unsupported editor profile storage layout.');
    const userData = dirname(userDirectory);
    this.bridge = new MediaClient(userData);
    const controls: { label: string; icon: string; command: string; kind?: MediaKind }[] = [
      {label: 'Code', icon: 'code', command: 'returnCode'},
      {label: 'Glurff', icon: 'globe', command: 'glurff', kind: 'glurff'},
      {label: 'Calls', icon: 'comment-discussion', command: 'noltbook', kind: 'noltbook'},
      {label: 'Landscape', icon: 'home', command: 'landscape', kind: 'landscape'}
    ];
    controls.forEach((control, index) => {
      const item = vscode.window.createStatusBarItem('readymade.' + control.command, vscode.StatusBarAlignment.Left, 1000 - index);
      item.name = 'Readymade ' + control.label; item.text = `$(${control.icon}) ${control.label}`;
      item.command = 'readymade.' + control.command;
      item.tooltip = control.kind === 'noltbook' ? 'Noltbook — notes and calls' : control.label;
      this.navigation.push({kind: control.kind, item}); this.disposables.push(item); item.show();
    });
    this.updateNavigation();
    const command = (name: string, action: (...args: unknown[]) => Promise<unknown>) => this.disposables.push(vscode.commands.registerCommand('readymade.' + name, async (...args: unknown[]) => {
      try { return await action(...args); }
      catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Media action failed'); throw error; }
      finally { this.changed(); }
    }));
    command('returnCode', async () => {
      const editor = this.lastCode;
      if (!editor || editor.document.isClosed) { await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup'); return; }
      await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, selection: editor.selection, preserveFocus: false });
    });
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor(editor => { if (editor) this.lastCode = editor; this.updateNavigation(); }));
    this.disposables.push(vscode.window.onDidChangeActiveBrowserTab(() => this.rememberApp()));
    this.disposables.push(vscode.window.onDidChangeBrowserTabState(() => this.rememberApp()));
    command('glurff', url => this.open('glurff', typeof url === 'string' ? url : undefined));
    command('noltbook', url => this.open('noltbook', typeof url === 'string' ? url : undefined));
    command('landscape', url => this.open('landscape', typeof url === 'string' ? url : undefined));
    command('calls', url => this.open('call', typeof url === 'string' ? url : undefined));
    command('mediaReveal', async id => { if (typeof id === 'string') await this.controller?.reveal(id); });
    command('mediaObserve', async row => { const id = await this.pick(row); if (id) await this.controller!.observe(id); });
    command('mediaReconnect', async row => {
      const id = await this.pick(row); if (!id) return;
      const choice = await vscode.window.showWarningMessage('Reconnect reloads this page and ends any call in it.', { modal: true }, 'Reconnect');
      if (choice === 'Reconnect') await this.controller!.reconnect(id);
    });
    command('mediaClose', async row => {
      const id = await this.pick(row); if (!id) return;
      const choice = await vscode.window.showWarningMessage('Close this media tab and end any call in it?', { modal: true }, 'Close Tab');
      if (choice === 'Close Tab') await this.controller!.close(id);
    });
    command('mediaForget', async () => {
      if (!this.controller) return;
      const choice = await vscode.window.showWarningMessage('Close these media tabs and forget their browser login?', { modal: true }, 'Disconnect Media');
      if (choice !== 'Disconnect Media') return;
      await this.controller.disconnect(); this.controller = undefined; this.releaseClient(); this.lastApp.clear();
    });
    command('legacyCalls', () => this.showExisting());
    this.disposables.push(vscode.window.onDidCloseBrowserTab(() => this.changed()));
    this.disposables.push(this.bridge.events.onOpen(event => { void this.controller?.handleOpen(event).then(() => this.rememberApp()).catch(() => { void vscode.window.showErrorMessage('The note link could not be opened. Its original media tab remains retained.'); }); }));
  }
  private async ready(): Promise<MediaController<vscode.BrowserTab>> {
    this.ensureOpen();
    if (this.controller) return this.controller;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    try { return await this.connecting; } finally { this.connecting = undefined; }
  }
  async connectClient(selected?: string, credentials?: (origin: string) => Promise<string | undefined>): Promise<ShipClient> {
    this.ensureOpen();
    const origin = selected ?? this.connectedClient?.origin ?? this.connectingOrigin ?? this.context.workspaceState.get<string>('readymade.origin') ?? vscode.workspace.getConfiguration('readymade').get<string>('origin') ?? 'http://localhost:8080';
    const candidate = new ShipClient(origin, credentials ?? (async o => await readSavedCode(o) ?? await this.context.secrets.get('code:' + o)));
    const existing = this.connectedClient;
    if (existing || this.clientConnecting) {
      candidate.close();
      if ((existing?.origin ?? this.connectingOrigin) !== candidate.origin) throw new Error('Open another Readymade window for a different ship; existing apps keep their connection.');
      return existing ?? this.clientConnecting!;
    }
    this.connectingOrigin = candidate.origin; this.authenticatingClient = candidate;
    this.clientConnecting = this.authenticate(candidate);
    try { return await this.clientConnecting; }
    finally { this.clientConnecting = undefined; this.connectingOrigin = undefined; this.authenticatingClient = undefined; }
  }
  private async authenticate(client: ShipClient): Promise<ShipClient> {
    try {
      try { await client.signIn(); }
      catch (error) {
        this.ensureOpen();
        if (!(error instanceof ShipClientError) || !['noSavedCode', 'authenticationRequired'].includes(error.code)) throw error;
        const code = await vscode.window.showInputBox({ title: 'Connect Readymade to Urbit', prompt: `Private login for ${client.origin}`, password: true, ignoreFocusOut: true });
        this.ensureOpen();
        if (!code) throw new Error('Ship login canceled');
        await this.context.secrets.store('code:' + client.origin, code); this.ensureOpen(); await client.signIn();
      }
      this.ensureOpen();
      await this.context.workspaceState.update('readymade.origin', client.origin);
      this.ensureOpen();
      this.client = client; this.changed(); return client;
    } catch (error) { client.close(); throw error; }
  }
  private async connect(): Promise<MediaController<vscode.BrowserTab>> {
    await this.bridge.request('status');
    const client = await this.connectClient(); this.ensureOpen();
    return this.controller = new MediaController({ client, bridge: this.bridge, browser: new NativeMediaBrowser(this.bridge) });
  }
  async open(kind: MediaKind, url?: string): Promise<MediaRecord> {
    const controller = await this.ready();
    if (this.currentClient() && this.currentClient()!.origin !== controller.origin) throw new Error('Disconnect the existing media tabs before switching ships.');
    const retained = url === undefined ? controller.state().filter(state => state.kind === kind && !state.closed) : [];
    const previous = retained.find(state => state.active) ?? retained.find(state => state.bindingId === this.lastApp.get(kind)) ?? retained.at(-1);
    if (previous) { await controller.reveal(previous.bindingId); this.lastApp.set(kind, previous.bindingId); this.changed(); return previous; }
    const state = await controller.open(kind, url); this.lastApp.set(kind, state.bindingId); this.changed();
    if (state.fault) void vscode.window.showWarningMessage(state.fault);
    return state;
  }
  private async pick(row?: unknown): Promise<string | undefined> {
    if (row !== undefined) {
      const id = typeof row === 'object' && row !== null && 'bindingId' in row ? row.bindingId : undefined;
      if (typeof id !== 'string' || !this.controller?.state().some(state => state.bindingId === id)) throw new Error('This app tab is no longer available.');
      return id;
    }
    const choices = (this.controller?.state() ?? []).map(s => ({ label: s.kind === 'call' ? 'Legacy Call Board' : s.kind === 'noltbook' ? 'Noltbook and Calls' : s.kind === 'landscape' ? 'Landscape' : 'Glurff', description: s.phase + ' · ' + s.url, id: s.bindingId }));
    if (!choices.length) { void vscode.window.showInformationMessage('No Readymade media tabs are open.'); return; }
    return (await vscode.window.showQuickPick(choices, { title: 'Choose a retained media tab' }))?.id;
  }
  rows(): MediaTreeRow[] {
    const rows: MediaTreeRow[] = [
      { id: 'code', label: 'Code', icon: 'code', command: { title: 'Return to Code', command: 'readymade.returnCode' } },
      { id: 'glurff', label: 'Glurff', icon: 'globe', tooltip: 'Your shared world, kept open beside your code', command: { title: 'Glurff', command: 'readymade.glurff' } },
      { id: 'noltbook', label: 'Calls', icon: 'comment-discussion', tooltip: 'Noltbook — notes and calls', command: { title: 'Noltbook', command: 'readymade.noltbook' } },
      { id: 'landscape', label: 'Landscape', icon: 'home', tooltip: 'Your ship’s apps, beside your code', command: { title: 'Landscape', command: 'readymade.landscape' } }
    ];
    const retained = (this.controller?.state() ?? []).filter(state => !state.closed).map(state => ({
      id: state.bindingId, bindingId: state.bindingId,
      label: state.title?.trim().slice(0, 100) || (state.kind === 'glurff' ? 'Glurff' : state.kind === 'noltbook' ? 'Noltbook' : state.kind === 'landscape' ? 'Landscape' : 'Legacy Call Board'),
      icon: state.kind === 'glurff' ? 'globe' : state.kind === 'noltbook' ? 'comment-discussion' : state.kind === 'landscape' ? 'home' : 'device-camera-video',
      description: state.fault ?? (state.active ? 'Active' : state.ready ? 'Open' : state.phase), tooltip: state.url,
      command: { title: 'Return to app', command: 'readymade.mediaReveal', arguments: [state.bindingId] }
    }));
    if (retained.length) rows.push({ id: 'open-apps', label: 'Open apps', children: retained });
    return rows;
  }

  private async showExisting(): Promise<void> {
    const configured = vscode.workspace.getConfiguration('readymade').get<string>('legacyMediaSocket');
    const paths = configured ? [configured] : [join(homedir(), '.cache/readymade/control.sock'), join(homedir(), '.cache/readymade/org.pataphor.desktop.nativeworkspace/control.sock')].filter(existsSync);
    const owners: { label: string; owner: LegacyMedia }[] = [];
    for (const socketPath of paths) {
      const owner = new LegacyMedia({ socketPath, revealExisting: value => this.revealExisting(value) });
      try { const info = await owner.inspect(); if (info) owners.push({ label: info.title ?? info.origin ?? socketPath, owner }); } catch { /* A stale owner is never started or replaced. */ }
    }
    if (!owners.length) throw new Error('No existing native media owner is running. Its socket can be selected in Readymade settings.');
    const selected = owners.length === 1 ? owners[0] : await vscode.window.showQuickPick(owners, { title: 'Reveal the existing call owner without reloading it' });
    await selected?.owner.show();
  }
  private async revealExisting(owner: LegacyMediaOwner): Promise<void> {
    const folder = basename(dirname(owner.socketPath));
    const id = folder === 'readymade' ? 'org.pataphor.desktop' : folder;
    if (!/^org\.pataphor\.desktop(?:\.[a-z0-9.-]+)?$/.test(id)) throw new Error('This socket is not bound to a known native Readymade application.');
    const script = `if application id "${id}" is running then\n tell application id "${id}" to activate\nelse\n error "Existing native owner stopped"\nend if`;
    await new Promise<void>((resolve, reject) => execFile('/usr/bin/osascript', ['-e', script], { timeout: 5000 }, error => error ? reject(new Error('The existing native application could not be revealed.')) : resolve()));
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.authenticatingClient?.close();
    // Browser documents retain their media owners until the user closes them.
    this.disposables.forEach(d => d.dispose()); this.bridge.close(); this.releaseClient();
  }
}
