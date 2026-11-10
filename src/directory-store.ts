import type { ShipClient } from './ship-client';
import { codingHistory } from './coding-history';
import type { PageJournal } from './source-pager';
import { asRecord, isInteger, isUx, type CodingSnapshot } from './protocol';
import { digest, originOf, sameBasis, sourceBasis, validPath, type SourceBasis } from './source-store';

export interface DirectoryEntry { path: string; mark: string; blob: string }
export interface DirectoryBinding { origin: string; ship: string; session: string; project: string; source: SourceBasis; directory: string }
interface Pending { cursor: number; request?: string }
export interface DirectoryListing {
  binding: DirectoryBinding; entries: DirectoryEntry[]; next: number | null; pending?: Pending;
  refusal?: {request: string; reason: string; detail: string};
}
function pinned(value: DirectoryBinding): DirectoryBinding {
  if (!isUx(value.session) || value.session === '0x0' || !/^~[a-z-]{1,127}$/.test(value.ship) ||
      !/^[a-z][a-z0-9-]{0,127}$/.test(value.project) || value.directory !== '/' && !validPath(value.directory)) throw new Error('Invalid directory binding.');
  return Object.freeze({origin: originOf(value.origin), ship: value.ship, session: value.session, project: value.project,
    source: sourceBasis(value.source), directory: value.directory});
}
function entries(value: unknown, directory: string): DirectoryEntry[] {
  if (!Array.isArray(value) || value.length > 4096) throw new Error('Invalid directory entries.');
  const result = value.map(item => {
    const row = asRecord(item);
    if (typeof row.path !== 'string' || !validPath(row.path) ||
        !row.path.startsWith(directory === '/' ? '/' : directory + '/') ||
        row.mark !== row.path.split('/').at(-1) || !isUx(row.blob) || row.blob === '0x0') throw new Error('Invalid source-bound directory entry.');
    return {path: row.path, mark: row.mark as string, blob: row.blob};
  });
  if (new Set(result.map(row => row.path)).size !== result.length) throw new Error('Duplicate directory paths.');
  return result;
}
function restore(value: unknown, binding: DirectoryBinding): DirectoryListing {
  const row = asRecord(value);
  if (JSON.stringify(row.binding) !== JSON.stringify(binding)) throw new Error('Directory journal binding changed.');
  const files = entries(row.entries, binding.directory);
  if (row.next !== null && (!isInteger(row.next, 0, 4096) || row.next !== files.length)) throw new Error('Invalid directory cursor.');
  let pending: Pending | undefined;
  if (row.pending !== undefined) {
    const held = asRecord(row.pending);
    if (held.cursor !== row.next || !isInteger(held.cursor) || held.request !== undefined && (!isUx(held.request) || held.request === '0x0')) throw new Error('Invalid directory intent.');
    pending = {cursor: held.cursor, ...(held.request ? {request: held.request as string} : {})};
  }
  let refusal: DirectoryListing['refusal'];
  if (row.refusal !== undefined) {
    const held = asRecord(row.refusal);
    if (!isUx(held.request) || held.request === '0x0' || typeof held.reason !== 'string' || !/^[a-z-]{1,128}$/.test(held.reason) ||
        typeof held.detail !== 'string' || held.detail.length > 8192) throw new Error('Invalid directory refusal.');
    refusal = {request: held.request, reason: held.reason, detail: held.detail};
  }
  return {binding, entries: files, next: row.next as number | null, ...(pending ? {pending} : {}), ...(refusal ? {refusal} : {})};
}

/** Lists are observations of one immutable source. Only next() submits a native tool. */
export class DirectoryStore {
  private busy = false;
  constructor(private readonly client: Pick<ShipClient, 'origin' | 'codingState' | 'codingTool'>, private readonly journal: PageJournal) {}
  async open(session: string, project: string, directory = '/'): Promise<DirectoryListing> {
    return this.exclusive(async () => {
    if (!isUx(session) || session === '0x0' || !/^[a-z][a-z0-9-]{0,127}$/.test(project) || directory !== '/' && !validPath(directory)) throw new Error('Invalid directory request.');
    const state = await this.client.codingState(session), row = state.sessions.find(s => s.id === session);
    if (!row || row.project !== project || state.session !== session || !/^~[a-z-]{1,127}$/.test(state.owner)) throw new Error('Project session is unavailable.');
    const binding = pinned({origin: originOf(this.client.origin), ship: state.owner, session, project, source: sourceBasis(row.source), directory});
    const saved = this.journal.get(this.key(binding));
    const listing = saved === undefined ? {binding, entries: [], next: 0} : restore(saved, binding);
    return this.observe(listing, state);
    });
  }
  async refresh(binding: DirectoryBinding): Promise<DirectoryListing> {
    binding = pinned(binding);
    return this.exclusive(async () => {
    const state = await this.fresh(binding);
    return this.observe(this.load(binding), state);
    });
  }
  async next(binding: DirectoryBinding): Promise<DirectoryListing> {
    binding = pinned(binding);
    return this.exclusive(async () => {
      const state = await this.fresh(binding);
      const held = await this.observe(this.load(binding), state);
      if (held.pending) throw new Error('Directory request already sent. Refresh its result; it will not be replayed.');
      if (held.next === null) return held;
      if (held.entries.length >= 4096) throw new Error('Directory browser limit reached: 4,096 files. Open a narrower directory.');
      const issued: DirectoryListing = {...held, pending: {cursor: held.next}};
      await this.save(issued);
      const result = await this.client.codingTool(binding.session, binding.source.id, `/list ${binding.directory} ${held.next} 64`);
      if (result.owner !== binding.ship || result.session !== binding.session) throw new Error('Directory response belongs to another ship or session.');
      const receipt = asRecord(result.commandReceipt ?? {});
      if (receipt.version !== 'native-coding-command-receipt-v1' || receipt.target !== 'viki' || receipt.session !== binding.session ||
          receipt.source !== binding.source.id || !isUx(receipt.request) || receipt.request === '0x0') throw new Error('Directory receipt is missing. Observe before sending anything else.');
      issued.pending!.request = receipt.request; await this.save(issued);
      return this.observe(issued, result);
    });
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('A directory request is already in progress.');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
  private key(binding: DirectoryBinding): string { return 'readymade.directory:' + digest(JSON.stringify(binding)); }
  private load(binding: DirectoryBinding): DirectoryListing {
    const saved = this.journal.get(this.key(binding));
    return saved === undefined ? {binding, entries: [], next: 0} : restore(saved, binding);
  }
  private async save(listing: DirectoryListing): Promise<void> { await this.journal.update(this.key(listing.binding), structuredClone(listing)); }
  private async fresh(binding: DirectoryBinding): Promise<CodingSnapshot> {
    if (this.client.origin !== binding.origin) throw new Error('Directory connection changed.');
    const state = await this.client.codingState(binding.session), row = state.sessions.find(s => s.id === binding.session);
    if (state.owner !== binding.ship || state.session !== binding.session || !row || row.project !== binding.project || !sameBasis(binding.source, row.source)) throw new Error('Directory source or project changed. Open the current source again.');
    return state;
  }
  private async observe(listing: DirectoryListing, state: CodingSnapshot): Promise<DirectoryListing> {
    const pending = listing.pending, binding = listing.binding;
    if (!pending?.request) return listing;
    state = await codingHistory(this.client, state);
    let page: {entries: DirectoryEntry[]; next: number | null} | undefined;
    let refusal: DirectoryListing['refusal'];
    for (const row of state.records) {
      if (row.kind !== 'tool' || typeof row.text !== 'string') continue;
      let result; try { result = asRecord(JSON.parse(row.text)); } catch { continue; }
      const context = asRecord(result.context ?? {});
      if (context.request !== pending.request) continue;
      const output = asRecord(result.output);
      if (result.version !== 'native-coding-tool-result-v1' || result.call_id !== pending.request || context.session !== binding.session ||
          context.project !== binding.project || !sameBasis(binding.source, context.source)) throw new Error('Directory result binding disagrees.');
      if (output.kind === 'refused') {
        const validated = restore({binding, entries: listing.entries, next: listing.next,
          refusal: {request: pending.request, reason: output.reason, detail: output.detail}}, binding).refusal!;
        if (refusal && JSON.stringify(refusal) !== JSON.stringify(validated)) throw new Error('Conflicting directory refusals.');
        refusal = validated; continue;
      }
      const file = asRecord(row.file), projected = asRecord(file.value);
      if (output.kind !== 'list' ||
          file.kind !== 'list' || file.session !== binding.session || file.request !== pending.request || file.callId !== result.call_id ||
          !sameBasis(binding.source, file.source)) throw new Error('Directory result binding disagrees.');
      const files = entries(output.entries, binding.directory);
      if (files.length > 64 || JSON.stringify(files) !== JSON.stringify(entries(projected.entries, binding.directory)) || output.next !== projected.next ||
          output.next !== null && (files.length !== 64 || output.next !== pending.cursor + files.length)) throw new Error('Directory page projections disagree.');
      const candidate = {entries: files, next: output.next as number | null};
      if (page && JSON.stringify(page) !== JSON.stringify(candidate)) throw new Error('Conflicting retained directory pages.');
      page = candidate;
    }
    if (refusal) {
      if (page) throw new Error('Directory result conflicts with its refusal.');
      const refused = {binding, entries: listing.entries, next: listing.next, refusal};
      await this.save(refused); return refused;
    }
    if (!page) return listing;
    const completed = restore({binding, entries: [...listing.entries, ...page.entries], next: page.next}, binding);
    await this.save(completed); return completed;
  }
}
