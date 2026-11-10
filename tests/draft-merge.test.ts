import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeDraft} from '../src/draft-merge';

test('independent edits converge without dropping either contribution', () => {
  const base = 'one\ntwo\nthree\nfour\n';
  const local = 'ONE\ntwo\nthree\nfour\n', current = 'one\ntwo\nthree\nFOUR\n';
  assert.deepEqual(mergeDraft(base, local, current), {kind: 'merged', text: 'ONE\ntwo\nthree\nFOUR\n'});
  assert.deepEqual(mergeDraft(base, current, local), mergeDraft(base, local, current));
  assert.deepEqual(mergeDraft(base, 'two\nthree\nfour\n', base + 'five\n'), {kind: 'merged', text: 'two\nthree\nfour\nfive\n'});
});
test('identical and unchanged contributions are not duplicated', () => {
  for (const text of ['', 'α😀\r\nlast', 'insert\n']) {
    assert.deepEqual(mergeDraft('base', text, text), {kind: 'merged', text});
    assert.deepEqual(mergeDraft('base', 'base', text), {kind: 'merged', text});
    assert.deepEqual(mergeDraft('base', text, 'base'), {kind: 'merged', text});
  }
  assert.deepEqual(mergeDraft('a\nb\nc\nd\n', 'A\nb\nc\nD\n', 'A\nB\nc\nd\n'),
    {kind: 'merged', text: 'A\nB\nc\nD\n'});
});
test('overlapping edits and competing insertions retain both patches without a guessed result', () => {
  for (const [base, local, current] of [
    ['a\nb\n', 'A\nb\n', 'B\nb\n'],
    ['a\nb\n', 'b\n', 'A\nb\n'],
    ['', 'one\n', 'two\n'],
    ['a\nb\n', 'new\na\nb\n', 'A\nb\n'],
  ]) {
    const result = mergeDraft(base, local, current);
    assert.equal(result.kind, 'conflict');
    if (result.kind !== 'conflict') throw new Error('Expected conflict');
    assert.ok(result.conflicts.length); assert.equal('text' in result, false);
    assert.notEqual(result.conflicts[0].local.replacement, result.conflicts[0].current.replacement);
  }
});
test('line endings, Unicode and missing final newline retain exact bytes', () => {
  assert.deepEqual(mergeDraft('α\r\nmid\r\nlast', '😀\r\nmid\r\nlast', 'α\r\nmid\r\nend'),
    {kind: 'merged', text: '😀\r\nmid\r\nend'});
});
test('large sparse edits converge, while unbounded or invalid inputs refuse', () => {
  const base = Array.from({length: 6000}, (_, i) => `line ${i}\n`), local = [...base], current = [...base];
  local[3] = 'ours\n'; current[5500] = 'theirs\n';
  const expected = [...local]; expected[5500] = current[5500];
  assert.deepEqual(mergeDraft(base.join(''), local.join(''), current.join('')), {kind: 'merged', text: expected.join('')});
  assert.throws(() => mergeDraft('', '\ud800', ''), /Unicode/);
  assert.throws(() => mergeDraft('', 'x'.repeat(1048577), ''), /limit/);
  assert.throws(() => mergeDraft('old\n'.repeat(300), 'local\n'.repeat(300), 'current\n'.repeat(300)), /bounded/);
});
