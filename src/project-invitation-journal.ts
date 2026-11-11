import * as fs from 'node:fs';
import {join} from 'node:path';
import {asRecord} from './protocol';
import {digest, originOf} from './source-store';
import {remoteShip} from './remote-project-view';
import {invitationCommand, invitationResult, type InvitationCommand} from './project-invitations';
import type {ShipClient} from './ship-client';

type Client = Pick<ShipClient, 'origin' | 'projectInvitation' | 'browserCookies'>;
export interface InvitationIntent {version: 1; origin: string; actor: string; command: InvitationCommand}
function validate(value: unknown): InvitationIntent {
  const r = asRecord(value);
  if (r.version !== 1 || typeof r.origin !== 'string' || originOf(r.origin) !== r.origin || !remoteShip(r.actor) || Object.keys(r).length !== 4) throw new Error('Invalid retained invitation intent.');
  return {version: 1, origin: r.origin, actor: r.actor, command: invitationCommand(r.command)};
}
/** Immutable once-only intent. Canonical outcomes are read, never inferred from local storage. */
export class InvitationJournal {
  constructor(readonly directory: string) {}
  private key(i: InvitationIntent): string {
    // The same action is retained once, whatever request id a window gave it. A leave is the exception: it names
    // no invitation, so leaving a project again after rejoining is the same action; each leave is its own entry.
    const {request: _request, ...action} = i.command;
    const basis = i.command.operation === 'leave' ? i.command : action;
    return digest(JSON.stringify([i.origin, i.actor, Object.entries(basis).sort(([a], [b]) => a.localeCompare(b))]));
  }
  private privateInfo(info: fs.Stats, directory = false): void {
    if (!(directory ? info.isDirectory() : info.isFile()) || info.isSymbolicLink() || process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new Error('Invitation journal must be private and owned.');
  }
  entries(): InvitationIntent[] {
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700}); this.privateInfo(fs.lstatSync(this.directory), true);
    const files = fs.readdirSync(this.directory).filter(f => f.endsWith('.intent.json'));
    if (files.length > 512) throw new Error('Invitation journal capacity reached.');
    return files.map(file => {
      const fd = fs.openSync(join(this.directory, file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const info = fs.fstatSync(fd); this.privateInfo(info);
        if (info.size > 8192) throw new Error('Invitation intent exceeds its limit.');
        const intent = validate(JSON.parse(fs.readFileSync(fd, 'utf8')));
        if (file !== this.key(intent) + '.intent.json') throw new Error('Invitation intent identity changed.');
        return intent;
      } finally {fs.closeSync(fd);}
    });
  }
  private context(client: Client, intent: InvitationIntent): void {
    const cookies = client.browserCookies(intent.origin).filter(c => c.name.startsWith('urbauth-'));
    if (client.origin !== intent.origin || cookies.length !== 1 || cookies[0].name !== 'urbauth-' + intent.actor) throw new Error('Invitation belongs to another authenticated ship.');
    if (['invite-member', 'revoke-invitation', 'expire-invitation'].includes(intent.command.operation) && intent.actor !== intent.command.authority) throw new Error('The project owner must issue this invitation action.');
  }
  async submit(client: Client, supplied: InvitationIntent, consent: boolean) {
    const intent = validate(supplied); this.context(client, intent);
    if (consent !== true) throw new Error('Confirm the invitation action first.');
    this.entries();
    const lock = join(this.directory, '.write.lock'), fd = fs.openSync(lock, 'wx', 0o600);
    try {
      const held = this.entries();
      if (held.length >= 512 || held.some(i => this.key(i) === this.key(intent) || i.command.request === intent.command.request)) throw new Error('Observe the retained invitation; it will not be sent again.');
      const file = fs.openSync(join(this.directory, this.key(intent) + '.intent.json'), 'wx', 0o600);
      try {fs.writeFileSync(file, JSON.stringify(intent)); fs.fsyncSync(file);} finally {fs.closeSync(file);}
      const dir = fs.openSync(this.directory, fs.constants.O_RDONLY); try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}
    } finally {fs.closeSync(fd); fs.unlinkSync(lock);}
    this.context(client, intent);
    const reply = await client.projectInvitation('submit', intent.command); this.context(client, intent);
    if (reply.status !== 200) return {intent, status: 'unconfirmed' as const};
    return {intent, ...invitationResult(reply.body, intent.command)};
  }
  async recover(client: Client, supplied: InvitationIntent) {
    const intent = validate(supplied); this.context(client, intent);
    const retained = this.entries().find(i => this.key(i) === this.key(intent));
    if (JSON.stringify(retained) !== JSON.stringify(intent)) throw new Error('Retained invitation context changed.');
    const reply = await client.projectInvitation('result', {request: intent.command.request}); this.context(client, intent);
    if (reply.status === 404) return {intent, status: 'unconfirmed' as const};
    if (reply.status !== 200) throw new Error('Canonical invitation outcome is unavailable.');
    return {intent, ...invitationResult(reply.body, intent.command)};
  }
}
