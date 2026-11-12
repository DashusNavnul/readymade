import * as http from 'node:http';
import * as https from 'node:https';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { completionId, type CompletionContext } from './completion-store';
import { reviewPolicyCommand, type ReviewPolicyChange } from './review-policy';
import {invitationCommand, invitationResult, invitationCatalog, invitationMembers, invitationUuid, invitationHash, invitationProject, type InvitationCommand} from './project-invitations';
import {projectInbox as decodeProjectInbox} from './project-inbox';
import {remoteShip, remoteProjectViewTarget, remoteProjectViewSelector, remoteProjectViewHeaders, remoteProjectViewJSON,
  remoteProjectViewRefused, remoteProjectViewReply, REMOTE_PROJECT_VIEW_LIMIT,
  type RemoteProjectViewTarget, type RemoteProjectViewSelector, type RemoteProjectViewReply} from './remote-project-view';
import {remoteProjectSessionsTarget, remoteProjectSessionsSelector, remoteProjectSessionsHeaders, remoteProjectSessionsRefused, remoteProjectSessionsReply,
  type RemoteProjectSessionsReply} from './remote-project-sessions';
import {sessionSharingTarget, sessionSharingCommand, sessionSharingHeaders, sessionSharingRefusal, sessionSharingSnapshot, sessionSharingReceipt,
  type SessionSharingCommand, type SessionSharingSnapshot, type SessionSharingReceipt} from './session-sharing';
import {remoteSuggestionIntent, remoteSuggestionBody, remoteSuggestionHeaders, remoteSuggestionReply, remoteSuggestionRefused, remoteSuggestionRecoveryBody, remoteSuggestionRecoveryReply,
  type RemoteSuggestionIntent, type RemoteSuggestionReply, type RemoteSuggestionRecoveryReply} from './remote-project-suggest';
import {FULL_SOURCE, GUEST_DESK_PATH, GUEST_DESK_PUBLISH, GUEST_PIKES_PATH, GUEST_PROBE_PATH, GUEST_SOURCE, fullDesk, fullFollowActions, guestDeskReceipt, guestDeskStatus, guestInstallActions, guestRemoveActions,
  guestServiceDesk, guestServiceProbe, guestServiceState, type GuestDeskStatus, type GuestServiceState, type GuestSource} from './guest-service';
import { activityBody, activityCommand, activityHeaders, activityReply, activitySelector, type ActivityCommand, type ActivityReply, type ActivitySelector } from './editing-activity';
import { asRecord, codingSnapshot, isInteger, isUv, isUx, validJSON, validUnicode, type CodingSnapshot, type JsonObject } from './protocol';

/** Why a request never got an answer, when the network layer said: the ship answered too slowly, nothing listens there, the name does not resolve, or the connection dropped. */
export type TransportDetail = 'slow' | 'down' | 'unknownHost' | 'dropped';
export class ShipClientError extends Error {
  constructor(readonly code: string, readonly status?: number, readonly detail?: TransportDetail) {
    const certificateMessage = code === 'certificateHostname'
      ? 'The HTTPS certificate does not match this ship address. Check the configured origin or ask the host to correct its certificate.'
      : code === 'certificateUntrusted'
        ? 'The HTTPS certificate cannot be verified. Ask the host to provide a certificate trusted by this computer and its complete certificate chain.'
        : undefined;
    const plain = code === 'commandBusy' ? 'Readymade is still finishing another request to your ship. Try again in a moment; nothing was sent.'
      : code === 'outcomeUnknown' ? 'No answer came back from your ship, so the outcome is not known. Nothing was sent again. Check the result before trying again.' : undefined;
    super(certificateMessage ?? plain ?? `Ship request failed: ${code}${status === undefined ? '' : ` (HTTP ${status})`}.`); this.name = 'ShipClientError';
  }
}
export class OutcomeUnknownError extends ShipClientError {
  constructor() { super('outcomeUnknown'); this.name = 'OutcomeUnknownError'; }
}
/** The owner's ship answered and changed nothing. `reason` is one of its fixed refusal names. */
export class SessionSharingRefusedError extends ShipClientError {
  constructor(status: number, readonly reason: string) { super('refused', status); this.name = 'SessionSharingRefusedError'; }
}
export interface RequestOptions {
  method?: 'GET' | 'POST'; body?: JsonObject; terminalNonce?: string; timeoutMs?: number; signal?: AbortSignal;
}
export interface WorkspaceRequestParameters {
  catalog: { offset?: number; catalog?: string };
  read: { requester: string; nonce: string };
  preview: { requester: string; nonce: string };
  completion: { requester: string; nonce: string };
  submit: { requester: string; nonce: string; requestDigest: string; scope: string };
  recover: { requester: string; nonce: string };
}
export interface WorkspaceRequestReply { status: number; body: JsonObject }
export type ProjectSharingCommand = {
  request: string; owner: string; project: string; peer: string; expected: string;
} & ({ operation: 'grant'; desk: string; paths: string; permission: 'view' | 'suggest' | 'view-suggest' } |
     { operation: 'revoke'; generation: string });
export interface ProjectSharingParameters {
  read: { project: string; peer: string };
  result: { request: string };
  submit: ProjectSharingCommand;
}
export interface ProjectInvitationParameters {
  submit: InvitationCommand; result: {request: string}; requests: {offset?: number; catalog?: string};
  members: {project: string; kind: 'members' | 'invitations' | 'events'; offset?: number; catalog?: string};
}
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
  private readonly completionSubmitted = new Set<string>();
  private readonly activityWrites = new Map<string, {command: ActivityCommand; request?: string}>();
  private readonly projectViews = new Map<string, {request?: string}>();
  private readonly projectSessionLists = new Map<string, {request?: string}>();
  private readonly projectSuggestions = new Set<string>();
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
  /** Records an owner judgment of the answer, never a source-change acceptance.
   * Caller must durably retain the exact intent before invoking this method. */
  async acceptCompletion(context: CompletionContext, proposal: string, reason: string, consent: boolean): Promise<CodingSnapshot> {
    if (this.closed) failure('closed');
    const current = this.snapshot, identity = `completion:${context.owner}:${context.session}:${proposal}`;
    if (this.busy || this.completionSubmitted.has(identity) || this.completionSubmitted.size >= 4096) failure('commandBusy');
    if (!current?.ready) failure('notReady');
    if (this.observedGeneration !== this.generation || current.owner !== context.owner || current.session !== context.session ||
        current.sessions.filter(s => s.id === context.session && s.project === context.project).length !== 1 ||
        !completionId(context.session) || !completionId(proposal) || consent !== true ||
        typeof reason !== 'string' || !reason.length || !validUnicode(reason) || Buffer.byteLength(reason) > 8192) failure('contextChanged');
    this.busy = true; const epoch = this.generation;
    try {
      const next = this.decodeCoding(await this.json(BASE + '/action', {method: 'POST', body: {
        kind: 'completion-accept', session: context.session, proposal, consent: true, reason, nonce: current.nonce
      }}));
      if (this.closed || epoch !== this.generation || next.session !== context.session || next.owner !== context.owner) failure('contextChanged');
      this.completionSubmitted.add(identity); // Even a delivered action needs its canonical judgment receipt.
      this.current = this.decodeCoding({...current, nonce: next.nonce});
      return next;
    } catch (error) {
      if (this.knownRefusal(error)) throw error;
      this.completionSubmitted.add(identity); throw new OutcomeUnknownError();
    } finally { this.busy = false; }
  }
  /** Starts native challenge/resolution; caller must persist its intent first. */
  async startCandidateReview(context: CompletionContext, candidate: string, consent: boolean, scopeBinding: string): Promise<CodingSnapshot> {
    const current = this.snapshot, identity = `candidate-review:${context.owner}:${context.session}:${candidate}`;
    if (this.closed) failure('closed');
    if (this.busy || this.completionSubmitted.has(identity) || this.completionSubmitted.size >= 4096) failure('commandBusy');
    if (!current?.ready) failure('notReady');
    if (this.observedGeneration !== this.generation || current.owner !== context.owner || current.session !== context.session ||
        current.sessions.filter(s => s.id === context.session && s.project === context.project).length !== 1 ||
        !completionId(context.session) || !completionId(candidate) || !completionId(scopeBinding) || consent !== true) failure('contextChanged');
    this.busy = true; const epoch = this.generation;
    try {
      const next = this.decodeCoding(await this.json(BASE + '/action', {method: 'POST', body: {
        kind: 'solo-review-start', session: context.session, candidate, scopeBinding, nonce: current.nonce
      }}));
      if (this.closed || epoch !== this.generation || next.owner !== context.owner || next.session !== context.session) failure('contextChanged');
      this.completionSubmitted.add(identity);
      this.current = this.decodeCoding({...current, nonce: next.nonce}); return next;
    } catch (error) {
      if (this.knownRefusal(error)) throw error;
      this.completionSubmitted.add(identity); throw new OutcomeUnknownError();
    } finally {this.busy = false;}
  }
  /** Applies a canonical native approval. Persist the exact intent before calling. */
  async applyReviewedCandidate(context: CompletionContext, candidate: string, basis: string, consent: boolean): Promise<CodingSnapshot> {
    const current = this.snapshot, identity = `candidate-apply:${context.owner}:${context.session}:${candidate}`;
    if (this.closed) failure('closed');
    if (this.busy || this.completionSubmitted.has(identity) || this.completionSubmitted.size >= 4096) failure('commandBusy');
    if (!current?.ready) failure('notReady');
    if (current.candidateDecide !== true) failure('candidateApplyUnavailable');
    const sessions = current.sessions.filter(s => s.id === context.session && s.project === context.project);
    if (this.observedGeneration !== this.generation || current.owner !== context.owner || current.session !== context.session ||
        sessions.length !== 1 || asRecord(sessions[0].source).id !== basis ||
        !completionId(context.session) || !completionId(candidate) || !completionId(basis) || consent !== true) failure('contextChanged');
    this.busy = true; const epoch = this.generation;
    try {
      const next = this.decodeCoding(await this.json(BASE + '/action', {method: 'POST', body: {
        kind: 'candidate-decide', owner: context.owner, project: context.project, session: context.session,
        candidate, basis, consent: true, nonce: current.nonce
      }}));
      if (this.closed || epoch !== this.generation || next.owner !== context.owner || next.session !== context.session) failure('contextChanged');
      this.completionSubmitted.add(identity);
      this.current = this.decodeCoding({...current, nonce: next.nonce}); return next;
    } catch (error) {
      if (this.knownRefusal(error)) throw error;
      this.completionSubmitted.add(identity); throw new OutcomeUnknownError();
    } finally {this.busy = false;}
  }
  /** Caller must durably retain the confirmed policy intent before dispatch. */
  async configureReviewPolicy(context: CompletionContext, change: ReviewPolicyChange, consent: boolean): Promise<CodingSnapshot> {
    const current = this.snapshot, identity = `review-policy:${context.owner}:${context.project}:${change.previous}`;
    if (this.closed) failure('closed');
    if (this.busy || this.completionSubmitted.has(identity) || this.completionSubmitted.size >= 4096) failure('commandBusy');
    if (!current?.ready) failure('notReady');
    if (this.observedGeneration !== this.generation || current.owner !== context.owner) failure('contextChanged');
    const command = reviewPolicyCommand(current, context.session, context.project, change, consent);
    this.busy = true; const epoch = this.generation;
    try {
      const next = this.decodeCoding(await this.json(BASE + '/action', {method: 'POST', body: {...command, nonce: current.nonce}}));
      if (this.closed || epoch !== this.generation || next.owner !== context.owner || next.session !== context.session) failure('contextChanged');
      this.completionSubmitted.add(identity);
      this.current = this.decodeCoding({...current, nonce: next.nonce}); return next;
    } catch (error) {
      if (this.knownRefusal(error)) throw error;
      this.completionSubmitted.add(identity); throw new OutcomeUnknownError();
    } finally {this.busy = false;}
  }
  workspaceState(): Promise<JsonObject> { return this.requestJSON('/apps/pataphor/remote/state.json'); }
  /** Bounded owner-authenticated workspace protocol. Recovery observes; it never resubmits. */
  async workspaceRequest<K extends keyof WorkspaceRequestParameters>(operation: K, parameters: WorkspaceRequestParameters[K]): Promise<WorkspaceRequestReply> {
    if (this.closed) failure('closed');
    const routes = { catalog: 'requests', read: 'request', preview: 'preview', submit: 'submit', recover: 'recover', completion: 'completion' };
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
  /** Fixed native import routes only; confirmation reserves a request and never executes it. */
  async workspaceImport(route: string, selected: Record<string, string> = {}, input?: JsonObject): Promise<JsonObject> {
    if (this.closed) failure('closed');
    const owner = this.projectViewPeer(), post = route === 'import-preview' || route === 'import-confirm';
    const fields: Record<string, string[]> = {'import-options': ['x-readymade-import-session'], 'import-messages': ['x-readymade-import-note', 'x-readymade-import-offset', 'x-readymade-import-catalog'], request: ['x-readymade-workspace-requester', 'x-readymade-workspace-nonce'], 'import-preview': [], 'import-confirm': []};
    if (!Object.hasOwn(fields, route) || Object.keys(selected).some(k => !fields[route].includes(k)) || post !== (input !== undefined)) failure('contextChanged');
    const ux = (v: unknown): v is string => isUx(v) && /^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(v) && BigInt(v.replaceAll('.', '')) < 1n << 256n;
    const uv = (v: unknown): v is string => isUv(v) && /^0v(?:0|[1-9a-v][0-9a-v]{0,4}(?:\.[0-9a-v]{5})*)$/.test(v) && v.length <= 64 && [...v.slice(2).replaceAll('.', '')].reduce((n,c) => n * 32n + BigInt(parseInt(c,32)),0n) < 1n << 256n;
    const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
    if (route === 'import-options' && !ux(selected['x-readymade-import-session']) || route === 'request' && (selected['x-readymade-workspace-requester'] !== owner || !uuid(selected['x-readymade-workspace-nonce']))) failure('contextChanged');
    if (route === 'import-messages') {
      const note = selected['x-readymade-import-note'], offset = selected['x-readymade-import-offset'], catalog = selected['x-readymade-import-catalog'];
      if (!note || note.length > 128 || /[\r\n\0]/.test(note) || !/^(?:0|[1-9][0-9]{0,3})$/.test(offset) || Number(offset) > 4095 || (catalog === undefined ? offset !== '0' : !ux(catalog))) failure('contextChanged');
    }
    let body: Buffer | undefined;
    if (input) {
      const keys = ['schema','operation','nonce','session','note','eid','grant', ...(route === 'import-confirm' ? ['previewDigest'] : [])];
      if (Object.keys(input).length !== keys.length || !keys.every(k => Object.hasOwn(input!, k)) || input.schema !== 'readymade-workspace-import-v1' || input.operation !== route.slice(7) || !uuid(input.nonce) || !ux(input.session) || !ux(input.grant) || !uv(input.eid) || typeof input.note !== 'string' || !input.note || Buffer.byteLength(input.note) > 128 || /[\r\n\0]/.test(input.note) || route === 'import-confirm' && !ux(input.previewDigest)) failure('contextChanged');
      body = this.encode(input); if (body.length > 4096) failure('tooLarge');
    }
    const key = 'workspace-import:' + input?.nonce;
    if (post && (this.busy || this.workspaceSubmitted.size >= 512 || route === 'import-confirm' && this.workspaceSubmitted.has(key))) failure('commandBusy');
    const epoch = this.generation; if (post) this.busy = true;
    // A lost or refused confirmation is observed by request ID, never sent again.
    if (route === 'import-confirm') this.workspaceSubmitted.add(key);
    try {
      const reply = await this.wire('/apps/readymade-collab/workspace-' + route, post ? 'POST' : 'GET', body, {...selected, ...(post ? {'Content-Type':'application/json','x-readymade-workspace-import':'v1'} : {})}, {timeoutMs:15000}, 65536);
      if (this.closed || epoch !== this.generation || this.projectViewPeer() !== owner) failure('contextChanged');
      if ([401,403].includes(reply.status)) failure('authenticationRequired', reply.status);
      const value = this.projectViewJSON(reply);
      if (![200,202].includes(reply.status)) {
        const error = new ShipClientError([400,409].includes(reply.status) ? 'refused' : 'unavailable', reply.status);
        if (typeof value.error === 'string') error.message += ' ' + value.error.slice(0,1024);
        throw error;
      }
      return value;
    } finally {if (post) this.busy = false;}
  }
  /** Exact retained request result; never executes, publishes, or retries a write. */
  async workspaceResult(requester: string, nonce: string): Promise<JsonObject> {
    if (this.closed) failure('closed');
    const owner = this.projectViewPeer(), epoch = this.generation;
    if (requester !== owner || typeof nonce !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nonce)) failure('contextChanged');
    const reply = await this.wire('/apps/readymade-collab/workspace-result', 'GET', undefined,
      {'x-readymade-workspace-requester': requester, 'x-readymade-workspace-nonce': nonce}, {timeoutMs: 15000}, 524288);
    if (this.closed || epoch !== this.generation || this.projectViewPeer() !== owner) failure('contextChanged');
    if ([401,403].includes(reply.status)) failure('authenticationRequired', reply.status);
    const value = this.projectViewJSON(reply);
    if (reply.status !== 200) throw new ShipClientError('unavailable', reply.status);
    return value;
  }
  /** Publish only a native-previewed completion summary; result reads never replay it. */
  async workspaceReturn(operation: 'preview'|'confirm'|'result', params: JsonObject, version: 1|2 = 2): Promise<JsonObject> {
    if (this.closed) failure('closed'); if(version!==1&&version!==2)failure('contextChanged'); const owner=this.projectViewPeer(), post=operation!=='result';
    const keys=['requester','nonce',...(post?['summary']:[]),...(operation==='confirm'?['previewDigest']:[])];
    if (!['preview','confirm','result'].includes(operation)||Object.keys(params).length!==keys.length||!keys.every(k=>Object.hasOwn(params,k))||!remoteShip(params.requester)||typeof params.nonce!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(params.nonce)) failure('contextChanged');
    if (post&&(typeof params.summary!=='string'||!params.summary||!validUnicode(params.summary)||params.summary.includes('\0')||Buffer.byteLength(params.summary)>8192)) failure('contextChanged');
    if (operation==='confirm'&&(typeof params.previewDigest!=='string'||!/^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(params.previewDigest)||params.previewDigest.length>81)) failure('contextChanged');
    const key=`workspace-return:${params.requester}:${params.nonce}`, epoch=this.generation;
    if (post&&(this.busy||this.workspaceSubmitted.size>=512||operation==='confirm'&&this.workspaceSubmitted.has(key))) failure('commandBusy');
    const body=post?this.encode({schema:`readymade-workspace-return-v${version}`,operation,...params}):undefined;
    if(post)this.busy=true;if(operation==='confirm')this.workspaceSubmitted.add(key);
    try{
      const headers=post?{'Content-Type':'application/json','x-readymade-workspace-return':`v${version}`}:{'x-readymade-workspace-requester':params.requester as string,'x-readymade-workspace-nonce':params.nonce};
      const reply=await this.wire(`/apps/readymade-collab/workspace-return-${version===2?'rich-':''}${operation}`,post?'POST':'GET',body,headers,{timeoutMs:15000},version===2?524288:131072);
      if(this.closed||epoch!==this.generation||this.projectViewPeer()!==owner)failure('contextChanged');
      if([401,403].includes(reply.status))failure('authenticationRequired',reply.status);const value=this.projectViewJSON(reply);
      if(reply.status!==200){const error=new ShipClientError([400,409].includes(reply.status)?'refused':'unavailable',reply.status);if(typeof value.error==='string')error.message+=' '+value.error.slice(0,1024);throw error;}return value;
    }finally{if(post)this.busy=false;}
  }
  /** One explicit activity operation. An unknown write blocks that target until this client closes. */
  async activitySubmit(value: ActivityCommand): Promise<ActivityReply> {
    if (this.closed) failure('closed');
    const command = activityCommand(value), body = this.encode(activityBody(command));
    const key = JSON.stringify([command.owner, command.project]), write = command.operation !== 'query';
    this.browserCookies(this.origin);
    if (this.busy || write && (this.activityWrites.has(key) || this.activityWrites.size >= 32)) failure('commandBusy');
    if (body.length > 8192) failure('tooLarge');
    this.busy = true; const epoch = this.generation;
    if (write) this.activityWrites.set(key, {command});
    try {
      const reply = await this.wire('/apps/readymade-editing/action', 'POST', body,
        {'Content-Type': 'application/json', 'x-readymade-editing-activity': 'v1'}, {timeoutMs: 15000}, 65536);
      if (this.closed || epoch !== this.generation) throw new OutcomeUnknownError();
      const json = this.activityJSON(reply);
      const refused = Object.keys(json).length === 3 && json.status === 'unavailable' && json.permissionGranted === false &&
        (reply.status === 403 && json.reason === 'owner-login-required' || reply.status === 400 && json.reason === 'same-origin-command-required' ||
         reply.status === 409 && ['activity-request-capacity', 'activity-request-invalid', 'activity-request-reused'].includes(String(json.reason)));
      if (refused) {
        if (write) this.activityWrites.delete(key);
        failure('refused', reply.status);
      }
      const result = activityReply(reply.status, json, {owner: command.owner, project: command.project}, command);
      if (write) this.activityWrites.set(key, {command, request: result.request});
      return result;
    } catch (error) {
      if (error instanceof ShipClientError && error.code === 'refused') throw error;
      throw new OutcomeUnknownError();
    } finally { this.busy = false; }
  }
  /** Exact-ID observation never submits, renews or infers a missing operation's outcome. */
  async activityResult(value: ActivitySelector, command?: ActivityCommand): Promise<ActivityReply> {
    if (this.closed) failure('closed');
    const selected = activitySelector(value), key = JSON.stringify([selected.owner, selected.project]);
    const held = this.activityWrites.get(key), matching = held?.request === selected.request;
    const supplied = command && activityCommand(command);
    if (supplied && (supplied.owner !== selected.owner || supplied.project !== selected.project ||
        matching && JSON.stringify(supplied) !== JSON.stringify(held.command))) failure('contextChanged');
    this.browserCookies(this.origin); const epoch = this.generation;
    const reply = await this.wire('/apps/readymade-editing/result', 'GET', undefined, activityHeaders(selected), {timeoutMs: 15000}, 65536);
    if (this.closed || epoch !== this.generation) failure('contextChanged');
    const result = activityReply(reply.status, this.activityJSON(reply), selected, matching ? held.command : supplied);
    if (matching && this.activityWrites.get(key) === held && (result.status === 'ready' || result.status === 'refused')) this.activityWrites.delete(key);
    return result;
  }
  /** A fresh remote read, submitted once. No local Viki session is required. */
  async projectViewSubmit(value: RemoteProjectViewTarget): Promise<RemoteProjectViewReply> {
    if (this.closed) failure('closed');
    const target = remoteProjectViewTarget(value), peer = this.projectViewPeer();
    if (target.owner === peer) failure('contextChanged');
    const key = JSON.stringify([peer, target.owner, target.project, target.generation]);
    if (this.busy || this.projectViews.has(key) || this.projectViews.size >= 32) failure('commandBusy');
    const body = this.encode({schema: 'readymade-project-view-v1', ...target});
    if (body.length > 4096) failure('tooLarge');
    this.busy = true; const epoch = this.generation; this.projectViews.set(key, {});
    try {
      const reply = await this.wire('/apps/readymade-collab/project-view', 'POST', body,
        {'Content-Type': 'application/json', 'x-readymade-project-view': 'v1'}, {timeoutMs: 15000}, REMOTE_PROJECT_VIEW_LIMIT);
      if (this.closed || epoch !== this.generation || this.projectViewPeer() !== peer) throw new OutcomeUnknownError();
      const json = this.projectViewJSON(reply);
      if (remoteProjectViewRefused(reply.status, json)) {this.projectViews.delete(key); failure('refused', reply.status);}
      const result = remoteProjectViewReply(reply.status, json, target, peer, this.origin);
      this.projectViews.set(key, {request: result.request}); return result;
    } catch (error) {
      if (error instanceof ShipClientError && error.code === 'refused') throw error;
      throw new OutcomeUnknownError();
    } finally {this.busy = false;}
  }
  /** Observes one exact selector. Correlated expiry permits a new explicit read, never a replay. */
  async projectViewResult(value: RemoteProjectViewSelector): Promise<RemoteProjectViewReply> {
    if (this.closed) failure('closed');
    const selected = remoteProjectViewSelector(value), peer = this.projectViewPeer(), epoch = this.generation;
    if (selected.owner === peer) failure('contextChanged');
    const key = JSON.stringify([peer, selected.owner, selected.project, selected.generation]), held = this.projectViews.get(key);
    const reply = await this.wire('/apps/readymade-collab/project-view-result', 'GET', undefined,
      remoteProjectViewHeaders(selected), {timeoutMs: 15000}, REMOTE_PROJECT_VIEW_LIMIT);
    if (this.closed || epoch !== this.generation || this.projectViewPeer() !== peer) failure('contextChanged');
    const result = remoteProjectViewReply(reply.status, this.projectViewJSON(reply), selected, peer, this.origin);
    if (held?.request === selected.request && this.projectViews.get(key) === held && ['ready', 'refused', 'missing', 'expired'].includes(result.status)) this.projectViews.delete(key);
    return result;
  }
  /** Asks one owner, once, which sessions it shares with this ship. An unknown submission is never resent. */
  async projectSessionsSubmit(owner: string, project: string): Promise<RemoteProjectSessionsReply> {
    if (this.closed) failure('closed');
    const target = remoteProjectSessionsTarget({owner, project}), peer = this.projectViewPeer();
    if (target.owner === peer) failure('contextChanged');
    const key = JSON.stringify([peer, target.owner, target.project]);
    if (this.busy || this.projectSessionLists.has(key) || this.projectSessionLists.size >= 32) failure('commandBusy');
    const body = this.encode({schema: 'readymade-project-sessions-v1', ...target});
    if (body.length > 4096) failure('tooLarge');
    this.busy = true; const epoch = this.generation; this.projectSessionLists.set(key, {});
    try {
      const reply = await this.wire('/apps/readymade-collab/project-sessions', 'POST', body,
        {'Content-Type': 'application/json', 'x-readymade-project-sessions': 'v1'}, {timeoutMs: 15000}, REMOTE_PROJECT_VIEW_LIMIT);
      if (this.closed || epoch !== this.generation || this.projectViewPeer() !== peer) throw new OutcomeUnknownError();
      const json = this.projectViewJSON(reply);
      if (remoteProjectSessionsRefused(reply.status, json)) {this.projectSessionLists.delete(key); failure('refused', reply.status);}
      const result = remoteProjectSessionsReply(reply.status, json, target, peer);
      this.projectSessionLists.set(key, {request: result.request}); return result;
    } catch (error) {
      if (error instanceof ShipClientError && error.code === 'refused') throw error;
      throw new OutcomeUnknownError();
    } finally {this.busy = false;}
  }
  /** Reads one exact request. Any settled answer, including no answer, permits a new explicit request, never a replay. */
  async projectSessionsResult(owner: string, project: string, request: string): Promise<RemoteProjectSessionsReply> {
    if (this.closed) failure('closed');
    const selected = remoteProjectSessionsSelector({owner, project, request}), peer = this.projectViewPeer(), epoch = this.generation;
    if (selected.owner === peer) failure('contextChanged');
    const key = JSON.stringify([peer, selected.owner, selected.project]), held = this.projectSessionLists.get(key);
    const reply = await this.wire('/apps/readymade-collab/project-sessions-result', 'GET', undefined,
      remoteProjectSessionsHeaders(selected), {timeoutMs: 15000}, REMOTE_PROJECT_VIEW_LIMIT);
    if (this.closed || epoch !== this.generation || this.projectViewPeer() !== peer) failure('contextChanged');
    const result = remoteProjectSessionsReply(reply.status, this.projectViewJSON(reply), selected, peer);
    if (held?.request === selected.request && this.projectSessionLists.get(key) === held && result.status !== 'pending') this.projectSessionLists.delete(key);
    return result;
  }
  /** One collaborator's standing in one of this ship's own projects. A read: it shares and changes nothing. */
  async sessionSharingRead(project: string, peer: string): Promise<SessionSharingSnapshot> {
    if (this.closed) failure('closed');
    const owner = this.projectViewPeer(), epoch = this.generation, target = sessionSharingTarget({owner, project, peer});
    const reply = await this.wire('/apps/readymade-collab/session-sharing', 'GET', undefined, sessionSharingHeaders(target), {timeoutMs: 15000}, REMOTE_PROJECT_VIEW_LIMIT);
    if (this.closed || epoch !== this.generation || this.projectViewPeer() !== owner) failure('contextChanged');
    if ([401, 403].includes(reply.status)) failure('authenticationRequired', reply.status);
    const json = this.projectViewJSON(reply), reason = sessionSharingRefusal(reply.status, json, false);
    if (reason) throw new SessionSharingRefusedError(reply.status, reason);
    if (reply.status !== 200) failure('unavailable', reply.status);
    try {return sessionSharingSnapshot(json, target);} catch {return failure('malformed');}
  }
  /** One explicit command, sent once and never held or replayed here. Its receipt confirms nothing: read the standing again. */
  async sessionSharingSubmit(value: SessionSharingCommand): Promise<SessionSharingReceipt> {
    if (this.closed) failure('closed');
    const command = sessionSharingCommand(value), owner = this.projectViewPeer();
    if (command.owner !== owner) failure('contextChanged');
    if (this.busy) failure('commandBusy');
    const body = this.encode({schema: 'readymade-session-sharing-command-v1', ...command});
    if (body.length > 4096) failure('tooLarge');
    this.busy = true; const epoch = this.generation;
    try {
      const reply = await this.wire('/apps/readymade-collab/session-sharing', 'POST', body,
        {'Content-Type': 'application/json', 'x-readymade-session-sharing': 'v1'}, {timeoutMs: 15000}, REMOTE_PROJECT_VIEW_LIMIT);
      if (this.closed || epoch !== this.generation || this.projectViewPeer() !== owner) throw new OutcomeUnknownError();
      if ([401, 403].includes(reply.status)) failure('authenticationRequired', reply.status);
      const json = this.projectViewJSON(reply), reason = sessionSharingRefusal(reply.status, json, true);
      if (reason) throw new SessionSharingRefusedError(reply.status, reason);
      return sessionSharingReceipt(reply.status, json, command);
    } catch (error) {
      if (error instanceof ShipClientError && ['refused', 'authenticationRequired'].includes(error.code)) throw error;
      throw new OutcomeUnknownError();
    } finally {this.busy = false;}
  }
  /** Whether this ship can take part in a shared project: a read of its own routes and kiln desks; changes nothing. */
  async guestServiceRead(): Promise<GuestServiceState> {
    if (this.closed) failure('closed');
    const actor = this.projectViewPeer(), epoch = this.generation;
    const probe = await this.wire(GUEST_PROBE_PATH, 'GET', undefined, {}, {timeoutMs: 15000}, 65536);
    if (this.closed || epoch !== this.generation || this.projectViewPeer() !== actor) failure('contextChanged');
    if ([401, 403].includes(probe.status)) failure('authenticationRequired', probe.status);
    let json: unknown; try {json = probe.data.length ? JSON.parse(probe.data.toString('utf8')) : undefined;} catch {json = undefined;}
    const seen = guestServiceProbe(probe.status, json);
    if (seen === 'unknown') failure('unavailable', probe.status);
    if (seen === 'present') return guestServiceState('present', null);
    const desks = await this.wire(GUEST_PIKES_PATH, 'GET', undefined, {}, {timeoutMs: 15000}, 2 * 1024 * 1024);
    if (this.closed || epoch !== this.generation || this.projectViewPeer() !== actor) failure('contextChanged');
    if ([401, 403].includes(desks.status)) failure('authenticationRequired', desks.status);
    if (desks.status !== 200) failure('unavailable', desks.status);
    let local: ReturnType<typeof guestServiceDesk>;
    try {local = guestServiceDesk(JSON.parse(desks.data.toString('utf8')));} catch {return failure('malformed');}
    return guestServiceState(seen, local);
  }
  /** The separately installed guest desk as this ship's kiln reports it, or null when the ship has none. */
  async guestServiceDeskRead(): Promise<ReturnType<typeof guestServiceDesk>> {
    if (this.closed) failure('closed');
    const actor = this.projectViewPeer(), epoch = this.generation;
    const desks = await this.wire(GUEST_PIKES_PATH, 'GET', undefined, {}, {timeoutMs: 15000}, 2 * 1024 * 1024);
    if (this.closed || epoch !== this.generation || this.projectViewPeer() !== actor) failure('contextChanged');
    if ([401, 403].includes(desks.status)) failure('authenticationRequired', desks.status);
    if (desks.status !== 200) failure('unavailable', desks.status);
    try {return guestServiceDesk(JSON.parse(desks.data.toString('utf8')));} catch {return failure('malformed');}
  }
  /**
   * Asks this ship's own kiln, once, to install or revive the collaboration service from `source`.
   * Accepted means sent: read the state again to learn what happened. A lost reply is never resent here;
   * kiln treats a repeated install of the same desk as the same install, so the caller may ask again after reading.
   */
  async guestServiceInstall(source: GuestSource = GUEST_SOURCE, revive = false): Promise<void> {
    return this.guestKiln(actor => guestInstallActions(actor, source, revive));
  }
  /**
   * Asks this ship's own kiln, once, to remove the guest desk. Accepted means sent: read the state again.
   * Only the guest desk is named; a ship that runs the agent from a full backend is not changed by this.
   */
  async guestServiceRemove(): Promise<void> {return this.guestKiln(actor => guestRemoveActions(actor));}
  /** The installed full backend desk as this ship's kiln reports it (and what it follows), or null when the ship has none. */
  async backendDeskRead(): Promise<ReturnType<typeof fullDesk>> {
    if (this.closed) failure('closed');
    const actor = this.projectViewPeer(), epoch = this.generation;
    const desks = await this.wire(GUEST_PIKES_PATH, 'GET', undefined, {}, {timeoutMs: 15000}, 2 * 1024 * 1024);
    if (this.closed || epoch !== this.generation || this.projectViewPeer() !== actor) failure('contextChanged');
    if ([401, 403].includes(desks.status)) failure('authenticationRequired', desks.status);
    if (desks.status !== 200) failure('unavailable', desks.status);
    try {return fullDesk(JSON.parse(desks.data.toString('utf8')));} catch {return failure('malformed');}
  }
  /** Asks this ship's own kiln, once, to follow the published backend. Accepted means sent: read the desk again. */
  async backendFollow(source: GuestSource = FULL_SOURCE): Promise<void> {return this.guestKiln(actor => fullFollowActions(actor, source));}
  private async guestKiln(build: (actor: string) => unknown[]): Promise<void> {
    if (this.closed) failure('closed');
    const actor = this.projectViewPeer();
    if (this.busy) failure('commandBusy');
    const actions = build(actor), body = Buffer.from(JSON.stringify(actions));
    const channel = '/~/channel/readymade-guest-' + randomUUID();
    this.busy = true; const epoch = this.generation;
    try {
      const reply = await this.wire(channel, 'PUT', body, {'Content-Type': 'application/json'}, {timeoutMs: 15000}, 65536);
      if (this.closed || epoch !== this.generation || this.projectViewPeer() !== actor) throw new OutcomeUnknownError();
      if ([401, 403].includes(reply.status)) failure('authenticationRequired', reply.status);
      // Only the ship's own 4xx is a refusal; a 5xx or a proxy's error says nothing about what the ship did.
      if (reply.status >= 400 && reply.status < 500) failure('refused', reply.status);
      if (![200, 204].includes(reply.status)) throw new OutcomeUnknownError();
    } catch (error) {
      if (error instanceof ShipClientError && ['refused', 'authenticationRequired'].includes(error.code)) throw error;
      throw new OutcomeUnknownError();
    } finally {
      this.busy = false;
      void this.wire(channel, 'PUT', Buffer.from(JSON.stringify([{id: actions.length + 1, action: 'delete'}])), {'Content-Type': 'application/json'}, {timeoutMs: 10000}, 65536).catch(() => undefined);
    }
  }
  /**
   * This ship's own guest desk and collaboration protocol. A ship whose agent predates the route answers 404,
   * reported as protocol 0 with nothing published.
   */
  async guestDeskRead(): Promise<GuestDeskStatus> {
    if (this.closed) failure('closed');
    const actor = this.projectViewPeer(), epoch = this.generation;
    const reply = await this.wire(GUEST_DESK_PATH, 'GET', undefined, {}, {timeoutMs: 15000}, 65536);
    if (this.closed || epoch !== this.generation || this.projectViewPeer() !== actor) failure('contextChanged');
    if ([401, 403].includes(reply.status)) failure('authenticationRequired', reply.status);
    if (reply.status === 404) return Object.freeze({protocol: 0, published: false, public: false, revision: 0, source: '', files: 0, missing: Object.freeze([])});
    if (reply.status !== 200) failure('unavailable', reply.status);
    try {return guestDeskStatus(JSON.parse(reply.data.toString('utf8')));} catch {return failure('malformed');}
  }
  /** Asks this ship, once, to publish its guest desk from its own installed code. The receipt confirms nothing: read again. */
  async guestDeskPublish(): Promise<{status: 'submitted' | 'unchanged'; changed: number}> {
    if (this.closed) failure('closed');
    const actor = this.projectViewPeer();
    if (this.busy) failure('commandBusy');
    this.busy = true; const epoch = this.generation;
    try {
      const reply = await this.wire(GUEST_DESK_PATH, 'POST', Buffer.from(GUEST_DESK_PUBLISH),
        {'Content-Type': 'application/json', 'x-readymade-guest-desk': 'v1'}, {timeoutMs: 30000}, 65536);
      if (this.closed || epoch !== this.generation || this.projectViewPeer() !== actor) throw new OutcomeUnknownError();
      if ([401, 403].includes(reply.status)) failure('authenticationRequired', reply.status);
      if ([400, 409].includes(reply.status)) failure('refused', reply.status);
      return guestDeskReceipt(reply.status, JSON.parse(reply.data.toString('utf8')));
    } catch (error) {
      if (error instanceof ShipClientError && ['refused', 'authenticationRequired'].includes(error.code)) throw error;
      throw new OutcomeUnknownError();
    } finally {this.busy = false;}
  }
  /** Caller must persist the exact intent before this explicit one-shot submission. */
  async projectSuggestionSubmit(value: RemoteSuggestionIntent, consent: boolean): Promise<RemoteSuggestionReply> {
    if (this.closed) failure('closed');
    if (consent !== true) failure('consentRequired');
    const intent = remoteSuggestionIntent(value), o = intent.observation, peer = this.projectViewPeer();
    if (o.origin !== this.origin || o.peer !== peer) failure('contextChanged');
    const key = JSON.stringify([peer, o.owner, o.project, o.generation, intent.request]);
    if (this.busy || this.projectSuggestions.has(key) || this.projectSuggestions.size >= 256) failure('commandBusy');
    const body = this.encode(remoteSuggestionBody(intent));
    if (body.length > 262144) failure('tooLarge');
    this.busy = true; const epoch = this.generation; this.projectSuggestions.add(key);
    try {
      const reply = await this.wire('/apps/readymade-collab/project-suggest', 'POST', body,
        {'Content-Type': 'application/json', 'x-readymade-project-suggest': 'v1'}, {timeoutMs: 15000}, 65536);
      if (this.closed || epoch !== this.generation || this.projectViewPeer() !== peer) throw new OutcomeUnknownError();
      const json = this.projectViewJSON(reply);
      if (remoteSuggestionRefused(reply.status, json)) failure('refused', reply.status);
      return remoteSuggestionReply(reply.status, json, intent, true);
    } catch (error) {
      if (error instanceof ShipClientError && error.code === 'refused') throw error;
      throw new OutcomeUnknownError();
    } finally {this.busy = false;}
  }
  /** Reads an exact durable intent after reconnect; missing evidence never resubmits. */
  async projectSuggestionResult(value: RemoteSuggestionIntent): Promise<RemoteSuggestionReply> {
    if (this.closed) failure('closed');
    const intent = remoteSuggestionIntent(value), o = intent.observation, peer = this.projectViewPeer(), epoch = this.generation;
    if (o.origin !== this.origin || o.peer !== peer) failure('contextChanged');
    const reply = await this.wire('/apps/readymade-collab/project-suggest-result', 'GET', undefined,
      remoteSuggestionHeaders(intent), {timeoutMs: 15000}, 65536);
    if (this.closed || epoch !== this.generation || this.projectViewPeer() !== peer) failure('contextChanged');
    return remoteSuggestionReply(reply.status, this.projectViewJSON(reply), intent);
  }
  /** Explicit read-only owner receipt recovery. No suggestion poke or send retry. */
  async projectSuggestionRecover(value: RemoteSuggestionIntent, consent: boolean): Promise<RemoteSuggestionRecoveryReply> {
    if (this.closed) failure('closed');
    if (consent !== true) failure('consentRequired');
    const intent = remoteSuggestionIntent(value), o = intent.observation, peer = this.projectViewPeer(), epoch = this.generation;
    if (o.origin !== this.origin || o.peer !== peer) failure('contextChanged');
    if (this.busy) failure('commandBusy');
    const body = this.encode(remoteSuggestionRecoveryBody(intent));
    if (body.length > 262144) failure('tooLarge');
    this.busy = true;
    try {
      const reply = await this.wire('/apps/readymade-collab/project-suggest-recover', 'POST', body,
        {'Content-Type': 'application/json', 'x-readymade-project-suggest': 'v1'}, {timeoutMs: 15000}, 8192);
      if (this.closed || epoch !== this.generation || this.projectViewPeer() !== peer) failure('contextChanged');
      return remoteSuggestionRecoveryReply(reply.status, this.projectViewJSON(reply), intent);
    } finally {this.busy = false;}
  }
  async projectSuggestionRecoveryResult(value: RemoteSuggestionIntent): Promise<RemoteSuggestionRecoveryReply> {
    if (this.closed) failure('closed');
    const intent = remoteSuggestionIntent(value), o = intent.observation, peer = this.projectViewPeer(), epoch = this.generation;
    if (o.origin !== this.origin || o.peer !== peer) failure('contextChanged');
    const reply = await this.wire('/apps/readymade-collab/project-suggest-recovery-result', 'GET', undefined,
      remoteSuggestionHeaders(intent), {timeoutMs: 15000}, 8192);
    if (this.closed || epoch !== this.generation || this.projectViewPeer() !== peer) failure('contextChanged');
    return remoteSuggestionRecoveryReply(reply.status, this.projectViewJSON(reply), intent);
  }
  /** Read historical suggestions as the authenticated project owner. */
  async projectInbox(project: string, receipt?: string): Promise<JsonObject> {
    if (this.closed) failure('closed');
    const owner = this.projectViewPeer(), epoch = this.generation;
    remoteProjectViewTarget({owner, project, generation: '1'});
    if (this.current && this.current.owner !== owner) failure('contextChanged');
    if (receipt !== undefined && (!isUx(receipt) || receipt.startsWith('0x0') || BigInt(receipt.replaceAll('.', '')) >= (1n << 256n))) failure('contextChanged');
    const headers: Record<string, string> = {'x-readymade-project': Buffer.from(project, 'utf8').toString('latin1')};
    if (receipt !== undefined) headers['x-readymade-project-receipt'] = receipt;
    const reply = await this.wire('/apps/readymade-collab/project-inbox', 'GET', undefined, headers, {timeoutMs: 15000}, 524288);
    if (this.closed || epoch !== this.generation || this.projectViewPeer() !== owner || this.current && this.current.owner !== owner) failure('contextChanged');
    if ([401, 403].includes(reply.status)) failure('authenticationRequired', reply.status);
    const body = this.projectViewJSON(reply);
    if (reply.status !== 200) failure(reply.status === 404 ? 'receiptMissing' : 'refused', reply.status);
    try {decodeProjectInbox(body, owner, project, receipt);} catch {return failure('malformed');}
    return body;
  }
  async projectInvitation<K extends keyof ProjectInvitationParameters>(operation: K, value: ProjectInvitationParameters[K]): Promise<WorkspaceRequestReply> {
    if (this.closed) failure('closed');
    const actor = this.projectViewPeer(), epoch = this.generation, p = asRecord(value);
    const headers: Record<string, string> = {}; let body: string | undefined, route: string;
    if (operation === 'submit') {
      const c = invitationCommand(value);
      if (['invite-member', 'revoke-invitation', 'expire-invitation'].includes(c.operation) && c.authority !== actor) failure('contextChanged');
      body = JSON.stringify({schema: 'readymade-project-invitation-v1', ...c});
      if (Buffer.byteLength(body) > 4096) failure('requestTooLarge');
      headers['Content-Type'] = 'application/json'; headers['x-readymade-project-invitation'] = 'v1'; route = 'project-invitation';
    } else if (operation === 'result') {
      if (Object.keys(p).length !== 1 || !invitationUuid(p.request)) failure('contextChanged');
      headers['x-readymade-project-request'] = p.request; route = 'project-invitation-result';
    } else {
      if (!['requests', 'members'].includes(operation)) failure('contextChanged');
      const allowed = operation === 'members' ? ['project', 'kind', 'offset', 'catalog'] : ['offset', 'catalog'];
      const offset = p.offset ?? 0;
      if (Object.keys(p).some(k => !allowed.includes(k)) || !Number.isSafeInteger(offset) || Number(offset) < 0 || p.catalog !== undefined && !invitationHash(p.catalog) || Number(offset) > 0 && !p.catalog) failure('contextChanged');
      const prefix = operation === 'members' ? 'x-readymade-project-' : 'x-readymade-invitation-';
      headers[prefix + 'offset'] = String(offset);
      if (p.catalog !== undefined) headers[prefix + 'catalog'] = String(p.catalog);
      route = operation === 'members' ? 'project-members' : 'project-invitation-requests';
      if (operation === 'members') {
        if (!invitationProject(p.project) || !['members', 'invitations', 'events'].includes(String(p.kind))) failure('contextChanged');
        headers['x-readymade-project'] = Buffer.from(p.project, 'utf8').toString('latin1'); headers['x-readymade-project-kind'] = String(p.kind);
      }
    }
    if (this.busy) failure('commandBusy');
    this.busy = true;
    try {
      const reply = await this.wire('/apps/readymade-collab/' + route, body === undefined ? 'GET' : 'POST', body === undefined ? undefined : Buffer.from(body), headers, {timeoutMs: 15000}, 65536);
      if (this.closed || epoch !== this.generation || this.projectViewPeer() !== actor) failure('contextChanged');
      const json = this.projectViewJSON(reply);
      if (reply.status === 200) {
        if (operation === 'submit') invitationResult(json, invitationCommand(value));
        else if (operation === 'result') {if (invitationResult(json).request !== p.request) failure('contextChanged');}
        else if (operation === 'requests') invitationCatalog(json, actor, Number(p.offset ?? 0), p.catalog as string | undefined);
        else invitationMembers(json, String(p.project), actor, p.kind as 'members' | 'invitations' | 'events', Number(p.offset ?? 0), p.catalog as string | undefined);
      }
      return {status: reply.status, body: json};
    } catch (error) {
      // A command that was sent and got no usable answer: its outcome is unknown, never a plain failure.
      const known = ['authenticationRequired', 'refused', 'cancelledBeforeSend', 'requestTooLarge', 'invalidOrigin', 'secureTransportRequired', 'redirectRefused', 'consentRequired'];
      if (operation !== 'submit' || error instanceof ShipClientError && known.includes(error.code)) throw error;
      throw new OutcomeUnknownError();
    } finally {this.busy = false;}
  }
  /** Refuses now, before a caller records an intent, when a request could not be sent anyway. Nothing is sent. */
  assertIdle(): void {if (this.closed) failure('closed'); if (this.busy) failure('commandBusy');}
  private projectViewPeer(): string {
    const active = this.cookies.filter(cookie => cookie.expires > Date.now());
    if (active.length !== 1) return failure('authenticationRequired');
    const name = active[0].value.split('=', 1)[0], peer = name.slice('urbauth-'.length);
    if (!name.startsWith('urbauth-') || !remoteShip(peer)) return failure('authenticationRequired');
    return peer;
  }
  private projectViewJSON(reply: Wire): JsonObject {
    if (reply.status >= 300 && reply.status < 400) failure('redirectRefused');
    if (reply.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') failure('malformed');
    try {return remoteProjectViewJSON(reply.data);} catch {return failure('malformed');}
  }
  private activityJSON(reply: Wire): JsonObject {
    if (reply.status >= 300 && reply.status < 400) failure('redirectRefused');
    if (reply.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') failure('malformed');
    try {
      const value = asRecord(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(reply.data)) as unknown);
      if (!validJSON(value)) failure('malformed');
      return value;
    } catch { return failure('malformed'); }
  }
  /** Retain the request ID durably before submit. Result reads never resend a command. */
  async projectSharing<K extends keyof ProjectSharingParameters>(operation: K, parameters: ProjectSharingParameters[K]): Promise<WorkspaceRequestReply> {
    if (this.closed) failure('closed');
    if (!['read', 'result', 'submit'].includes(operation)) failure('contextChanged');
    let params: JsonObject;
    try { params = asRecord(parameters); } catch { return failure('contextChanged'); }
    const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
    const ship = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && /^~(?:[a-z]{3}|[a-z]{6}(?:-[a-z]{6}){0,3}(?:--[a-z]{6}(?:-[a-z]{6}){3})?)$/.test(value);
    const project = (value: unknown): value is string => typeof value === 'string' && validUnicode(value) && Buffer.byteLength(value) > 0 && Buffer.byteLength(value) <= 128 && !/[\u0000-\u001f\u007f:]/u.test(value);
    const fields = operation === 'read' ? ['project', 'peer'] : operation === 'result' ? ['request'] :
      ['request', 'owner', 'project', 'peer', 'expected', 'operation', ...(params.operation === 'grant' ? ['desk', 'paths', 'permission'] : ['generation'])];
    if (Object.keys(params).length !== fields.length || fields.some(key => !Object.hasOwn(params, key))) failure('contextChanged');
    const headers: http.OutgoingHttpHeaders = {};
    if (operation === 'result') {
      if (!uuid(params.request)) failure('contextChanged');
      headers['x-readymade-project-request'] = params.request;
    } else {
      if (!project(params.project) || !ship(params.peer)) failure('contextChanged');
      if (operation === 'read') {
        headers['x-readymade-project'] = params.project; headers['x-readymade-project-peer'] = params.peer;
      } else {
        if (!uuid(params.request) || !ship(params.owner) || typeof params.expected !== 'string' ||
            !/^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(params.expected) || params.expected.replace(/\./g, '').length > 66) failure('contextChanged');
        if (params.operation === 'grant') {
          if (typeof params.desk !== 'string' || !/^[a-z0-9-]{1,64}$/.test(params.desk) || typeof params.paths !== 'string' || Buffer.byteLength(params.paths) > 4096 ||
              !['view', 'suggest', 'view-suggest'].includes(String(params.permission))) failure('contextChanged');
          const paths = params.paths.split('\n');
          if (!paths.length || paths.length > 8 || new Set(paths).size !== paths.length || paths.some(path => !/^\/(?:app|lib|ted)\/(?:[a-z0-9-]{1,63}\/){1,6}hoon$/.test(path))) failure('contextChanged');
        } else if (params.operation === 'revoke') {
          if (typeof params.generation !== 'string' || !/^[1-9][0-9]{0,2}(?:\.[0-9]{3})*$/.test(params.generation) ||
              params.generation.length > 26 || BigInt(params.generation.replace(/\./g, '')) > 18446744073709551615n) failure('contextChanged');
        } else failure('contextChanged');
      }
    }
    const post = operation === 'submit', id = `sharing:${params.request}`;
    if (post && (this.busy || this.workspaceSubmitted.size >= 512 || this.workspaceSubmitted.has(id))) failure('commandBusy');
    if (post) this.busy = true;
    const epoch = this.generation;
    try {
      const body = post ? this.encode({ schema: 'readymade-project-sharing-v1', ...params }) : undefined;
      if (body && body.length > 8192) failure('contextChanged');
      if (post) { headers['Content-Type'] = 'application/json'; headers['x-readymade-project-sharing'] = 'v1'; }
      const reply = await this.wire(`/apps/readymade-collab/project-sharing${operation === 'result' ? '-result' : ''}`, post ? 'POST' : 'GET', body, headers, {}, 65536);
      if (this.closed || epoch !== this.generation) failure('contextChanged');
      if ([401, 403].includes(reply.status)) failure('authenticationRequired', reply.status);
      if (reply.status >= 300 && reply.status < 400) failure('redirectRefused');
      let value: JsonObject;
      try {
        if (reply.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') failure('malformed');
        value = asRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.data)) as unknown);
        if (!validJSON(value)) failure('malformed');
      } catch { return failure('malformed'); }
      if (![200, 202, 409, ...(operation === 'result' ? [404] : [])].includes(reply.status)) {
        if (reply.status === 400) failure('refused', reply.status);
        failure('unavailable', reply.status);
      }
      if (post) this.workspaceSubmitted.add(id);
      return { status: reply.status, body: value };
    } catch (error) {
      if (!post || this.knownRefusal(error)) throw error;
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
    if (reply.status === 403 && (options.method ?? 'GET') === 'GET' && path === '/apps/pataphor-cli/source' &&
        reply.headers['content-type']?.split(';')[0]?.trim().toLowerCase() === 'application/json') {
      let transportRequired = false;
      try {
        const refusal = asRecord(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(reply.data)) as unknown);
        transportRequired = Object.keys(refusal).length === 1 && refusal.status === 'secure-transport-required';
      } catch { /* Unrecognized refusals retain normal authentication handling. */ }
      if (transportRequired) failure('secureTransportRequired', reply.status);
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
      let slow = false;
      const abort = (): void => { request.destroy(new ShipClientError('transport', undefined, slow ? 'slow' : undefined)); };
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
        else { slow = true; abort(); }
      }, timeout); this.requests.add(request);
      request.on('error', (error: NodeJS.ErrnoException) => {
        const code = error.code === 'ERR_TLS_CERT_ALTNAME_INVALID' ? 'certificateHostname'
          : ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
            'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_UNTRUSTED'].includes(error.code ?? '') ? 'certificateUntrusted' : 'transport';
        // An abort carries its own reason (a slow ship); every other destroy keeps the code it always had.
        if (error instanceof ShipClientError && error.code === 'transport' && error.detail) { finish(error); return; }
        const detail: TransportDetail | undefined = code !== 'transport' ? undefined : error.code === 'ECONNREFUSED' ? 'down'
          : ['ENOTFOUND', 'EAI_AGAIN'].includes(error.code ?? '') ? 'unknownHost' : ['ECONNRESET', 'EPIPE'].includes(error.code ?? '') ? 'dropped' : undefined;
        finish(new ShipClientError(code, undefined, detail));
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort(); else request.end(body);
    }).catch((error: unknown) => { if (error instanceof ShipClientError) throw error; return failure('transport'); });
  }
}
