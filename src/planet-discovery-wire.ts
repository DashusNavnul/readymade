import * as net from 'node:net';
import {randomInt} from 'node:crypto';
export type NativeQuery = 'identity' | 'live' | 'http' | 'real';
export const LOCAL_OBSERVATION_TIMEOUT_MS = 5000;
export interface NativeReality {ship: string; fake: boolean}
export type NativeObservationReason = 'timeout' | 'connection' | 'frame-or-decode' | 'envelope';
export class NativeObservationFailure extends Error {
  constructor(readonly reason: NativeObservationReason) {super('Local planet observation unavailable.'); this.name = 'NativeObservationFailure';}
}
type Noun = bigint | [Noun, Noun];
const MAX = 65536;
function need(ok: unknown): asserts ok {if (!ok) throw Error('Local planet observation unavailable.');}
const atom = (s: string): bigint => s ? BigInt('0x' + Buffer.from(s).reverse().toString('hex')) : 0n;
const tuple = (...values: Noun[]): Noun => values.slice(0, -1).reduceRight<Noun>((tail, head) => [head, tail], values.at(-1)!);
function parts(noun: Noun, length: number): Noun[] {
  const result: Noun[] = [];
  for (let i = 1; i < length; i++) {need(Array.isArray(noun)); result.push(noun[0]); noun = noun[1];}
  return [...result, noun];
}
function text(noun: Noun): string {
  need(typeof noun === 'bigint' && noun > 0n);
  let hex = noun.toString(16); need(hex.length <= 512); if (hex.length % 2) hex = '0' + hex;
  const bytes = Buffer.from(hex, 'hex').reverse(), s = bytes.toString('utf8');
  need(Buffer.from(s).equals(bytes) && !/[\x00-\x20\x7f-\x9f]/u.test(s)); return s;
}
function jam(noun: Noun): Buffer {
  const bits: number[] = [], pending: {value: Noun; depth: number}[] = [{value: noun, depth: 0}];
  const put = (n: bigint, width: number) => {for (let i = 0; i < width; i++) bits.push(Number(n >> BigInt(i) & 1n));};
  let nodes = 0;
  while (pending.length) {
    const {value, depth} = pending.pop()!; need(++nodes <= 8192 && depth <= 128);
    if (Array.isArray(value)) {bits.push(1, 0); pending.push({value: value[1], depth: depth + 1}, {value: value[0], depth: depth + 1});}
    else {
      need(value >= 0n); bits.push(0);
      if (value === 0n) bits.push(1);
      else {const width = value.toString(2).length, size = width.toString(2).length; bits.push(...Array<number>(size).fill(0), 1); put(BigInt(width), size - 1); put(value, width);}
    }
    need(bits.length <= (MAX - 5) * 8);
  }
  const frame = Buffer.alloc(5 + Math.ceil(bits.length / 8)); frame.writeUInt32LE(frame.length - 5, 1);
  bits.forEach((bit, i) => {frame[5 + (i >> 3)] |= bit << (i % 8);}); return frame;
}
function cue(frame: Buffer): Noun {
  need(Buffer.isBuffer(frame) && frame.length >= 6 && frame.length <= MAX && frame[0] === 0 && frame.readUInt32LE(1) === frame.length - 5);
  const data = frame.subarray(5), memo = new Map<number, Noun>(), stack: {at: number; head?: Noun}[] = [];
  let cursor = 0, nodes = 0;
  const bits = (count: number): bigint => {
    need(Number.isSafeInteger(count) && count >= 0 && count <= data.length * 8 - cursor);
    if (!count) return 0n;
    const start = cursor; cursor += count;
    const bytes = Buffer.from(data.subarray(start >> 3, Math.ceil(cursor / 8))).reverse();
    return BigInt('0x' + bytes.toString('hex')) >> BigInt(start % 8) & ((1n << BigInt(count)) - 1n);
  };
  const mat = (): bigint => {let width = 0; while (bits(1) === 0n) need(++width < 20); return width ? bits(2 ** (width - 1) + Number(bits(width - 1))) : 0n;};
  for (;;) {
    need(++nodes <= 8192); const at = cursor; let value: Noun;
    if (bits(1) === 0n) {value = mat(); memo.set(at, value);}
    else if (bits(1) === 0n) {need(stack.length < 128); stack.push({at}); continue;}
    else {const ref = mat(); need(ref < BigInt(at) && memo.has(Number(ref))); value = memo.get(Number(ref))!;}
    while (stack.length && stack.at(-1)!.head !== undefined) {const parent = stack.pop()!; value = [parent.head!, value]; memo.set(parent.at, value);}
    if (!stack.length) {const remaining = data.length * 8 - cursor; need(remaining < 8 && bits(remaining) === 0n); return value;}
    stack.at(-1)!.head = value;
  }
}
function valid(query: NativeQuery, id: number): void {need(['identity', 'live', 'http', 'real'].includes(query) && Number.isSafeInteger(id) && id >= 0 && id <= 0xffffffff);}
export function encodeQuery(query: NativeQuery, id: number): Buffer {
  valid(query, id);
  const request = query === 'real' ? tuple(BigInt(id), atom('peek'), tuple(1n, atom('once'), atom('j'), atom('fake'), 0n)) :
    tuple(BigInt(id), atom('peel'), query === 'http' ? tuple(atom('port'), atom('http'), 0n) : [atom(query === 'identity' ? 'who' : 'live'), 0n]);
  return jam(request);
}
export function decodeQuery(query: 'real', id: number, frame: Buffer): NativeReality;
export function decodeQuery(query: Exclude<NativeQuery, 'real'>, id: number, frame: Buffer): bigint;
export function decodeQuery(query: NativeQuery, id: number, frame: Buffer): bigint | NativeReality;
export function decodeQuery(query: NativeQuery, id: number, frame: Buffer): bigint | NativeReality {
  let reason: NativeObservationReason = 'frame-or-decode';
  try {
  valid(query, id); const noun = cue(frame); reason = 'envelope';
  if (query !== 'real') {
    const [rid, unit, value] = parts(noun, 3); need(rid === BigInt(id) && unit === 0n && typeof value === 'bigint');
    if (query === 'live') need(value === 0n || value === 1n);
    if (query === 'http') need(value > 0n && value <= 65535n);
    return value;
  }
  const [rid, kind, unit, omen, location, mark, value] = parts(noun, 7);
  need(rid === BigInt(id) && kind === atom('peek') && unit === 0n && omen === atom('omen') && mark === atom('noun') && (value === 0n || value === 1n));
  const [vane, ship, view, timestamp, end] = parts(location, 5);
  need(vane === atom('j') && view === atom('fake') && end === 0n);
  const name = text(ship), date = text(timestamp);
  need(/^~(?:[a-z]{3}|[a-z]{6}(?:-[a-z]{6}){0,3}(?:--[a-z]{6}(?:-[a-z]{6}){3})?)(?![\s\S])/.test(name));
  need(/^~[0-9]+\.[0-9]+\.[0-9]+\.\.[0-9]{2}\.[0-9]{2}\.[0-9]{2}(?:\.\.[a-f0-9]{4}(?:\.[a-f0-9]{4})*)?(?![\s\S])/.test(date));
  return {ship: name, fake: value === 0n};
  } catch {throw new NativeObservationFailure(reason);}
}
/** The ship's own strand renders its own login code; nothing else is read and nothing is written. */
const LOGIN_CODE_STRAND = `=/  m  (strand ,vase)
;<  b=bowl  bind:m  get-bowl
?>  =(our.b src.b)
;<  code=@p  bind:m  (scry @p /j/code/(scot %p our.b))
(pure:m !>((crip (slag 1 (scow %p code)))))
`;
export function encodeLoginCodeRequest(id: number): Buffer {
  need(Number.isSafeInteger(id) && id >= 0 && id <= 0xffffffff);
  return jam(tuple(BigInt(id), atom('fyrd'), atom('base'), atom('khan-eval'), atom('noun'), atom('ted-eval'), atom(LOGIN_CODE_STRAND)));
}
export function decodeLoginCode(id: number, frame: Buffer): string {
  let reason: NativeObservationReason = 'frame-or-decode';
  try {
    const noun = cue(frame); reason = 'envelope';
    const [rid, kind, failed, mark, value] = parts(noun, 5);
    need(rid === BigInt(id) && kind === atom('avow') && failed === 0n && mark === atom('noun'));
    const code = text(value); need(/^[a-z]{6}(?:-[a-z]{6}){3}(?![\s\S])/.test(code)); return code;
  } catch {throw new NativeObservationFailure(reason);}
}
/**
 * The doctor's read-only strand: the kelvin, the count of pending timers, and who set the ones due within
 * five minutes. One Behn scry that exists on every kernel; nothing is written and no agent is asked.
 */
const DOCTOR_STRAND = `=/  m  (strand ,vase)
;<  b=bowl  bind:m  get-bowl
?>  =(our.b src.b)
=/  timers=(list [@da duct])  .^((list [@da duct]) %bx /(scot %p our.b)//(scot %da now.b)/debug/timers)
=/  soon=(list [@da duct])  (scag 128 (skim timers |=([d=@da *] (lth d (add now.b ~m5)))))
=/  rows=(list @t)
  %+  turn  soon
  |=  [d=@da =duct]
  =/  who=@t
    ?~  duct  'unknown'
    =/  w=path  i.duct
    ?:  ?=([%gall %use @ *] w)  i.t.t.w
    ?~(w 'unknown' i.w)
  (rap 3 ~[(scot %ud (div (sub (max d now.b) now.b) ~s1)) ':' who])
(pure:m !>((rap 3 (join ' ' \`(list @t)\`[(scot %ud zuse) (scot %ud (lent timers)) rows]))))
`;
export function encodeDoctorRequest(id: number): Buffer {
  need(Number.isSafeInteger(id) && id >= 0 && id <= 0xffffffff);
  return jam(tuple(BigInt(id), atom('fyrd'), atom('base'), atom('khan-eval'), atom('noun'), atom('ted-eval'), atom(DOCTOR_STRAND)));
}
export function decodeDoctorReading(id: number, frame: Buffer): string {
  let reason: NativeObservationReason = 'frame-or-decode';
  try {
    const noun = cue(frame); reason = 'envelope';
    const [rid, kind, failed, mark, value] = parts(noun, 5);
    need(rid === BigInt(id) && kind === atom('avow') && failed === 0n && mark === atom('noun'));
    need(typeof value === 'bigint' && value > 0n);
    let hex = value.toString(16); need(hex.length <= 32768); if (hex.length % 2) hex = '0' + hex;
    const reading = Buffer.from(hex, 'hex').reverse().toString('latin1'); need(/^[0-9a-z.: -]+(?![\s\S])/.test(reading)); return reading;
  } catch {throw new NativeObservationFailure(reason);}
}
/** One request, one bounded reply, no retry. */
function exchange<T>(socket: string, request: Buffer, decode: (frame: Buffer) => T, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!(typeof socket === 'string' && socket.startsWith('/') && Buffer.byteLength(socket) < 104 && !/[\x00-\x1f\x7f]/.test(socket))) {reject(new NativeObservationFailure('connection')); return;}
    if (signal?.aborted) {reject(new NativeObservationFailure('connection')); return;}
    let connection: net.Socket;
    try {connection = net.createConnection({path: socket});} catch {reject(new NativeObservationFailure('connection')); return;}
    let data = Buffer.alloc(0), settled = false;
    const finish = (value?: {value: T}, reason: NativeObservationReason = 'connection') => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); connection.destroy();
      if (value !== undefined) resolve(value.value); else reject(new NativeObservationFailure(reason));
    };
    const abort = () => finish(), timer = setTimeout(() => finish(undefined, 'timeout'), LOCAL_OBSERVATION_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, {once: true});
    connection.once('connect', () => {if (!settled) connection.write(request);});
    connection.on('error', abort); connection.once('end', () => finish(undefined, data.length ? 'frame-or-decode' : 'connection'));
    connection.on('data', chunk => {
      if (settled) return;
      try {
        need(data.length + chunk.length <= MAX); data = Buffer.concat([data, chunk]);
        if (data.length < 5) return;
        const size = data.readUInt32LE(1) + 5; need(data[0] === 0 && size >= 6 && size <= MAX && data.length <= size);
        if (data.length === size) finish({value: decode(data)});
      } catch (error) {finish(undefined, error instanceof NativeObservationFailure ? error.reason : 'frame-or-decode');}
    });
  });
}
/**
 * Ask a ship running on this computer for its own web login code over its owner-only native socket.
 * The caller must already have verified the socket's ship; the code is returned, never logged or stored here.
 */
export function queryLoginCode(socket: string, signal?: AbortSignal): Promise<string> {
  const id = randomInt(0x100000000);
  return Promise.resolve().then(() => exchange(socket, encodeLoginCodeRequest(id), frame => decodeLoginCode(id, frame), signal));
}
/** Ask a ship running on this computer for the doctor's reading over its owner-only socket. Read-only. */
export function queryDoctorReading(socket: string, signal?: AbortSignal): Promise<string> {
  const id = randomInt(0x100000000);
  return Promise.resolve().then(() => exchange(socket, encodeDoctorRequest(id), frame => decodeDoctorReading(id, frame), signal));
}
export function queryNative(socket: string, query: 'real', signal?: AbortSignal): Promise<NativeReality>;
export function queryNative(socket: string, query: Exclude<NativeQuery, 'real'>, signal?: AbortSignal): Promise<bigint>;
export function queryNative(socket: string, query: NativeQuery, signal?: AbortSignal): Promise<bigint | NativeReality>;
export function queryNative(socket: string, query: NativeQuery, signal?: AbortSignal): Promise<bigint | NativeReality> {
  const id = randomInt(0x100000000);
  // Inside the promise chain: an invalid query rejects, as it did before the exchange was shared.
  return Promise.resolve().then(() => exchange(socket, encodeQuery(query, id), frame => decodeQuery(query, id, frame), signal));
}
