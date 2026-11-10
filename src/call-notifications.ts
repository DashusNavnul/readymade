import {randomBytes} from 'node:crypto';
import {documentJSON} from './noltbook-documents';
import type {BrowserSessionCookie} from './ship-client';

export interface CallNotice { noteId: string; callId: string; participants: readonly string[] }
export interface NotesClient { origin: string; browserCookies(origin: string): readonly BrowserSessionCookie[] }
const object = (x: unknown): Record<string, unknown> | undefined =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : undefined;
const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(x);

/** Presentation state only. Native call snapshots, not chat messages, determine calls. */
export class CallNotices {
  private readonly generations = new Map<string, number>();
  private readonly active = new Map<string, string>();
  constructor(private readonly self: string, private readonly notify: (notice: CallNotice) => void) {}
  update(value: unknown): void {
    const update = object(value); if (!update) return;
    if (Array.isArray(update['call-list'])) {
      if (update['call-list'].length > 4096) throw new Error('Too many calls');
      const present = new Set<string>();
      for (const row of update['call-list']) {
        const snap = object(row); if (text(snap?.noteId)) present.add(snap.noteId);
        this.snapshot(row, true);
      }
      for (const key of this.active.keys()) if (!present.has(key)) this.active.delete(key);
    } else if (update['call-snap']) this.snapshot(update['call-snap'], false);
  }
  private snapshot(value: unknown, replacement: boolean): void {
    const snap = object(value);
    if (!snap || !text(snap.noteId) || !Number.isSafeInteger(snap.gen) || (snap.gen as number) < 0) return;
    const note = snap.noteId, gen = snap.gen as number;
    if (!replacement && gen <= (this.generations.get(note) ?? -1)) return;
    if (!this.generations.has(note) && this.generations.size >= 4096) throw new Error('Too many call revisions');
    this.generations.set(note, gen);
    const call = object(snap.call);
    if (!call || call.status !== 'active' || !Array.isArray(call.participants) || !call.participants.length) {
      this.active.delete(note); return;
    }
    if (!text(call.callId) || call.participants.length > 256 ||
        !call.participants.every(p => typeof p === 'string' && /^~[a-z-]{3,128}$/.test(p))) return;
    const prior = this.active.get(note); this.active.set(note, call.callId);
    if (prior === call.callId || call.participants.includes(this.self)) return;
    this.notify(Object.freeze({noteId: note, callId: call.callId, participants: Object.freeze([...call.participants])}));
  }
  current(notice: CallNotice): boolean { return this.active.get(notice.noteId) === notice.callId; }
}

/** One owned Eyre notes subscription, with no polling or automatic write retry.
 * Authentication remains on Urbit. Closing the editor releases this UI subscription. */
export class EyreNotesFeed {
  private readonly channel = '/~/channel/readymade-calls-' + randomBytes(16).toString('hex');
  private readonly abort = new AbortController();
  private sequence = 1;
  private started = false;
  private closed = false;
  private latest = 0;
  private acknowledged = 0;
  private acknowledging = false;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private writing: Promise<void> = Promise.resolve();
  private readonly identity: string;
  constructor(private readonly client: NotesClient, private readonly update: (value: unknown) => void,
    private readonly failed: () => void) {
    const origin = new URL(client.origin);
    if (origin.origin !== client.origin || origin.username || origin.password ||
        !(origin.protocol === 'https:' || origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('Invalid call origin');
    const names = client.browserCookies(client.origin).map(c => c.name);
    if (names.length !== 1 || !/^urbauth-~[a-z-]{3,128}$/.test(names[0])) throw new Error('Call identity unavailable');
    this.identity = names[0];
  }

  private headers(): Record<string, string> {
    const cookies = this.client.browserCookies(this.client.origin);
    if (cookies.length !== 1 || cookies[0].name !== this.identity || cookies.some(c => !/^urbauth-~[a-z-]{3,128}$/.test(c.name) || !/^[^\s;,]{1,4096}$/.test(c.value))) throw new Error('Call authentication unavailable');
    return {Cookie: cookies.map(c => c.name + '=' + c.value).join('; '), Origin: this.client.origin};
  }
  private put(actions: object[], beforeDispatch?: () => void): Promise<void> {
    const write = this.writing.then(async () => {
      beforeDispatch?.();
      const response = await fetch(this.client.origin + this.channel, {method: 'PUT', redirect: 'manual',
        headers: {...this.headers(), 'Content-Type': 'application/json'}, body: JSON.stringify(actions), signal: AbortSignal.timeout(10000)});
      await response.body?.cancel();
      if (response.status !== 204) throw new Error('Call subscription refused');
    });
    // Delete must not overtake an acknowledgement on a different HTTP connection.
    // A failed write is never replayed; cleanup remains a separate final operation.
    this.writing = write.catch(() => undefined);
    return write;
  }
  start(): Promise<void> {
    if (this.started || this.closed) return Promise.reject(new Error('Call subscription already used'));
    this.started = true;
    this.opening = this.put([{id: 1, action: 'subscribe', ship: this.client.browserCookies(this.client.origin)[0].name.slice('urbauth-~'.length), app: 'noltbook', path: '/notes'}]);
    return this.opening.then(() => {
      if (!this.closed) void this.read().catch(() => this.fail());
    }).catch(error => { this.fail(); throw error; });
  }
  /** A caller must retain its intent first. PUT acknowledgement is never app completion. */
  async pokeDocument(action:
    {action: 'request-document'; data: {noteId: string}} |
    {action: 'save-document'; data: {noteId: string; body: string; expected: number; requestId: number}} |
    {action: 'save-document-receipted'; data: {host: string; noteId: string; body: string; expected: number; requestId: number}} |
    {action: 'request-document-save-receipt'; data: {host: string; requester: string; noteId: string; expected: number; requestId: number; bodyHash: string}}, beforeDispatch?: () => void): Promise<void> {
    if (!this.started || this.closed) throw new Error('Notes subscription unavailable');
    await this.opening;
    if (this.closed) throw new Error('Notes subscription closed');
    await this.put([{id: ++this.sequence, action: 'poke', ship: this.identity.slice('urbauth-~'.length),
      app: 'noltbook', mark: 'noltbook-action', json: action}], () => {if (this.closed) throw new Error('Notes subscription closed'); beforeDispatch?.();});
  }
  private async read(): Promise<void> {
    const response = await fetch(this.client.origin + this.channel, {headers: {...this.headers(), Accept: 'text/event-stream'},
      redirect: 'manual', signal: this.abort.signal});
    if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
      await response.body?.cancel(); throw new Error('Call stream refused');
    }
    const decoder = new TextDecoder('utf-8', {fatal: true}); let buffer = '';
    for await (const bytes of response.body) {
      if (this.closed) return;
      buffer += decoder.decode(bytes, {stream: true});
      if (buffer.length > 8 * 1024 * 1024) throw new Error('Call event too large');
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
        const data: string[] = []; let id: string | undefined;
        for (const line of event.split(/\r?\n/)) {
          if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          if (line.startsWith('id:')) id = line.slice(3).trim();
        }
        if (!data.length) continue;
        if (!id || !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('Invalid call event');
        const number = Number(id); if (number <= this.latest) continue;
        const row = object(documentJSON(data.join('\n'))); if (!row) throw new Error('Invalid call event');
        this.latest = number;
        if (row.id === 1) {
          if (row.response === 'quit' || row.err) throw new Error('Call subscription ended');
          if (row.response === 'diff') this.update(row.json);
        }
      }
      void this.acknowledge();
    }
    if (!this.closed) throw new Error('Call stream ended');
  }
  private async acknowledge(): Promise<void> {
    if (this.acknowledging || this.closed) return;
    this.acknowledging = true;
    try {
      while (!this.closed && this.latest > this.acknowledged) {
        const event = this.latest;
        await this.put([{id: ++this.sequence, action: 'ack', 'event-id': event}]); this.acknowledged = event;
      }
    } catch { this.fail(); }
    finally { this.acknowledging = false; }
  }
  private fail(): void {
    if (this.closed) return;
    void this.close(); this.failed();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.abort.abort();
    this.closing = (async () => {
      await this.opening?.catch(() => undefined);
      if (this.started) await this.put([{id: ++this.sequence, action: 'delete'}]);
    })().catch(() => { /* No retry of an uncertain ephemeral-channel cleanup. */ });
    return this.closing;
  }
}

/** Read-only call presentation over the shared native notes feed. */
export class CallNotificationFeed {
  private readonly notices: CallNotices;
  private readonly feed: EyreNotesFeed;
  private closed = false;
  constructor(client: NotesClient, notify: (notice: CallNotice) => void, failed: () => void) {
    const self = client.browserCookies(client.origin)[0]?.name.slice('urbauth-'.length) ?? '';
    this.notices = new CallNotices(self, notice => { if (!this.closed) notify(notice); });
    this.feed = new EyreNotesFeed(client, value => this.notices.update(value), () => { this.closed = true; failed(); });
  }
  current(notice: CallNotice): boolean { return !this.closed && this.notices.current(notice); }
  start(): Promise<void> { return this.feed.start(); }
  close(): Promise<void> { this.closed = true; return this.feed.close(); }
}
