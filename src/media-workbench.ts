import * as vscode from 'vscode';
import { dirname, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { ShipClient, ShipClientError, readSavedCode } from './ship-client';
import { MediaClient } from './media-client';
import { MediaController, type MediaKind, type MediaRecord } from './media-controller';
import { NativeMediaBrowser } from './media-browser';
import { LegacyMedia, type LegacyMediaOwner } from './legacy-media';
import { CallNotificationFeed, type CallNotice } from './call-notifications';
import { ComposerJournal, attachComposerJournal } from './composer-journal';
import {authenticateShip, normalizeShipAddress, switchTarget, type SwitchTarget, connectionFailureMessage, automaticShip, lastShip, type LastShip} from './ship-connection';
import {discoverLocalPlanets, recheckLocalPlanet, slowShipNotice, type LocalPlanet} from './planet-discovery';
import {queryLoginCode} from './planet-discovery-wire';

export interface MediaTreeRow { label: string; id?: string; icon?: string; tooltip?: string; bindingId?: string; description?: string; command?: vscode.Command; children?: MediaTreeRow[] }
interface SelectedOrigin {origin: string; planet?: LocalPlanet}
const SWITCH_KEY = 'readymade.switchTo';
interface PlanetChoice extends vscode.QuickPickItem {planet?: LocalPlanet; operation?: 'manual' | 'refresh'}
export class MediaWorkbench implements vscode.Disposable {
  readonly bridge: MediaClient;
  controller?: MediaController<vscode.BrowserTab>;
  private client?: ShipClient;
  private authenticatingClient?: ShipClient;
  private disposed = false;
  private callFeed?: CallNotificationFeed;
  private ensureOpen(): void { if (this.disposed) throw new Error('This Readymade workspace is closed.'); }
  private clientConnecting?: Promise<ShipClient>;
  private localPlanet?: LocalPlanet;
  private connectingOrigin?: string;
  private selectingOrigin?: Promise<SelectedOrigin | undefined>;
  private discovered: LocalPlanet[] = [];
  private scanCount = 0;
  private scanning = false;
  private scanReport?: Awaited<ReturnType<typeof discoverLocalPlanets>>;
  get localDiscoveryStatus() {return {scans: this.scanCount, checking: this.scanning, selecting: !!this.selectingOrigin,
    connecting: !!this.clientConnecting, found: this.scanReport?.planets.length, unavailable: this.scanReport?.unavailable,
    diagnostics: this.scanReport?.diagnostics};}
  get localPlanets(): readonly {ship: string; origin: string}[] {return this.discovered.map(({ship, origin}) => ({ship, origin}));}
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
  /** The verified ship on this computer behind the current connection, when it was chosen from the running-ship list. */
  get connectedLocalPlanet(): LocalPlanet | undefined { return this.client ? this.localPlanet : undefined; }
  private releaseClient(): void {
    const client = this.client, feed = this.callFeed; this.callFeed = undefined; this.client = undefined; this.localPlanet = undefined;
    void (feed?.close() ?? Promise.resolve()).finally(() => { if (client !== this.currentClient()) client?.close(); });
  }
  private watchCalls(client: ShipClient): void {
    if (this.disposed || this.callFeed || !vscode.workspace.getConfiguration('readymade').get<boolean>('callNotifications', true)) return;
    try {
      const feed = new CallNotificationFeed(client, notice => { void this.incomingCall(feed, client, notice); }, () => {
        if (this.disposed || this.callFeed !== feed) return;
        void vscode.window.showWarningMessage('Call notifications disconnected. Open Calls or reconnect notifications.', 'Reconnect Notifications').then(choice => {
          if (choice === 'Reconnect Notifications' && !this.disposed && this.callFeed === feed) {
            this.callFeed = undefined; this.watchCalls(client);
          }
        });
      });
      this.callFeed = feed; void feed.start().catch(() => undefined);
    } catch { /* App-only connections can remain usable without a Noltbook subscription. */ }
  }
  private async incomingCall(feed: CallNotificationFeed, client: ShipClient, notice: CallNotice): Promise<void> {
    const choice = await vscode.window.showInformationMessage(`Noltbook call from ${notice.participants[0]}.`, 'Open Call');
    if (choice !== 'Open Call' || this.disposed || this.callFeed !== feed || this.connectedClient !== client) return;
    if (!feed.current(notice)) { void vscode.window.showInformationMessage('That call has ended.'); return; }
    try { await this.open('noltbook', client.origin + '/apps/noltbook/?note=' + encodeURIComponent(notice.noteId)); }
    catch { void vscode.window.showWarningMessage('The call could not open. Use Calls to inspect the current state.'); }
  }
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
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('readymade.callNotifications')) return;
      const feed = this.callFeed; this.callFeed = undefined;
      void (feed?.close() ?? Promise.resolve()).then(() => { if (this.connectedClient) this.watchCalls(this.connectedClient); });
    }));
    const controls: { label: string; icon: string; command: string; kind?: MediaKind }[] = [
      {label: 'Code', icon: 'code', command: 'returnCode'},
      {label: 'Groups', icon: 'organization', command: 'groups', kind: 'groups'},
      {label: 'Lattice', icon: 'notebook', command: 'lattice', kind: 'lattice'},
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
      catch (error) { if (error instanceof ShipClientError && error.code === 'cancelled') return; void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Media action failed'); throw error; }
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
    command('groups', url => this.open('groups', typeof url === 'string' ? url : undefined));
    command('lattice', url => this.open('lattice', typeof url === 'string' ? url : undefined));
    command('noltbook', url => this.open('noltbook', typeof url === 'string' ? url : undefined));
    command('landscape', url => this.open('landscape', typeof url === 'string' ? url : undefined));
    command('calls', url => this.open('call', typeof url === 'string' ? url : undefined));
    command('mediaReveal', async id => { if (typeof id === 'string') await this.controller?.reveal(id); });
    command('mediaObserve', async row => {
      const id = await this.pick(row); if (!id) return;
      await this.controller!.observe(id);
      const status = await this.bridge.request('status');
      const permissions = status.systemMediaPermissions;
      if (permissions && typeof permissions === 'object' && !Array.isArray(permissions)) {
        const values = permissions as Record<string, unknown>;
        const states = ['camera', 'microphone', 'screen'].map(kind => {
          const value = values[kind];
          return `${kind}: ${typeof value === 'string' && ['not-determined', 'granted', 'denied', 'restricted', 'unknown'].includes(value) ? value : 'unavailable'}`;
        });
        void vscode.window.showInformationMessage(`System access — ${states.join('; ')}. Website permission is separate; use the browser tab's site controls.`);
      }
    });
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
  /**
   * One window holds one ship. Switching picks another of your ships with the same list Connect shows, remembers
   * the choice and reloads this window onto it; everything the old ship was doing stays on that ship. Returns
   * false when nothing was chosen or the choice is the ship already connected.
   */
  async switchShip(): Promise<boolean> {
    this.ensureOpen();
    const current = this.connectedClient?.origin;
    this.selectingOrigin ??= this.pickOrigin(current ?? this.context.workspaceState.get<string>('readymade.origin'));
    let choice: SelectedOrigin | undefined;
    try {choice = await this.selectingOrigin;} finally {this.selectingOrigin = undefined;}
    this.ensureOpen();
    if (!choice) return false;
    const origin = normalizeShipAddress(choice.origin);
    if (origin === current) {void vscode.window.showInformationMessage('This window is already connected to that ship.'); return false;}
    const name = choice.planet?.ship ?? new URL(origin).host;
    if (current && (await vscode.window.showWarningMessage(`Switch this window to ${name}?`, {modal: true,
      detail: 'The window reloads onto the other ship. Anything running on the current ship keeps running there, and its drafts stay saved.'}, 'Switch')) !== 'Switch') return false;
    this.ensureOpen();
    await this.context.workspaceState.update(SWITCH_KEY, switchTarget({origin, ...(choice.planet ? {ship: choice.planet.ship} : {})}));
    if (!current) return true; // nothing to tear down: the caller connects now
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
    return true;
  }
  /** The connected ship, when it runs on this computer and now answers at another address than this window uses. */
  async findMoved(): Promise<{ship: string; origin: string} | undefined> {
    const client = this.connectedClient;
    try {
      if (!client || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(client.origin).hostname)) return undefined;
      const ship = client.browserCookies(client.origin)[0]?.name.slice('urbauth-'.length) ?? this.context.workspaceState.get<string>('readymade.ship:' + client.origin);
      if (!ship) return undefined;
      const found = (await discoverLocalPlanets()).planets.filter(p => p.ship === ship && p.origin !== client.origin);
      return found.length === 1 ? {ship, origin: found[0].origin} : undefined;
    } catch {return undefined;}
  }
  /** Reload this window onto a known address of one of your ships. */
  async switchTo(origin: string, ship?: string): Promise<void> {
    this.ensureOpen();
    await this.context.workspaceState.update(SWITCH_KEY, switchTarget({origin: normalizeShipAddress(origin), ...(ship ? {ship} : {})}));
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
  /**
   * After a switch reload: the ship to connect, read once and cleared. A ship that ran on this computer is found
   * again in the running-ship list so it still signs in by itself; if it is no longer there, its saved code is used.
   */
  async takeSwitch(): Promise<SelectedOrigin | undefined> {
    const raw = this.context.workspaceState.get<unknown>(SWITCH_KEY);
    if (raw === undefined) return undefined;
    await this.context.workspaceState.update(SWITCH_KEY, undefined);
    let target: SwitchTarget; try {target = switchTarget(raw);} catch {return undefined;}
    if (!target.ship) return {origin: target.origin};
    try {
      const planet = (await discoverLocalPlanets()).planets.find(p => p.ship === target.ship && p.origin === target.origin);
      return planet ? {origin: target.origin, planet: await recheckLocalPlanet(planet)} : {origin: target.origin};
    } catch {return {origin: target.origin};}
  }
  /**
   * The ship last connected, kept in one small private file that is written at once. The editor's own state
   * store is flushed late and lost when the app is killed (measured: connect, kill, reopen forgot the ship).
   */
  private lastFile(): string {return join(this.context.globalStorageUri.fsPath, 'last-ship.json');}
  private readLast(): LastShip | undefined {
    try {return lastShip(JSON.parse(readFileSync(this.lastFile(), 'utf8')));} catch {return undefined;}
  }
  private writeLast(value: LastShip): void {
    try {
      const file = this.lastFile(); mkdirSync(dirname(file), {recursive: true, mode: 0o700});
      writeFileSync(file + '.new', JSON.stringify(value), {mode: 0o600}); renameSync(file + '.new', file);
    } catch { /* not remembered: the next launch asks, which is safe */ }
  }
  /**
   * A ship on this computer is connected without a question whenever the choice is clear: the ship a link
   * names, the ship last used here, or the only one running. It signs in with the code the ship itself supplies.
   */
  private async automatic(wanted?: string): Promise<SelectedOrigin | undefined> {
    try {
      const running = (await discoverLocalPlanets()).planets;
      const planet = automaticShip(running, wanted, this.readLast()?.ship);
      return planet ? {origin: planet.origin, planet: await recheckLocalPlanet(planet)} : undefined;
    } catch {return undefined;}
  }
  /**
   * When the app opens: connect without asking anything. A ship on this computer is taken when the choice is
   * clear (the one last used, found again by name since its port may have changed, or the only one running,
   * which covers the very first launch) and signs in by itself; a hosted one last used here signs in with the
   * code saved in the Keychain. If none of that is possible right now, nothing happens and nothing is asked.
   */
  async reconnectLast(): Promise<{client: ShipClient; first: boolean} | undefined> {
    // Off with the setting, and in the app's own window tests, which must start from nothing connected.
    if (!vscode.workspace.getConfiguration('readymade').get<boolean>('connectOnStart', true) || process.env.READYMADE_NO_AUTO_CONNECT === '1') return undefined;
    const last = this.readLast();
    if (this.connectedClient || this.clientConnecting || this.disposed) return undefined;
    try {
      if (last && !last.local) return {client: await this.connectClient(normalizeShipAddress(last.origin), undefined, undefined, undefined, true), first: false};
      // The very first time too: when exactly one ship is running on this computer there is nothing to choose.
      const found = await this.automatic();
      return found ? {client: await this.connectClient(found.origin, undefined, found.planet, undefined, true), first: !last} : undefined;
    } catch {return undefined;}
  }
  async connectClient(selected?: string, credentials?: (origin: string) => Promise<string | undefined>, planet?: LocalPlanet, wanted?: string, silent = false): Promise<ShipClient> {
    this.ensureOpen();
    const configured = vscode.workspace.getConfiguration('readymade').inspect<string>('origin');
    const remembered = this.context.workspaceState.get<string>('readymade.origin') ?? configured?.workspaceFolderValue ?? configured?.workspaceValue ?? configured?.globalValue;
    let address = selected ?? this.connectedClient?.origin ?? this.connectingOrigin, expectedShip: string | undefined = planet?.ship, local: LocalPlanet | undefined = planet;
    if (!address) {
      // No question when the choice is clear; the list only when it is not.
      let asked = false;
      this.selectingOrigin ??= this.automatic(wanted).then(found => found ?? (asked = true, this.pickOrigin(remembered)));
      let choice: SelectedOrigin | undefined;
      try {choice = await this.selectingOrigin;} finally {this.selectingOrigin = undefined;}
      this.ensureOpen();
      if (!choice) throw new ShipClientError('cancelled');
      address = choice.origin; expectedShip = choice.planet?.ship; local = choice.planet;
      // Say which ship was taken without asking, and how to choose another.
      if (!asked && choice.planet && !silent) void vscode.window.setStatusBarMessage(`Connecting ${choice.planet.ship}, the ship running on this Mac. “Readymade: Switch Ship…” chooses another.`, 8000);
    }
    const origin = normalizeShipAddress(address);
    // An address on this computer given as text (a remembered one, a link) is still a local ship: find it, so it
    // signs in by itself instead of asking for a login code.
    if (!local && !this.connectedClient && !this.clientConnecting && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) {
      try {
        const found = (await discoverLocalPlanets()).planets.find(row => row.origin === origin && (!expectedShip || row.ship === expectedShip));
        if (found) {local = await recheckLocalPlanet(found); expectedShip = local.ship;}
      } catch { /* falls back to the saved code, then the private prompt */ }
      this.ensureOpen();
    }
    const existing = this.connectedClient;
    if (existing || this.clientConnecting) {
      if ((existing?.origin ?? this.connectingOrigin) !== origin) throw new Error('This window is connected to another ship. Use “Readymade: Switch Ship…” to move it, or open another Readymade window; existing apps keep their connection.');
      const shared = existing ?? await this.clientConnecting!;
      this.ensureOpen();
      if (expectedShip && shared.browserCookies(origin)[0]?.name !== 'urbauth-' + expectedShip) throw Error('The selected ship changed. Refresh the running-ship list.');
      return shared;
    }
    this.connectingOrigin = origin;
    this.clientConnecting = this.authenticate(origin, credentials, expectedShip, local, silent);
    try { return await this.clientConnecting; }
    finally { this.clientConnecting = undefined; this.connectingOrigin = undefined; this.authenticatingClient = undefined; }
  }
  private async pickOrigin(remembered?: string): Promise<SelectedOrigin | undefined> {
    for (;;) {
      this.ensureOpen(); this.discovered = []; this.scanCount++; this.scanning = true; this.scanReport = undefined;
      const choices = discoverLocalPlanets().then(result => {
        this.ensureOpen(); this.discovered = result.planets; this.scanReport = result;
        return [...result.planets.map(planet => ({label: planet.ship, description: new URL(planet.origin).host,
          detail: 'Running on this computer. Signs in for you.', planet})),
        {label: 'Enter a ship’s web address', description: 'For hosted ships or another computer', operation: 'manual'},
        {label: 'Refresh running ships', detail: slowShipNotice(result.diagnostics), operation: 'refresh'}] as PlanetChoice[];
      }).finally(() => {this.scanning = false;});
      const choice = await vscode.window.showQuickPick<PlanetChoice>(choices, {title: 'Connect your Urbit',
        placeHolder: 'Choose a running ship, or connect by web address', ignoreFocusOut: true, matchOnDescription: true});
      this.ensureOpen();
      if (!choice) return undefined;
      if (choice.operation === 'refresh') continue;
      if (choice.planet) {const planet = await recheckLocalPlanet(choice.planet); this.ensureOpen(); return {origin: planet.origin, planet};}
      const address = await vscode.window.showInputBox({title: 'Connect by web address', value: remembered,
        prompt: 'Your ship’s web address. You’ll enter its login code privately next.', placeHolder: 'your-ship.example or localhost:8080', ignoreFocusOut: true,
        validateInput: value => {try {normalizeShipAddress(value); return undefined;} catch (error) {return error instanceof Error ? error.message : 'Enter your ship’s web address.';}}});
      this.ensureOpen(); return address ? {origin: normalizeShipAddress(address)} : undefined;
    }
  }
  /**
   * A ship chosen from the running-ship list was just verified on this computer, so ask it for its own
   * login code instead of sending a newcomer to its terminal for +code. Read fresh each time, never
   * stored; any failure falls through to the saved code and then the private prompt.
   */
  private async localCode(local: LocalPlanet): Promise<string | undefined> {
    try {return await queryLoginCode(join(local.pier, '.urb/conn.sock'));} catch {return undefined;}
  }
  private async authenticate(origin: string, credentials?: (origin: string) => Promise<string | undefined>, expectedShip?: string, local?: LocalPlanet, silent = false): Promise<ShipClient> {
    let client: ShipClient | undefined;
    try {
      client = await authenticateShip(origin, {
        expectedShip,
        readCode: credentials ?? (async address => (local && await this.localCode(local)) || (await this.context.secrets.get('code:' + address) ?? await readSavedCode(address))),
        askCode: async (address, rejected) => silent ? undefined : vscode.window.showInputBox({title: rejected ? 'Try your Urbit login code again' : 'Sign in to your Urbit',
          prompt: `${rejected ? 'That code wasn’t accepted. ' : ''}Private login for ${address}`, password: true, ignoreFocusOut: true}),
        saveCode: async (address, code) => this.context.secrets.store('code:' + address, code),
        ensureOpen: () => this.ensureOpen(), onClient: value => {this.authenticatingClient = value;},
      });
      this.ensureOpen();
      await this.context.workspaceState.update('readymade.origin', client.origin);
      const signedIn = client.browserCookies(client.origin)[0]?.name.slice('urbauth-'.length);
      if (signedIn) await this.context.workspaceState.update('readymade.ship:' + client.origin, signedIn);
      if (signedIn) this.writeLast({ship: signedIn, origin: client.origin, local: !!local});
      this.ensureOpen();
      this.client = client; this.localPlanet = local; this.watchCalls(client); this.changed(); return client;
    } catch (error) {
      client?.close();
      if (error instanceof ShipClientError && error.code === 'transport' && error.detail === 'down') await this.explainMoved(origin, expectedShip, error);
      throw error;
    }
  }
  /**
   * Nothing answered at a local address. If the ship that was last signed in there is running on this computer at
   * another port (ports change when ships restart in a different order), say so instead of "could not reach".
   */
  private async explainMoved(origin: string, expectedShip: string | undefined, error: ShipClientError): Promise<void> {
    try {
      if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) return;
      const ship = expectedShip ?? this.context.workspaceState.get<string>('readymade.ship:' + origin);
      if (!ship) return;
      const found = (await discoverLocalPlanets()).planets.filter(p => p.ship === ship && p.origin !== origin);
      if (found.length !== 1 || this.disposed) return;
      error.message = connectionFailureMessage(origin, 'down', {ship, origin: found[0].origin});
      await this.context.workspaceState.update('readymade.origin', found[0].origin);
      error.message += ' Connect again to use it.';
    } catch { /* the plain "nothing is answering" message stands */ }
  }
  private async connect(): Promise<MediaController<vscode.BrowserTab>> {
    await this.bridge.request('status');
    const client = await this.connectClient(); this.ensureOpen();
    const cookies = client.browserCookies(client.origin);
    if (cookies.length !== 1 || !/^urbauth-~[a-z-]{3,128}$/.test(cookies[0].name)) throw new Error('Composer backup identity unavailable.');
    const journal = new ComposerJournal(join(this.context.globalStorageUri.fsPath, 'composer-drafts'), client.origin, cookies[0].name.slice('urbauth-~'.length));
    const browser = new NativeMediaBrowser(this.bridge, async tab => {
      this.disposables.push(await attachComposerJournal(tab, journal, () => {
        void vscode.window.showWarningMessage('Composer draft backup failed. Copy unsent text before closing this pane.');
      }));
    });
    return this.controller = new MediaController({ client, bridge: this.bridge, browser });
  }
  async open(kind: MediaKind, url?: string, expected?: {client: ShipClient; peer: string}): Promise<MediaRecord> {
    const check = () => {
      if (!expected) return;
      const cookies = expected.client.browserCookies(expected.client.origin);
      if (this.connectedClient !== expected.client || cookies.length !== 1 || cookies[0].name !== 'urbauth-' + expected.peer) throw new Error('Document connection changed.');
    };
    check();
    const controller = await this.ready();
    check();
    if (expected && controller.origin !== expected.client.origin) throw new Error('Document origin changed.');
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
    const choices = (this.controller?.state() ?? []).map(s => ({ label: s.kind === 'call' ? 'Legacy Call Board' : s.kind === 'noltbook' ? 'Noltbook and Calls' : s.kind === 'landscape' ? 'Landscape' : s.kind === 'groups' ? 'Tlon Groups' : s.kind === 'lattice' ? 'Lattice' : 'Glurff', description: s.phase + ' · ' + s.url, id: s.bindingId }));
    if (!choices.length) { void vscode.window.showInformationMessage('No Readymade media tabs are open.'); return; }
    return (await vscode.window.showQuickPick(choices, { title: 'Choose a retained media tab' }))?.id;
  }
  rows(): MediaTreeRow[] {
    const rows: MediaTreeRow[] = [
      { id: 'code', label: 'Code', icon: 'code', command: { title: 'Return to Code', command: 'readymade.returnCode' } },
      { id: 'groups', label: 'Groups', icon: 'organization', tooltip: 'Tlon groups and channels, kept open beside your code', command: { title: 'Tlon Groups', command: 'readymade.groups' } },
      { id: 'lattice', label: 'Lattice', icon: 'notebook', tooltip: 'Lattice reader and editor, kept open beside your code', command: { title: 'Lattice', command: 'readymade.lattice' } },
      { id: 'glurff', label: 'Glurff', icon: 'globe', tooltip: 'Your shared world, kept open beside your code', command: { title: 'Glurff', command: 'readymade.glurff' } },
      { id: 'noltbook', label: 'Calls', icon: 'comment-discussion', tooltip: 'Noltbook — notes and calls', command: { title: 'Noltbook', command: 'readymade.noltbook' } },
      { id: 'landscape', label: 'Landscape', icon: 'home', tooltip: 'Your ship’s apps, beside your code', command: { title: 'Landscape', command: 'readymade.landscape' } }
    ];
    const retained = (this.controller?.state() ?? []).filter(state => !state.closed).map(state => ({
      id: state.bindingId, bindingId: state.bindingId,
      label: state.title?.trim().slice(0, 100) || (state.kind === 'glurff' ? 'Glurff' : state.kind === 'noltbook' ? 'Noltbook' : state.kind === 'landscape' ? 'Landscape' : state.kind === 'groups' ? 'Tlon Groups' : state.kind === 'lattice' ? 'Lattice' : 'Legacy Call Board'),
      icon: state.kind === 'glurff' ? 'globe' : state.kind === 'noltbook' ? 'comment-discussion' : state.kind === 'landscape' ? 'home' : state.kind === 'groups' ? 'organization' : state.kind === 'lattice' ? 'notebook' : 'device-camera-video',
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
