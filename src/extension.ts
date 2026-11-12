import * as vscode from 'vscode';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import {ProjectInvitationsView} from './project-invitations-view';
import {InvitationJournal} from './project-invitation-journal';
import {ProjectInboxView, type InboxAnswer} from './project-inbox-view';
import {NoltbookDocumentsView} from './noltbook-documents-view';
import {NoltbookDocumentStore} from './noltbook-document-store';
import {RemoteSuggestionJournal} from './remote-suggestion-journal';
import {RemoteDraftStore} from './remote-draft-store';
import {RemoteDraftProvider} from './remote-draft-provider';
import {RemoteSourceView} from './remote-source-view';
import { EditingActivityView } from './editing-activity-view';
import { existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { OutcomeUnknownError, ShipClient, ShipClientError } from './ship-client';
import { restoredSession, sessionSelection, sessionSelectionKey, projectSessionSelectionKey, sourceSessionChoice } from './session-selection';
import { JsonObject, asRecord } from './protocol';
import { SourceStore, SourceDescriptor, sourceBasis, sameBasis, validPath, type SourceBasis } from './source-store';
import { DirectoryView } from './directory-view';
import { CheckView } from './check-view';
import {EvaluationView} from './evaluation-view';
import {EvaluationStore} from './evaluation-store';
import { CheckDocumentJournal } from './check-document-journal';
import { ReviewPolicyView } from './review-policy-view';
import { ReviewPolicyJournal } from './review-policy-journal';
import { ProjectSharingView } from './project-sharing-view';
import { SharingJournal } from './project-sharing-journal';
import { CandidateView } from './candidate-view';
import { CandidateJournal } from './candidate-journal';
import { CompletionView } from './completion-view';
import { CompletionJournal } from './completion-journal';
import { SourceProvider } from './source-provider';
import { SourcePager } from './source-pager';
import { SourceLoader } from './source-loader';
import { DurablePageJournal } from './page-journal';
import { DraftStore } from './draft-store';
import { DraftProvider } from './draft-provider';
import { openSavedDraft } from './draft-open-view';
import { reconcileDraftView } from './draft-reconcile-view';
import { DraftReviewView, readDraftReviewContext } from './draft-review-view';
import { ConversationStore } from './conversation-store';
import { ConversationView } from './conversation-view';
import { ShipTerminalSession, terminalApps } from './terminal-session';
import { ShipTerminalView } from './terminal-view';
import { MediaWorkbench, type MediaTreeRow } from './media-workbench';
import { WorkspaceRequestView } from './workspace-request-view';
import { installAppCommand } from './landscape-command';
import { SetupView } from './setup-view';
import { WelcomeView } from './welcome-view';
import { PlanetSetupView } from './planet-setup-view';
import { BackendInstallView } from './backend-install-view';
import { hostProbes } from './backend-install';
import { installChoice, loomOf } from './install-choice';
import { connectionFailureMessage } from './ship-connection';
import { ShipDoctorView } from './ship-doctor-view';
import { waitingReport, waitingSummary, type WaitingReport } from './owner-inbox';
import { projectActivity, type ActivityEntry } from './project-activity';
import { FULL_SOURCE } from './guest-service';
import { PlanetBootView } from './planet-boot-view';
import { askAssistant, askAssistantSummary } from './home-assistant';
import { CATCH_UP_SYSTEM, catchUpDigest, catchUpDocument, type CatchUpInput } from './catch-up';
import { shareNoticeLines, shareNoticeText, shareNoticesUnseen, type ShareNotice, type ShareNotices } from './share-notices';

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
  readonly home: WelcomeView;
  readonly planetSetup: PlanetSetupView;
  readonly backendInstall: BackendInstallView;
  readonly doctor: ShipDoctorView;
  readonly planetBoot: PlanetBootView;
  readonly setup: SetupView;
  readonly workspaceRequests: WorkspaceRequestView;
  readonly files: DirectoryView;
  readonly checks: CheckView;
  readonly evaluations: EvaluationView;
  readonly codeReview: CandidateView;
  readonly reviewPolicy: ReviewPolicyView;
  readonly projectSharing: ProjectSharingView;
  readonly inbox: ProjectInboxView;
  readonly documents: NoltbookDocumentsView;
  readonly invitations: ProjectInvitationsView;
  readonly activity: EditingActivityView;
  readonly remoteSource: RemoteSourceView;
  readonly remoteDrafts: RemoteDraftStore;
  readonly answerReview: CompletionView;
  client?: ShipClient;
  sources?: SourceStore;
  private pager?: SourcePager;
  private loader?: SourceLoader;
  private disposed = false;
  private readonly pageJournal: DurablePageJournal;
  readonly drafts: DraftStore;
  readonly changes: DraftReviewView;
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
  private projectSelectionEpoch = 0;
  private reviewContextJSON = '';
  get project(): string | undefined { return this.selectedProject; }
  async enableTerminalCommand(): Promise<void> {
    const apps = ['landscape', 'groups', 'lattice', 'glurff', 'noltbook'] as const;
    const uris = apps.map(app => vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: this.context.extension.id, path: '/' + app }));
    this.registrations.push(vscode.window.registerUriHandler({ handleUri: async incoming => {
      if (incoming.path === '/join-project') {
        try {await this.invitations.join(incoming);} catch (error) {void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Project invitation could not open.');}
        return;
      }
      if (incoming.path === '/shared-project') {
        try {await this.remoteSource.open(incoming);} catch (error) {void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Shared project could not open.');}
        return;
      }
      const index = uris.findIndex(uri => incoming.toString() === uri.toString());
      if (index < 0) return;
      try { await this.media.open(apps[index]); }
      catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Ship app could not open.'); }
    } }));
    const candidates = [join(vscode.env.appRoot, '../../../../../MacOS/ReadymadeCLI'), join(vscode.env.appRoot, 'bin/codium'), join(vscode.env.appRoot, 'bin/code')];
    const cli = candidates.find(existsSync);
    if (!cli) throw new Error('Editor command-line launcher is unavailable.');
    await mkdir(this.context.globalStorageUri.fsPath, { recursive: true, mode: 0o700 });
    const directory = await realpath(this.context.globalStorageUri.fsPath), executable = await realpath(cli), userData = await realpath(this.media.bridge.directory);
    let bin = '';
    for (const [index, app] of apps.entries()) bin = await installAppCommand(app, directory, executable, userData, uris[index].toString());
    const environment = this.context.environmentVariableCollection;
    environment.persistent = false; environment.description = 'Adds landscape, groups, lattice, glurff and noltbook to open retained ship app tabs.';
    environment.prepend('PATH', bin + delimiter);
    this.registrations.push({ dispose: () => environment.clear() });
  }
  constructor(private readonly context: vscode.ExtensionContext) {
    this.pageJournal = new DurablePageJournal(join(context.globalStorageUri.fsPath, 'file-pages'), context.workspaceState);
    this.answerReview = new CompletionView(new CompletionJournal(join(context.globalStorageUri.fsPath, 'answer-decisions')), () => this.selectedProject, () => this.render());
    this.checks = new CheckView(() => this.selectedProject, () => this.render(), new CheckDocumentJournal(join(context.globalStorageUri.fsPath, 'check-documents')), async (report, path) => {
      const client = this.client, sources = this.sources, loader = this.loader;
      const active = () => !this.disposed && this.client === client && this.sources === sources && this.selectedProject === report.project && client?.origin === report.origin && client.snapshot?.owner === report.owner;
      if (!client || !sources || !loader || !active()) return;
      const retained = sources.sources().find(row => row.session === report.session && row.path === path && sameBasis(report.source, row.source));
      if (retained) return sources.openSnapshot(retained);
      const state = await client.codingState(report.session);
      const sessions = state.sessions.filter(row => row.id === report.session && row.project === report.project && sameBasis(report.source, row.source));
      if (!active() || state.owner !== report.owner || sessions.length !== 1) return;
      const loaded = await loader.load(report.session, report.source, path, report.project, {active, progress: () => {}});
      if (loaded && active()) return sources.openSnapshot(loaded);
    });
    this.evaluations = new EvaluationView(new EvaluationStore(join(context.globalStorageUri.fsPath, 'evaluations')), () => this.client,
      () => this.selectedProject, () => {
        const uri = vscode.window.activeTextEditor?.document.uri;
        if (!uri || uri.scheme !== 'urbit-source' || !this.sources || this.disposed) return;
        try {const source = this.sources.openSnapshot(uri.toString()); return source.session === this.selectedSession ? source : undefined;}
        catch {return;}
      }, () => this.render());
    this.codeReview = new CandidateView(() => this.selectedProject, () => this.render(), new CandidateJournal(join(context.globalStorageUri.fsPath, 'code-reviews')),
      undefined, new CheckDocumentJournal(join(context.globalStorageUri.fsPath, 'candidate-documents')));
    this.reviewPolicy = new ReviewPolicyView(() => this.selectedProject, () => this.render(), new ReviewPolicyJournal(join(context.globalStorageUri.fsPath, 'review-policies')));
    this.projectSharing = new ProjectSharingView(() => this.selectedProject, () => this.render(), new SharingJournal(join(context.globalStorageUri.fsPath, 'project-sharing')));
    this.files = new DirectoryView(this.pageJournal, () => this.selectedProject, () => this.render());
    // A newly connected ship (a collaborator's included) is asked once what owners told it while the app was closed.
    this.media = new MediaWorkbench(context, () => this.client, () => {this.render(); void this.checkShareNotices();});
    this.documents = new NoltbookDocumentsView(new NoltbookDocumentStore(join(context.globalStorageUri.fsPath, 'noltbook-documents')), () => this.media.connectedClient, () => this.render(),
      (client, peer, url) => this.media.open('noltbook', url, {client, peer}));
    this.remoteDrafts = new RemoteDraftStore(join(context.globalStorageUri.fsPath, 'remote-drafts'));
    const remoteProvider = new RemoteDraftProvider(this.remoteDrafts);
    this.registrations.push(remoteProvider,
      vscode.workspace.registerFileSystemProvider('readymade-remote-draft', remoteProvider, {isCaseSensitive: true}),
      vscode.workspace.registerFileSystemProvider('readymade-remote-original', remoteProvider, {isCaseSensitive: true, isReadonly: true}));
    const draftErrors = new Set<string>();
    // Coming back to the window is when a person wants to know what an owner ended meanwhile. An event, never a timer.
    this.registrations.push(vscode.window.onDidChangeWindowState(state => {if (state.focused) void this.checkShareNotices();}));
    this.registrations.push(vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.scheme !== 'readymade-remote-draft' || !event.contentChanges.length) return;
      const uri = event.document.uri.toString();
      try {this.remoteDrafts.save(uri, event.document.getText()); draftErrors.delete(uri);}
      catch (error) {if (!draftErrors.has(uri)) {draftErrors.add(uri); void vscode.window.showErrorMessage('Shared draft could not be retained: ' + (error instanceof Error ? error.message : 'Private storage unavailable'));}}
    }));
    this.remoteSource = new RemoteSourceView(context.extension.id, () => this.media.connectedClient, async retainedOrigin => {
      if (this.media.connectedClient) return this.media.connectedClient;
      // No address to type: a ship on this computer connects by itself, anything else through the Connect list.
      return this.media.connectClient(retainedOrigin);
    }, () => {if (!this.disposed) this.render();}, this.remoteDrafts, this.remoteSuggestions = new RemoteSuggestionJournal(join(context.globalStorageUri.fsPath, 'remote-suggestions')));
    this.invitations = new ProjectInvitationsView(context.extension.id, () => this.media.connectedClient, () => this.selectedProject, async wanted => {
      if (this.media.connectedClient) return this.media.connectedClient;
      // A join link names the ship it is for: if that ship runs on this computer it connects and signs in by itself.
      const client = await this.media.connectClient(undefined, undefined, undefined, wanted);
      this.render(); return client;
    }, new InvitationJournal(join(context.globalStorageUri.fsPath, 'project-invitations')), () => {if (!this.disposed) this.render();});
    this.workspaceRequests = new WorkspaceRequestView(context, () => this.render(), session => this.refresh(session));
    this.drafts = new DraftStore(join(context.globalStorageUri.fsPath, 'drafts'));
    this.changes = new DraftReviewView(this.drafts);
    this.activity = new EditingActivityView(this.drafts, () => ({client: this.client, project: this.selectedProject}),
      () => {if (!this.disposed) this.render();}, join(homedir(), '.cache', 'readymade', 'activity-publishers'));
    this.inbox = new ProjectInboxView(() => this.client && this.selectedProject && this.sources && this.loader ?
      {client: this.client, project: this.selectedProject, sources: this.sources, loader: this.loader, drafts: this.drafts} : undefined,
    (client, project, receipt) => client.projectInbox(project, receipt), () => this.activity.contextChanged(), () => {if (!this.disposed) this.render();}, undefined, {
      // What this computer told collaborators, newest 256. The ship keeps no record of it.
      get: key => (context.globalState.get<Record<string, InboxAnswer>>('readymade.suggestionAnswers') ?? {})[key],
      set: (key, answer) => {
        const held = Object.entries(context.globalState.get<Record<string, InboxAnswer>>('readymade.suggestionAnswers') ?? {}).filter(([k]) => k !== key);
        return context.globalState.update('readymade.suggestionAnswers', Object.fromEntries([...held, [key, answer]].slice(-256)));
      }});
    const retainedReview = readDraftReviewContext(context.workspaceState.get('readymade.reviewContext'));
    if (retainedReview) this.changes.refresh(retainedReview);
    const connection = () => {
      const client = this.media.connectedClient;
      const cookies = client?.browserCookies(client.origin).filter(cookie => cookie.name.startsWith('urbauth-')) ?? [];
      const ship = cookies.length === 1 && /^urbauth-~[a-z-]{3,128}$/.test(cookies[0].name) ? cookies[0].name.slice('urbauth-'.length) : undefined;
      return {ship, origin: ship ? client?.origin : undefined, project: client && this.client === client ? this.selectedProject : undefined};
    };
    this.planetSetup = new PlanetSetupView(connection, () => this.connectApps());
    this.backendInstall = new BackendInstallView(context.extensionPath, join(context.globalStorageUri.fsPath, 'backend-install'), () => this.media.connectedLocalPlanet, () => this.connectApps());
    this.planetBoot = new PlanetBootView(context.extensionPath, () => this.connectApps());
    this.doctor = new ShipDoctorView(context.extensionPath, () => {
      const client = this.media.connectedClient, cookies = client?.browserCookies(client.origin) ?? [];
      if (!client || cookies.length !== 1 || !/^urbauth-~[a-z-]{3,128}$/.test(cookies[0].name)) return undefined;
      return {ship: cookies[0].name.slice('urbauth-'.length), origin: client.origin, planet: this.media.connectedLocalPlanet};
    });
    this.registrations.push(this.backendInstall, this.planetBoot, this.doctor);
    void this.offerStart();
    void this.resumeSwitch().then(() => this.reconnectLast());
    this.home = new WelcomeView(connection, async action => {
      if (action === 'openProject') return vscode.commands.executeCommand('workbench.action.files.openFolder');
      if (action === 'connect') {if (await this.connectApps()) await this.setup.show(this.media.connectedClient); return;}
      if (action === 'getUrbit') return this.planetSetup.show();
      if (action === 'join') return this.invitations.join();
      if (await this.connectApps()) return this.media.open(action);
    }, async (text, report) => {
      // The assistant only chooses from the listed commands; each runs exactly as it would from its own button.
      const now = connection(), chosen = vscode.workspace.getConfiguration('readymade').get<string>('assistantPath')?.trim() || undefined;
      const plan = await askAssistant(text, {connected: !!now.ship, project: !!now.project}, {chosen});
      const lines = plan.say ? [plan.say] : [];
      for (const step of plan.steps) {
        report([...lines, `Running: ${step.title}…`].join('\n'));
        try {await vscode.commands.executeCommand(step.command, ...step.args);}
        catch (error) {report([...lines, `Stopped at: ${step.title}. ${error instanceof Error ? error.message.slice(0, 300) : 'It did not finish.'}`].join('\n')); return;}
        lines.push(`Ran: ${step.title}`);
      }
      report(lines.join('\n'));
    });
    const homeStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    homeStatus.name = 'Readymade Home'; homeStatus.text = '$(home) Home'; homeStatus.command = 'readymade.home';
    homeStatus.tooltip = 'Get a planet, connect your Urbit, or open a project'; homeStatus.show();
    this.registrations.push(this.home, this.planetSetup, homeStatus);
    this.registrations.push(vscode.workspace.registerFileSystemProvider('readymade-draft', new DraftProvider(this.drafts), { isCaseSensitive: true }));
    this.registrations.push(vscode.window.registerTreeDataProvider('readymade.workspace', this.tree));
    this.registrations.push(vscode.window.onDidCloseTerminal(t => { this.terminals.get(t)?.close(); this.terminals.delete(t); }));
    this.status.text = '$(plug) Connect'; this.status.command = 'readymade.connect'; this.status.show();
    const command = (name: string, handler: (...args: unknown[]) => unknown) => this.registrations.push(vscode.commands.registerCommand('readymade.' + name, async (...args: unknown[]) => {
      try { return await handler(...args); } catch (error) { if (error instanceof ShipClientError && error.code === 'cancelled') return; if (await this.recoverSession(error)) return; void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Readymade operation failed'); throw error; }
    }));
    command('home', () => this.home.show());
    command('getUrbit', () => this.planetSetup.show());
    command('installBackend', () => this.backendInstall.show());
    command('startPlanet', () => this.planetBoot.show());
    command('connect', async origin => {const client = await this.media.connectClient(typeof origin === 'string' ? origin : undefined); this.render(); await this.setup.show(client);});
    command('doctor', () => this.doctor.show());
    command('ownerInbox', () => this.checkWaiting());
    command('catchUp', () => this.catchUp());
    command('projectActivity', () => this.readActivity());
    command('followBackendUpdates', () => this.followBackendUpdates());
    command('switchShip', async () => {if (await this.media.switchShip() && !this.media.connectedClient) await this.resumeSwitch();});
    command('openSharedProject', link => this.remoteSource.open(typeof link === 'string' ? link : undefined));
    command('resumeSharedProject', id => this.remoteSource.resume(typeof id === 'string' ? id : undefined));
    command('refreshSharedProject', () => this.remoteSource.refresh());
    command('checkSharedProject', () => this.remoteSource.check());
    command('refreshSharedActivity', () => this.remoteSource.refreshActivity());
    command('refreshSharedSessions', async (owner, project) => {await this.remoteSource.refreshSessions(owner, project); void this.checkShareNotices(true);});
    command('openSharedActivityFile', ship => this.remoteSource.openActivityFile(String(ship)));
    command('openSharedSource', uri => this.remoteSource.openFile(uri));
    command('editSharedDraft', path => this.remoteSource.editDraft(typeof path === 'string' ? path : undefined));
    command('openSharedDraft', id => this.remoteSource.openDraft(String(id)));
    command('compareSharedDraft', id => this.remoteSource.compare(typeof id === 'string' ? id : undefined));
    command('reconcileSharedDraft', id => this.remoteSource.reconcile(typeof id === 'string' ? id : undefined));
    command('sendSharedSuggestion', id => this.remoteSource.sendSuggestion(typeof id === 'string' ? id : undefined));
    command('checkSharedSuggestion', request => this.remoteSource.checkSuggestion(String(request)));
    const role = (value: unknown) => value === 'contributor' || value === 'observer' || value === 'maintainer' ? value : undefined;
    command('inviteCollaborator', async (target, wanted) => {await this.invitations.invite(typeof target === 'string' ? target : undefined, role(wanted));});
    command('inviteAndCopyLink', (target, wanted) => this.invitations.inviteAndCopyLink(typeof target === 'string' ? target : undefined, role(wanted)));
    command('joinProject', link => this.invitations.join(typeof link === 'string' ? link : undefined));
    command('checkProjectInvitation', request => this.invitations.check(String(request)));
    command('leaveProject', request => this.invitations.leave(typeof request === 'string' ? request : undefined));
    command('removeCollaborationService', () => this.invitations.removeGuestService());
    command('copyProjectJoinLink', request => this.invitations.copyLink(String(request)));
    command('projectMembers', () => this.invitations.observe('members'));
    command('projectInvitations', () => this.invitations.observe('invitations'));
    command('nextProjectMembers', kind => this.invitations.observe(kind === 'invitations' || kind === 'events' ? kind : 'members', true));
    command('projectHistory', () => this.invitations.observe('events'));
    command('copyPendingJoinLink', id => this.invitations.copyPendingLink(String(id)));
    command('closeProjectInvitation', (id, expired) => this.invitations.closeInvitation(String(id), expired === true));
    command('projectInbox', () => this.inbox.observe());
    command('openInboxSuggestion', receipt => this.inbox.show(String(receipt)));
    command('openDocument', async id => {
      if (typeof id !== 'string' && !this.media.connectedClient) await this.media.connectClient();
      return this.documents.open(typeof id === 'string' ? id : undefined);
    });
    command('publishDocument', id => this.documents.publish(typeof id === 'string' ? id : undefined));
    command('checkDocument', id => this.documents.check(typeof id === 'string' ? id : undefined));
    command('reconcileDocument', id => this.documents.reconcile(typeof id === 'string' ? id : undefined));
    command('compareDocument', id => this.documents.compare(typeof id === 'string' ? id : undefined));
    command('documentHistory', id => this.documents.history(typeof id === 'string' ? id : undefined));
    command('openDocumentInNoltbook', id => this.documents.openInNoltbook(typeof id === 'string' ? id : undefined));
    command('restoreDocumentVersion', id => this.documents.restore(typeof id === 'string' ? id : undefined));
    command('importInboxSuggestion', receipt => this.inbox.import(String(receipt)));
    command('answerInboxSuggestion', (receipt, answer) => this.inbox.answer(String(receipt), answer === 'taken' ? 'taken' : 'declined'));
    command('savedChecks', () => this.checks.openSaved());
    this.setup = new SetupView(async () => {
      if (!await this.connectApps()) return undefined;
      return this.media.connectedClient;
    }, async action => {
      if (action === 'coding') return this.connect(this.media.connectedClient?.origin);
      if (action === 'join') return this.invitations.join();
      if (action === 'guide') return vscode.env.openExternal(vscode.Uri.parse('https://github.com/DashusNavnul/readymade/blob/main/docs/LLM_SETUP.md'));
      if (action === 'newWindow') return vscode.commands.executeCommand('workbench.action.newWindow');
      return this.media.open(action);
    });
    this.registrations.push(this.setup); command('checkSetup', () => this.setup.show());
    command('refresh', () => this.refresh());
    command('selectProject', project => this.selectProject(typeof project === 'string' ? project : undefined));
    command('selectSession', async session => {
      this.requireClient();
      const selected = typeof session === 'string' ? session : (await vscode.window.showQuickPick((this.client!.snapshot?.sessions ?? []).map(s => ({ label: String(s.id), description: String(s.project ?? ''), session: String(s.id) })), { title: 'Observe coding session' }))?.session;
      if (selected) await this.refresh(selected);
    });
    command('openSource', uri => this.openSource(typeof uri === 'string' ? uri : undefined));
    command('readFile', (path, session, basis) => this.readFile(typeof path === 'string' ? path : undefined, typeof session === 'string' ? session : undefined, basis === undefined ? undefined : sourceBasis(basis)));
    command('browseFiles', (session, directory) => this.files.open(typeof session === 'string' ? session : undefined, typeof directory === 'string' ? directory : undefined));
    command('refreshFiles', () => this.files.refresh());
    command('moreFiles', () => this.files.next());
    command('checks', session => this.checks.observe(typeof session === 'string' ? session : undefined));
    command('showCheck', key => this.checks.show(String(key)));
    command('runExpression', expression => this.evaluations.run(typeof expression === 'string' ? expression : undefined));
    command('showEvaluation', id => this.evaluations.show(String(id)));
    command('observeEvaluation', id => this.evaluations.observe(String(id)));
    command('reviewCode', session => this.codeReview.observe(typeof session === 'string' ? session : undefined));
    command('showCandidate', id => this.codeReview.show(String(id)));
    command('savedCandidates', () => this.codeReview.openSaved());
    command('startCodeReview', id => this.codeReview.start(String(id)));
    command('applyCandidate', id => this.codeReview.apply(String(id)));
    command('checkAppliedCandidate', (session, id) => this.codeReview.checkApplied(String(session), String(id)));
    command('recoverCodeReview', (session, id) => this.codeReview.recover(String(session), String(id)));
    command('reviewPolicy', session => this.reviewPolicy.observe(typeof session === 'string' ? session : undefined));
    command('configureReviewer', () => this.reviewPolicy.configure());
    command('disableReviewer', () => this.reviewPolicy.configure(true));
    command('recoverReviewer', previous => this.reviewPolicy.recover(String(previous)));
    command('projectSharing', peer => this.projectSharing.observe(typeof peer === 'string' ? peer : undefined));
    command('shareActivity', () => this.activity.share());
    command('stopActivity', () => this.activity.stop());
    command('refreshActivity', () => this.activity.refresh());
    command('openActivityFile', ship => this.activity.openFile(String(ship), async (file, active) => {
      const client = this.requireClient();
      if (!active() || client.origin !== file.origin || this.selectedProject !== file.project) throw new Error('Activity project changed.');
      const state = await client.codingState();
      if (!active() || this.client !== client || state.owner !== file.actor) throw new Error('Activity connection changed.');
      const sessions = state.sessions.filter(row => row.project === file.project && typeof row.id === 'string')
        .map(row => ({id: String(row.id), source: sourceBasis(row.source)})).filter(row => row.source.owner === file.owner && row.source.desk === file.desk);
      const session = sessions.find(row => row.id === this.selectedSession) ?? (sessions.length === 1 ? sessions[0] : undefined);
      if (!session) throw new Error('Select a coding session for this project and source desk before opening this file.');
      await this.readFile(file.path, session.id, sourceBasis(session.source));
    }));
    command('copySharedProjectLink', () => this.projectSharing.copyLink(this.context.extension.id));
    command('copySharedFileLink', () => this.projectSharing.copyLink(this.context.extension.id, true));
    command('grantProjectAccess', () => this.projectSharing.change());
    command('revokeProjectAccess', () => this.projectSharing.change(true));
    command('recoverProjectAccess', request => this.projectSharing.recover(String(request)));
    command('shareSession', session => this.projectSharing.sessionSharing('share', typeof session === 'string' ? session : undefined));
    command('unshareSession', session => this.projectSharing.sessionSharing('unshare', typeof session === 'string' ? session : undefined));
    command('showShareNotices', () => this.showShareNotices());
    command('shareSessionUntil', session => this.projectSharing.sessionSharing('share-until', typeof session === 'string' ? session : undefined));
    command('removeCollaborator', () => this.projectSharing.removeCollaborator());
    command('projectSessionSharing', setting => this.projectSharing.projectSessionSharing(setting === 'on' ? true : setting === 'off' ? false : undefined));
    command('reviewAnswer', session => this.answerReview.observe(typeof session === 'string' ? session : undefined));
    command('acceptAnswer', () => this.answerReview.accept());
    command('recoverAnswer', proposal => this.answerReview.recover(String(proposal)));
    command('readNextPage', key => this.readNextPage(typeof key === 'string' ? key : undefined));
    command('createDraft', () => this.createDraft());
    command('reconcileDraft', () => {
      const client = this.requireClient(), project = this.selectedProject;
      if (!project) throw new Error('Choose the draft project first.');
      return reconcileDraftView({drafts: this.drafts, sources: this.sources!, loader: this.loader!, client, project,
        active: () => !this.disposed && this.client === client && this.selectedProject === project, changed: () => this.render()});
    });
    command('changes', () => this.changes.reveal());
    command('openSavedDraft', id => openSavedDraft(this.drafts, () => !this.disposed, typeof id === 'string' ? id : undefined));
    command('reviewDraft', id => this.changes.review(typeof id === 'string' ? id : undefined));
    command('reviewSubmitted', id => this.changes.review(typeof id === 'string' ? id : undefined, true));
    command('prepareCandidate', () => this.prepareCandidate());
    command('conversation', () => this.showConversation());
    command('request', () => this.request());
    command('receipts', async () => { await this.requireJournal().checkReceipts(this.requireClient()); await this.showConversation(); });
    command('terminal', app => this.openTerminal(typeof app === 'string' ? app : undefined));
    command('terminalControl', () => this.terminalControl());
    this.render();
  }
  private async connectApps(): Promise<boolean> {
    if (this.media.connectedClient) return true;
    try {await this.media.connectClient(); this.render(); void this.offerInstall(); void this.invitations.observeRetained(); return true;}
    catch (error) {if (error instanceof ShipClientError && error.code === 'cancelled') return false; throw error;}
  }
  /** When the app opens: a planet Readymade set up that is not running (after a Mac restart, say) is offered a start. */
  private async offerStart(): Promise<void> {
    const stopped = await this.planetBoot.stopped();
    if (this.disposed || stopped.length !== 1) return; // several: the Start a planet page lists them
    const ship = stopped[0].ship, choice = await vscode.window.showInformationMessage(`${ship} is not running.`, 'Start it');
    if (choice === 'Start it' && !this.disposed) {await this.planetBoot.show(); await this.planetBoot.restart(ship);}
  }
  /** When the app opens: the ship last used here, or the only one running on this Mac, connects by itself. Nothing is asked. */
  private async reconnectLast(): Promise<void> {
    if (this.disposed || this.media.connectedClient) return;
    const opened = await this.media.reconnectLast();
    if (!opened || this.disposed) return;
    const client = opened.client;
    this.render(); void this.offerInstall(); void this.invitations.observeRetained();
    const ship = client.browserCookies(client.origin)[0]?.name.slice('urbauth-'.length);
    if (!ship) return;
    if (!opened.first) {void vscode.window.setStatusBarMessage(`Connected to ${ship}`, 5000); return;}
    // The first time, say what happened: the person asked for nothing and typed nothing.
    const choice = await vscode.window.showInformationMessage(`Connected to ${ship}, the ship running on this Mac. Nothing was typed and nothing on the ship was changed.`, 'Open Your Urbit', 'Do not connect when opening');
    if (this.disposed) return;
    if (choice === 'Open Your Urbit') await this.setup.show(client);
    else if (choice === 'Do not connect when opening') await vscode.workspace.getConfiguration('readymade').update('connectOnStart', false, vscode.ConfigurationTarget.Global);
  }
  /** After Switch Ship reloaded this window: connect the chosen ship, as Connect would. */
  private async resumeSwitch(): Promise<void> {
    try {
      const target = await this.media.takeSwitch();
      if (!target || this.disposed) return;
      const client = await this.media.connectClient(target.origin, undefined, target.planet);
      this.render(); void this.offerInstall(); await this.setup.show(client);
    } catch (error) {
      if (error instanceof ShipClientError && error.code === 'cancelled') return;
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Could not connect the ship you switched to.');
    }
  }
  /**
   * Make an installed full backend follow its published source, so updates arrive by themselves. Asks first and
   * says what following costs; sends one kiln request and then only reads until the ship reports the source.
   */
  private followingUpdates = false;
  private async followBackendUpdates(): Promise<void> {
    if (this.followingUpdates) throw new Error('Readymade is already asking your ship to follow updates.');
    this.followingUpdates = true;
    try {await this.followUpdatesOnce();} finally {this.followingUpdates = false;}
  }
  private async followUpdatesOnce(): Promise<void> {
    const client = this.media.connectedClient;
    if (!client) throw new Error('Connect the ship first.');
    const local = await client.backendDeskRead();
    if (!local) throw new Error('This ship has no full Pataphor install to update. Use Install Pataphor first; the collaboration service updates by itself.');
    if (local.source?.ship === FULL_SOURCE.ship && local.source.desk === FULL_SOURCE.desk) {
      void vscode.window.showInformationMessage(`This ship already follows ${FULL_SOURCE.ship} for Pataphor updates.`); return;
    }
    const detail = `Your ship will take each update ${FULL_SOURCE.ship} publishes, without being asked again. An update makes the ship rebuild what changed; a large one can keep it busy for several minutes, and it answers nothing while it builds.` +
      (local.source ? ` It currently follows ${local.source.ship} %${local.source.desk}; that is replaced.` : '');
    if ((await vscode.window.showWarningMessage('Follow Pataphor updates?', {modal: true, detail}, 'Follow updates')) !== 'Follow updates') return;
    // Sent once. An unanswered request is followed by reading the ship, never by sending again.
    try {await client.backendFollow();} catch (error) {if (!(error instanceof OutcomeUnknownError)) throw error;}
    await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: 'Asking your ship to follow Pataphor updates'}, async () => {
      for (let n = 0; n < 40; n++) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        if (this.disposed || this.media.connectedClient !== client) throw new Error('Connection changed; read the ship again before asking twice.');
        const now = await client.backendDeskRead().catch(() => undefined);
        if (now?.source?.ship === FULL_SOURCE.ship && now.source.desk === FULL_SOURCE.desk) return;
      }
      throw new Error('The ship has not reported the new source yet. It may be building; check again later. Nothing is sent twice.');
    });
    void vscode.window.showInformationMessage(`This ship now follows ${FULL_SOURCE.ship} for Pataphor updates.`);
  }
  private feed?: {project: string; entries: ActivityEntry[]; partial: boolean; older: boolean};
  /** The project's activity feed: its own history and the suggestions received, read fresh and merged by time. */
  private async readActivity(): Promise<void> {
    const project = this.selectedProject; this.requireClient();
    if (!project) throw new Error('Choose a project first.');
    let partial = false;
    // Its own read of the newest history page: the members or invitations shown in the tree stay as they are.
    const history = await this.invitations.historyPage();
    try {await this.inbox.observe();} catch {partial = true;}
    if (this.selectedProject !== project) return;
    const suggestions = this.inbox.receipts ?? [], entries = projectActivity(history.rows, suggestions);
    this.feed = {project, entries, partial, older: history.older || history.rows.length + suggestions.length > entries.length}; this.render();
  }
  private activityRows(): MediaTreeRow[] {
    const feed = this.feed?.project === this.selectedProject ? this.feed : undefined;
    const children: MediaTreeRow[] = [{label: feed ? 'Refresh Activity' : 'Read Project Activity', command: {command: 'readymade.projectActivity', title: 'Read Project Activity'}}];
    for (const entry of feed?.entries ?? []) children.push({label: entry.text, description: entry.day, icon: entry.kind === 'suggestion' ? 'lightbulb' : 'organization'});
    if (feed && !feed.entries.length) children.push({label: 'Nothing recorded yet'});
    if (feed?.partial) children.push({label: 'Suggestions could not be read; showing membership only'});
    if (feed?.older) children.push({label: 'Older activity is in Project History', command: {command: 'readymade.projectHistory', title: 'Project History'}});
    return [{id: 'project-activity', label: 'Project Activity', icon: 'history', children}];
  }
  private waiting?: WaitingReport;
  private checkingWaiting = false;
  private heldShareNotices?: ShareNotices;
  private remoteSuggestions?: RemoteSuggestionJournal;
  /** The file of a suggestion this computer sent, if its journal still holds the request an owner answered. */
  private readonly suggestionFile = (n: ShareNotice): string | undefined => {
    try {
      return this.remoteSuggestions?.list().find(row => row.request === n.session && row.intent.observation.owner === n.owner && row.intent.observation.project === n.project)?.intent.path;
    } catch {return undefined;}
  };
  private shareNoticesChecked = 0;
  private shareNoticesFor?: ShipClient;
  /**
   * Reads what owners of other projects told this ship about shares they ended, and says what is new, once.
   * A read only. Without `force` it reads once for a newly connected ship and then at most once a minute.
   * An older collaboration service keeps no list.
   */
  private async checkShareNotices(force = false): Promise<void> {
    const client = this.media.connectedClient;
    if (!client || !force && client === this.shareNoticesFor && Date.now() - this.shareNoticesChecked < 60_000) return;
    this.shareNoticesFor = client; this.shareNoticesChecked = Date.now();
    let list: ShareNotices | null;
    try {list = await client.shareNotices();} catch {return;}
    if (!list || this.media.connectedClient !== client) return;
    this.heldShareNotices = list;
    const key = `readymade.shareNoticesSeen:${client.origin}:${list.peer}`, fresh = shareNoticesUnseen(list, this.context.globalState.get(key));
    if (!fresh.length) return;
    await this.context.globalState.update(key, fresh[0].at);
    const more = fresh.length - 1, all = 'Show All';
    const first = shareNoticeText(fresh[0], this.suggestionFile);
    void vscode.window.showWarningMessage(more ? `${first} There ${more === 1 ? 'is 1 more notice' : `are ${more} more notices`} from owners.` : first,
      ...(more ? [all] : [])).then(choice => {if (choice === all) void this.showShareNotices(false);});
  }
  /** Everything owners told this ship about shares they ended, newest first, on one page. A read only. */
  private async showShareNotices(read = true): Promise<void> {
    if (read) await this.checkShareNotices(true);
    const client = this.media.connectedClient, list = this.heldShareNotices;
    if (!client) throw new Error('Connect your ship first.');
    if (!list || this.shareNoticesFor !== client) throw new Error('Your ship keeps no list of ended shares. Its collaboration service may be older; update it, then try again.');
    const lines = shareNoticeLines(list, this.suggestionFile).map(row => `- ${row.day}: ${row.text}`);
    const page = await vscode.workspace.openTextDocument({language: 'markdown', content: [`# What owners told your ship: ${list.peer}`, '',
      'Each line is what an owner’s ship told your ship: a share it ended, or what it did with a suggestion you sent. It changes nothing by itself; the Shared view shows what you can open now.', '',
      ...(lines.length ? lines : ['No owner has told your ship anything yet.']), ''].join('\n')});
    await vscode.window.showTextDocument(page, {preview: true});
  }
  /**
   * The owner inbox: ask each existing screen for its own current state, then count what needs the owner.
   * Each source is read on its own; one that cannot be read (no project, a busy ship) is named as not checked.
   */
  /**
   * What happened while the person was away: the activity, what is waiting and the recent requests and results
   * the app already reads, on one page. A summary by the assistant on this computer is offered, never assumed:
   * the page says how much text would be sent and to what. Nothing is sent to the ship.
   */
  private async catchUp(): Promise<void> {
    const client = this.requireClient(), project = this.selectedProject;
    this.snapshot = await client.workspaceState();
    if (project) {try {await this.readActivity();} catch { /* shown as none recorded */ } try {await this.checkWaiting();} catch { /* shown as not checked */ }}
    await this.checkShareNotices(true);
    if (this.requireClient() !== client || this.selectedProject !== project) throw new Error('The connection or project changed; ask again.');
    const rows = (value: unknown) => Array.isArray(value) ? value as JsonObject[] : [], text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    const feed = this.feed && this.feed.project === project ? this.feed : undefined;
    const input: CatchUpInput = {
      ship: text(this.snapshot.ship) || client.origin, project, session: this.selectedSession && this.selectedSession !== '0x0' ? this.selectedSession : undefined,
      activity: feed?.entries ?? [], activityPartial: feed?.partial ?? false,
      waiting: project && this.waiting ? {items: this.waiting.items.map(item => item.label), unchecked: this.waiting.unchecked} : undefined,
      notices: this.heldShareNotices && this.heldShareNotices.peer === this.snapshot.ship ? shareNoticeLines(this.heldShareNotices, this.suggestionFile) : undefined,
      conversation: rows((this.snapshot.conversation as JsonObject | undefined)?.entries).map(row => ({id: text(row.id), status: text(row.status), request: text(row.request),
        output: typeof row.output === 'string' && row.output ? row.output : undefined, truncated: Number(row.outputBytes) > Buffer.byteLength(text(row.output))})),
      candidates: rows(this.snapshot.candidates).map(row => ({id: text(row.id), project: text(row.project), stage: text(row.stage)})),
      sessions: (client.snapshot?.sessions ?? []).map(row => ({id: text(row.id), project: text(row.project)})),
    };
    const digest = catchUpDigest(input), summarize = 'Summarize', plain = 'Show Without a Summary';
    const choice = await vscode.window.showInformationMessage('Catch me up', {modal: true, detail: `Readymade read your ship's activity, what is waiting on you, and your recent requests and results (${digest.length.toLocaleString('en-US')} characters).\n\n` +
      'Summarize sends that text to the coding assistant on this computer (Claude Code, or else Codex) under your own account, and shows its summary above the text. Show Without a Summary sends it nowhere. Nothing is sent to your ship either way.'}, summarize, plain);
    if (!choice) return;
    const chosen = vscode.workspace.getConfiguration('readymade').get<string>('assistantPath')?.trim() || undefined;
    const summary = choice === summarize ? await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: 'Asking the assistant for a summary…'}, () => askAssistantSummary(CATCH_UP_SYSTEM, digest, {chosen})) : undefined;
    const page = await vscode.workspace.openTextDocument({language: 'markdown', content: catchUpDocument(input, digest, new Date().toLocaleString('en-US'), summary)});
    await vscode.window.showTextDocument(page, {preview: false});
  }
  private async checkWaiting(): Promise<void> {
    if (this.checkingWaiting) return;
    this.requireClient(); this.checkingWaiting = true; this.render();
    const quiet = async (work: () => Promise<unknown>) => {try {await work();} catch { /* reported as not checked */ }};
    try {
      const project = this.selectedProject, session = this.selectedSession;
      await quiet(() => this.workspaceRequests.loadAll());
      if (project) {
        await quiet(() => this.inbox.observe());
        if (session && session !== '0x0') await quiet(() => this.codeReview.observe(session));
        await quiet(() => this.invitations.observe('invitations'));
      }
      const candidates = this.codeReview.waiting;
      this.waiting = waitingReport({requests: this.workspaceRequests.waiting(project), suggestions: project ? this.inbox.waiting : undefined,
        review: candidates?.review, apply: candidates?.apply, answer: this.answerReview.waiting,
        expiredInvitations: project ? this.invitations.expiredInvitations : undefined}, Date.now());
    } finally {this.checkingWaiting = false; this.render();}
    void vscode.window.setStatusBarMessage(waitingSummary(this.waiting), 6000);
  }
  private waitingRows(): MediaTreeRow[] {
    const report = this.waiting, children: MediaTreeRow[] = [{label: this.checkingWaiting ? 'Checking…' : report ? 'Check Again' : 'Check What Is Waiting',
      ...(this.checkingWaiting ? {} : {command: {command: 'readymade.ownerInbox', title: 'Check What Is Waiting'}})}];
    for (const item of report?.items ?? []) children.push({label: item.label, command: {command: item.command.command, title: item.command.title, arguments: [...(item.command.arguments ?? [])]}});
    if (report && !report.items.length) children.push({label: 'Nothing is waiting on you'});
    if (report?.unchecked.length) children.push({label: `Not checked: ${report.unchecked.join(', ')}`, tooltip: 'Choose a project and a task, or open that screen, to include these.'});
    return [{id: 'owner-inbox-all', label: 'Waiting on You', icon: 'bell', description: report ? waitingSummary(report) : undefined, children}];
  }
  private recovering = false;
  /**
   * A command failed because the ship no longer knows this window. Two measured causes are repaired without asking
   * for anything: the session ended (a ship forgets sessions after a restore, and cookies expire), so sign in again
   * with the code the ship itself or the keychain supplies; or a ship on this computer restarted on another port.
   * Returns true when the failure was explained here. The failed action is never repeated automatically.
   */
  private async recoverSession(error: unknown): Promise<boolean> {
    const client = this.media.connectedClient;
    if (!(error instanceof ShipClientError) || !client || this.recovering || this.disposed) return false;
    this.recovering = true;
    try {
      if (error.code === 'authenticationRequired') {
        try {await client.signIn();} catch {return false;}
        if (this.client === client) await this.refresh().catch(() => undefined);
        this.render();
        void vscode.window.showInformationMessage('Your ship had signed this window out. Signed in again without asking; run the action once more.');
        return true;
      }
      if (error.code === 'transport' && error.detail === 'down') {
        const moved = await this.media.findMoved();
        if (!moved || this.disposed) return false;
        const choice = await vscode.window.showWarningMessage(connectionFailureMessage(client.origin, 'down', moved), 'Reconnect there');
        if (choice === 'Reconnect there' && !this.disposed) await this.media.switchTo(moved.origin, moved.ship);
        return true;
      }
      return false;
    } finally {this.recovering = false;}
  }
  private readonly installOffered = new Set<string>();
  /** Once per ship per window: a local ship without Pataphor is offered the install instead of a dead end. */
  private async offerInstall(): Promise<void> {
    const local = this.media.connectedLocalPlanet, client = this.media.connectedClient;
    if (!local || !client || this.installOffered.has(local.ship)) return;
    this.installOffered.add(local.ship);
    try {await client.requestJSON('/apps/pataphor/remote/state.json', {timeoutMs: 8000});}
    catch (error) {
      // Only a definite "not there" is an offer; a busy or unreachable ship is left alone.
      if (!(error instanceof ShipClientError) || error.status !== 404 || this.disposed) return;
      // Offer what this ship can run: all of Pataphor for a planet or larger with enough memory, else the collaboration service.
      let loom: number | undefined; try {loom = loomOf(await hostProbes.command(local.workerPid));} catch {loom = undefined;}
      if (this.disposed) return;
      const offer = installChoice(local.ship, loom), full = 'Install Pataphor', guest = 'Install the collaboration service';
      const actions = offer.recommended === 'full' ? [full, guest] : offer.fullPossible ? [guest, full] : [guest];
      const choice = await vscode.window.showInformationMessage(`Pataphor is not on ${local.ship} yet. ${offer.reason}`, ...actions);
      if (this.disposed) return;
      if (choice === full) await this.backendInstall.show();
      else if (choice === guest) await this.invitations.installGuestService();
    }
  }
  async connect(origin?: string, credentials?: (origin: string) => Promise<string | undefined>): Promise<void> {
    if (this.connecting) throw new Error('Connection already in progress');
    // No address to type: use the connected ship, or connect one (a ship on this computer signs in by itself).
    const selected = origin ?? this.media.connectedClient?.origin ?? (await this.media.connectClient()).origin;
    if (!selected) return;
    this.connecting = true;
    try {
      await this.activity.contextChanged();
      const client = await this.media.connectClient(selected, credentials);
      if (this.client) { await this.refresh(); return; }
      const snapshot = await client.workspaceState();
      if (typeof snapshot.ship !== 'string' || !snapshot.ship.startsWith('~')) throw new Error('Invalid ship identity');
      const pendingSession = this.drafts.list().find(d => d.pending && d.snapshot.origin === client.origin && d.snapshot.ship === snapshot.ship)?.snapshot.session;
      let selectedSession = pendingSession ?? '0x0';
      const sources = new SourceStore(client); await sources.refresh(selectedSession);
      if (client.snapshot?.owner !== snapshot.ship) throw new Error('Workspace and coding ship identities disagree');
      if (!pendingSession) {
        const project = this.context.workspaceState.get<string>(`readymade.project:${client.origin}:${snapshot.ship}`);
        const retained = this.context.workspaceState.get(sessionSelectionKey(client.origin, snapshot.ship));
        const session = restoredSession(retained, client.snapshot, snapshot.ship, project);
        if (session !== '0x0') {
          await sources.refresh(session);
          if (restoredSession(retained, client.snapshot!, snapshot.ship, project) !== session) throw new Error('Saved coding session changed while connecting. Choose the session again.');
          selectedSession = session;
        }
      }
      const journal = new ConversationStore(join(this.context.globalStorageUri.fsPath, 'requests'), client.origin);
      this.sourceRegistration = vscode.workspace.registerFileSystemProvider('urbit-source', new SourceProvider(sources), { isCaseSensitive: true, isReadonly: true });
      this.client = client; this.sources = sources; this.snapshot = snapshot; this.journal = journal;
      this.pager = new SourcePager(client, sources, this.pageJournal);
      this.loader = new SourceLoader(sources, this.pager);
      this.files.connect(client);
      this.checks.connect(client);
      this.codeReview.connect(client);
      this.reviewPolicy.connect(client);
      this.projectSharing.connect(client);
      this.answerReview.connect(client);
      this.selectedSession = selectedSession;
      this.workspaceRequests.connect(client, snapshot.ship);
      const savedProject = this.context.workspaceState.get<string>(this.projectKey());
      this.selectedProject = client.snapshot?.projects.some(p => p.id === savedProject) ? savedProject : undefined;
      const pendingProject = client.snapshot?.sessions.find(s => s.id === selectedSession)?.project;
      if (typeof pendingProject === 'string') this.selectedProject = pendingProject;
      const preference = sessionSelection(client.snapshot!, this.selectedProject, selectedSession);
      if (preference) await this.context.workspaceState.update(projectSessionSelectionKey(client.origin, snapshot.ship, preference.project), preference);
      for (const draft of this.drafts.list()) if (draft.pending && draft.snapshot.origin === client.origin && draft.snapshot.session === selectedSession) this.drafts.observe(draft.id, client.snapshot!);
      this.status.text = `$(remote) ${snapshot.ship}`; this.status.command = 'readymade.refresh'; this.render();
      void this.checkShareNotices(true);
    } finally { this.connecting = false; }
  }
  async refresh(session = this.selectedSession): Promise<void> {
    const epoch = ++this.projectSelectionEpoch, client = this.requireClient();
    const active = () => !this.disposed && this.client === client && this.projectSelectionEpoch === epoch;
    await this.activity.contextChanged();
    if (!active()) return;
    const snapshot = await client.workspaceState();
    if (!active()) return;
    if (snapshot.unchanged !== true && snapshot.ship !== this.snapshot?.ship) throw new Error('Ship identity changed; open a new window and verify the connection');
    if (snapshot.unchanged !== true) this.snapshot = snapshot;
    await this.sources!.refresh(session);
    if (!active()) return;
    await this.activity.contextChanged();
    if (!active()) return;
    this.selectedSession = session;
    if (client.snapshot?.owner !== this.snapshot?.ship) throw new Error('Workspace and coding ship identities disagree');
    const project = client.snapshot?.sessions.find(s => s.id === session)?.project;
    if (typeof project === 'string') this.selectedProject = project;
    const preference = sessionSelection(client.snapshot!, this.selectedProject, session);
    await this.context.workspaceState.update(this.projectKey(), this.selectedProject);
    if (!active()) return;
    await this.context.workspaceState.update(sessionSelectionKey(client.origin, String(this.snapshot?.ship)), preference);
    if (!active()) return;
    if (preference) await this.context.workspaceState.update(projectSessionSelectionKey(client.origin, String(this.snapshot?.ship), preference.project), preference);
    if (!active()) return;
    for (const draft of this.drafts.list()) {
      if (draft.pending && draft.snapshot.origin === client.origin && draft.snapshot.session === session) this.drafts.observe(draft.id, client.snapshot!);
    }
    this.render();
  }
  private requireClient(): ShipClient { if (!this.client) throw new Error('Connect to a ship first'); return this.client; }
  private requireJournal(): ConversationStore { if (!this.journal) throw new Error('Connect to a ship first'); return this.journal; }
  private projectKey(): string { return `readymade.project:${this.requireClient().origin}:${String(this.snapshot?.ship)}`; }
  async selectProject(project?: string): Promise<void> {
    const epoch = ++this.projectSelectionEpoch;
    await this.activity.contextChanged();
    const client = this.requireClient(), owner = String(this.snapshot?.ship); await client.codingState();
    const active = () => !this.disposed && this.client === client && this.projectSelectionEpoch === epoch && client.snapshot?.owner === owner;
    if (!active()) throw new Error('Project selection changed.');
    const projects = client.snapshot!.projects;
    const selected = project ?? (await vscode.window.showQuickPick(projects.map(p => ({ label: String(p.title ?? p.id), description: String(p.id), project: String(p.id) })), { title: 'Choose project' }))?.project;
    if (!selected) return;
    await this.activity.contextChanged();
    if (!active()) throw new Error('Project selection changed.');
    await client.codingState();
    if (!active() || !client.snapshot?.projects.some(p => p.id === selected)) throw new Error('Project is no longer available');
    const key = projectSessionSelectionKey(client.origin, owner, selected), retained = this.context.workspaceState.get(key);
    const session = restoredSession(retained, client.snapshot, owner, selected);
    if (session !== '0x0') {
      await this.sources!.refresh(session);
      if (!active() || restoredSession(retained, client.snapshot!, owner, selected) !== session) throw new Error('Saved project session changed. Select the project again.');
    }
    if (!active()) throw new Error('Project selection changed.');
    const preference = sessionSelection(client.snapshot!, selected, session);
    this.selectedProject = selected; this.selectedSession = session;
    await this.context.workspaceState.update(this.projectKey(), selected);
    if (!active()) throw new Error('Project selection changed.');
    await this.context.workspaceState.update(sessionSelectionKey(client.origin, owner), preference);
    if (!active()) throw new Error('Project selection changed.');
    if (!preference) await this.context.workspaceState.update(key, undefined);
    this.render();
  }
  private projectSources(): readonly SourceDescriptor[] {
    const sessions = this.client?.snapshot?.sessions ?? [];
    return (this.sources?.sources() ?? []).filter(source => !this.selectedProject || sessions.some(s => s.id === source.session && s.project === this.selectedProject));
  }
  private render(): void {
    this.home?.refresh();
    this.planetSetup?.refresh();
    if (this.client && this.snapshot) {
      const retained = {origin: this.client.origin, ship: String(this.snapshot.ship), project: this.selectedProject, sessions: (this.client.snapshot?.sessions ?? []).map(s => [String(s.id), String(s.project)])};
      const review = readDraftReviewContext(retained);
      if (review) {
        this.changes.refresh(review);
        const encoded = JSON.stringify(retained);
        if (encoded !== this.reviewContextJSON) { this.reviewContextJSON = encoded; void this.context.workspaceState.update('readymade.reviewContext', retained); }
      } else this.changes.clearContext();
    } else if (this.media.connectedClient) this.changes.constrainOrigin(this.media.connectedClient.origin);
    const rows: Row[] = [{id: 'home', label: 'Home', icon: 'home', command: {command: 'readymade.home', title: 'Readymade Home'}},
      { label: this.snapshot ? String(this.snapshot.ship) : this.media.connectedClient?.origin ?? 'Connect to your ship', command: { command: 'readymade.connect', title: 'Connect' } }, ...this.media.rows()];
    rows.push(...this.remoteSource.rows());
    rows.push(...this.documents.rows());
    rows.push(...this.invitations.rows());
    rows.push({ id: 'changes', label: 'Changes', icon: 'diff', command: { command: 'readymade.changes', title: 'Changes' } });
    if (this.drafts.list().length) rows.push({id: 'saved-drafts', label: 'Open saved draft…', icon: 'files',
      command: {command: 'readymade.openSavedDraft', title: 'Open saved local draft'}});
    if (this.snapshot) {
      rows.unshift({ id: 'project', label: this.selectedProject ?? 'Choose project…', icon: 'folder', command: { command: 'readymade.selectProject', title: 'Choose project' } });
      rows.push(...this.waitingRows());
      if (this.selectedProject) rows.push(...this.activityRows());
      rows.push(...this.workspaceRequests.rows(this.selectedProject));
      rows.push(...this.files.rows());
      rows.push(...this.checks.rows());
      rows.push(...this.evaluations.rows());
      rows.push(...this.codeReview.rows());
      rows.push(...this.reviewPolicy.rows());
      rows.push(...this.projectSharing.rows());
      rows.push(...this.inbox.rows());
      rows.push(...this.activity.rows());
      rows.push(...this.answerReview.rows());
      rows.push({ label: 'Pataphor conversation and receipts', command: { command: 'readymade.conversation', title: 'Conversation' } });
      rows.push({ label: 'Read ship file…', command: { command: 'readymade.readFile', title: 'Read file' } });
      const sessions = (this.client?.snapshot?.sessions ?? []).filter(s => !this.selectedProject || s.project === this.selectedProject);
      rows.push({ label: `Coding sessions (${sessions.length})`, children: sessions.map(s => ({ label: String(s.id), description: s.id === this.selectedSession ? 'Current session' : String(s.project ?? ''), command: { command: 'readymade.selectSession', title: 'Observe session', arguments: [s.id] } })) });
      for (const source of this.projectSources()) rows.push({ label: source.path, description: 'canonical · read-only', command: { command: 'readymade.openSource', title: 'Open source', arguments: [source.uri] } });
      for (const file of this.sources!.progress().filter(p => p.next !== null && p.ship === this.snapshot?.ship && sessions.some(s => s.id === p.session))) {
        rows.push({label: file.path, description: `${file.lines}/${file.total} lines · ${file.bytes}/1,048,576 bytes`, children: [
          {label: 'Read next page', command: {command: 'readymade.readNextPage', title: 'Read next page', arguments: [file.key]}},
          {label: 'Refresh retained result', command: {command: 'readymade.selectSession', title: 'Refresh', arguments: [file.session]}}
        ]});
      }
      rows.push({ label: 'Observe ship terminal…', command: { command: 'readymade.terminal', title: 'Terminal' } });
    }
    for (const draft of this.drafts.list().filter(d => d.snapshot.origin === this.client?.origin && d.snapshot.ship === this.snapshot?.ship && (!this.selectedProject || this.client?.snapshot?.sessions.some(s => s.id === d.snapshot.session && s.project === this.selectedProject)))) rows.push({ label: draft.snapshot.path, description: draft.pending ? `${draft.pending.phase} ${draft.pending.candidate ?? draft.pending.request ?? 'intent retained'}` : 'local draft', command: { command: 'vscode.open', title: 'Open draft', arguments: [vscode.Uri.parse(draft.uri)] } });
    const primary = new Set(['home', 'project', 'shared-project', 'shared-documents', 'workspace-requests', 'ship-files', 'checks', 'evaluations', 'code-review', 'review-policy', 'project-sharing', 'project-activity', 'answer-review', 'changes', 'saved-drafts', 'code', 'groups', 'lattice', 'glurff', 'noltbook', 'landscape']);
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
  private async readFile(requestedPath?: string, requestedSession?: string, expectedSource?: SourceBasis): Promise<void> {
    const client = this.requireClient(), project = this.selectedProject;
    const current = () => !this.disposed && this.client === client && this.selectedProject === project;
    await this.activity.contextChanged();
    const state = await client.codingState();
    if (!current()) return;
    const choices = state.sessions.filter(s => (!this.selectedProject || s.project === this.selectedProject) && typeof s.id === 'string' && s.source && typeof s.source === 'object').map(sourceSessionChoice);
    if (!choices.length) { void vscode.window.showInformationMessage('This project has no coding session yet.'); return; }
    const selected = requestedSession ? choices.find(s => s.session.id === requestedSession) : await vscode.window.showQuickPick(choices, { title: 'Choose the task for this file read', matchOnDescription: true, matchOnDetail: true });
    if (!selected) { if (requestedSession) throw new Error('File session is outside the selected project.'); return; }
    await this.activity.contextChanged();
    const session = String(selected.session.id); const fresh = await client.codingState(session);
    if (!current()) return;
    const row = fresh.sessions.find(s => s.id === session); if (!row) throw new Error('Session changed');
    if (project !== undefined && row.project !== project) throw new Error('File session changed project.');
    const source = asRecord(row.source);
    if (expectedSource && !sameBasis(expectedSource, source)) throw new Error('Listed source changed. Browse the current revision again.');
    const path = requestedPath ?? await vscode.window.showInputBox({ title: 'Read ship file', prompt: 'Urbit source path, e.g. /lib/example/hoon. This explicitly submits a read tool to the selected ship session.' });
    if (!path || !current()) return; if (!validPath(path)) throw new Error('Invalid source path');
    const retained = this.sources!.sources().find(s => s.session === session && s.path === path && sameBasis(s.source, source));
    if (retained) { await this.openSource(retained.uri); return; }
    const complete = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
      title: `Opening ${path}`, cancellable: true}, (progress, token) => this.loader!.load(session, sourceBasis(source), path, project, {
        active: () => current() && !token.isCancellationRequested,
        progress: value => progress.report({message: value ? `${value.lines}/${value.total} lines · ${value.bytes.toLocaleString()} bytes` : 'Reading from your ship…'})
      }));
    if (!complete || !current()) return;
    this.selectedSession = session; await this.refresh(session);
    if (current()) await this.openSource(complete.uri);
  }
  private async readNextPage(key?: string): Promise<void> {
    const client = this.requireClient();
    const files = this.sources!.progress().filter(p => p.next !== null && p.ship === this.snapshot?.ship &&
      (!this.selectedProject || client.snapshot?.sessions.some(s => s.id === p.session && s.project === this.selectedProject)));
    const file = key ? files.find(p => p.key === key) : (await vscode.window.showQuickPick(files.map(p => ({
      label: p.path, description: `${p.lines}/${p.total} lines`, file: p
    })), {title: 'Continue reading a ship file'}))?.file;
    if (!file) return;
    await this.pager!.next(file.key, this.selectedProject);
    await this.refresh(file.session);
    const source = this.sources!.sources().find(s => s.session === file.session && s.source.id === file.source.id && s.path === file.path && s.blob === file.blob);
    if (source) await this.openSource(source.uri);
    else void vscode.window.showInformationMessage('Page requested. Refresh its retained result before continuing.');
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
    await this.activity.contextChanged();
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
    const closingClient = this.client, activityStopped = this.activity.contextChanged();
    this.disposed = true;
    this.activity.dispose();
    this.remoteSource.dispose();
    this.checks.dispose();
    this.evaluations.dispose();
    this.codeReview.dispose();
    this.reviewPolicy.dispose();
    this.projectSharing.dispose();
    this.inbox.dispose();
    this.documents.dispose();
    this.invitations.dispose();
    this.answerReview.dispose();
    this.changes.dispose();
    this.workspaceRequests.dispose();
    this.media.dispose();
    for (const [terminal, view] of this.terminals) { view.close(); terminal.dispose(); }
    this.terminals.clear(); void activityStopped.then(() => closingClient?.close(), () => closingClient?.close()); this.sourceRegistration?.dispose();
    this.registrations.forEach(d => d.dispose()); this.tree.dispose(); this.status.dispose(); this.conversation.dispose();
  }
}
export async function activate(context: vscode.ExtensionContext): Promise<ReadymadeWorkspace> {
  const workspace = new ReadymadeWorkspace(context); context.subscriptions.push(workspace);
  await workspace.enableTerminalCommand(); workspace.home.showOnStartup(); return workspace;
}
