import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompletionJournal } from '../src/completion-journal';
import type { CompletionProposal } from '../src/completion-store';
import type { CodingSnapshot, JsonObject } from '../src/protocol';
import { ShipClientError } from '../src/ship-client';

const context = {owner: '~zod', project: 'demo', session: '0x1'};
const source = {owner: '~zod', desk: 'work', number: '1', root: '0v1', commit: '0v2'};
const proposal: CompletionProposal = {tag: 'native-coding-completion-proposal-v1', digest: '0x2', session: '0x1', project: 'demo',
  objective: 'Review work', configuration: '0x3', source, accepted: {...source, desk: 'base'}, grant: '0x4', assignment: null,
  latest: '0x5', head: '0x6', sequence: '10', model: '0x7', snapshot: '0x8', evidence: [{record: '0x9', tool: '0xa', result: '0xb'}]};
function fixture(directory: string) {
  let posts = 0, drop = false;
  const paths: string[] = [], state: CodingSnapshot = {nonce: '0v1', cursor: '0x1', owner: '~zod', session: '0x1', ready: true, after: 0,
    projects: [], sessions: [{id: '0x1', project: 'demo'}], records: []};
  const wire: JsonObject = {available: true, session: '0x1', campaigns: [], ownerReceipt: null, proposal: {ready: true, reason: '', value: proposal}};
  const client = {origin: 'https://zod.example', codingState: async () => state,
    requestJSON: async (path: string) => {paths.push(path); return structuredClone(wire);},
    acceptCompletion: async () => {
      posts++; const files = readdirSync(directory).filter(f => f.endsWith('.intent.json'));
      assert.equal(files.length, 1); assert.equal(JSON.parse(readFileSync(join(directory, files[0]), 'utf8')).reason, 'Reviewed');
      if (drop) throw new Error('Response lost'); return state;
    }};
  return {client, wire, paths, posts: () => posts, lose: () => {drop = true;}, receipt: (reason = 'Reviewed') => {
    wire.ownerReceipt = {key: '0xc', session: '0x1', proposal: '0x2', judgment: '0xd', historical: true, verdict: 'complete', reason};
  }};
}
async function temporary(run: (path: string) => Promise<void>): Promise<void> {
  const path = mkdtempSync(join(tmpdir(), 'readymade-completion-'));
  try {await run(path);} finally {rmSync(path, {recursive: true, force: true});}
}
test('lost response retains pre-send intent through restart; recovery never posts', () => temporary(async path => {
  const f = fixture(path); f.lose(); const journal = new CompletionJournal(path);
  await assert.rejects(journal.accept(f.client, context, proposal, 'Reviewed', true), /Response lost/);
  const reopened = new CompletionJournal(path), held = reopened.entries()[0];
  assert.equal(held.receipt, undefined);
  await assert.rejects(reopened.accept(f.client, context, proposal, 'Reviewed', true), /not be submitted again/);
  assert.equal((await reopened.recover(f.client, held.intent)).receipt, undefined);
  f.receipt(); const settled = await reopened.recover(f.client, held.intent);
  assert.equal(settled.receipt!.judgment, '0xd'); assert.equal(f.posts(), 1);
  assert.equal(new CompletionJournal(path).entries()[0].receipt!.proposal, '0x2');
  assert.ok(f.paths.at(-1)!.endsWith('&proposal=0x2'));
}));
test('two journal instances cannot submit the same proposal concurrently', () => temporary(async path => {
  const f = fixture(path);
  const result = await Promise.allSettled([new CompletionJournal(path).accept(f.client, context, proposal, 'Reviewed', true),
    new CompletionJournal(path).accept(f.client, context, proposal, 'Reviewed', true)]);
  assert.equal(f.posts(), 1); assert.equal(result.filter(r => r.status === 'rejected').length, 1);
}));
test('different simultaneous proposals compete for one session submission slot', () => temporary(async path => {
  const a = fixture(path), b = fixture(path), other = {...proposal, digest: '0xe'};
  (b.wire.proposal as JsonObject).value = other;
  const results = await Promise.allSettled([new CompletionJournal(path).accept(a.client, context, proposal, 'Reviewed', true),
    new CompletionJournal(path).accept(b.client, context, other, 'Reviewed', true)]);
  assert.equal(a.posts() + b.posts(), 1); assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(new CompletionJournal(path).entries().length, 1);
}));
test('missing consent, changed proposal and wrong receipt reason do not authorize completion', () => temporary(async path => {
  const f = fixture(path), journal = new CompletionJournal(path);
  await assert.rejects(journal.accept(f.client, context, proposal, 'Reviewed', false), /consent/);
  await assert.rejects(journal.accept(f.client, context, {...proposal, digest: '0xe'}, 'Reviewed', true), /changed/);
  assert.equal(f.posts(), 0); assert.equal(journal.entries().length, 0);
  await journal.accept(f.client, context, proposal, 'Reviewed', true); f.receipt('Different decision');
  await assert.rejects(journal.recover(f.client, journal.entries()[0].intent), /reason/);
  assert.equal(journal.entries()[0].receipt, undefined);
  await assert.rejects(journal.recover({...f.client, origin: 'https://other.example'}, journal.entries()[0].intent), /origin/);
}));
test('damaged intent fails closed instead of disappearing and permitting replay', () => temporary(async path => {
  const f = fixture(path), journal = new CompletionJournal(path);
  await journal.accept(f.client, context, proposal, 'Reviewed', true);
  writeFileSync(join(path, readdirSync(path)[0]), '{');
  await assert.rejects(journal.accept(f.client, context, proposal, 'Reviewed', true)); assert.equal(f.posts(), 1);
}));
test('proven native refusal permits an explicit fresh attempt without replaying the refused record', () => temporary(async path => {
  const f = fixture(path), journal = new CompletionJournal(path);
  const refused = await journal.accept({...f.client, acceptCompletion: async () => {throw new ShipClientError('refused', 409);}}, context, proposal, 'Reviewed', true);
  assert.equal(refused.receipt, undefined); assert.equal(refused.refusal!.status, 409);
  const reopened = new CompletionJournal(path); assert.equal(reopened.entries()[0].refusal!.status, 409);
  let sends = 0;
  const retried = await reopened.accept({...f.client, acceptCompletion: async () => {sends++; return f.client.codingState();}}, context, proposal, 'Reviewed', true);
  assert.notEqual(retried.intent.attempt, refused.intent.attempt);
  assert.equal(sends, 1); assert.equal(reopened.entries().length, 2);
}));
