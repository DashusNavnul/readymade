import {asRecord} from './protocol';
import {invitationCatalog, type InvitationResult} from './project-invitations';
import type {RemoteProjectSessionsReply} from './remote-project-sessions';
import {ShipClientError, type ShipClient} from './ship-client';

/**
 * Joined projects, read from the ship instead of from this computer's profile.
 *
 * Two different kinds of evidence, kept apart:
 *  - The connected ship's own list of invitation requests says where this ship once asked to join. It is not
 *    membership: it has no order in time, it knows nothing of a removal by the owner, and the ship forgets its
 *    oldest settled requests once it holds 512.
 *  - Membership is whatever the owner's ship says now. The owner answers the shared-session list read only for a
 *    current member, so an answered read is the owner's own statement that this ship is a member at that moment.
 * Nothing here sends a command, writes a file or turns an old request into something that can be sent.
 */
export type CatalogFailure = 'unsupported' | 'changed' | 'unreachable' | 'malformed' | 'capacity' | 'signed-out';
export type CatalogRead = {status: 'complete'; catalog: string; requests: InvitationResult[]} | {status: 'unavailable'; reason: CatalogFailure};
/** The ship keeps at most 512 requests, 64 to a page: eight pages, or one empty page. */
const PAGES = 8;
/**
 * Owners asked in one pass. Each ask is one read the connected ship holds for five and a half minutes, and it holds
 * 32 at most, for every window together; so a pass asks few, and the next pass asks the ones not asked yet.
 */
export const MEMBERSHIP_CHECKS = 8;
/** An owner's answer this recent is used as it is instead of asking again. */
export const ANSWER_FRESH_MS = 60000;

function thrown(error: unknown): CatalogFailure {
  if (!(error instanceof ShipClientError)) return 'unreachable';
  if (error.code === 'authenticationRequired') return 'signed-out';
  // The request was answered, but not with a page this Readymade can verify.
  if (['malformed', 'redirectRefused', 'tooLarge'].includes(error.code)) return 'malformed';
  return 'unreachable';
}
/**
 * Every page of the connected ship's own request list, or no list at all. Each later page is bound to the digest
 * of the first; a list that changes while it is read is read once more from the start, then given up. A partial
 * list is never returned: half a list would read as "this ship joined nothing else".
 */
export async function readRequestCatalog(client: Pick<ShipClient, 'projectInvitation'>, actor: string, live: () => boolean = () => true): Promise<CatalogRead> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const requests: InvitationResult[] = [], seen = new Set<string>();
    let offset = 0, catalog: string | undefined, total: number | undefined, restart = false;
    for (let n = 0; n < PAGES && !restart; n++) {
      let reply: Awaited<ReturnType<ShipClient['projectInvitation']>>;
      try {reply = await client.projectInvitation('requests', catalog === undefined ? {} : {offset, catalog});}
      catch (error) {return {status: 'unavailable', reason: thrown(error)};}
      if (!live()) return {status: 'unavailable', reason: 'changed'};
      if (reply.status === 409) {
        const message = asRecord(reply.body).message;
        if (message === '%invitation-catalog-stale' || message === 'invitation-catalog-stale') {restart = true; break;}
        return {status: 'unavailable', reason: String(message).includes('invitation-catalog-capacity') ? 'capacity' : 'malformed'};
      }
      if (reply.status === 404) return {status: 'unavailable', reason: 'unsupported'};
      if (reply.status !== 200) return {status: 'unavailable', reason: reply.status >= 500 ? 'unreachable' : 'malformed'};
      let page: ReturnType<typeof invitationCatalog>;
      try {page = invitationCatalog(reply.body, actor, offset, catalog);} catch {return {status: 'unavailable', reason: 'malformed'};}
      if (total !== undefined && page.total !== total || page.requests.some(row => seen.has(row.request))) return {status: 'unavailable', reason: 'malformed'};
      total = page.total; catalog = page.catalog;
      for (const row of page.requests) {seen.add(row.request); requests.push(row);}
      if (page.next === null) return requests.length === total ? {status: 'complete', catalog, requests} : {status: 'unavailable', reason: 'malformed'};
      offset = page.next;
    }
    if (!restart) return {status: 'unavailable', reason: 'malformed'};
  }
  return {status: 'unavailable', reason: 'changed'};
}

export interface JoinedCandidate {
  readonly authority: string; readonly project: string;
  /** `accepted`: the ship holds an accepted join. `unresolved`: it holds only joins whose result it never learned. */
  readonly evidence: 'accepted' | 'unresolved';
  /** The ship sent a leave for this project and has no answer yet; it refuses another until that one settles. */
  readonly leaving: boolean;
}
/**
 * The projects worth asking an owner about: every project of another ship for which this ship holds a join that
 * was not refused. A refused join alone names nothing. Accepted leaves do not remove a candidate, because the list
 * has no order: "joined, left, joined again" and "changed role, then left" hold the same rows. The owner decides.
 */
export function joinedCandidates(requests: readonly InvitationResult[], actor: string): JoinedCandidate[] {
  const found = new Map<string, {authority: string; project: string; evidence: 'accepted' | 'unresolved'; leaving: boolean}>();
  for (const row of requests) {
    if (row.authority === actor || row.operation !== 'join' || row.status === 'refused') continue;
    const key = row.authority + '\n' + row.project, held = found.get(key);
    const evidence = row.status === 'accepted' || held?.evidence === 'accepted' ? 'accepted' : 'unresolved';
    found.set(key, {authority: row.authority, project: row.project, evidence, leaving: false});
  }
  for (const row of requests) {
    const held = found.get(row.authority + '\n' + row.project);
    if (held && row.operation === 'leave' && row.status === 'submitted') held.leaving = true;
  }
  return [...found.values()].sort((a, b) => a.authority === b.authority ? (a.project < b.project ? -1 : a.project > b.project ? 1 : 0) : a.authority < b.authority ? -1 : 1);
}

export type Standing = 'member' | 'unconfirmed' | 'unreachable';
export interface OwnerAnswer {readonly standing: Standing; readonly observedAt?: string}
/**
 * What one answer of the owner's ship says about membership. Only an answered list is membership. A refusal is
 * not proof of the opposite (the owner's rules can refuse the read to a member), so it reads "not confirmed".
 * No answer, an expired read and a read that could not start all read "did not answer". `undefined` is a read
 * that never produced a reply.
 */
export function ownerAnswer(reply: RemoteProjectSessionsReply | undefined): OwnerAnswer {
  if (reply?.status === 'ready' && reply.observation) return {standing: 'member', observedAt: reply.observation.observedAt};
  if (reply?.status === 'refused') return {standing: 'unconfirmed'};
  return {standing: 'unreachable'};
}

/** `waiting`: the ship or this connection still holds earlier checks, so the owner was not asked this time. `unchecked`: more projects than one pass asks. */
export type JoinedStanding = Standing | 'checking' | 'unchecked' | 'waiting';
export interface JoinedProject extends JoinedCandidate {standing: JoinedStanding; observedAt?: string}
/** `~2026.11.20..22.42.03..2cbc` as `2026-11-20 22:42 UTC`; a date alone when the ship gave no time. */
export function observedWhen(at: string): string {
  const [day, time] = at.slice(1).split('..');
  return day.replaceAll('.', '-') + (time ? ' ' + time.split('.').slice(0, 2).join(':') + ' UTC' : '');
}
/** One joined project in plain words: a short status beside the name, and the reasoning on hover. */
export function joinedProjectWords(row: JoinedProject): {description: string; tooltip: string} {
  const unresolved = row.evidence === 'unresolved' ? ' Your ship never learned the result of its own join request here.' : '';
  switch (row.standing) {
    case 'member': return {description: `${row.authority} · member`,
      tooltip: `${row.authority} confirmed this ship as a member${row.observedAt ? ' at ' + observedWhen(row.observedAt) : ''}. File and session access are granted separately by the owner.`};
    case 'checking': return {description: `${row.authority} · asking the owner’s ship…`, tooltip: 'Reading only; nothing is sent again.'};
    case 'unconfirmed': return {description: `${row.authority} · not confirmed by the owner’s ship`,
      tooltip: `Your ship once asked to join this project. ${row.authority} did not confirm that it is a member now: it may have left or been removed, or the owner’s ship does not answer this read.${unresolved} Nothing was sent.`};
    case 'unreachable': return {description: `${row.authority} · the owner’s ship did not answer`,
      tooltip: `Membership could not be checked now.${unresolved} Check again when ${row.authority} is reachable. Nothing was sent.`};
    case 'waiting': return {description: `${row.authority} · not asked just now`,
      tooltip: 'Your ship is still holding earlier checks, so this owner was not asked this time. Refresh joined projects in a few minutes. Nothing was sent.'};
    case 'unchecked': return {description: `${row.authority} · not checked yet`,
      tooltip: `Owners are asked ${MEMBERSHIP_CHECKS} at a time, those not asked yet first. Refresh joined projects to ask the next ones.`};
  }
}
/** Why the ship's own list could not be read, and what to do; never worded as "no projects". */
export function catalogFailureWords(reason: CatalogFailure): string {
  switch (reason) {
    case 'unsupported': return 'This ship’s collaboration service does not list its requests. Update it, then refresh.';
    case 'changed': return 'This ship’s requests changed while they were being read. Refresh to read them again.';
    case 'unreachable': return 'Your ship did not answer. Refresh when it is reachable.';
    case 'malformed': return 'Your ship answered with a list Readymade could not verify, so nothing was assumed. Refresh, or update the collaboration service.';
    case 'capacity': return 'This ship holds more requests than the list can show, so joined projects cannot be listed completely and none are assumed.';
    case 'signed-out': return 'Sign in to this ship again, then refresh.';
  }
}
