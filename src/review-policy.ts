import { asRecord, isUx, validUnicode, type CodingSnapshot, type JsonObject } from './protocol';
import { candidateCampaigns, type CandidateCampaigns } from './candidate-campaign';

export interface ReviewProvider {key: string; binding: string; provider: string; model: string}
export interface ReviewPolicy {scope?: CandidateCampaigns['scope']; providers: ReviewProvider[]; possiblyTruncated: boolean}
export interface ReviewPolicyChange {previous: string; provider?: ReviewProvider}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && validUnicode(value) && Buffer.byteLength(value) <= 8192;
}
function digest(value: unknown): value is string {
  return isUx(value) && /^0x[1-9a-f]/.test(value) && value.replaceAll('.', '').length <= 66;
}
/** Provider binding identifies the complete native selection, not just its model label. */
export function reviewProvider(value: unknown): ReviewProvider {
  const r = asRecord(value);
  if (!text(r.key) || !/^[A-Za-z0-9_-]{1,64}$/.test(r.key) || !digest(r.binding) || !text(r.provider) || !text(r.model) ||
      Buffer.byteLength(r.model) > 256) throw new Error('Invalid native reviewer selection.');
  return {key: r.key, binding: r.binding, provider: r.provider, model: r.model};
}
export function reviewGeneration(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,2}(?:\.[0-9]{3})*)$/.test(value) ||
      value.length > 26 || BigInt(value.replaceAll('.', '')) >= 18446744073709551615n) throw new Error('Invalid review policy generation.');
  return value;
}
export function reviewPolicy(state: CodingSnapshot, session: string, project: string): ReviewPolicy {
  if (state.session !== session || !isUx(session) || session === '0x0' ||
      state.sessions.filter(s => s.id === session && s.project === project).length !== 1) throw new Error('Review policy context changed.');
  const raw = asRecord(state.soloReview);
  // Configuration does not depend on the bounded candidate summary.
  const parsed = candidateCampaigns({...raw, campaigns: []}, project, []);
  if (!parsed?.available || !Array.isArray(raw.providers) || raw.providers.length > 64) throw new Error('Native review configuration unavailable.');
  const providers = raw.providers.map(reviewProvider);
  if (new Set(providers.map(p => p.key)).size !== providers.length) throw new Error('Duplicate native reviewer selection.');
  return {scope: parsed.scope, providers, possiblyTruncated: providers.length === 64};
}
/** Revalidate the confirmed selection against the latest snapshot before forming a command. */
export function reviewPolicyCommand(state: CodingSnapshot, session: string, project: string, change: ReviewPolicyChange, consent: boolean): JsonObject {
  if (consent !== true) throw new Error('Explicit review policy confirmation is required.');
  const policy = reviewPolicy(state, session, project), previous = reviewGeneration(change.previous);
  if ((policy.scope?.generation ?? '0') !== previous) throw new Error('Review policy changed. Observe it again.');
  if (change.provider !== undefined) {
    const provider = reviewProvider(change.provider);
    if (['unknown', 'model-unreported'].includes(provider.model)) throw new Error('Reviewer model identity is unavailable.');
    if (!policy.providers.some(p => JSON.stringify(p) === JSON.stringify(provider))) throw new Error('Reviewer selection changed. Observe it again.');
    return {kind: 'solo-review-enable', session, project, previous, providerKey: provider.key, binding: provider.binding, consent: true};
  }
  if (!policy.scope?.enabled) throw new Error('Review policy is not enabled.');
  return {kind: 'solo-review-disable', session, project, previous};
}
