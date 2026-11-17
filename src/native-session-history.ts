import {asRecord, isInteger, validJSON, type JsonObject} from './protocol';
import {remoteShip} from './remote-project-view';
import type {ShipClient} from './ship-client';

export interface NativeHistoryConnection {
  client: Pick<ShipClient, 'origin' | 'requestJSON'>;
  owner: string;
  current: () => boolean;
}
interface Head {revision: number; commit: string}
export interface NativeArchivePage {head: Head; offset: number; next: number | null; sessionIds: string[]}
export interface NativeHistoryRecord {id: string; sequence: number; kind: string; text: string; file: JsonObject | null; context: JsonObject | null}
export interface NativeHistoryPage {
  owner: string; session: string; project: string; objective: string; summary: string; phase: string;
  records: NativeHistoryRecord[]; after: number; more: boolean;
}
const BASE = '/apps/pataphor-native/coding/', PAGE = 'native-coding-session-archive-page-v1';
const PHASES = new Set(['idle', 'ready', 'inference', 'tools', 'judgment', 'paused', 'unknown', 'complete', 'refused']);
const KINDS = new Set(['operator', 'model', 'tool', 'selection', 'status', 'terminal', 'context', 'judgment']);
function invalid(): never {throw new Error('Native session history is invalid or changed. Reopen history to read it again.');}
function exact(value: unknown, keys: string[]): JsonObject {
  const row = asRecord(value);
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function ux(value: unknown): value is string {
  return typeof value === 'string' && /^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(value) && value.replaceAll('.', '').length <= 66;
}
function uv(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || !/^0v[1-9a-v][0-9a-v]{0,4}(?:\.[0-9a-v]{5})*$/.test(value)) return false;
  let n = 0n; for (const c of value.slice(2).replaceAll('.', '')) n = n * 32n + BigInt(parseInt(c, 32));
  return n < (1n << 256n);
}
// These archive endpoints require the exact scot %ud spelling, unlike /state.
function ud(value: number): string {
  if (!isInteger(value)) invalid();
  return String(value).replace(/\B(?=(?:[0-9]{3})+$)/g, '.');
}

/** One authenticated GET per requested page; no writes, retries or persistent cache. */
export class NativeSessionHistory {
  private readonly origin: string;
  private readonly owner: string;
  constructor(private readonly connection: NativeHistoryConnection) {
    this.origin = connection.client.origin;
    if (!remoteShip(connection.owner)) invalid();
    this.owner = connection.owner;
  }
  private current(): void {
    if (!this.connection.current() || this.connection.client.origin !== this.origin || this.connection.owner !== this.owner) throw new Error('Native history connection changed. Reopen history.');
  }
  private async get(path: string): Promise<JsonObject> {
    this.current();
    const value = await this.connection.client.requestJSON(BASE + path, {method: 'GET'});
    this.current();
    if (!validJSON(value) || Buffer.byteLength(JSON.stringify(value)) > 4194304 || value.owner !== this.owner) invalid();
    if (value.available === false) {
      const refusal = exact(value, ['schema', 'owner', 'available', 'error']);
      if (refusal.schema !== PAGE || typeof refusal.error !== 'string' || !/^archive-[a-z0-9-]{1,128}$/.test(refusal.error)) invalid();
      throw new Error('Native session history unavailable: ' + refusal.error);
    }
    if (value.available !== true) invalid();
    return value;
  }
  async *pages(): AsyncGenerator<NativeArchivePage> {
    let offset = 0, head: Head | undefined;
    const seen = new Set<string>();
    for (;;) {
      const value = exact(await this.get(`archived-sessions?offset=${ud(offset)}&revision=${ud(head?.revision ?? 0)}&commit=${head?.commit ?? '0v0'}`),
        ['schema', 'owner', 'available', 'head', 'offset', 'next', 'sessionIds']);
      const anchor = exact(value.head, ['revision', 'commit']);
      if (value.schema !== PAGE || value.offset !== offset || !isInteger(anchor.revision, 1) || !uv(anchor.commit) ||
          head && (head.revision !== anchor.revision || head.commit !== anchor.commit) ||
          !Array.isArray(value.sessionIds) || value.sessionIds.length > 64) invalid();
      const ids: string[] = [];
      for (const id of value.sessionIds) {
        if (!ux(id) || seen.has(id)) invalid();
        seen.add(id); ids.push(id);
      }
      const end = offset + ids.length;
      if (!isInteger(end) || offset > 0 && !ids.length || value.next !== null && (!ids.length || value.next !== end)) invalid();
      head = {revision: anchor.revision, commit: anchor.commit};
      yield {head: {...head}, offset, next: value.next as number | null, sessionIds: ids};
      if (value.next === null) return;
      offset = end;
    }
  }
  async *history(session: string): AsyncGenerator<NativeHistoryPage> {
    if (!ux(session)) invalid();
    let after = 0, metadata: string | undefined;
    const seen = new Set<string>();
    for (;;) {
      const value = exact(await this.get(`archived-session?id=${session}&after=${ud(after)}`),
        ['schema', 'owner', 'available', 'session', 'project', 'objective', 'summary', 'phase', 'records', 'after', 'more']);
      if (value.schema !== 'native-coding-session-archive-detail-v1' || value.session !== session ||
          typeof value.project !== 'string' || !value.project || Buffer.byteLength(value.project) > 128 ||
          typeof value.objective !== 'string' || typeof value.summary !== 'string' || typeof value.phase !== 'string' || !PHASES.has(value.phase) ||
          !Array.isArray(value.records) || value.records.length > 32 || typeof value.more !== 'boolean') invalid();
      const identity = JSON.stringify([value.owner, session, value.project, value.objective, value.summary, value.phase]);
      if (metadata !== undefined && metadata !== identity) invalid();
      metadata = identity;
      let next = after;
      const records = value.records.map(item => {
        const r = exact(item, ['id', 'sequence', 'kind', 'text', 'file', 'context']);
        if (!ux(r.id) || seen.has(r.id) || !isInteger(r.sequence, 0, Number.MAX_SAFE_INTEGER - 1) || r.sequence !== next ||
            typeof r.kind !== 'string' || !KINDS.has(r.kind) || typeof r.text !== 'string') invalid();
        if (r.file !== null) asRecord(r.file);
        if (r.context !== null) asRecord(r.context);
        seen.add(r.id); next = r.sequence + 1;
        return structuredClone(r) as unknown as NativeHistoryRecord;
      });
      if (value.after !== next || (value.more || after > 0) && !records.length) invalid();
      yield {owner: this.owner, session, project: value.project, objective: value.objective, summary: value.summary,
        phase: value.phase, records, after: next, more: value.more};
      if (!value.more) return;
      after = next;
    }
  }
}
