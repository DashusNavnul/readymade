import { lstat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { asRecord, validJSON, validUnicode, type JsonObject } from './protocol';

export type MediaOperation = 'status' | 'bind' | 'navigate' | 'observe' | 'forget';
export interface MediaOpenEvent { type: 'open'; bindingId: string; url: string }
const REFUSAL_REASONS = new Set(['invalidOrigin', 'invalidBinding', 'invalidURL', 'invalidCookies', 'alreadyBound',
  'bootstrapNotFound', 'unsafeView', 'cookieOriginConflict', 'bindingMissing', 'bindingFault', 'bindingCapacity', 'requestFailed']);
export class MediaClientError extends Error {
  readonly reason?: string;
  constructor(readonly code: string, readonly bindingId?: string, reason?: string) {
    const safeReason = reason && REFUSAL_REASONS.has(reason) ? reason : undefined;
    super(`Browser connection failed: ${code}${safeReason ? ': ' + safeReason : ''}.`);
    this.name = 'MediaClientError'; if (safeReason) this.reason = safeReason;
  }
}
export class MediaOutcomeUnknownError extends MediaClientError {
  constructor(bindingId?: string) { super('outcomeUnknown', bindingId); this.name = 'MediaOutcomeUnknownError'; }
}
interface Binding { origin: string; kind: string }
interface Pending { op: MediaOperation; bindingId?: string; bindingIds?: readonly string[]; origin?: string; timer: NodeJS.Timeout; resolve(value: JsonObject): void; reject(error: Error): void }
const ID = /^[a-f0-9]{32}$/, LIMIT = 4 * 1024 * 1024;
function fail(code: string, bindingId?: string): never { throw new MediaClientError(code, bindingId); }
function originOf(raw: unknown): string {
  if (typeof raw !== 'string' || !/^https?:\/\/[^/?#@]+$/i.test(raw) || /[\s\\]/u.test(raw)) return fail('invalidOrigin');
  let url: URL; try { url = new URL(raw); } catch { return fail('invalidOrigin'); }
  if (url.origin !== raw || url.port === '0' || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return fail('invalidOrigin');
  return raw;
}
function destination(origin: string, value: unknown, login = false): string {
  if (typeof value !== 'string' || !validUnicode(value) || value.length > 8192 || /[\s\\\u0000-\u001f]/u.test(value)) return fail('invalidURL');
  let url: URL; try { url = new URL(value); } catch { return fail('invalidURL'); }
  if (url.origin !== origin || url.username || url.password || !(url.pathname.startsWith('/apps/') || login && url.pathname === '/~/login')) return fail('invalidURL');
  return value;
}
/** Bounded private IPC into the existing editor host, with no reconnect or write replay loop. */
export class MediaClient {
  private socket?: Socket;
  private connecting?: Promise<Socket>;
  private closed = false;
  private input = Buffer.alloc(0);
  private readonly pending = new Map<string, Pending>();
  private readonly bindings = new Map<string, Binding>();
  private readonly unknown = new Set<string>();
  private readonly unknownForget = new Set<string>();
  private readonly listeners = new Set<(event: MediaOpenEvent) => void>();
  readonly events = { onOpen: (callback: (event: MediaOpenEvent) => void): { dispose(): void } => {
    this.listeners.add(callback); return { dispose: () => { this.listeners.delete(callback); } };
  } };
  constructor(readonly directory: string) { if (!isAbsolute(directory)) fail('unsafeSocket'); }
  close(): void { this.closed = true; this.listeners.clear(); this.disconnect('closed'); }
  async request(op: MediaOperation, payload: JsonObject = {}): Promise<JsonObject> {
    if (this.closed) fail('closed');
    if (!['status', 'bind', 'navigate', 'observe', 'forget'].includes(op)) fail('invalidOperation');
    try { asRecord(payload); if (!validJSON(payload)) fail('malformed'); } catch { return fail('malformed'); }
    const write = ['bind', 'navigate', 'forget'].includes(op), bindingId = op === 'status' || op === 'forget' ? undefined : payload.bindingId;
    if (bindingId !== undefined && (typeof bindingId !== 'string' || !ID.test(bindingId)) || op !== 'status' && op !== 'forget' && bindingId === undefined) fail('invalidBinding');
    const binding = typeof bindingId === 'string' ? this.bindings.get(bindingId) : undefined;
    let origin = binding?.origin, bindingIds: readonly string[] | undefined;
    if (op === 'bind') {
      origin = originOf(payload.origin);
      if (!['glurff', 'noltbook', 'landscape', 'groups', 'call'].includes(String(payload.kind)) || payload.bootstrapURL !== 'about:blank#readymade-' + bindingId ||
          !Array.isArray(payload.cookies) || !payload.cookies.length || payload.cookies.length > 8) fail('invalidBinding');
      destination(origin, payload.url);
      for (const item of payload.cookies) {
        const cookie = asRecord(item);
        if (typeof cookie.name !== 'string' || !/^urbauth-[A-Za-z0-9~-]+$/.test(cookie.name) || typeof cookie.value !== 'string' ||
            !/^[^\s;,]{1,4096}$/.test(cookie.value) || cookie.expires !== undefined &&
            (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires) || cookie.expires <= Date.now() / 1000)) fail('invalidCookie');
      }
      if (binding && (binding.origin !== origin || binding.kind !== payload.kind)) fail('invalidBinding');
    } else if (op === 'navigate') { if (!binding) fail('invalidBinding'); destination(binding.origin, payload.url); }
    else if (op === 'forget') {
      origin = originOf(payload.origin);
      if (!Array.isArray(payload.bindingIds) || !payload.bindingIds.length || payload.bindingIds.length > 8 ||
          payload.bindingIds.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(payload.bindingIds).size !== payload.bindingIds.length) fail('invalidBinding');
      bindingIds = Object.freeze([...(payload.bindingIds as string[])]);
      if (bindingIds.some(id => this.bindings.get(id)?.origin !== origin)) fail('invalidBinding');
      payload = { origin, bindingIds }; // Freeze the exact owned scope before any asynchronous work.
    }
    const scope = bindingIds ?? (typeof bindingId === 'string' ? [bindingId] : []);
    if (write) this.writeGuard(op, scope);
    const id = randomBytes(16).toString('hex'); let data: string;
    try { data = JSON.stringify({ id, op, payload }) + '\n'; } catch { return fail('malformed'); }
    if (Buffer.byteLength(data) > 65536) fail('tooLarge');
    const socket = await this.connection();
    if (this.closed || socket !== this.socket || socket.destroyed) fail('closed');
    if (this.pending.size >= 16) fail('busy');
    if (write) this.writeGuard(op, scope);
    if (op === 'forget' && bindingIds!.some(id => this.bindings.get(id)?.origin !== origin)) fail('invalidBinding');
    const retained = typeof bindingId === 'string' ? this.bindings.get(bindingId) : undefined;
    if (op === 'bind' && retained && (retained.origin !== origin || retained.kind !== payload.kind)) fail('invalidBinding');
    if (op === 'bind') this.bindings.set(bindingId as string, { origin: origin!, kind: payload.kind as string });
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id); if (!entry) return;
        this.pending.delete(id); this.markUnknown(entry); reject(write ? new MediaOutcomeUnknownError(entry.bindingId) : new MediaClientError('timeout'));
      }, 10000);
      this.pending.set(id, { op, bindingId: bindingId as string | undefined, bindingIds, origin, timer, resolve, reject });
      try { socket.write(data, error => { if (error && this.socket === socket) this.disconnect('transport'); }); }
      catch { if (this.socket === socket) this.disconnect('transport'); }
    });
  }
  private writeGuard(op: MediaOperation, scope: readonly string[]): void {
    if (scope.some(id => this.unknownForget.has(id) || op !== 'forget' && this.unknown.has(id))) fail('observeRequired', scope[0]);
    if ([...this.pending.values()].some(entry => ['bind', 'navigate', 'forget'].includes(entry.op) &&
        (entry.bindingIds ?? (entry.bindingId ? [entry.bindingId] : [])).some(id => scope.includes(id)))) fail('busy');
  }
  private async securePath(): Promise<{ dev: number; ino: number }> {
    try {
      const directory = await lstat(this.directory), socket = await lstat(join(this.directory, 'readymade-media.sock'));
      if (!directory.isDirectory() || directory.uid !== process.getuid?.() || directory.mode & 0o077 ||
          !socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o777) !== 0o600) fail('unsafeSocket');
      return { dev: socket.dev, ino: socket.ino };
    } catch (error) { if (error instanceof MediaClientError) throw error; return fail('unavailable'); }
  }
  private async connection(): Promise<Socket> {
    await this.securePath();
    if (this.closed) return fail('closed');
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return this.socket;
    const opening = this.open(); this.connecting = opening;
    try { return await opening; } finally { if (this.connecting === opening) this.connecting = undefined; }
  }
  private async open(): Promise<Socket> {
    const before = await this.securePath();
    if (this.closed) return fail('closed');
    const socket = createConnection(join(this.directory, 'readymade-media.sock')); this.socket = socket; this.input = Buffer.alloc(0);
    socket.on('data', data => this.receive(socket, data));
    socket.on('error', () => { if (this.socket === socket) this.disconnect('transport'); });
    socket.on('close', () => { if (this.socket === socket) this.disconnect('transport'); });
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => { clearTimeout(timer); socket.removeListener('connect', connected); socket.removeListener('close', failed); if (error) reject(error); else resolve(); };
      const connected = (): void => finish(), failed = (): void => finish(new MediaClientError('unavailable'));
      const timer = setTimeout(() => { finish(new MediaClientError('timeout')); socket.destroy(); }, 10000);
      socket.once('connect', connected); socket.once('close', failed);
    });
    try {
      const after = await this.securePath();
      if (before.dev !== after.dev || before.ino !== after.ino || this.closed || this.socket !== socket) fail('unsafeSocket');
    } catch (error) { socket.destroy(); throw error; }
    return socket;
  }
  private receive(socket: Socket, data: Buffer): void {
    if (this.socket !== socket || this.closed) return;
    this.input = Buffer.concat([this.input, data]);
    let newline: number;
    while ((newline = this.input.indexOf(10)) !== -1) {
      if (newline > LIMIT) { this.disconnect('malformed'); return; }
      const line = this.input.subarray(0, newline); this.input = this.input.subarray(newline + 1);
      let row: JsonObject;
      try { row = asRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)) as unknown); if (!validJSON(row)) throw new Error(); }
      catch { this.disconnect('malformed'); return; }
      if (row.type === 'open') { this.openEvent(row); continue; }
      if (row.type === 'state') continue; // Presentation observes through explicit requests; no secret event payload is exposed.
      if (typeof row.id !== 'string' || !ID.test(row.id) || typeof row.ok !== 'boolean') { this.disconnect('malformed'); return; }
      const pending = this.pending.get(row.id); if (!pending) continue; // Late reply cannot settle a timed-out write.
      this.pending.delete(row.id); clearTimeout(pending.timer);
      if (!row.ok) {
        if (row.error === 'outcomeUnknown' || typeof row.error !== 'string') { this.markUnknown(pending); pending.reject(new MediaOutcomeUnknownError(pending.bindingId)); }
        else pending.reject(new MediaClientError('refused', pending.bindingId, row.error));
        continue;
      }
      try {
        const result = asRecord(row.result);
        if (['bind', 'navigate', 'observe'].includes(pending.op) && result.bindingId !== pending.bindingId || pending.op === 'forget' && result.forgotten !== true) throw new Error();
        if (pending.op === 'observe' && this.conclusive(pending.bindingId!, result)) this.unknown.delete(pending.bindingId!);
        if (pending.op === 'forget' && result.forgotten === true) {
          for (const id of pending.bindingIds!) { this.bindings.delete(id); this.unknown.delete(id); }
        }
        pending.resolve(result);
      } catch { this.markUnknown(pending); pending.reject(['bind', 'navigate', 'forget'].includes(pending.op) ? new MediaOutcomeUnknownError(pending.bindingId) : new MediaClientError('malformed')); }
    }
    if (this.input.length > LIMIT) this.disconnect('malformed');
  }
  private conclusive(id: string, row: JsonObject): boolean {
    if (row.bindingId !== id || row.pending !== false) return false;
    if (row.exists === false) return true;
    const binding = this.bindings.get(id);
    if (!binding || row.origin !== binding.origin || row.kind !== binding.kind || typeof row.ready !== 'boolean' || !(row.fault === null || typeof row.fault === 'string')) return false;
    try { if (row.url !== 'about:blank#readymade-' + id) destination(binding.origin, row.url, true); return true; } catch { return false; }
  }
  private openEvent(row: JsonObject): void {
    if (typeof row.bindingId !== 'string' || typeof row.url !== 'string') return;
    const binding = this.bindings.get(row.bindingId); if (!binding) return;
    try { destination(binding.origin, row.url); } catch { return; }
    const event: MediaOpenEvent = Object.freeze({ type: 'open', bindingId: row.bindingId, url: row.url });
    for (const listener of this.listeners) { try { listener(event); } catch { /* A UI callback cannot corrupt the channel. */ } }
  }
  private markUnknown(entry: Pending): void {
    if (['bind', 'navigate'].includes(entry.op) && entry.bindingId) this.unknown.add(entry.bindingId);
    if (entry.op === 'forget') for (const id of entry.bindingIds!) this.unknownForget.add(id);
  }
  private disconnect(code: string): void {
    const socket = this.socket; this.socket = undefined; this.input = Buffer.alloc(0); socket?.destroy();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer); this.markUnknown(entry);
      entry.reject(['bind', 'navigate', 'forget'].includes(entry.op) ? new MediaOutcomeUnknownError(entry.bindingId) : new MediaClientError(code));
    }
    this.pending.clear();
  }
}
