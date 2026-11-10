import * as fs from 'node:fs';
import {join} from 'node:path';
import {asRecord, isInteger, isUv, isUx, validUnicode, type CodingSnapshot, type JsonObject} from './protocol';
import {digest, snapshotFrom, sameBasis, sourceBasis, validPath, type SourceSnapshot} from './source-store';
import {codingHistory} from './coding-history';
import {readCheck} from './check-store';
import type {ShipClient} from './ship-client';

type Client = Pick<ShipClient, 'origin' | 'codingState' | 'codingTool'>;
export interface EvaluationIntent {version: 1; id: string; snapshot: SourceSnapshot; project: string; expression: string; fuel: 300000; nonce: string; after: number}
export interface EvaluationRecord extends EvaluationIntent {request?: string; result?: JsonObject; phase: 'unknown' | 'pending' | 'complete'; output?: string}
const clone = <T>(value: T): T => structuredClone(value);
function expression(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !validUnicode(value) || Buffer.byteLength(value) > 8192 || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) throw new Error('Enter a Hoon expression of at most 8 KiB.');
  return value;
}
const command = (i: Pick<EvaluationIntent, 'snapshot' | 'expression' | 'fuel'>) => `/eval ${i.snapshot.path} ${i.fuel}\n${i.expression}`;
function validate(value: unknown): EvaluationIntent {
  const row = asRecord(value), snapshot = snapshotFrom(row.snapshot), text = expression(row.expression);
  if (row.version !== 1 || snapshot.mark !== 'hoon' || snapshot.ship !== snapshot.source.owner ||
      typeof row.project !== 'string' || !row.project || !validUnicode(row.project) || Buffer.byteLength(row.project) > 128 ||
      row.fuel !== 300000 || !isUv(row.nonce) || row.nonce === '0v0' || !isInteger(row.after, 0, 4096)) throw new Error('Invalid saved evaluation.');
  const id = digest(JSON.stringify([snapshot.origin, snapshot.ship, snapshot.session, snapshot.source, snapshot.path, row.project, text, row.nonce]));
  if (row.id !== id) throw new Error('Evaluation identity changed.');
  return {version: 1, id, snapshot, project: row.project, expression: text, fuel: 300000, nonce: row.nonce, after: row.after};
}
/** Presentation only: decode a bounded native jam noun, never execute it. */
export function evaluationValue(detail: string): string {
  const match = /^Result as jam hex: (0x[0-9a-f]{1,4}(?:\.[0-9a-f]{4})*)$/.exec(detail);
  if (!match || match[1].length > 8192) return detail;
  try {
    const atom = BigInt(match[1].replaceAll('.', '')), length = atom.toString(2).length;
    let cursor = 0, nodes = 0; const memo = new Map<number, string>();
    const bits = (count: number): bigint => {if (count < 0 || count > 65536 || cursor + count > length) throw new Error('Truncated noun'); const v = atom >> BigInt(cursor) & ((1n << BigInt(count)) - 1n); cursor += count; return v;};
    const mat = (): bigint => {let width = 0; while (bits(1) === 0n) {if (++width > 16) throw new Error('Large noun');} if (!width) return 0n; return bits(2 ** (width - 1) + Number(bits(width - 1)));};
    const read = (depth: number): string => {
      if (++nodes > 256 || depth > 64) throw new Error('Complex noun'); const at = cursor;
      let value: string;
      if (bits(1) === 0n) value = mat().toString();
      else if (bits(1) === 0n) value = `[${read(depth + 1)} ${read(depth + 1)}]`;
      else {const reference = Number(mat()), known = memo.get(reference); if (known === undefined || reference >= at) throw new Error('Invalid reference'); return known;}
      if (value.length > 8192) throw new Error('Large result'); memo.set(at, value); return value;
    };
    const value = read(0); if (cursor !== length) throw new Error('Trailing noun data'); return value;
  } catch {return detail;}
}
export function evaluationAllowed(state: CodingSnapshot, snapshot: SourceSnapshot, project: string): void {
  const sessions = state.sessions.filter(s => s.id === snapshot.session), projects = state.projects.filter(p => p.id === project);
  if (!state.ready || state.owner !== snapshot.ship || state.session !== snapshot.session || sessions.length !== 1 || sessions[0].project !== project ||
      !sameBasis(snapshot.source, sessions[0].source) || sourceBasis(sessions[0].source).id !== snapshot.source.id || projects.length !== 1 ||
      !Array.isArray(projects[0].operations) || !projects[0].operations.includes('eval')) throw new Error('This exact project/source does not allow evaluation.');
  if (!Array.isArray(state.grants) || !state.grants.some(value => {
    const g = asRecord(value); return isUx(g.id) && g.id !== '0x0' && g.revoked === false && Array.isArray(g.operations) && g.operations.includes('eval') &&
      Array.isArray(g.readable) && g.readable.some(prefix => typeof prefix === 'string' && (prefix === '/' || validPath(prefix) && (snapshot.path === prefix || snapshot.path.startsWith(prefix + '/'))));
  })) throw new Error('This session has no current evaluation grant for this file.');
}
function result(intent: EvaluationIntent, request: string, row: JsonObject): string | undefined {
  if (row.kind !== 'tool' || typeof row.text !== 'string') return;
  let raw: JsonObject; try {raw = asRecord(JSON.parse(row.text));} catch {return;}
  const context = asRecord(raw.context), output = asRecord(raw.output);
  if (raw.version !== 'native-coding-tool-result-v1' || raw.call_id !== request || context.request !== request || context.session !== intent.snapshot.session || context.project !== intent.project || context.actor !== intent.snapshot.ship || !sameBasis(intent.snapshot.source, context.source)) return;
  if (!isUx(row.id) || !isInteger(row.sequence, intent.after, 4096)) throw new Error('Invalid evaluation record.');
  if (output.kind === 'refused') {
    if (typeof output.reason !== 'string' || output.reason.length > 128 || typeof output.detail !== 'string' || Buffer.byteLength(output.detail) > 8192) throw new Error('Malformed native refusal.');
    return `Refused: ${output.reason}\n${output.detail}`;
  }
  const report = readCheck(row, intent.snapshot.ship, intent.snapshot.session, intent.project); if (!report) return;
  const evaluated = report.values.filter(v => v.name === 'eval'), compiled = report.values.filter(v => v.name === 'compile');
  if (compiled.length !== 1 || evaluated.length > 1 || report.values.length !== compiled.length + evaluated.length) throw new Error('Unexpected evaluation diagnostics.');
  if (!compiled[0].passed) return `Compilation failed\n${compiled[0].detail}`;
  if (evaluated.length !== 1) throw new Error('Evaluation result missing.');
  return evaluated[0].passed ? evaluationValue(evaluated[0].detail) : `Evaluation failed\n${evaluated[0].detail}`;
}
/** Immutable per-request intents. Unknown sends block this session across windows and reloads. */
export class EvaluationStore {
  constructor(readonly directory: string) {}
  private secure(file: string, directory = false): void {const s = fs.lstatSync(file); if (s.isSymbolicLink() || !(directory ? s.isDirectory() : s.isFile() && s.nlink === 1) || process.getuid && (s.uid !== process.getuid() || s.mode & 0o077)) throw new Error('Evaluation history must be private and owned.');}
  private ensure(): void {fs.mkdirSync(this.directory, {recursive: true, mode: 0o700}); this.secure(this.directory, true);}
  private read(file: string): unknown {this.secure(file); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try {if (fs.fstatSync(fd).size > 4_194_304) throw new Error('Evaluation history exceeds its bound.'); return JSON.parse(fs.readFileSync(fd, 'utf8'));} finally {fs.closeSync(fd);}}
  private file(id: string, kind: string): string {if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid evaluation ID.'); return join(this.directory, `${id}.${kind}.json`);}
  private write(file: string, value: unknown): void {
    const bytes = JSON.stringify(value); if (Buffer.byteLength(bytes) > 4_194_304) throw new Error('Evaluation exceeds its journal bound.');
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    const directory = fs.openSync(this.directory, fs.constants.O_RDONLY); try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
  }
  get(id: string): EvaluationRecord {
    this.ensure(); const i = validate(this.read(this.file(id, 'intent'))); if (i.id !== id) throw new Error('Saved evaluation filename changed.');
    const receiptFile = this.file(id, 'receipt'), outcomeFile = this.file(id, 'result'); let request: string | undefined;
    if (fs.existsSync(receiptFile)) {const v = asRecord(this.read(receiptFile)); if (!isUx(v.request) || v.request === '0x0' || v.intent !== id) throw new Error('Invalid evaluation receipt.'); request = v.request;}
    if (!fs.existsSync(outcomeFile)) return {...i, request, phase: request ? 'pending' : 'unknown'};
    if (!request) throw new Error('Evaluation receipt missing.'); const row = asRecord(this.read(outcomeFile)), output = result(i, request, row);
    if (output === undefined) throw new Error('Evaluation result is uncorrelated.'); return {...i, request, result: row, output, phase: 'complete'};
  }
  list(): EvaluationRecord[] {this.ensure(); const names = fs.readdirSync(this.directory).filter(n => /^[a-f0-9]{64}\.intent\.json$/.test(n)); if (names.length > 64) throw new Error('Evaluation history is full.'); return names.map(n => this.get(n.slice(0, 64)));}
  async run(client: Client, supplied: SourceSnapshot, project: string, value: string, active = () => true): Promise<EvaluationRecord> {
    const snapshot = snapshotFrom(supplied), text = expression(value);
    if (client.origin !== snapshot.origin || snapshot.mark !== 'hoon') throw new Error('Select an immutable Hoon source on this connection.');
    const state = await codingHistory(client, await client.codingState(snapshot.session)); evaluationAllowed(state, snapshot, project);
    if (!active() || client.origin !== snapshot.origin) throw new Error('Evaluation context changed.');
    const id = digest(JSON.stringify([snapshot.origin, snapshot.ship, snapshot.session, snapshot.source, snapshot.path, project, text, state.nonce]));
    const i = validate({version: 1, id, snapshot, project, expression: text, fuel: 300000, nonce: state.nonce, after: state.after});
    this.ensure(); const lock = join(this.directory, '.claim.lock'), fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600), own = fs.fstatSync(fd);
    try {
      const held = this.list(); if (held.length >= 64 || held.some(r => r.snapshot.origin === snapshot.origin && r.snapshot.ship === snapshot.ship && r.snapshot.session === snapshot.session && r.phase !== 'complete')) throw new Error('Observe the retained evaluation first. Unknown requests are never resent.');
      this.write(this.file(id, 'intent'), i);
    } finally {fs.closeSync(fd); const current = fs.lstatSync(lock); if (current.ino === own.ino && current.dev === own.dev) fs.unlinkSync(lock);}
    // The immutable intent is durable before the only POST. No automatic retry.
    const reply = await client.codingTool(snapshot.session, snapshot.source.id, command(i));
    const receipt = asRecord(reply.commandReceipt);
    if (reply.owner !== snapshot.ship || reply.session !== snapshot.session || receipt.version !== 'native-coding-command-receipt-v1' || receipt.target !== 'viki' || receipt.session !== snapshot.session || receipt.source !== snapshot.source.id || !isUx(receipt.request) || receipt.request === '0x0' || !isUx(receipt.delivery) || reply.delivery !== `${receipt.delivery}: submitted; observing native retention`) throw new Error('Evaluation delivery is unknown. Observe; do not resend.');
    this.write(this.file(id, 'receipt'), {intent: id, request: receipt.request});
    if (!active()) return this.get(id);
    return this.observe(client, id, active);
  }
  async observe(client: Client, id: string, active = () => true): Promise<EvaluationRecord> {
    const row = this.get(id); if (row.phase === 'complete') return clone(row);
    if (client.origin !== row.snapshot.origin) throw new Error('Reconnect to this evaluation’s exact ship.');
    const state = await codingHistory(client, await client.codingState(row.snapshot.session));
    if (!active() || client.origin !== row.snapshot.origin || state.owner !== row.snapshot.ship || state.session !== row.snapshot.session) throw new Error('Evaluation connection changed.');
    if (!row.request) return row; // A lost acceptance response cannot be inferred from similar text.
    const matches = state.records.filter(r => result(row, row.request!, r) !== undefined);
    if (matches.length > 1) throw new Error('Conflicting evaluation results.');
    if (matches.length) {const file = this.file(id, 'result'); if (fs.existsSync(file)) {if (JSON.stringify(this.read(file)) !== JSON.stringify(matches[0])) throw new Error('Native evaluation result changed.');} else this.write(file, matches[0]);}
    return this.get(id);
  }
}
