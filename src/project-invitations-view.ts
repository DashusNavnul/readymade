import * as vscode from 'vscode';
import {randomBytes, randomUUID} from 'node:crypto';
import type {ShipClient} from './ship-client';
import {remoteShip} from './remote-project-view';
import {invitationCommand, invitationHash, invitationMembers, invitationProject, type InvitationCommand, type InvitationPage, type InvitationRow} from './project-invitations';
import {InvitationJournal, type InvitationIntent} from './project-invitation-journal';
import type {MediaTreeRow} from './media-workbench';

type Outcome = Awaited<ReturnType<InvitationJournal['recover']>>;
export interface JoinProjectLink {authority: string; project: string; invitation: string; target: string}
export function joinProjectLink(uri: vscode.Uri, extension: string): JoinProjectLink {
  if (uri.toString().length > 2048 || uri.scheme !== vscode.env.uriScheme || uri.authority !== extension || uri.path !== '/join-project' || uri.fragment) throw new Error('Invalid project invitation link.');
  const query = new URLSearchParams(uri.query), keys = [...query.keys()];
  if (keys.length !== 4 || new Set(keys).size !== 4 || keys.some(key => !['authority', 'project', 'invitation', 'target'].includes(key))) throw new Error('Invalid project invitation fields.');
  const authority = query.get('authority'), project = query.get('project'), invitation = query.get('invitation'), target = query.get('target');
  if (!remoteShip(authority) || !remoteShip(target) || authority === target || !invitationProject(project) || !invitationHash(invitation)) throw new Error('Invalid project invitation recipient or identity.');
  return Object.freeze({authority, project, invitation, target});
}
export class ProjectInvitationsView implements vscode.Disposable {
  private busy = false;
  private closed = false;
  private page?: InvitationPage;
  private scope = '';
  private readonly observed = new Map<string, Outcome>();
  constructor(private readonly extension: string, private readonly current: () => ShipClient | undefined,
    private readonly project: () => string | undefined, private readonly connect: () => Promise<ShipClient | undefined>,
    private readonly journal: InvitationJournal, private readonly changed: () => void) {}
  private actor(client: ShipClient): string {
    const cookies = client.browserCookies(client.origin);
    if (cookies.length !== 1 || !cookies[0].name.startsWith('urbauth-') || !remoteShip(cookies[0].name.slice(8))) throw new Error('One authenticated ship identity is required.');
    return cookies[0].name.slice(8);
  }
  private active(client: ShipClient, actor: string, project?: string): boolean {
    return !this.closed && this.current() === client && this.actor(client) === actor && (project === undefined || this.project() === project);
  }
  private owner() {
    const client = this.current(), project = this.project();
    if (!client || !project || client.snapshot?.owner !== this.actor(client)) throw new Error('Connect and select your own project first.');
    return {client, project, actor: this.actor(client)};
  }
  private key(intent: InvitationIntent): string {return JSON.stringify([intent.origin, intent.actor, intent.command.request]);}
  private sync(): void {
    const client = this.current(), scope = JSON.stringify([client?.origin, client?.snapshot?.owner, this.project()]);
    if (scope !== this.scope) {this.scope = scope; this.page = undefined;}
  }
  private async members(client: ShipClient, actor: string, project: string, kind: 'members' | 'invitations', offset = 0, catalog?: string): Promise<InvitationPage> {
    const reply = await client.projectInvitation('members', {project, kind, offset, ...(catalog ? {catalog} : {})});
    if (!this.active(client, actor, project) || reply.status !== 200) throw new Error('Project membership changed or is unavailable. Refresh explicitly.');
    return invitationMembers(reply.body, project, actor, kind, offset, catalog);
  }
  async observe(kind: 'members' | 'invitations' = 'members', next = false): Promise<void> {
    this.sync(); const {client, actor, project} = this.owner();
    if (this.busy || this.closed) throw new Error('An invitation operation is already running.');
    const prior = this.page;
    if (next && (!prior || prior.kind !== kind || prior.next === null)) throw new Error('Refresh membership before reading another page.');
    this.busy = true; this.changed();
    try {this.page = await this.members(client, actor, project, kind, next ? prior!.next! : 0, next ? prior!.catalog : undefined);}
    finally {this.busy = false; this.changed();}
  }
  async invite(target?: string, selectedRole?: 'contributor' | 'observer' | 'maintainer'): Promise<void> {
    const {client, actor, project} = this.owner();
    if (this.closed || this.busy) throw new Error('An invitation operation is already running.');
    this.busy = true; this.changed();
    try {
      const recipient = target ?? await vscode.window.showInputBox({title: 'Invite Collaborator', prompt: 'Collaborator ship, including ~'});
      if (!recipient) return;
      if (!remoteShip(recipient) || recipient === actor) throw new Error('Enter another ship’s exact name.');
      const role = selectedRole ?? (await vscode.window.showQuickPick(['contributor', 'observer', 'maintainer'], {title: 'Collaborator role'}));
      if (!role) return;
      const unresolved = this.journal.entries().find(row => row.origin === client.origin && row.actor === actor && row.command.project === project && row.command.operation === 'invite-member' && row.command.target === recipient && !['accepted', 'refused'].includes(this.observed.get(this.key(row))?.status ?? ''));
      if (unresolved) throw new Error('Check the retained invitation result before inviting this collaborator again.');
      const page = await this.members(client, actor, project, 'invitations');
      const nonce = '0x' + (BigInt('0x' + randomBytes(16).toString('hex')) || 1n).toString(16).replace(/\B(?=(?:[0-9a-f]{4})+$)/g, '.');
      const command = invitationCommand({request: randomUUID(), authority: actor, project, operation: 'invite-member', target: recipient, role, expiresAt: page.inviteUntil, nonce});
      const intent: InvitationIntent = {version: 1, origin: client.origin, actor, command};
      const result = await this.journal.submit(client, intent, true);
      if (!this.active(client, actor, project)) throw new Error('Project changed; check the retained invitation result.');
      this.observed.set(this.key(intent), result);
    } finally {this.busy = false; this.changed();}
  }
  async join(value?: string | vscode.Uri): Promise<void> {
    const supplied = value ?? await vscode.window.showInputBox({title: 'Join Project', prompt: 'Paste the invitation link from the project owner.'});
    if (!supplied) return;
    const link = joinProjectLink(typeof supplied === 'string' ? vscode.Uri.parse(supplied, true) : supplied, this.extension);
    if (this.closed || this.busy) throw new Error('An invitation operation is already running.');
    this.busy = true; this.changed();
    try {
      const client = await this.connect(); if (!client || this.closed) return;
      const actor = this.actor(client);
      if (actor !== link.target) throw new Error(`This invitation is for ${link.target}. Connect that ship in another window.`);
      if (!this.active(client, actor)) throw new Error('Connection changed before joining.');
      const command = invitationCommand({request: randomUUID(), authority: link.authority, project: link.project, operation: 'join', invitation: link.invitation});
      const intent: InvitationIntent = {version: 1, origin: client.origin, actor, command};
      const result = await this.journal.submit(client, intent, true);
      if (!this.active(client, actor)) throw new Error('Connection changed; check the retained join result.');
      this.observed.set(this.key(intent), result);
    } finally {this.busy = false; this.changed();}
  }
  async check(request: string): Promise<void> {
    const client = this.current();
    if (!client || this.closed || this.busy) throw new Error('Connect the ship that sent this invitation action.');
    const actor = this.actor(client), intent = this.journal.entries().find(row => row.origin === client.origin && row.actor === actor && row.command.request === request);
    if (!intent) throw new Error('No retained invitation request belongs to this connection.');
    this.busy = true; this.changed();
    try {
      const result = await this.journal.recover(client, intent);
      if (!this.active(client, actor)) throw new Error('Connection changed during observation.');
      this.observed.set(this.key(intent), result);
    } finally {this.busy = false; this.changed();}
  }
  private async pending(client: ShipClient, actor: string, project: string): Promise<InvitationRow[]> {
    const rows: InvitationRow[] = []; let offset = 0, catalog: string | undefined;
    for (let n = 0; n < 8; n++) {
      const page = await this.members(client, actor, project, 'invitations', offset, catalog);
      rows.push(...page.rows as InvitationRow[]);
      if (page.next === null) return rows;
      offset = page.next; catalog = page.catalog;
    }
    throw new Error('Invitation list exceeds this bounded read. No link was copied.');
  }
  async copyLink(request: string): Promise<void> {
    const {client, actor, project} = this.owner();
    if (this.closed || this.busy) throw new Error('An invitation operation is already running.');
    const intent = this.journal.entries().find(row => row.origin === client.origin && row.actor === actor && row.command.request === request);
    if (!intent || intent.command.operation !== 'invite-member' || intent.command.project !== project || this.observed.get(this.key(intent))?.status !== 'accepted') throw new Error('Check that the native invitation was accepted before copying its link.');
    const command = intent.command;
    this.busy = true; this.changed();
    try {
      const matches = (await this.pending(client, actor, project)).filter(row => row.target === command.target && row.role === command.role && row.issuedBy === actor && row.expiresAt === command.expiresAt && !row.expired);
      if (matches.length !== 1) throw new Error('One exact current native invitation was not found. No link was copied.');
      const uri = vscode.Uri.from({scheme: vscode.env.uriScheme, authority: this.extension, path: '/join-project',
        query: new URLSearchParams({authority: actor, project, invitation: matches[0].id, target: command.target}).toString()});
      joinProjectLink(uri, this.extension); await vscode.env.clipboard.writeText(uri.toString());
      void vscode.window.showInformationMessage('Join link copied. Membership lasts until revoked; file access is granted separately.');
    } finally {this.busy = false; this.changed();}
  }
  async closeInvitation(id: string, expire = false): Promise<void> {
    const {client, actor, project} = this.owner();
    if (this.closed || this.busy) throw new Error('An invitation operation is already running.');
    this.busy = true; this.changed();
    try {
      const row = (await this.pending(client, actor, project)).find(row => row.id === id);
      if (!row || expire && !row.expired) throw new Error('Refresh pending invitations before closing this one.');
      const command: InvitationCommand = {request: randomUUID(), authority: actor, project, operation: expire ? 'expire-invitation' : 'revoke-invitation', invitation: id};
      const intent: InvitationIntent = {version: 1, origin: client.origin, actor, command};
      const result = await this.journal.submit(client, intent, true);
      if (!this.active(client, actor, project)) throw new Error('Project changed; check the retained invitation result.');
      this.observed.set(this.key(intent), result);
    } finally {this.busy = false; this.changed();}
  }
  rows(): MediaTreeRow[] {
    this.sync(); const client = this.current(); let actor: string | undefined;
    try {if (client) actor = this.actor(client);} catch { /* Authentication is required for actions. */ }
    const children: MediaTreeRow[] = [{label: 'Join Project…', command: {command: 'readymade.joinProject', title: 'Join Project'}}];
    if (client && actor === client.snapshot?.owner && this.project()) children.push(
      {label: 'Invite Collaborator…', command: {command: 'readymade.inviteCollaborator', title: 'Invite Collaborator'}},
      {label: 'Members', command: {command: 'readymade.projectMembers', title: 'Members'}},
      {label: 'Pending Invitations', command: {command: 'readymade.projectInvitations', title: 'Pending Invitations'}});
    if (this.busy) children.push({label: 'Observing invitation action…'});
    for (const row of this.page?.rows ?? []) {
      if ('ship' in row) children.push({label: row.ship, description: row.role, children: row.ship === actor ? [] : [{label: 'Manage Shared Files…',
        command: {command: 'readymade.projectSharing', title: 'Manage Shared Files', arguments: [row.ship]}}]});
      else children.push({label: row.target, description: `${row.role} · ${row.expired ? 'Acceptance window expired' : 'Awaiting join'}`,
        children: [{label: row.expired ? 'Close Expired Invitation' : 'Revoke Invitation', command: {command: 'readymade.closeProjectInvitation', title: 'Close Invitation', arguments: [row.id, row.expired]}}]});
    }
    if (this.page?.next !== null && this.page) children.push({label: 'Next Page', command: {command: 'readymade.nextProjectMembers', title: 'Next Page', arguments: [this.page.kind]}});
    if (client && actor) for (const intent of this.journal.entries().filter(row => row.origin === client.origin && row.actor === actor)) {
      const outcome = this.observed.get(this.key(intent)), accepted = outcome?.status === 'accepted', command = intent.command;
      children.push({label: command.project, description: `${command.operation} · ${outcome?.status ?? 'retained — check result'}`,
        children: [{label: 'Check Result', command: {command: 'readymade.checkProjectInvitation', title: 'Check Result', arguments: [command.request]}},
          ...(accepted && command.operation === 'invite-member' ? [{label: 'Copy Join Link', command: {command: 'readymade.copyProjectJoinLink', title: 'Copy Join Link', arguments: [command.request]}}] : []),
          ...(accepted && command.operation === 'join' ? [{label: 'Joined — ask owner for shared files'}] : [])]});
    }
    return [{id: 'project-invitations', label: 'Project Invitations', icon: 'organization', children}];
  }
  dispose(): void {this.closed = true; this.observed.clear(); this.page = undefined;}
}
