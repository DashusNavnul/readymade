import {EyreNotesFeed, type NotesClient} from './call-notifications';
import {documentJSON, documentNoteId, documentNotes, documentSnapshot, documentHistory, documentUpdate, documentSaveResult, documentSaveIntent,
  documentCapability, documentReceipt, documentReceiptSelector,
  type DocumentReceipt, type DocumentSnapshot, type DocumentUpdate, type DocumentHistory, type DocumentSaveIntent, type DocumentSaveResult, type DocumentNote} from './noltbook-documents';

export class DocumentOutcomeUnknown extends Error {constructor() {super('Save outcome unknown. Keep the draft and observe; do not resend.');}}
class FailedDocumentScry extends Error {}
class MissingDocumentRead extends Error {constructor() {super('Native document read unavailable. The document may be missing or no longer shared with you.');}}
interface Pending {intent: DocumentSaveIntent; reply?: DocumentSaveResult; observed?: DocumentUpdate;
  finish: (reply?: DocumentSaveResult) => void}
/** A bounded editor subscription, not a source authority or background retry service. */
export class NoltbookDocumentClient {
  private readonly feed: EyreNotesFeed;
  private readonly peer: string;
  private readonly pending = new Map<number, Pending>();
  private readonly snapshots = new Map<string, DocumentSnapshot>();
  private readonly seenRequests = new Set<number>();
  private readonly opening = new Set<string>();
  private readonly pulls = new Map<string, (arrived: boolean) => void>();
  private readonly receipts = new Map<number, DocumentReceipt>();
  private receiptSupport = false;
  private started = false;
  private closed = false;
  constructor(private readonly client: NotesClient, private readonly onUpdate: (update: DocumentUpdate) => void,
    private readonly onFailure: () => void) {
    this.peer = this.headers().Cookie.split('=')[0].slice('urbauth-'.length);
    this.feed = new EyreNotesFeed(client, value => this.update(value), () => this.fail());
  }
  private headers(): {Cookie: string; Origin: string} {
    const origin = new URL(this.client.origin), cookies = this.client.browserCookies(this.client.origin);
    if (origin.origin !== this.client.origin || !(origin.protocol === 'https:' || origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) ||
      cookies.length !== 1 || !/^urbauth-~[a-z-]{3,128}$/.test(cookies[0].name) || !/^[^\s;,]{1,4096}$/.test(cookies[0].value) ||
      this.peer && cookies[0].name !== 'urbauth-' + this.peer) throw new Error('Document identity changed');
    return {Cookie: cookies[0].name + '=' + cookies[0].value, Origin: this.client.origin};
  }
  async start(): Promise<void> {if (this.closed || this.started) throw new Error('Document feed already used'); this.started = true; await this.feed.start();}
  private async get(route: string): Promise<unknown> {
    if (this.closed) throw new Error('Document connection closed');
    const response = await fetch(this.client.origin + '/~/scry/noltbook/' + route + '.json', {
      headers: {...this.headers(), Accept: 'application/json'}, redirect: 'manual', signal: AbortSignal.timeout(15000)});
    if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0] !== 'application/json' || !response.body) {
      await response.body?.cancel(); if (response.status === 404) throw new MissingDocumentRead();
      if (response.status === 500) throw new FailedDocumentScry('Native document read unavailable');
      throw new Error('Native document read unavailable');
    }
    const parts: Uint8Array[] = []; let size = 0;
    for await (const bytes of response.body) {size += bytes.length; if (size > 8_388_608) throw new Error('Document response too large'); parts.push(bytes);}
    this.headers(); if (this.closed) throw new Error('Document connection closed');
    return documentJSON(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(parts)));
  }
  async notes(): Promise<readonly DocumentNote[]> {return documentNotes(await this.get('api/notes'));}
  async capabilities(): Promise<{capacity: number; retained: number} | undefined> {
    try {const capability = documentCapability(await this.get('api/document-receipts'), this.peer); this.receiptSupport = true; return capability;}
    catch (error) {this.receiptSupport = false; if (error instanceof MissingDocumentRead) return undefined; throw error;}
  }
  receipt(intent: DocumentSaveIntent): DocumentReceipt | undefined {
    const value = this.receipts.get(intent.requestId); return value && documentReceipt(value, intent);
  }
  private receiveReceipt(value: unknown, intent: DocumentSaveIntent): DocumentSaveResult | undefined {
    const receipt = documentReceipt(value, intent);
    if (!this.receipts.has(intent.requestId) && this.receipts.size >= 256) throw new Error('Document receipt capacity reached.');
    const prior = this.receipts.get(intent.requestId);
    if (prior?.status === 'recorded' && (receipt.status !== 'recorded' ||
      (['result', 'revision', 'limit', 'recordedAt'] as const).some(key => prior.receipt?.[key] !== receipt.receipt?.[key]))) throw new Error('Retained document receipt changed');
    this.receipts.set(intent.requestId, receipt);
    if (receipt.status !== 'recorded' || !receipt.receipt) return;
    const {recordedAt: _at, ...terminal} = receipt.receipt; void _at;
    return documentSaveResult({...terminal, noteId: receipt.noteId, requestId: receipt.requestId});
  }
  async read(noteId: string): Promise<DocumentSnapshot> {
    const snapshot = documentSnapshot(await this.get('api/notes/' + documentNoteId(noteId) + '/document'), this.client.origin, this.peer);
    if (snapshot.noteId !== noteId) throw new Error('Document identity mismatch');
    if (!this.snapshots.has(noteId) && this.snapshots.size >= 64) throw new Error('Too many open documents');
    const old = this.snapshots.get(noteId);
    if (old && (old.host !== snapshot.host || old.revision > snapshot.revision || old.revision === snapshot.revision && old.body !== snapshot.body)) throw new Error('Document revision moved backwards');
    this.snapshots.set(noteId, snapshot); this.admit(snapshot); return snapshot;
  }
  /** Explicit Open may hydrate an invited remote note once; ordinary reads never poke. */
  async open(noteId: string, expectedHost: string, active: () => boolean = () => true): Promise<DocumentSnapshot> {
    documentNoteId(noteId); const origin = this.client.origin;
    const current = (): void => {this.headers(); if (!this.started || this.closed || this.client.origin !== origin || !active()) throw new Error('Document connection changed.');};
    current();
    if (this.opening.has(noteId) || this.opening.size >= 8) throw new Error('Document opening already pending.');
    this.opening.add(noteId);
    try {
      const notes = await this.notes(); current();
      const note = notes.find(n => n.id === noteId);
      if (!note || note.host !== expectedHost) throw new Error('Document is not in the current shared catalog.');
      const read = async (): Promise<DocumentSnapshot> => {const snapshot = await this.read(noteId); current(); if (snapshot.host !== expectedHost) throw new Error('Document host changed.'); return snapshot;};
      try {return await read();}
      catch (error) {if (!(error instanceof MissingDocumentRead || error instanceof FailedDocumentScry) || note.host === this.peer) throw error;}
      current();
      const waiting = new Promise<void>((resolve, reject) => {
        const finish = (arrived: boolean): void => {clearTimeout(timer); this.pulls.delete(noteId); if (arrived) resolve(); else reject(new Error('Shared document did not arrive. Open it again explicitly; no save was sent.'));};
        const timer = setTimeout(() => finish(false), 30000); this.pulls.set(noteId, finish);
      });
      void waiting.catch(() => undefined);
      try {current(); await this.feed.pokeDocument({action: 'request-document', data: {noteId}}, () => {current(); if (!this.pulls.has(noteId)) throw new Error('Document pull is no longer pending.');});}
      catch {this.pulls.get(noteId)?.(false);}
      await waiting; current(); return await read();
    } finally {this.pulls.get(noteId)?.(false); this.opening.delete(noteId);}
  }
  async history(noteId: string): Promise<DocumentHistory> {
    const history = documentHistory(await this.get('api/notes/' + documentNoteId(noteId) + '/document/history'));
    if (history.noteId !== noteId) throw new Error('Document history mismatch'); return history;
  }
  private context(intent: DocumentSaveIntent, receiptOnly = false): void {
    this.headers(); if (!this.started || this.closed || intent.snapshot.origin !== this.client.origin || intent.snapshot.peer !== this.peer) throw new Error('Document connection changed');
    const admitted = this.snapshots.get(intent.snapshot.noteId);
    if (!receiptOnly && (!admitted || admitted.host !== intent.snapshot.host)) throw new Error('Read this exact hosted document before saving or observing');
  }
  private wait(intent: DocumentSaveIntent): Promise<DocumentSaveResult> {
    if (this.pending.size >= 8 || this.pending.has(intent.requestId)) throw new Error('Document observation already pending');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(), 30000);
      const finish = (reply?: DocumentSaveResult): void => {clearTimeout(timer); this.pending.delete(intent.requestId); if (reply) resolve(reply); else reject(new DocumentOutcomeUnknown());};
      this.pending.set(intent.requestId, {intent, finish});
    });
  }
  async save(value: DocumentSaveIntent, beforeDispatch: () => Promise<void>): Promise<DocumentSaveResult> {
    const intent = documentSaveIntent(value.snapshot, value.body, value.requestId, value.protocol); this.context(intent);
    if (intent.protocol && !this.receiptSupport) throw new Error('Discover native receipt support before sending.');
    if (this.seenRequests.has(intent.requestId) || this.seenRequests.size >= 256) throw new Error('Retained document request cannot be resent');
    this.seenRequests.add(intent.requestId);
    await beforeDispatch(); this.context(intent);
    const waiting = this.wait(intent); void waiting.catch(() => undefined);
    // The native no-change result has no update fact; the exact prior snapshot is its observation.
    this.admit(intent.snapshot);
    const data = {noteId: intent.snapshot.noteId, body: intent.body, expected: intent.snapshot.revision, requestId: intent.requestId};
    try {await this.feed.pokeDocument(intent.protocol ? {action: 'save-document-receipted', data: {...data, host: intent.snapshot.host}} : {action: 'save-document', data});}
    catch {this.pending.get(intent.requestId)?.finish();}
    return waiting;
  }
  /** Observe the exact original request; a pending durable receipt permits a read-only query, never another save. */
  async check(value: DocumentSaveIntent): Promise<DocumentSaveResult> {
    const intent = documentSaveIntent(value.snapshot, value.body, value.requestId, value.protocol); this.context(intent, !!intent.protocol);
    if (intent.protocol) {
      const selector = documentReceiptSelector(intent), request = String(intent.requestId).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      let retained: unknown;
      try {retained = await this.get(`api/document-receipts/${selector.host}/${selector.noteId}/${request}`);}
      catch (error) {if (error instanceof MissingDocumentRead) throw new DocumentOutcomeUnknown(); throw error;}
      const result = this.receiveReceipt(retained, intent); if (result) return result;
      if (this.receipts.get(intent.requestId)?.status !== 'pending') throw new DocumentOutcomeUnknown();
      const waiting = this.wait(intent); void waiting.catch(() => undefined);
      try {await this.feed.pokeDocument({action: 'request-document-save-receipt', data: selector});}
      catch {this.pending.get(intent.requestId)?.finish();}
      return waiting;
    }
    const waiting = this.wait(intent); this.admit(this.snapshots.get(intent.snapshot.noteId)!); return waiting;
  }
  private admit(update: DocumentUpdate): void {
    for (const pending of this.pending.values()) {
      const {intent} = pending;
      if (update.noteId === intent.snapshot.noteId && update.body === intent.body &&
        (update.revision === intent.snapshot.revision && intent.body === intent.snapshot.body || update.revision === intent.snapshot.revision + 1 && update.updatedBy === this.peer)) pending.observed = update;
      this.settle(pending);
    }
  }
  private settle(pending: Pending): void {
    const reply = pending.reply; if (!reply) return;
    if (!['saved', 'no-change'].includes(reply.result) || pending.observed?.revision === reply.revision) pending.finish(reply);
  }
  private update(value: unknown): void {
    if (this.closed || !value || typeof value !== 'object') return;
    this.headers(); const row = value as Record<string, unknown>;
    if (Object.hasOwn(row, 'document-save-receipt')) {
      const raw = row['document-save-receipt'] as Record<string, unknown>, pending = raw && this.pending.get(raw.requestId as number);
      if (pending?.intent.protocol) {
        const result = this.receiveReceipt(raw, pending.intent);
        if (result) pending.finish(result);
        else if (this.receipts.get(pending.intent.requestId)?.status !== 'pending') pending.finish();
      }
    }
    if (Object.hasOwn(row, 'document-save-result')) {
      const raw = row['document-save-result'] as Record<string, unknown>;
      // Other clients and uncorrelated native operations share /notes.
      if (!raw || !this.pending.has(raw.requestId as number)) return;
      const reply = documentSaveResult(raw), pending = this.pending.get(reply.requestId)!;
      if (pending.intent.protocol) return;
      if (reply.noteId !== pending.intent.snapshot.noteId) throw new Error('Document request correlation mismatch');
      if (reply.result === 'saved' && reply.revision !== pending.intent.snapshot.revision + 1 || reply.result === 'no-change' && reply.revision !== pending.intent.snapshot.revision) throw new Error('Invalid saved revision');
      pending.reply = reply; this.settle(pending);
    }
    if (Object.hasOwn(row, 'document-updated')) {
      const update = documentUpdate(row['document-updated']), old = this.snapshots.get(update.noteId);
      this.pulls.get(update.noteId)?.(true);
      if (!old) return;
      if (old.revision === update.revision && old.body !== update.body) throw new Error('Conflicting native revision');
      this.admit(update);
      if (update.revision <= old.revision) return;
      this.snapshots.set(update.noteId, Object.freeze({...old, ...update})); this.onUpdate(update);
    }
  }
  private fail(): void {if (this.closed) return; void this.close(); this.onFailure();}
  async close(): Promise<void> {this.closed = true; for (const finish of this.pulls.values()) finish(false); for (const p of this.pending.values()) p.finish(); await this.feed.close();}
}
