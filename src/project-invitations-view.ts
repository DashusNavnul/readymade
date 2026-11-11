import * as vscode from 'vscode';
import {randomBytes, randomUUID} from 'node:crypto';
import {OutcomeUnknownError, ShipClientError, type ShipClient} from './ship-client';
import {GUEST_DESK, GUEST_PROTOCOL, GUEST_SOURCE, guestDeskServing, guestServiceMessage, type GuestServiceState, type GuestSource, guestServiceRemoved} from './guest-service';
import {remoteShip} from './remote-project-view';
import {invitationCommand, invitationHash, invitationMembers, invitationProject, type InvitationCommand, type InvitationPage, type InvitationRow, eventSentence, type EventRow, type MemberRow, type MembersKind} from './project-invitations';
import type {SessionSharingSnapshot} from './session-sharing';
import {InvitationJournal, type InvitationIntent} from './project-invitation-journal';
import type {MediaTreeRow} from './media-workbench';

type Outcome = Awaited<ReturnType<InvitationJournal['recover']>>;
/** `source`, when present, is the ship the owner said publishes the guest desk (normally the owner itself). */
export interface JoinProjectLink {authority: string; project: string; invitation: string; target: string; source?: string}
export function joinProjectLink(uri: vscode.Uri, extension: string): JoinProjectLink {
  if (uri.toString().length > 2048 || uri.scheme !== vscode.env.uriScheme || uri.authority !== extension || uri.path !== '/join-project' || uri.fragment) throw new Error('Invalid project invitation link.');
  const query = new URLSearchParams(uri.query), keys = [...query.keys()];
  if (![4, 5].includes(keys.length) || new Set(keys).size !== keys.length || keys.some(key => !['authority', 'project', 'invitation', 'target', 'source'].includes(key)) ||
      keys.length === 5 && !keys.includes('source')) throw new Error('Invalid project invitation fields.');
  const authority = query.get('authority'), project = query.get('project'), invitation = query.get('invitation'), target = query.get('target'), source = query.get('source');
  if (!remoteShip(authority) || !remoteShip(target) || authority === target || !invitationProject(project) || !invitationHash(invitation)) throw new Error('Invalid project invitation recipient or identity.');
  if (source !== null && (!remoteShip(source) || source === target)) throw new Error('Invalid project invitation source.');
  return Object.freeze({authority, project, invitation, target, ...(source !== null ? {source} : {})});
}
/** How the join flow asks before installing, waits, and gives up. Replaceable in tests; defaults are the product's. */
export interface GuestServiceSteps {
  confirm(detail: string, title?: string, action?: string): Thenable<boolean>;
  progress<T>(title: string, work: () => Promise<T>): Thenable<T>;
  pause(ms: number): Promise<void>;
  readonly pollMs: number; readonly deadlineMs: number;
}
const guestSteps: GuestServiceSteps = {
  confirm: async (detail, title = 'Install the collaboration service?', action = 'Install') => (await vscode.window.showWarningMessage(title, {modal: true, detail}, action)) === action,
  progress: (title, work) => vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title}, work),
  pause: ms => new Promise(resolve => setTimeout(resolve, ms)),
  pollMs: 3000, deadlineMs: 10 * 60 * 1000,
};
/** A read the ship did not answer because it is busy or briefly unreachable: worth reading again, not an error. */
function busyShip(error: unknown): boolean {return error instanceof ShipClientError && ['transport', 'unavailable'].includes(error.code);}
/** The ship-side limit (lib/readymade-project-members member-limit): ships in a project, the owner and open invitations included. */
export const PROJECT_SHIP_LIMIT = 16;
/** A member's grants in a few words, from what the owner's ship holds now. */
export function memberGrants(held: SessionSharingSnapshot | undefined): string {
  if (!held) return 'grants not read';
  const shared = held.sessions.filter(session => session.shared).length;
  return `files ${held.viewGrant === 'live' ? 'shared' : 'not shared'} · ${shared === 0 ? 'no sessions' : shared === 1 ? '1 session' : `${shared} sessions`} shared`;
}
export class ProjectInvitationsView implements vscode.Disposable {
  private busy = false;
  private closed = false;
  private page?: InvitationPage;
  private scope = '';
  private readonly observed = new Map<string, Outcome>();
  private grants = new Map<string, SessionSharingSnapshot>();
  private retaining?: Promise<void>;
  constructor(private readonly extension: string, private readonly current: () => ShipClient | undefined,
    private readonly project: () => string | undefined, private readonly connect: (wanted?: string) => Promise<ShipClient | undefined>,
    private readonly journal: InvitationJournal, private readonly changed: () => void,
    private readonly guest: GuestServiceSteps = guestSteps) {}
  /**
   * A guest's own ship must run the collaboration agent before it can join. When it does not, ask once,
   * have the ship's kiln install it from the published source, and wait until the agent answers.
   * Nothing is joined or granted here; declining leaves the ship unchanged.
   */
  private async ensureGuestService(client: ShipClient, actor: string, from: GuestSource = GUEST_SOURCE): Promise<void> {
    let state: GuestServiceState = await client.guestServiceRead();
    if (state.status === 'ready') return this.ensureProtocol(client, actor, from);
    if (!this.active(client, actor)) throw new Error('Connection changed before joining.');
    const elsewhere = state.source && (state.source.ship !== from.ship || state.source.desk !== from.desk);
    const detail = [guestServiceMessage(state), 'Joining a shared project needs it.',
      `Your ship will install it from ${from.ship} (desk %${from.desk}, about 400 files) and keep it updated from there.`,
      ...(elsewhere ? [`It currently follows ${state.source!.ship} (desk %${state.source!.desk}); installing switches it to ${from.ship}.`] : []),
      'Nothing is joined until it is running.'].join(' ');
    if (state.status !== 'starting' && !await this.guest.confirm(detail)) throw new Error('Not joined: your ship needs the collaboration service to join.');
    await this.guest.progress('Installing the collaboration service on your ship', async () => {
      if (state.status !== 'starting') {
        try {await client.guestServiceInstall(from, state.status === 'suspended');} catch (error) {if (!(error instanceof OutcomeUnknownError)) throw error;}
      }
      for (const end = Date.now() + this.guest.deadlineMs; Date.now() < end;) {
        await this.guest.pause(this.guest.pollMs);
        if (!this.active(client, actor)) throw new Error('Connection changed while the collaboration service was installing.');
        // A ship answers nothing while it builds; an unanswered read is "not yet", never a failure.
        try {state = await client.guestServiceRead();} catch (error) {if (!busyShip(error)) throw error; continue;}
        if (state.status === 'ready') return;
      }
      throw new Error(`The collaboration service did not start in time (${guestServiceMessage(state)}). Check your ship, then join again.`);
    });
    await this.ensureProtocol(client, actor, from);
  }
  /** A running service older than this Readymade is updated by its own kiln from the same source, then read again. */
  /**
   * After connecting: read the outcome of every retained request of this ship that this window has not read yet
   * (a project joined yesterday, an invitation sent before a restart), so its row shows what happened and offers
   * the right actions without a Check Result click. Reads only, one at a time, at most sixteen; failures are left
   * for Check Result.
   */
  async observeRetained(): Promise<void> {
    const client = this.current();
    if (!client || this.closed || this.busy) return;
    let actor: string; try {actor = this.actor(client);} catch {return;}
    const unread = this.journal.entries().filter(row => row.origin === client.origin && row.actor === actor && !this.observed.has(this.key(row))).slice(0, 16);
    if (!unread.length) return;
    this.busy = true; this.changed();
    this.retaining = (async () => {
      try {
        for (const intent of unread) {
          if (this.closed || this.current() !== client) break;
          try {this.observed.set(this.key(intent), await this.journal.recover(client, intent));} catch { /* left for Check Result */ }
        }
      } finally {this.busy = false; this.retaining = undefined; this.changed();}
    })();
    await this.retaining;
  }
  /** An action pressed while retained results are still being read waits for that reading; it is not refused. */
  private async quiet(): Promise<void> {if (this.retaining) await this.retaining.catch(() => undefined);}
  /**
   * A command is sent once and the ship settles it a moment later (about a second, measured). Read the result a
   * few times so the person sees the outcome without pressing Check Result. Reads only; nothing is sent again.
   * If it has not settled, the retained row and Check Result remain exactly as before.
   */
  private async settle(client: ShipClient, intent: InvitationIntent, first: Outcome): Promise<Outcome> {
    let result = first;
    for (let n = 0; n < 8 && ['prepared', 'submitted'].includes(String(result.status)); n++) {
      await this.guest.pause(1000);
      if (this.closed || this.current() !== client) break;
      try {result = await this.journal.recover(client, intent);} catch {break;}
    }
    return result;
  }
  /** Install the collaboration service on the connected ship without joining anything; asks first, like a join does. */
  async installGuestService(): Promise<void> {
    await this.quiet();
    if (this.closed || this.busy) throw new Error('An invitation operation is already running.');
    this.busy = true; this.changed();
    try {
      const client = await this.connect(); if (!client || this.closed) return;
      const actor = this.actor(client);
      await this.ensureGuestService(client, actor);
      void vscode.window.showInformationMessage(`${actor} runs the collaboration service. Paste an invitation link under Join Project to join one.`);
    } finally {this.busy = false; this.changed();}
  }
  private async ensureProtocol(client: ShipClient, actor: string, from: GuestSource): Promise<void> {
    let seen = (await client.guestDeskRead()).protocol;
    if (seen >= GUEST_PROTOCOL) return;
    await this.guest.progress('Updating the collaboration service on your ship', async () => {
      try {await client.guestServiceInstall(from);} catch (error) {if (!(error instanceof OutcomeUnknownError)) throw error;}
      for (const end = Date.now() + this.guest.deadlineMs; Date.now() < end;) {
        await this.guest.pause(this.guest.pollMs);
        if (!this.active(client, actor)) throw new Error('Connection changed while the collaboration service was updating.');
        try {seen = (await client.guestDeskRead()).protocol;} catch { /* Read again; a reload answers nothing for a moment. */ }
        if (seen >= GUEST_PROTOCOL) return;
      }
      throw new Error(`Your ship's collaboration service is older (protocol ${seen}) than this Readymade needs (${GUEST_PROTOCOL}) and did not update in time.`);
    });
  }
  /**
   * Before an owner hands out a join link: this ship publishes the guest desk from its own code, so the guest can
   * install from the owner. One publish, then reads; if it does not settle, the link names no source (the guest uses
   * the distributor) and the owner is told.
   */
  private async publishedSource(client: ShipClient, actor: string): Promise<string | undefined> {
    let status = await client.guestDeskRead();
    if (guestDeskServing(status)) return actor;
    if (status.protocol === 0) return undefined; // This ship's agent predates publication.
    try {await client.guestDeskPublish();} catch (error) {if (!(error instanceof OutcomeUnknownError)) return undefined;}
    for (let reads = 0; reads < 15; reads++) {
      await this.guest.pause(1000);
      if (!this.active(client, actor)) return undefined;
      try {status = await client.guestDeskRead();} catch {continue;}
      if (guestDeskServing(status)) return actor;
    }
    return undefined;
  }
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
  private async members(client: ShipClient, actor: string, project: string, kind: MembersKind, offset = 0, catalog?: string): Promise<InvitationPage> {
    const reply = await client.projectInvitation('members', {project, kind, offset, ...(catalog ? {catalog} : {})});
    if (!this.active(client, actor, project) || reply.status !== 200) throw new Error('Project membership changed or is unavailable. Refresh explicitly.');
    return invitationMembers(reply.body, project, actor, kind, offset, catalog);
  }
  async observe(kind: MembersKind = 'members', next = false): Promise<void> {
    await this.quiet();
    this.sync(); const {client, actor, project} = this.owner();
    if (this.busy || this.closed) throw new Error('An invitation operation is already running.');
    const prior = this.page;
    if (next && (!prior || prior.kind !== kind || prior.next === null)) throw new Error('Refresh membership before reading another page.');
    this.busy = true; this.changed();
    try {
      const page = await this.members(client, actor, project, kind, next ? prior!.next! : 0, next ? prior!.catalog : undefined);
      // Each member's grants beside the role: one read per member, of what the owner's ship holds right now.
      const grants = new Map<string, SessionSharingSnapshot>();
      if (kind === 'members') for (const row of page.rows as MemberRow[]) {
        if (row.ship === actor) continue;
        try {grants.set(row.ship, await client.sessionSharingRead(project, row.ship));} catch { /* shown as not read */ }
        if (!this.active(client, actor, project)) throw new Error('Project changed while reading members. Refresh explicitly.');
      }
      this.page = page; this.grants = grants;
    } finally {this.busy = false; this.changed();}
  }
  /** Copy the join link of one pending invitation from the ship's own list, whoever recorded it and in whichever window. */
  async copyPendingLink(id: string): Promise<void> {
    await this.quiet();
    const {client, actor, project} = this.owner();
    if (this.closed || this.busy) throw new Error('An invitation operation is already running.');
    this.busy = true; this.changed();
    try {
      const row = (await this.pending(client, actor, project)).find(row => row.id === id);
      if (!row || row.expired) throw new Error('That invitation is no longer open. Refresh pending invitations.');
      const source = await this.publishedSource(client, actor);
      if (!this.active(client, actor, project)) throw new Error('Connection changed; no link was copied.');
      const uri = vscode.Uri.from({scheme: vscode.env.uriScheme, authority: this.extension, path: '/join-project',
        query: new URLSearchParams({authority: actor, project, invitation: row.id, target: row.target, ...(source ? {source} : {})}).toString()});
      joinProjectLink(uri, this.extension); await vscode.env.clipboard.writeText(uri.toString());
      void vscode.window.showInformationMessage(`Join link for ${row.target} copied (${row.role}). Only ${row.target} can use it.`);
    } finally {this.busy = false; this.changed();}
  }
  /** Invite, then put that invitation's join link on the clipboard: one step for the owner. */
  async inviteAndCopyLink(target?: string, selectedRole?: 'contributor' | 'observer' | 'maintainer'): Promise<void> {
    const sent = await this.invite(target, selectedRole);
    if (!sent) return;
    if (sent.status === 'refused') throw new Error('The ship refused the invitation, so no link was copied. Its reason is under Pending Project Invitations.');
    if (sent.status !== 'accepted') throw new Error('The ship has not confirmed the invitation yet, so no link was copied. Check the invitation result, then copy its link.');
    await this.copyLink(sent.request);
  }
  async invite(target?: string, selectedRole?: 'contributor' | 'observer' | 'maintainer'): Promise<{request: string; status: string} | undefined> {
    await this.quiet();
    const {client, actor, project} = this.owner();
    if (this.closed || this.busy) throw new Error('An invitation operation is already running.');
    this.busy = true; this.changed();
    try {
      const recipient = target ?? await vscode.window.showInputBox({title: 'Invite Collaborator', prompt: 'Collaborator ship, including ~'});
      if (!recipient) return undefined;
      if (!remoteShip(recipient) || recipient === actor) throw new Error('Enter another ship’s exact name.');
      // Someone who is already a member is offered another role: the same invitation, applied when they accept it.
      const roster = await this.members(client, actor, project, 'members');
      const held = (roster.rows as MemberRow[]).find(row => row.ship === recipient);
      const role = selectedRole ?? (await vscode.window.showQuickPick((['contributor', 'observer', 'maintainer'] as const).filter(name => name !== held?.role),
        {title: held ? `Offer ${recipient} another role (now ${held.role})` : 'Collaborator role', placeHolder: held ? 'Their role changes when they accept the new link; until then nothing changes.' : undefined}));
      if (!role) return undefined;
      if (held?.role === role) throw new Error(`${recipient} already has that role.`);
      const unresolved = this.journal.entries().find(row => row.origin === client.origin && row.actor === actor && row.command.project === project && row.command.operation === 'invite-member' && row.command.target === recipient && !['accepted', 'refused'].includes(this.observed.get(this.key(row))?.status ?? ''));
      if (unresolved) throw new Error('Check the retained invitation result before inviting this collaborator again.');
      const page = await this.members(client, actor, project, 'invitations');
      if (!held && roster.total + page.total >= PROJECT_SHIP_LIMIT) throw new Error(`This project is full: ${PROJECT_SHIP_LIMIT} ships in all, counting yours and open invitations. Remove a member or withdraw an invitation first.`);
      const nonce = '0x' + (BigInt('0x' + randomBytes(16).toString('hex')) || 1n).toString(16).replace(/\B(?=(?:[0-9a-f]{4})+$)/g, '.');
      const command = invitationCommand({request: randomUUID(), authority: actor, project, operation: 'invite-member', target: recipient, role, expiresAt: page.inviteUntil, nonce});
      const intent: InvitationIntent = {version: 1, origin: client.origin, actor, command};
      const result = await this.settle(client, intent, await this.journal.submit(client, intent, true));
      if (!this.active(client, actor, project)) throw new Error('Project changed; check the retained invitation result.');
      this.observed.set(this.key(intent), result);
      return {request: command.request, status: result.status};
    } finally {this.busy = false; this.changed();}
  }
  async join(value?: string | vscode.Uri): Promise<void> {
    const supplied = value ?? await vscode.window.showInputBox({title: 'Join Project', prompt: 'Paste the invitation link from the project owner.'});
    if (!supplied) return;
    const link = joinProjectLink(typeof supplied === 'string' ? vscode.Uri.parse(supplied, true) : supplied, this.extension);
    await this.quiet();
    if (this.closed || this.busy) throw new Error('An invitation operation is already running.');
    this.busy = true; this.changed();
    try {
      const client = await this.connect(link.target); if (!client || this.closed) return;
      const actor = this.actor(client);
      if (actor !== link.target) throw new Error(`This invitation is for ${link.target}. Connect that ship in another window.`);
      if (!this.active(client, actor)) throw new Error('Connection changed before joining.');
      await this.ensureGuestService(client, actor, link.source ? {ship: link.source, desk: GUEST_DESK} : GUEST_SOURCE);
      if (!this.active(client, actor)) throw new Error('Connection changed before joining.');
      const command = invitationCommand({request: randomUUID(), authority: link.authority, project: link.project, operation: 'join', invitation: link.invitation});
      const intent: InvitationIntent = {version: 1, origin: client.origin, actor, command};
      const result = await this.settle(client, intent, await this.journal.submit(client, intent, true));
      if (!this.active(client, actor)) throw new Error('Connection changed; check the retained join result.');
      this.observed.set(this.key(intent), result);
    } finally {this.busy = false; this.changed();}
    // Older rows of this ship (earlier joins and leaves) are read too, so the list shows where things stand.
    void this.observeRetained();
  }
  /**
   * A guest leaves a project it joined. The owner's ship settles it; sent once through the same journal as the
   * join, so an unknown outcome is checked, never resent. The owner's file and session grants end with membership.
   */
  async leave(request: string): Promise<void> {
    await this.quiet();
    const client = this.current();
    if (!client || this.closed || this.busy) throw new Error('Connect the ship that joined this project.');
    const actor = this.actor(client), joined = this.journal.entries().find(row => row.origin === client.origin && row.actor === actor && row.command.request === request);
    if (!joined || joined.command.operation !== 'join' || this.observed.get(this.key(joined))?.status !== 'accepted') throw new Error('Check the join result before leaving this project.');
    const {authority, project} = joined.command;
    const open = this.journal.entries().find(row => row.origin === client.origin && row.actor === actor && row.command.operation === 'leave' && row.command.authority === authority &&
      row.command.project === project && !['accepted', 'refused'].includes(this.observed.get(this.key(row))?.status ?? ''));
    if (open) throw new Error('Check the retained leave result before leaving again.');
    if (!await this.guest.confirm(`Leave ${project} on ${authority}? You lose access to its shared files and sessions. The owner can invite you again.`, 'Leave Project?', 'Leave')) return;
    this.busy = true; this.changed();
    try {
      const command = invitationCommand({request: randomUUID(), authority, project, operation: 'leave'});
      const intent: InvitationIntent = {version: 1, origin: client.origin, actor, command};
      const result = await this.settle(client, intent, await this.journal.submit(client, intent, true));
      if (!this.active(client, actor)) throw new Error('Connection changed; check the retained leave result.');
      this.observed.set(this.key(intent), result);
    } finally {this.busy = false; this.changed();}
  }
  /**
   * Remove the collaboration service from a guest's own ship: kiln uninstalls the guest desk, nothing else.
   * A ship that runs the agent from a full Readymade backend has no guest desk and is refused here.
   */
  async removeGuestService(): Promise<void> {
    await this.quiet();
    const client = this.current();
    if (!client || this.closed || this.busy) throw new Error('Connect the ship first.');
    const actor = this.actor(client);
    this.busy = true; this.changed();
    try {
      const desk = await client.guestServiceDeskRead();
      if (!this.active(client, actor)) throw new Error('Connection changed; nothing was removed.');
      if (!desk) throw new Error('This ship has no separately installed collaboration service. A full Readymade backend is removed from its own setup screen.');
      if (guestServiceRemoved(desk)) {void vscode.window.showInformationMessage('The collaboration service is already removed from this ship.'); return;}
      if (!await this.guest.confirm(`Remove the collaboration service (%${GUEST_DESK}) from ${actor}? Projects you joined stay joined on their owners' ships, but this ship can no longer open them until the service is installed again.`, 'Remove the collaboration service?', 'Remove')) return;
      await this.guest.progress('Removing the collaboration service from your ship', async () => {
        // Sent once. A ship can take longer to stop the service than a request waits (measured: about 40 s on a
        // moon), so an unanswered request is followed by reading the ship, never by sending again.
        try {await client.guestServiceRemove();} catch (error) {if (!(error instanceof OutcomeUnknownError)) throw error;}
        for (const end = Date.now() + this.guest.deadlineMs; Date.now() < end;) {
          await this.guest.pause(this.guest.pollMs);
          if (!this.active(client, actor)) throw new Error('Connection changed while removing; read the ship again.');
          let now: Awaited<ReturnType<ShipClient['guestServiceDeskRead']>>;
          try {now = await client.guestServiceDeskRead();} catch (error) {if (!busyShip(error)) throw error; continue;}
          if (guestServiceRemoved(now)) return;
        }
        throw new Error('The ship has not reported the service removed yet. Check again in a minute; nothing is sent twice.');
      });
      void vscode.window.showInformationMessage('The collaboration service was removed from your ship.');
    } finally {this.busy = false; this.changed();}
  }
  async check(request: string): Promise<void> {
    await this.quiet();
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
    await this.quiet();
    const {client, actor, project} = this.owner();
    if (this.closed || this.busy) throw new Error('An invitation operation is already running.');
    const intent = this.journal.entries().find(row => row.origin === client.origin && row.actor === actor && row.command.request === request);
    if (!intent || intent.command.operation !== 'invite-member' || intent.command.project !== project || this.observed.get(this.key(intent))?.status !== 'accepted') throw new Error('Check that the native invitation was accepted before copying its link.');
    const command = intent.command;
    this.busy = true; this.changed();
    try {
      const matches = (await this.pending(client, actor, project)).filter(row => row.target === command.target && row.role === command.role && row.issuedBy === actor && row.expiresAt === command.expiresAt && !row.expired);
      if (matches.length !== 1) throw new Error('One exact current native invitation was not found. No link was copied.');
      const source = await this.publishedSource(client, actor);
      if (!this.active(client, actor, project)) throw new Error('Connection changed; no link was copied.');
      const uri = vscode.Uri.from({scheme: vscode.env.uriScheme, authority: this.extension, path: '/join-project',
        query: new URLSearchParams({authority: actor, project, invitation: matches[0].id, target: command.target, ...(source ? {source} : {})}).toString()});
      joinProjectLink(uri, this.extension); await vscode.env.clipboard.writeText(uri.toString());
      void vscode.window.showInformationMessage(`Join link copied. ${source ? 'Your ship serves the collaboration service to the guest.' :
        `Your ship could not publish the collaboration service; the guest will install it from ${GUEST_SOURCE.ship}.`} Membership lasts until revoked; file access is granted separately.`);
    } finally {this.busy = false; this.changed();}
  }
  async closeInvitation(id: string, expire = false): Promise<void> {
    await this.quiet();
    const {client, actor, project} = this.owner();
    if (this.closed || this.busy) throw new Error('An invitation operation is already running.');
    this.busy = true; this.changed();
    try {
      const row = (await this.pending(client, actor, project)).find(row => row.id === id);
      if (!row || expire && !row.expired) throw new Error('Refresh pending invitations before closing this one.');
      const command: InvitationCommand = {request: randomUUID(), authority: actor, project, operation: expire ? 'expire-invitation' : 'revoke-invitation', invitation: id};
      const intent: InvitationIntent = {version: 1, origin: client.origin, actor, command};
      const result = await this.settle(client, intent, await this.journal.submit(client, intent, true));
      if (!this.active(client, actor, project)) throw new Error('Project changed; check the retained invitation result.');
      this.observed.set(this.key(intent), result);
    } finally {this.busy = false; this.changed();}
  }
  /** The first page of the project's history when that is what was last read, else undefined. */
  get history(): EventRow[] | undefined {this.sync(); return this.page?.kind === 'events' && this.page.offset === 0 ? this.page.rows as EventRow[] : undefined;}
  /** Expired invitations in the last read pending list, or undefined when that list is not what is held. */
  get expiredInvitations(): number | undefined {
    this.sync(); if (this.page?.kind !== 'invitations') return undefined;
    return (this.page.rows as InvitationRow[]).filter(row => row.expired).length;
  }
  rows(): MediaTreeRow[] {
    this.sync(); const client = this.current(); let actor: string | undefined;
    try {if (client) actor = this.actor(client);} catch { /* Authentication is required for actions. */ }
    const children: MediaTreeRow[] = [{label: 'Join Project…', command: {command: 'readymade.joinProject', title: 'Join Project'}}];
    if (client && actor && !client.snapshot) children.push({label: 'Remove Collaboration Service…', command: {command: 'readymade.removeCollaborationService', title: 'Remove Collaboration Service'}});
    if (client && actor === client.snapshot?.owner && this.project()) children.push(
      {label: 'Invite Collaborator…', command: {command: 'readymade.inviteCollaborator', title: 'Invite Collaborator'}},
      {label: 'Members', command: {command: 'readymade.projectMembers', title: 'Members'}},
      {label: 'Pending Invitations', command: {command: 'readymade.projectInvitations', title: 'Pending Invitations'}},
      {label: 'Project History', command: {command: 'readymade.projectHistory', title: 'Project History'}});
    if (this.busy) children.push({label: 'Observing invitation action…'});
    for (const row of this.page?.rows ?? []) {
      if ('sequence' in row) children.push({label: eventSentence(row), description: row.at.slice(1, 11).replaceAll('.', '-')});
      else if ('ship' in row) {
        const held = this.grants.get(row.ship), shared = held?.sessions.filter(session => session.shared).length ?? 0;
        children.push({label: row.ship, description: row.ship === actor ? row.role : `${row.role} · ${memberGrants(held)}`, children: row.ship === actor ? [] : [
          {label: held ? (held.viewGrant === 'live' ? 'Files: shared' : held.viewGrant === 'revoked' ? 'Files: sharing ended' : 'Files: not shared') : 'Grants not read'},
          ...(held ? [{label: `Sessions: ${shared} shared${held.sessionSharing === 'on' ? '' : ' (session sharing is off for this project)'}`}] : []),
          {label: 'Manage Shared Files…', command: {command: 'readymade.projectSharing', title: 'Manage Shared Files', arguments: [row.ship]}},
          ...(row.role === 'operator' ? [] : [{label: 'Offer Another Role…', command: {command: 'readymade.inviteCollaborator', title: 'Offer Another Role', arguments: [row.ship]}}])]});
      } else children.push({label: row.target, description: `${row.role} · ${row.expired ? 'Acceptance window expired' : 'Awaiting join'}`,
        children: [...(row.expired ? [] : [{label: 'Copy Join Link', command: {command: 'readymade.copyPendingJoinLink', title: 'Copy Join Link', arguments: [row.id]}}]),
          {label: row.expired ? 'Close Expired Invitation' : 'Revoke Invitation', command: {command: 'readymade.closeProjectInvitation', title: 'Close Invitation', arguments: [row.id, row.expired]}}]});
    }
    if (this.page?.next !== null && this.page) children.push({label: 'Next Page', command: {command: 'readymade.nextProjectMembers', title: 'Next Page', arguments: [this.page.kind]}});
    // Leave is offered once for a project, and only while this ship's accepted joins outnumber its accepted leaves.
    const retained = client && actor ? this.journal.entries().filter(row => row.origin === client.origin && row.actor === actor) : [];
    const balance = new Map<string, number>(), pair = (row: InvitationIntent) => row.command.authority + '\n' + row.command.project;
    for (const row of retained) if (this.observed.get(this.key(row))?.status === 'accepted' && (row.command.operation === 'join' || row.command.operation === 'leave'))
      balance.set(pair(row), (balance.get(pair(row)) ?? 0) + (row.command.operation === 'join' ? 1 : -1));
    if (client && actor) for (const intent of retained) {
      const outcome = this.observed.get(this.key(intent)), accepted = outcome?.status === 'accepted', command = intent.command;
      const offerLeave = accepted && command.operation === 'join' && (balance.get(pair(intent)) ?? 0) > 0;
      if (offerLeave) balance.set(pair(intent), 0);
      children.push({label: command.project, description: `${command.operation} · ${outcome?.status ?? 'retained — check result'}`,
        children: [{label: 'Check Result', command: {command: 'readymade.checkProjectInvitation', title: 'Check Result', arguments: [command.request]}},
          ...(accepted && command.operation === 'invite-member' ? [{label: 'Copy Join Link', command: {command: 'readymade.copyProjectJoinLink', title: 'Copy Join Link', arguments: [command.request]}}] : []),
          ...(accepted && command.operation === 'join' ? [{label: offerLeave ? 'Joined — ask owner for shared files' : 'Joined earlier'},
            ...(offerLeave ? [{label: 'Leave Project…', command: {command: 'readymade.leaveProject', title: 'Leave Project', arguments: [command.request]}}] : [])] : [])]});
    }
    return [{id: 'project-invitations', label: 'Project Invitations', icon: 'organization', children}];
  }
  dispose(): void {this.closed = true; this.observed.clear(); this.grants.clear(); this.page = undefined;}
}
