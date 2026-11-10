import {asRecord, isInteger, isUx, type CodingSnapshot, type JsonObject} from './protocol';
import type {ShipClient} from './ship-client';
import type {WorkspaceRequestDetail} from './workspace-request-store';

export interface WorkspaceSessionObservation {
  owner: string; project: string; session: string; requestDigest: string;
  phase: string; source: JsonObject; reviews: JsonObject[]; records: JsonObject[];
  requestCompletionVerified: false;
  notice: string;
}
const phases = ['idle', 'ready', 'inference', 'tools', 'judgment', 'paused', 'unknown', 'complete', 'refused'];
/** Read the explicitly linked session. Session completion is not request attribution. */
export async function observeWorkspaceSession(
  client: Pick<ShipClient, 'codingState'>, request: WorkspaceRequestDetail,
): Promise<WorkspaceSessionObservation> {
  if (request.status !== 'recorded' || !request.evidence) throw new Error('Observe a recorded instruction before its coding session.');
  const records: JsonObject[] = [], ids = new Set<string>();
  let after = 0, cursor = '0x0', binding = '', first: CodingSnapshot | undefined, source: JsonObject = {};
  let bytes = 0;
  const validate = (page: CodingSnapshot): void => {
    const sessions = page.sessions.filter(s => s.id === request.session && s.project === request.project);
    if (!page.ready || page.owner !== request.owner || page.session !== request.session || sessions.length !== 1 ||
        !phases.includes(String(page.phase)) || sessions[0].phase !== page.phase || typeof page.more !== 'boolean' ||
        !isInteger(page.after, 0, 4096) || !isUx(page.cursor)) throw new Error('Linked coding session changed or is unavailable.');
    const current = asRecord(sessions[0].source);
    if (current.owner !== request.owner || current.desk !== request.sourceDesk || !isInteger(current.number, 1) ||
        BigInt(current.number) < BigInt(request.sourceRevision.replaceAll('.', ''))) throw new Error('Linked coding source changed.');
    const next = JSON.stringify([page.phase, current, page.reviews ?? []]);
    if (binding && next !== binding) throw new Error('Coding outcome changed during observation. Refresh it again.');
    binding = next; source = current;
    if ((page.reviews ?? []).some(r => r.session !== request.session)) throw new Error('Unrelated candidate in coding outcome.');
  };
  for (let pageIndex = 0; pageIndex < 129; pageIndex++) {
    const page = await client.codingState(request.session, after, cursor);
    validate(page); first ??= page;
    bytes += Buffer.byteLength(JSON.stringify(page));
    if (bytes > 16 * 1024 * 1024 || pageIndex > 0 && page.reset === true) throw new Error('Coding history changed or exceeded its bound.');
    for (const record of page.records) {
      if (record.sequence !== records.length || !isUx(record.id) || ids.has(record.id) || typeof record.text !== 'string' || typeof record.kind !== 'string') {
        throw new Error('Coding history is incomplete or duplicated.');
      }
      ids.add(record.id); records.push(record);
    }
    if (page.after !== records.length || records.length > 4096 || page.more && page.after <= after) throw new Error('Coding history did not advance.');
    after = page.after; cursor = page.cursor;
    if (!page.more) {
      const tail = await client.codingState(request.session, after, cursor); validate(tail);
      if (tail.reset === true || tail.more !== false || tail.after !== after || tail.cursor !== cursor || tail.records.length) {
        throw new Error('Coding history advanced during observation. Refresh it again.');
      }
      return structuredClone({owner: request.owner, project: request.project, session: request.session, requestDigest: request.requestDigest,
        phase: String(first.phase), source, reviews: first.reviews ?? [], records, requestCompletionVerified: false,
        notice: 'Current linked session observation. Its checks and judgment may include later instructions; the request receipt remains separate.'});
    }
  }
  throw new Error('Coding history exceeded its page bound.');
}
