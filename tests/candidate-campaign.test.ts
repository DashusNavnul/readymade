import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateCampaigns } from '../src/candidate-campaign';
const campaign = {candidate: '0x2', mode: 'resolve', pending: '0x3', reason: '', outcome: '', attempt: 1};
const scope = {project: 'demo', generation: '1', enabled: true, providerKey: 'reviewer', provider: 'codex', model: 'model'};
const view = {schema: 'native-coding-solo-review-view-v1', available: true, project: 'demo', scope, campaigns: [campaign]};
test('native review retains pending request and does not turn acceptance into landing', () => {
  assert.equal(candidateCampaigns(view, 'demo', ['0x2'])!.campaigns[0].pending, '0x3');
  const result = candidateCampaigns({...view, campaigns: [{...campaign, pending: null, outcome: 'accept'}]}, 'demo', ['0x2'])!;
  assert.equal(result.campaigns[0].outcome, 'accept'); assert.equal('landed' in result, false);
});
test('missing, disabled and unavailable review scope remain distinct', () => {
  assert.equal(candidateCampaigns(null, 'demo', []), undefined);
  assert.equal(candidateCampaigns({...view, scope: null}, 'demo', ['0x2'])!.scope, undefined);
  assert.equal(candidateCampaigns({...view, scope: {...scope, enabled: false}}, 'demo', ['0x2'])!.scope!.enabled, false);
  assert.equal(candidateCampaigns({...view, available: false, project: '', scope: null}, 'demo', ['0x2'])!.available, false);
});
test('foreign, duplicated and malformed review records fail closed', () => {
  for (const change of [{project: 'other'}, {scope: {...scope, project: 'other'}}, {scope: {...scope, generation: '1000'}},
    {scope: {...scope, generation: '18.446.744.073.709.551.616'}}, {campaigns: [campaign, campaign]},
    {campaigns: [{...campaign, candidate: '0x9'}]}, {campaigns: [{...campaign, pending: '0x0'}]},
    {campaigns: [{...campaign, outcome: 'applied'}]}, {campaigns: [{...campaign, attempt: -1}]}]) {
    assert.throws(() => candidateCampaigns({...view, ...change}, 'demo', ['0x2']));
  }
  assert.equal(candidateCampaigns({...view, scope: {...scope, generation: '1.000'}}, 'demo', ['0x2'])!.scope!.generation, '1.000');
});
