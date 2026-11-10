import {isUx, validUnicode} from './protocol';
import {validPath} from './source-store';
import {linePatches} from './line-patches';

/** Preserve existing command bytes; sparse large edits form one atomic proposal. */
export function candidateCommand(source: {path: string; blob: string; mark: string; text: string}, text: string): string {
  if (!validPath(source.path) || source.mark !== source.path.split('/').at(-1) || !isUx(source.blob) || source.blob === '0x0') throw new Error('Invalid candidate source.');
  for (const value of [source.text, text]) {
    if (!validUnicode(value) || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(value) || Buffer.byteLength(value) > 1_048_576) throw new Error('Candidate source must be valid text within the native 1 MiB limit.');
  }
  const replace = `/replace ${source.path} ${source.blob} ${source.mark}\n${text}`;
  if (Buffer.byteLength(replace) <= 65_536) return replace;
  const lines = (value: string) => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const before = lines(source.text), after = lines(text);
  let first = 0, endBefore = before.length, endAfter = after.length;
  while (first < endBefore && first < endAfter && before[first] === after[first]) first++;
  while (endBefore > first && endAfter > first && before[endBefore - 1] === after[endAfter - 1]) {endBefore--; endAfter--;}
  const expected = before.slice(first, endBefore).join(''), replacement = after.slice(first, endAfter).join('');
  if (Buffer.byteLength(expected) > 32_768 || Buffer.byteLength(replacement) > 32_768) {
    const patches = linePatches(before, after);
    if (!patches.length) throw new Error('Candidate has no changed lines.');
    const items = patches.map(p => {
      const oldBytes = Buffer.byteLength(p.expected), newBytes = Buffer.byteLength(p.replacement);
      if (oldBytes > 32_768 || newBytes > 32_768) throw new Error('This edit exceeds the native patch size. Split it into smaller reviewed changes.');
      return `${source.path} ${source.blob} ${p.start} ${p.remove} ${oldBytes} ${newBytes}\n${p.expected}${p.replacement}`;
    });
    const command = `/patches ${items.length}\n${items.join('')}`;
    if (Buffer.byteLength(command) > 65_536) throw new Error('Candidate patches exceed the native command limit.');
    return command;
  }
  const patch = `/patch ${source.path} ${source.blob} ${first + 1} ${endBefore - first} ${Buffer.byteLength(expected)}\n${expected}${replacement}`;
  if (Buffer.byteLength(patch) > 65_536) throw new Error('Candidate patch exceeds the native command limit.');
  return patch;
}
