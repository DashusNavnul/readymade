import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { reviewGeneration, reviewPolicy, reviewPolicyCommand, reviewProvider } from '../src/review-policy';
import { ShipClient, OutcomeUnknownError } from '../src/ship-client';
import type { CodingSnapshot } from '../src/protocol';
const provider = {key: 'reviewer', binding: '0xa', provider: 'codex', model: 'qualified-model'};
function fixture(): CodingSnapshot {
  return {nonce: '0v1', cursor: '0x1', owner: '~zod', session: '0x4', ready: true, after: 0, projects: [], records: [],
    sessions: [{id: '0x4', project: 'demo'}], soloReview: {schema: 'native-coding-solo-review-view-v1', available: true,
      project: 'demo', scope: null, providers: [provider], campaigns: []}};
}
function enabled(): CodingSnapshot {
  const state = fixture();
  (state.soloReview as Record<string, unknown>).scope = {project: 'demo', enabled: true, generation: '1',
    providerKey: provider.key, provider: provider.provider, model: provider.model, binding: '0xb'};
  return state;
}
test('policy command binds the complete provider selection, separately from scope digest', () => {
  const state = enabled();
  assert.deepEqual(reviewPolicyCommand(state, '0x4', 'demo', {previous: '1', provider}, true),
    {kind: 'solo-review-enable', session: '0x4', project: 'demo', previous: '1', providerKey: 'reviewer', binding: '0xa', consent: true});
  assert.deepEqual(reviewPolicyCommand(state, '0x4', 'demo', {previous: '1'}, true),
    {kind: 'solo-review-disable', session: '0x4', project: 'demo', previous: '1'});
  assert.equal(reviewPolicy(fixture(), '0x4', 'demo').scope, undefined);
});
test('stale policy, changed provider, absent consent and foreign sessions refuse before dispatch', () => {
  const state = enabled();
  assert.throws(() => reviewPolicyCommand(state, '0x4', 'demo', {previous: '0', provider}, true), /policy changed/);
  for (const changed of [{...provider, binding: '0xc'}, {...provider, model: 'other'}, {...provider, key: 'other'}])
    assert.throws(() => reviewPolicyCommand(state, '0x4', 'demo', {previous: '1', provider: changed}, true), /selection changed/);
  assert.throws(() => reviewPolicyCommand(state, '0x4', 'demo', {previous: '1'}, false), /confirmation/);
  assert.throws(() => reviewPolicyCommand(state, '0x5', 'demo', {previous: '1'}, true), /context/);
  assert.throws(() => reviewPolicyCommand(state, '0x4', 'other', {previous: '1'}, true), /context/);
  assert.throws(() => reviewPolicyCommand(fixture(), '0x4', 'demo', {previous: '0'}, true), /not enabled/);
});
test('native provider catalog refuses ambiguous or malformed entries and marks its limit', () => {
  assert.equal(reviewProvider({...provider, key: 'Reviewer_2'}).key, 'Reviewer_2');
  assert.throws(() => reviewProvider({...provider, key: 'a'.repeat(65)}));
  for (const bad of ['0x0', '0x00', '0x0001', '0x1.' + Array(17).fill('aaaa').join('.')])
    assert.throws(() => reviewProvider({...provider, binding: bad}));
  for (const model of ['', '\ud800', 'a'.repeat(257)]) assert.throws(() => reviewProvider({...provider, model}));
  const state = fixture(), raw = state.soloReview as Record<string, unknown>;
  raw.providers = [provider, provider]; assert.throws(() => reviewPolicy(state, '0x4', 'demo'), /Duplicate/);
  raw.providers = Array.from({length: 64}, (_, i) => ({...provider, key: `reviewer-${i}`}));
  assert.equal(reviewPolicy(state, '0x4', 'demo').possiblyTruncated, true);
  (raw.providers as unknown[]).push(provider); assert.throws(() => reviewPolicy(state, '0x4', 'demo'));
  delete raw.providers; assert.throws(() => reviewPolicy(state, '0x4', 'demo'));
});
test('generation arithmetic remains within native unsigned 64-bit capacity', () => {
  assert.equal(reviewGeneration('18.446.744.073.709.551.614'), '18.446.744.073.709.551.614');
  for (const bad of ['01', '1000', '1.00', '-1', '18.446.744.073.709.551.615', '999'.repeat(100)]) assert.throws(() => reviewGeneration(bad));
});
test('an unreported model cannot be enabled but does not prevent disabling review', () => {
  const state = enabled(), unknown = {...provider, model: 'model-unreported'};
  (state.soloReview as Record<string, unknown>).providers = [unknown];
  assert.throws(() => reviewPolicyCommand(state, '0x4', 'demo', {previous: '1', provider: unknown}, true), /identity is unavailable/);
  assert.equal(reviewPolicyCommand(state, '0x4', 'demo', {previous: '1'}, true).kind, 'solo-review-disable');
});
test('HTTP policy command sends once and cannot replay an unknown result across sessions', async () => {
  let posts = 0, captured: unknown; const state = fixture();
  const server = http.createServer((req, res) => {
    if (req.url === '/~/login') {res.setHeader('Set-Cookie', 'urbauth-~zod=fixture; Path=/'); res.end(); return;}
    if (req.method === 'GET') {res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state)); return;}
    const chunks: Buffer[] = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      posts++; captured = JSON.parse(Buffer.concat(chunks).toString()); res.destroy();
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new ShipClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async () => 'fixture');
  const context = {owner: '~zod', session: '0x4', project: 'demo'}, change = {previous: '0', provider};
  try {
    await client.signIn(); await client.codingState('0x4');
    await assert.rejects(client.configureReviewPolicy({...context, owner: '~nec'}, change, true));
    await assert.rejects(client.configureReviewPolicy(context, change, false)); assert.equal(posts, 0);
    await assert.rejects(client.configureReviewPolicy(context, change, true), OutcomeUnknownError);
    assert.deepEqual(captured, {kind: 'solo-review-enable', session: '0x4', project: 'demo', previous: '0',
      providerKey: 'reviewer', binding: '0xa', consent: true, nonce: '0v1'});
    state.session = '0x5'; state.sessions = [{id: '0x5', project: 'demo'}]; await client.codingState('0x5');
    await assert.rejects(client.configureReviewPolicy({...context, session: '0x5'}, change, true)); assert.equal(posts, 1);
  } finally {client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});
