import test from 'node:test';
import assert from 'node:assert/strict';
import {linePatches, type LinePatch} from '../src/line-patches';
import {candidateCommand} from '../src/candidate-command';

function apply(rows: string[], patches: LinePatch[]): string {
  const result = [...rows]; let bound = rows.length + 2;
  for (const p of [...patches].reverse()) {
    assert.ok(p.start < bound && p.start + p.remove <= bound);
    assert.equal(rows.slice(p.start - 1, p.start - 1 + p.remove).join(''), p.expected);
    result.splice(p.start - 1, p.remove, p.replacement); bound = p.start;
  }
  return result.join('');
}
function decode(command: string): LinePatch[] {
  let body = Buffer.from(command), newline = body.indexOf(10);
  const header = body.subarray(0, newline).toString().split(' ');
  assert.equal(header[0], '/patches'); body = body.subarray(newline + 1);
  const result: LinePatch[] = [];
  for (let i = 0; i < Number(header[1]); i++) {
    newline = body.indexOf(10); assert.ok(newline > 0);
    const [path, blob, start, remove, oldBytes, newBytes] = body.subarray(0, newline).toString().split(' ');
    assert.equal(path, '/lib/large/hoon'); assert.equal(blob, '0x123');
    body = body.subarray(newline + 1);
    result.push({start: Number(start), remove: Number(remove), expected: body.subarray(0, Number(oldBytes)).toString(),
      replacement: body.subarray(Number(oldBytes), Number(oldBytes) + Number(newBytes)).toString()});
    body = body.subarray(Number(oldBytes) + Number(newBytes));
  }
  assert.equal(body.length, 0); return result;
}
test('sparse large edits use one compact exact multi-patch command', () => {
  const before = Array.from({length: 6000}, (_, i) => `line ${i} unchanged\n`), after = [...before];
  after[3] = 'α\t😀\n'; after.splice(5500, 1); after.push('last without newline');
  const command = candidateCommand({path: '/lib/large/hoon', blob: '0x123', mark: 'hoon', text: before.join('')}, after.join(''));
  const patches = decode(command); assert.equal(patches.length, 3); assert.ok(Buffer.byteLength(command) < 512);
  assert.equal(apply(before, patches), after.join(''));
});
test('bounded line diff reconstructs duplicate lines, insertions, deletions and empty files', () => {
  let seed = 17;
  const random = (n: number) => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n;};
  for (let trial = 0; trial < 2000; trial++) {
    const before = Array.from({length: random(20)}, () => ['a\n', 'b\n', 'α\n', '\n'][random(4)]);
    const after = [...before];
    for (let i = 0; i < 4; i++) after.splice(random(after.length + 1), random(3), ...Array.from({length: random(3)}, () => ['a\n', 'b\n', '😀\n'][random(3)]));
    assert.equal(apply(before, linePatches(before, after)), after.join(''));
  }
  assert.deepEqual(linePatches([], []), []);
  assert.equal(apply(['tail'], linePatches(['tail'], ['tail\n'])), 'tail\n');
});
test('too many separated edits or excessive edit distance stop before submission', () => {
  const before = Array.from({length: 100}, (_, i) => `${i}\n`), after = [...before];
  for (let i = 0; i < 17; i++) after[i * 3] = 'changed\n';
  assert.throws(() => linePatches(before, after), /16 separate/);
  assert.throws(() => linePatches(Array(300).fill('old\n'), Array(300).fill('new\n')), /bounded native patch/);
});
