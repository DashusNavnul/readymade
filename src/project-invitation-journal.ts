import * as fs from 'node:fs';
import {join} from 'node:path';
import {asRecord} from './protocol';
import {digest, originOf} from './source-store';
import {remoteShip} from './remote-project-view';
import {invitationCommand, invitationResult, type InvitationCommand} from './project-invitations';
import type {ShipClient} from './ship-client';

type Client = Pick<ShipClient, 'origin' | 'projectInvitation' | 'browserCookies'> & {assertIdle?(): void};
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
  entries(): InvitationIntent[] {return this.read().map(row => row.intent);}
  /** Oldest first, by when each intent was written to this journal (its file's creation time). */
  ordered(): InvitationIntent[] {return this.read().sort((a, b) => a.at - b.at).map(row => row.intent);}
  private read(): {intent: InvitationIntent; at: number}[] {
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
        return {intent, at: info.birthtimeMs || info.mtimeMs};
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
    // Before anything is recorded: a client that could not send now would leave an intent that was never sent and is never sent again.
    client.assertIdle?.();
    this.entries();
    const lock = join(this.directory, '.write.lock'), fd = fs.openSync(lock, 'wx', 0o600);
    try {
      const held = this.entries();
      if (held.length >= 512 || held.some(i => this.key(i) === this.key(intent) || i.command.request === intent.command.request)) throw new Error('Observe the retained invitation; it will not be sent again. If your ship does not hold it, put it aside under Project Invitations and make the request again.');
      const file = fs.openSync(join(this.directory, this.key(intent) + '.intent.json'), 'wx', 0o600);
      try {fs.writeFileSync(file, JSON.stringify(intent)); fs.fsyncSync(file);} finally {fs.closeSync(file);}
      const dir = fs.openSync(this.directory, fs.constants.O_RDONLY); try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}
    } finally {fs.closeSync(fd); fs.unlinkSync(lock);}
    this.context(client, intent);
    const reply = await client.projectInvitation('submit', intent.command); this.context(client, intent);
    // Not recorded by this ship. A refusal it gave before recording anything names its reason; that is kept for the row.
    if (reply.status !== 200) {
      const said = reply.status === 409 ? asRecord(reply.body).message : undefined;
      return {intent, status: 'unconfirmed' as const, ...(typeof said === 'string' && /^[a-z-]{1,64}$/.test(said) ? {reason: said} : {})};
    }
    return {intent, ...invitationResult(reply.body, intent.command)};
  }
  /**
   * Put aside a request this ship does not hold, so the same request can be made again. This ship records a
   * command before it sends anything to an owner, so a request it has no record of was sent to no one: Readymade
   * stopped, or the ship refused, between writing the intent here and the ship recording it. The ship is read once
   * more first, and a request written under a minute ago is left alone because it may still be arriving. The
   * intent moves to `history/`; nothing is deleted. Should the ship hold the same action after all, under another
   * request, it refuses the repeat itself: it never sends one action twice.
   */
  async retire(client: Client, supplied: InvitationIntent, now = Date.now()): Promise<void> {
    const intent = validate(supplied); this.context(client, intent);
    const held = this.read().find(row => this.key(row.intent) === this.key(intent));
    if (!held || JSON.stringify(held.intent) !== JSON.stringify(intent)) throw new Error('Retained invitation context changed.');
    if (now - held.at < 60000) throw new Error('This request was recorded less than a minute ago and may still be on its way. Check its result in a minute.');
    const reply = await client.projectInvitation('result', {request: intent.command.request}); this.context(client, intent);
    if (reply.status === 200) throw new Error('Your ship holds this request after all. Check its result; it was not put aside.');
    if (reply.status !== 404) throw new Error('Your ship could not be read. Nothing was changed.');
    const lock = join(this.directory, '.write.lock'), fd = fs.openSync(lock, 'wx', 0o600);
    try {
      const history = join(this.directory, 'history'), name = this.key(intent) + '.intent.json';
      fs.mkdirSync(history, {recursive: true, mode: 0o700}); this.privateInfo(fs.lstatSync(history), true);
      // Kept under its own request, so a later request for the same action that is put aside too does not replace it.
      fs.renameSync(join(this.directory, name), join(history, `${this.key(intent)}.${intent.command.request}.intent.json`));
      for (const directory of [history, this.directory]) {const dir = fs.openSync(directory, fs.constants.O_RDONLY); try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}}
    } finally {fs.closeSync(fd); fs.unlinkSync(lock);}
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
