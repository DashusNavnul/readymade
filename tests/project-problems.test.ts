import test from 'node:test';
import assert from 'node:assert/strict';
import {projectProblemRows} from '../src/project-problems';
import type {MediaTreeRow} from '../src/media-workbench';

function row(key: string, status: 'unknown' | 'blocked' = 'unknown'): MediaTreeRow {
  return {label: 'Check Result', tooltip: 'Original request retained; no resend.',
    command: {command: 'readymade.checkSharedSuggestion', title: 'Check Result', arguments: [key]},
    problem: {key, category: 'delivery', status, label: `Suggestion ${key} is ${status}`}};
}
test('consolidated problems retain exact corrective action and original context', () => {
  const source = row('request-a');
  const result = projectProblemRows([{label: 'owner / project', children: [source]}])[0].children![0];
  assert.equal(result.command, source.command);
  assert.equal(result.description, 'delivery · unknown');
  assert.match(result.tooltip!, /owner \/ project/);
  assert.match(result.tooltip!, /no resend/);
});
test('no guessing from labels, no conversion of unknown to failed, no historical state cache', () => {
  const ignored = {label: 'Failed request', command: {command: 'readymade.anything', title: 'Read'}};
  assert.equal(projectProblemRows([ignored])[0].description, undefined);
  assert.match(projectProblemRows([row('a')])[0].children![0].description!, /unknown/);
  assert.match(projectProblemRows([])[0].children![0].label, /current observations/);
});
test('deduplicates same evidence while preserving separate request identities and categories', () => {
  const a = row('a'), b = row('b'), check = row('a');
  check.problem = {...check.problem!, category: 'check'};
  const result = projectProblemRows([a, a, b, check])[0];
  assert.equal(result.description, '3');
  assert.equal(result.children!.length, 3);
});
test('bounds presentation without declaring omitted problems resolved', () => {
  const result = projectProblemRows(Array.from({length: 70}, (_, i) => row(String(i))))[0];
  assert.equal(result.description, '70');
  assert.equal(result.children!.length, 65);
  assert.match(result.children![64].label, /64 of 70/);
});
test('only existing actionable rows are linked and the derived section cannot consume itself', () => {
  const source = row('a');
  const withoutAction = {...source, command: undefined};
  const existing = projectProblemRows([source]);
  assert.equal(projectProblemRows([withoutAction, ...existing])[0].description, undefined);
});
