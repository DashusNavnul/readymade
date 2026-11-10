import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { CandidateJournal, type CandidateIntent } from '../src/candidate-journal';
import { readCandidate } from '../src/candidate-store';
import { ShipClient, OutcomeUnknownError } from '../src/ship-client';
import type { CodingSnapshot } from '../src/protocol';
const scope = {enabled: true, generation: '1', providerKey: 'reviewer', provider: 'codex', model: 'model', binding: '0xa'};
function fixture(path: string) {
  const basis = {id: '0x1', owner: '~zod', desk: 'work', number: 1, root: '0v1', commit: '0v2'};
  const row = {id: '0x2', session: '0x4', request: '0x3', actor: '~zod', basis, sourceId: basis.id, source: '1', stage: 'review', decision: 'pending',
    workspace: '', artifact: '', reason: '', landed: null, edits: [{path: '/lib/a/hoon', kind: 'modify', before: '0x5', after: '0x6'}], checkCount: 0, checks: []};
  const solo = {schema: 'native-coding-solo-review-view-v1', available: true, project: 'demo', scope: {...scope, project: 'demo'}, campaigns: [] as unknown[]};
  const state: CodingSnapshot = {nonce: '0v1', cursor: '0x1', owner: '~zod', session: '0x4', ready: true, after: 0, projects: [], records: [],
    sessions: [{id: '0x4', project: 'demo'}], reviews: [row], soloReview: solo};
  let posts = 0, drop = false;
  const client = {origin: 'https://zod.example', codingState: async () => state, startCandidateReview: async () => {
    posts++; assert.equal(new CandidateJournal(path).entries().length, 1);
    if (drop) throw new Error('Lost response'); return state;
  }};
  const intent: CandidateIntent = {version: 1, origin: client.origin, owner: '~zod', project: 'demo', session: '0x4', candidate: readCandidate(row, '~zod', '0x4'), scope};
  return {client, intent, state, row, solo, posts: () => posts, lose: () => {drop = true;}};
}
async function temporary(run: (path: string) => Promise<void>) {
  const path = fs.mkdtempSync(join(tmpdir(), 'readymade-candidate-'));
  try {await run(path);} finally {fs.rmSync(path, {recursive: true, force: true});}
}
test('review start survives response loss and restart without replay', () => temporary(async path => {
  const f = fixture(path); f.lose();
  await assert.rejects(new CandidateJournal(path).start(f.client, f.intent, true), /Lost response/);
  const reopened = new CandidateJournal(path), held = reopened.entries()[0];
  await assert.rejects(reopened.start(f.client, held, true), /not be submitted again/);
  assert.equal((await reopened.recover(f.client, held)).campaign, undefined);
  f.solo.campaigns = [{candidate: '0x2', mode: 'resolve', pending: null, reason: '', outcome: 'accept', attempt: 0}];
  const result = await reopened.recover(f.client, held);
  assert.equal(result.campaign!.outcome, 'accept'); assert.equal(result.candidate!.landed, undefined); assert.equal(f.posts(), 1);
}));
test('two windows compete for a single durable candidate start', () => temporary(async path => {
  const f = fixture(path);
  const results = await Promise.allSettled([new CandidateJournal(path).start(f.client, f.intent, true), new CandidateJournal(path).start(f.client, f.intent, true)]);
  assert.equal(f.posts(), 1); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
}));
test('consent, candidate and scope changes prevent dispatch', () => temporary(async path => {
  const f = fixture(path), j = new CandidateJournal(path);
  await assert.rejects(j.start(f.client, f.intent, false), /consent/);
  f.solo.scope.generation = '2'; await assert.rejects(j.start(f.client, f.intent, true), /changed/);
  f.solo.scope.generation = '1'; f.row.reason = 'changed'; await assert.rejects(j.start(f.client, f.intent, true), /changed/);
  assert.equal(f.posts(), 0); assert.equal(j.entries().length, 0);
}));
test('recovery rejects changed immutable evidence and foreign origins', () => temporary(async path => {
  const f = fixture(path), j = new CandidateJournal(path); await j.start(f.client, f.intent, true);
  await assert.rejects(j.recover({...f.client, origin: 'https://other.example'}, f.intent), /context/);
  f.row.edits[0].after = '0x7'; await assert.rejects(j.recover(f.client, f.intent), /evidence/);
  assert.equal(f.posts(), 1);
}));
test('missing or changed policy bindings cannot start a review', () => temporary(async path => {
  const f = fixture(path), j = new CandidateJournal(path);
  const legacy = {...f.intent, scope: {...f.intent.scope, binding: undefined}};
  await assert.rejects(j.start(f.client, legacy, true), /exact review policy binding/);
  f.solo.scope.binding = '0xb'; await assert.rejects(j.start(f.client, f.intent, true), /scope changed/);
  f.solo.scope.binding = '0x0'; await assert.rejects(j.start(f.client, f.intent, true), /Invalid candidate review scope/);
  assert.equal(f.posts(), 0); assert.equal(j.entries().length, 0);
}));
test('legacy retained starts remain readable without acquiring permission to replay', () => temporary(async path => {
  const f = fixture(path), j = new CandidateJournal(path); await j.start(f.client, f.intent, true);
  const file = join(path, fs.readdirSync(path).find(name => name.endsWith('.intent.json'))!);
  const old = JSON.parse(fs.readFileSync(file, 'utf8')); delete old.scope.binding;
  fs.writeFileSync(file, JSON.stringify(old));
  const reopened = new CandidateJournal(path), intent = reopened.entries()[0];
  assert.equal(intent.scope.binding, undefined);
  await reopened.recover(f.client, intent);
  await assert.rejects(reopened.start(f.client, intent, true), /exact review policy binding/);
  assert.equal(f.posts(), 1);
}));
test('real HTTP client sends exact native start and prevents replay after dropped response', async () => {
  let posts = 0, captured: unknown;
  const state = {nonce: '0v1', cursor: '0x1', owner: '~zod', session: '0x4', ready: true, after: 0, projects: [], records: [], sessions: [{id: '0x4', project: 'demo'}]};
  const server = http.createServer((req, res) => {
    if (req.url === '/~/login') {res.setHeader('Set-Cookie', 'urbauth-~zod=test; Path=/'); res.end(); return;}
    if (req.method === 'GET') {res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state)); return;}
    const chunks: Buffer[] = []; req.on('data', c => chunks.push(c)); req.on('end', () => {posts++; captured = JSON.parse(Buffer.concat(chunks).toString()); res.destroy();});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new ShipClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async () => 'fixture');
  const context = {owner: '~zod', project: 'demo', session: '0x4'};
  try {
    await client.signIn(); await client.codingState('0x4');
    await assert.rejects(client.startCandidateReview(context, '0x2', false, '0xa')); assert.equal(posts, 0);
    await assert.rejects(client.startCandidateReview(context, '0x2', true, '0x0')); assert.equal(posts, 0);
    await assert.rejects(client.startCandidateReview(context, '0x2', true, '0xa'), OutcomeUnknownError);
    assert.deepEqual(captured, {kind: 'solo-review-start', session: '0x4', candidate: '0x2', scopeBinding: '0xa', nonce: '0v1'});
    await client.codingState('0x4'); await assert.rejects(client.startCandidateReview(context, '0x2', true, '0xa')); assert.equal(posts, 1);
  } finally {client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});
