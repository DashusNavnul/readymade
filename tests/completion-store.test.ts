import test from 'node:test';
import assert from 'node:assert/strict';
import { completionId, observeCompletion, readCompletion } from '../src/completion-store';
import type { JsonObject } from '../src/protocol';

const context = {owner: '~zod', project: 'demo', session: '0x1'};
function fixture(): JsonObject {
  const source = {owner: '~zod', desk: 'work', number: '1.001', root: '0v1', commit: '0v2'};
  return {available: true, session: '0x1', campaigns: [], ownerReceipt: null, proposal: {ready: true, reason: '', value: {
    tag: 'native-coding-completion-proposal-v1', digest: '0x2', session: '0x1', project: 'demo', configuration: '0x3',
    source, accepted: {...source, desk: 'base'}, grant: '0x4', assignment: null, objective: 'Review real work',
    latest: '0x5', head: '0x6', sequence: '1.024', model: '0x7', snapshot: '0x8', evidence: [{record: '0x9', tool: '0xa', result: '0xb'}]
  }}};
}
test('completion retains exact native numbers and immutable response ownership', () => {
  const raw = fixture(), result = readCompletion(raw, context);
  assert.equal((result.proposal!.source as JsonObject).number, '1.001');
  assert.equal(result.proposal!.sequence, '1.024');
  (raw.proposal as JsonObject).value = null;
  assert.equal(result.proposal!.digest, '0x2');
});
test('completion refuses foreign scope, malformed identifiers and bad evidence joins', () => {
  for (const change of [
    (p: JsonObject) => {p.session = '0x2';}, (p: JsonObject) => {p.project = 'foreign';},
    (p: JsonObject) => {(p.source as JsonObject).owner = '~nec';}, (p: JsonObject) => {p.digest = '0x02';},
    (p: JsonObject) => {p.sequence = '1024';}, (p: JsonObject) => {p.sequence = '4.097';},
    (p: JsonObject) => {p.evidence = [];}, (p: JsonObject) => {p.evidence = [...p.evidence as unknown[], ...p.evidence as unknown[]];},
    (p: JsonObject) => {p.accepted = p.source;}
  ]) {
    const raw = fixture(); change((raw.proposal as JsonObject).value as JsonObject);
    assert.throws(() => readCompletion(raw, context));
  }
  assert.equal(completionId('0x0'), false); assert.equal(completionId('0x1000.0000'), true);
});
test('not ready and unavailable remain explicit rather than accepting empty evidence', () => {
  const raw = fixture(); raw.proposal = {ready: false, reason: 'completion-pending-work', value: null};
  assert.equal(readCompletion(raw, context).reason, 'completion-pending-work');
  assert.equal(readCompletion(raw, context).proposal, undefined);
  raw.available = false; assert.throws(() => readCompletion(raw, context));
  delete raw.proposal; assert.equal(readCompletion(raw, context).available, false);
});
test('campaign application cannot contradict retained provenance', () => {
  const raw = fixture(), campaign = {id: '0xe', project: 'demo', historical: true, reviewReady: false, scopeCurrent: true,
    application: 'none', applied: false, receipt: null, outcome: null, provenance: null, reason: '', proposal: null, jobs: []};
  raw.campaigns = [campaign]; assert.equal(readCompletion(raw, context).campaigns.length, 1);
  for (const patch of [{applied: true}, {application: 'retained'}, {application: 'unconfirmed'}, {receipt: '0xf'}, {proposal: {digest: '0x1'}}]) {
    raw.campaigns = [{...campaign, ...patch}]; assert.throws(() => readCompletion(raw, context));
  }
  raw.campaigns = [{...campaign, application: 'unconfirmed', applied: null, receipt: '0xf'}];
  assert.equal(readCompletion(raw, context).campaigns[0].applied, null);
});
test('exact historical receipt recovery never mistakes a newer judgment for delivery', async () => {
  const raw = fixture(); raw.ownerReceipt = {key: '0xc', session: '0x1', proposal: '0x2', judgment: '0xd', historical: true, verdict: 'complete', reason: 'Reviewed'};
  const calls: string[] = [];
  const result = await observeCompletion({requestJSON: async path => {calls.push(path); return raw;}}, context, '0x2');
  assert.equal(result.ownerReceipt!.proposal, '0x2');
  assert.deepEqual(calls, ['/apps/pataphor-native/coding/completion?session=0x1&proposal=0x2']);
  await assert.rejects(observeCompletion({requestJSON: async () => raw}, context, '0x3'), /Unbound/);
  (raw.ownerReceipt as JsonObject).historical = false; assert.throws(() => readCompletion(raw, context));
});
