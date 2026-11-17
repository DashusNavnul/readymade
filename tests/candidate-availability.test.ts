import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateCampaigns, candidateReviewer} from '../src/candidate-campaign';

const availability = {schema: 'native-review-availability-v1', observedAt: '~2026.11.13', transport: 'subscription',
  pairing: 'active', job: 'none', liveness: 'unobserved', authentication: 'unobserved', quota: 'unobserved'};
function fixture() {
  return {schema: 'native-coding-solo-review-view-v1', available: true, project: 'demo',
    scope: {project: 'demo', enabled: true, generation: '2', providerKey: 'new-reviewer', provider: 'codex', model: 'codex-cli'},
    availability: {...availability}, campaigns: [{candidate: '0x1', mode: 'challenge', pending: '0x2', reason: '', outcome: '', attempt: 0,
      availability: {...availability, pairing: 'revoked', job: 'claimed'}}]};
}
const read = (value: unknown) => candidateCampaigns(value, 'demo', ['0x1', '0x3'])!;

test('candidate retains original reviewer evidence after policy changes', () => {
  const review = read(fixture());
  assert.equal(candidateReviewer(review, '0x1')?.pairing, 'revoked');
  assert.equal(candidateReviewer(review, '0x1')?.job, 'claimed');
  assert.equal(candidateReviewer(review, '0x3')?.pairing, 'active');
  assert.equal(candidateReviewer(review, '0x1')?.authentication, 'unobserved');
  assert.equal(candidateReviewer(review, '0x1')?.quota, 'unobserved');
});
test('legacy or missing campaign observations never inherit another reviewer status', () => {
  const value = fixture();
  const without = {...value, campaigns: value.campaigns.map(campaign => ({...campaign, availability: undefined}))};
  assert.equal(candidateReviewer(read(without), '0x1'), undefined);
  assert.equal(candidateReviewer(read({...without, availability: null}), '0x3'), undefined);
  assert.equal(candidateReviewer(read({...without, availability: undefined}), '0x3'), undefined);
});
test('unsupported login/quota assertions and malformed dates are rejected', () => {
  for (const change of [{authentication: 'authenticated'}, {quota: 'available'}, {liveness: 'online'}, {pairing: 'online'},
    {job: 'running'}, {observedAt: '~2026.02.30'}, {schema: 'future'}, {transport: 'api'}, {transport: ['subscription']},
    {pairing: ['active']}, {job: ['none']}, {transport: 'unsupported', pairing: 'active'}]) {
    const value = fixture();
    assert.throws(() => read({...value, availability: {...value.availability, ...change}}));
  }
});
test('pending identity and absence agree with reported native job state', () => {
  const value = fixture();
  assert.throws(() => read({...value, campaigns: [{...value.campaigns[0], pending: null}]}));
  assert.throws(() => read({...value, campaigns: [{...value.campaigns[0], availability: {...availability}}]}));
  assert.throws(() => read({...value, availability: {...availability, job: 'claimed'}}));
  const complete = read({...value, campaigns: [{...value.campaigns[0], pending: null, availability: {...availability}}]});
  assert.equal(candidateReviewer(complete, '0x1')?.job, 'none');
});
test('observation keeps native time and discards unexpected private payloads', () => {
  const value = fixture();
  const review = read({...value, availability: {...availability, prompt: 'secret', capability: 'private'}});
  assert.equal(review.availability?.observedAt, '~2026.11.13');
  assert.equal(JSON.stringify(review).includes('secret'), false);
  assert.equal(JSON.stringify(review).includes('private'), false);
});
