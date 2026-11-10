import { createHash } from 'node:crypto';
import type { ShipClient } from './ship-client';
import { codingHistory } from './coding-history';
import { asRecord, isInteger, isUv, isUx, validUnicode, type CodingSnapshot, type JsonObject } from './protocol';

export const FILE_LIMIT = 1_048_576;
export interface SourceBasis { readonly id: string; readonly owner: string; readonly desk: string; readonly number: number; readonly root: string; readonly commit: string }
export interface SourceDescriptor {
  readonly key: string; readonly uri: string; readonly origin: string; readonly ship: string; readonly session: string;
  readonly source: SourceBasis; readonly path: string; readonly blob: string; readonly mark: string;
  readonly byteLength: number; readonly contentHash: string;
}
export interface SourceSnapshot extends SourceDescriptor { readonly text: string }
export interface SourceProgress {
  readonly key: string; readonly ship: string; readonly session: string; readonly source: SourceBasis;
  readonly path: string; readonly blob: string; readonly total: number; readonly next: number | null;
  readonly lines: number; readonly bytes: number;
}
export function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
export function originOf(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid exact ship origin.');
  return url.origin;
}
export function validPath(path: string): boolean {
  const parts = path.split('/').slice(1);
  return Buffer.byteLength(path) <= 2064 && /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(path) &&
    parts.length <= 16 && parts.every(part => part !== '.' && part !== '..');
}
export function sourceBasis(value: unknown): SourceBasis {
  const row = asRecord(value);
  if (!isUx(row.id) || row.id === '0x0' || typeof row.owner !== 'string' || !/^~[a-z-]{1,127}$/.test(row.owner) ||
      typeof row.desk !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(row.desk) || !isInteger(row.number, 1) || !isUv(row.root) || !isUv(row.commit)) throw new Error('Invalid native source basis.');
  return Object.freeze({ id: row.id, owner: row.owner, desk: row.desk, number: row.number, root: row.root, commit: row.commit });
}
export function sameBasis(source: SourceBasis, value: unknown): boolean {
  try {
    const row = asRecord(value);
    return (row.id === undefined || row.id === source.id) && row.owner === source.owner && row.desk === source.desk &&
      row.number === source.number && row.root === source.root && row.commit === source.commit;
  } catch { return false; }
}
export function snapshotFrom(value: unknown): SourceSnapshot {
  const row = asRecord(value), source = sourceBasis(row.source);
  if (typeof row.origin !== 'string' || typeof row.ship !== 'string' || !/^~[a-z-]{1,127}$/.test(row.ship) ||
      !isUx(row.session) || row.session === '0x0' || typeof row.path !== 'string' || !validPath(row.path) ||
      !isUx(row.blob) || row.blob === '0x0' || row.mark !== row.path.split('/').at(-1) || typeof row.text !== 'string' ||
      !validUnicode(row.text) || Buffer.byteLength(row.text) > FILE_LIMIT) throw new Error('Invalid exact source snapshot.');
  const origin = originOf(row.origin), contentHash = digest(row.text);
  const identity = { origin, ship: row.ship, session: row.session, source, path: row.path, blob: row.blob, mark: row.mark as string, contentHash };
  const binding = JSON.stringify(identity), key = digest(binding);
  // VS Code serializes the complete query with encodeURIComponent, including its '=' separator.
  const uri = `urbit-source:/${key}${row.path}?binding%3D${Buffer.from(binding).toString('base64url')}`;
  if ((row.uri !== undefined && row.uri !== uri) || (row.contentHash !== undefined && row.contentHash !== contentHash) ||
      (row.key !== undefined && row.key !== key) || (row.byteLength !== undefined && row.byteLength !== Buffer.byteLength(row.text))) throw new Error('Source identity changed.');
  return Object.freeze({ ...identity, key, uri, byteLength: Buffer.byteLength(row.text), text: row.text });
}
function lineCount(text: string): number { return text.length ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0; }
interface Page { source: SourceBasis; session: string; path: string; blob: string; mark: string; start: number; total: number; text: string; lines: number; next: number | null }
function readPage(row: JsonObject): Page | undefined {
  if (row.kind !== 'tool' || !row.file || typeof row.file !== 'object' || Array.isArray(row.file)) return undefined;
  const file = asRecord(row.file); if (file.kind !== 'read') return undefined;
  const source = sourceBasis(file.source), page = asRecord(file.value);
  if (!isUx(row.id) || !isInteger(row.sequence) || !isUx(file.session) || file.session === '0x0' || !isUx(file.request) || file.request === '0x0' ||
      typeof file.callId !== 'string' || !file.callId.length || !validUnicode(file.callId) || Buffer.byteLength(file.callId) > 512 ||
      typeof row.text !== 'string') throw new Error('Invalid retained file record.');
  const result = asRecord(JSON.parse(row.text)), context = asRecord(result.context), output = asRecord(result.output);
  if (result.version !== 'native-coding-tool-result-v1' || result.call_id !== file.callId || context.request !== file.request ||
      context.session !== file.session || !sameBasis(source, context.source) || output.kind !== 'read') throw new Error('Unbound retained file result.');
  for (const key of ['path', 'blob', 'start', 'total', 'text', 'next']) {
    if (page[key] !== output[key]) throw new Error('Retained file projections disagree.');
  }
  for (const key of ['mark', 'lines', 'bytes']) {
    if (Object.hasOwn(output, key) && page[key] !== output[key]) throw new Error('Optional native file metadata disagrees.');
  }
  if (typeof page.path !== 'string' || !validPath(page.path) || page.mark !== page.path.split('/').at(-1) || !isUx(page.blob) || page.blob === '0x0' ||
      !isInteger(page.start, 1) || !isInteger(page.total) || !isInteger(page.lines, 0, 200) || typeof page.text !== 'string' || !validUnicode(page.text) ||
      page.bytes !== Buffer.byteLength(page.text) || Buffer.byteLength(page.text) > 16_384 || page.lines !== lineCount(page.text) ||
      !(page.next === null || isInteger(page.next, 1))) throw new Error('Invalid exact native file page.');
  if (page.next === null ? page.start + page.lines !== page.total + 1 :
      !page.lines || page.next !== page.start + page.lines || page.next > page.total || !page.text.endsWith('\n')) throw new Error('Incomplete native page boundaries.');
  return { source, session: file.session, path: page.path, blob: page.blob, mark: page.mark as string,
    start: page.start, total: page.total, text: page.text, lines: page.lines, next: page.next };
}

/** Pure projection of retained native read evidence. Refresh is GET-only; browsing never invokes a tool. */
export class SourceStore {
  private readonly cache = new Map<string, SourceSnapshot>();
  private readonly pages = new Map<string, Map<number, Page>>();
  readonly origin: string;
  constructor(private readonly client: Pick<ShipClient, 'origin' | 'codingState'>) { this.origin = originOf(client.origin); }
  async refresh(session = '0x0'): Promise<readonly SourceDescriptor[]> {
    const state = await codingHistory(this.client, await this.client.codingState(session));
    if (originOf(this.client.origin) !== this.origin) throw new Error('Ship origin changed.');
    this.ingest(state); return this.sources();
  }
  ingest(state: CodingSnapshot): void {
    if (typeof state.owner !== 'string' || !/^~[a-z-]{1,127}$/.test(state.owner)) throw new Error('Invalid observed ship identity.');
    const staged = new Map([...this.pages].map(([key, value]) => [key, new Map(value)]));
    const completed: SourceSnapshot[] = [];
    for (const row of state.records) {
      const page = readPage(row); if (!page) continue;
      const key = JSON.stringify([state.owner, page.session, page.source, page.path, page.blob, page.total]);
      const pages = staged.get(key) ?? new Map<number, Page>();
      const prior = pages.get(page.start);
      if (prior && JSON.stringify(prior) !== JSON.stringify(page)) throw new Error('Conflicting native bytes for one source/blob.');
      pages.set(page.start, page); staged.set(key, pages);
      if (pages.size > 512 || [...pages.values()].reduce((count, part) => count + Buffer.byteLength(part.text), 0) > FILE_LIMIT) throw new Error('Native file page capacity exceeded.');
    }
    if (staged.size > 128) throw new Error('Retained source projection capacity reached.');
    for (const [group, pages] of staged) {
      const first = pages.get(1); if (!first) continue;
      let next: number | null = 1, text = '';
      while (next !== null) {
        const page = pages.get(next); if (!page) break;
        text += page.text; if (Buffer.byteLength(text) > FILE_LIMIT) throw new Error('Whole-file source exceeds 1 MiB of UTF-8 bytes.');
        next = page.next;
      }
      if (next !== null) continue;
      if (lineCount(text) !== first.total) throw new Error('Whole-file native line count changed.');
      completed.push(snapshotFrom({ origin: this.origin, ship: JSON.parse(group)[0],
        session: first.session, source: first.source, path: first.path, blob: first.blob, mark: first.mark, text }));
    }
    if (new Set([...this.cache.keys(), ...completed.map(item => item.key)]).size > 64) throw new Error('64 immutable source snapshots are retained.');
    this.pages.clear(); for (const [key, value] of staged) this.pages.set(key, value);
    for (const item of completed) this.cache.set(item.key, item);
  }
  sources(): readonly SourceDescriptor[] { return [...this.cache.values()].map(({ text: _text, ...descriptor }) => Object.freeze(descriptor)); }
  progress(): readonly SourceProgress[] {
    return [...this.pages].map(([group, pages]) => {
      const first = pages.values().next().value!;
      let next: number | null = 1, lines = 0, bytes = 0;
      while (next !== null) {
        const page = pages.get(next); if (!page) break;
        lines += page.lines; bytes += Buffer.byteLength(page.text); next = page.next;
      }
      return Object.freeze({key: digest(JSON.stringify([this.origin, group])), ship: JSON.parse(group)[0] as string,
        session: first.session, source: first.source, path: first.path, blob: first.blob,
        total: first.total, next, lines, bytes});
    });
  }
  openSnapshot(descriptor: SourceDescriptor | string): SourceSnapshot {
    const uri = typeof descriptor === 'string' ? descriptor : descriptor.uri, parsed = new URL(uri);
    const key = parsed.pathname.split('/')[1], snapshot = this.cache.get(key);
    if (parsed.protocol !== 'urbit-source:' || parsed.host || parsed.hash || !snapshot || parsed.pathname !== `/${key}${snapshot.path}` ||
        (parsed.search && uri !== snapshot.uri)) throw new Error('This exact immutable source is not retained. Refresh its native read records.');
    return snapshot;
  }
  bytes(descriptor: SourceDescriptor | string): Uint8Array { return Buffer.from(this.openSnapshot(descriptor).text, 'utf8'); }
}
