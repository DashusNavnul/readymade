import {asRecord, isUx, type CodingSnapshot} from './protocol';

export const sessionSelectionKey = (origin: string, ship: string): string =>
  'readymade.session:' + JSON.stringify([origin, ship]);

export const projectSessionSelectionKey = (origin: string, ship: string, project: string): string =>
  'readymade.project-session:' + JSON.stringify([origin, ship, project]);

/** Presentation preference only. Every restoration requires current catalog membership. */
export function sessionSelection(catalog: CodingSnapshot, project: string | undefined, session: string): {project: string; session: string} | undefined {
  if (!catalog.ready || !project || !isUx(session) || session === '0x0' ||
      catalog.projects.filter(p => p.id === project).length !== 1 ||
      catalog.sessions.filter(s => s.id === session).length !== 1 ||
      !catalog.sessions.some(s => s.id === session && s.project === project)) return undefined;
  return {project, session};
}

export function restoredSession(value: unknown, catalog: CodingSnapshot, owner: string, project: string | undefined): string {
  if (catalog.owner !== owner || !value || typeof value !== 'object' || Array.isArray(value)) return '0x0';
  const row = asRecord(value);
  if (row.project !== project || typeof row.session !== 'string') return '0x0';
  return sessionSelection(catalog, project, row.session)?.session ?? '0x0';
}
