import type { ShipClient } from './ship-client';
import { candidateCampaigns, type CandidateCampaigns } from './candidate-campaign';
import { asRecord, isInteger, isUx, validUnicode } from './protocol';
import { sourceBasis, validPath, type SourceBasis } from './source-store';
import {dateAtom} from './editing-activity';

export interface CandidateReview {
  id: string; session: string; request: string; actor: string; stage: string; decision: string;
  basis: SourceBasis; landed?: SourceBasis; workspace: string; artifact: string; reason: string;
  edits: {path: string; kind: string; before: string; after: string; preview?: {schema: 'native-coding-candidate-text-v1'; original: string; proposed: string}}[];
  checks: {target: string; check: string; passed: boolean; detail: string}[];
  checkCount: number; checksTruncated: boolean;
}
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && validUnicode(value) && Buffer.byteLength(value) <= limit;
}
function id(value: unknown): value is string { return isUx(value) && value !== '0x0'; }

export interface CheckSlotBlocker {
  candidate: string; session: string; request: string; stage: string; reason: string | null;
  worker: {request: string; ticket: string; ship: string; sent: boolean; phase: string; resultPresent: boolean; resultReason: string | null} | null;
}
export interface CheckSlot {
  status: 'unknown' | 'free' | 'blocked'; notice: string; observedAt?: string;
  blockerCount: number | null; blockers: CheckSlotBlocker[]; truncated: boolean;
}
/** Invalid or absent evidence never becomes an empty/free slot. */
export function readCheckSlot(value: unknown, owner: string): CheckSlot {
  const unknown = (notice: string): CheckSlot => ({status: 'unknown', notice, blockerCount: null, blockers: [], truncated: false});
  if (value === undefined) return unknown('This backend does not report the canonical check-slot occupant.');
  try {
    const r = asRecord(value);
    if (r.schema !== 'native-coding-check-slot-v1' || r.owner !== owner || typeof r.available !== 'boolean' ||
        typeof r.truncated !== 'boolean' || !Array.isArray(r.blockers)) throw new Error();
    dateAtom(r.observedAt);
    if (!r.available) {
      if (r.condition !== 'unknown' || r.blockerCount !== null || r.blockers.length || r.truncated) throw new Error();
      return {...unknown('The ship could not read its canonical check-slot evidence.'), observedAt: r.observedAt as string};
    }
    if (!isInteger(r.blockerCount, 0, 512) || r.blockers.length !== Math.min(r.blockerCount, 32) ||
        r.truncated !== (r.blockerCount > 32) || r.condition !== (r.blockerCount === 0 ? 'free' : 'blocked')) throw new Error();
    const reason = (v: unknown): string | null => {
      if (v === null) return null;
      if (!text(v, 128) || !v || !/^[a-z][a-z0-9-]*$/.test(v)) throw new Error();
      return v;
    };
    const blockers = r.blockers.map(value => {
      const b = asRecord(value);
      if (!id(b.candidate) || !id(b.session) || !id(b.request) || !['cloning', 'staging', 'checking', 'landing', 'unknown'].includes(String(b.stage))) throw new Error();
      const why = reason(b.reason);
      if (b.stage === 'cloning' && why === 'candidate-waiting-for-slot') throw new Error();
      let worker: CheckSlotBlocker['worker'] = null;
      if (b.worker !== null) {
        const w = asRecord(b.worker);
        if (!id(w.request) || !id(w.ticket) || typeof w.ship !== 'string' || !/^~[a-z-]{1,127}$/.test(w.ship) ||
            !['reserved', 'dispatched', 'checked', 'refused', 'unknown', 'revoked'].includes(String(w.phase)) ||
            typeof w.sent !== 'boolean' || typeof w.resultPresent !== 'boolean' || w.resultPresent && !w.sent ||
            w.phase === 'reserved' && (w.sent || w.resultPresent) || w.phase === 'dispatched' && (!w.sent || w.resultPresent) ||
            w.phase === 'checked' && !w.resultPresent) throw new Error();
        const resultReason = reason(w.resultReason);
        if (resultReason !== null && !w.resultPresent) throw new Error();
        worker = {request: w.request, ticket: w.ticket, ship: w.ship, sent: w.sent, phase: String(w.phase), resultPresent: w.resultPresent, resultReason};
      }
      return {candidate: b.candidate, session: b.session, request: b.request, stage: String(b.stage), reason: why, worker};
    });
    if (new Set(blockers.map(b => b.candidate)).size !== blockers.length) throw new Error();
    return {status: r.condition as 'free' | 'blocked', observedAt: r.observedAt as string, blockerCount: r.blockerCount, blockers,
      truncated: r.truncated, notice: 'Canonical candidate check-slot snapshot across all sessions. A free slot does not prove a check succeeded or authorize work.'};
  } catch {return unknown('Invalid canonical check-slot evidence; observe again.');}
}

/** Viki's session summary does not identify Cantrip's current check-slot owner. */
export function candidateBlocking(candidate: CandidateReview, observed: readonly CandidateReview[], checkSlot = readCheckSlot(undefined, candidate.actor)) {
  const waitingForSlot = candidate.stage === 'cloning' && candidate.reason === 'candidate-waiting-for-slot';
  const related = waitingForSlot ? observed.filter(row => row.id !== candidate.id && row.actor === candidate.actor &&
    row.session === candidate.session && ['cloning', 'staging', 'checking', 'landing', 'unknown'].includes(row.stage) &&
    !(row.stage === 'cloning' && row.reason === 'candidate-waiting-for-slot')) : [];
  return {
    condition: {status: candidate.reason ? 'reported' : 'not-reported', reason: candidate.reason || null},
    waitingForSlot,
    slot: waitingForSlot ? checkSlot : null,
    related: related.map(row => ({candidate: row.id, session: row.session, request: row.request, stage: row.stage, reason: row.reason || null})),
    notice: 'Observed work in this session only; these rows do not establish which candidate holds the check slot. Other sessions and omitted rows may contain the occupant.'
  };
}

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
  let previewBytes = 0;
  const edits = r.edits.map(value => {
    const e = asRecord(value);
    if (typeof e.path !== 'string' || !validPath(e.path) || !['add', 'modify', 'delete'].includes(String(e.kind)) ||
        !(e.before === '' || id(e.before)) || !(e.after === '' || id(e.after)) ||
        (e.kind === 'add' ? e.before !== '' || e.after === '' : e.kind === 'delete' ? e.before === '' || e.after !== '' : e.before === '' || e.after === '')) throw new Error('Invalid candidate edit.');
    let preview: CandidateReview['edits'][number]['preview'];
    if (e.preview !== undefined && e.preview !== null) {
      const p = asRecord(e.preview);
      if (p.schema !== 'native-coding-candidate-text-v1' || !text(p.original, 65536) || !text(p.proposed, 65536) ||
          p.original.includes('\0') || p.proposed.includes('\0') || e.kind === 'add' && p.original !== '' ||
          e.kind === 'delete' && p.proposed !== '') throw new Error('Invalid candidate source preview.');
      previewBytes += Buffer.byteLength(p.original) + Buffer.byteLength(p.proposed);
      if (previewBytes > 65536) throw new Error('Candidate source previews exceed the native bound.');
      preview = {schema: p.schema, original: p.original, proposed: p.proposed};
    }
    return {path: e.path, kind: String(e.kind), before: e.before as string, after: e.after as string, ...(preview ? {preview} : {})};
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

export async function observeCandidates(client: Pick<ShipClient, 'codingState'>, session: string, project: string): Promise<{owner: string; project: string; session: string; candidates: CandidateReview[]; possiblyTruncated: boolean; review?: CandidateCampaigns; checkSlot: CheckSlot}> {
  const state = await client.codingState(session);
  const selected = state.sessions.filter(s => s.id === session && s.project === project);
  if (state.session !== session || selected.length !== 1 || !Array.isArray(state.reviews) || state.reviews.length > 8) throw new Error('Candidate review scope unavailable.');
  const candidates = state.reviews.map(r => readCandidate(r, state.owner, session));
  if (new Set(candidates.map(c => c.id)).size !== candidates.length) throw new Error('Duplicate native candidates.');
  const review = candidateCampaigns(state.soloReview, project, candidates.map(c => c.id));
  return {owner: state.owner, project, session, candidates, possiblyTruncated: candidates.length === 8, review, checkSlot: readCheckSlot(state.checkSlot, state.owner)};
}
