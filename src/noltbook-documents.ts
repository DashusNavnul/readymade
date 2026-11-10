import {randomBytes} from 'node:crypto';
import {remoteShip, remoteSourceHash} from './remote-project-view';
import {dateAtom} from './editing-activity';

export interface DocumentUpdate {
  readonly noteId: string; readonly body: string; readonly revision: number;
  readonly updatedBy: string; readonly updatedAt: string; readonly versions: number; readonly bytes: number;
}
export interface DocumentSnapshot extends DocumentUpdate {
  readonly origin: string; readonly peer: string; readonly host: string; readonly canEdit: boolean;
}
export interface DocumentVersion {readonly revision: number; readonly body: string; readonly savedBy: string; readonly savedAt: string}
export interface DocumentHistory {readonly noteId: string; readonly versions: number; readonly bytes: number; readonly entries: readonly DocumentVersion[]; readonly isHost?: boolean}
export interface DocumentSaveIntent {readonly snapshot: DocumentSnapshot; readonly body: string; readonly requestId: number; readonly protocol?: 'receipted-v1'}
export interface DocumentReceipt {
  readonly schema: 'noltbook-document-receipt-v1'; readonly host: string; readonly requester: string; readonly noteId: string;
  readonly requestId: number; readonly expected: number; readonly bodyHash: string;
  readonly status: 'recorded' | 'pending' | 'missing' | 'refused' | 'capacity';
  readonly receipt: null | {readonly result: DocumentSaveResult['result']; readonly revision: number | null; readonly limit: number | null; readonly recordedAt: string};
}
export interface DocumentSaveResult {
  readonly noteId: string; readonly requestId: number;
  readonly result: 'saved' | 'no-change' | 'conflict' | 'too-large' | 'denied' | 'no-such-note';
  readonly revision: number | null; readonly limit: number | null;
}
const fail = (): never => {throw new Error('Invalid native document data');};
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) return fail();
  return row;
}
export function documentNoteId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_~-][a-zA-Z0-9_.~-]{0,127}$/.test(value) || value === '.' || value === '..') return fail();
  return value;
}
function integer(value: unknown): number {if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail(); return value;}
export function documentBody(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1_048_576 || /[\u0000\uD800-\uDFFF]/u.test(value)) return fail();
  return value;
}
function ship(value: unknown): string {if (!remoteShip(value)) return fail(); return value as string;}
function date(value: unknown): string {dateAtom(value); return value as string;}
const updateKeys = ['noteId', 'body', 'revision', 'updatedBy', 'updatedAt', 'versions', 'bytes'];
export function documentUpdate(value: unknown): DocumentUpdate {
  const r = object(value, updateKeys);
  return Object.freeze({noteId: documentNoteId(r.noteId), body: documentBody(r.body), revision: integer(r.revision),
    updatedBy: ship(r.updatedBy), updatedAt: date(r.updatedAt), versions: integer(r.versions), bytes: integer(r.bytes)});
}
export function documentSnapshot(value: unknown, origin: string, peer: string): DocumentSnapshot {
  const r = object(value, [...updateKeys, 'host', 'canEdit']);
  if (typeof r.canEdit !== 'boolean' || new URL(origin).origin !== origin) return fail();
  const data = Object.fromEntries(updateKeys.map(key => [key, r[key]]));
  return Object.freeze({...documentUpdate(data), origin, peer: ship(peer), host: ship(r.host), canEdit: r.canEdit});
}
export function documentHistory(value: unknown): DocumentHistory {
  const hasHost = !!value && typeof value === 'object' && Object.hasOwn(value, 'isHost');
  const r = object(value, ['noteId', 'versions', 'bytes', 'entries', ...(hasHost ? ['isHost'] : [])]);
  if (hasHost && typeof r.isHost !== 'boolean' || !Array.isArray(r.entries) || r.entries.length > 256) return fail();
  let bytes = 0, previous = -1;
  const entries = r.entries.map(value => {
    const row = object(value, ['revision', 'body', 'savedBy', 'savedAt']), revision = integer(row.revision), body = documentBody(row.body);
    bytes += Buffer.byteLength(body); if (bytes > 4_194_304 || revision <= previous) return fail(); previous = revision;
    return Object.freeze({revision, body, savedBy: ship(row.savedBy), savedAt: date(row.savedAt)});
  });
  return Object.freeze({noteId: documentNoteId(r.noteId), versions: integer(r.versions), bytes: integer(r.bytes),
    entries: Object.freeze(entries), ...(hasHost ? {isHost: r.isHost as boolean} : {})});
}
export function documentSaveResult(value: unknown): DocumentSaveResult {
  const r = object(value, ['noteId', 'requestId', 'result', 'revision', 'limit']);
  if (!['saved', 'no-change', 'conflict', 'too-large', 'denied', 'no-such-note'].includes(String(r.result))) return fail();
  const result = r.result as DocumentSaveResult['result'], revision = r.revision === null ? null : integer(r.revision), limit = r.limit === null ? null : integer(r.limit);
  if (['saved', 'no-change', 'conflict'].includes(result) !== (revision !== null) || (result === 'too-large') !== (limit !== null)) return fail();
  const requestId = integer(r.requestId); if (!requestId) return fail();
  return Object.freeze({noteId: documentNoteId(r.noteId), requestId, result, revision, limit});
}
export function documentRequestId(): number {return randomBytes(6).readUIntBE(0, 6) + 1;}
export function documentSaveIntent(snapshot: DocumentSnapshot, body: string, requestId = documentRequestId(), protocol?: 'receipted-v1'): DocumentSaveIntent {
  const {origin, peer, ...native} = snapshot;
  const checked = documentSnapshot(native, origin, peer);
  if (!checked.canEdit || !integer(requestId) || protocol !== undefined && protocol !== 'receipted-v1' || checked.revision === Number.MAX_SAFE_INTEGER) return fail();
  return Object.freeze({snapshot: checked, body: documentBody(body), requestId, ...(protocol ? {protocol} : {})});
}
export function documentReceiptSelector(intent: DocumentSaveIntent) {
  if (intent.protocol !== 'receipted-v1') return fail();
  return {host: intent.snapshot.host, requester: intent.snapshot.peer, noteId: intent.snapshot.noteId, requestId: intent.requestId,
    expected: intent.snapshot.revision, bodyHash: remoteSourceHash(intent.body)};
}
export function documentReceipt(value: unknown, intent: DocumentSaveIntent): DocumentReceipt {
  const r = object(value, ['schema', 'host', 'requester', 'noteId', 'requestId', 'expected', 'bodyHash', 'status', 'receipt']);
  const selector = documentReceiptSelector(intent);
  if (r.schema !== 'noltbook-document-receipt-v1' || Object.entries(selector).some(([key, value]) => r[key] !== value) ||
    !['recorded', 'pending', 'missing', 'refused', 'capacity'].includes(String(r.status))) return fail();
  if ((r.status === 'recorded') !== (r.receipt !== null)) return fail();
  if (r.receipt !== null) {
    const terminal = object(r.receipt, ['result', 'revision', 'limit', 'recordedAt']);
    const {recordedAt, ...outcome} = terminal;
    const result = documentSaveResult({...outcome, noteId: selector.noteId, requestId: selector.requestId});
    date(recordedAt);
    if (result.result === 'saved' && result.revision !== selector.expected + 1 || result.result === 'no-change' && result.revision !== selector.expected ||
      result.result === 'conflict' && result.revision === selector.expected || result.result === 'too-large' && result.limit !== 1048576) return fail();
    return Object.freeze({...r, receipt: Object.freeze({...outcome, recordedAt})}) as unknown as DocumentReceipt;
  }
  return Object.freeze(r) as unknown as DocumentReceipt;
}
export function documentCapability(value: unknown, peer: string): {capacity: number; retained: number} {
  const r = object(value, ['schema', 'ship', 'version', 'capacity', 'retained']);
  if (r.schema !== 'noltbook-document-receipts-capability-v1' || r.ship !== peer || r.version !== 1 || r.capacity !== 256 || integer(r.retained) > 256) return fail();
  return {capacity: 256, retained: r.retained as number};
}

export interface DocumentNote {readonly id: string; readonly name: string; readonly host: string}
export function documentNotes(value: unknown): readonly DocumentNote[] {
  const outer = object(value, ['notes']);
  if (!Array.isArray(outer.notes) || outer.notes.length > 4096) return fail();
  const seen = new Set<string>(), notes: DocumentNote[] = [];
  for (const value of outer.notes) {
    const row = object(value, ['id', 'name', 'type', 'creator', 'visibility', 'iconUrl', 'headline', 'userCount', 'lastPreview', 'app', 'active']);
    const id = documentNoteId(row.id); if (seen.has(id)) return fail(); seen.add(id);
    if (row.type !== 'document') continue;
    if (typeof row.name !== 'string' || Buffer.byteLength(row.name) > 4096) return fail();
    notes.push(Object.freeze({id, name: row.name, host: ship(row.creator)}));
  }
  return Object.freeze(notes);
}

/** Document bodies need a larger wire bound than the 512KiB project-source protocol. */
export function documentJSON(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > 8_388_608) return fail();
  const value: unknown = JSON.parse(text), stack: (Set<string> | null)[] = [];
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{') stack.push(new Set()); else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const keys = stack.at(-1), key = JSON.parse(token) as string;
      if (!keys || keys.has(key)) return fail(); keys.add(key);
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
