import type { ShipClient } from './ship-client';
import { codingHistory } from './coding-history';
import { asRecord, isInteger, isUx, type CodingSnapshot } from './protocol';
import { digest, FILE_LIMIT, sameBasis, sourceBasis, SourceStore, validPath, type SourceProgress, type SourceBasis } from './source-store';

export interface PageJournal {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}
interface Intent { count: number; request?: string; previous?: Intent }
export class PagePendingError extends Error {}
export class PageSizeError extends Error {}
export class PageCancelledError extends Error {}
export class PageRefusedError extends Error {
  constructor(readonly reason: string) {super(`The ship refused this file read: ${reason}.`);}
}
function refusal(state: CodingSnapshot, file: SourceProgress, request: string | undefined): string | undefined {
  if (!request || !isUx(request) || request === '0x0' || state.owner !== file.ship || state.session !== file.session) return;
  const reasons = new Set<string>();
  for (const row of state.records) {
    try {
      if (row.kind !== 'tool' || typeof row.text !== 'string') continue;
      const result = asRecord(JSON.parse(row.text)), context = asRecord(result.context), output = asRecord(result.output);
      if (result.version === 'native-coding-tool-result-v1' && result.call_id === request &&
        context.request === request && context.session === file.session && sameBasis(file.source, context.source) &&
        output.kind === 'refused' && typeof output.reason === 'string' && /^[a-z][a-z0-9-]{0,127}$/.test(output.reason)) reasons.add(output.reason);
    } catch { /* Unbound or malformed evidence cannot settle this request. */ }
  }
  if (reasons.size > 1) throw new Error('Conflicting native file-read refusals.');
  return reasons.values().next().value;
}

/** One explicit page request. A durable pre-send marker prevents replay after a lost reply. */
export class SourcePager {
  private busy = false;
  constructor(private readonly client: Pick<ShipClient, 'origin' | 'codingState' | 'codingTool'>,
    private readonly store: SourceStore, private readonly journal: PageJournal) {}

  async start(session: string, basis: SourceBasis, path: string, project?: string, count = 200, active = () => true): Promise<void> {
    basis = sourceBasis(basis);
    if (!isUx(session) || session === '0x0' || !validPath(path) || !isInteger(count, 1, 200)) throw new Error('Invalid file read.');
    if (this.busy) throw new Error('A file page request is already in progress.');
    this.busy = true;
    try {
      if (this.client.origin !== this.store.origin) throw new Error('File belongs to another connection.');
      const state = await codingHistory(this.client, await this.client.codingState(session)), row = state.sessions.find(s => s.id === session);
      if (state.session !== session || !row || project !== undefined && row.project !== project || !sameBasis(basis, row.source)) throw new Error('File source or project changed.');
      this.store.ingest(state);
      if (this.store.progress().some(p => p.ship === state.owner && p.session === session && sameBasis(basis, p.source) && p.path === path && p.next !== 1)) return;
      const held: SourceProgress = {key: digest(JSON.stringify([this.store.origin, state.owner, session, basis, path])),
        ship: state.owner, session, source: basis, path, blob: '0x0', total: 0, next: 1, lines: 0, bytes: 0};
      await this.send(held, 1, state, count, active);
    } finally { this.busy = false; }
  }

  async next(key: string, project?: string, active = () => true): Promise<void> {
    if (this.busy) throw new Error('A file page request is already in progress.');
    this.busy = true;
    try {
      const held = this.store.progress().find(row => row.key === key);
      if (!held || this.client.origin !== this.store.origin) throw new Error('File belongs to another connection.');
      const state = await codingHistory(this.client, await this.client.codingState(held.session));
      const session = state.sessions.find(row => row.id === held.session);
      if (state.owner !== held.ship || state.session !== held.session || !session ||
          (project !== undefined && session.project !== project) || !sameBasis(held.source, session.source)) {
        throw new Error('File source or project changed. Start a read from the current session.');
      }
      this.store.ingest(state);
      const current = this.store.progress().find(row => row.key === key)!;
      if (current.next === null) return;
      if (current.bytes >= FILE_LIMIT) throw new Error('This file exceeds the 1 MiB source limit.');
      await this.send(held, current.next, state, 200, active);
    } finally { this.busy = false; }
  }
  private async send(held: SourceProgress, start: number, state: CodingSnapshot, count: number, active: () => boolean): Promise<void> {
      if (!active()) throw new PageCancelledError('File reading cancelled.');
      const marker = `readymade.page:${held.key}:${start}`;
      const prior = this.journal.get<Intent>(marker);
      const previousReason = refusal(state, held, prior?.request);
      if (previousReason && previousReason !== 'read-page-too-large') throw new PageRefusedError(previousReason);
      if (prior !== undefined && (!isInteger(prior?.count, 1, 200) || previousReason !== 'read-page-too-large')) {
        throw new PagePendingError('This page was already requested. Refresh to observe its result; it will not be sent again.');
      }
      if (prior?.count === 1) throw new Error('A single line exceeds the ship’s 16,384-byte page limit.');
      const intent: Intent = {count: prior ? Math.min(count, Math.max(1, Math.floor(prior.count / 2))) : count, ...(prior ? {previous: prior} : {})};
      await this.journal.update(marker, intent);
      const result = await this.client.codingTool(held.session, held.source.id, `/read ${held.path} ${start} ${intent.count}`);
      if (result.owner !== held.ship) throw new Error('Ship identity changed after the page request.');
      const receipt = asRecord(result.commandReceipt ?? {});
      if (receipt?.version === 'native-coding-command-receipt-v1' && receipt.target === 'viki' &&
          receipt.session === held.session && receipt.source === held.source.id && isUx(receipt.request) && receipt.request !== '0x0') {
        intent.request = receipt.request; await this.journal.update(marker, intent);
      }
      this.store.ingest(result);
      const reason = refusal(result, held, intent.request);
      if (reason === 'read-page-too-large') throw new PageSizeError('The ship refused this page as too large. Read this file or page again to request fewer lines.');
      if (reason) throw new PageRefusedError(reason);
  }
}
