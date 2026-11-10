import test from 'node:test';
import assert from 'node:assert/strict';
import {checkLocations, checkProblemReport, exactProblemSource} from '../src/check-problems';
import {snapshotFrom} from '../src/source-store';
const source = {id: '0x1', owner: '~zod', desk: 'demo', number: 2, root: '0v1', commit: '0v2'};
const report = {origin: 'https://zod.example', owner: '~zod', project: 'demo', session: '0x2', sequence: 3, source,
  values: [{name: 'compile', passed: false, detail: 'nest-fail\n/lib/example/hoon:<[2 1].[2 4]>'}]};
test('only exact native mook path and spot produces navigation; unrelated numbers never imply lines', () => {
  assert.deepEqual(checkLocations(report.values[0].detail), [{path: '/lib/example/hoon', line: 2, column: 1, endLine: 2, endColumn: 4}]);
  for (const detail of ['/lib/example/hoon:42', 'line 4 column 8', '/lib/../hoon:<[2 1].[2 4]>', '/lib/example/hoon:<[0 1].[2 4]>', '/lib/example/hoon:<[2 4].[2 1]>', '/lib/example/hoon:<[02 1].[2 4]>', '/~zod/demo/2/lib/example/hoon:<[2 1].[2 4]>']) assert.deepEqual(checkLocations(detail), []);
  assert.equal(checkLocations('/lib/example/hoon:<[1.001 1].[1.001 2]>')[0].line, 1001);
});
test('navigation requires exact owner origin session revision path and bounds, never current-file substitution', () => {
  const parsed = checkProblemReport(JSON.stringify(report)), location = checkLocations(parsed.values[0].detail)[0];
  const snapshot = snapshotFrom({origin: report.origin, ship: '~zod', session: report.session, source, path: location.path, blob: '0x3', mark: 'hoon', text: '|%\nabc\n--\n'});
  exactProblemSource(parsed, location, snapshot);
  for (const patch of [{origin: 'https://other.example'}, {ship: '~nec'}, {session: '0x4'}, {source: {...source, number: 3}}, {path: '/lib/other/hoon'}, {text: 'short'}]) assert.throws(() => exactProblemSource(parsed, location, {...snapshot, ...patch}));
  assert.throws(() => checkProblemReport(JSON.stringify({...report, owner: '~nec'})));
  assert.throws(() => checkProblemReport(JSON.stringify({...report, values: [{passed: false, detail: 4, name: 'compile'}]})));
});
