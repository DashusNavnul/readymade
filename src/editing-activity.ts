import {asRecord, validUnicode, type JsonObject} from './protocol';

export interface ActivityTarget {owner: string; project: string}
export interface ActivitySelector extends ActivityTarget {request: string}
export type ActivityCommand = ActivityTarget & (
  {operation: 'query'} |
  {operation: 'update'; epoch: string; sequence: string; desk: string; path: string} |
  {operation: 'stop'; epoch: string; sequence: string}
);
export interface ActivityRow {ship: string; desk: string; path: string}
export type ActivityReply = ActivitySelector & {permissionGranted: false} & (
  {status: 'pending' | 'missing' | 'expired'} |
  {status: 'refused'; reason: string; epoch: null; at: null; rows: []; selfSequence: null} |
  {status: 'ready'; reason: null; epoch: string; at: string; rows: ActivityRow[]; selfSequence: string | null}
);
const schema = 'readymade-editing-activity-result-v1', maxSequence = (1n << 64n) - 1n;
const ship = (v: unknown): v is string => typeof v === 'string' && v.length <= 128 &&
  /^~(?:[a-z]{3}|[a-z]{6}(?:-[a-z]{6}){0,3}(?:--[a-z]{6}(?:-[a-z]{6}){3})?)$/.test(v);
const project = (v: unknown): v is string => typeof v === 'string' && validUnicode(v) &&
  Buffer.byteLength(v) > 0 && Buffer.byteLength(v) <= 128 && !/[\u0000-\u001f\u007f:]/u.test(v);
const desk = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9-]{1,64}$/.test(v);
const filePath = (v: unknown): v is string => typeof v === 'string' && Buffer.byteLength(v) <= 2064 &&
  /^\/(?:app|lib|ted)\/(?:[a-z0-9-]{1,63}\/){1,6}hoon$/.test(v);
function invalid(): never {throw new Error('Invalid or uncorrelated editing activity.');}
function record(v: unknown): JsonObject {
  const r = asRecord(v);
  if (Object.getPrototypeOf(r) !== Object.prototype) invalid();
  return r;
}
function exact(r: JsonObject, keys: string[]): boolean {return Object.keys(r).length === keys.length && keys.every(k => Object.hasOwn(r, k));}
function target(r: JsonObject): ActivityTarget {
  if (!ship(r.owner) || !project(r.project)) invalid();
  return {owner: r.owner, project: r.project};
}
function request(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 64 || !/^0v[1-9a-v][0-9a-v]{0,4}(?:\.[0-9a-v]{5})*$/.test(v)) return false;
  let n = 0n;
  for (const digit of v.slice(2).replaceAll('.', '')) n = n * 32n + BigInt(parseInt(digit, 32));
  return n < (1n << 256n);
}
function sequence(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 26 && /^[1-9][0-9]{0,2}(?:\.[0-9]{3})*$/.test(v) &&
    BigInt(v.replaceAll('.', '')) <= maxSequence;
}

/** Native year/yawn/yule and scot %da rules; no JS Date rounding or local timezone.
 * Formatting uses two-digit calendar/time fields and up to four 16-bit fraction
 * groups, omitting zero trailing groups and the all-zero time component. */
export function dateAtom(v: unknown): bigint {
  if (typeof v !== 'string' || v.length > 64) return invalid();
  const m = /^~([1-9][0-9]{0,11})(-?)\.([0-9]{2})\.([0-9]{2})(?:\.\.([0-9]{2})\.([0-9]{2})\.([0-9]{2})(?:\.\.([0-9a-f]{4}(?:\.[0-9a-f]{4}){0,3}))?)?$/.exec(v);
  if (!m) return invalid();
  const y = 292277024400n + (m[2] ? 1n - BigInt(m[1]) : BigInt(m[1]));
  const month = Number(m[3]), day = Number(m[4]), hour = Number(m[5] ?? 0), minute = Number(m[6] ?? 0), second = Number(m[7] ?? 0);
  const leap = y % 4n === 0n && (y % 100n !== 0n || y % 400n === 0n);
  const months = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 0n || month < 1 || month > 12 || day < 1 || day > months[month - 1] || hour > 23 || minute > 59 || second > 59 ||
      m[8]?.split('.').at(-1) === '0000' || m[5] !== undefined && !hour && !minute && !second && !m[8]) return invalid();
  const days = 365n * y + (y + 3n) / 4n - (y + 99n) / 100n + (y + 399n) / 400n +
    BigInt(months.slice(0, month - 1).reduce((a, b) => a + b, 0) + day - 1);
  const fraction = m[8] ? BigInt('0x' + m[8].replaceAll('.', '').padEnd(16, '0')) : 0n;
  const atom = ((days * 86400n + BigInt(hour * 3600 + minute * 60 + second)) << 64n) + fraction;
  if (atom <= 0n || atom >= (1n << 128n)) return invalid();
  return atom;
}

/** Seconds from the @da epoch to 1970-01-01, as Urbit counts them. */
const UNIX_EPOCH_SECONDS = 0x8000000cce9e0d80n;
/** The moment a ship-printed date names, in milliseconds since 1970. */
export function dateAtomMillis(v: unknown): number {
  const atom = dateAtom(v);
  return Number(((atom >> 64n) - UNIX_EPOCH_SECONDS) * 1000n + (((atom & ((1n << 64n) - 1n)) * 1000n) >> 64n));
}
/** A whole second exactly as a ship prints it (`~2026.11.12..01.00.00`; midnight has no time part). Rounds up. */
export function dateAtomText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0 || ms > 8.64e15) return invalid();
  const d = new Date(Math.ceil(ms / 1000) * 1000), two = (n: number) => String(n).padStart(2, '0');
  const day = `~${d.getUTCFullYear()}.${two(d.getUTCMonth() + 1)}.${two(d.getUTCDate())}`;
  const time = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
  return time.some(Boolean) ? `${day}..${time.map(two).join('.')}` : day;
}

/** Validation constructs a fresh command; it never posts, grants, or retries. */
export function activityCommand(value: unknown): ActivityCommand {
  const r = record(value), base = target(r), common = ['owner', 'project', 'operation'];
  if (r.operation === 'query' && exact(r, common)) return {...base, operation: 'query'};
  if (!['update', 'stop'].includes(String(r.operation)) || !sequence(r.sequence)) return invalid();
  dateAtom(r.epoch);
  const bound = {...base, epoch: r.epoch as string, sequence: r.sequence};
  if (r.operation === 'stop' && exact(r, [...common, 'epoch', 'sequence'])) return {...bound, operation: 'stop'};
  if (r.operation === 'update' && exact(r, [...common, 'epoch', 'sequence', 'desk', 'path']) && desk(r.desk) && filePath(r.path)) {
    return {...bound, operation: 'update', desk: r.desk, path: r.path};
  }
  return invalid();
}
export function activityBody(value: unknown): JsonObject {
  return {schema: 'readymade-editing-activity-v1', ...activityCommand(value)};
}
export function activitySelector(value: unknown): ActivitySelector {
  const r = record(value), base = target(r);
  if (!exact(r, ['owner', 'project', 'request']) || !request(r.request)) return invalid();
  return {...base, request: r.request};
}
export function activityHeaders(value: unknown): Record<string, string> {
  const s = activitySelector(value);
  return {'x-readymade-activity-owner': s.owner, 'x-readymade-project': s.project, 'x-readymade-activity-request': s.request};
}

/** POST accepts only 202 with a fresh native id. GET always requires an exact id.
 * Missing/expired results remain unknown; no outcome or resend authority is inferred.
 * Supply the retained update/stop command to require its exact room epoch. */
export function activityReply(status: number, value: unknown, expected: ActivityTarget | ActivitySelector, command?: ActivityCommand): ActivityReply {
  const wanted = record(expected), context = target(wanted);
  const get = Object.hasOwn(wanted, 'request');
  const selected = get ? activitySelector(expected) : undefined;
  if (!get && (!exact(wanted, ['owner', 'project']) || status !== 202)) return invalid();
  const retained = command && activityCommand(command);
  if (retained && (retained.owner !== context.owner || retained.project !== context.project)) return invalid();
  const r = record(value);
  if (status === 404 || status === 410) {
    if (!selected || !exact(r, ['status', 'reason', 'permissionGranted']) || r.status !== 'unavailable' || r.permissionGranted !== false ||
        r.reason !== (status === 404 ? 'request-not-retained' : 'request-expired-outcome-unknown')) return invalid();
    return {...selected, permissionGranted: false, status: status === 404 ? 'missing' : 'expired'};
  }
  const common = ['schema', 'status', 'permissionGranted', 'owner', 'project', 'request'];
  if (r.schema !== schema || r.permissionGranted !== false || r.owner !== context.owner || r.project !== context.project || !request(r.request) ||
      selected && r.request !== selected.request) return invalid();
  const base = {...context, request: r.request, permissionGranted: false as const};
  if (status === 202 && r.status === 'pending' && exact(r, common)) return {...base, status: 'pending'};
  if (status !== 200 || !selected || !exact(r, [...common, 'reason', 'epoch', 'at', 'rows', 'selfSequence']) || !Array.isArray(r.rows) || r.rows.length > 32) return invalid();
  if (r.status === 'refused') {
    if (typeof r.reason !== 'string' || !/^[a-z0-9-]{1,128}$/.test(r.reason) || r.epoch !== null || r.at !== null || r.selfSequence !== null || r.rows.length) return invalid();
    return {...base, status: 'refused', reason: r.reason, epoch: null, at: null, selfSequence: null, rows: []};
  }
  if (r.status !== 'ready' || r.reason !== null || !(r.selfSequence === null || sequence(r.selfSequence)) || dateAtom(r.at) < dateAtom(r.epoch) ||
      retained && retained.operation !== 'query' && (r.epoch !== retained.epoch || r.selfSequence !== retained.sequence)) return invalid();
  const seen = new Set<string>();
  const rows = r.rows.map(value => {
    const row = record(value);
    if (!exact(row, ['ship', 'desk', 'path']) || !ship(row.ship) || !desk(row.desk) || !filePath(row.path) || seen.has(row.ship)) return invalid();
    seen.add(row.ship);
    return {ship: row.ship, desk: row.desk, path: row.path};
  });
  return {...base, status: 'ready', reason: null, epoch: r.epoch as string, at: r.at as string, selfSequence: r.selfSequence, rows};
}
