import * as vscode from 'vscode';
import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { ShipClient } from './ship-client';
import { JsonObject, asRecord } from './protocol';
import { SourceStore, SourceDescriptor } from './source-store';
import { SourceProvider } from './source-provider';
import { DraftStore } from './draft-store';
import { DraftProvider } from './draft-provider';
import { ConversationStore } from './conversation-store';
import { ConversationView } from './conversation-view';
import { ShipTerminalSession, terminalApps } from './terminal-session';
import { ShipTerminalView } from './terminal-view';
import { MediaWorkbench, type MediaTreeRow } from './media-workbench';
import { WorkspaceRequestView } from './workspace-request-view';
import { installLandscapeCommand } from './landscape-command';

type Row = MediaTreeRow;
class WorkspaceTree implements vscode.TreeDataProvider<Row> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  rows: Row[] = [{ label: 'Connect to your ship', command: { command: 'readymade.connect', title: 'Connect' } }];
  getTreeItem(row: Row): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, row.children ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = row.id; item.description = row.description; item.command = row.command;
    item.contextValue = row.bindingId ? 'readymade.media' : undefined;
    item.iconPath = row.icon ? new vscode.ThemeIcon(row.icon) : undefined;
    item.tooltip = row.tooltip ?? row.description; return item;
  }
  getChildren(row?: Row): Row[] { return row?.children ?? this.rows; }
  refresh(): void { this.changed.fire(); }
  dispose(): void { this.changed.dispose(); }
}

export class ReadymadeWorkspace implements vscode.Disposable {
  readonly media: MediaWorkbench;
  readonly workspaceRequests: WorkspaceRequestView;
  client?: ShipClient;
  sources?: SourceStore;
  readonly drafts: DraftStore;
  journal?: ConversationStore;
  snapshot?: JsonObject;
  readonly terminals = new Map<vscode.Terminal, ShipTerminalView>();
  private readonly tree = new WorkspaceTree();
  private readonly conversation = new ConversationView();
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly registrations: vscode.Disposable[] = [];
  private sourceRegistration?: vscode.Disposable;
  private connecting = false;
  private selectedSession = '0x0';
  private selectedProject?: string;
  get project(): string | undefined { return this.selectedProject; }
  async enableTerminalCommand(): Promise<void> {
    const uri = vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: this.context.extension.id, path: '/landscape' });
    this.registrations.push(vscode.window.registerUriHandler({ handleUri: async incoming => {
      if (incoming.toString() !== uri.toString()) return;
      try { await this.media.open('landscape'); }
      catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Landscape could not open.'); }
    } }));
    const candidates = [join(vscode.env.appRoot, '../../../../../MacOS/ReadymadeCLI'), join(vscode.env.appRoot, 'bin/codium'), join(vscode.env.appRoot, 'bin/code')];
    const cli = candidates.find(existsSync);
    if (!cli) throw new Error('Editor command-line launcher is unavailable.');
    await mkdir(this.context.globalStorageUri.fsPath, { recursive: true, mode: 0o700 });
    const bin = await installLandscapeCommand(await realpath(this.context.globalStorageUri.fsPath), await realpath(cli), await realpath(this.media.bridge.directory), uri.toString());
    const environment = this.context.environmentVariableCollection;
    environment.persistent = false; environment.description = 'Adds landscape to open the retained Landscape app tab.';
    environment.prepend('PATH', bin + delimiter);
    this.registrations.push({ dispose: () => environment.clear() });
  }
  constructor(private readonly context: vscode.ExtensionContext) {
    this.media = new MediaWorkbench(context, () => this.client, () => this.render());
    this.workspaceRequests = new WorkspaceRequestView(context, () => this.render(), session => this.refresh(session));
    this.drafts = new DraftStore(join(context.globalStorageUri.fsPath, 'drafts'));
    this.registrations.push(vscode.workspace.registerFileSystemProvider('readymade-draft', new DraftProvider(this.drafts), { isCaseSensitive: true }));
    this.registrations.push(vscode.window.registerTreeDataProvider('readymade.workspace', this.tree));
    this.registrations.push(vscode.window.onDidCloseTerminal(t => { this.terminals.get(t)?.close(); this.terminals.delete(t); }));
    this.status.text = '$(plug) Connect'; this.status.command = 'readymade.connect'; this.status.show();
    const command = (name: string, handler: (...args: unknown[]) => unknown) => this.registrations.push(vscode.commands.registerCommand('readymade.' + name, async (...args: unknown[]) => {
      try { return await handler(...args); } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Readymade operation failed'); throw error; }
    }));
    command('connect', origin => this.connect(typeof origin === 'string' ? origin : undefined));
    command('refresh', () => this.refresh());
    command('selectProject', project => this.selectProject(typeof project === 'string' ? project : undefined));
    command('selectSession', async session => {
      this.requireClient();
      const selected = typeof session === 'string' ? session : (await vscode.window.showQuickPick((this.client!.snapshot?.sessions ?? []).map(s => ({ label: String(s.id), description: String(s.project ?? ''), session: String(s.id) })), { title: 'Observe coding session' }))?.session;
      if (selected) await this.refresh(selected);
    });
    command('openSource', uri => this.openSource(typeof uri === 'string' ? uri : undefined));
    command('readFile', () => this.readFile());
    command('createDraft', () => this.createDraft());
    command('prepareCandidate', () => this.prepareCandidate());
    command('conversation', () => this.showConversation());
    command('request', () => this.request());
    command('receipts', async () => { await this.requireJournal().checkReceipts(this.requireClient()); await this.showConversation(); });
    command('terminal', app => this.openTerminal(typeof app === 'string' ? app : undefined));
    command('terminalControl', () => this.terminalControl());
    this.render();
  }
  async connect(origin?: string, credentials?: (origin: string) => Promise<string | undefined>): Promise<void> {
    if (this.connecting) throw new Error('Connection already in progress');
    const selected = origin ?? await vscode.window.showInputBox({ title: 'Connect Readymade to Urbit', value: this.media.connectedClient?.origin ?? this.context.workspaceState.get<string>('readymade.origin') ?? vscode.workspace.getConfiguration('readymade').get<string>('origin'), prompt: 'Exact HTTPS ship origin, or localhost HTTP' });
    if (!selected) return;
    this.connecting = true;
    try {
      const client = await this.media.connectClient(selected, credentials);
      if (this.client) { await this.refresh(); return; }
      const snapshot = await client.workspaceState();
      if (typeof snapshot.ship !== 'string' || !snapshot.ship.startsWith('~')) throw new Error('Invalid ship identity');
      const selectedSession = this.drafts.list().find(d => d.pending && d.snapshot.origin === client.origin)?.snapshot.session ?? '0x0';
      const sources = new SourceStore(client); await sources.refresh(selectedSession);
      if (client.snapshot?.owner !== snapshot.ship) throw new Error('Workspace and coding ship identities disagree');
      const journal = new ConversationStore(join(this.context.globalStorageUri.fsPath, 'requests'), client.origin);
      this.sourceRegistration = vscode.workspace.registerFileSystemProvider('urbit-source', new SourceProvider(sources), { isCaseSensitive: true, isReadonly: true });
      this.client = client; this.sources = sources; this.snapshot = snapshot; this.journal = journal;
      this.selectedSession = selectedSession;
      this.workspaceRequests.connect(client, snapshot.ship);
      const savedProject = this.context.workspaceState.get<string>(this.projectKey());
      this.selectedProject = client.snapshot?.projects.some(p => p.id === savedProject) ? savedProject : undefined;
      const pendingProject = client.snapshot?.sessions.find(s => s.id === selectedSession)?.project;
      if (typeof pendingProject === 'string') this.selectedProject = pendingProject;
      for (const draft of this.drafts.list()) if (draft.pending && draft.snapshot.origin === client.origin && draft.snapshot.session === selectedSession) this.drafts.observe(draft.id, client.snapshot!);
      this.status.text = `$(remote) ${snapshot.ship}`; this.status.command = 'readymade.refresh'; this.render();
    } finally { this.connecting = false; }
  }
  async refresh(session = this.selectedSession): Promise<void> {
    const client = this.requireClient();
    const snapshot = await client.workspaceState();
    if (snapshot.unchanged !== true && snapshot.ship !== this.snapshot?.ship) throw new Error('Ship identity changed; open a new window and verify the connection');
    if (snapshot.unchanged !== true) this.snapshot = snapshot;
    await this.sources!.refresh(session); this.selectedSession = session;
    if (client.snapshot?.owner !== this.snapshot?.ship) throw new Error('Workspace and coding ship identities disagree');
    const project = client.snapshot?.sessions.find(s => s.id === session)?.project;
    if (typeof project === 'string') this.selectedProject = project;
    await this.context.workspaceState.update(this.projectKey(), this.selectedProject);
    for (const draft of this.drafts.list()) {
      if (draft.pending && draft.snapshot.origin === client.origin && draft.snapshot.session === session) this.drafts.observe(draft.id, client.snapshot!);
    }
    this.render();
  }
  private requireClient(): ShipClient { if (!this.client) throw new Error('Connect to a ship first'); return this.client; }
  private requireJournal(): ConversationStore { if (!this.journal) throw new Error('Connect to a ship first'); return this.journal; }
  private projectKey(): string { return `readymade.project:${this.requireClient().origin}:${String(this.snapshot?.ship)}`; }
  async selectProject(project?: string): Promise<void> {
    const client = this.requireClient(); await client.codingState();
    const projects = client.snapshot!.projects;
    const selected = project ?? (await vscode.window.showQuickPick(projects.map(p => ({ label: String(p.title ?? p.id), description: String(p.id), project: String(p.id) })), { title: 'Choose project' }))?.project;
    if (!selected) return;
    if (!projects.some(p => p.id === selected)) throw new Error('Project is no longer available');
    this.selectedProject = selected; this.selectedSession = '0x0';
    await this.context.workspaceState.update(this.projectKey(), selected); this.render();
  }
  private projectSources(): readonly SourceDescriptor[] {
    const sessions = this.client?.snapshot?.sessions ?? [];
    return (this.sources?.sources() ?? []).filter(source => !this.selectedProject || sessions.some(s => s.id === source.session && s.project === this.selectedProject));
  }
  private render(): void {
    const rows: Row[] = [{ label: this.snapshot ? String(this.snapshot.ship) : this.media.connectedClient?.origin ?? 'Connect to your ship', command: { command: 'readymade.connect', title: 'Connect' } }, ...this.media.rows()];
    if (this.snapshot) {
      rows.unshift({ id: 'project', label: this.selectedProject ?? 'Choose project…', icon: 'folder', command: { command: 'readymade.selectProject', title: 'Choose project' } });
      rows.push(...this.workspaceRequests.rows(this.selectedProject));
      rows.push({ label: 'Pataphor conversation and receipts', command: { command: 'readymade.conversation', title: 'Conversation' } });
      rows.push({ label: 'Read ship file…', command: { command: 'readymade.readFile', title: 'Read file' } });
      const sessions = (this.client?.snapshot?.sessions ?? []).filter(s => !this.selectedProject || s.project === this.selectedProject);
      rows.push({ label: `Coding sessions (${sessions.length})`, children: sessions.map(s => ({ label: String(s.id), description: String(s.project ?? ''), command: { command: 'readymade.selectSession', title: 'Observe session', arguments: [s.id] } })) });
      for (const source of this.projectSources()) rows.push({ label: source.path, description: 'canonical · read-only', command: { command: 'readymade.openSource', title: 'Open source', arguments: [source.uri] } });
      rows.push({ label: 'Observe ship terminal…', command: { command: 'readymade.terminal', title: 'Terminal' } });
    }
    for (const draft of this.drafts.list()) rows.push({ label: draft.snapshot.path, description: draft.pending ? `${draft.pending.phase} ${draft.pending.candidate ?? draft.pending.request ?? 'intent retained'}` : 'local draft', command: { command: 'vscode.open', title: 'Open draft', arguments: [vscode.Uri.parse(draft.uri)] } });
    const primary = new Set(['project', 'workspace-requests', 'code', 'glurff', 'noltbook', 'landscape']);
    this.tree.rows = [...rows.filter(row => row.id && primary.has(row.id)),
      {id: 'more', label: 'More', icon: 'ellipsis', children: rows.filter(row => !row.id || !primary.has(row.id))}];
    this.tree.refresh();
  }
  private async pickSource(): Promise<SourceDescriptor | undefined> {
    const choices = this.projectSources().map(source => ({ label: source.path, description: `${source.source.owner} %${source.source.desk} · ${source.blob}`, source }));
    if (!choices.length) { void vscode.window.showInformationMessage('No complete retained file reads. Use Readymade: Read Ship File to read one explicitly.'); return; }
    return (await vscode.window.showQuickPick(choices, { title: 'Retained canonical ship files' }))?.source;
  }
  async openSource(uri?: string): Promise<void> {
    this.requireClient(); const source = uri ?? (await this.pickSource())?.uri; if (!source) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(source)); await vscode.window.showTextDocument(document);
  }
  private async readFile(): Promise<void> {
    const client = this.requireClient(); const state = await client.codingState();
    const choices = state.sessions.filter(s => (!this.selectedProject || s.project === this.selectedProject) && typeof s.id === 'string' && s.source && typeof s.source === 'object').map(s => ({ label: String(s.id), description: String(s.project ?? ''), session: s }));
    if (!choices.length) { void vscode.window.showInformationMessage('This project has no coding session yet.'); return; }
    const selected = await vscode.window.showQuickPick(choices, { title: 'Choose a ship coding session for the explicit file read' }); if (!selected) return;
    const session = String(selected.session.id); const fresh = await client.codingState(session);
    const row = fresh.sessions.find(s => s.id === session); if (!row) throw new Error('Session changed');
    const source = asRecord(row.source);
    const path = await vscode.window.showInputBox({ title: 'Read ship file', prompt: 'Urbit source path, e.g. /lib/example/hoon. This explicitly submits a read tool to the selected ship session.' });
    if (!path) return; if (!/^\/(?:[a-z0-9-]+\/)*[a-z0-9-]+$/.test(path)) throw new Error('Invalid source path');
    await client.codingTool(session, String(source.id), `/read ${path} 1 200`);
    this.selectedSession = session; await this.refresh(session);
    void vscode.window.showInformationMessage('Read submitted. Refresh this session after its native result is retained. Only complete retained files are editable as drafts.');
  }
  private async createDraft(): Promise<void> {
    this.requireClient(); const active = vscode.window.activeTextEditor?.document.uri;
    const source = active?.scheme === 'urbit-source' ? active.toString() : (await this.pickSource())?.uri;
    if (!source) return; const draft = this.drafts.create(this.sources!.openSnapshot(source)); this.render();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.parse(draft.uri)));
  }
  private async prepareCandidate(): Promise<void> {
    const editor = vscode.window.activeTextEditor; if (editor?.document.uri.scheme !== 'readymade-draft') throw new Error('Open a Readymade draft first');
    if (editor.document.isDirty && !await editor.document.save()) throw new Error('Save the local draft before preparing a candidate');
    const uri = editor.document.uri.toString(), draft = this.drafts.get(uri), client = this.requireClient();
    if (draft.snapshot.origin !== client.origin) throw new Error('Draft belongs to another ship');
    this.selectedSession = draft.snapshot.session;
    await client.codingState(draft.snapshot.session);
    await this.drafts.prepare(uri, client); this.render();
    void vscode.window.showInformationMessage('Candidate intent retained. Review the ship result; this does not install or deploy a change.');
  }
  private async showConversation(): Promise<void> { const client = this.requireClient(); this.snapshot = await client.workspaceState(); this.conversation.render(this.snapshot, this.requireJournal()); }
  private async request(): Promise<void> {
    const client = this.requireClient(), journal = this.requireJournal(); this.snapshot = await client.workspaceState();
    const seats = Array.isArray(this.snapshot.seats) ? this.snapshot.seats as JsonObject[] : [];
    const destination = await vscode.window.showQuickPick([{ label: 'Private Pataphor', destination: 'private' }, ...seats.map(s => ({ label: `Seat: ${String(s.seat)}`, destination: 'seat:' + String(s.seat) }))], { title: 'Request destination' });
    if (!destination) return;
    const text = await vscode.window.showInputBox({ title: 'Pataphor request', value: journal.draft(destination.destination), ignoreFocusOut: true, prompt: 'Send an actual request through the ship. 1–4096 UTF-8 bytes.' });
    if (text === undefined) return;
    await journal.submit(client, destination.destination, text); await this.showConversation();
  }
  async openTerminal(app?: string): Promise<vscode.Terminal | undefined> {
    const client = this.requireClient();
    const selected = app ?? await vscode.window.showQuickPick([...terminalApps], { title: 'Observe ship terminal (does not start or take control)' });
    if (!selected) return; if (!terminalApps.includes(selected as typeof terminalApps[number])) throw new Error('Unknown terminal');
    const existing = [...this.terminals].find(([, v]) => v.session.app === selected); if (existing) { existing[0].show(); return existing[0]; }
    const session = new ShipTerminalSession(client, selected as typeof terminalApps[number]);
    const view = new ShipTerminalView(session), terminal = vscode.window.createTerminal({ name: `Readymade · ${selected}`, pty: view });
    this.terminals.set(terminal, view); terminal.show(); return terminal;
  }
  private async terminalControl(): Promise<void> {
    const view = this.terminals.get(vscode.window.activeTerminal!); if (!view) throw new Error('Select a Readymade ship terminal first');
    const action = await vscode.window.showQuickPick(['Observe current session', 'Attach as viewer', 'Take control', 'Release control', 'Start session', 'Interrupt', 'Stop session'], { title: view.session.notice || 'Ship terminal control' });
    if (action === 'Observe current session') await view.session.observe();
    if (action === 'Attach as viewer') await view.session.attach();
    if (action === 'Take control') await view.session.takeControl();
    if (action === 'Release control') await view.session.release();
    if (action === 'Start session') await view.session.start();
    if (action === 'Interrupt') await view.session.interrupt();
    if (action === 'Stop session') await view.session.stop();
    this.render();
  }
  dispose(): void {
    this.workspaceRequests.dispose();
    this.media.dispose();
    for (const [terminal, view] of this.terminals) { view.close(); terminal.dispose(); }
    this.terminals.clear(); this.client?.close(); this.sourceRegistration?.dispose();
    this.registrations.forEach(d => d.dispose()); this.tree.dispose(); this.status.dispose(); this.conversation.dispose();
  }
}
export async function activate(context: vscode.ExtensionContext): Promise<ReadymadeWorkspace> {
  const workspace = new ReadymadeWorkspace(context); context.subscriptions.push(workspace);
  await workspace.enableTerminalCommand(); return workspace;
}
