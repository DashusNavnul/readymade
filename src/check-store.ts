import type { ShipClient } from './ship-client';
import { asRecord, isInteger, isUx, validUnicode, type CodingSnapshot, type JsonObject } from './protocol';
import { digest, originOf, sameBasis, sourceBasis, type SourceBasis } from './source-store';

export interface CheckValue { name: string; passed: boolean; detail: string; artifacts: string[] }
export interface CheckReport {
  key: string; id: string; sequence: number; project: string; session: string; configuration: string;
  request: string; callId: string; recordedAt: string; source: SourceBasis; values: CheckValue[];
}
export interface CheckObservation {
  origin: string; owner: string; project: string; session: string; source: SourceBasis;
  reports: CheckReport[]; records: number;
}
function text(value: unknown, max: number, required = false): value is string {
  return typeof value === 'string' && validUnicode(value) && (!required || value.length > 0) && Buffer.byteLength(value) <= max;
}
function nonzero(value: unknown): value is string { return isUx(value) && value !== '0x0'; }

/** Raw native result and HTTP projection must agree. Details are text, never inferred locations. */
export function readCheck(row: JsonObject, owner: string, session: string, project: string): CheckReport | undefined {
  if (row.kind !== 'tool') return undefined;
  const projected = row.file && typeof row.file === 'object' && !Array.isArray(row.file) ? asRecord(row.file) : undefined;
  let result: JsonObject | undefined;
  if (typeof row.text === 'string') { try { result = asRecord(JSON.parse(row.text)); } catch { /* Other tool text is not a check. */ } }
  const output = result?.output && typeof result.output === 'object' && !Array.isArray(result.output) ? asRecord(result.output) : undefined;
  if (projected?.kind !== 'diagnostics' && output?.kind !== 'diagnostics') return undefined;
  if (!projected || !result || !output) throw new Error('Native check projection is unavailable.');
  const context = asRecord(result.context), source = sourceBasis(projected.source), value = asRecord(projected.value);
  if (!nonzero(row.id) || !isInteger(row.sequence, 0, 4096) || projected.version !== 'native-coding-problems-v1' ||
      projected.kind !== 'diagnostics' || result.version !== 'native-coding-tool-result-v1' || output.kind !== 'diagnostics' ||
      projected.session !== session || context.session !== session || projected.project !== project || context.project !== project ||
      source.owner !== owner || !sameBasis(source, context.source) || !nonzero(projected.request) || context.request !== projected.request ||
      !nonzero(projected.configuration) || context.configuration !== projected.configuration ||
      !text(projected.callId, 256, true) || result.call_id !== projected.callId ||
      !text(projected.recordedAt, 128, true) || !/^~[0-9][0-9a-f.]*$/.test(projected.recordedAt) ||
      !Array.isArray(value.values) || !value.values.length || value.values.length > 64 ||
      !Array.isArray(output.values) || value.values.length !== output.values.length) throw new Error('Invalid source-bound native checks.');
  let bytes = 0, nameBytes = 0;
  const rawValues = output.values;
  const values = value.values.map((item, index) => {
    const diagnostic = asRecord(item), raw = asRecord(rawValues[index]);
    if (!text(diagnostic.name, 131072) || (nameBytes += Buffer.byteLength(diagnostic.name)) > 131072) throw new Error('Native check names exceed the 128 KiB presentation limit.');
    if (typeof diagnostic.passed !== 'boolean' || !text(diagnostic.detail, 8192) ||
        !sameBasis(source, diagnostic.source) || sourceBasis(diagnostic.source).id !== source.id || !sameBasis(source, raw.source) ||
        !Array.isArray(diagnostic.artifacts) || diagnostic.artifacts.length > 16 || !diagnostic.artifacts.every(isUx) ||
        raw.name !== diagnostic.name || raw.passed !== diagnostic.passed || raw.detail !== diagnostic.detail ||
        JSON.stringify(raw.artifacts) !== JSON.stringify(diagnostic.artifacts) || (bytes += Buffer.byteLength(diagnostic.detail)) > 16384) throw new Error('Native check projections disagree.');
    return {name: diagnostic.name, passed: diagnostic.passed, detail: diagnostic.detail, artifacts: [...diagnostic.artifacts] as string[]};
  });
  return {key: digest(JSON.stringify([owner, session, row.id])), id: row.id, sequence: row.sequence, project, session,
    configuration: projected.configuration, request: projected.request, callId: projected.callId,
    recordedAt: projected.recordedAt, source, values};
}

/** Bounded GET-only traversal. Never calls compile/check or changes review/acceptance. */
export async function observeChecks(client: Pick<ShipClient, 'origin' | 'codingState'>, session: string, project: string): Promise<CheckObservation> {
  if (!nonzero(session) || !text(project, 128, true)) throw new Error('Select a project coding session.');
  const origin = originOf(client.origin), reports: CheckReport[] = [];
  let initial: CodingSnapshot | undefined, source: SourceBasis | undefined, after = 0, records = 0;
  for (let page = 0; page < 128; page++) {
    const state = await client.codingState(session, after);
    const matches = state.sessions.filter(s => s.id === session), chosen = matches[0];
    if (client.origin !== origin || state.session !== session || matches.length !== 1 || chosen.project !== project || state.reset !== false || typeof state.more !== 'boolean' ||
        !/^~[a-z-]{1,127}$/.test(state.owner) || !isInteger(state.after, after, 4096) || state.records.length > 32) throw new Error('Check observation context changed.');
    const basis = sourceBasis(chosen.source);
    if (initial && (state.owner !== initial.owner || !sameBasis(source!, basis))) throw new Error('Source changed during check observation. Refresh again.');
    initial ??= state; source ??= basis;
    for (const row of state.records) {
      if (!isInteger(row.sequence, after, state.after - 1)) throw new Error('Invalid retained record page.');
      const report = readCheck(row, state.owner, session, project); if (!report) continue;
      for (const previous of reports) {
        if (previous.id === report.id || previous.sequence === report.sequence || previous.request === report.request && previous.callId === report.callId) throw new Error('Conflicting native check identities.');
      }
      reports.push(report);
    }
    records += state.records.length;
    if (reports.length > 256) throw new Error('Check history exceeds the 256-report presentation limit.');
    if (state.more !== true) return {origin, owner: state.owner, project, session, source, reports: reports.sort((a, b) => b.sequence - a.sequence), records};
    if (state.after <= after || !state.records.length) throw new Error('Native record pagination did not advance.');
    after = state.after;
  }
  throw new Error('Check history exceeds the 4,096-record presentation limit.');
}
