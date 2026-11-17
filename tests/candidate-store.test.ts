import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateBlocking, readCandidate, observeCandidates, readCheckSlot } from '../src/candidate-store';
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
test('candidate text previews retain exact whitespace and require bounded native evidence', () => {
  const r = row(), edit = (r.edits as JsonObject[])[0];
  edit.preview = {schema: 'native-coding-candidate-text-v1', original: 'old\r\n', proposed: 'new\n'};
  assert.deepEqual(readCandidate(r, '~zod', '0x4').edits[0].preview, edit.preview);
  for (const preview of [{schema: 'future', original: '', proposed: ''},
    {schema: 'native-coding-candidate-text-v1', original: 'x\0y', proposed: ''},
    {schema: 'native-coding-candidate-text-v1', original: '\ud800', proposed: ''},
    {schema: 'native-coding-candidate-text-v1', original: 'a'.repeat(32769), proposed: 'b'.repeat(32768)}]) {
    edit.preview = preview; assert.throws(() => readCandidate(r, '~zod', '0x4'));
  }
  edit.preview = null; assert.equal(readCandidate(r, '~zod', '0x4').edits[0].preview, undefined);
  edit.kind = 'add'; edit.before = ''; edit.preview = {schema: 'native-coding-candidate-text-v1', original: 'invented', proposed: 'new'};
  assert.throws(() => readCandidate(r, '~zod', '0x4'));
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
test('waiting condition preserves exact correlation without inventing a slot occupant', () => {
  const waiting = readCandidate({...row(), stage: 'cloning', reason: 'candidate-waiting-for-slot'}, '~zod', '0x4');
  const active = {...waiting, id: '0x7', request: '0x8', stage: 'checking', reason: ''};
  const unknown = {...active, id: '0x9', reason: 'worker-thread-unconfirmed', stage: 'unknown'};
  const evidence = candidateBlocking(waiting, [waiting, active, unknown, {...active, id: '0xa', session: '0xb'},
    {...active, id: '0xc', actor: '~nec'}, {...waiting, id: '0xd'}, {...active, id: '0xe', stage: 'review'}]);
  assert.equal(evidence.condition.reason, 'candidate-waiting-for-slot');
  assert.deepEqual(evidence.related, [
    {candidate: '0x7', session: '0x4', request: '0x8', stage: 'checking', reason: null},
    {candidate: '0x9', session: '0x4', request: '0x8', stage: 'unknown', reason: 'worker-thread-unconfirmed'}
  ]);
  assert.equal(evidence.slot?.status, 'unknown'); assert.deepEqual(evidence.slot?.blockers, []);
  assert.match(evidence.notice, /do not establish/);
});
test('an empty bounded summary never proves that a check slot is free', () => {
  const waiting = readCandidate({...row(), stage: 'cloning', reason: 'candidate-waiting-for-slot'}, '~zod', '0x4');
  const evidence = candidateBlocking(waiting, [waiting]);
  assert.equal(evidence.slot?.status, 'unknown'); assert.deepEqual(evidence.related, []);
});
test('missing native condition is distinguished from an explicit unknown reason', () => {
  const candidate = readCandidate(row(), '~zod', '0x4');
  assert.deepEqual(candidateBlocking(candidate, []).condition, {status: 'not-reported', reason: null});
  const uncertain = candidateBlocking({...candidate, stage: 'unknown', reason: 'worker-thread-unconfirmed'}, []);
  assert.deepEqual(uncertain.condition, {status: 'reported', reason: 'worker-thread-unconfirmed'});
  assert.equal(uncertain.slot, null);
});
const slot = () => ({schema: 'native-coding-check-slot-v1', owner: '~zod', observedAt: '~2026.11.13', available: true,
  condition: 'blocked', blockerCount: 1, truncated: false, blockers: [{candidate: '0x7', session: '0x8', request: '0x9', stage: 'unknown', reason: 'worker-thread-unconfirmed',
    worker: {request: '0xa', ticket: '0xb', ship: '~nec', sent: true, phase: 'unknown', resultPresent: false, resultReason: null}}]});
test('canonical blockers retain cross-session identity and exact worker correlation', async () => {
  const state = {session: '0x4', owner: '~zod', sessions: [{id: '0x4', project: 'demo'}], reviews: [row()], checkSlot: slot()} as unknown as CodingSnapshot;
  const seen = await observeCandidates({codingState: async () => state}, '0x4', 'demo');
  assert.equal(seen.checkSlot.status, 'blocked'); assert.deepEqual(seen.checkSlot.blockers, slot().blockers);
  const waiting = readCandidate({...row(), stage: 'cloning', reason: 'candidate-waiting-for-slot'}, '~zod', '0x4');
  assert.equal(candidateBlocking(waiting, [waiting], seen.checkSlot).slot, seen.checkSlot);
});
test('only complete native evidence reports a free slot', () => {
  const free = {...slot(), condition: 'free', blockerCount: 0, blockers: []};
  assert.equal(readCheckSlot(free, '~zod').status, 'free');
  for (const bad of [undefined, null, {...free, owner: '~nec'}, {...free, schema: 'future'}, {...free, available: false},
    {...free, blockerCount: 1}, {...free, truncated: true}, {...free, blockers: slot().blockers}, {...free, observedAt: 'yesterday'}]) {
    const result = readCheckSlot(bad, '~zod');
    assert.equal(result.status, 'unknown'); assert.equal(result.blockerCount, null); assert.deepEqual(result.blockers, []);
  }
  const unavailable = {...free, available: false, condition: 'unknown', blockerCount: null};
  assert.equal(readCheckSlot(unavailable, '~zod').status, 'unknown');
});
test('canonical slot validates full count, bounded rows, duplicates and truncated evidence', () => {
  const partial = {...slot(), blockerCount: 33, truncated: true,
    blockers: Array.from({length: 32}, (_, i) => ({...slot().blockers[0], candidate: `0x${(i + 1).toString(16)}`}))};
  const seen = readCheckSlot(partial, '~zod');
  assert.equal(seen.status, 'blocked'); assert.equal(seen.blockerCount, 33); assert.equal(seen.blockers.length, 32); assert.equal(seen.truncated, true);
  for (const bad of [{...partial, truncated: false}, {...partial, blockerCount: 513}, {...partial, blockers: partial.blockers.slice(1)},
    {...partial, blockers: [partial.blockers[0], ...partial.blockers.slice(0, 31)]}, {...partial, condition: 'free'}])
    assert.equal(readCheckSlot(bad, '~zod').status, 'unknown');
});
test('missing worker correlation differs from malformed or inconsistent worker evidence', () => {
  const b = slot().blockers[0], w = b.worker;
  assert.equal(readCheckSlot({...slot(), blockers: [{...b, worker: null}]}, '~zod').blockers[0].worker, null);
  for (const worker of [undefined, {...w, request: '0x0'}, {...w, ticket: 'invalid'}, {...w, ship: ''}, {...w, phase: 'invented'},
    {...w, resultPresent: true, sent: false}, {...w, resultReason: 'worker-deadline-unconfirmed'}, {...w, phase: 'checked'},
    {...w, phase: 'reserved'}, {...w, sent: 'yes'}])
    assert.equal(readCheckSlot({...slot(), blockers: [{...b, worker}]}, '~zod').status, 'unknown');
  assert.equal(readCheckSlot({...slot(), blockers: [{...b, stage: 'review'}]}, '~zod').status, 'unknown');
});
