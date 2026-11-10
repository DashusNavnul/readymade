import {createHash} from 'node:crypto';
import {dateAtom} from './editing-activity';
import {asRecord, validUnicode, type JsonObject} from './protocol';

export interface RemoteProjectViewTarget {readonly owner: string; readonly project: string; readonly generation: string}
export interface RemoteProjectViewSelector extends RemoteProjectViewTarget {readonly request: string}
export interface RemoteSourceFile {readonly path: string; readonly text: string; readonly hash: string}
export interface RemoteSourceObservation extends RemoteProjectViewSelector {
  readonly origin: string; readonly peer: string; readonly grant: string; readonly observedAt: string;
  readonly root: string; readonly snapshotDigest: string; readonly desk: string; readonly revision: string;
  readonly files: readonly RemoteSourceFile[];
}
export type RemoteProjectViewReply = RemoteProjectViewSelector & {readonly peer: string; readonly permissionGranted: false} & (
  {readonly status: 'missing' | 'expired'} |
  {readonly status: 'pending' | 'ready' | 'refused' | 'uncertain'; readonly reason: string;
    readonly deadline: string; readonly retainedUntil: string; readonly observation: RemoteSourceObservation | null}
);
export const REMOTE_PROJECT_VIEW_LIMIT = 524288;
function invalid(): never {throw new Error('Invalid or uncorrelated remote source observation.');}
function exact(value: unknown, keys: readonly string[]): JsonObject {
  const row = asRecord(value);
  if (Object.getPrototypeOf(row) !== Object.prototype || Object.keys(row).length !== keys.length || !keys.every(k => Object.hasOwn(row, k))) invalid();
  return row;
}
export function remoteShip(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && /^~(?:[a-z]{3}|[a-z]{6}(?:-[a-z]{6}){0,3}(?:--[a-z]{6}(?:-[a-z]{6}){3})?)$/.test(value);
}
function ux(value: unknown, bits = 256, zero = false): value is string {
  if (typeof value !== 'string' || value.length > 82 || !/^0x(?:0|[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*)$/.test(value)) return false;
  const n = BigInt(value.replaceAll('.', '')); return (zero || n > 0n) && n < (1n << BigInt(bits));
}
function ud(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 26 && /^[1-9][0-9]{0,2}(?:\.[0-9]{3})*$/.test(value) && BigInt(value.replaceAll('.', '')) < (1n << 64n);
}
export function remoteProjectViewTarget(value: unknown): RemoteProjectViewTarget {
  const r = exact(value, ['owner', 'project', 'generation']);
  if (!remoteShip(r.owner) || !ud(r.generation) || typeof r.project !== 'string' || !validUnicode(r.project) ||
      !Buffer.byteLength(r.project) || Buffer.byteLength(r.project) > 128 || /[\u0000-\u001f\u007f:]/u.test(r.project)) invalid();
  return Object.freeze({owner: r.owner, project: r.project, generation: r.generation});
}
export function remoteProjectViewSelector(value: unknown): RemoteProjectViewSelector {
  const r = exact(value, ['owner', 'project', 'generation', 'request']);
  const target = remoteProjectViewTarget({owner: r.owner, project: r.project, generation: r.generation});
  if (!ux(r.request, 128)) invalid(); return Object.freeze({...target, request: r.request});
}
export function remoteProjectViewHeaders(value: unknown): Record<string, string> {
  const s = remoteProjectViewSelector(value);
  return {'x-readymade-project-owner': s.owner, 'x-readymade-project': Buffer.from(s.project, 'utf8').toString('latin1'),
    'x-readymade-project-generation': s.generation, 'x-readymade-project-view-request': s.request};
}
/** shax hashes atom bytes; the SHA-256 output bytes are a little-endian atom. */
export function remoteSourceHash(text: string): string {
  const hex = BigInt('0x' + createHash('sha256').update(text, 'utf8').digest().reverse().toString('hex')).toString(16);
  return '0x' + hex.replace(/\B(?=(?:[0-9a-f]{4})+$)/g, '.');
}
/** Reject duplicate object keys before JSON.parse can discard their evidence. */
export function remoteProjectViewJSON(bytes: Uint8Array): JsonObject {
  if (bytes.byteLength > REMOTE_PROJECT_VIEW_LIMIT) invalid();
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  const value: unknown = JSON.parse(text), stack: (Set<string> | null)[] = [];
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{') stack.push(new Set()); else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const keys = stack.at(-1), key = JSON.parse(token) as string;
      if (!keys || keys.has(key)) invalid(); keys.add(key);
    }
  }
  return asRecord(value);
}
export function remoteProjectViewRefused(status: number, value: unknown): boolean {
  const r = asRecord(value);
  if (Object.keys(r).length !== 2 || r.status !== 'refused') return false;
  return status === 403 && r.message === 'Owner login required.' ||
    status === 400 && r.message === 'Exact owner-origin source view command required.' ||
    status === 409 && ['view-selector-invalid', 'view-request-reused', 'view-capacity'].includes(String(r.message));
}
/** Validate retained provenance without asserting current permission. */
export function remoteSourceObservation(value: unknown): RemoteSourceObservation {
  const r = exact(value, ['owner', 'project', 'generation', 'request', 'origin', 'peer', 'grant', 'observedAt', 'root', 'snapshotDigest', 'desk', 'revision', 'files']);
  const key = remoteProjectViewSelector({owner: r.owner, project: r.project, generation: r.generation, request: r.request});
  if (typeof r.origin !== 'string' || r.origin.length > 2048 || !remoteShip(r.peer) || r.peer === key.owner) invalid();
  const url = new URL(r.origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== r.origin) invalid();
  return sourceObservation(r, key, r.peer, r.origin);
}
function sourceObservation(o: JsonObject, key: RemoteProjectViewSelector, peer: string, origin: string): RemoteSourceObservation {
  if (o.owner !== key.owner || o.peer !== peer || !ux(o.grant) || !ux(o.root) || !ux(o.snapshotDigest, 256, true) || !ud(o.revision) ||
      typeof o.desk !== 'string' || !/^[a-z0-9-]{1,63}$/.test(o.desk) || !Array.isArray(o.files) || !o.files.length || o.files.length > 8) invalid();
  dateAtom(o.observedAt);
  let total = 0; const paths = new Set<string>();
  const files = o.files.map(value => {
    const f = exact(value, ['path', 'text', 'hash']);
    if (typeof f.path !== 'string' || !/^\/(?:app|lib|ted)\/(?:[a-z0-9-]{1,63}\/){1,6}hoon$/.test(f.path) || paths.has(f.path) ||
        typeof f.text !== 'string' || /[^\t\n\r\x20-\x7e]/.test(f.text) || Buffer.byteLength(f.text) > 32768 ||
        !ux(f.hash, 256, true) || f.hash !== remoteSourceHash(f.text)) invalid();
    paths.add(f.path); total += Buffer.byteLength(f.text);
    return Object.freeze({path: f.path, text: f.text, hash: f.hash});
  });
  if (total > 65536) invalid();
  return Object.freeze({...key, origin, peer, grant: o.grant, observedAt: o.observedAt as string, root: o.root,
    snapshotDigest: o.snapshotDigest, desk: o.desk, revision: o.revision, files: Object.freeze(files)});
}
/** Current native authorization was checked at disclosure time, never renewed here. */
export function remoteProjectViewReply(status: number, value: unknown, expected: RemoteProjectViewTarget | RemoteProjectViewSelector,
  peer: string, origin: string): RemoteProjectViewReply {
  if (!remoteShip(peer) || new URL(origin).origin !== origin) invalid();
  const get = Object.hasOwn(expected, 'request'), selected = get ? remoteProjectViewSelector(expected) : undefined;
  const wanted = selected ?? remoteProjectViewTarget(expected);
  if (peer === wanted.owner) invalid();
  if (get && (status === 404 || status === 410)) {
    const r = exact(value, ['status', 'message']);
    if (!(status === 404 && r.status === 'unknown' && r.message === 'Observation not retained; no retry was issued.' ||
          status === 410 && r.status === 'expired' && r.message === 'Historical observation expired.')) invalid();
    return Object.freeze({...selected!, peer, permissionGranted: false, status: status === 404 ? 'missing' : 'expired'});
  }
  const r = exact(value, ['schema', 'owner', 'peer', 'project', 'generation', 'request', 'status', 'reason', 'deadline', 'retainedUntil', 'permissionGranted', 'observation']);
  const key = remoteProjectViewSelector({owner: r.owner, project: r.project, generation: r.generation, request: r.request});
  if (r.schema !== 'readymade-project-view-result-v1' || r.permissionGranted !== false || r.peer !== peer ||
      key.owner !== wanted.owner || key.project !== wanted.project || key.generation !== wanted.generation || selected && key.request !== selected.request) invalid();
  const reasons: Record<string, readonly string[]> = {pending: ['awaiting-owner'], ready: ['observed'], refused: ['watch-refused'],
    uncertain: ['view-timeout', 'unexpected-poke-ack', 'closed-without-view', 'invalid-view', 'view-mismatch']};
  if (typeof r.status !== 'string' || typeof r.reason !== 'string' || !Object.hasOwn(reasons, r.status) || !reasons[r.status].includes(r.reason) ||
      (!get && r.status !== 'pending') || status !== (r.status === 'pending' ? 202 : 200)) invalid();
  const deadline = dateAtom(r.deadline), retained = dateAtom(r.retainedUntil);
  if (retained - deadline !== (300n << 64n)) invalid();
  let observation: RemoteSourceObservation | null = null;
  if (r.status === 'ready') {
    const o = exact(r.observation, ['owner', 'peer', 'grant', 'observedAt', 'root', 'snapshotDigest', 'desk', 'revision', 'files']);
    observation = sourceObservation(o, key, peer, origin);
  } else if (r.observation !== null) invalid();
  return Object.freeze({...key, peer, permissionGranted: false, status: r.status as 'pending' | 'ready' | 'refused' | 'uncertain',
    reason: r.reason, deadline: r.deadline as string, retainedUntil: r.retainedUntil as string, observation});
}
