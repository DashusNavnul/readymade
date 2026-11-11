import {dateAtom} from './editing-activity';
import {eventSentence, type EventRow} from './project-invitations';

/**
 * One project's activity feed for its owner: what the project's own history recorded (who was invited, joined,
 * left or was removed) merged by time with the suggestions collaborators sent. Nothing here is inferred: every
 * line is a record the owner's ship holds, with that record's own time.
 */
export interface ActivityEntry {readonly at: string; readonly day: string; readonly text: string; readonly kind: 'membership' | 'suggestion'}
export interface SuggestionLike {readonly peer: string; readonly path: string; readonly receivedAt: string}
/** `~2026.11.11..17.59.28..0e67` as `2026-11-11 17:59`; a date without a time keeps only the day. */
export function activityDay(at: string): string {
  const match = /^~(\d+)\.(\d{1,2})\.(\d{1,2})(?:\.\.(\d{2})\.(\d{2}))?/.exec(at);
  if (!match) return at;
  const day = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  return match[4] ? `${day} ${match[4]}:${match[5]}` : day;
}
export function projectActivity(events: readonly EventRow[], suggestions: readonly SuggestionLike[], limit = 64): ActivityEntry[] {
  const rows: {when: bigint; order: number; entry: ActivityEntry}[] = [];
  const add = (at: string, order: number, text: string, kind: ActivityEntry['kind']) => {
    let when: bigint; try {when = dateAtom(at);} catch {return;}
    rows.push({when, order, entry: Object.freeze({at, day: activityDay(at), text, kind})});
  };
  for (const row of events) add(row.at, row.sequence, eventSentence(row), 'membership');
  for (const row of suggestions) add(row.receivedAt, 0, `${row.peer} suggested a change to ${row.path}`, 'suggestion');
  // Newest first; records of the same instant keep the project's own order.
  rows.sort((a, b) => a.when === b.when ? b.order - a.order : a.when < b.when ? 1 : -1);
  return rows.slice(0, Math.max(0, limit)).map(row => row.entry);
}
