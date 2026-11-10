import * as fs from 'node:fs';
import { join } from 'node:path';
import { asRecord } from './protocol';
import { digest, originOf, sourceBasis } from './source-store';
import { observeCandidates, readCandidate, type CandidateReview } from './candidate-store';
import { candidateCampaigns, type CandidateCampaigns } from './candidate-campaign';
import type { ShipClient } from './ship-client';

type Client = Pick<ShipClient, 'origin' | 'codingState' | 'startCandidateReview'>;
export interface CandidateIntent {
  version: 1; origin: string; owner: string; project: string; session: string;
  candidate: CandidateReview; scope: NonNullable<CandidateCampaigns['scope']>;
}
function validate(value: unknown): CandidateIntent {
  const r = asRecord(value), c = asRecord(r.candidate), basis = asRecord(c.basis);
  if (r.version !== 1 || typeof r.origin !== 'string' || originOf(r.origin) !== r.origin ||
      typeof r.owner !== 'string' || typeof r.project !== 'string' || !r.project || typeof r.session !== 'string') throw new Error('Invalid candidate intent.');
  const candidate = readCandidate({...c, sourceId: basis.id, source: typeof basis.number === 'number' ? basis.number.toLocaleString('en-US').replaceAll(',', '.') : '', landed: c.landed ?? null}, r.owner, r.session);
  const review = candidateCampaigns({schema: 'native-coding-solo-review-view-v1', available: true, project: r.project,
    scope: {...asRecord(r.scope), project: r.project}, campaigns: []}, r.project, [candidate.id])!;
  if (!review.scope?.enabled || candidate.stage !== 'review' || candidate.decision !== 'pending' || candidate.landed) throw new Error('Candidate is not ready for review.');
  return {version: 1, origin: r.origin, owner: r.owner, project: r.project, session: r.session, candidate, scope: review.scope};
}
/** One immutable, synchronized start intent per candidate, shared by all windows.
 * Recovery reads native state only; even an unanswered start is never replayed. */
export class CandidateJournal {
  constructor(readonly directory: string) {}
  private privateInfo(info: fs.Stats, directory = false): void {
    if (!(directory ? info.isDirectory() : info.isFile()) || info.isSymbolicLink() ||
        process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new Error('Candidate journal must be private and owned.');
  }
  private ensure(): void {fs.mkdirSync(this.directory, {recursive: true, mode: 0o700}); this.privateInfo(fs.lstatSync(this.directory), true);}
  private key(i: CandidateIntent): string {return digest(JSON.stringify([i.origin, i.owner, i.session, i.candidate.id]));}
  entries(): CandidateIntent[] {
    this.ensure(); const files = fs.readdirSync(this.directory).filter(f => f.endsWith('.intent.json'));
    if (files.length > 4096) throw new Error('Candidate journal capacity reached.');
    return files.map(file => {
      const fd = fs.openSync(join(this.directory, file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd); this.privateInfo(stat);
        if (stat.size > 4194304) throw new Error('Candidate intent exceeds its size limit.');
        const intent = validate(JSON.parse(fs.readFileSync(fd, 'utf8')));
        if (file !== this.key(intent) + '.intent.json') throw new Error('Candidate journal identity changed.');
        return intent;
      } finally {fs.closeSync(fd);}
    });
  }
  async start(client: Client, supplied: CandidateIntent, consent: boolean): Promise<Awaited<ReturnType<CandidateJournal['recover']>>> {
    const intent = validate(supplied);
    if (consent !== true) throw new Error('Explicit consent to native review is required.');
    if (!intent.scope.binding) throw new Error('This backend does not provide an exact review policy binding. Update it before starting review.');
    if (client.origin !== intent.origin) throw new Error('Candidate origin changed.');
    const entries = this.entries();
    if (entries.length >= 4096 || entries.some(e => this.key(e) === this.key(intent))) throw new Error('Observe the retained review start; it will not be submitted again.');
    const fresh = await observeCandidates(client, intent.session, intent.project);
    if (fresh.owner !== intent.owner || !fresh.review?.available || JSON.stringify(fresh.review.scope) !== JSON.stringify(intent.scope) ||
        JSON.stringify(fresh.candidates.find(c => c.id === intent.candidate.id)) !== JSON.stringify(intent.candidate) ||
        fresh.review.campaigns.some(c => c.candidate === intent.candidate.id)) throw new Error('Candidate or review scope changed. Review it again.');
    const data = JSON.stringify(intent);
    if (Buffer.byteLength(data) > 4194304) throw new Error('Candidate intent exceeds its size limit.');
    const fd = fs.openSync(join(this.directory, this.key(intent) + '.intent.json'), 'wx', 0o600);
    try {fs.writeFileSync(fd, data); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    const directory = fs.openSync(this.directory, fs.constants.O_RDONLY);
    try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
    await client.startCandidateReview(intent, intent.candidate.id, true, intent.scope.binding);
    return this.recover(client, intent);
  }
  async recover(client: Client, supplied: CandidateIntent) {
    const intent = validate(supplied), retained = this.entries().find(e => this.key(e) === this.key(intent));
    if (client.origin !== intent.origin || JSON.stringify(retained) !== JSON.stringify(intent)) throw new Error('Retained candidate context changed.');
    const observed = await observeCandidates(client, intent.session, intent.project);
    if (observed.owner !== intent.owner) throw new Error('Candidate owner changed.');
    const candidate = observed.candidates.find(c => c.id === intent.candidate.id);
    if (candidate && (candidate.request !== intent.candidate.request || JSON.stringify(candidate.basis) !== JSON.stringify(intent.candidate.basis) ||
        JSON.stringify(candidate.edits) !== JSON.stringify(intent.candidate.edits))) throw new Error('Candidate evidence changed.');
    return {intent, candidate, campaign: observed.review?.campaigns.find(c => c.candidate === intent.candidate.id),
      notice: 'Observed state is not a delivery receipt. Missing evidence never authorizes resubmission.'};
  }
}

export type CandidateDecisionIntent = Omit<CandidateIntent, 'scope'>;
type DecisionClient = Pick<ShipClient, 'origin' | 'codingState' | 'applyReviewedCandidate'>;
function decisionIntent(value: unknown): CandidateDecisionIntent {
  const r = asRecord(value), c = asRecord(r.candidate), basis = asRecord(c.basis);
  if (r.version !== 1 || typeof r.origin !== 'string' || originOf(r.origin) !== r.origin ||
      typeof r.owner !== 'string' || typeof r.project !== 'string' || !r.project || typeof r.session !== 'string') throw new Error('Invalid apply intent.');
  const candidate = readCandidate({...c, sourceId: basis.id, source: typeof basis.number === 'number' ? basis.number.toLocaleString('en-US').replaceAll(',', '.') : '', landed: c.landed ?? null}, r.owner, r.session);
  if (candidate.stage !== 'review' || candidate.decision !== 'approve' || candidate.landed) throw new Error('This candidate has no native approval ready to apply.');
  return {version: 1, origin: r.origin, owner: r.owner, project: r.project, session: r.session, candidate};
}
/** Applying approved source is a separate, explicit operation from reviewing it.
 * Its exclusive durable intent remains after success, refusal or lost delivery. */
export class CandidateDecisionJournal {
  constructor(readonly directory: string) {}
  private key(i: CandidateDecisionIntent): string {return digest(JSON.stringify([i.origin, i.owner, i.session, i.candidate.id]));}
  private privateInfo(info: fs.Stats, directory = false): void {
    if (!(directory ? info.isDirectory() : info.isFile() && info.nlink === 1) || info.isSymbolicLink() ||
        process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new Error('Apply journal must be private and owned.');
  }
  entries(): CandidateDecisionIntent[] {
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700}); this.privateInfo(fs.lstatSync(this.directory), true);
    const files = fs.readdirSync(this.directory).filter(f => f.endsWith('.intent.json'));
    if (files.length > 4096) throw new Error('Apply journal capacity reached.');
    return files.map(file => {
      const fd = fs.openSync(join(this.directory, file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd); this.privateInfo(stat);
        if (stat.size > 4194304) throw new Error('Apply intent exceeds its size limit.');
        const intent = decisionIntent(JSON.parse(fs.readFileSync(fd, 'utf8')));
        if (file !== this.key(intent) + '.intent.json') throw new Error('Apply journal identity changed.');
        return intent;
      } finally {fs.closeSync(fd);}
    });
  }
  async apply(client: DecisionClient, supplied: CandidateDecisionIntent, consent: boolean, active: () => boolean = () => true) {
    const intent = decisionIntent(supplied);
    if (consent !== true) throw new Error('Explicit consent to apply reviewed source is required.');
    if (client.origin !== intent.origin || !active()) throw new Error('Candidate context changed.');
    const entries = this.entries();
    if (entries.length >= 4096 || entries.some(e => this.key(e) === this.key(intent))) throw new Error('Observe the retained apply request; it will not be submitted again.');
    const state = await client.codingState(intent.session), sessions = state.sessions.filter(s => s.id === intent.session && s.project === intent.project);
    if (!active()) throw new Error('Candidate context changed.');
    if (state.candidateDecide !== true) throw new Error('Update the backend to apply reviewed changes.');
    if (state.owner !== intent.owner || state.session !== intent.session || sessions.length !== 1 ||
        JSON.stringify(sourceBasis(sessions[0].source)) !== JSON.stringify(intent.candidate.basis)) throw new Error('The working source changed. Review it again.');
    const fresh = await observeCandidates(client, intent.session, intent.project);
    if (!active()) throw new Error('Candidate context changed.');
    if (fresh.owner !== intent.owner || JSON.stringify(fresh.candidates.find(c => c.id === intent.candidate.id)) !== JSON.stringify(intent.candidate)) throw new Error('Candidate approval changed. Review it again.');
    const data = JSON.stringify(intent);
    if (Buffer.byteLength(data) > 4194304) throw new Error('Apply intent exceeds its size limit.');
    const fd = fs.openSync(join(this.directory, this.key(intent) + '.intent.json'), 'wx', 0o600);
    try {fs.writeFileSync(fd, data); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    const directory = fs.openSync(this.directory, fs.constants.O_RDONLY);
    try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
    await client.applyReviewedCandidate(intent, intent.candidate.id, intent.candidate.basis.id, true);
    return this.recover(client, intent);
  }
  async recover(client: DecisionClient, supplied: CandidateDecisionIntent) {
    const intent = decisionIntent(supplied), held = this.entries().find(e => this.key(e) === this.key(intent));
    if (client.origin !== intent.origin || JSON.stringify(held) !== JSON.stringify(intent)) throw new Error('Retained apply context changed.');
    const observed = await observeCandidates(client, intent.session, intent.project), candidate = observed.candidates.find(c => c.id === intent.candidate.id);
    if (observed.owner !== intent.owner || candidate && (candidate.request !== intent.candidate.request ||
        JSON.stringify(candidate.basis) !== JSON.stringify(intent.candidate.basis) || JSON.stringify(candidate.edits) !== JSON.stringify(intent.candidate.edits))) throw new Error('Candidate evidence changed.');
    return {intent, candidate, applied: candidate?.stage === 'applied' && !!candidate.landed,
      notice: 'Only canonical applied source confirms completion. Missing or uncertain evidence never resubmits the retained request.'};
  }
}
