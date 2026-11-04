export type JsonObject = Record<string, unknown>;

export function asRecord(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid native JSON object.');
  return value as JsonObject;
}
export function isInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
export function isUx(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 82 && /^0x[0-9a-f]{1,4}(?:\.[0-9a-f]{4})*$/.test(value);
}
export function isUv(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && /^0v[0-9a-v]{1,5}(?:\.[0-9a-v]{5})*$/.test(value);
}
export function validUnicode(value: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
export function exactUTF8(left: string, right: string): boolean {
  return validUnicode(left) && validUnicode(right) && Buffer.from(left, 'utf8').equals(Buffer.from(right, 'utf8'));
}
export interface CodingSnapshot extends JsonObject {
  nonce: string; cursor: string; session: string; owner: string; ready: boolean; after: number;
  projects: JsonObject[]; sessions: JsonObject[]; records: JsonObject[]; reviews?: JsonObject[];
}
export function codingSnapshot(value: unknown): CodingSnapshot {
  const row = asRecord(value);
  if (!isUv(row.nonce) || !isUx(row.cursor) || !isUx(row.session) || typeof row.owner !== 'string' ||
      !/^~[a-z-]{1,127}$/.test(row.owner) || typeof row.ready !== 'boolean' || !isInteger(row.after, 0, 4096)) {
    throw new TypeError('Invalid native coding snapshot.');
  }
  for (const field of ['projects', 'sessions', 'records', ...(row.reviews === undefined ? [] : ['reviews'])]) {
    if (!Array.isArray(row[field])) throw new TypeError('Invalid native coding rows.');
    (row[field] as unknown[]).forEach(asRecord);
  }
  return row as CodingSnapshot;
}
/** Refuse JSON overflow/precision loss and ill-formed Unicode before presentation or submission. */
export function validJSON(value: unknown): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (typeof value === 'string') return validUnicode(value);
  if (Array.isArray(value)) return value.every(validJSON);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.entries(value).every(([key, item]) => validUnicode(key) && validJSON(item));
  }
  return false;
}
