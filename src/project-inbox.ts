import {asRecord, type JsonObject, type CodingSnapshot} from './protocol';
import {dateAtom} from './editing-activity';
import {remoteProjectViewTarget, remoteShip, remoteSourceHash} from './remote-project-view';
import {sameBasis, snapshotFrom, sourceBasis, type SourceBasis, type SourceSnapshot} from './source-store';
import type {DraftRecord, DraftStore} from './draft-store';
import {mergeDraft, type DraftMerge} from './draft-merge';

export interface InboxReceipt {
  readonly receiptHash: string; readonly peer: string; readonly receivedAt: string; readonly generation: string;
  readonly request: string; readonly path: string; readonly sourceHash: string; readonly parentRoot: string;
  readonly snapshotDigest: string; readonly desk: string; readonly revision: string; readonly originalHash: string;
}
export interface InboxDetail extends InboxReceipt {readonly source: string}
export interface ProjectInbox {readonly owner: string; readonly project: string; readonly receipts: readonly InboxReceipt[]}
function invalid(): never {throw new Error('Invalid or uncorrelated owner inbox receipt.');}
function exact(value: unknown, keys: readonly string[]): JsonObject {
  const row = asRecord(value);
  if (Object.getPrototypeOf(row) !== Object.prototype || Object.keys(row).length !== keys.length || !keys.every(key => Object.hasOwn(row, key))) invalid();
  return row;
}
function ux(value: unknown, zero = false, bits = 256): value is string {
  if (typeof value !== 'string' || value.length > 82 || !/^0x(?:0|[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*)$/.test(value)) return false;
  const n = BigInt(value.replaceAll('.', '')); return (zero || n > 0n) && n < 1n << BigInt(bits);
}
function ud(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 26 && /^[1-9][0-9]{0,2}(?:\.[0-9]{3})*$/.test(value) && BigInt(value.replaceAll('.', '')) < 1n << 64n;
}
const fields = ['receiptHash', 'peer', 'receivedAt', 'generation', 'request', 'path', 'sourceHash', 'parentRoot', 'snapshotDigest', 'desk', 'revision', 'originalHash'];
export function projectInbox(value: unknown, owner: string, project: string, receipt?: string): ProjectInbox {
  remoteProjectViewTarget({owner, project, generation: '1'});
  if (receipt !== undefined && !ux(receipt)) invalid();
  const body = exact(value, ['schema', 'owner', 'project', 'permissionGranted', 'committed', 'receipts']);
  if (body.schema !== 'readymade-project-inbox-v1' || body.owner !== owner || body.project !== project || body.permissionGranted !== false || body.committed !== false ||
      !Array.isArray(body.receipts) || body.receipts.length > 64 || receipt && body.receipts.length !== 1 || Buffer.byteLength(JSON.stringify(body)) > 524288) invalid();
  const seen = new Set<string>();
  const receipts = body.receipts.map(value => {
    const r = exact(value, receipt ? [...fields, 'source'] : fields);
    if (!ux(r.receiptHash) || seen.has(r.receiptHash) || receipt && r.receiptHash !== receipt || !remoteShip(r.peer) || r.peer === owner ||
        !ud(r.generation) || !ux(r.request, false, 128) || !ux(r.sourceHash, true) || !ux(r.parentRoot) || !ux(r.snapshotDigest, true) || !ux(r.originalHash, true) ||
        !ud(r.revision) || typeof r.desk !== 'string' || !/^[a-z0-9-]{1,63}$/.test(r.desk) || typeof r.path !== 'string' || !/^\/(?:app|lib|ted)\/(?:[a-z0-9-]{1,63}\/){1,6}hoon$/.test(r.path)) invalid();
    dateAtom(r.receivedAt); seen.add(r.receiptHash);
    if (receipt && (typeof r.source !== 'string' || /[^\t\n\r\x20-\x7e]/.test(r.source) || Buffer.byteLength(r.source) > 32768 || remoteSourceHash(r.source) !== r.sourceHash)) invalid();
    return Object.freeze({...r}) as unknown as InboxReceipt;
  });
  return Object.freeze({owner, project, receipts: Object.freeze(receipts)});
}
/** Urbit @uv is grouped base32; compare the atom, never compare differently rendered auras. */
export function inboxBasisMatches(receipt: InboxReceipt, value: SourceBasis, owner: string): boolean {
  const basis = sourceBasis(value);
  if (!/^0v(?:0|[1-9a-v][0-9a-v]{0,4}(?:\.[0-9a-v]{5})*)$/.test(basis.root)) return false;
  let root = 0n;
  for (const digit of basis.root.slice(2).replaceAll('.', '')) root = root * 32n + BigInt(parseInt(digit, 32));
  return basis.owner === owner && basis.desk === receipt.desk && BigInt(basis.number) === BigInt(receipt.revision.replaceAll('.', '')) && root === BigInt(receipt.parentRoot.replaceAll('.', ''));
}
export interface InboxImportContext {origin: string; owner: string; project: string; session: string; basis: SourceBasis; state: Pick<CodingSnapshot, 'owner' | 'session' | 'sessions'>}
export class ExistingInboxDraftError extends Error {constructor(readonly draft: DraftRecord) {super('An edited or submitted draft already exists. It was opened without overwriting it.');}}
function validatedSuggestion(detail: InboxDetail, value: SourceSnapshot, context: InboxImportContext): InboxDetail {
  const validated = projectInbox({schema: 'readymade-project-inbox-v1', owner: context.owner, project: context.project, permissionGranted: false,
    committed: false, receipts: [detail]}, context.owner, context.project, detail.receiptHash).receipts[0] as InboxDetail;
  const source = snapshotFrom(value), sessions = context.state.sessions.filter(row => row.id === context.session);
  if (context.state.owner !== context.owner || context.state.session !== context.session || sessions.length !== 1 ||
      sessions[0].project !== context.project || !sameBasis(context.basis, sessions[0].source))
    throw new Error('Owner session does not belong to this project and source. No draft was changed.');
  if (source.origin !== context.origin || source.ship !== context.owner || source.session !== context.session || source.path !== validated.path ||
      !sameBasis(source.source, context.basis) || !inboxBasisMatches(validated, source.source, context.owner) || remoteSourceHash(source.text) !== validated.originalHash)
    throw new Error('Suggestion source is stale or does not match this owner session. No draft was changed.');
  return validated;
}
/** A pure preview: the native receipt, original, journal and editor remain untouched. */
export function mergeInboxSuggestion(draft: DraftRecord, localText: string, detail: InboxDetail, source: SourceSnapshot, context: InboxImportContext): DraftMerge {
  const validated = validatedSuggestion(detail, source, context);
  if (draft.pending || draft.snapshot.uri !== source.uri || draft.snapshot.text !== source.text)
    throw new Error('Draft is submitted or no longer matches the original. No draft was changed.');
  return mergeDraft(source.text, localText, validated.source);
}
export function importInboxSuggestion(store: DraftStore, detail: InboxDetail, value: SourceSnapshot, context: InboxImportContext): DraftRecord {
  const validated = validatedSuggestion(detail, value, context), source = snapshotFrom(value);
  const existing = store.list().find(row => row.snapshot.uri === source.uri);
  if (existing && (existing.pending || existing.text !== source.text)) throw new ExistingInboxDraftError(existing);
  const draft = store.create(source); return store.save(draft.id, validated.source);
}
