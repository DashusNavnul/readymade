import test from 'node:test';
import assert from 'node:assert/strict';
import { readCandidate, observeCandidates } from '../src/candidate-store';
import type { CodingSnapshot, JsonObject } from '../src/protocol';
const basis = {id: '0x1', owner: '~zod', desk: 'work', number: 1000, root: '0v1', commit: '0v2'};
function row(): JsonObject { return {id: '0x2', request: '0x3', session: '0x4', actor: '~zod', basis, sourceId: basis.id, source: '1.000',
  stage: 'review', decision: 'pending', workspace: '', artifact: '', reason: '', landed: null,
  edits: [{path: '/lib/main/hoon', kind: 'modify', before: '0x5', after: '0x6'}], checkCount: 1,
  checks: [{target: 'main', check: 'compile', passed: true, detail: 'Native compile'}]}; }
test('candidate retains exact basis and separates checks from landing', () => {
  const c = readCandidate(row(), '~zod', '0x4'); assert.equal(c.basis.number, 1000); assert.equal(c.landed, undefined);
  assert.equal(c.checksTruncated, false); assert.equal(c.decision, 'pending');
});
test('candidate exposes clipped check list and never fills unseen results', () => {
  const r = row(); r.checkCount = 9; r.checks = Array.from({length: 8}, (_, n) => ({target: 'main', check: String(n), passed: true, detail: ''}));
  const c = readCandidate(r, '~zod', '0x4'); assert.equal(c.checksTruncated, true); assert.equal(c.checks.length, 8);
  (r.checks as JsonObject[]).pop(); assert.throws(() => readCandidate(r, '~zod', '0x4'));
});
test('foreign identities, conflicting source and invented landing are rejected', () => {
  for (const change of [{session: '0x8'}, {actor: '~nec'}, {sourceId: '0x9'}, {source: '1000'}, {stage: 'applied'}, {landed: {...basis, number: 1001}}]) {
    assert.throws(() => readCandidate({...row(), ...change}, '~zod', '0x4'));
  }
  const applied = {...row(), stage: 'applied', decision: 'approve', landed: {...basis, id: '0x9', number: 1001}};
  assert.equal(readCandidate(applied, '~zod', '0x4').landed!.number, 1001);
});
test('edit fingerprints and unique paths remain mandatory', () => {
  const r = row(); const edit = (r.edits as JsonObject[])[0]; edit.after = ''; assert.throws(() => readCandidate(r, '~zod', '0x4'));
  edit.after = '0x6'; (r.edits as JsonObject[]).push({...edit}); assert.throws(() => readCandidate(r, '~zod', '0x4'));
});
test('candidate observation is session/project scoped and flags the native list ceiling', async () => {
  const state = {session: '0x4', owner: '~zod', sessions: [{id: '0x4', project: 'demo'}], reviews: [row()]} as unknown as CodingSnapshot;
  const client = {codingState: async () => state};
  assert.equal((await observeCandidates(client, '0x4', 'demo')).candidates.length, 1);
  await assert.rejects(observeCandidates(client, '0x4', 'other'));
  state.reviews = Array.from({length: 8}, (_, n) => ({...row(), id: `0x${n + 10}`}));
  assert.equal((await observeCandidates(client, '0x4', 'demo')).possiblyTruncated, true);
  state.reviews[1] = state.reviews[0]; await assert.rejects(observeCandidates(client, '0x4', 'demo'));
});
