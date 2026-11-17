import {asRecord, isInteger, validUnicode, type CodingSnapshot, type JsonObject} from './protocol';
import {remoteShip} from './remote-project-view';

export const CODING_CATALOG_BYTES = 524288;
const SCHEMA = 'native-coding-session-catalog-v2', ENDPOINT = '/apps/pataphor-native/coding/sessions?offset=0';
const PHASES = new Set(['idle', 'ready', 'inference', 'tools', 'judgment', 'paused', 'unknown', 'complete', 'refused']);
export class CodingCatalogError extends Error {
  constructor(readonly code: 'catalogMalformed' | 'catalogUnavailable' | 'catalogChanged' | 'catalogDeadline') { super(code); }
}
function invalid(): never { throw new CodingCatalogError('catalogMalformed'); }
function object(value: unknown): JsonObject { try { return asRecord(value); } catch { return invalid(); } }
function exact(value: unknown, keys: string[]): JsonObject {
  const row = object(value); if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid(); return row;
}
function ux(value: unknown): value is string {
  return typeof value === 'string' && /^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(value) && value.replaceAll('.', '').length <= 66;
}
function uv(value: unknown): boolean {
  if (typeof value !== 'string' || !/^0v(?:0|[1-9a-v][0-9a-v]{0,4}(?:\.[0-9a-v]{5})*)$/.test(value) || value.length > 64) return false;
  let n = 0n; for (const c of value.slice(2).replaceAll('.', '')) n = n * 32n + BigInt(parseInt(c, 32));
  return n < (1n << 256n);
}
function text(value: unknown, min: number, max: number): boolean {
  return typeof value === 'string' && validUnicode(value) && Buffer.byteLength(value) >= min && Buffer.byteLength(value) <= max;
}
function ids(value: unknown, total: number): string[] {
  if (!Array.isArray(value) || value.length !== total || value.some(id => !ux(id))) invalid();
  const values = value as string[];
  if (values.some((id, i) => i > 0 && BigInt(id.replaceAll('.', '')) <= BigInt(values[i - 1].replaceAll('.', '')))) invalid();
  return values;
}
function rows(value: unknown, owner: string, max: number): JsonObject[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value.map(item => {
    const r = exact(item, ['id', 'project', 'objective', 'phase', 'model', 'worker', 'source']);
    const s = exact(r.source, ['id', 'owner', 'desk', 'number', 'root', 'commit']);
    if (!ux(r.id) || !text(r.project, 1, 128) || !text(r.objective, 0, 65536) || !text(r.model, 1, 256) ||
        !PHASES.has(String(r.phase)) || !remoteShip(r.worker) || !ux(s.id) || s.owner !== owner ||
        typeof s.desk !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/.test(s.desk) || !isInteger(s.number) || !uv(s.root) || !uv(s.commit)) invalid();
    return Object.freeze({...r, source: Object.freeze({...s})});
  });
}
type FetchPage = (path: string, timeoutMs: number) => Promise<JsonObject>;
type Cached = {key: string; rows: readonly JsonObject[]};

/** One complete catalog per connection. Partial pages never become selection evidence. */
export class CodingSessionCatalog {
  private cached?: Cached;
  clear(): void { this.cached = undefined; }
  async resolve(snapshot: CodingSnapshot, connection: number, fetch: FetchPage, current: () => void): Promise<CodingSnapshot> {
    current();
    if (snapshot.sessionCatalog === undefined) return snapshot; // Older backends retain their existing protocol.
    const meta = object(snapshot.sessionCatalog);
    if (meta.schema !== SCHEMA || meta.owner !== snapshot.owner || !remoteShip(meta.owner) || meta.permissionGranted !== false ||
        meta.endpoint !== ENDPOINT || typeof meta.available !== 'boolean' || typeof meta.complete !== 'boolean' ||
        typeof snapshot.sessionCatalogReady !== 'boolean') invalid();
    if (!meta.available) throw new CodingCatalogError('catalogUnavailable');
    if (!ux(meta.digest) || !isInteger(meta.total, 0, 512) ||
        snapshot.ready !== (snapshot.sessionCatalogReady && meta.complete) ||
        (meta.complete ? meta.error !== null : meta.error !== 'coding-catalog-upgrade-required')) invalid();
    const key = JSON.stringify([connection, meta.owner, meta.digest, meta.total]);
    let complete: JsonObject[];
    if (meta.complete) {
      complete = rows(snapshot.sessions, snapshot.owner, 512);
      ids(complete.map(row => row.id), meta.total);
    } else {
      if (snapshot.sessions.length || !meta.total) invalid();
      if (this.cached?.key === key) complete = [...this.cached.rows];
      else {
        complete = []; let expectedIds: string[] | undefined;
        const deadline = Date.now() + 60000;
        while (complete.length < meta.total) {
          current();
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new CodingCatalogError('catalogDeadline');
          const page = object(await fetch(`${ENDPOINT.slice(0, -1)}${complete.length}&catalog=${meta.digest}`, Math.min(20000, remaining)));
          current();
          if (Date.now() >= deadline) throw new CodingCatalogError('catalogDeadline');
          if (Buffer.byteLength(JSON.stringify(page)) > CODING_CATALOG_BYTES || page.schema !== SCHEMA ||
              page.owner !== snapshot.owner || page.permissionGranted !== false) invalid();
          if (page.error === 'coding-catalog-stale') throw new CodingCatalogError('catalogChanged');
          if (page.available !== true || page.error !== undefined) throw new CodingCatalogError('catalogUnavailable');
          const cursor = exact(page.catalog, ['digest', 'offset', 'total', 'next']);
          if (cursor.digest !== meta.digest || cursor.offset !== complete.length || cursor.total !== meta.total) invalid();
          const ordered = ids(page.sessionIds, meta.total);
          if (expectedIds && ordered.some((id, i) => id !== expectedIds![i])) invalid();
          expectedIds = ordered;
          const next = rows(page.sessions, snapshot.owner, 64), end = complete.length + next.length;
          if (!next.length || end > meta.total || next.some((row, i) => row.id !== ordered[complete.length + i]) ||
              cursor.next !== (end === meta.total ? null : end)) invalid();
          complete.push(...next);
        }
      }
    }
    current();
    this.cached = {key, rows: Object.freeze([...complete])};
    return {...snapshot, sessions: complete, ready: snapshot.sessionCatalogReady, catalogLoaded: true, catalogNotice: ''};
  }
}
