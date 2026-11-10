import * as fs from 'node:fs';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import type {BrowserTab, BrowserCDPSession, Disposable} from 'vscode';
const PREFIX = 'nb-composer-v1/';
const MAX_RECORD_BYTES = 3 * 1024 * 1024;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const record = (x: unknown): Record<string, unknown> | undefined => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : undefined;
function secure(path: string, directory: boolean): void {
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Composer backup storage is not private.');
}
/** Only unsent composer records; never browser cookies or arbitrary localStorage. */
export class ComposerJournal {
  readonly directory: string;
  constructor(root: string, readonly origin: string, readonly ship: string) {
    const url = new URL(origin);
    if (url.origin !== origin || !/^~?[a-z-]{3,128}$/.test(ship) || ship.startsWith('~') ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Invalid composer identity.');
    fs.mkdirSync(root, {recursive: true, mode: 0o700}); secure(root, true);
    this.directory = join(root, hash(JSON.stringify([origin, ship])));
    fs.mkdirSync(this.directory, {mode: 0o700, recursive: true}); secure(this.directory, true);
  }
  accepts(key: unknown): key is string {
    if (typeof key !== 'string' || !key.startsWith(PREFIX) || key.length > 2048) return false;
    try {
      const pair = JSON.parse(key.slice(PREFIX.length));
      return Array.isArray(pair) && pair.length === 2 && pair[0] === this.ship && typeof pair[1] === 'string' && pair[1].length > 0 && !/[\u0000-\u001f]/u.test(pair[1]) && key === PREFIX + JSON.stringify(pair);
    } catch { return false; }
  }
  private validate(value: string): void {
    if (Buffer.byteLength(value) > 1024 * 1024) throw new Error('Composer draft exceeds backup limit.');
    const row = record(JSON.parse(value));
    const fields = ['version', 'text', 'replyingTo', 'replyingToEid', 'editingMsgId', 'editingEid', 'replyLabel'];
    if (!row || Object.keys(row).length !== fields.length || !fields.every(k => Object.hasOwn(row, k)) || row.version !== 1 || typeof row.text !== 'string' || typeof row.replyLabel !== 'string' ||
      !fields.slice(2, 6).every(k => row[k] === null || typeof row[k] === 'string' || Number.isSafeInteger(row[k]))) throw new Error('Invalid composer draft.');
  }
  entries(): [string, string][] {
    secure(this.directory, true);
    const files = fs.readdirSync(this.directory).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
    if (files.length > 128) throw new Error('Composer backup capacity exceeded.');
    return files.map(name => {
      const file = join(this.directory, name); secure(file, false);
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let saved;
      try { if (fs.fstatSync(fd).size > MAX_RECORD_BYTES) throw new Error('Composer backup oversized.'); saved = JSON.parse(fs.readFileSync(fd, 'utf8')); }
      finally { fs.closeSync(fd); }
      if (saved.origin !== this.origin || saved.ship !== this.ship || !this.accepts(saved.key) || name !== hash(saved.key) + '.json' || typeof saved.value !== 'string') throw new Error('Composer backup identity mismatch.');
      this.validate(saved.value); return [saved.key, saved.value];
    });
  }
  set(key: string, value?: string): void {
    if (!this.accepts(key)) throw new Error('Foreign composer key refused.');
    const entries = this.entries(), file = join(this.directory, hash(key) + '.json');
    if (value === undefined) { if (entries.some(([k]) => k === key)) fs.unlinkSync(file); return; }
    this.validate(value);
    if (entries.length >= 128 && !entries.some(([k]) => k === key)) throw new Error('Composer backup capacity exceeded.');
    // The inner JSON can double in size when escaped inside the disk record.
    const serialized = JSON.stringify({origin: this.origin, ship: this.ship, key, value});
    if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) throw new Error('Composer backup oversized.');
    const temporary = join(this.directory, '.' + randomUUID());
    const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  }
  hydrationScript(): string {
    const marker = 'readymade-composer-hydrated/' + this.ship;
    // Seed once per ephemeral session. Reload must not resurrect a cleared draft.
    return `(()=>{if(location.origin!==${JSON.stringify(this.origin)}||!location.pathname.startsWith('/apps/noltbook/'))return;const marker=${JSON.stringify(marker)};if(sessionStorage.getItem(marker))return;for(const [key,value] of ${JSON.stringify(this.entries())})if(localStorage.getItem(key)===null)localStorage.setItem(key,value);sessionStorage.setItem(marker,'1')})()`;
  }
}

/** Reactive presentation adapter owned by one browser tab, with no polling. */
export async function attachComposerJournal(tab: BrowserTab, journal: ComposerJournal, failed: () => void): Promise<Disposable> {
  const channel: BrowserCDPSession = await tab.startCDPSession();
  let sequence = 0, sessionId: string | undefined, closed = false, warned = false;
  const pending = new Map<number, {resolve: (x: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout}>();
  const fail = (): void => { if (!warned && !closed) { warned = true; failed(); } };
  const request = (method: string, params: object = {}): Promise<Record<string, unknown>> => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Composer backup connection timed out.')); }, 5000);
      pending.set(id, {resolve, reject, timer});
      void channel.sendMessage({id, method, params, ...(sessionId ? {sessionId} : {})}).then(undefined, () => { clearTimeout(timer); pending.delete(id); reject(new Error('Composer backup connection closed.')); });
    });
  };
  const messages = channel.onDidReceiveMessage(message => {
    const row = record(message); if (!row || closed) return;
    if (typeof row.id === 'number') {
      const item = pending.get(row.id); if (!item) return;
      pending.delete(row.id); clearTimeout(item.timer);
      if (row.error) item.reject(new Error('Composer backup protocol refused.')); else item.resolve(record(row.result) ?? {});
      return;
    }
    if (row.sessionId !== sessionId || typeof row.method !== 'string' || !row.method.startsWith('DOMStorage.')) return;
    const params = record(row.params), storage = record(params?.storageId);
    if (storage?.securityOrigin !== journal.origin || storage.isLocalStorage !== true) return;
    try {
      if (row.method === 'DOMStorage.domStorageItemsCleared') { for (const [key] of journal.entries()) journal.set(key); }
      else if (journal.accepts(params?.key)) {
        if (row.method === 'DOMStorage.domStorageItemRemoved') journal.set(params.key);
        else if (['DOMStorage.domStorageItemAdded', 'DOMStorage.domStorageItemUpdated'].includes(row.method) && typeof params.newValue === 'string') journal.set(params.key, params.newValue);
      }
    } catch { fail(); }
  });
  const dispose = (): void => {
    if (closed) return; closed = true; messages.dispose(); ending.dispose();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Composer backup closed.')); } pending.clear();
    void channel.close();
  };
  const ending = channel.onDidClose(dispose);
  try {
    const targets = await request('Target.getTargets');
    const matches = (Array.isArray(targets.targetInfos) ? targets.targetInfos : []).map(record).filter(t => t?.type === 'page' && t.url === tab.url);
    if (matches.length !== 1 || typeof matches[0]?.targetId !== 'string' || !/^about:blank#readymade-[a-f0-9]{32}$/.test(tab.url)) throw new Error('Composer backup requires a unique private bootstrap.');
    const attached = await request('Target.attachToTarget', {targetId: matches[0].targetId, flatten: true});
    if (typeof attached.sessionId !== 'string') throw new Error('Composer backup target unavailable.'); sessionId = attached.sessionId;
    await request('Page.enable');
    await request('DOMStorage.enable');
    await request('Page.addScriptToEvaluateOnNewDocument', {source: journal.hydrationScript()});
    return {dispose};
  } catch (error) { dispose(); throw error; }
}
