import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { asRecord, validUnicode, type JsonObject } from './protocol';
import { digest, originOf } from './source-store';
import { observeCompletion, readCompletion, type CompletionContext, type CompletionProposal } from './completion-store';
import { ShipClientError, type ShipClient } from './ship-client';

type Client = Pick<ShipClient, 'origin' | 'codingState' | 'requestJSON' | 'acceptCompletion'> & {assertIdle?(): void};
export interface CompletionIntent {
  version: 1; attempt: string; origin: string; context: CompletionContext; proposal: CompletionProposal; reason: string;
}
export interface CompletionResult { intent: CompletionIntent; receipt?: JsonObject; refusal?: {code: 'refused'; status: number} }
function privateInfo(info: fs.Stats, directory = false): void {
  if (!(directory ? info.isDirectory() : info.isFile()) || info.isSymbolicLink() ||
      process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new Error('Completion journal must be private and owned.');
}
function validate(value: unknown): CompletionIntent {
  const r = asRecord(value), context = asRecord(r.context) as unknown as CompletionContext;
  const p = readCompletion({available: true, session: context.session, campaigns: [], ownerReceipt: null,
    proposal: {ready: true, reason: '', value: r.proposal}}, context).proposal!;
  if (r.version !== 1 || typeof r.origin !== 'string' || originOf(r.origin) !== r.origin ||
      typeof r.attempt !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.attempt) ||
      typeof r.reason !== 'string' || !r.reason.length || !validUnicode(r.reason) || Buffer.byteLength(r.reason) > 8192) throw new Error('Invalid completion intent.');
  return {version: 1, attempt: r.attempt, origin: r.origin, context: {...context}, proposal: p, reason: r.reason};
}
/** Immutable private intent files: exclusive creation is the cross-window no-replay gate. */
export class CompletionJournal {
  constructor(readonly directory: string) {}
  private ensure(): void {
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700}); privateInfo(fs.lstatSync(this.directory), true);
  }
  private key(i: CompletionIntent): string { return digest(JSON.stringify([i.origin, i.context.owner, i.context.project, i.context.session, i.proposal.digest, i.attempt])); }
  private sessionKey(i: CompletionIntent): string { return digest(JSON.stringify([i.origin, i.context.owner, i.context.session])); }
  private read(file: string): unknown {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd); privateInfo(stat);
      if (stat.size > 1048576) throw new Error('Completion journal exceeds its size limit.');
      return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally {fs.closeSync(fd);}
  }
  private create(file: string, value: unknown): void {
    const fd = fs.openSync(file, 'wx', 0o600);
    try {fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    const directory = fs.openSync(this.directory, fs.constants.O_RDONLY);
    try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
  }
  entries(): CompletionResult[] {
    this.ensure(); const files = fs.readdirSync(this.directory).filter(f => f.endsWith('.intent.json'));
    if (files.length > 4096) throw new Error('Completion journal capacity reached.');
    const slots = new Map<string, number[]>();
    const result = files.map(file => {
      const intent = validate(this.read(join(this.directory, file)));
      const match = /^([a-f0-9]{64})\.(0|[1-9][0-9]{0,3})\.intent\.json$/.exec(file);
      if (!match || match[1] !== this.sessionKey(intent)) throw new Error('Completion journal identity changed.');
      slots.set(match[1], [...slots.get(match[1]) ?? [], Number(match[2])]);
      let receipt: JsonObject | undefined;
      try {receipt = this.receipt(intent, this.read(join(this.directory, this.key(intent) + '.receipt.json')));}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      let refusal: CompletionResult['refusal'];
      try {
        const held = asRecord(this.read(join(this.directory, this.key(intent) + '.refusal.json')));
        if (held.intent !== this.key(intent) || held.code !== 'refused' || ![400, 409, 503].includes(Number(held.status)) || typeof held.status !== 'number' || receipt) throw new Error('Invalid completion refusal.');
        refusal = {code: 'refused', status: held.status};
      } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      return {intent, receipt, refusal};
    });
    for (const indices of slots.values()) if (indices.sort((a, b) => a - b).some((n, i) => n !== i)) throw new Error('Completion journal has missing session slots.');
    return result;
  }
  private receipt(intent: CompletionIntent, value: unknown): JsonObject {
    const receipt = readCompletion({available: true, session: intent.context.session, campaigns: [], ownerReceipt: value,
      proposal: {ready: false, reason: 'historical-receipt', value: null}}, intent.context, intent.proposal.digest).ownerReceipt;
    if (!receipt || receipt.reason !== intent.reason) throw new Error('Completion receipt does not match the retained reason.');
    return receipt;
  }
  async recover(client: Client, supplied: CompletionIntent): Promise<CompletionResult> {
    const intent = validate(supplied); this.ensure();
    if (client.origin !== intent.origin) throw new Error('Completion belongs to another ship origin.');
    const retained = this.entries().find(e => this.key(e.intent) === this.key(intent)), held = retained?.intent;
    if (JSON.stringify(held) !== JSON.stringify(intent)) throw new Error('Completion intent changed.');
    if (retained?.refusal) return retained;
    await this.fresh(client, intent.context);
    const observed = await observeCompletion(client, intent.context, intent.proposal.digest);
    if (!observed.ownerReceipt) return {intent};
    const receipt = this.receipt(intent, observed.ownerReceipt), file = join(this.directory, this.key(intent) + '.receipt.json');
    try {this.create(file, receipt);} catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || JSON.stringify(this.receipt(intent, this.read(file))) !== JSON.stringify(receipt)) throw error;
    }
    return {intent, receipt};
  }
  private async fresh(client: Client, context: CompletionContext): Promise<void> {
    const state = await client.codingState(context.session);
    if (state.owner !== context.owner || state.session !== context.session || state.sessions.filter(s => s.id === context.session && s.project === context.project).length !== 1) throw new Error('Completion session context changed.');
  }
  async accept(client: Client, context: CompletionContext, proposal: CompletionProposal, reason: string, consent: boolean): Promise<CompletionResult> {
    const intent = validate({version: 1, attempt: randomUUID(), origin: client.origin, context, proposal, reason});
    if (consent !== true) throw new Error('Explicit owner consent is required.');
    const entries = this.entries();
    if (entries.length >= 4096 || entries.some(e => this.sessionKey(e.intent) === this.sessionKey(intent) &&
        (!e.receipt && !e.refusal || e.receipt && e.intent.proposal.digest === intent.proposal.digest))) throw new Error('Observe the retained completion intent; it will not be submitted again.');
    await this.fresh(client, intent.context);
    const current = await observeCompletion(client, intent.context);
    if (!current.proposal || current.proposal.digest !== intent.proposal.digest || JSON.stringify(current.proposal) !== JSON.stringify(intent.proposal)) throw new Error('Completion proposal changed. Review it again.');
    const freshEntries = this.entries(), sessionEntries = freshEntries.filter(e => this.sessionKey(e.intent) === this.sessionKey(intent));
    if (freshEntries.length >= 4096 || sessionEntries.some(e => !e.receipt && !e.refusal || e.receipt && e.intent.proposal.digest === intent.proposal.digest)) throw new Error('Observe the retained completion intent; it will not be submitted again.');
    // Every proposal for this session competes for the same next immutable slot.
    // Exclusive creation remains atomic across processes; settled slots are never deleted or reused.
    // A client that could not send now would leave a recorded intent that was never sent and is never sent again.
    client.assertIdle?.();
    this.create(join(this.directory, `${this.sessionKey(intent)}.${sessionEntries.length}.intent.json`), intent);
    // A failed send leaves the intent intact. Only exact canonical recovery can settle it.
    try {await client.acceptCompletion(intent.context, intent.proposal.digest, intent.reason, true);}
    catch (error) {
      // Native console returns these JSON failures before producing the dispatch card.
      if (error instanceof ShipClientError && error.code === 'refused' && error.status !== undefined && [400, 409, 503].includes(error.status)) {
        this.create(join(this.directory, this.key(intent) + '.refusal.json'), {intent: this.key(intent), code: 'refused', status: error.status});
        return {intent, refusal: {code: 'refused', status: error.status}};
      }
      throw error;
    }
    return this.recover(client, intent);
  }
}
