import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ShipClient, ProjectSharingCommand } from './ship-client';
import type { MediaTreeRow } from './media-workbench';
import { SharingJournal } from './project-sharing-journal';
import {sharedProjectLink} from './remote-source-view';
import { sharingView, type SharingView } from './project-sharing';
import {remoteSessionShortId} from './remote-project-sessions';
import {sessionSharingSettle, sessionSharingHolds, sessionSharingMessage, type SessionSharingCommand, type SessionSharingOutcome, type SessionSharingSnapshot} from './session-sharing';

/** One collaborator's agent-session standing, in memory only. `check` is a command whose result a later read may still show. */
interface SessionStanding {
  client: ShipClient; context: string; peer: string; snapshot?: SessionSharingSnapshot; note?: string;
  check?: SessionSharingCommand; last?: {command: SessionSharingCommand; outcome: SessionSharingOutcome};
}
export class ProjectSharingView implements vscode.Disposable {
  private client?: ShipClient;
  private held?: SharingView;
  private sessions?: SessionStanding;
  private settling = false;
  private context = '';
  private busy = false;
  private text = '# Project sharing\n\nChoose a project and a collaborator.';
  private readonly uri = vscode.Uri.parse('readymade-sharing:/access.md');
  private readonly event = new vscode.EventEmitter<vscode.Uri>();
  private readonly registration: vscode.Disposable;
  constructor(private readonly project: () => string | undefined, private readonly changed: () => void,
    private readonly journal: SharingJournal, private readonly confirm: (detail: string) => Thenable<boolean> = async detail =>
      (await vscode.window.showWarningMessage('Change shared access?', {modal: true, detail}, 'Confirm')) === 'Confirm',
    private readonly confirmRemoval: (detail: string) => Thenable<boolean> = async detail =>
      (await vscode.window.showWarningMessage('Remove collaborator?', {modal: true, detail}, 'Remove')) === 'Remove') {
    this.registration = vscode.workspace.registerTextDocumentContentProvider('readymade-sharing', {
      onDidChange: this.event.event, provideTextDocumentContent: uri => {
        if (uri.toString() !== this.uri.toString()) throw vscode.FileSystemError.FileNotFound(uri);
        return this.text;
      }
    });
  }
  connect(client: ShipClient): void {this.client = client; this.context = ''; this.held = undefined; this.sync();}
  private sync(): void {
    const next = JSON.stringify([this.client?.origin, this.client?.snapshot?.owner, this.project()]);
    if (next === this.context) return;
    this.context = next; this.held = undefined; this.text = '# Project sharing\n\nChoose a collaborator to inspect access.'; this.event.fire(this.uri);
  }
  private entries() {return this.journal.entries().filter(i => i.origin === this.client?.origin && i.command.owner === this.client?.snapshot?.owner && i.command.project === this.project());}
  rows(): MediaTreeRow[] {
    this.sync();
    const children: MediaTreeRow[] = [{label: 'Choose collaborator…', command: {command: 'readymade.projectSharing', title: 'Choose collaborator'}}];
    if (this.held) {
      const h = this.held;
      children.push({label: h.peer, description: h.grant ? h.grant.revoked ? 'Access revoked' : 'Retained access grant' : 'No access grant'});
      if (h.member) children.push({label: 'Share selected files…', command: {command: 'readymade.grantProjectAccess', title: 'Share files'}});
      else children.push({label: 'Join this project before sharing files'});
      if (h.grant?.view && !h.grant.revoked) children.push({label: 'Copy Shared Project Link', command: {command: 'readymade.copySharedProjectLink', title: 'Copy Shared Project Link'}});
      if (h.grant?.view && !h.grant.revoked) children.push({label: 'Copy Shared File Link…', command: {command: 'readymade.copySharedFileLink', title: 'Copy Shared File Link'}});
      if (h.grant && !h.grant.revoked) children.push({label: 'Revoke access…', command: {command: 'readymade.revokeProjectAccess', title: 'Revoke access'}});
      children.push(...this.sessionRows());
    }
    try {
      for (const i of this.entries()) children.push({label: `Check ${i.command.operation === 'grant' ? 'sharing' : 'revocation'} request`, description: i.command.peer,
        command: {command: 'readymade.recoverProjectAccess', title: 'Check sharing result', arguments: [i.command.request]}});
    } catch {children.push({label: 'Saved sharing requests unavailable'});}
    return [{id: 'project-sharing', label: 'Project Sharing', icon: 'organization', children}];
  }
  async observe(supplied?: string): Promise<void> {
    this.sync(); const client = this.client, project = this.project(), context = this.context;
    if (!client || !project || this.busy) throw new Error('Connect and select a project before sharing.');
    this.busy = true;
    try {
      const peer = supplied ?? await vscode.window.showInputBox({title: 'Project collaborator', prompt: 'Collaborator ship, including ~', value: this.held?.peer});
      if (!peer) return;
      const reply = await client.projectSharing('read', {project, peer});
      if (reply.status !== 200) throw new Error('Project sharing is unavailable on this ship.');
      const view = sharingView(reply.body);
      this.sync();
      if (client !== this.client || context !== this.context || view.owner !== client.snapshot?.owner || view.project !== project || view.peer !== peer) throw new Error('Sharing context changed; observe again.');
      this.held = view;
      const grant = view.grant;
      await this.show(`# Project sharing\n\nProject: ${view.project}\n\nCollaborator: ${view.peer}\n\n${!view.member ? 'Not a current project member.' : 'Current project member.'}\n\n` +
        (grant ? `${grant.revoked ? 'Revoked' : 'Retained'} grant · ${grant.desk}\n\nPermissions: ${[grant.view ? 'Read files' : '', grant.suggest ? 'Suggest changes' : ''].filter(Boolean).join(', ')}\n\nFiles:\n\n${grant.paths.map(p => '- ' + p).join('\n')}\n\n` : 'No retained source-access grant.\n\n') +
        'Membership alone does not grant file access. The ship checks current permissions for each request.');
      await this.readSessions(client, context, project, peer);
    } finally {this.busy = false; this.changed();}
  }
  async copyLink(authority: string, chooseFile = false): Promise<void> {
    this.sync(); const client = this.client, held = this.held, context = this.context;
    if (!client || !held || this.busy) throw new Error('Choose a collaborator and inspect access first.');
    this.busy = true;
    try {
      const file = chooseFile ? await vscode.window.showQuickPick(held.grant?.paths ?? [], {title: 'Copy link to shared file'}) : undefined;
      if (chooseFile && !file) return;
      this.sync();
      if (client !== this.client || context !== this.context) throw new Error('Sharing context changed; observe again.');
      const reply = await client.projectSharing('read', {project: held.project, peer: held.peer});
      if (reply.status !== 200) throw new Error('Project sharing is unavailable on this ship.');
      const fresh = sharingView(reply.body); this.sync();
      if (client !== this.client || context !== this.context || fresh.owner !== client.snapshot?.owner || fresh.owner !== held.owner ||
          fresh.project !== held.project || fresh.peer !== held.peer) throw new Error('Sharing context changed; observe again.');
      this.held = fresh;
      if (!fresh.member || !fresh.grant?.view || fresh.grant.revoked) throw new Error('This collaborator needs current read access before a project link can be copied.');
      if (file && !fresh.grant.paths.includes(file)) throw new Error('This file is no longer shared with this collaborator.');
      const uri = vscode.Uri.from({scheme: vscode.env.uriScheme, authority, path: '/shared-project',
        query: new URLSearchParams({owner: fresh.owner, project: fresh.project, generation: fresh.grant.generation, peer: fresh.peer, ...(file ? {file} : {})}).toString()});
      sharedProjectLink(uri, authority);
      await vscode.env.clipboard.writeText(uri.toString());
      void vscode.window.showInformationMessage(file ? 'Shared file link copied.' : 'Shared project link copied.');
    } finally {this.busy = false; this.changed();}
  }
  async change(revoke = false): Promise<void> {
    this.sync(); const client = this.client, h = this.held, context = this.context;
    if (!client || !h || this.busy) throw new Error('Choose a collaborator and inspect access first.');
    this.busy = true;
    try {
      const base = {request: randomUUID(), owner: h.owner, project: h.project, peer: h.peer, expected: h.expected};
      let command: ProjectSharingCommand, detail: string;
      if (revoke) {
        if (!h.grant || h.grant.revoked) throw new Error('There is no current grant to revoke.');
        command = {...base, operation: 'revoke', generation: h.grant.generation};
        detail = `Revoke ${h.peer}'s access to ${h.project}?`;
      } else {
        if (!h.member) throw new Error('This collaborator must join the project first.');
        const desks = [...new Set([h.workingDesk, h.baseDesk].filter((d): d is string => d !== null))];
        const selected = await vscode.window.showQuickPick(desks, {title: 'Choose files from'});
        if (!selected) return;
        const entered = await vscode.window.showInputBox({title: 'Files to share', prompt: 'Up to 8 Hoon file paths, separated by commas', value: h.grant?.paths.join(', '), placeHolder: '/lib/example/hoon, /app/example/hoon'});
        if (!entered) return;
        const permission = await vscode.window.showQuickPick([{label: 'Read files', value: 'view' as const}, {label: 'Read and suggest changes', value: 'view-suggest' as const}], {title: 'Collaborator permissions'});
        if (!permission) return;
        command = {...base, operation: 'grant', desk: selected, paths: entered.split(',').map(p => p.trim()).join('\n'), permission: permission.value};
        detail = `Share with ${h.peer}\nProject: ${h.project}\nDesk: ${selected}\n${command.paths}\n\n${permission.label}. Access lasts until revoked. Suggestions do not automatically apply changes.`;
      }
      if (!await this.confirm(detail)) return;
      this.sync(); if (client !== this.client || context !== this.context || this.held !== h) throw new Error('Project changed; inspect access again.');
      const result = await this.journal.submit(client, {version: 1, origin: client.origin, command}, true);
      this.sync(); if (client !== this.client || context !== this.context) throw new Error('Project changed during submission.');
      this.held = undefined;
      await this.show(`# Sharing request\n\nCollaborator: ${h.peer}\n\nStatus: ${result.status}\n\nUse “Check sharing request” to read the ship’s result. This does not resend the request.`);
    } finally {this.busy = false; this.changed();}
  }
  async recover(request: string): Promise<void> {
    this.sync(); const client = this.client, context = this.context, retained = this.entries().find(i => i.command.request === request);
    if (!client || !retained || this.busy) throw new Error('Choose a saved sharing request.');
    this.busy = true;
    try {
      const result = await this.journal.recover(client, retained);
      this.sync(); if (client !== this.client || context !== this.context) throw new Error('Project changed during observation.');
      this.held = undefined;
      const reply = await client.projectSharing('read', {project: retained.command.project, peer: retained.command.peer});
      this.sync(); if (client !== this.client || context !== this.context) throw new Error('Project changed during access refresh.');
      if (reply.status !== 200) throw new Error('Current access is unavailable. Observe the collaborator again.');
      const fresh = sharingView(reply.body);
      if (fresh.owner !== client.snapshot?.owner || fresh.owner !== retained.command.owner || fresh.project !== retained.command.project || fresh.peer !== retained.command.peer)
        throw new Error('Sharing context changed during access refresh.');
      this.held = fresh;
      await this.show(`# Sharing result\n\nCollaborator: ${retained.command.peer}\n\nAction: ${retained.command.operation}\n\nStatus: ${result.status}\n\nThis result was read from the ship. No request was resent.`);
    } finally {this.busy = false; this.changed();}
  }
  private standing(): SessionStanding | undefined {
    const s = this.sessions;
    return s && this.held && s.client === this.client && s.context === this.context && s.peer === this.held.peer ? s : undefined;
  }
  /** A read only, and never fatal to the file-sharing screen: an older ship has no session sharing. */
  private async readSessions(client: ShipClient, context: string, project: string, peer: string): Promise<void> {
    const prior = this.standing(), next: SessionStanding = {client, context, peer, check: prior?.check, last: prior?.last};
    try {
      const snapshot = await client.sessionSharingRead(project, peer);
      this.sync(); if (client !== this.client || context !== this.context || this.held?.peer !== peer || snapshot.owner !== client.snapshot?.owner) return;
      next.snapshot = snapshot;
      if (next.check) {
        const holds = sessionSharingHolds(next.check, snapshot);
        next.note = holds ? 'Confirmed: your ship now shows the change.' : 'Not confirmed yet. Check again reads your ship; nothing is resent.';
        if (holds) next.check = undefined;
      }
    } catch (error) {
      const reason = (error as {reason?: unknown} | null)?.reason;
      next.note = `Agent session sharing could not be read from your ship${typeof reason === 'string' ? ` (${reason})` : ''}.`;
    }
    this.sessions = next;
  }
  private sessionRows(): MediaTreeRow[] {
    const s = this.standing();
    if (!s) return [];
    if (this.settling) return [{label: 'Waiting for your ship to show the change…'}];
    const rows: MediaTreeRow[] = s.note ? [{label: s.note}] : [], v = s.snapshot;
    if (!v || s.check) rows.push({label: 'Check again', tooltip: 'Reads your ship again. Nothing is sent or resent.',
      command: {command: 'readymade.projectSharing', title: 'Check again', arguments: [s.peer]}});
    if (!v) return rows;
    if (v.sessionSharing === 'unregistered') rows.push({label: 'Session sharing: this project is not set up for coding on your ship'});
    else if (v.sessionSharingBlocked) rows.push({label: `Session sharing for this project: ${v.sessionSharing} (cannot be changed now)`,
      tooltip: v.sessionSharingBlocked === 'project-not-private' ? 'The project’s source desk is readable by other ships; your ship only changes coding policy for private projects.' :
        v.sessionSharingBlocked === 'work-not-isolated' ? 'The project’s work desk is running or claimed.' : 'One of the project’s desks is missing on your ship.'});
    else rows.push({label: `Session sharing for this project: ${v.sessionSharing}`, tooltip: 'The project’s own setting. When it is off, no session of it can be shared with anyone.',
      children: [v.sessionSharing === 'on' ? {label: 'Turn off session sharing for this project…', command: {command: 'readymade.projectSessionSharing', title: 'Turn off', arguments: ['off']}} :
        {label: 'Turn on session sharing for this project…', command: {command: 'readymade.projectSessionSharing', title: 'Turn on', arguments: ['on']}}]});
    if (!v.inspectable && v.member && v.sessionSharing === 'off') rows.push({label: `Sessions cannot be shared until session sharing is turned on for this project`});
    else if (!v.inspectable) rows.push(v.member ? {label: `Sessions cannot be shared with ${v.peer} as ${v.role}`, tooltip: 'That role, or this project’s policy, does not allow looking at agent sessions.'} :
      {label: `Sessions cannot be shared: ${v.peer} is not a member of this project`, tooltip: 'Invite this ship and let it join first.'});
    else if (!v.sessions.length) rows.push({label: 'This project has no agent sessions to share'});
    // Stopping must stay reachable, so a session still shared is listed even when new sharing is not allowed.
    for (const row of v.inspectable ? v.sessions : v.sessions.filter(row => row.shared)) rows.push({label: remoteSessionShortId(row.id),
      description: `${row.phase} · ${row.shared ? 'shared' : 'not shared'}`, tooltip: `${row.desk} @ ${row.revision}\nSession ${row.id}\nObserved ${v.observedAt}`,
      children: [row.shared ? {label: 'Stop sharing this session', command: {command: 'readymade.unshareSession', title: 'Stop sharing this session', arguments: [row.id]}} :
        {label: 'Share this session', command: {command: 'readymade.shareSession', title: 'Share this session', arguments: [row.id]}}]});
    if (v.truncated) rows.push({label: 'Showing the first 128 sessions'});
    if (v.member || v.viewGrant === 'live' || v.sessions.some(row => row.shared)) rows.push({label: `Remove ${v.peer} from this project…`,
      command: {command: 'readymade.removeCollaborator', title: 'Remove collaborator'}});
    return rows;
  }
  /** Sends one command once, then only reads. The ship keeps no journal for it: the outcome is what a read shows. */
  private async settle(client: ShipClient, context: string, s: SessionStanding, command: SessionSharingCommand, label: string): Promise<SessionSharingOutcome> {
    this.sync(); if (client !== this.client || context !== this.context || this.standing() !== s) throw new Error('Project changed; choose the collaborator again.');
    this.settling = true; s.note = undefined; s.check = undefined; this.changed();
    try {
      const outcome = await sessionSharingSettle(client, command, snapshot => {
        this.sync(); if (client !== this.client || context !== this.context) throw new Error('Project changed. Choose the collaborator again to see the result; nothing was resent.');
        s.snapshot = snapshot;
      });
      s.last = {command, outcome}; s.note = sessionSharingMessage(command, outcome, label);
      s.check = outcome.status === 'not-confirmed' || outcome.status === 'unknown' ? command : undefined;
      if (outcome.status === 'confirmed' || outcome.status === 'unchanged') void vscode.window.showInformationMessage(s.note);
      else void vscode.window.showWarningMessage(s.note);
      return outcome;
    } finally {this.settling = false;}
  }
  async sessionSharing(operation: 'share' | 'unshare', id?: string): Promise<void> {
    this.sync(); const client = this.client, context = this.context, s = this.standing(), v = s?.snapshot;
    if (!client || !s || !v || this.busy) throw new Error('Choose a collaborator and read their agent sessions first.');
    this.busy = true;
    try {
      const stop = operation === 'unshare';
      const session = id ?? (await vscode.window.showQuickPick(v.sessions.filter(row => row.shared === stop).map(row => ({label: remoteSessionShortId(row.id),
        description: row.phase, detail: `${row.desk} @ ${row.revision}`, id: row.id})), {title: stop ? `Stop sharing a session with ${v.peer}` : `Share a session with ${v.peer}`}))?.id;
      if (!session) return;
      if (!v.sessions.some(row => row.id === session)) throw new Error('This session is not in the list. Check again first.');
      if (!stop && !v.inspectable) throw new Error(`Sessions cannot be shared with ${v.peer} right now.`);
      await this.settle(client, context, s, {owner: v.owner, project: v.project, peer: v.peer, operation, session}, remoteSessionShortId(session));
    } finally {this.busy = false; this.changed();}
  }
  /** The whole project's setting, through the same one-send-then-read path. Turning it off stops every shared session at once. */
  /** With no setting named (the command palette, the Home command line) it offers the opposite of what the project has now. */
  async projectSessionSharing(setting?: boolean): Promise<void> {
    this.sync(); const client = this.client, context = this.context, s = this.standing(), v = s?.snapshot;
    if (!client || !s || !v || this.busy) throw new Error('Choose a collaborator and read their agent sessions first.');
    if (v.sessionSharing === 'unregistered') throw new Error('This project is not set up for coding on your ship.');
    const on = setting ?? v.sessionSharing !== 'on';
    this.busy = true;
    try {
      const detail = on ?
        `Allow agent sessions of ${v.project} to be shared?\n\nNothing is shared by this: you still choose each session and each collaborator, one at a time, and a collaborator only sees ` +
          'what that session shows (read only). Collaborators need the contributor role or higher.\n\nThis adds “inspect” to the project’s coding policy on your ship. Sessions already running keep working.' :
        `Stop all session sharing for ${v.project}?\n\nEvery session shared with any collaborator stops at once. The sessions themselves keep running.\n\nThis removes “inspect” from the project’s coding policy on your ship.`;
      if (!await this.confirm(detail)) return;
      await this.settle(client, context, s, {owner: v.owner, project: v.project, peer: v.peer, operation: on ? 'sharing-on' : 'sharing-off', session: '0x0'}, '');
    } finally {this.busy = false; this.changed();}
  }
  async removeCollaborator(): Promise<void> {
    this.sync(); const client = this.client, h = this.held, context = this.context, s = this.standing(), v = s?.snapshot;
    if (!client || !h || !s || !v || this.busy) throw new Error('Choose a collaborator and read their agent sessions first.');
    this.busy = true;
    try {
      const command: SessionSharingCommand = {owner: v.owner, project: v.project, peer: v.peer, operation: 'remove', session: '0x0'};
      if (!await this.confirmRemoval(`Remove ${v.peer} from ${v.project}?\n\nThis does three things in one step:\n• removes ${v.peer} from the project’s members\n` +
        `• revokes its access to the files you shared\n• stops sharing every agent session with it\n\nThis screen cannot undo it. You can invite ${v.peer} again later.`)) return;
      this.sync(); if (client !== this.client || context !== this.context || this.held !== h) throw new Error('Project changed; inspect access again.');
      const outcome = await this.settle(client, context, s, command, '');
      // Membership and the file grant changed with it: read the file-sharing rows again, or drop them.
      let fresh: SharingView | undefined;
      try {const reply = await client.projectSharing('read', {project: v.project, peer: v.peer}); if (reply.status === 200) fresh = sharingView(reply.body);} catch { /* Dropped below. */ }
      this.sync();
      this.held = fresh && client === this.client && context === this.context && fresh.owner === v.owner && fresh.project === v.project && fresh.peer === v.peer ? fresh : undefined;
      await this.show(`# Collaborator removal\n\nProject: ${v.project}\n\nCollaborator: ${v.peer}\n\n${sessionSharingMessage(command, outcome)}\n\n` +
        'Removal ends membership, shared file access and every shared agent session together. Invite the ship again to restore membership.');
    } finally {this.busy = false; this.changed();}
  }
  private async show(text: string): Promise<void> {this.text = text; this.event.fire(this.uri); await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(this.uri), {preview: true});}
  dispose(): void {this.client = undefined; this.held = undefined; this.sessions = undefined; this.context = ''; this.registration.dispose(); this.event.dispose();}
}
