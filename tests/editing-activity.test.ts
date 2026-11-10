import test from 'node:test';
import assert from 'node:assert/strict';
import {activityBody, activityCommand, activityHeaders, activityReply, activitySelector} from '../src/editing-activity';

const target = {owner: '~zod', project: 'demo'}, selected = {...target, request: '0v1'};
const epoch = '~2026.11.08';
const update = {...target, operation: 'update' as const, epoch, sequence: '1', desk: 'demo-work', path: '/lib/example/hoon'};
const pending = {schema: 'readymade-editing-activity-result-v1', ...selected, status: 'pending', permissionGranted: false};
const ready = {...pending, status: 'ready', reason: null, epoch, at: '~2026.11.08..01.02.03..0001', selfSequence: '1',
  rows: [{ship: '~nec', desk: 'demo-work', path: '/lib/example/hoon'}]};

test('activity commands keep query, publication and stop explicit and bounded', () => {
  assert.deepEqual(activityCommand({...target, operation: 'query'}), {...target, operation: 'query'});
  assert.deepEqual(activityBody(update), {schema: 'readymade-editing-activity-v1', ...update});
  assert.deepEqual(activityCommand({...target, operation: 'stop', epoch, sequence: '2'}), {...target, operation: 'stop', epoch, sequence: '2'});
  for (const wrong of [
    {...target, operation: 'query', sequence: '1'}, {...update, actor: '~nec'}, {...update, operation: 'stop'},
    {...update, sequence: '0'}, {...update, sequence: '01'}, {...update, sequence: '1000'}, {...update, sequence: 1},
    {...update, sequence: '18.446.744.073.709.551.616'}, {...update, owner: 'zod'}, {...update, project: 'bad:project'},
    {...update, project: 'λ'.repeat(65)}, {...update, project: '\ud800'}, {...update, path: '/lib/../hoon'},
    {...update, path: '/lib/example/js'}, {...update, path: 'lib/example/hoon'}, {...update, path: '/lib/example/hoon/'},
    {...update, desk: 'Demo'}, {...update, desk: 'a'.repeat(65)}, {...update, schema: 'anything'},
  ]) assert.throws(() => activityCommand(wrong));
  assert.equal(activityCommand({...update, sequence: '18.446.744.073.709.551.615'}).operation, 'update');
});

test('canonical native dates retain exact fractions and reject normalization', () => {
  for (const valid of [epoch, '~2024.02.29', '~2000.02.29', '~1-.02.29',
    '~2026.11.09..04.02.34..8f53', '~2026.11.08..00.00.00..0000.0001',
    '~292277024401-.01.01..00.00.00..0000.0000.0000.0001']) {
    assert.equal(activityCommand({...update, epoch: valid}).operation, 'update');
  }
  for (const invalid of ['~2026.11.8', '~02026.11.08', '~2026.02.29', '~1900.02.29', '~2026.00.01', '~2026.13.01',
    '~2026.04.31', '~2026.11.08..00.00.00', '~2026.11.08..24.00.00', '~2026.11.08..01.60.00', '~2026.11.08..01.01.60',
    '~2026.11.08..01.01.01..ABCD', '~2026.11.08..01.01.01..0000', '~2026.11.08..01.01.01..1234.0000',
    '~2026.11.08..01.01.01..1234.1234.1234.1234.1234', '~292277024401-.01.01', '~999999999999.01.01', '2026-11-08']) {
    assert.throws(() => activityCommand({...update, epoch: invalid}), invalid);
  }
});

test('native request identity uses canonical base32 and exact selector headers', () => {
  assert.deepEqual(activityHeaders(selected), {'x-readymade-activity-owner': '~zod', 'x-readymade-project': 'demo', 'x-readymade-activity-request': '0v1'});
  const format = (n: bigint) => '0v' + n.toString(32).replace(/\B(?=(?:.{5})+$)/g, '.');
  assert.equal(activitySelector({...selected, request: format((1n << 256n) - 1n)}).request, format((1n << 256n) - 1n));
  for (const request of ['0v0', '0v01', '0v1.1', '0v1.0000w', '0vA', '0v100000', format(1n << 256n)]) {
    assert.throws(() => activitySelector({...selected, request}));
  }
  assert.throws(() => activitySelector({...selected, extra: true}));
});

test('POST accepts only pending correlation and GET never accepts another request or owner', () => {
  assert.equal(activityReply(202, pending, target).status, 'pending');
  assert.equal(activityReply(202, pending, selected).status, 'pending');
  for (const response of [
    {...pending, permissionGranted: true}, {...pending, owner: '~nec'}, {...pending, project: 'other'},
    {...pending, request: '0v2'}, {...pending, extra: []}, {...pending, schema: 'old'},
  ]) assert.throws(() => activityReply(202, response, selected));
  assert.throws(() => activityReply(200, ready, target));
  assert.throws(() => activityReply(200, pending, selected));
  assert.throws(() => activityReply(202, ready, selected));
});

test('filtered ready response preserves advisory scope and copies file rows', () => {
  const decoded = activityReply(200, ready, selected, update);
  assert.equal(decoded.status, 'ready');
  if (decoded.status !== 'ready') throw new Error('Ready result expected');
  assert.equal(decoded.permissionGranted, false); assert.equal(decoded.selfSequence, '1');
  assert.deepEqual(decoded.rows, ready.rows); assert.notEqual(decoded.rows, ready.rows); assert.notEqual(decoded.rows[0], ready.rows[0]);
  const empty = activityReply(200, {...ready, selfSequence: null, rows: []}, selected);
  assert.equal(empty.status, 'ready');
  for (const response of [
    {...ready, reason: 'anything'}, {...ready, epoch: '~2026.11.09'}, {...ready, at: '~2026.11.07'},
    {...ready, selfSequence: '0'}, {...ready, selfSequence: '2'}, {...ready, selfSequence: null},
    {...ready, selfSequence: 1}, {...ready, selfSequence: '1.00'},
    {...ready, selfSequence: '18.446.744.073.709.551.616'}, {...ready, rows: [...ready.rows, ...ready.rows]},
    {...ready, rows: Array(33).fill(ready.rows[0])}, {...ready, rows: [{...ready.rows[0], source: 'private'}]},
    {...ready, rows: [{...ready.rows[0], path: '/lib/private/js'}]}, {...ready, journal: {}},
  ]) assert.throws(() => activityReply(200, response, selected, update));
  assert.throws(() => activityReply(200, ready, selected, {...update, project: 'other'}));
  const stop = {...target, operation: 'stop' as const, epoch, sequence: '2'};
  assert.equal(activityReply(200, {...ready, selfSequence: '2', rows: []}, selected, stop).status, 'ready');
  assert.throws(() => activityReply(200, ready, selected, stop));
  assert.throws(() => activityReply(200, {...ready, at: '~2026.11.08..00.00.00..0001'}, selected,
    {...update, epoch: '~2026.11.08..00.00.00..0002'}));
});

test('timestamp ordering compares the entire native fraction without precision loss', () => {
  const earlier = '~2026.11.08..00.00.00..1234.5678.9abc.def0', later = '~2026.11.08..00.00.00..1234.5678.9abc.def1';
  assert.equal(activityReply(200, {...ready, epoch: earlier, at: later}, selected).status, 'ready');
  assert.throws(() => activityReply(200, {...ready, epoch: later, at: earlier}, selected));
});

test('refused, missing and expired replies provide no activity or retry authority', () => {
  const refused = {...ready, status: 'refused', reason: 'activity-permission-refused', epoch: null, at: null, rows: [], selfSequence: null};
  assert.equal(activityReply(200, refused, selected).status, 'refused');
  assert.throws(() => activityReply(200, {...refused, rows: ready.rows}, selected));
  assert.throws(() => activityReply(200, {...refused, selfSequence: '1'}, selected));
  for (const [status, reason, outcome] of [[404, 'request-not-retained', 'missing'], [410, 'request-expired-outcome-unknown', 'expired']] as const) {
    const body = {status: 'unavailable', reason, permissionGranted: false};
    assert.deepEqual(activityReply(status, body, selected), {...selected, permissionGranted: false, status: outcome});
    assert.throws(() => activityReply(status, {...body, reason: 'unknown-route'}, selected));
    assert.throws(() => activityReply(status, {...body, rows: []}, selected));
    assert.throws(() => activityReply(status, body, target));
  }
});

test('malformed objects and prototype-bearing values fail closed', () => {
  for (const value of [null, [], 1, 'query', Object.create(update)]) assert.throws(() => activityCommand(value));
  for (const value of [null, [], Object.create(ready)]) assert.throws(() => activityReply(200, value, selected));
});
