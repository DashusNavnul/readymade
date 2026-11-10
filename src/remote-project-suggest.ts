import {randomBytes} from 'node:crypto';
import {dateAtom} from './editing-activity';
import {asRecord, type JsonObject} from './protocol';
import {remoteSourceObservation, remoteSourceHash, remoteProjectViewSelector, remoteProjectViewHeaders,
  type RemoteSourceObservation, type RemoteProjectViewSelector} from './remote-project-view';

export interface RemoteSuggestionIntent {
  readonly observation: RemoteSourceObservation; readonly path: string; readonly source: string; readonly request: string;
}
export type RemoteSuggestionReply = RemoteProjectViewSelector & {readonly peer: string; readonly permissionGranted: false; readonly committed: false} & (
  {readonly status: 'missing' | 'expired'} |
  {readonly status: 'watching' | 'sent' | 'recorded' | 'refused' | 'uncertain'; readonly viewRequest: string;
    readonly grant: string; readonly root: string; readonly snapshotDigest: string; readonly path: string; readonly sourceHash: string;
    readonly reason: string; readonly deadline: string; readonly retainedUntil: string; readonly receiptHash: string | null}
);
function invalid(): never {throw new Error('Invalid or uncorrelated shared suggestion.');}
function exact(value: unknown, fields: string[]): JsonObject {
  const r = asRecord(value);
  if (Object.getPrototypeOf(r) !== Object.prototype || Object.keys(r).length !== fields.length || !fields.every(k => Object.hasOwn(r, k))) invalid();
  return r;
}
export function newRemoteSuggestionRequest(): string {
  const n = BigInt('0x' + randomBytes(16).toString('hex')) || 1n;
  return '0x' + n.toString(16).replace(/\B(?=(?:[0-9a-f]{4})+$)/g, '.');
}
export function remoteSuggestionIntent(value: unknown): RemoteSuggestionIntent {
  const r = exact(value, ['observation', 'path', 'source', 'request']), o = remoteSourceObservation(r.observation);
  const key = remoteProjectViewSelector({owner: o.owner, project: o.project, generation: o.generation, request: r.request});
  if (typeof r.path !== 'string' || !o.files.some(f => f.path === r.path) || typeof r.source !== 'string' ||
      /[^\t\n\r\x20-\x7e]/.test(r.source) || Buffer.byteLength(r.source) > 32768) invalid();
  return Object.freeze({observation: o, path: r.path, source: r.source, request: key.request});
}
export function remoteSuggestionBody(value: RemoteSuggestionIntent): JsonObject {
  const i = remoteSuggestionIntent(value), o = i.observation;
  return {schema: 'readymade-project-suggest-v1', owner: o.owner, project: o.project, generation: o.generation,
    viewRequest: o.request, request: i.request, path: i.path, source: i.source};
}
export function remoteSuggestionHeaders(value: RemoteSuggestionIntent): Record<string, string> {
  const i = remoteSuggestionIntent(value), o = i.observation;
  const headers = remoteProjectViewHeaders({owner: o.owner, project: o.project, generation: o.generation, request: i.request});
  delete headers['x-readymade-project-view-request']; headers['x-readymade-project-suggest-request'] = i.request;
  return headers;
}
export function remoteSuggestionRefused(status: number, value: unknown): boolean {
  const r = asRecord(value);
  if (Object.keys(r).length !== 2 || r.status !== 'refused') return false;
  return status === 403 && r.message === 'Owner login required.' ||
    status === 400 && r.message === 'Exact owner-origin suggestion required.' ||
    status === 409 && ['Exact retained source observation required.', 'ready-view-required', 'view-or-source-invalid',
      'selector-invalid', 'request-reused', 'request-conflict', 'suggest-capacity'].includes(String(r.message));
}
export function remoteSuggestionReply(status: number, value: unknown, supplied: RemoteSuggestionIntent, post = false): RemoteSuggestionReply {
  const i = remoteSuggestionIntent(supplied), o = i.observation;
  const common = {owner: o.owner, peer: o.peer, project: o.project, generation: o.generation, request: i.request,
    permissionGranted: false as const, committed: false as const};
  if (!post && (status === 404 || status === 410)) {
    const r = exact(value, ['status', 'message']);
    if (!(status === 404 && r.status === 'unknown' && r.message === 'Suggestion not retained; do not resend an unknown outcome.' ||
          status === 410 && r.status === 'expired' && r.message === 'Suggestion observation expired; no retry issued.')) invalid();
    return Object.freeze({...common, status: status === 404 ? 'missing' : 'expired'});
  }
  const r = exact(value, ['schema', 'owner', 'peer', 'project', 'generation', 'request', 'viewRequest', 'grant', 'root', 'snapshotDigest',
    'status', 'reason', 'path', 'sourceHash', 'deadline', 'retainedUntil', 'permissionGranted', 'committed', 'receiptHash']);
  if (r.schema !== 'readymade-project-suggest-result-v1' || Object.entries(common).some(([k, v]) => r[k] !== v) ||
      r.viewRequest !== o.request || r.grant !== o.grant || r.root !== o.root || r.snapshotDigest !== o.snapshotDigest ||
      r.path !== i.path || r.sourceHash !== remoteSourceHash(i.source)) invalid();
  const reasons: Record<string, string[]> = {watching: ['awaiting-owner'], sent: ['awaiting-receipt'], recorded: ['suggestion-recorded'],
    refused: ['watch-refused'], uncertain: ['suggest-timeout', 'watch-refused', 'poke-refused', 'closed-without-receipt', 'invalid-reply', 'grant-mismatch', 'receipt-mismatch']};
  if (typeof r.status !== 'string' || typeof r.reason !== 'string' || !Object.hasOwn(reasons, r.status) || !reasons[r.status].includes(r.reason) ||
      status !== (post || r.status === 'watching' || r.status === 'sent' ? 202 : 200) ||
      dateAtom(r.retainedUntil) - dateAtom(r.deadline) !== (300n << 64n)) invalid();
  if (r.status === 'recorded') {
    if (typeof r.receiptHash !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*)$/.test(r.receiptHash) ||
        r.receiptHash.length > 82 || BigInt(r.receiptHash.replaceAll('.', '')) >= 1n << 256n) invalid();
  } else if (r.receiptHash !== null) invalid();
  return Object.freeze({...common, status: r.status as 'watching' | 'sent' | 'recorded' | 'refused' | 'uncertain',
    viewRequest: o.request, grant: o.grant, root: o.root, snapshotDigest: o.snapshotDigest, path: i.path, sourceHash: r.sourceHash as string,
    reason: r.reason, deadline: r.deadline as string, retainedUntil: r.retainedUntil as string, receiptHash: r.receiptHash as string | null});
}

export type RemoteSuggestionRecoveryReply = RemoteSuggestionReply & {readonly recovery: true};
export function remoteSuggestionRecoveryBody(value: RemoteSuggestionIntent): JsonObject {
  const i = remoteSuggestionIntent(value), o = i.observation;
  return {...remoteSuggestionBody(i), schema: 'readymade-project-suggest-recover-v1', grant: o.grant, root: o.root, snapshotDigest: o.snapshotDigest};
}
/** Recovery is a separately correlated observation, never a send receipt rewrite. */
export function remoteSuggestionRecoveryReply(status: number, value: unknown, intent: RemoteSuggestionIntent): RemoteSuggestionRecoveryReply {
  if (status === 404 || status === 410) {
    const r = exact(value, ['status', 'message']);
    if (!(status === 404 && r.status === 'unknown' && r.message === 'Recovery observation not retained; original outcome stays unknown.' ||
          status === 410 && r.status === 'expired' && r.message === 'Recovery observation expired; no suggestion resent.')) invalid();
    const old = status === 404 ? {status: 'unknown', message: 'Suggestion not retained; do not resend an unknown outcome.'}
      : {status: 'expired', message: 'Suggestion observation expired; no retry issued.'};
    return Object.freeze({...remoteSuggestionReply(status, old, intent), recovery: true});
  }
  const r = asRecord(value);
  if (r.schema !== 'readymade-project-suggest-recovery-result-v1' || r.recovery !== true ||
      !['watching', 'recorded', 'uncertain'].includes(String(r.status))) invalid();
  const {recovery: _recovery, ...fields} = r;
  const reason = r.reason === 'recovering-receipt' && r.status === 'watching' ? 'awaiting-owner'
    : r.reason === 'unexpected-recovery-ready' && r.status === 'uncertain' ? 'invalid-reply' : r.reason;
  if (r.status === 'watching' && r.reason !== 'recovering-receipt') invalid();
  const parsed = remoteSuggestionReply(status, {...fields, schema: 'readymade-project-suggest-result-v1', reason}, intent);
  if (parsed.status === 'missing' || parsed.status === 'expired') invalid();
  return Object.freeze({...parsed, reason: r.reason as string, recovery: true});
}
