import type {RemoteDraftStore} from './remote-draft-store';
import {suggestionSettled, suggestionStanding, type RemoteSuggestionJournal} from './remote-suggestion-journal';
import {bundleStanding, type RemoteBundleJournal} from './remote-bundle-suggest';

/**
 * Which shared-project work is finished, and how it moves to history so that drafts and suggestions never stop at
 * 64. No ship is called here and nothing is deleted: a move takes records out of the 64 open places of their
 * stores and keeps them, exactly, in each store's history.
 *
 * Finished means there is nothing left to learn about a send: the owner recorded it, the owner refused it, or it
 * never started. A send whose outcome is not known is never finished, however old. A draft that was never sent is
 * never finished either: it moves only when the person says so.
 */
export interface WorkStores {readonly drafts: RemoteDraftStore; readonly suggestions?: RemoteSuggestionJournal; readonly bundles?: RemoteBundleJournal}
/** One finished piece of work: a send record and the drafts it sent, or (`draft`) a draft whose send record is already in history. */
export interface FinishedWork {readonly kind: 'suggestion' | 'bundle' | 'draft'; readonly request: string; readonly drafts: readonly string[]; readonly at: number}
export type DraftStanding = 'unsent' | 'unsettled' | 'ended' | 'finished';
export const OPEN_PLACES = 64;

/**
 * Where one open draft stands. `unsent`: no send was ever recorded for it. `unsettled`: its send can still be
 * checked or closed. `ended`: its send ended without an outcome and nothing more is being read. `finished`: see above.
 */
export function draftStanding(stores: WorkStores, id: string): DraftStanding {
  const single = stores.suggestions?.list().find(row => row.draftId === id);
  if (single) {const standing = suggestionStanding(single); return standing === 'open' ? 'unsettled' : standing;}
  const bundle = stores.bundles?.list().find(row => row.drafts.includes(id));
  if (bundle) {const standing = bundleStanding(bundle); return standing === 'open' ? 'unsettled' : standing;}
  return stores.suggestions?.holds(id) || stores.bundles?.holdsDraft(id) ? 'finished' : 'unsent';
}
/**
 * Finished work among the open records, oldest first. `inUse` names drafts the person has open in an editor: work
 * that includes one is left where it is.
 */
export function finishedWork(stores: WorkStores, inUse: (draft: string) => boolean = () => false): FinishedWork[] {
  const units: FinishedWork[] = [], claimed = new Set<string>();
  for (const row of stores.suggestions?.list() ?? []) {
    claimed.add(row.draftId);
    if (suggestionSettled(row)) units.push({kind: 'suggestion', request: row.request, drafts: [row.draftId], at: row.updatedAt});
  }
  for (const row of stores.bundles?.list() ?? []) {
    for (const id of row.drafts) claimed.add(id);
    if (bundleStanding(row) === 'finished') units.push({kind: 'bundle', request: row.request, drafts: row.drafts, at: row.updatedAt});
  }
  // A draft whose send record is already in history: its move was interrupted between the two stores, or it was restored to look at.
  for (const draft of stores.drafts.list()) {
    if (!claimed.has(draft.id) && (stores.suggestions?.holds(draft.id) || stores.bundles?.holdsDraft(draft.id))) units.push({kind: 'draft', request: '', drafts: [draft.id], at: draft.updatedAt});
  }
  return units.filter(unit => !unit.drafts.some(inUse)).sort((a, b) => a.at - b.at);
}
/**
 * Move one finished piece of work: the send record first, then each of its drafts that is open. Interrupted in
 * between, the drafts are still open and still marked as sent by the record in history; the next move takes them.
 * Returns how many open places it freed in each store.
 */
export function moveFinished(stores: WorkStores, unit: FinishedWork): {drafts: number; suggestions: number; bundles: number} {
  if (unit.kind === 'suggestion') stores.suggestions!.archive(unit.request);
  if (unit.kind === 'bundle') stores.bundles!.archive(unit.request);
  const open = new Set(stores.drafts.list().map(draft => draft.id));
  let drafts = 0;
  // A draft that cannot move now (another window changed it since this one read it) stays open. It is still marked
  // as sent by the record in history, and a later move takes it; one stuck draft never stops the person's own action.
  for (const id of unit.drafts) if (open.has(id)) {try {stores.drafts.archive(id); drafts++;} catch { /* left open; see above */ }}
  return {drafts, suggestions: unit.kind === 'suggestion' ? 1 : 0, bundles: unit.kind === 'bundle' ? 1 : 0};
}
export interface Room {drafts?: number; suggestions?: number; bundles?: number}
/**
 * Before one more record: when a store has all 64 places taken, move the oldest finished work that frees a place
 * in it, and no more than that. `short` names the stores that are still full afterwards, because none of what
 * they hold is finished; the caller says so instead of discarding anything.
 */
export function makeRoom(stores: WorkStores, need: Room, inUse: (draft: string) => boolean = () => false): {sends: number; drafts: number; short: (keyof Room)[]} {
  const lacking = {
    drafts: (need.drafts ?? 0) - (OPEN_PLACES - stores.drafts.open),
    suggestions: need.suggestions ? need.suggestions - (OPEN_PLACES - (stores.suggestions?.list().length ?? 0)) : 0,
    bundles: need.bundles ? need.bundles - (OPEN_PLACES - (stores.bundles?.list().length ?? 0)) : 0,
  };
  const keys = ['drafts', 'suggestions', 'bundles'] as const; let sends = 0, drafts = 0;
  if (keys.some(key => lacking[key] > 0)) {
    const open = new Set(stores.drafts.list().map(draft => draft.id));
    for (const unit of finishedWork(stores, inUse)) {
      if (!keys.some(key => lacking[key] > 0)) break;
      const helps = lacking.suggestions > 0 && unit.kind === 'suggestion' || lacking.bundles > 0 && unit.kind === 'bundle' || lacking.drafts > 0 && unit.drafts.some(id => open.has(id));
      if (!helps) continue;
      const freed = moveFinished(stores, unit); sends += freed.suggestions + freed.bundles; drafts += freed.drafts;
      for (const key of keys) lacking[key] -= freed[key];
    }
  }
  return {sends, drafts, short: keys.filter(key => lacking[key] > 0)};
}
/** Why a store is still full, in plain words, and what makes room; nothing was discarded. */
export function fullWords(store: keyof Room): string {
  switch (store) {
    case 'drafts': return '64 drafts are open and none of them is finished. Finish a suggestion, or move a draft you are not working on to history: its text is kept and it can be restored.';
    case 'suggestions': return '64 suggestions are open and none has a settled result. Check their results; a finished one moves to history by itself when room is needed.';
    case 'bundles': return '64 multi-file suggestions are open and none has a settled result. Check their results; a finished one moves to history by itself when room is needed.';
  }
}
/** Every finished piece of work, moved now. Work that includes a draft open in an editor stays. */
export function moveAllFinished(stores: WorkStores, inUse: (draft: string) => boolean = () => false): {sends: number; drafts: number} {
  let sends = 0, drafts = 0;
  for (const unit of finishedWork(stores, inUse)) {const freed = moveFinished(stores, unit); sends += freed.suggestions + freed.bundles; drafts += freed.drafts;}
  return {sends, drafts};
}
/** What a move did, for the person. */
export function movedWords(moved: {sends: number; drafts: number}): string {
  const part = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [...(moved.sends ? [part(moved.sends, 'finished suggestion', 'finished suggestions')] : []), ...(moved.drafts ? [part(moved.drafts, 'finished draft', 'finished drafts')] : [])];
  return parts.join(' and ') || 'nothing';
}
