import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateCommand} from '../src/candidate-command';

const source = (text: string) => ({path: '/lib/large/hoon', mark: 'hoon', blob: '0x123', text});
const large = 'unchanged line\n'.repeat(6000);
function apply(original: string, command: string): string {
  const split = command.indexOf('\n'), header = command.slice(0, split).split(' '), body = Buffer.from(command.slice(split + 1));
  assert.equal(header[0], '/patch');
  const [start, remove, bytes] = header.slice(3).map(Number), rows = original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const expected = body.subarray(0, bytes).toString('utf8'), replacement = body.subarray(bytes).toString('utf8');
  assert.equal(rows.slice(start - 1, start - 1 + remove).join(''), expected);
  return rows.slice(0, start - 1).join('') + replacement + rows.slice(start - 1 + remove).join('');
}
test('small candidate commands retain the existing replace format exactly', () => {
  assert.equal(candidateCommand(source('old\n'), 'new\n'), '/replace /lib/large/hoon 0x123 hoon\nnew\n');
});
test('large-file line edits reconstruct exact Unicode, tabs and final-newline bytes', () => {
  for (const [before, after] of [
    [large, 'α\t😀\n' + large], [large, large + 'tail'],
    [large + 'tail', large + 'tail\n'], [large + 'tail\n', large + 'tail'],
    [large, large.slice('unchanged line\n'.length)],
    [large + 'last\n', large + 'β\n'],
    [large + '\n', large],
  ]) assert.equal(apply(before, candidateCommand(source(before), after)), after);
});
test('patches reject oversized spans rather than truncating or silently splitting', () => {
  assert.throws(() => candidateCommand(source(large), 'new line\n'.repeat(12000)), /patch size/);
  assert.throws(() => candidateCommand(source('x'.repeat(1_048_577)), large), /1 MiB/);
  assert.throws(() => candidateCommand(source(large), large + '\r'), /valid text/);
  assert.throws(() => candidateCommand(source(large), large + '\ud800'), /valid text/);
});
