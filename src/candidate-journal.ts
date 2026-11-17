import * as fs from 'node:fs';
import { join } from 'node:path';
import { asRecord, isUx } from './protocol';
import { digest, originOf, sourceBasis } from './source-store';
import { observeCandidates, readCandidate, type CandidateReview } from './candidate-store';
import { candidateCampaigns, restartCampaign, type CandidateCampaigns } from './candidate-campaign';
import type { ShipClient } from './ship-client';

type Client = Pick<ShipClient, 'origin' | 'codingState' | 'startCandidateReview'> & {assertIdle?(): void};
/** Older retained intents have no text preview. New presentation evidence may
 * fill that absence, but never change a recorded edit or previously seen text. */
function sameEdits(current: CandidateReview['edits'], retained: CandidateReview['edits']): boolean {
  return current.length === retained.length && retained.every((old, index) => {
    const next = current[index];
    return next.path === old.path && next.kind === old.kind && next.before === old.before && next.after === old.after &&
      (!old.preview || JSON.stringify(next.preview) === JSON.stringify(old.preview));
  });
}
export interface CandidateIntent {
  version: 1; origin: string; owner: string; project: string; session: string;
  candidate: CandidateReview; scope: NonNullable<CandidateCampaigns['scope']>;
  previousCampaign?: string;
}
function validate(value: unknown): CandidateIntent {
  const r = asRecord(value), c = asRecord(r.candidate), basis = asRecord(c.basis);
  if (r.version !== 1 || typeof r.origin !== 'string' || originOf(r.origin) !== r.origin ||
      typeof r.owner !== 'string' || typeof r.project !== 'string' || !r.project || typeof r.session !== 'string' ||
      r.previousCampaign !== undefined && (!isUx(r.previousCampaign) || r.previousCampaign === '0x0')) throw new Error('Invalid candidate intent.');
  const candidate = readCandidate({...c, sourceId: basis.id, source: typeof basis.number === 'number' ? basis.number.toLocaleString('en-US').replaceAll(',', '.') : '', landed: c.landed ?? null}, r.owner, r.session);
  const review = candidateCampaigns({schema: 'native-coding-solo-review-view-v1', available: true, project: r.project,
    scope: {...asRecord(r.scope), project: r.project}, campaigns: []}, r.project, [candidate.id])!;
  if (!review.scope?.enabled || candidate.stage !== 'review' || candidate.decision !== 'pending' || candidate.landed) throw new Error('Candidate is not ready for review.');
  return {version: 1, origin: r.origin, owner: r.owner, project: r.project, session: r.session, candidate, scope: review.scope,
    ...(r.previousCampaign === undefined ? {} : {previousCampaign: r.previousCampaign as string})};
}
/** One immutable start intent per candidate or explicit retired campaign, shared by all windows.
 * Recovery reads native state only; even an unanswered start is never replayed. */
export class CandidateJournal {
  constructor(readonly directory: string) {}
  private privateInfo(info: fs.Stats, directory = false): void {
    if (!(directory ? info.isDirectory() : info.isFile()) || info.isSymbolicLink() ||
        process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new Error('Candidate journal must be private and owned.');
  }
  private ensure(): void {fs.mkdirSync(this.directory, {recursive: true, mode: 0o700}); this.privateInfo(fs.lstatSync(this.directory), true);}
  private key(i: CandidateIntent): string {return digest(JSON.stringify([i.origin, i.owner, i.session, i.candidate.id, ...(i.previousCampaign ? [i.previousCampaign] : [])]));}
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
        (intent.previousCampaign ? restartCampaign(fresh.review, intent.candidate.id) !== intent.previousCampaign :
          fresh.review.campaigns.some(c => c.candidate === intent.candidate.id))) throw new Error('Candidate or review scope changed. Review it again.');
    const data = JSON.stringify(intent);
    if (Buffer.byteLength(data) > 4194304) throw new Error('Candidate intent exceeds its size limit.');
    // A client that could not send now would leave a recorded intent that was never sent and is never sent again.
    client.assertIdle?.();
    const fd = fs.openSync(join(this.directory, this.key(intent) + '.intent.json'), 'wx', 0o600);
    try {fs.writeFileSync(fd, data); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    const directory = fs.openSync(this.directory, fs.constants.O_RDONLY);
    try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
    await client.startCandidateReview(intent, intent.candidate.id, true, intent.scope.binding, intent.previousCampaign);
    return this.recover(client, intent);
  }
  async recover(client: Client, supplied: CandidateIntent) {
    const intent = validate(supplied), retained = this.entries().find(e => this.key(e) === this.key(intent));
    if (client.origin !== intent.origin || JSON.stringify(retained) !== JSON.stringify(intent)) throw new Error('Retained candidate context changed.');
    const observed = await observeCandidates(client, intent.session, intent.project);
    if (observed.owner !== intent.owner) throw new Error('Candidate owner changed.');
    const candidate = observed.candidates.find(c => c.id === intent.candidate.id);
    if (candidate && (candidate.request !== intent.candidate.request || JSON.stringify(candidate.basis) !== JSON.stringify(intent.candidate.basis) ||
        !sameEdits(candidate.edits, intent.candidate.edits))) throw new Error('Candidate evidence changed.');
    return {intent, candidate, campaign: observed.review?.campaigns.find(c => c.candidate === intent.candidate.id),
      notice: 'Observed state is not a delivery receipt. Missing evidence never authorizes resubmission.'};
  }
}

export type CandidateDecisionIntent = Omit<CandidateIntent, 'scope' | 'previousCampaign'>;
type DecisionClient = Pick<ShipClient, 'origin' | 'codingState' | 'applyReviewedCandidate'> & {assertIdle?(): void};
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
  private continuationJournal(): CandidateDecisionJournal {return new CandidateDecisionJournal(join(this.directory, 'continuation'));}
  /** This precise retained reason was refused by the native HTTP ready gate before
   * dispatch. Only native recovery of that block permits one new explicit intent. */
  canContinue(supplied: CandidateDecisionIntent): boolean {
    const intent = decisionIntent(supplied), previous = this.entries().filter(e => this.key(e) === this.key(intent));
    if (previous.length !== 1 || previous[0].candidate.reason !== 'local-review-owner-incompatible' || intent.candidate.reason !== '' ||
        !sameEdits(intent.candidate.edits, previous[0].candidate.edits) ||
        JSON.stringify({...intent, candidate: {...intent.candidate, reason: previous[0].candidate.reason, edits: previous[0].candidate.edits}}) !== JSON.stringify(previous[0])) return false;
    return !this.continuationJournal().entries().some(e => this.key(e) === this.key(intent));
  }
  async continue(client: DecisionClient, supplied: CandidateDecisionIntent, consent: boolean, active: () => boolean = () => true) {
    const intent = decisionIntent(supplied);
    if (!this.canContinue(intent)) throw new Error('This retained apply request cannot be continued. Observe its result.');
    return this.continuationJournal().apply(client, intent, consent, () => active() && this.canContinue(intent));
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
    // A client that could not send now would leave a recorded intent that was never sent and is never sent again.
    client.assertIdle?.();
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
        JSON.stringify(candidate.basis) !== JSON.stringify(intent.candidate.basis) || !sameEdits(candidate.edits, intent.candidate.edits))) throw new Error('Candidate evidence changed.');
    return {intent, candidate, applied: candidate?.stage === 'applied' && !!candidate.landed,
      notice: 'Only canonical applied source confirms completion. Missing or uncertain evidence never resubmits the retained request.'};
  }
}
