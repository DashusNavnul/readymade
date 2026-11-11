import assert from 'node:assert/strict';
import test from 'node:test';
import {waitingCandidates, waitingReport, waitingSummary} from '../src/owner-inbox';

test('candidates wait on the owner when not yet under review or approved but not applied', () => {
  const rows = [{id: 'a', stage: 'review', decision: 'pending'}, {id: 'b', stage: 'review', decision: 'pending'}, {id: 'c', stage: 'review', decision: 'approve'},
    {id: 'd', stage: 'review', decision: 'approve', landed: true}, {id: 'e', stage: 'draft', decision: 'pending'}, {id: 'f', stage: 'review', decision: 'refuse'}];
  assert.deepEqual(waitingCandidates(rows, new Set(['b'])), {review: 1, apply: 1});
  assert.deepEqual(waitingCandidates([], new Set()), {review: 0, apply: 0});
});
test('the report lists only what has something in it, in acting order, and names what was not read', () => {
  const report = waitingReport({suggestions: 2, review: 0, apply: 1, requests: 3, answer: true}, 7);
  assert.deepEqual(report.items.map(item => [item.id, item.count]), [['requests', 3], ['suggestions', 2], ['apply', 1], ['answer', 1]]);
  assert.deepEqual(report.unchecked, ['invitations']); assert.equal(report.checkedAt, 7);
  assert.equal(report.items[1].label, '2 suggestions from collaborators'); assert.equal(report.items[2].label, '1 reviewed change ready to apply');
  assert.equal(waitingSummary(report), '7 things are waiting on you');
  assert.equal(waitingSummary(waitingReport({suggestions: 1, review: 0, apply: 0, requests: 0, answer: false, expiredInvitations: 0}, 1)), '1 thing is waiting on you');
});
test('an unread source is never reported as empty', () => {
  const all = waitingReport({suggestions: 0, review: 0, apply: 0, requests: 0, answer: false, expiredInvitations: 0}, 1);
  assert.equal(waitingSummary(all), 'Nothing is waiting on you');
  const partial = waitingReport({suggestions: 0}, 1);
  assert.deepEqual(partial.items, []); assert.equal(partial.unchecked.length, 5);
  assert.match(waitingSummary(partial), /^Nothing found; not checked: coding requests, changes to review, changes to apply, answers to accept, invitations$/);
});
