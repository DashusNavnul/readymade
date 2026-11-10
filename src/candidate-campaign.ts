import { asRecord, isInteger, isUx, validUnicode } from './protocol';

export interface CandidateCampaigns {
  available: boolean;
  scope?: {enabled: boolean; generation: string; providerKey: string; provider: string; model: string; binding?: string};
  campaigns: {candidate: string; mode: string; pending: string | null; reason: string; outcome: string; attempt: number}[];
}
function text(value: unknown): value is string {
  return typeof value === 'string' && validUnicode(value) && Buffer.byteLength(value) <= 8192;
}
/** Review outcomes describe Viki's review, not proof that Clay has landed code. */
export function candidateCampaigns(value: unknown, project: string, candidates: readonly string[]): CandidateCampaigns | undefined {
  if (value === undefined || value === null) return undefined;
  const r = asRecord(value);
  if (r.schema !== 'native-coding-solo-review-view-v1' || typeof r.available !== 'boolean' ||
      (r.available ? r.project !== project : r.project !== '') || !Array.isArray(r.campaigns) || r.campaigns.length > 8) throw new Error('Invalid candidate review process.');
  let scope: CandidateCampaigns['scope'];
  if (r.scope !== null) {
    const s = asRecord(r.scope);
    if (!r.available || s.project !== project || typeof s.enabled !== 'boolean' || typeof s.generation !== 'string' ||
        !/^(?:0|[1-9][0-9]{0,2}(?:\.[0-9]{3})*)$/.test(s.generation) ||
        BigInt(s.generation.replaceAll('.', '')) > 18446744073709551615n ||
        !text(s.providerKey) || !s.providerKey || !text(s.provider) || !text(s.model) ||
        s.binding !== undefined && (!isUx(s.binding) || s.binding === '0x0')) throw new Error('Invalid candidate review scope.');
    scope = {enabled: s.enabled, generation: s.generation, providerKey: s.providerKey, provider: s.provider, model: s.model,
      ...(s.binding === undefined ? {} : {binding: s.binding as string})};
  }
  const campaigns = r.campaigns.map(value => {
    const c = asRecord(value);
    if (!isUx(c.candidate) || !candidates.includes(c.candidate) || !['challenge', 'resolve'].includes(String(c.mode)) ||
        !(c.pending === null || isUx(c.pending) && c.pending !== '0x0') || !text(c.reason) ||
        !['', 'challenge', 'accept', 'refuse'].includes(String(c.outcome)) || !isInteger(c.attempt, 0, Number.MAX_SAFE_INTEGER)) throw new Error('Invalid candidate review campaign.');
    return {candidate: c.candidate, mode: String(c.mode), pending: c.pending as string | null, reason: c.reason, outcome: String(c.outcome), attempt: c.attempt};
  });
  if (new Set(campaigns.map(c => c.candidate)).size !== campaigns.length) throw new Error('Duplicate candidate review campaign.');
  return {available: r.available, scope, campaigns};
}
