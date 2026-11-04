import { constants, closeSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ShipClient, ShipClientError } from './ship-client';
import { JsonObject, validUnicode } from './protocol';

export type RequestStatus = 'unknown' | 'submitted' | 'accepted' | 'refused' | 'not-sent';
export interface RequestEntry { id: string; destination: string; text: string; at: string; status: RequestStatus; reason?: string }
interface Journal { version: 1; origin: string; entries: RequestEntry[]; drafts: Record<string, string> }
const settled = (e: RequestEntry) => ['accepted', 'refused', 'not-sent'].includes(e.status);
const LIMIT = 1024 * 1024;
// These unwrapped, status-less codes originate before POST in ShipClient.requestJSON.
// Response/transport failures are wrapped as OutcomeUnknownError by that method.
const notSent = (error: unknown) => error instanceof ShipClientError && error.status === undefined &&
  ['commandBusy', 'closed', 'contextChanged', 'malformed', 'tooLarge', 'cancelledBeforeSend'].includes(error.code);
export const validDestination = (v: string) => v === 'private' || /^seat:[a-z]+(?:-[a-z]+)*$/.test(v) && v.length <= 37;
function requestID(): string {
  let n = BigInt('0x' + randomBytes(16).toString('hex')); if (!n) n = 1n;
  const s = n.toString(32); return '0v' + s.replace(/\B(?=(.{5})+$)/g, '.');
}
function privateRead(path: string): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid?.() || s.mode & 0o077 || s.size > LIMIT) throw new Error('Unsafe request journal');
    const bytes = Buffer.alloc(LIMIT + 1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, length); if (!count) break; length += count; }
    if (length > LIMIT) throw new Error('Unsafe request journal');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { closeSync(fd); }
}

/** Recovery evidence only. The ship receipt is the sole acceptance authority. */
export class ConversationStore {
  readonly file: string;
  private state: Journal;
  private baseline: string | undefined;
  private readonly inFlight = new Set<string>();
  constructor(readonly directory: string, readonly origin: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.uid !== process.getuid?.() || dir.mode & 0o077) throw new Error('Unsafe request journal directory');
    this.file = join(directory, createHash('sha256').update(origin).digest('hex') + '.json');
    this.baseline = privateRead(this.file);
    this.state = this.baseline === undefined ? { version: 1, origin, entries: [], drafts: {} } : JSON.parse(this.baseline) as Journal;
    this.validate(this.state);
  }
  get entries(): readonly RequestEntry[] { return structuredClone(this.state.entries); }
  draft(destination: string): string { return this.state.drafts[destination] ?? ''; }
  saveDraft(destination: string, text: string): void {
    if (!validDestination(destination) || !validUnicode(text) || Buffer.byteLength(text) > 8192) throw new Error('Invalid request draft');
    const next = structuredClone(this.state);
    if (text) next.drafts[destination] = text; else delete next.drafts[destination];
    this.commit(next);
  }
  issue(destination: string, raw: string): RequestEntry {
    const text = raw.trim();
    if (!validDestination(destination) || !validUnicode(raw) || !text || Buffer.byteLength(raw) > 8192 || Buffer.byteLength(text) > 4096) throw new Error('Enter 1–4096 UTF-8 bytes');
    if (this.state.entries.some(e => e.destination === destination && !settled(e))) throw new Error('Check the pending request receipt before sending another request here');
    const entry: RequestEntry = { id: requestID(), destination, text, at: new Date().toISOString(), status: 'unknown' };
    const next = structuredClone(this.state); next.entries.push(entry); this.commit(next); return entry;
  }
  receipt(id: string, object: JsonObject): void {
    const next = structuredClone(this.state), entry = next.entries.find(e => e.id === id);
    if (!entry || object.id !== id || typeof object.known !== 'boolean') throw new Error('Invalid ship receipt');
    if (!object.known) return;
    if (object.destination !== (entry.destination === 'private' ? 'private' : 'seat') || !['accepted', 'refused'].includes(String(object.outcome))) throw new Error('Mismatched ship receipt');
    if (settled(entry) && entry.status !== object.outcome) throw new Error('Contradictory settled receipt');
    if (object.reason !== undefined && object.reason !== null && (typeof object.reason !== 'string' || !validUnicode(object.reason) || Buffer.byteLength(object.reason) > 8192)) throw new Error('Invalid receipt reason');
    entry.status = object.outcome as RequestStatus;
    if (typeof object.reason === 'string') entry.reason = object.reason; else delete entry.reason;
    if (entry.status === 'accepted' && next.drafts[entry.destination]?.trim() === entry.text) delete next.drafts[entry.destination];
    this.commit(next);
  }
  async submit(client: Pick<ShipClient, 'origin' | 'requestJSON'>, destination: string, raw: string): Promise<RequestEntry> {
    if (client.origin !== this.origin) throw new Error('Request origin changed');
    this.saveDraft(destination, raw);
    const entry = this.issue(destination, raw); // Durable unknown intent BEFORE network I/O; never replay.
    this.inFlight.add(entry.id);
    try {
      let object: JsonObject;
      try { object = await client.requestJSON('/apps/pataphor/remote/submit', { method: 'POST', body: { id: entry.id, destination, text: entry.text } }); }
      catch (error) {
        if (notSent(error)) {
          const next = structuredClone(this.state), current = next.entries.find(e => e.id === entry.id)!;
          if (!settled(current)) { current.status = 'not-sent'; current.reason = 'Not sent: ' + (error as ShipClientError).code; this.commit(next); }
          throw new Error('Request was not sent. Your draft is retained; submit again explicitly to create a new request.');
        }
        throw new Error('Request outcome unconfirmed. Check the original receipt; nothing will be resent.');
      }
      if (object.submitted === true) {
        if (!destination.startsWith('seat:') || object.id !== entry.id || object.seat !== destination.slice(5)) throw new Error('Mismatched submission receipt');
        const next = structuredClone(this.state), current = next.entries.find(e => e.id === entry.id)!;
        if (!settled(current)) { current.status = 'submitted'; this.commit(next); }
      } else this.receipt(entry.id, object);
      return this.entries.find(e => e.id === entry.id)!;
    } finally { this.inFlight.delete(entry.id); }
  }
  async checkReceipts(client: Pick<ShipClient, 'origin' | 'requestJSON'>): Promise<void> {
    if (client.origin !== this.origin) throw new Error('Request origin changed');
    for (const e of this.entries.filter(e => !settled(e))) {
      const query = new URLSearchParams({ id: e.id, destination: e.destination });
      this.receipt(e.id, await client.requestJSON('/apps/pataphor/remote/receipt.json?' + query.toString()));
    }
  }
  private validate(s: Journal): void {
    if (s.version !== 1 || s.origin !== this.origin || !Array.isArray(s.entries) || s.entries.length > 64 || !s.drafts || typeof s.drafts !== 'object' || Array.isArray(s.drafts) || Object.keys(s.drafts).length > 32) throw new Error('Invalid request journal');
    const ids = new Set<string>();
    for (const e of s.entries) {
      if (!/^0v[1-9a-v][0-9a-v]{0,4}(?:\.[0-9a-v]{5})*$/.test(e.id) || e.id.replaceAll('.', '').length > 28 || ids.has(e.id) || !validDestination(e.destination) || typeof e.text !== 'string' || !validUnicode(e.text) || !e.text || Buffer.byteLength(e.text) > 4096 || !['unknown', 'submitted', 'accepted', 'refused', 'not-sent'].includes(e.status) || !Number.isFinite(Date.parse(e.at)) ||
          e.reason !== undefined && (typeof e.reason !== 'string' || !validUnicode(e.reason) || Buffer.byteLength(e.reason) > 8192)) throw new Error('Invalid request journal entry');
      ids.add(e.id);
    }
    for (const [d, text] of Object.entries(s.drafts)) if (!validDestination(d) || typeof text !== 'string' || !validUnicode(text) || Buffer.byteLength(text) > 8192) throw new Error('Invalid saved draft');
  }
  private commit(next: Journal): void {
    let archive: Journal | undefined;
    if (next.entries.length > 64 || Buffer.byteLength(JSON.stringify(next)) > LIMIT) {
      const entries: RequestEntry[] = [];
      for (const entry of next.entries.filter(e => settled(e) && !this.inFlight.has(e.id))) {
        if (entries.length >= 32 || Buffer.byteLength(JSON.stringify({ version: 1, origin: this.origin, entries: [...entries, entry], drafts: {} })) > LIMIT) break;
        entries.push(entry);
      }
      if (!entries.length) throw new Error('Request journal full; no request sent');
      archive = { version: 1, origin: this.origin, entries, drafts: {} };
      const ids = new Set(entries.map(e => e.id)); next = { ...next, entries: next.entries.filter(e => !ids.has(e.id)) };
    }
    this.validate(next);
    const bytes = JSON.stringify(next); if (Buffer.byteLength(bytes) > LIMIT) throw new Error('Request journal full');
    const directory = lstatSync(this.directory);
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || directory.mode & 0o077) throw new Error('Unsafe request journal directory');
    const lock = this.file + '.lock', fd = openSync(lock, 'wx', 0o600);
    const temp = this.file + '.' + randomBytes(8).toString('hex');
    try {
      if (privateRead(this.file) !== this.baseline) throw new Error('Request journal changed in another window');
      if (archive) this.archive(archive); // Durable immutable bytes BEFORE pruning the active file.
      const out = openSync(temp, 'wx', 0o600);
      try { writeFileSync(out, bytes); fsyncSync(out); } finally { closeSync(out); }
      renameSync(temp, this.file);
      const dir = openSync(this.directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
      this.baseline = bytes; this.state = next;
    } finally {
      closeSync(fd); unlinkSync(lock);
      try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  private archive(value: Journal): void {
    this.validate(value);
    if (value.entries.some(e => !settled(e)) || Object.keys(value.drafts).length) throw new Error('Unsafe request archive');
    const bytes = JSON.stringify(value), hash = createHash('sha256').update(bytes).digest('hex');
    const destination = this.file.replace(/\.json$/, '') + '.archive-' + hash + '.json';
    const temporary = destination + '.' + randomBytes(8).toString('hex');
    const fd = openSync(temporary, 'wx', 0o600);
    let opened = true;
    try {
      writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); opened = false;
      try { linkSync(temporary, destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || privateRead(destination) !== bytes) throw new Error('Request archive conflict; active evidence retained'); }
      const dir = openSync(this.directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally { if (opened) closeSync(fd); unlinkSync(temporary); }
  }
}
