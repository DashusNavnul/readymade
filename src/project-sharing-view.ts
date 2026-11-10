import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ShipClient, ProjectSharingCommand } from './ship-client';
import type { MediaTreeRow } from './media-workbench';
import { SharingJournal } from './project-sharing-journal';
import {sharedProjectLink} from './remote-source-view';
import { sharingView, type SharingView } from './project-sharing';

export class ProjectSharingView implements vscode.Disposable {
  private client?: ShipClient;
  private held?: SharingView;
  private context = '';
  private busy = false;
  private text = '# Project sharing\n\nChoose a project and a collaborator.';
  private readonly uri = vscode.Uri.parse('readymade-sharing:/access.md');
  private readonly event = new vscode.EventEmitter<vscode.Uri>();
  private readonly registration: vscode.Disposable;
  constructor(private readonly project: () => string | undefined, private readonly changed: () => void,
    private readonly journal: SharingJournal, private readonly confirm: (detail: string) => Thenable<boolean> = async detail =>
      (await vscode.window.showWarningMessage('Change shared access?', {modal: true, detail}, 'Confirm')) === 'Confirm') {
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
  private async show(text: string): Promise<void> {this.text = text; this.event.fire(this.uri); await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(this.uri), {preview: true});}
  dispose(): void {this.client = undefined; this.held = undefined; this.context = ''; this.registration.dispose(); this.event.dispose();}
}
