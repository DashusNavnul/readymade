import * as fs from 'node:fs';
import { join } from 'node:path';
import { asRecord } from './protocol';
import { digest, originOf } from './source-store';
import { sharingCommand, sharingResult, sharingView } from './project-sharing';
import type { ProjectSharingCommand, ShipClient } from './ship-client';

type Client = Pick<ShipClient, 'origin' | 'projectSharing'>;
export interface SharingIntent {version: 1; origin: string; command: ProjectSharingCommand}
function validate(value: unknown): SharingIntent {
  const r = asRecord(value);
  if (r.version !== 1 || typeof r.origin !== 'string' || originOf(r.origin) !== r.origin || Object.keys(r).length !== 3) throw new Error('Invalid retained sharing intent.');
  return {version: 1, origin: r.origin, command: sharingCommand(r.command)};
}
/** One immutable intent per observed peer view, across windows and restarts. */
export class SharingJournal {
  constructor(readonly directory: string) {}
  private key(i: SharingIntent): string {const c = i.command; return digest(JSON.stringify([i.origin, c.owner, c.project, c.peer, c.expected]));}
  private privateInfo(info: fs.Stats, directory = false): void {
    if (!(directory ? info.isDirectory() : info.isFile()) || info.isSymbolicLink() || process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new Error('Sharing journal must be private and owned.');
  }
  entries(): SharingIntent[] {
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700}); this.privateInfo(fs.lstatSync(this.directory), true);
    const files = fs.readdirSync(this.directory).filter(f => f.endsWith('.intent.json'));
    if (files.length > 512) throw new Error('Sharing journal capacity reached.');
    return files.map(file => {
      const fd = fs.openSync(join(this.directory, file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const info = fs.fstatSync(fd); this.privateInfo(info);
        if (info.size > 8192) throw new Error('Sharing intent exceeds its limit.');
        const intent = validate(JSON.parse(fs.readFileSync(fd, 'utf8')));
        if (file !== this.key(intent) + '.intent.json') throw new Error('Sharing intent identity changed.');
        return intent;
      } finally {fs.closeSync(fd);}
    });
  }
  async submit(client: Client, supplied: SharingIntent, consent: boolean) {
    const intent = validate(supplied), c = intent.command;
    if (consent !== true || client.origin !== intent.origin) throw new Error('Confirm sharing on the selected ship.');
    const entries = this.entries();
    if (entries.length >= 512 || entries.some(i => this.key(i) === this.key(intent) || i.command.request === c.request)) throw new Error('Observe the retained sharing request; it will not be sent again.');
    const reply = await client.projectSharing('read', {project: c.project, peer: c.peer});
    if (reply.status !== 200) throw new Error('Current sharing state is unavailable.');
    const view = sharingView(reply.body);
    if (view.owner !== c.owner || view.project !== c.project || view.peer !== c.peer || view.expected !== c.expected) throw new Error('Sharing state changed; observe it again.');
    const data = JSON.stringify(intent);
    if (Buffer.byteLength(data) > 8192) throw new Error('Sharing intent exceeds its limit.');
    const fd = fs.openSync(join(this.directory, this.key(intent) + '.intent.json'), 'wx', 0o600);
    try {fs.writeFileSync(fd, data); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    const directory = fs.openSync(this.directory, fs.constants.O_RDONLY);
    try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
    const submitted = await client.projectSharing('submit', c);
    if (submitted.status !== 200 && submitted.status !== 202) return {intent, status: 'unconfirmed', reason: 'Observe the retained request; no retry was sent.'};
    return {intent, ...sharingResult(submitted.body, c)};
  }
  async recover(client: Client, supplied: SharingIntent) {
    const intent = validate(supplied), retained = this.entries().find(i => this.key(i) === this.key(intent));
    if (client.origin !== intent.origin || JSON.stringify(retained) !== JSON.stringify(intent)) throw new Error('Retained sharing context changed.');
    const reply = await client.projectSharing('result', {request: intent.command.request});
    if (reply.status === 404) return {intent, status: 'unconfirmed', reason: 'Request not observed. A delayed request may still arrive; no retry was sent.'};
    if (reply.status !== 200) throw new Error('Canonical sharing outcome is unavailable.');
    return {intent, ...sharingResult(reply.body, intent.command)};
  }
}
