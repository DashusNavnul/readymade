import { randomBytes } from 'node:crypto';
import { ShipClient, ShipClientError } from './ship-client';
import { JsonObject, asRecord, isUv } from './protocol';

export const terminalApps = ['pataphor-terminal', 'pataphor-terminal-b', 'pataphor-terminal-c', 'pataphor-terminal-d'] as const;
export type TerminalApp = typeof terminalApps[number];
export interface TerminalState {
  phase: number; generation: number; inputNext: number; offset: number; connected: boolean;
  nonce: string; cursor: string; control?: { revision: number; viewer: string };
  driverRevision?: bigint; faultErrno?: number;
}
export interface TerminalOutput { data: Uint8Array; generation: number; offset: number; historical: boolean; reset: boolean }
type Transport = Pick<ShipClient, 'origin' | 'requestJSON'>;
const fail = (message: string): never => { throw new Error(message); };
function integer(value: unknown, max = 0xffffffff): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : fail('Invalid terminal number.');
}
export function terminalState(value: JsonObject): TerminalState {
  const phase = integer(value.phase, 4), generation = integer(value.generation), inputNext = integer(value.inputNext);
  const offset = integer(value.offset, Number.MAX_SAFE_INTEGER);
  if (typeof value.connected !== 'boolean' || !isUv(value.nonce) || value.nonce === '0v0' || !isUv(value.cursor)) fail('Invalid terminal state.');
  const state: TerminalState = { phase, generation, inputNext, offset, connected: value.connected as boolean, nonce: value.nonce as string, cursor: value.cursor as string };
  if (value.control !== undefined) {
    const control = asRecord(value.control);
    if (typeof control.viewer !== 'string' || !/^(?:[a-f0-9]{32})?$/.test(control.viewer)) fail('Invalid terminal controller.');
    state.control = { revision: integer(control.revision), viewer: control.viewer as string };
  }
  if (value.driver !== undefined) {
    const driver = asRecord(value.driver);
    if (typeof driver.revision !== 'string' || !/^(?:0|[1-9][0-9]{0,2}(?:\.[0-9]{3})*)$/.test(driver.revision)) fail('Invalid terminal driver.');
    state.driverRevision = BigInt((driver.revision as string).replaceAll('.', ''));
    if (state.driverRevision > 0xffffffffffffffffn) fail('Invalid terminal driver revision.');
    if (driver.fault !== null) {
      const fault = asRecord(driver.fault);
      if (state.driverRevision === 0n || integer(fault.generation) !== generation) fail('Invalid terminal fault.');
      state.faultErrno = integer(fault.errno);
    }
  }
  return state;
}
function older(next: TerminalState, old: TerminalState): boolean {
  return next.generation < old.generation || !!old.control && (!next.control || next.control.revision < old.control.revision) ||
    next.generation === old.generation && (next.inputNext < old.inputNext || next.phase < old.phase || next.offset < old.offset ||
      old.driverRevision !== undefined && (next.driverRevision === undefined || next.driverRevision < old.driverRevision));
}

/** A view adapter; shell state, grants and execution remain on Urbit. */
export class ShipTerminalSession {
  readonly viewer = randomBytes(16).toString('hex');
  private readonly controlKey = randomBytes(16).toString('hex');
  private readonly path: string;
  state?: TerminalState;
  attached = false; locked = true; closed = false; outcomeUnconfirmed = false;
  notice = 'Observe the terminal before attaching.';
  outputOffset = 0;
  onOutput?: (output: TerminalOutput) => void;
  onChange?: () => void;
  private historyUntil = 0; private epoch = 0; private queueEpoch = 0; private queuedBytes = 0;
  private watcher?: AbortController; private watchEnabled = false;
  private readonly uncertainPackets = new Set<string>();
  private tail: Promise<void> = Promise.resolve(); private inFlight = false; private pending = 0;
  constructor(readonly client: Transport, readonly app: TerminalApp = 'pataphor-terminal') {
    if (!terminalApps.includes(app)) fail('Unknown terminal app.');
    this.path = '/apps/' + app;
  }
  get controlling(): boolean { return this.state?.control?.viewer === this.viewer; }
  get canInput(): boolean { return !this.closed && this.attached && !this.locked && this.controlling && this.state?.connected === true && this.state.phase === 2 && this.state.faultErrno === undefined; }
  async observe(watch = true): Promise<void> {
    if (this.closed || this.inFlight || this.pending) fail('A terminal decision is pending.');
    this.cancelWatch(); this.watchEnabled = watch; this.discard(); this.attached = false; this.locked = true;
    const mine = this.epoch, abort = new AbortController(); this.watcher = abort;
    try {
      const next = terminalState(await this.client.requestJSON(this.path + '/state', { signal: abort.signal }));
      if (this.closed || mine !== this.epoch || !this.apply(next)) fail('Terminal observation changed.');
      this.locked = next.faultErrno !== undefined;
      this.notice = this.outcomeUnconfirmed ? 'Observed current state; earlier delivery remains unconfirmed. Nothing was replayed.' : 'Observing. Attach, then explicitly take control to type.';
      await this.pollOutputOnce(abort.signal);
      this.onChange?.();
      if (watch && !this.closed && mine === this.epoch) this.watch(abort, mine);
    } catch (error) { if (!this.closed && mine === this.epoch) this.lock('Observation failed. Observe again; nothing was replayed.'); throw error; }
  }
  close(): void { this.closed = true; this.cancelWatch(); this.discard(); this.attached = false; this.locked = true; this.onChange?.(); }
  attach(): Promise<void> { return this.action(6); }
  takeControl(): Promise<void> { return this.action(11); }
  release(): Promise<void> { return this.action(12); }
  start(rows = 24, cols = 80): Promise<void> { return this.action(1, { rows, cols }); }
  interrupt(): Promise<void> { return this.action(4); }
  stop(): Promise<void> { this.discard(); return this.action(5); }
  input(value: string | Uint8Array): Promise<void> {
    const data = Buffer.from(value);
    if (!this.canInput || !data.length || this.queuedBytes + data.length > 65536) return Promise.reject(new Error('Terminal input is unavailable or too large.'));
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < data.length; i += 2048) tasks.push(this.action(2, { data: data.subarray(i, i + 2048).toString('base64') }));
    return Promise.all(tasks).then(() => undefined);
  }
  resize(rows: number, cols: number): Promise<void> { return this.action(3, { rows, cols }); }
  async pollOutputOnce(signal?: AbortSignal): Promise<void> {
    const prior = this.state, requested = this.outputOffset, mine = this.epoch;
    try {
      if (this.closed || !prior) fail('Observe the terminal first.');
      const value = await this.client.requestJSON(`${this.path}/events?offset=${requested}&cursor=${prior!.cursor}`, { timeoutMs: 45000, signal });
      if (this.closed || mine !== this.epoch) return;
      const next = terminalState(asRecord(value.state)), offset = integer(value.offset, Number.MAX_SAFE_INTEGER);
      if (typeof value.reset !== 'boolean' || typeof value.data !== 'string' || value.data.length > 2000000) fail('Invalid terminal output.');
      const data = Buffer.from(value.data as string, 'base64');
      if (data.toString('base64') !== value.data || offset !== next.offset || data.length > offset) fail('Invalid terminal output bytes.');
      if (this.state && older(next, this.state)) return;
      if (next.generation !== prior!.generation && requested !== 0) { this.apply(next); return; }
      if (!value.reset && offset - data.length !== requested) fail('Terminal output gap.');
      if (!this.apply(next)) return;
      if (value.reset) this.onOutput?.({ data: new Uint8Array(), generation: next.generation, offset: offset - data.length, historical: true, reset: true });
      const historical = Math.min(data.length, Math.max(0, this.historyUntil - (offset - data.length)));
      if (historical) this.onOutput?.({ data: data.subarray(0, historical), generation: next.generation, offset: offset - data.length + historical, historical: true, reset: false });
      if (historical < data.length) this.onOutput?.({ data: data.subarray(historical), generation: next.generation, offset, historical: false, reset: false });
      this.outputOffset = offset;
    } catch (error) {
      if (!this.closed && !signal?.aborted && mine === this.epoch && error instanceof ShipClientError && error.code === 'pollExpired') return;
      if (!this.closed && !signal?.aborted && mine === this.epoch) this.lock('Terminal output could not be verified. Observe again; nothing was replayed.');
      throw error;
    }
  }
  private watch(abort: AbortController, epoch: number): void {
    void (async () => {
      try {
        while (!this.closed && !abort.signal.aborted && epoch === this.epoch) {
          // Even an immediate empty response must yield; this timer belongs only to the open view.
          await new Promise<void>(resolve => {
            const finish = (): void => { clearTimeout(timer); abort.signal.removeEventListener('abort', finish); resolve(); };
            const timer = setTimeout(finish, 250);
            abort.signal.addEventListener('abort', finish, { once: true }); if (abort.signal.aborted) finish();
          });
          if (this.closed || abort.signal.aborted || epoch !== this.epoch) return;
          await this.pollOutputOnce(abort.signal);
        }
      }
      catch { if (!this.closed && !abort.signal.aborted && epoch === this.epoch) this.lock('Terminal output disconnected. Observe again; nothing was replayed.'); }
    })();
  }
  private cancelWatch(): void { this.epoch++; this.watcher?.abort(); this.watcher = undefined; this.watchEnabled = false; }
  private permitted(kind: number): TerminalState {
    const state = this.state;
    if (this.closed || !state) return fail('Observe the terminal first.');
    if (kind !== 6) {
      if (!this.attached || !state.control || kind !== 11 && !this.controlling || this.locked && !(state.faultErrno !== undefined && ([5, 11, 12].includes(kind) || kind === 1 && state.phase === 4))) fail('Attach and explicitly take control first.');
      if ([2, 3, 4].includes(kind) && !this.canInput) fail('Terminal input is locked.');
      if (kind === 1 && (!state.connected || ![0, 4].includes(state.phase))) fail('The shell is not ready to start.');
      if (kind === 5 && (!state.connected || ![1, 2].includes(state.phase))) fail('The shell is not running.');
    }
    return state;
  }
  private action(kind: number, fields: JsonObject = {}): Promise<void> {
    let captured: TerminalState;
    try {
      if (this.pending >= 64) fail('The terminal action queue is full.');
      captured = this.permitted(kind);
      if ([1, 3].includes(kind) && (!Number.isInteger(fields.rows) || !Number.isInteger(fields.cols) || (fields.rows as number) < 1 || (fields.cols as number) < 1 || (fields.rows as number) > 1000 || (fields.cols as number) > 1000)) fail('Invalid terminal size.');
    } catch (error) { return Promise.reject(error); }
    const mine = this.queueEpoch, bytes = typeof fields.data === 'string' ? Buffer.from(fields.data, 'base64').length : 0;
    this.queuedBytes += bytes; this.pending++;
    const work = this.tail.then(async () => {
      if (mine !== this.queueEpoch) fail('Queued terminal action discarded.');
      const current = this.permitted(kind);
      if (current.generation !== captured.generation || kind !== 6 && current.control?.revision !== captured.control?.revision) fail('Terminal authority changed.');
      const body: JsonObject = { kind, generation: current.generation, sequence: [1, 6, 11, 12].includes(kind) ? 0 : current.inputNext, ...fields };
      if (current.control) Object.assign(body, { viewer: this.viewer, controlKey: this.controlKey, controlRevision: current.control.revision });
      const identity = JSON.stringify([current.nonce, kind, current.generation, body.sequence, current.control?.revision ?? 0]);
      if (kind !== 6 && (this.uncertainPackets.has(identity) || this.uncertainPackets.size >= 16)) {
        this.lock('Earlier terminal packet delivery is unconfirmed. Observe its sequence before another decision.'); fail(this.notice);
      }
      const resume = this.watchEnabled; this.cancelWatch();
      this.inFlight = true;
      try {
        const next = terminalState(await this.client.requestJSON(this.path + '/action', { method: 'POST', body, terminalNonce: current.nonce }));
        if (this.closed || next.generation !== current.generation + (kind === 1 ? 1 : 0)) fail('Terminal acknowledgment changed.');
        if (kind === 11 && (next.control?.viewer !== this.viewer || next.control.revision !== (current.control?.revision ?? 0) + 1)) fail('Invalid control acknowledgment.');
        if (kind === 12 && (next.control?.viewer !== '' || next.control.revision !== (current.control?.revision ?? 0) + 1)) fail('Invalid release acknowledgment.');
        if (![1, 6, 11, 12].includes(kind) && next.inputNext <= current.inputNext) fail('Invalid terminal sequence acknowledgment.');
        if (!this.apply(next, kind)) fail('Stale terminal acknowledgment.');
        if (kind === 6) { this.attached = true; this.locked = next.faultErrno !== undefined; }
        if (kind === 1) this.locked = next.faultErrno !== undefined;
        this.onChange?.();
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (kind !== 6 && !['refused', 'authenticationRequired', 'commandBusy', 'cancelledBeforeSend'].includes(code ?? '')) { this.outcomeUnconfirmed = true; this.uncertainPackets.add(identity); }
        this.lock('Terminal decision failed or is unconfirmed. Queued input discarded; observe before another decision.'); throw error;
      } finally {
        this.inFlight = false;
        if (resume && !this.closed) { this.watchEnabled = true; const abort = new AbortController(); this.watcher = abort; this.watch(abort, this.epoch); }
      }
    });
    const settled = work.finally(() => { this.queuedBytes = Math.max(0, this.queuedBytes - bytes); this.pending--; });
    this.tail = settled.catch(() => undefined); return settled;
  }
  private apply(next: TerminalState, acknowledgment?: number): boolean {
    const old = this.state;
    if (old && older(next, old)) return false;
    if (!old) this.historyUntil = next.offset;
    if (old && old.control?.revision !== next.control?.revision && ![11, 12].includes(acknowledgment ?? 0)) this.lock('Terminal ownership changed. Observe before another decision.');
    if (old && old.generation !== next.generation) {
      this.discard(); this.outputOffset = 0; this.historyUntil = acknowledgment === 1 ? 0 : next.offset;
      this.onOutput?.({ data: new Uint8Array(), generation: next.generation, offset: 0, historical: true, reset: true });
      if (acknowledgment !== 1) this.lock('Terminal generation changed. Observe before another decision.');
    }
    this.state = next;
    if (next.faultErrno !== undefined) { this.outcomeUnconfirmed = true; this.lock('Terminal driver fault. Input is locked.', false); }
    if ((!next.connected || next.phase !== 2) && this.queuedBytes) this.lock('Terminal stopped. Queued input discarded.');
    this.onChange?.(); return true;
  }
  private discard(): void { this.queueEpoch++; }
  private lock(notice: string, detach = true): void { this.locked = true; if (detach) this.attached = false; this.discard(); this.notice = notice; this.onChange?.(); }
}
