import {asRecord, isInteger, type JsonObject, type CodingSnapshot} from './protocol';
import {dateAtom} from './editing-activity';
import {remoteProjectViewTarget, remoteShip, remoteSourceHash} from './remote-project-view';
import {sameBasis, snapshotFrom, sourceBasis, type SourceBasis, type SourceSnapshot} from './source-store';
import type {BundleDraftRecord, DraftRecord, DraftStore} from './draft-store';
import {mergeDraft, type DraftMerge} from './draft-merge';

export interface InboxReceipt {
  readonly receiptHash: string; readonly peer: string; readonly receivedAt: string; readonly generation: string;
  readonly request: string; readonly path: string; readonly sourceHash: string; readonly parentRoot: string;
  readonly snapshotDigest: string; readonly desk: string; readonly revision: string; readonly originalHash: string;
}
export interface InboxDetail extends InboxReceipt {readonly source: string}
export interface ProjectInbox {readonly owner: string; readonly project: string; readonly receipts: readonly InboxReceipt[]}
export interface InboxHistorySelector {readonly revision: string; readonly after: string; readonly limit: number}
export interface InboxHistoryPage extends ProjectInbox {
  readonly desk: string; readonly revision: string; readonly commit: string; readonly examined: number;
  readonly next: string | null; readonly more: boolean;
  /** Archived multi-file suggestions on this page (v2 ships only); sources come from the detail read. */
  readonly bundles: readonly InboxBundleSummary[];
}
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
export function inboxHistorySelector(value: unknown = {revision: '0', after: 'start', limit: 8}): InboxHistorySelector {
  const row = exact(value, ['revision', 'after', 'limit']);
  if (!(row.revision === '0' || ud(row.revision)) || !isInteger(row.limit, 1, 8) ||
      (row.revision === '0' ? row.after !== 'start' : !ux(row.after))) invalid();
  return Object.freeze({revision: row.revision as string, after: row.after as string, limit: row.limit});
}
function historyCommit(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || !/^0v[1-9a-v][0-9a-v]{0,4}(?:\.[0-9a-v]{5})*$/.test(value)) return false;
  let n = 0n;
  for (const digit of value.slice(2).replaceAll('.', '')) n = n * 32n + BigInt(parseInt(digit, 32));
  return n > 0n && n < 1n << 256n;
}
function bundleRowValue(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, 'kind');
}
/** One bounded native history page; empty rows can still require Next. A v2 page also carries archived multi-file suggestions. */
export function projectInboxHistory(value: unknown, owner: string, project: string, selector: InboxHistorySelector = inboxHistorySelector()): InboxHistoryPage {
  const query = inboxHistorySelector(selector);
  const body = exact(value, ['schema', 'owner', 'project', 'permissionGranted', 'committed', 'desk', 'revision', 'commit', 'examined', 'next', 'more', 'receipts']);
  const v2 = body.schema === 'readymade-project-inbox-history-v2';
  if (!v2 && body.schema !== 'readymade-project-inbox-history-v1' || body.owner !== owner || body.project !== project || body.permissionGranted !== false || body.committed !== false ||
      typeof body.desk !== 'string' || !/^[a-z0-9-]{1,63}$/.test(body.desk) || body.desk === 'base' || !ud(body.revision) || !historyCommit(body.commit) ||
      query.revision !== '0' && body.revision !== query.revision || !isInteger(body.examined, 0, query.limit) || typeof body.more !== 'boolean' ||
      (body.more ? !ux(body.next) || body.next === query.after || body.examined === 0 : body.next !== null) ||
      !Array.isArray(body.receipts) || body.receipts.length > body.examined || Buffer.byteLength(JSON.stringify(body)) > 524288) invalid();
  const rows = body.receipts as unknown[], scalar = rows.filter(row => !v2 || !bundleRowValue(row));
  const receipts = projectInbox({schema: 'readymade-project-inbox-v1', owner, project, permissionGranted: false, committed: false, receipts: scalar}, owner, project).receipts;
  const bundles = rows.filter(row => v2 && bundleRowValue(row)).map(row => bundleRow(row, owner, false));
  const keys = new Set<string>();
  for (const row of [...receipts, ...bundles]) {
    const key = JSON.stringify([row.peer, row.generation, row.request]);
    if (keys.has(key) || keys.has(row.receiptHash)) invalid(); keys.add(key); keys.add(row.receiptHash);
  }
  return Object.freeze({owner, project, desk: body.desk, revision: body.revision, commit: body.commit, examined: body.examined,
    next: body.next as string | null, more: body.more, receipts, bundles: Object.freeze(bundles)});
}
/** One exact hot or archived receipt of either kind, sources included (v2 ships only). */
export function projectInboxDetail(value: unknown, owner: string, project: string, receipt: string): InboxDetail | InboxBundleDetail {
  remoteProjectViewTarget({owner, project, generation: '1'});
  if (!ux(receipt)) invalid();
  const body = exact(value, ['schema', 'owner', 'project', 'permissionGranted', 'committed', 'receipt']);
  if (body.schema !== 'readymade-project-inbox-detail-v2' || body.owner !== owner || body.project !== project || body.permissionGranted !== false ||
      body.committed !== false || Buffer.byteLength(JSON.stringify(body)) > 524288) invalid();
  if (!bundleRowValue(body.receipt))
    return projectInbox({schema: 'readymade-project-inbox-v1', owner, project, permissionGranted: false, committed: false, receipts: [body.receipt]},
      owner, project, receipt).receipts[0] as InboxDetail;
  const row = bundleRow(body.receipt, owner, true);
  if (row.receiptHash !== receipt) invalid();
  return row;
}
/** Everything a summary and its detail must agree on: same receipt, same files, same hashes. */
export function bundleSummaryKey(row: InboxBundleSummary): string {
  return JSON.stringify([row.receiptHash, row.peer, row.receivedAt, row.generation, row.request, row.parentRoot, row.snapshotDigest, row.desk, row.revision,
    row.files.map(f => [f.path, f.originalHash, f.sourceHash])]);
}
/** Urbit @uv is grouped base32; compare the atom, never compare differently rendered auras. */
export function inboxBasisMatches(receipt: Pick<InboxReceipt, 'desk' | 'revision' | 'parentRoot'>, value: SourceBasis, owner: string): boolean {
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

export interface InboxBundleFileSummary {readonly path: string; readonly originalHash: string; readonly sourceHash: string}
export interface InboxBundleFile extends InboxBundleFileSummary {readonly source: string}
export interface InboxBundleSummary extends Omit<InboxReceipt, 'path' | 'sourceHash' | 'originalHash'> {
  readonly kind: 'bundle'; readonly files: readonly InboxBundleFileSummary[];
}
export interface InboxBundleDetail extends InboxBundleSummary {readonly files: readonly InboxBundleFile[]}
function bundleRow(value: unknown, owner: string, sources: true): InboxBundleDetail;
function bundleRow(value: unknown, owner: string, sources: false): InboxBundleSummary;
function bundleRow(value: unknown, owner: string, sources: boolean): InboxBundleSummary | InboxBundleDetail {
  const row = exact(value, ['kind', 'receiptHash', 'peer', 'receivedAt', 'generation', 'request', 'parentRoot', 'snapshotDigest', 'desk', 'revision', 'files']);
  if (row.kind !== 'bundle' || !ux(row.receiptHash) || !remoteShip(row.peer) || row.peer === owner || !ud(row.generation) ||
      !ux(row.request, false, 128) || !ux(row.parentRoot) || !ux(row.snapshotDigest, true) || !ud(row.revision) ||
      typeof row.desk !== 'string' || !/^[a-z0-9-]{1,63}$/.test(row.desk) || !Array.isArray(row.files) || !row.files.length || row.files.length > 8) invalid();
  dateAtom(row.receivedAt);
  const paths = new Set<string>(); let bytes = 0;
  const files = row.files.map(value => {
    const f = exact(value, sources ? ['path', 'originalHash', 'sourceHash', 'source'] : ['path', 'originalHash', 'sourceHash']);
    if (typeof f.path !== 'string' || !/^\/(?:app|lib|ted)\/(?:[a-z0-9-]{1,63}\/){1,6}hoon$/.test(f.path) || paths.has(f.path) ||
        !ux(f.originalHash, true) || !ux(f.sourceHash, true) || sources && (typeof f.source !== 'string' || /[^\t\n\r\x20-\x7e]/.test(f.source) ||
        Buffer.byteLength(f.source) > 32768 || remoteSourceHash(f.source) !== f.sourceHash)) invalid();
    paths.add(f.path); if (sources) bytes += Buffer.byteLength(f.source as string);
    return Object.freeze({...f}) as unknown as InboxBundleFile;
  });
  if (bytes > 65536) invalid();
  return Object.freeze({...row, files: Object.freeze(files)}) as unknown as InboxBundleDetail;
}
/** Prepared native hot/detail row, sources included. No cold archive head or implied permission. */
export function inboxBundleDetail(value: unknown, owner: string, project: string): InboxBundleDetail {
  remoteProjectViewTarget({owner, project, generation: '1'});
  return bundleRow(value, owner, true);
}
/** Validate the entire immutable source closure before any local draft write. */
export function inboxBundleSources(detail: InboxBundleDetail, values: readonly SourceSnapshot[], owner: string, project: string): SourceSnapshot[] {
  const row = inboxBundleDetail(detail, owner, project);
  if (values.length !== row.files.length) invalid();
  const sources = values.map(snapshotFrom), first = sources[0], paths = new Set<string>();
  if (!first) invalid();
  let originalBytes = 0;
  for (const source of sources) {
    const member = row.files.find(file => file.path === source.path);
    if (!member || paths.has(source.path) || source.ship !== owner || source.origin !== first.origin || source.session !== first.session ||
        !sameBasis(source.source, first.source) || source.source.id !== first.source.id || source.mark !== 'hoon' ||
        !inboxBasisMatches(row, source.source, owner) || Buffer.byteLength(source.text) > 32768 || remoteSourceHash(source.text) !== member.originalHash) invalid();
    originalBytes += Buffer.byteLength(source.text);
    paths.add(source.path);
  }
  if (originalBytes > 65536) invalid();
  // Receipt ordering is native map order, not assumed lexical order.
  return row.files.map(file => sources.find(source => source.path === file.path)!);
}
export function importInboxBundle(store: DraftStore, detail: InboxBundleDetail, values: readonly SourceSnapshot[], context: InboxImportContext): BundleDraftRecord {
  const row = inboxBundleDetail(detail, context.owner, context.project);
  const sources = inboxBundleSources(row, values, context.owner, context.project);
  const sessions = context.state.sessions.filter(session => session.id === context.session);
  if (context.state.owner !== context.owner || context.state.session !== context.session || sessions.length !== 1 || sessions[0].project !== context.project ||
      !sameBasis(context.basis, sessions[0].source) || sources.some(source => source.origin !== context.origin || source.session !== context.session ||
        !sameBasis(source.source, context.basis) || source.source.id !== context.basis.id)) throw new Error('Bundle owner session or source changed. No draft was changed.');
  return store.createBundle(context.owner, context.project, row, sources);
}
/** Per file: did the owner's current source move since the collaborator's original? Both texts are kept by the caller. */
export interface BundleDrift {readonly path: string; readonly originalHash: string; readonly suggestedHash: string; readonly currentHash: string; readonly changed: boolean}
export function bundleDrift(detail: InboxBundleSummary, currents: readonly SourceSnapshot[]): readonly BundleDrift[] {
  if (currents.length !== detail.files.length) invalid();
  const seen = new Set<string>();
  return Object.freeze(detail.files.map(file => {
    const current = currents.filter(c => c.path === file.path);
    if (current.length !== 1 || seen.has(file.path)) invalid();
    seen.add(file.path);
    const currentHash = remoteSourceHash(current[0].text);
    return Object.freeze({path: file.path, originalHash: file.originalHash, suggestedHash: file.sourceHash, currentHash, changed: currentHash !== file.originalHash});
  }));
}
export interface InboxBundlesPage {
  readonly owner: string; readonly project: string; readonly total: number; readonly more: boolean;
  readonly bundles: readonly InboxBundleDetail[];
}
/** Owner-only hot list of whole multi-file suggestions, newest first. Historical: never permission or acceptance. */
export function projectInboxBundles(value: unknown, owner: string, project: string): InboxBundlesPage {
  remoteProjectViewTarget({owner, project, generation: '1'});
  const body = exact(value, ['schema', 'owner', 'project', 'permissionGranted', 'committed', 'total', 'more', 'bundles']);
  if (body.schema !== 'readymade-project-inbox-bundles-v1' || body.owner !== owner || body.project !== project || body.permissionGranted !== false ||
      body.committed !== false || typeof body.more !== 'boolean' || !Array.isArray(body.bundles) || body.bundles.length > 4 ||
      typeof body.total !== 'string' || !/^(?:0|[1-9][0-9]{0,2}(?:\.[0-9]{3})*)$/.test(body.total)) invalid();
  const total = Number(body.total.replaceAll('.', ''));
  if (!Number.isSafeInteger(total) || total < body.bundles.length || body.more !== total > body.bundles.length) invalid();
  const bundles = body.bundles.map(row => inboxBundleDetail(row, owner, project)), seen = new Set<string>();
  for (const row of bundles) {
    const key = JSON.stringify([row.peer, row.generation, row.request]);
    if (seen.has(row.receiptHash) || seen.has(key)) invalid();
    seen.add(row.receiptHash); seen.add(key);
  }
  return Object.freeze({owner, project, total, more: body.more, bundles: Object.freeze(bundles)});
}
