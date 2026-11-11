import assert from 'node:assert/strict';
import test from 'node:test';
import {activityDay, projectActivity} from '../src/project-activity';
import type {EventRow} from '../src/project-invitations';

const event = (sequence: number, at: string, action: EventRow['action'], actor: string, subject: string | null, role: string | null): EventRow => ({sequence, at, actor, action, subject, role});
test('the feed merges the project history and suggestions by their own times, newest first', () => {
  const events = [event(3, '~2026.11.11..18.00.00', 'member-left', '~nec', '~nec', null), event(2, '~2026.11.11..12.00.00', 'invitation-accepted', '~nec', '~nec', 'contributor'),
    event(1, '~2026.11.10', 'project-opened', '~wes', null, null)];
  const feed = projectActivity(events, [{peer: '~nec', path: '/lib/x/hoon', receivedAt: '~2026.11.11..15.30.00..abcd'}, {peer: '~bud', path: '/app/y/hoon', receivedAt: 'not a date'}]);
  assert.deepEqual(feed.map(row => [row.day, row.kind, row.text]), [
    ['2026-11-11 18:00', 'membership', '~nec left'], ['2026-11-11 15:30', 'suggestion', '~nec suggested a change to /lib/x/hoon'],
    ['2026-11-11 12:00', 'membership', '~nec accepted as contributor'], ['2026-11-10', 'membership', '~wes opened the project']]);
  assert.equal(projectActivity(events, [], 2).length, 2);
});
test('records of the same instant keep the project order; days read plainly', () => {
  const same = [event(5, '~2026.11.11..18.00.00', 'invitation-accepted', '~nec', '~nec', 'observer'), event(4, '~2026.11.11..18.00.00', 'invitation-issued', '~wes', '~nec', 'observer')];
  assert.deepEqual(projectActivity(same, []).map(row => row.text), ['~nec accepted as observer', '~wes invited ~nec as observer']);
  assert.equal(activityDay('~2026.1.3..04.05.06..0e67'), '2026-01-03 04:05'); assert.equal(activityDay('~2026.11.11'), '2026-11-11'); assert.equal(activityDay('x'), 'x');
});
