import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as http from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {CandidateDecisionJournal, type CandidateDecisionIntent} from '../src/candidate-journal';
import {readCandidate} from '../src/candidate-store';
import {ShipClient, OutcomeUnknownError} from '../src/ship-client';
import type {CodingSnapshot} from '../src/protocol';

function fixture(directory: string) {
  const basis = {id: '0x1', owner: '~zod', desk: 'work', number: 1, root: '0v1', commit: '0v2'};
  const row = {id: '0x2', session: '0x4', request: '0x3', actor: '~zod', basis, sourceId: basis.id, source: '1', stage: 'review', decision: 'approve',
    workspace: '', artifact: '', reason: '', landed: null as unknown, edits: [{path: '/lib/a/hoon', kind: 'modify', before: '0x5', after: '0x6'}], checkCount: 1,
    checks: [{target: 'a', check: 'compile', passed: true, detail: 'Built by Ford'}]};
  const state = {candidateDecide: true, nonce: '0v1', cursor: '0x1', owner: '~zod', session: '0x4', ready: true, after: 0, projects: [], records: [],
    sessions: [{id: '0x4', project: 'demo', source: basis}], reviews: [row]} as unknown as CodingSnapshot;
  let posts = 0, drop = false;
  const client = {origin: 'https://zod.example', codingState: async () => state, applyReviewedCandidate: async () => {
    posts++; assert.equal(new CandidateDecisionJournal(directory).entries().length, 1);
    if (drop) throw new Error('Lost reply'); return state;
  }};
  const intent: CandidateDecisionIntent = {version: 1, origin: client.origin, owner: '~zod', project: 'demo', session: '0x4', candidate: readCandidate(row, '~zod', '0x4')};
  return {client, intent, state, row, posts: () => posts, lose: () => {drop = true;}};
}
async function temporary(run: (directory: string) => Promise<void>) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'readymade-apply-'));
  try {await run(directory);} finally {fs.rmSync(directory, {recursive: true, force: true});}
}
test('lost apply reply survives reopen; canonical landing settles without another write', () => temporary(async directory => {
  const f = fixture(directory), j = new CandidateDecisionJournal(directory); f.lose();
  await assert.rejects(j.apply(f.client, f.intent, true), /Lost reply/);
  const reopened = new CandidateDecisionJournal(directory), held = reopened.entries()[0];
  await assert.rejects(reopened.apply(f.client, held, true), /not be submitted again/);
  assert.equal((await reopened.recover(f.client, held)).applied, false);
  f.row.stage = 'applied'; f.row.landed = {...f.row.basis, id: '0x9', number: 2, root: '0v3', commit: '0v4'};
  assert.equal((await reopened.recover(f.client, held)).applied, true); assert.equal(f.posts(), 1);
}));
test('two windows can retain only one apply intent', () => temporary(async directory => {
  const f = fixture(directory);
  const results = await Promise.allSettled([new CandidateDecisionJournal(directory).apply(f.client, f.intent, true), new CandidateDecisionJournal(directory).apply(f.client, f.intent, true)]);
  assert.equal(f.posts(), 1); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
}));
test('consent, source drift and changed native approval prevent applying', () => temporary(async directory => {
  const f = fixture(directory), j = new CandidateDecisionJournal(directory);
  await assert.rejects(j.apply(f.client, f.intent, false), /consent/);
  delete f.state.candidateDecide; await assert.rejects(j.apply(f.client, f.intent, true), /Update the backend/);
  f.state.candidateDecide = true;
  f.state.sessions[0].source = {...f.row.basis, id: '0x9', number: 2};
  await assert.rejects(j.apply(f.client, f.intent, true), /working source changed/);
  f.state.sessions[0].source = f.row.basis; f.row.decision = 'revise';
  await assert.rejects(j.apply(f.client, f.intent, true), /approval changed/);
  assert.equal(f.posts(), 0); assert.equal(j.entries().length, 0);
}));
test('recovery rejects altered edit evidence and another origin', () => temporary(async directory => {
  const f = fixture(directory), j = new CandidateDecisionJournal(directory); await j.apply(f.client, f.intent, true);
  await assert.rejects(j.recover({...f.client, origin: 'https://other.example'}, f.intent), /context/);
  f.row.edits[0].after = '0x7'; await assert.rejects(j.recover(f.client, f.intent), /evidence/);
  assert.equal(f.posts(), 1);
}));
test('changing project during either preflight prevents retaining or sending an apply', () => temporary(async directory => {
  for (const changedAt of [1, 2]) {
    const f = fixture(directory), j = new CandidateDecisionJournal(directory); let reads = 0, active = true;
    f.client.codingState = async () => {if (++reads === changedAt) active = false; return f.state;};
    await assert.rejects(j.apply(f.client, f.intent, true, () => active), /context changed/);
    assert.equal(f.posts(), 0); assert.equal(j.entries().length, 0);
  }
}));
async function compatibilityFixture(directory: string) {
  const f = fixture(directory), j = new CandidateDecisionJournal(directory);
  f.row.reason = 'local-review-owner-incompatible'; f.intent.candidate = readCandidate(f.row, '~zod', '0x4');
  await j.apply(f.client, f.intent, true);
  f.row.reason = '';
  return {...f, j, current: {...f.intent, candidate: readCandidate(f.row, '~zod', '0x4')}};
}
test('one explicit compatibility continuation preserves the original intent after a lost reply', () => temporary(async directory => {
  const f = await compatibilityFixture(directory), file = join(directory, fs.readdirSync(directory).find(name => name.endsWith('.intent.json'))!);
  const original = fs.readFileSync(file, 'utf8');
  Object.assign(f.row.edits[0], {preview: {schema: 'native-coding-candidate-text-v1', original: 'old\n', proposed: 'new\n'}});
  f.current.candidate = readCandidate(f.row, '~zod', '0x4');
  assert.equal(f.j.canContinue(f.current), true);
  await assert.rejects(f.j.continue(f.client, f.current, false), /consent/); assert.equal(f.posts(), 1);
  f.lose(); await assert.rejects(f.j.continue(f.client, f.current, true), /Lost reply/);
  assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(f.posts(), 2);
  const reopened = new CandidateDecisionJournal(directory), continuation = new CandidateDecisionJournal(join(directory, 'continuation')).entries();
  assert.equal(continuation.length, 1); assert.deepEqual(continuation[0], f.current);
  assert.equal(reopened.canContinue(f.current), false);
  await assert.rejects(reopened.continue(f.client, f.current, true), /cannot be continued/);
  assert.equal((await reopened.recover(f.client, f.intent)).applied, false);
  f.row.stage = 'applied'; f.row.landed = {...f.row.basis, id: '0x9', number: 2, root: '0v3', commit: '0v4'};
  assert.equal((await reopened.recover(f.client, f.intent)).applied, true); assert.equal(f.posts(), 2);
}));
test('two windows can submit only one separate compatibility continuation', () => temporary(async directory => {
  const f = await compatibilityFixture(directory);
  const results = await Promise.allSettled([new CandidateDecisionJournal(directory).continue(f.client, f.current, true),
    new CandidateDecisionJournal(directory).continue(f.client, f.current, true)]);
  assert.equal(f.posts(), 2); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.j.entries().length, 1); assert.equal(new CandidateDecisionJournal(join(directory, 'continuation')).entries().length, 1);
}));
test('unknown or unrelated retained requests never authorize a compatibility continuation', async () => {
  for (const reason of [undefined, '', 'candidate-outcome-unknown', 'local-review-scope-revoked']) await temporary(async directory => {
    const f = fixture(directory), j = new CandidateDecisionJournal(directory);
    if (reason !== undefined) {
      f.row.reason = reason; f.intent.candidate = readCandidate(f.row, '~zod', '0x4'); await j.apply(f.client, f.intent, true);
    }
    const current = {...f.intent, candidate: {...f.intent.candidate, reason: ''}};
    assert.equal(j.canContinue(current), false); await assert.rejects(j.continue(f.client, current, true), /cannot be continued/);
    assert.equal(f.posts(), reason === undefined ? 0 : 1);
  });
});
test('continuation refuses changed approval evidence, source, identity and uncleared reasons', () => temporary(async directory => {
  const f = await compatibilityFixture(directory);
  const changes: ((intent: CandidateDecisionIntent) => void)[] = [
    i => {i.origin = 'https://other.example';}, i => {i.project = 'other';}, i => {i.candidate.request = '0xa';},
    i => {i.candidate.basis = {...i.candidate.basis, number: 2};}, i => {i.candidate.edits[0].after = '0xb';},
    i => {i.candidate.checks[0].passed = false;}, i => {i.candidate.checks[0].detail = 'Changed';},
    i => {i.candidate.checks.push({...i.candidate.checks[0]}); i.candidate.checkCount++;},
    i => {i.candidate.artifact = 'changed';}, i => {i.candidate.reason = 'local-review-owner-incompatible';},
    i => {i.candidate.reason = 'another-refusal';}, i => {i.candidate.stage = 'unknown';},
    i => {i.candidate.stage = 'landing';}, i => {i.candidate.stage = 'refused';}, i => {i.candidate.decision = 'revise';},
    i => {i.candidate.stage = 'applied'; i.candidate.landed = {...i.candidate.basis, id: '0xc', number: 2};}
  ];
  for (const change of changes) {
    const altered = structuredClone(f.current); change(altered); await assert.rejects(f.j.continue(f.client, altered, true));
  }
  assert.equal(f.posts(), 1); assert.equal(new CandidateDecisionJournal(join(directory, 'continuation')).entries().length, 0);
}));
test('continuation freshly rechecks native evidence and the active project before retaining intent', async () => {
  for (const mode of ['source', 'approval', 'project']) await temporary(async directory => {
    const f = await compatibilityFixture(directory); let reads = 0, active = true;
    f.client.codingState = async () => {
      if (mode === 'source') f.state.sessions[0].source = {...f.row.basis, id: '0x9', number: 2};
      if (++reads === 2) {
        if (mode === 'approval') f.row.checks[0].passed = false;
        if (mode === 'project') active = false;
      }
      return f.state;
    };
    await assert.rejects(f.j.continue(f.client, f.current, true, () => active), /changed/);
    assert.equal(f.posts(), 1); assert.equal(new CandidateDecisionJournal(join(directory, 'continuation')).entries().length, 0);
  });
});
test('HTTP apply carries only exact identity, basis and consent and never repeats lost delivery', async () => {
  let posts = 0, captured: unknown;
  const state = {candidateDecide: true, nonce: '0v1', cursor: '0x1', owner: '~zod', session: '0x4', ready: true, after: 0, projects: [], records: [],
    sessions: [{id: '0x4', project: 'demo', source: {id: '0x1'}}]};
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
    await assert.rejects(client.applyReviewedCandidate(context, '0x2', '0x1', false));
    await assert.rejects(client.applyReviewedCandidate(context, '0x2', '0x9', true)); assert.equal(posts, 0);
    await assert.rejects(client.applyReviewedCandidate(context, '0x2', '0x1', true), OutcomeUnknownError);
    assert.deepEqual(captured, {kind: 'candidate-decide', owner: '~zod', project: 'demo', session: '0x4', candidate: '0x2', basis: '0x1', consent: true, nonce: '0v1'});
    await client.codingState('0x4'); await assert.rejects(client.applyReviewedCandidate(context, '0x2', '0x1', true)); assert.equal(posts, 1);
  } finally {client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});
