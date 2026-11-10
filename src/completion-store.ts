import { asRecord, isUv, validJSON, validUnicode, type JsonObject } from './protocol';
import type { ShipClient } from './ship-client';

export interface CompletionContext { owner: string; project: string; session: string }
export interface CompletionProposal extends JsonObject { digest: string; session: string; project: string; objective: string }
export interface CompletionObservation {
  context: CompletionContext; available: boolean; reason: string;
  proposal?: CompletionProposal; ownerReceipt?: JsonObject; campaigns: JsonObject[];
}
/** Canonical, nonzero native 256-bit identifier. No alternate spellings in intent keys. */
export function completionId(value: unknown): value is string {
  return typeof value === 'string' && /^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(value) && value.replaceAll('.', '').length <= 66;
}
function text(value: unknown, limit: number, nonempty = true): value is string {
  return typeof value === 'string' && validUnicode(value) && (!nonempty || value.length > 0) && Buffer.byteLength(value) <= limit;
}
function natural(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,2}(?:\.[0-9]{3})*)$/.test(value) && value.length <= 128;
}
function revision(value: unknown, owner: string): JsonObject {
  const r = asRecord(value);
  if (r.owner !== owner || !text(r.desk, 128) || !natural(r.number) || r.number === '0' ||
      !isUv(r.root) || r.root === '0v0' || !isUv(r.commit) || r.commit === '0v0') throw new Error('Invalid completion revision.');
  return r;
}
export function readCompletion(value: unknown, context: CompletionContext, expected?: string): CompletionObservation {
  if (!completionId(context.session) || !text(context.project, 128) || !/^~[a-z-]{1,127}$/.test(context.owner) ||
      expected !== undefined && !completionId(expected)) throw new Error('Invalid completion context.');
  if (!validJSON(value) || Buffer.byteLength(JSON.stringify(value)) > 1048576) throw new Error('Invalid completion evidence.');
  // Own the projection: a caller cannot change already-reviewed evidence by mutating its response.
  const row = asRecord(JSON.parse(JSON.stringify(value)));
  if (row.session !== context.session || typeof row.available !== 'boolean' || !Array.isArray(row.campaigns) || row.campaigns.length > 32) throw new Error('Completion context changed.');
  const campaigns = row.campaigns.map(item => {
    const c = asRecord(item);
    if (!completionId(c.id) || c.project !== context.project || c.historical !== true || typeof c.reviewReady !== 'boolean' ||
        typeof c.scopeCurrent !== 'boolean' || !['none', 'retained', 'unconfirmed'].includes(String(c.application)) ||
        !(c.applied === null || typeof c.applied === 'boolean') || !text(c.reason, 8192, false)) throw new Error('Invalid retained completion review.');
    if (c.application === 'none') {
      if (c.applied !== false || c.receipt !== null || c.outcome !== null || c.provenance !== null) throw new Error('Contradictory completion application.');
    } else if (c.application === 'unconfirmed') {
      if (c.applied !== null || !completionId(c.receipt) || c.outcome !== null || c.provenance !== null) throw new Error('Contradictory completion application.');
    } else {
      const proof = asRecord(c.provenance);
      if (c.applied !== true || !completionId(c.receipt) || !['complete', 'negative'].includes(String(c.outcome)) ||
          proof.key !== c.receipt || !['judgment', 'proposal', 'scope', 'head', 'projection'].every(k => completionId(proof[k])) ||
          !natural(proof.target) || !text(proof.reason, 8192) || !Array.isArray(proof.admissions) || proof.admissions.length > 128 ||
          !proof.admissions.every(completionId) || (c.outcome === 'complete' ? proof.move !== null : !natural(proof.move))) throw new Error('Unbound completion application.');
    }
    // This reader issues no campaign selector; selected historical proposals require a separate bound read.
    if (c.proposal !== null || !Array.isArray(c.jobs) || c.jobs.length > 5) throw new Error('Unexpected selected review proposal.');
    return c;
  });
  if (new Set(campaigns.map(c => c.id)).size !== campaigns.length) throw new Error('Duplicate completion campaigns.');
  let ownerReceipt: JsonObject | undefined;
  if (row.ownerReceipt !== null) {
    const r = asRecord(row.ownerReceipt);
    if (r.session !== context.session || !completionId(r.key) || !completionId(r.proposal) || !completionId(r.judgment) ||
        r.historical !== true || r.verdict !== 'complete' || !text(r.reason, 8192) || expected !== undefined && r.proposal !== expected) throw new Error('Unbound completion receipt.');
    ownerReceipt = r;
  }
  if (!row.available) {
    if (ownerReceipt || campaigns.length || row.proposal !== undefined) throw new Error('Unavailable completion contains authority.');
    return {context: {...context}, available: false, reason: 'Completion observation unavailable', campaigns};
  }
  const prepared = asRecord(row.proposal);
  if (typeof prepared.ready !== 'boolean' || !text(prepared.reason, 8192, false)) throw new Error('Invalid completion readiness.');
  let proposal: CompletionProposal | undefined;
  if (prepared.ready) {
    const p = asRecord(prepared.value), source = revision(p.source, context.owner), accepted = revision(p.accepted, context.owner);
    if (prepared.reason !== '' || p.tag !== 'native-coding-completion-proposal-v1' || p.session !== context.session || p.project !== context.project ||
        !['digest', 'configuration', 'grant', 'latest', 'head', 'model', 'snapshot'].every(k => completionId(p[k])) ||
        !(p.assignment === null || completionId(p.assignment)) || !text(p.objective, 65536) || source.desk === accepted.desk ||
        !natural(p.sequence) || BigInt(p.sequence.replaceAll('.', '')) < 1n || BigInt(p.sequence.replaceAll('.', '')) > 4096n ||
        !Array.isArray(p.evidence) || !p.evidence.length || p.evidence.length > 128) throw new Error('Invalid exact completion proposal.');
    const evidence = p.evidence.map(asRecord);
    if (!evidence.every(e => ['record', 'tool', 'result'].every(k => completionId(e[k]))) ||
        new Set(evidence.map(e => e.tool)).size !== evidence.length) throw new Error('Invalid completion evidence join.');
    proposal = p as CompletionProposal;
  } else if (prepared.value !== null || !prepared.reason) throw new Error('Refused completion has a proposal.');
  return {context: {...context}, available: true, reason: prepared.reason, proposal, ownerReceipt, campaigns};
}

/** Historical receipt recovery is a GET for the exact digest, never an acceptance retry. */
export async function observeCompletion(client: Pick<ShipClient, 'requestJSON'>, context: CompletionContext, expected?: string): Promise<CompletionObservation> {
  if (!completionId(context.session) || expected !== undefined && !completionId(expected)) throw new Error('Invalid completion identifier.');
  const path = `/apps/pataphor-native/coding/completion?session=${context.session}${expected ? `&proposal=${expected}` : ''}`;
  return readCompletion(await client.requestJSON(path), context, expected);
}
