/**
 * Everything waiting on the owner, in one place. This module only counts what the existing screens already
 * hold after their own reads; it adds no authority and no request of its own. A source that was not read
 * (no project chosen, ship busy) is reported as not checked, never as empty.
 */
export interface WaitingItem {
  readonly id: string;
  /** What is waiting, in plain words, already counted: "2 suggestions from collaborators". */
  readonly label: string;
  readonly count: number;
  readonly command: {readonly command: string; readonly title: string; readonly arguments?: readonly unknown[]};
}
export interface WaitingReport {readonly items: readonly WaitingItem[]; readonly unchecked: readonly string[]; readonly checkedAt: number}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface CandidateLike {readonly stage: string; readonly decision: string; /** Present once the change is applied. */ readonly landed?: unknown; readonly id: string}
/** Candidates that need the owner: not yet under review, or reviewed and approved but not applied. */
export function waitingCandidates(candidates: readonly CandidateLike[], underReview: ReadonlySet<string>): {review: number; apply: number} {
  let review = 0, apply = 0;
  for (const c of candidates) {
    if (c.stage !== 'review') continue;
    if (c.decision === 'pending' && !underReview.has(c.id)) review++;
    else if (c.decision === 'approve' && !c.landed) apply++;
  }
  return {review, apply};
}
export interface WaitingCounts {
  suggestions?: number; review?: number; apply?: number; requests?: number; answer?: boolean; expiredInvitations?: number;
}
/** The items with something in them, in the order an owner would act, plus the names of sources that were not read. */
export function waitingReport(counts: WaitingCounts, checkedAt: number): WaitingReport {
  const items: WaitingItem[] = [], unchecked: string[] = [];
  const add = (value: number | undefined, name: string, item: (n: number) => WaitingItem) => {
    if (value === undefined) unchecked.push(name); else if (value > 0) items.push(item(value));
  };
  add(counts.requests, 'coding requests', n => ({id: 'requests', count: n, label: `${plural(n, 'coding request', 'coding requests')} waiting for your permission review`,
    command: {command: 'readymade.workspaceRequests', title: 'Browse shared coding requests'}}));
  add(counts.suggestions, 'suggestions', n => ({id: 'suggestions', count: n, label: `${plural(n, 'suggestion', 'suggestions')} from collaborators`,
    command: {command: 'readymade.projectInbox', title: 'Refresh Inbox'}}));
  add(counts.review, 'changes to review', n => ({id: 'review', count: n, label: `${plural(n, 'change', 'changes')} waiting for review`,
    command: {command: 'readymade.reviewCode', title: 'Observe code candidates'}}));
  add(counts.apply, 'changes to apply', n => ({id: 'apply', count: n, label: `${plural(n, 'reviewed change', 'reviewed changes')} ready to apply`,
    command: {command: 'readymade.reviewCode', title: 'Observe code candidates'}}));
  add(counts.answer === undefined ? undefined : counts.answer ? 1 : 0, 'answers to accept', () => ({id: 'answer', count: 1, label: 'An answer is ready for you to accept',
    command: {command: 'readymade.reviewAnswer', title: 'Review answer'}}));
  add(counts.expiredInvitations, 'invitations', n => ({id: 'invitations', count: n, label: `${plural(n, 'expired invitation', 'expired invitations')} to close`,
    command: {command: 'readymade.projectInvitations', title: 'Pending Invitations'}}));
  return Object.freeze({items: Object.freeze(items), unchecked: Object.freeze(unchecked), checkedAt});
}
export function waitingSummary(report: WaitingReport): string {
  const total = report.items.reduce((sum, item) => sum + item.count, 0);
  if (!total) return report.unchecked.length ? `Nothing found; not checked: ${report.unchecked.join(', ')}` : 'Nothing is waiting on you';
  return `${plural(total, 'thing is', 'things are')} waiting on you`;
}
