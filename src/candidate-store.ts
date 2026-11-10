import type { ShipClient } from './ship-client';
import { candidateCampaigns, type CandidateCampaigns } from './candidate-campaign';
import { asRecord, isInteger, isUx, validUnicode } from './protocol';
import { sourceBasis, validPath, type SourceBasis } from './source-store';

export interface CandidateReview {
  id: string; session: string; request: string; actor: string; stage: string; decision: string;
  basis: SourceBasis; landed?: SourceBasis; workspace: string; artifact: string; reason: string;
  edits: {path: string; kind: string; before: string; after: string}[];
  checks: {target: string; check: string; passed: boolean; detail: string}[];
  checkCount: number; checksTruncated: boolean;
}
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && validUnicode(value) && Buffer.byteLength(value) <= limit;
}
function id(value: unknown): value is string { return isUx(value) && value !== '0x0'; }

/** Native summary only: clipped details and a bounded list never authorize acceptance. */
export function readCandidate(value: unknown, owner: string, session: string): CandidateReview {
  const r = asRecord(value), basis = sourceBasis(r.basis);
  if (!id(r.id) || !id(r.request) || r.session !== session || !id(session) || r.actor !== owner || basis.owner !== owner ||
      r.sourceId !== basis.id || r.source !== basis.number.toLocaleString('en-US').replaceAll(',', '.') ||
      !['requested', 'cloning', 'staging', 'checking', 'review', 'landing', 'applied', 'refused', 'unknown'].includes(String(r.stage)) ||
      !['pending', 'approve', 'revise', 'refuse'].includes(String(r.decision)) ||
      !text(r.workspace, 8192) || !text(r.artifact, 65536) || !text(r.reason, 8192) ||
      !Array.isArray(r.edits) || !r.edits.length || r.edits.length > 4096 ||
      !isInteger(r.checkCount, 0, 1000000) || !Array.isArray(r.checks) || r.checks.length !== Math.min(r.checkCount, 8)) throw new Error('Invalid native candidate review.');
  const edits = r.edits.map(value => {
    const e = asRecord(value);
    if (typeof e.path !== 'string' || !validPath(e.path) || !['add', 'modify', 'delete'].includes(String(e.kind)) ||
        !(e.before === '' || id(e.before)) || !(e.after === '' || id(e.after)) ||
        (e.kind === 'add' ? e.before !== '' || e.after === '' : e.kind === 'delete' ? e.before === '' || e.after !== '' : e.before === '' || e.after === '')) throw new Error('Invalid candidate edit.');
    return {path: e.path, kind: String(e.kind), before: e.before as string, after: e.after as string};
  });
  if (new Set(edits.map(e => e.path)).size !== edits.length) throw new Error('Duplicate candidate paths.');
  const checks = r.checks.map(value => {
    const c = asRecord(value);
    if (!text(c.target, 131072) || !text(c.check, 131072) || typeof c.passed !== 'boolean' || !text(c.detail, 512)) throw new Error('Invalid candidate check.');
    return {target: c.target, check: c.check, passed: c.passed, detail: c.detail};
  });
  const landed = r.landed === null ? undefined : sourceBasis(r.landed);
  if (landed && (r.stage !== 'applied' || r.decision !== 'approve' || landed.owner !== owner || landed.desk !== basis.desk || landed.number !== basis.number + 1) || r.stage === 'applied' && !landed) throw new Error('Unbound landed candidate.');
  return {id: r.id, session, request: r.request, actor: owner, stage: String(r.stage), decision: String(r.decision), basis, landed,
    workspace: r.workspace, artifact: r.artifact, reason: r.reason, edits, checks, checkCount: r.checkCount, checksTruncated: r.checkCount > checks.length};
}

export async function observeCandidates(client: Pick<ShipClient, 'codingState'>, session: string, project: string): Promise<{owner: string; project: string; session: string; candidates: CandidateReview[]; possiblyTruncated: boolean; review?: CandidateCampaigns}> {
  const state = await client.codingState(session);
  const selected = state.sessions.filter(s => s.id === session && s.project === project);
  if (state.session !== session || selected.length !== 1 || !Array.isArray(state.reviews) || state.reviews.length > 8) throw new Error('Candidate review scope unavailable.');
  const candidates = state.reviews.map(r => readCandidate(r, state.owner, session));
  if (new Set(candidates.map(c => c.id)).size !== candidates.length) throw new Error('Duplicate native candidates.');
  const review = candidateCampaigns(state.soloReview, project, candidates.map(c => c.id));
  return {owner: state.owner, project, session, candidates, possiblyTruncated: candidates.length === 8, review};
}
