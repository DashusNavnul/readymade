import {linePatches, type LinePatch} from './line-patches';
import {validUnicode} from './protocol';
import {FILE_LIMIT} from './source-store';

export type DraftMerge = {kind: 'merged'; text: string} |
  {kind: 'conflict'; conflicts: {local: LinePatch; current: LinePatch}[]};
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
function validate(text: string): void {
  if (!validUnicode(text) || Buffer.byteLength(text) > FILE_LIMIT) throw new Error('Draft reconciliation requires valid Unicode within the 1 MiB file limit.');
}
function identical(a: LinePatch, b: LinePatch): boolean {
  return a.start === b.start && a.remove === b.remove && a.expected === b.expected && a.replacement === b.replacement;
}
function overlaps(a: LinePatch, b: LinePatch): boolean {
  // Insertions at a replacement boundary are ambiguous; retain both versions
  // for explicit resolution rather than guessing their intended ordering.
  if (!a.remove) return a.start >= b.start && a.start <= b.start + b.remove;
  if (!b.remove) return b.start >= a.start && b.start <= a.start + a.remove;
  return a.start < b.start + b.remove && b.start < a.start + a.remove;
}
function changes(original: string[], text: string): LinePatch[] {
  return linePatches(original, lines(text)).flatMap(patch => {
    const replacement = lines(patch.replacement), expected = lines(patch.expected);
    // Equal-length replacements have stable original-line coordinates. Splitting
    // them lets a common edit coexist with an adjacent independent edit.
    if (!patch.remove || patch.remove !== replacement.length) return [patch];
    return replacement.flatMap((line, index) => line === expected[index] ? [] : [{
      start: patch.start + index, remove: 1, expected: expected[index], replacement: line,
    }]);
  });
}

/** Pure local reconciliation. Inputs stay intact; no source identity or authority is granted. */
export function mergeDraft(base: string, local: string, current: string): DraftMerge {
  [base, local, current].forEach(validate);
  if (local === base || local === current) return {kind: 'merged', text: current};
  if (current === base) return {kind: 'merged', text: local};
  const original = lines(base), ours = changes(original, local), theirs = changes(original, current);
  const conflicts: {local: LinePatch; current: LinePatch}[] = [];
  for (const a of ours) for (const b of theirs) if (!identical(a, b) && overlaps(a, b)) conflicts.push({local: a, current: b});
  if (conflicts.length) return {kind: 'conflict', conflicts};
  const patches = [...ours, ...theirs.filter(b => !ours.some(a => identical(a, b)))].sort((a, b) => b.start - a.start);
  const result = [...original];
  for (const patch of patches) {
    if (original.slice(patch.start - 1, patch.start - 1 + patch.remove).join('') !== patch.expected) throw new Error('Draft reconciliation context changed.');
    result.splice(patch.start - 1, patch.remove, patch.replacement);
  }
  const text = result.join(''); validate(text);
  return {kind: 'merged', text};
}
