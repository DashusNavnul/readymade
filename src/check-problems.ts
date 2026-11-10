import {sourceBasis, sameBasis, originOf, validPath, type SourceSnapshot} from './source-store';
import {asRecord, isUx, validUnicode} from './protocol';
export interface CheckProblemLocation {path: string; line: number; column: number; endLine: number; endColumn: number}
/** Exact mook %spot rendering only. No guessed filename, default line or free-text search. */
export function checkLocations(detail: string): CheckProblemLocation[] {
  const found: CheckProblemLocation[] = [];
  if (Buffer.byteLength(detail) > 8192) return found;
  const atom = '(?:0|[1-9][0-9]{0,2}(?:\\.[0-9]{3})*)';
  const pattern = new RegExp('^(/(?:app|lib|ted|sur)/(?:[a-z0-9-]+/){1,13}hoon):<\\[(' + atom + ') (' + atom + ')\\]\\.\\[(' + atom + ') (' + atom + ')\\]>$');
  for (const row of detail.split('\n')) {
    const match = pattern.exec(row.trim()); if (!match) continue;
    const [line, column, endLine, endColumn] = match.slice(2).map(v => Number(v.replaceAll('.', '')));
    if (!validPath(match[1]) || [line, column, endLine, endColumn].some(n => !Number.isSafeInteger(n) || n < 1 || n > 1_048_576) || endLine < line || endLine === line && endColumn < column) continue;
    const location = {path: match[1], line, column, endLine, endColumn};
    if (!found.some(old => JSON.stringify(old) === JSON.stringify(location))) found.push(location);
    if (found.length === 16) break;
  }
  return found;
}
export function checkProblemReport(text: string) {
  if (Buffer.byteLength(text) > 1_048_576) throw new Error('Saved check report exceeds its limit.');
  const row = asRecord(JSON.parse(text)), source = sourceBasis(row.source);
  if (typeof row.origin !== 'string' || originOf(row.origin) !== row.origin || row.owner !== source.owner || typeof row.project !== 'string' || !row.project || Buffer.byteLength(row.project) > 128 ||
      !isUx(row.session) || row.session === '0x0' || !Number.isSafeInteger(row.sequence) || Number(row.sequence) < 0 || !Array.isArray(row.values) || row.values.length > 64) throw new Error('Invalid saved check report.');
  const values = row.values.map(v => {
    const value = asRecord(v);
    if (typeof value.name !== 'string' || !validUnicode(value.name) || Buffer.byteLength(value.name) > 131072 || typeof value.detail !== 'string' || !validUnicode(value.detail) || Buffer.byteLength(value.detail) > 8192 || typeof value.passed !== 'boolean') throw new Error('Invalid saved check diagnostic.');
    return {name: value.name, detail: value.detail, passed: value.passed};
  });
  return {origin: row.origin, owner: source.owner, project: row.project, session: row.session, source, values};
}
export type CheckProblemReport = ReturnType<typeof checkProblemReport>;
export function exactProblemSource(report: CheckProblemReport, location: CheckProblemLocation, snapshot: SourceSnapshot): void {
  if (snapshot.origin !== report.origin || snapshot.ship !== report.owner || snapshot.session !== report.session || !sameBasis(report.source, snapshot.source) || snapshot.path !== location.path) throw new Error('Check source identity changed.');
  const lines = snapshot.text.split('\n');
  if (location.endLine > lines.length || location.column > lines[location.line - 1].length + 1 || location.endColumn > lines[location.endLine - 1].length + 1) throw new Error('Compiler location is outside the exact source.');
  if (/[^\x00-\x7f]/.test(lines[location.line - 1]) || /[^\x00-\x7f]/.test(lines[location.endLine - 1])) throw new Error('Native Unicode column conversion is not established; inspect the saved trace.');
}
