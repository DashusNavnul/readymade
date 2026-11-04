import * as http from 'node:http';
import * as https from 'node:https';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { asRecord, codingSnapshot, isInteger, isUv, isUx, validJSON, validUnicode, type CodingSnapshot, type JsonObject } from './protocol';

export class ShipClientError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(`Ship request failed: ${code}${status === undefined ? '' : ` (HTTP ${status})`}.`); this.name = 'ShipClientError';
  }
}
export class OutcomeUnknownError extends ShipClientError {
  constructor() { super('outcomeUnknown'); this.name = 'OutcomeUnknownError'; }
}
export interface RequestOptions {
  method?: 'GET' | 'POST'; body?: JsonObject; terminalNonce?: string; timeoutMs?: number; signal?: AbortSignal;
}
export interface WorkspaceRequestParameters {
  catalog: { offset?: number; catalog?: string };
  read: { requester: string; nonce: string };
  preview: { requester: string; nonce: string };
  submit: { requester: string; nonce: string; requestDigest: string; scope: string };
  recover: { requester: string; nonce: string };
}
export interface WorkspaceRequestReply { status: number; body: JsonObject }
export interface BrowserSessionCookie { readonly name: string; readonly value: string; readonly expires?: number }
type SavedCode = (origin: string) => Promise<string | undefined>;
type Wire = { status: number; headers: http.IncomingHttpHeaders; data: Buffer };
const LIMIT = 4 * 1024 * 1024, BASE = '/apps/pataphor-native/coding';
function failure(code: string, status?: number): never { throw new ShipClientError(code, status); }
function originOf(raw: string): string {
  let url: URL; try { url = new URL(raw); } catch { return failure('invalidOrigin'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!/^https?:\/\/[^/?#@]+\/?$/i.test(raw) || /[\s\\]/u.test(raw) || url.username || url.password || url.search || url.hash ||
      (url.pathname !== '/' && url.pathname !== '') || !(url.protocol === 'https:' || url.protocol === 'http:' && local) ||
      url.port === '0' || /[?#]/.test(raw)) return failure('invalidOrigin');
  return url.origin;
}
export async function readSavedCode(origin: string): Promise<string | undefined> {
  origin = originOf(origin);
  let file;
  try { file = await open(join(homedir(), '.cache', 'readymade', 'codes.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; return failure('credentialStorage'); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 1024 * 1024) failure('credentialStorage');
    const bytes = Buffer.alloc(1024 * 1024 + 1); let length = 0;
    while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length > 1024 * 1024) failure('credentialStorage'); const raw = bytes.subarray(0, length);
    const codes = asRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown);
    if (!Object.values(codes).every(value => typeof value === 'string')) failure('credentialStorage');
    return Object.hasOwn(codes, origin) && typeof codes[origin] === 'string' ? codes[origin] as string : undefined;
  } catch { return failure('credentialStorage'); } finally { await file.close(); }
}

/** Finite HTTP presentation adapter. Grants, models and canonical changes remain on the ship. */
export class ShipClient {
  readonly origin: string;
  private cookies: { value: string; expires: number }[] = [];
  private closed = false;
  private busy = false;
  private generation = 0;
  private observedGeneration = -1;
  private readonly blockedNonces = new Set<string>();
  private readonly uncertain = new Set<string>();
  private readonly workspaceSubmitted = new Set<string>();
  private readonly requests = new Set<http.ClientRequest>();
  private current?: CodingSnapshot;
  get snapshot(): CodingSnapshot | undefined { return this.current; }
  /** Trusted local UI bridge only: never put this session capability in documents or logs. */
  browserCookies(origin: string): readonly BrowserSessionCookie[] {
    if (origin !== this.origin) failure('contextChanged'); if (this.closed) failure('closed');
    const cookies = this.cookies.filter(cookie => cookie.expires > Date.now()).map(cookie => {
      const split = cookie.value.indexOf('=');
      return Object.freeze({ name: cookie.value.slice(0, split), value: cookie.value.slice(split + 1),
        ...(Number.isFinite(cookie.expires) ? { expires: cookie.expires / 1000 } : {}) });
    });
    if (!cookies.length) failure('authenticationRequired'); return Object.freeze(cookies);
  }
  constructor(origin: string, private readonly savedCode: SavedCode = readSavedCode) { this.origin = originOf(origin); }
  close(): void {
    this.closed = true; this.generation++; this.cookies = []; this.current = undefined;
    for (const request of this.requests) request.destroy(new ShipClientError('closed'));
    this.requests.clear();
  }
  async signIn(): Promise<void> {
    if (this.closed) failure('closed'); if (this.busy) failure('commandBusy');
    this.busy = true; const epoch = ++this.generation; this.cookies = []; this.current = undefined;
    try {
      let code: string | undefined;
      try { code = await this.savedCode(this.origin); } catch { return failure('credentialStorage'); }
      if (!code || !validUnicode(code) || Buffer.byteLength(code) > 4096) failure('noSavedCode');
      const body = Buffer.from(new URLSearchParams({ password: code }).toString());
      const reply = await this.wire('/~/login', 'POST', body, { 'Content-Type': 'application/x-www-form-urlencoded' }, {}, 65536);
      if (this.closed || epoch !== this.generation) failure('contextChanged');
      if (reply.status < 200 || reply.status >= 400) failure('authenticationRequired', reply.status);
      const location = reply.headers.location;
      if (location) { let destination: URL; try { destination = new URL(location, this.origin); } catch { return failure('redirectRefused'); }
        if (destination.origin !== this.origin || destination.username || destination.password) failure('redirectRefused');
      } else if (reply.status >= 300) failure('redirectRefused');
      const cookies = (reply.headers['set-cookie'] ?? []).flatMap(raw => {
        const parts = raw.split(';').map(part => part.trim()), pair = parts.shift()!;
        if (!/^urbauth-[A-Za-z0-9~-]+=[^\s;,]+$/.test(pair)) return [];
        const attrs = new Map(parts.map(part => { const split = part.indexOf('='); return split < 0 ? [part.toLowerCase(), ''] : [part.slice(0, split).toLowerCase(), part.slice(split + 1)]; }));
        const host = new URL(this.origin).hostname;
        if (attrs.get('path') !== '/' || attrs.has('domain') && attrs.get('domain')!.replace(/^\./, '').toLowerCase() !== host ||
            attrs.has('secure') && !this.origin.startsWith('https:')) return [];
        let expires = attrs.has('expires') ? Date.parse(attrs.get('expires')!) : Infinity;
        if (attrs.has('max-age')) { const seconds = Number(attrs.get('max-age')); if (!Number.isSafeInteger(seconds)) return []; expires = Date.now() + seconds * 1000; }
        return expires > Date.now() ? [{ value: pair, expires }] : [];
      });
      if (!cookies.length) failure('authenticationRequired'); this.cookies = cookies;
    } finally { this.busy = false; }
  }
  async codingState(session = '0x0', after = 0, cursor = '0x0'): Promise<CodingSnapshot> {
    if (!isUx(session) || !isUx(cursor) || !isInteger(after, 0, 4096)) failure('contextChanged');
    const epoch = ++this.generation;
    const next = this.decodeCoding(await this.requestJSON(`${BASE}/state?${session}&${after}&${cursor}`));
    if (epoch !== this.generation || next.session !== session) failure('contextChanged');
    this.current = next; this.observedGeneration = epoch;
    return next;
  }
  async codingTool(session: string, source: string, input: string): Promise<CodingSnapshot> {
    if (this.closed) failure('closed');
    const current = this.snapshot;
    if (this.busy || this.blockedNonces.size >= 16 || current && this.blockedNonces.has(current.nonce)) failure('commandBusy');
    if (!current?.ready) failure('notReady');
    if (this.observedGeneration !== this.generation) failure('contextChanged');
    const matches = current.sessions.filter(row => row.id === session);
    if (!isUx(session) || session === '0x0' || !isUx(source) || source === '0x0' || current.session !== session || matches.length !== 1 ||
        typeof matches[0]!.source !== 'object' || matches[0]!.source === null || Array.isArray(matches[0]!.source) ||
        asRecord(matches[0]!.source).id !== source) failure('contextChanged');
    if (!validUnicode(input)) failure('malformed'); if (Buffer.byteLength(input) > 65536) failure('tooLarge');
    this.busy = true; const epoch = this.generation;
    try {
      const body = { kind: 'terminal', session, source, input, nonce: current.nonce };
      const next = this.decodeCoding(await this.json(BASE + '/action', { method: 'POST', body }));
      if (this.closed || epoch !== this.generation || next.session !== session) failure('contextChanged');
      this.current = this.decodeCoding({ ...current, nonce: next.nonce, ...(next.delivery === undefined ? {} : { delivery: next.delivery }) }); return next;
    } catch (error) {
      if (this.knownRefusal(error)) throw error;
      this.blockedNonces.add(current.nonce); throw new OutcomeUnknownError();
    } finally { this.busy = false; }
  }
  workspaceState(): Promise<JsonObject> { return this.requestJSON('/apps/pataphor/remote/state.json'); }
  /** Bounded owner-authenticated workspace protocol. Recovery observes; it never resubmits. */
  async workspaceRequest<K extends keyof WorkspaceRequestParameters>(operation: K, parameters: WorkspaceRequestParameters[K]): Promise<WorkspaceRequestReply> {
    if (this.closed) failure('closed');
    const routes = { catalog: 'requests', read: 'request', preview: 'preview', submit: 'submit', recover: 'recover' };
    if (!Object.hasOwn(routes, operation)) failure('contextChanged');
    let params: JsonObject;
    try { params = asRecord(parameters); } catch { return failure('contextChanged'); }
    const digest = (value: unknown): value is string => typeof value === 'string' && value.length <= 81 &&
      /^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(value) && value.replace(/\./g, '').length <= 66;
    const fields = operation === 'catalog' ? ['offset', 'catalog'] : operation === 'submit' ? ['requester', 'nonce', 'requestDigest', 'scope'] : ['requester', 'nonce'];
    if (Object.keys(params).some(key => !fields.includes(key))) failure('contextChanged');
    const headers: http.OutgoingHttpHeaders = {};
    if (operation === 'catalog') {
      const offset = params.offset ?? 0;
      if (!isInteger(offset, 0, 511) ||
          params.catalog !== undefined && !digest(params.catalog) || offset > 0 && params.catalog === undefined) failure('contextChanged');
      headers['x-readymade-workspace-offset'] = String(offset);
      if (params.catalog !== undefined) headers['x-readymade-workspace-catalog'] = params.catalog as string;
    } else {
      if (typeof params.requester !== 'string' || params.requester.length > 128 ||
          !/^~(?:[a-z]{3}|[a-z]{6}(?:-[a-z]{6}){0,3}(?:--[a-z]{6}(?:-[a-z]{6}){3})?)$/.test(params.requester) ||
          typeof params.nonce !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(params.nonce) ||
          operation === 'submit' && (!digest(params.requestDigest) || !digest(params.scope))) failure('contextChanged');
      headers['x-readymade-workspace-requester'] = params.requester;
      headers['x-readymade-workspace-nonce'] = params.nonce;
    }
    const post = operation === 'submit' || operation === 'recover';
    const id = `workspace:${params.requester}:${params.nonce}`;
    if (post && (this.busy || operation === 'submit' && (this.workspaceSubmitted.size >= 512 || this.workspaceSubmitted.has(id)))) failure('commandBusy');
    if (post) this.busy = true;
    const epoch = this.generation;
    try {
      const body = post ? this.encode({ schema: 'readymade-workspace-command-v1', operation, ...params }) : undefined;
      if (post) { delete headers['x-readymade-workspace-requester']; delete headers['x-readymade-workspace-nonce'];
        headers['Content-Type'] = 'application/json'; headers['x-readymade-workspace'] = 'v1'; }
      const reply = await this.wire(`/apps/readymade-collab/workspace-${routes[operation]}`, post ? 'POST' : 'GET', body, headers, {}, 65536);
      if (this.closed || epoch !== this.generation) failure('contextChanged');
      if ([401, 403].includes(reply.status)) failure('authenticationRequired', reply.status);
      if (reply.status >= 300 && reply.status < 400) failure('redirectRefused');
      let value: JsonObject;
      try {
        if (reply.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') failure('malformed');
        value = asRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.data)) as unknown);
        if (!validJSON(value)) failure('malformed');
      } catch { return failure('malformed'); }
      if (![200, 202, 409].includes(reply.status)) {
        if ([400, 503].includes(reply.status) && typeof value.error === 'string' && value.error) failure('refused', reply.status);
        failure('unavailable', reply.status);
      }
      if (operation === 'submit') this.workspaceSubmitted.add(id);
      return { status: reply.status, body: value };
    } catch (error) {
      if (operation !== 'submit' || this.knownRefusal(error)) throw error;
      this.workspaceSubmitted.add(id); throw new OutcomeUnknownError();
    } finally { if (post) this.busy = false; }
  }
  async requestJSON(path: string, options: RequestOptions = {}): Promise<JsonObject> {
    if (this.closed) failure('closed');
    const url = this.path(path), method = options.method ?? 'GET';
    if (!['GET', 'POST'].includes(method) || (method === 'POST') !== (options.body !== undefined) || url.pathname === BASE + '/action') failure('contextChanged');
    if (options.terminalNonce !== undefined && (method !== 'POST' || !isUv(options.terminalNonce) || options.terminalNonce === '0v0' ||
        !/^\/apps\/pataphor-terminal(?:-[bcd])?\/action$/.test(url.pathname) &&
        !['/apps/pataphor-terminal/sharing', '/apps/pataphor-terminal/shared/open'].includes(url.pathname))) failure('contextChanged');
    if (!isInteger(options.timeoutMs ?? 20000, 1, 60000)) failure('contextChanged');
    if (method === 'GET') return this.json(path, options);
    const data = this.encode(options.body!), fields = url.pathname.endsWith('/sharing') ? ['action', 'ship', 'revision', 'generation', 'controlRevision'] : ['kind', 'generation', 'sequence', 'controlRevision'];
    const packet = options.terminalNonce && !url.pathname.endsWith('/shared/open') ? [options.terminalNonce, ...fields.map(field => options.body![field] ?? '')].join(':') : undefined;
    const identity = options.body!.id ?? options.body!.nonce ?? packet ?? createHash('sha256').update(data).digest('hex'), id = `${url.pathname}:${identity}`;
    if (this.busy || this.uncertain.size >= 16 || this.uncertain.has(id)) failure('commandBusy');
    this.busy = true;
    try { return await this.json(path, options); }
    catch (error) {
      if (this.knownRefusal(error) ||
          options.terminalNonce && url.pathname.endsWith('/action') && options.body!.kind === 6) throw error;
      this.uncertain.add(id); throw new OutcomeUnknownError();
    } finally { this.busy = false; }
  }
  private knownRefusal(error: unknown): boolean { return error instanceof ShipClientError && ['refused', 'authenticationRequired', 'cancelledBeforeSend'].includes(error.code); }
  private decodeCoding(value: JsonObject): CodingSnapshot {
    try {
      const next = codingSnapshot(value);
      const freeze = (item: unknown): void => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } };
      freeze(next); return next;
    } catch { return failure('malformed'); }
  }
  private path(path: string): URL {
    if (!/^\/(?:apps|~\/scry)\//.test(path) || /[\\#\s\u0000-\u001f\u007f]/u.test(path)) failure('contextChanged');
    const raw = path.split('?')[0]!; if (raw.includes('//')) failure('contextChanged');
    for (const part of raw.split('/').slice(1)) {
      let decoded: string; try { decoded = decodeURIComponent(part); } catch { return failure('contextChanged'); }
      if (decoded !== part || decoded === '.' || decoded === '..' || /[\\/#?\u0000-\u001f\u007f]/u.test(decoded)) failure('contextChanged');
    }
    const url = new URL(path, this.origin); if (url.origin !== this.origin || url.pathname !== raw) failure('contextChanged'); return url;
  }
  private encode(body: JsonObject): Buffer {
    try { asRecord(body); if (!validJSON(body)) failure('malformed'); const data = Buffer.from(JSON.stringify(body, (_key, value: unknown) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
      return value;
    })); if (data.length > 131072) failure('tooLarge'); return data; }
    catch (error) { if (error instanceof ShipClientError) throw error; return failure('malformed'); }
  }
  private async json(path: string, options: RequestOptions): Promise<JsonObject> {
    const body = options.body === undefined ? undefined : this.encode(options.body);
    const reply = await this.wire(path, options.method ?? 'GET', body, {
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(options.terminalNonce ? { 'x-terminal-nonce': options.terminalNonce } : {})
    }, options, LIMIT);
    if (reply.status >= 300 && reply.status < 400) {
      const location = reply.headers.location;
      if (location) { try { const url = new URL(location, this.origin); if (url.origin === this.origin && url.pathname === '/~/login') failure('authenticationRequired'); }
        catch (error) { if (error instanceof ShipClientError) throw error; } }
      failure('redirectRefused');
    }
    if ([401, 403].includes(reply.status)) failure('authenticationRequired', reply.status);
    let value: JsonObject;
    try {
      if (reply.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') failure('malformed');
      value = asRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.data)) as unknown);
      if (!validJSON(value)) failure('malformed');
    } catch { return failure('malformed'); }
    if (typeof value.error === 'string' && value.error && ([400, 409, 503].includes(reply.status) || path.startsWith(BASE) && reply.status >= 400 && reply.status < 500)) failure('refused', reply.status);
    if (reply.status < 200 || reply.status >= 300) failure('unavailable', reply.status); return value;
  }
  private wire(path: string, method: string, body: Buffer | undefined, headers: http.OutgoingHttpHeaders, options: RequestOptions, limit: number): Promise<Wire> {
    if (this.closed) return Promise.reject(new ShipClientError('closed'));
    if (options.signal?.aborted) return Promise.reject(new ShipClientError('cancelledBeforeSend'));
    const timeout = options.timeoutMs ?? 20000;
    if (!isInteger(timeout, 1, 60000)) return Promise.reject(new ShipClientError('contextChanged'));
    return new Promise<Wire>((resolve, reject) => {
      let settled = false;
      const finish = (error?: ShipClientError, value?: Wire): void => {
        if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
        this.requests.delete(request); if (error) reject(error); else resolve(value!);
      };
      const abort = (): void => { request.destroy(new ShipClientError('transport')); };
      const request = (this.origin.startsWith('https:') ? https : http).request(new URL(path, this.origin), {
        method, agent: false, headers: { Accept: 'application/json', Origin: this.origin,
          ...(this.cookies.filter(cookie => cookie.expires > Date.now()).length ? { Cookie: this.cookies.filter(cookie => cookie.expires > Date.now()).map(cookie => cookie.value).join('; ') } : {}),
          ...headers, ...(body ? { 'Content-Length': body.length } : {}) }
      }, response => {
        const size = Number(response.headers['content-length'] ?? 0);
        if (!Number.isFinite(size) || size > limit) { finish(new ShipClientError('tooLarge')); response.destroy(); return; }
        const chunks: Buffer[] = []; let total = 0;
        response.on('data', (chunk: Buffer) => { total += chunk.length; if (total > limit) { finish(new ShipClientError('tooLarge')); response.destroy(); } else chunks.push(chunk); });
        response.on('end', () => finish(undefined, { status: response.statusCode ?? 0, headers: response.headers, data: Buffer.concat(chunks) }));
        response.on('error', () => finish(new ShipClientError('transport')));
        response.on('aborted', () => finish(new ShipClientError('transport')));
      });
      const timer = setTimeout(() => {
        if (method === 'GET' && timeout === 45000) { finish(new ShipClientError('pollExpired')); request.destroy(); }
        else abort();
      }, timeout); this.requests.add(request);
      request.on('error', () => finish(new ShipClientError('transport')));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort(); else request.end(body);
    }).catch((error: unknown) => { if (error instanceof ShipClientError) throw error; return failure('transport'); });
  }
}
