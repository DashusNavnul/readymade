import test from 'node:test';
import assert from 'node:assert/strict';
import {codingHistory} from '../src/coding-history';
import type {CodingSnapshot} from '../src/protocol';

function page(after: number, more: boolean): CodingSnapshot {
  return {owner: '~zod', session: '0x1', nonce: '0v1', cursor: '0x0', ready: true, reset: false, more, after,
    projects: [], sessions: [{id: '0x1', project: 'demo', source: {id: '0x2'}}], records: [{sequence: after - 1, kind: 'tool'}]};
}
test('history reaches later retained results using reads only', async () => {
  const calls: number[] = [];
  const client = {origin: 'https://zod.example', codingState: async (session: string, after = 0) => {
    assert.equal(session, '0x1'); calls.push(after); return page(41, false);
  }};
  const result = await codingHistory(client, page(32, true));
  assert.deepEqual(calls, [32]); assert.deepEqual(result.records.map(row => row.sequence), [31, 40]);
});
test('history rejects source drift, reset, stalled cursors and overlapping records', async () => {
  for (const corrupt of ['source', 'reset', 'cursor', 'overlap']) {
    const next = page(41, false);
    if (corrupt === 'source') next.sessions[0].source = {id: '0x3'};
    if (corrupt === 'reset') next.reset = true;
    if (corrupt === 'cursor') {next.after = 32; next.more = true; next.records = [];}
    if (corrupt === 'overlap') next.records[0].sequence = 31;
    await assert.rejects(codingHistory({origin: 'https://zod.example', codingState: async () => next}, page(32, true)), /History/);
  }
});

test('unchanged freshly observed state reuses a complete scan without sharing mutable records', async () => {
  const first = {...page(32, true), cursor: '0xa'}, last = {...page(65, false), cursor: '0xa'};
  const reads: number[] = [];
  const client = {origin: 'https://zod.example', codingState: async (_session: string, after = 0) => {
    reads.push(after); return after === 32 ? {...page(64, true), cursor: '0xa'} : structuredClone(last);
  }};
  const initial = await codingHistory(client, structuredClone(first));
  initial.records[2].kind = 'modified';
  const reused = await codingHistory(client, structuredClone(first));
  assert.deepEqual(reads, [32, 64, 64]); assert.equal(reused.records[2].kind, 'tool');
  reused.records.length = 0;
  assert.equal((await codingHistory(client, structuredClone(first))).records.length, 3);
});

test('fresh authority, identity, cursor and first-page changes invalidate retained history', async () => {
  for (const change of ['cursor', 'nonce', 'grants', 'records', 'origin', 'client', 'source', 'project', 'owner']) {
    const first: CodingSnapshot = {...page(32, true), cursor: '0xa'};
    let next: CodingSnapshot = {...page(41, false), cursor: '0xa'};
    let reads = 0;
    let client = {origin: 'https://zod.example', codingState: async () => {reads++; return structuredClone(next);}};
    await codingHistory(client, structuredClone(first));
    const fresh: CodingSnapshot = structuredClone(first);
    if (change === 'cursor') fresh.cursor = '0xb';
    if (change === 'nonce') fresh.nonce = '0v2';
    if (change === 'grants') fresh.grants = [{revoked: true}];
    if (change === 'records') fresh.records[0].text = 'changed';
    if (change === 'origin') client.origin = 'https://other.example';
    if (change === 'client') client = {...client};
    if (change === 'source') fresh.sessions[0].source = {id: '0x3'};
    if (change === 'project') fresh.sessions[0].project = 'other';
    if (change === 'owner') fresh.owner = '~nec';
    next = {...structuredClone(fresh), after: 41, more: false, records: [{sequence: 40, kind: 'tool'}]};
    await codingHistory(client, fresh);
    assert.equal(reads, 2, change);
  }
});

test('unstable cursors, resets and failed scans cannot revive a prior completed scan', async () => {
  for (const mode of ['unstable', 'zero', 'reset', 'failure']) {
    const first = {...page(32, true), cursor: mode === 'zero' ? '0x0' : '0xa'};
    let reads = 0, fail = false;
    const client = {origin: 'https://zod.example', codingState: async () => {
      reads++; if (fail) throw new Error('offline');
      return {...page(41, false), cursor: mode === 'unstable' ? '0xb' : first.cursor};
    }};
    await codingHistory(client, structuredClone(first));
    if (mode === 'reset') await assert.rejects(codingHistory(client, {...first, reset: true}), /History/);
    if (mode === 'failure') {
      fail = true; await assert.rejects(codingHistory(client, {...first, cursor: '0xc'}), /offline/); fail = false;
    }
    await codingHistory(client, structuredClone(first));
    assert.equal(reads, mode === 'failure' ? 3 : 2, mode);
  }
});

test('tail drift rereads the current head; tail failure never returns saved records', async () => {
  const first = {...page(32, true), cursor: '0xa'};
  let cursor = '0xa', fail = false;
  const calls: number[] = [];
  const client = {origin: 'https://zod.example', codingState: async (_session: string, after = 0) => {
    calls.push(after); if (fail) throw new Error('offline');
    return after === 0 ? {...first, cursor} : {...page(41, false), cursor};
  }};
  await codingHistory(client, structuredClone(first));
  cursor = '0xb';
  assert.equal((await codingHistory(client, structuredClone(first))).cursor, '0xb');
  assert.deepEqual(calls, [32, 32, 0, 32]);
  fail = true;
  await assert.rejects(codingHistory(client, {...first, cursor}), /offline/);
  fail = false;
  await codingHistory(client, {...first, cursor});
  assert.deepEqual(calls, [32, 32, 0, 32, 32, 32]);
});
