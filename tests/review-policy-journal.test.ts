import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewPolicyJournal, type ReviewPolicyIntent } from '../src/review-policy-journal';
import type { CodingSnapshot } from '../src/protocol';
function fixture(directory: string) {
  const provider = {key: 'reviewer', binding: '0xa', provider: 'codex', model: 'model'};
  const solo = {schema: 'native-coding-solo-review-view-v1', available: true, project: 'demo', scope: null as unknown,
    providers: [provider], campaigns: []};
  const state: CodingSnapshot = {nonce: '0v1', cursor: '0x1', owner: '~zod', session: '0x4', ready: true,
    after: 0, projects: [], records: [], sessions: [{id: '0x4', project: 'demo'}], soloReview: solo};
  let posts = 0, lost = false;
  const client = {origin: 'https://zod.example', codingState: async () => state, configureReviewPolicy: async () => {
    posts++; assert.equal(new ReviewPolicyJournal(directory).entries().length, 1);
    if (lost) throw new Error('Lost response'); return state;
  }};
  const intent: ReviewPolicyIntent = {version: 1, origin: client.origin, owner: '~zod', session: '0x4', project: 'demo',
    change: {previous: '0', provider}};
  return {client, intent, state, solo, posts: () => posts, lose: () => {lost = true;}};
}
async function temporary(run: (directory: string) => Promise<void>) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'readymade-policy-'));
  try {await run(directory);} finally {fs.rmSync(directory, {recursive: true, force: true});}
}
test('policy intent survives response loss and recovery never claims delivery or replays', () => temporary(async directory => {
  const f = fixture(directory); f.lose();
  await assert.rejects(new ReviewPolicyJournal(directory).configure(f.client, f.intent, true), /Lost response/);
  const reopened = new ReviewPolicyJournal(directory), retained = reopened.entries()[0];
  assert.equal((await reopened.recover(f.client, retained)).observed.scope, undefined);
  await assert.rejects(reopened.configure(f.client, retained, true), /not be submitted again/);
  f.solo.scope = {project: 'demo', generation: '1', enabled: true, providerKey: 'reviewer', provider: 'codex', model: 'model', binding: '0xb'};
  const observed = await reopened.recover(f.client, retained);
  assert.equal(observed.observed.scope?.generation, '1'); assert.match(observed.notice, /not a delivery receipt/);
  assert.equal(f.posts(), 1);
}));
test('concurrent windows share one project-generation slot', () => temporary(async directory => {
  const f = fixture(directory);
  const results = await Promise.allSettled([new ReviewPolicyJournal(directory).configure(f.client, f.intent, true),
    new ReviewPolicyJournal(directory).configure(f.client, f.intent, true)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.posts(), 1);
  f.state.session = '0x5'; f.state.sessions = [{id: '0x5', project: 'demo'}];
  await assert.rejects(new ReviewPolicyJournal(directory).configure(f.client, {...f.intent, session: '0x5'}, true), /not be submitted again/);
  assert.equal(f.posts(), 1);
}));
test('changed provider, owner and absent consent leave no intent or write', () => temporary(async directory => {
  const f = fixture(directory), journal = new ReviewPolicyJournal(directory);
  await assert.rejects(journal.configure(f.client, f.intent, false), /confirmation/);
  f.state.owner = '~nec'; await assert.rejects(journal.configure(f.client, f.intent, true), /owner changed/);
  f.state.owner = '~zod'; f.solo.providers = [{...f.solo.providers[0], binding: '0xc'}];
  await assert.rejects(journal.configure(f.client, f.intent, true), /selection changed/);
  assert.equal(journal.entries().length, 0); assert.equal(f.posts(), 0);
}));
test('journal recovery refuses foreign origin and changed retained selection', () => temporary(async directory => {
  const f = fixture(directory), journal = new ReviewPolicyJournal(directory);
  await journal.configure(f.client, f.intent, true);
  await assert.rejects(journal.recover({...f.client, origin: 'https://other.example'}, f.intent), /context changed/);
  await assert.rejects(journal.recover(f.client, {...f.intent, change: {previous: '0', provider: {...f.intent.change.provider!, model: 'other'}}}), /context changed/);
  const file = join(directory, fs.readdirSync(directory)[0]); fs.chmodSync(file, 0o644);
  assert.throws(() => journal.entries(), /private and owned/); assert.equal(f.posts(), 1);
}));
