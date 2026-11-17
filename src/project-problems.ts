import type {MediaTreeRow} from './media-workbench';

/** Transient annotation derived by the existing view that owns the evidence. */
export interface ProjectProblem {
  key: string;
  category: 'join' | 'import' | 'check' | 'review' | 'delivery';
  status: 'blocked' | 'unknown' | 'pending' | 'historical';
  label: string;
}

/** Reuse exact corrective commands; collecting problems never reads or changes a ship. */
export function projectProblemRows(sources: readonly MediaTreeRow[]): MediaTreeRow[] {
  const items = new Map<string, MediaTreeRow>();
  const visit = (rows: readonly MediaTreeRow[], context: readonly string[]): void => {
    for (const row of rows) {
      if (row.id === 'project-problems') continue;
      const problem = row.problem;
      if (problem && row.command) {
        const key = JSON.stringify([problem.category, problem.key]);
        if (!items.has(key)) items.set(key, {label: problem.label, description: `${problem.category} · ${problem.status}`,
          tooltip: [...context, row.tooltip ?? row.description ?? '', `Action: ${row.command.title}`].filter(Boolean).join('\n'), command: row.command});
      }
      if (row.children) visit(row.children, [...context, row.label]);
    }
  };
  visit(sources, []);
  const children = [...items.values()].slice(0, 64);
  if (items.size > 64) children.push({label: `Showing 64 of ${items.size} reported problems`, tooltip: 'Open the existing source sections for the remaining evidence and actions.'});
  if (!children.length) children.push({label: 'No reported problems in current observations', tooltip: 'Unread or unavailable sources are not proven clear. Observe their existing sections to update this list.'});
  return [{id: 'project-problems', label: 'Project Problems', icon: 'warning', description: items.size ? String(items.size) : undefined, children}];
}
