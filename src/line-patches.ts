export interface LinePatch {start: number; remove: number; expected: string; replacement: string}

/** Bounded Myers line diff. Coordinates always refer to the original file. */
export function linePatches(before: string[], after: string[]): LinePatch[] {
  let work = 0;
  const trace: Map<number, number>[] = [], frontier = new Map<number, number>([[1, 0]]);
  const at = (v: Map<number, number>, k: number) => v.get(k) ?? -Infinity;
  for (let distance = 0; distance <= 256; distance++) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++work > 2_000_000) throw new Error('This edit exceeds the bounded native patch size calculation.');
      let x = diagonal === -distance || diagonal !== distance && at(frontier, diagonal - 1) < at(frontier, diagonal + 1)
        ? at(frontier, diagonal + 1) : at(frontier, diagonal - 1) + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        if (++work > 2_000_000) throw new Error('This edit exceeds the bounded native patch size calculation.');
        x++; y++;
      }
      frontier.set(diagonal, x);
      if (x !== before.length || y !== after.length) continue;
      const changes: {old: number; next: number; insert: boolean}[] = [];
      for (let d = distance; d > 0; d--) {
        const v = trace[d], k = x - y;
        const previous = k === -d || k !== d && at(v, k - 1) < at(v, k + 1) ? k + 1 : k - 1;
        const old = at(v, previous), next = old - previous, insert = x - y < previous;
        changes.push({old, next, insert}); x = old; y = next;
      }
      changes.reverse();
      const spans: {old: number; next: number; oldEnd: number; nextEnd: number}[] = [];
      for (const change of changes) {
        let span = spans.at(-1);
        if (!span || span.oldEnd !== change.old || span.nextEnd !== change.next) {
          if (spans.length === 16) throw new Error('This edit exceeds the native patch size: at most 16 separate spans.');
          span = {old: change.old, next: change.next, oldEnd: change.old, nextEnd: change.next}; spans.push(span);
        }
        if (change.insert) span.nextEnd++; else span.oldEnd++;
      }
      return spans.map(s => ({start: s.old + 1, remove: s.oldEnd - s.old,
        expected: before.slice(s.old, s.oldEnd).join(''), replacement: after.slice(s.next, s.nextEnd).join('')}));
    }
  }
  throw new Error('This edit exceeds the bounded native patch size calculation.');
}
