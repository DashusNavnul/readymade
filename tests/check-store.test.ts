import test from 'node:test';
import assert from 'node:assert/strict';
import { observeChecks, readCheck } from '../src/check-store';
import type { CodingSnapshot, JsonObject } from '../src/protocol';

const source = {id: '0xabc', owner: '~zod', desk: 'demo', number: 1, root: '0v1', commit: '0v2'};
function report(sequence = 0, passed = false): JsonObject {
  const request = `0x${(256 + sequence).toString(16)}`, callId = `call-${sequence}`;
  const value = {name: 'compile', passed, detail: 'Retained compiler detail\n/path:99 is text, not a structured location.', source, artifacts: ['0x123']};
  const {id: _id, ...rawSource} = source;
  return {id: `0x${(512 + sequence).toString(16)}`, sequence, kind: 'tool',
    file: {version: 'native-coding-problems-v1', kind: 'diagnostics', project: 'demo', session: '0x1', configuration: '0x3',
      request, callId, recordedAt: '~2026.11.4', source, value: {values: [value]}},
    text: JSON.stringify({version: 'native-coding-tool-result-v1', call_id: callId,
      context: {project: 'demo', session: '0x1', configuration: '0x3', request, source: rawSource}, output: {kind: 'diagnostics', values: [{...value, source: rawSource}]}})};
}
function state(records: JsonObject[] = [report()], more = false): CodingSnapshot {
  return {owner: '~zod', session: '0x1', nonce: '0v1', cursor: '0x1', ready: true,
    after: records.length ? Number(records.at(-1)!.sequence) + 1 : 0, more, reset: false,
    sessions: [{id: '0x1', project: 'demo', source}], projects: [{id: 'demo'}], records};
}
test('checks retain exact result identities, details and artifacts without deriving locations', () => {
  const held = readCheck(report(), '~zod', '0x1', 'demo')!;
  assert.equal(held.values[0].passed, false); assert.deepEqual(held.values[0].artifacts, ['0x123']);
  assert.equal(held.configuration, '0x3'); assert.notEqual(held.callId, held.request);
  assert.equal(Object.hasOwn(held.values[0], 'location'), false);
  assert.equal(readCheck({kind: 'terminal', text: 'passed'}, '~zod', '0x1', 'demo'), undefined);
});
test('raw result and projected check/source/configuration cannot disagree', () => {
  for (const field of ['passed', 'source', 'configuration', 'request', 'artifacts']) {
    const row = report(), raw = JSON.parse(row.text as string);
    if (field === 'passed') raw.output.values[0].passed = true;
    if (field === 'source') raw.output.values[0].source.commit = '0v3';
    if (field === 'configuration') raw.context.configuration = '0x4';
    if (field === 'request') raw.context.request = '0x4';
    if (field === 'artifacts') raw.output.values[0].artifacts = [];
    row.text = JSON.stringify(raw); assert.throws(() => readCheck(row, '~zod', '0x1', 'demo'));
  }
  assert.throws(() => readCheck(report(), '~zod', '0x2', 'demo'));
  assert.throws(() => readCheck(report(), '~zod', '0x1', 'private'));
  assert.throws(() => readCheck({...report(), file: null}, '~zod', '0x1', 'demo'), /unavailable/);
});
test('empty and oversized diagnostics are not green checks', () => {
  const empty = report(); ((empty.file as JsonObject).value as JsonObject).values = [];
  assert.throws(() => readCheck(empty, '~zod', '0x1', 'demo'));
  const large = report(), raw = JSON.parse(large.text as string);
  raw.output.values[0].detail = '🙂'.repeat(2049); large.text = JSON.stringify(raw);
  (((large.file as JsonObject).value as JsonObject).values as JsonObject[])[0].detail = raw.output.values[0].detail;
  assert.throws(() => readCheck(large, '~zod', '0x1', 'demo'));
});
test('native empty names and zero artifact IDs remain literal evidence', () => {
  const row = report(), raw = JSON.parse(row.text as string);
  const projected = (((row.file as JsonObject).value as JsonObject).values as JsonObject[])[0];
  projected.name = ''; projected.artifacts = ['0x0'];
  raw.output.values[0].name = ''; raw.output.values[0].artifacts = ['0x0']; row.text = JSON.stringify(raw);
  const held = readCheck(row, '~zod', '0x1', 'demo')!;
  assert.equal(held.values[0].name, ''); assert.deepEqual(held.values[0].artifacts, ['0x0']);
});
test('GET pagination finds newer checks after the first32 retained records', async () => {
  const calls: number[] = [];
  const observation = await observeChecks({origin: 'https://zod.example', codingState: async (_session, after = 0) => {
    calls.push(after);
    return after === 0 ? state(Array.from({length: 32}, (_, sequence) => ({kind: 'status', sequence})), true) : state([report(32, true)]);
  }}, '0x1', 'demo');
  assert.deepEqual(calls, [0, 32]); assert.equal(observation.records, 33);
  assert.equal(observation.reports[0].values[0].passed, true);
});
test('historical diagnostics remain bound to their old source, never the new revision', async () => {
  const current = state(); current.sessions[0].source = {...source, id: '0xdef', number: 2, commit: '0v3'};
  const observation = await observeChecks({origin: 'https://zod.example', codingState: async () => current}, '0x1', 'demo');
  assert.equal(observation.source.number, 2); assert.equal(observation.reports[0].source.number, 1);
});
test('changed source, reset, nonadvancing pages and conflicting check identities fail closed', async () => {
  for (const fault of ['source', 'reset', 'stalled', 'duplicate']) {
    const client = {origin: 'https://zod.example', codingState: async (_session: string, after = 0) => {
      if (after === 0) return state([report()], true);
      const next = state([report(1)]);
      if (fault === 'source') next.sessions[0].source = {...source, root: '0v3'};
      if (fault === 'reset') next.reset = true;
      if (fault === 'stalled') { next.records = []; next.after = after; next.more = true; }
      if (fault === 'duplicate') next.records[0].id = report().id;
      return next;
    }};
    await assert.rejects(observeChecks(client, '0x1', 'demo'));
  }
});
