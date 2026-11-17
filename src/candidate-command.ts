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

/** One native batch command, never separate per-file requests. The protocol is not a grant. */
export function bundleCandidateCommand(files: readonly {snapshot: {path: string; blob: string; mark: string; text: string}; text: string}[]): string {
  if (files.length < 1 || files.length > 8) throw new Error('A bundle needs one to eight files.');
  const paths = new Set<string>(); let total = 0;
  const items = files.map(({snapshot: source, text}) => {
    if (!validPath(source.path) || source.mark !== 'hoon' || !/^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(source.blob) ||
        source.blob.replaceAll('.', '').length > 66 || paths.has(source.path)) throw new Error('Invalid or duplicate bundle source.');
    paths.add(source.path);
    for (const value of [source.text, text]) {
      if (!validUnicode(value) || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(value) || Buffer.byteLength(value) > 32768) throw new Error('Bundle files must be valid LF text within 32 KiB.');
    }
    total += Buffer.byteLength(text);
    if (text === source.text) throw new Error('Every bundle member must contain a change.');
    const lines = (value: string) => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const before = lines(source.text), after = lines(text);
    let first = 0, oldEnd = before.length, newEnd = after.length;
    while (first < oldEnd && first < newEnd && before[first] === after[first]) first++;
    while (oldEnd > first && newEnd > first && before[oldEnd - 1] === after[newEnd - 1]) {oldEnd--; newEnd--;}
    const expected = before.slice(first, oldEnd).join(''), replacement = after.slice(first, newEnd).join('');
    return `${source.path} ${source.blob} ${first + 1} ${oldEnd - first} ${Buffer.byteLength(expected)} ${Buffer.byteLength(replacement)}\n${expected}${replacement}`;
  });
  const command = `/patches ${items.length}\n${items.join('')}`;
  if (total > 65536 || items.length > 16 || Buffer.byteLength(command) > 65536) throw new Error('The whole bundle exceeds the native batch limit. Nothing was split or submitted.');
  return command;
}
