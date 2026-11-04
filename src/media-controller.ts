import { randomBytes } from 'node:crypto';
import { validUnicode, type JsonObject } from './protocol';
import { originOf } from './source-store';

export type MediaKind = 'glurff' | 'noltbook' | 'landscape' | 'call';
export interface MediaTab { readonly url: string; readonly title?: string }
export interface BrowserAdapter<T extends MediaTab> {
  open(url: string): Promise<T>; reveal(tab: T): Promise<void>; close(tab: T): Promise<void>;
  isClosed?(tab: T): boolean;
  isActive?(tab: T): boolean;
  retained?(bootstrapURL: string): T | undefined;
}
export interface MediaShipClient {
  readonly origin: string; signIn(): Promise<void>;
  browserCookies(origin: string): readonly { readonly name: string; readonly value: string; readonly expires?: number }[];
}
export interface MediaBridge {
  request(op: 'status' | 'bind' | 'observe' | 'navigate' | 'forget', payload?: JsonObject): Promise<JsonObject>;
}
export interface MediaRecord {
  readonly bindingId: string; readonly kind: MediaKind; readonly origin: string; readonly url: string;
  readonly phase: 'opening' | 'bound' | 'unknown'; readonly ready: boolean; readonly closed?: boolean; readonly active?: boolean; readonly title?: string; readonly fault?: string; readonly currentURL?: string; readonly pending?: boolean;
}
interface Owned<T> { record: MediaRecord; tab?: T; busy: boolean; opened: Promise<void>; bindAttempted: boolean; released: boolean }
const roots: Record<MediaKind, string> = { glurff: '/apps/glurff/', noltbook: '/apps/noltbook/', landscape: '/apps/landscape/', call: '/apps/call' };
export function mediaURL(origin: string, kind: MediaKind, raw?: string): string {
  origin = originOf(origin);
  if (!Object.hasOwn(roots, kind)) throw new Error('Unknown ship media surface.');
  const input = raw ?? roots[kind], path = input.replace(/^https?:\/\/[^/?#]+/i, '').split(/[?#]/, 1)[0];
  if (input.startsWith('//') || path.split('/').some(part => {
    try { const decoded = decodeURIComponent(part); return decoded === '.' || decoded === '..' || /[/\\]/.test(decoded); } catch { return true; }
  })) throw new Error('Use a media path without encoded separators or traversal.');
  const url = new URL(input, origin), root = roots[kind].replace(/\/$/, '');
  if (url.origin !== origin || url.username || url.password || !(url.pathname === root || url.pathname.startsWith(root + '/')) ||
      !validUnicode(raw ?? '') || !validUnicode(url.href) || Buffer.byteLength(url.href) > 8192 || /[\u0000-\u0020\\]/u.test(raw ?? '') ||
      kind === 'call' && url.searchParams.has('auto')) throw new Error('Use this ship’s exact media route without automatic call joining.');
  return url.href;
}

/** Retains independent browser/media owners. Revealing a tab never sends a navigation. */
export class MediaController<T extends MediaTab> {
  readonly origin: string;
  private readonly owned = new Map<string, Owned<T>>();
  private epoch = 0;
  private disconnected = false;
  private releaseUnknown = false;
  private readonly client: MediaShipClient;
  private readonly bridge: MediaBridge;
  private readonly browser: BrowserAdapter<T>;
  constructor(options: { client: MediaShipClient; bridge: MediaBridge; browser: BrowserAdapter<T> }) {
    this.client = options.client; this.bridge = options.bridge; this.browser = options.browser;
    this.origin = originOf(this.client.origin);
  }
  state(): readonly MediaRecord[] {
    return [...this.owned.values()].map(item => {
      const closed = !!(item.tab && this.browser.isClosed?.(item.tab));
      const suffix = item.tab ? ` (${item.tab.url})` : '';
      const title = suffix && item.tab?.title?.endsWith(suffix) ? item.tab.title.slice(0, -suffix.length) : item.tab?.title;
      return Object.freeze({ ...item.record,
        ...(title !== undefined ? { title } : {}),
        ...(this.browser.isActive ? { active: !!(item.tab && !closed && this.browser.isActive(item.tab)) } : {}),
        ...(closed ? { closed: true, ready: false } : {}) });
    });
  }
  private item(selector: string): Owned<T> {
    const item = this.owned.get(selector) ?? [...this.owned.values()].reverse().find(item => item.record.kind === selector);
    if (!item) throw new Error('This managed media tab is not retained.');
    return item;
  }
  private current(item: Owned<T>, epoch = this.epoch): boolean {
    return !this.disconnected && epoch === this.epoch && this.client.origin === this.origin && this.owned.get(item.record.bindingId) === item;
  }
  async open(kind: MediaKind, raw?: string): Promise<MediaRecord> {
    if (this.disconnected || this.client.origin !== this.origin) throw new Error('Reconnect the selected ship first.');
    const url = mediaURL(this.origin, kind, raw);
    const existing = [...this.owned.values()].find(item => item.record.kind === kind && item.record.url === url);
    if (existing) {
      if (existing.tab && this.browser.isClosed?.(existing.tab) === true) this.owned.delete(existing.record.bindingId);
      else { if (existing.tab) await this.browser.reveal(existing.tab); return { ...existing.record }; }
    }
    if (this.owned.size >= 8) throw new Error('Eight managed media tabs are retained. Close one explicitly first.');
    const bindingId = randomBytes(16).toString('hex'), bootstrapURL = `about:blank#readymade-${bindingId}`, epoch = this.epoch;
    let finishOpening!: () => void;
    const opened = new Promise<void>(resolve => { finishOpening = resolve; });
    const item: Owned<T> = { record: { bindingId, kind, origin: this.origin, url, phase: 'opening', ready: false }, busy: true, opened, bindAttempted: false, released: false };
    this.owned.set(bindingId, item);
    try {
      let cookies;
      try { cookies = this.client.browserCookies(this.origin); }
      catch { await this.client.signIn(); cookies = this.client.browserCookies(this.origin); }
      if (!this.current(item, epoch)) throw new Error('Media selection changed.');
      const tab = await this.browser.open(bootstrapURL); item.tab = tab;
      if (!this.current(item, epoch)) { await this.browser.close(tab); throw new Error('Media selection changed.'); }
      item.bindAttempted = true;
      const result = await this.bridge.request('bind', { bindingId, bootstrapURL, origin: this.origin, kind, url, cookies });
      if (this.current(item, epoch)) this.accept(item, result);
    } catch {
      if (!item.tab) item.tab = this.browser.retained?.(bootstrapURL);
      if (this.current(item, epoch)) item.record = { ...item.record, phase: 'unknown', ready: false, fault: 'Open outcome is unknown. Observe before any reconnect; nothing was retried.' };
      else if (this.disconnected && this.owned.get(bindingId) !== item && item.tab) await this.browser.close(item.tab);
    } finally { item.busy = false; finishOpening(); }
    return { ...item.record };
  }
  async reveal(selector: string): Promise<void> {
    const item = this.item(selector); if (!item.tab) throw new Error('No browser tab was created. Close this record before opening again.');
    await this.browser.reveal(item.tab);
  }
  private accept(item: Owned<T>, value: JsonObject): void {
    let current: URL;
    try { current = new URL(value.url as string); } catch { throw new Error('Media URL observation is invalid.'); }
    const login = current.origin === this.origin && !current.username && !current.password && ['/~/login', '/~/login/'].includes(current.pathname);
    if (!login && mediaURL(this.origin, item.record.kind, current.href) !== current.href) throw new Error('Media route changed.');
    if (value.bindingId !== item.record.bindingId || value.origin !== this.origin || value.kind !== item.record.kind ||
        value.requestedURL !== item.record.url || typeof value.ready !== 'boolean' || login && value.ready ||
        value.pending !== undefined && typeof value.pending !== 'boolean' ||
        !(value.fault === null || typeof value.fault === 'string')) throw new Error('Media binding observation does not match this retained tab.');
    item.record = { ...item.record, phase: value.pending ? 'unknown' : 'bound', pending: value.pending === true, ready: value.ready, currentURL: current.href,
      ...(value.fault ? { fault: value.fault as string } : { fault: undefined }) };
  }
  async observe(selector: string): Promise<MediaRecord> {
    const item = this.item(selector); if (item.busy || !this.current(item)) throw new Error('Media operation is still pending.');
    item.busy = true;
    try {
      const value = await this.bridge.request('observe', { bindingId: item.record.bindingId });
      if (!this.current(item)) throw new Error('Media selection changed.');
      if (value.bindingId === item.record.bindingId && value.exists === false) {
        item.record = { ...item.record, phase: 'unknown', ready: false, fault: 'No native binding exists. Close this owned tab before opening a new one.' };
      } else this.accept(item, value);
      return { ...item.record };
    } finally { item.busy = false; }
  }
  async reconnect(selector: string): Promise<MediaRecord> {
    const item = this.item(selector);
    if (item.busy || item.record.phase !== 'bound' || item.record.pending || !this.current(item)) throw new Error('Observe the uncertain media binding before reconnecting.');
    item.busy = true;
    try {
      const result = await this.bridge.request('navigate', { bindingId: item.record.bindingId, url: item.record.url });
      if (this.current(item)) this.accept(item, result);
    } catch {
      if (this.current(item)) item.record = { ...item.record, phase: 'unknown', ready: false, fault: 'Reconnect outcome is unknown. Observe before another deliberate reconnect.' };
    } finally { item.busy = false; }
    return { ...item.record };
  }
  async handleOpen(event: { type: 'open'; bindingId: string; url: string }): Promise<MediaRecord | undefined> {
    const owner = this.owned.get(event.bindingId);
    if (owner?.record.phase === 'opening') await owner.opened;
    if (!owner || owner.record.phase !== 'bound' || !this.current(owner) ||
        owner.tab && this.browser.isClosed?.(owner.tab)) return undefined;
    for (const kind of ['glurff', 'noltbook', 'landscape'] as const) {
      try { mediaURL(this.origin, kind, event.url); } catch { continue; }
      return this.open(kind, event.url);
    }
    return undefined;
  }
  async close(selector: string): Promise<void> {
    const item = this.item(selector);
    if (item.busy) throw new Error('Wait for the owned media operation before closing this tab.');
    if (item.tab) await this.browser.close(item.tab);
    this.owned.delete(item.record.bindingId);
  }
  async disconnect(): Promise<void> {
    this.disconnected = true; this.epoch++;
    const items = [...this.owned.values()], bindingIds = items.filter(item => item.bindAttempted && !item.released).map(item => item.record.bindingId);
    if (bindingIds.length) {
      if (this.releaseUnknown) throw new Error('Owned media release remains unconfirmed. It cannot be replayed.');
      try {
        const result = await this.bridge.request('forget', { origin: this.origin, bindingIds });
        if (result.forgotten !== true) throw new Error('Owned native binding release is unconfirmed.');
        for (const item of items) if (bindingIds.includes(item.record.bindingId)) item.released = true;
      } catch {
        this.releaseUnknown = true;
        for (const item of items) if (item.bindAttempted) item.record = { ...item.record, phase: 'unknown', ready: false,
          fault: 'Owned media release is unconfirmed. No other window was disconnected; nothing was retried.' };
        throw new Error('Owned media release is unconfirmed. Retained tab records were preserved.');
      }
    }
    const results = await Promise.allSettled(items.map(async item => { if (item.tab) await this.browser.close(item.tab); }));
    for (const [index, item] of items.entries()) {
      if (results[index].status === 'fulfilled' && this.owned.get(item.record.bindingId) === item) this.owned.delete(item.record.bindingId);
      else item.record = { ...item.record, phase: 'unknown', ready: false, fault: 'Native media was released, but its owned tab handle could not close.' };
    }
    if (results.some(result => result.status === 'rejected')) throw new Error('Some owned media tabs could not close. Their original owners were not replaced.');
  }
}
