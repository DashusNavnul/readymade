import { asRecord, isInteger, isUx, validUnicode } from './protocol';
import {dateAtom} from './editing-activity';

export interface ReviewerAvailability {
  observedAt: string;
  transport: 'subscription' | 'unsupported';
  pairing: 'unobserved' | 'missing' | 'mismatch' | 'active' | 'revoked';
  job: 'none' | 'unobserved' | 'missing' | 'mismatch' | 'queued' | 'claimed' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  liveness: 'unobserved'; authentication: 'unobserved'; quota: 'unobserved';
}

export interface CandidateCampaigns {
  available: boolean;
  restart?: boolean;
  availability?: ReviewerAvailability;
  scope?: {enabled: boolean; generation: string; providerKey: string; provider: string; model: string; binding?: string};
  campaigns: {candidate: string; mode: string; pending: string | null; reason: string; outcome: string; attempt: number; binding?: string; availability?: ReviewerAvailability}[];
}
/** An existing campaign keeps its original reviewer, even when the current policy changes. */
export function candidateReviewer(review: CandidateCampaigns | undefined, candidate: string): ReviewerAvailability | undefined {
  const campaign = review?.campaigns.find(c => c.candidate === candidate);
  return campaign ? campaign.availability : review?.availability;
}
function reviewerAvailability(value: unknown): ReviewerAvailability | undefined {
  if (value === undefined || value === null) return undefined;
  const r = asRecord(value);
  dateAtom(r.observedAt);
  if (r.schema !== 'native-review-availability-v1' || typeof r.transport !== 'string' || !['subscription', 'unsupported'].includes(r.transport) ||
      typeof r.pairing !== 'string' || !['unobserved', 'missing', 'mismatch', 'active', 'revoked'].includes(r.pairing) ||
      typeof r.job !== 'string' || !['none', 'unobserved', 'missing', 'mismatch', 'queued', 'claimed', 'completed', 'failed', 'cancelled', 'unknown'].includes(r.job) ||
      r.liveness !== 'unobserved' || r.authentication !== 'unobserved' || r.quota !== 'unobserved' ||
      r.transport === 'unsupported' && (r.pairing !== 'unobserved' || !['none', 'unobserved'].includes(String(r.job))))
    throw new Error('Invalid reviewer availability.');
  return {observedAt: r.observedAt as string, transport: r.transport as ReviewerAvailability['transport'],
    pairing: r.pairing as ReviewerAvailability['pairing'], job: r.job as ReviewerAvailability['job'],
    liveness: 'unobserved', authentication: 'unobserved', quota: 'unobserved'};
}
/** A fresh native policy still authorizes dispatch; this only selects its explicit recovery operation. */
export function restartCampaign(review: CandidateCampaigns | undefined, candidate: string): string | undefined {
  const c = review?.campaigns.find(c => c.candidate === candidate);
  return review?.restart === true && c?.binding && c.pending === null && c.outcome === '' && c.reason === 'local-review-scope-revoked' ? c.binding : undefined;
}
function text(value: unknown): value is string {
  return typeof value === 'string' && validUnicode(value) && Buffer.byteLength(value) <= 8192;
}
/** Review outcomes describe Viki's review, not proof that Clay has landed code. */
export function candidateCampaigns(value: unknown, project: string, candidates: readonly string[]): CandidateCampaigns | undefined {
  if (value === undefined || value === null) return undefined;
  const r = asRecord(value);
  if (r.schema !== 'native-coding-solo-review-view-v1' || typeof r.available !== 'boolean' || r.restart !== undefined && typeof r.restart !== 'boolean' ||
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
  const availability = reviewerAvailability(r.availability);
  if (availability && (!scope || availability.job !== 'none')) throw new Error('Invalid current reviewer availability.');
  const campaigns = r.campaigns.map(value => {
    const c = asRecord(value);
    if (!isUx(c.candidate) || !candidates.includes(c.candidate) || !['challenge', 'resolve'].includes(String(c.mode)) ||
        !(c.pending === null || isUx(c.pending) && c.pending !== '0x0') || !text(c.reason) ||
        !['', 'challenge', 'accept', 'refuse'].includes(String(c.outcome)) || !isInteger(c.attempt, 0, Number.MAX_SAFE_INTEGER) ||
        (c.binding !== undefined || r.restart === true) && (!isUx(c.binding) || c.binding === '0x0')) throw new Error('Invalid candidate review campaign.');
    const availability = reviewerAvailability(c.availability);
    if (availability && (availability.job === 'none') !== (c.pending === null)) throw new Error('Invalid campaign reviewer availability.');
    return {candidate: c.candidate, mode: String(c.mode), pending: c.pending as string | null, reason: c.reason, outcome: String(c.outcome), attempt: c.attempt, availability,
      ...(c.binding === undefined ? {} : {binding: c.binding as string})};
  });
  if (new Set(campaigns.map(c => c.candidate)).size !== campaigns.length) throw new Error('Duplicate candidate review campaign.');
  return {available: r.available, scope, campaigns, availability, ...(r.restart === undefined ? {} : {restart: r.restart as boolean})};
}
