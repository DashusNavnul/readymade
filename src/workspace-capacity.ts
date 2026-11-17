import {asRecord, isInteger, isUx, validUnicode, type CodingSnapshot, type JsonObject} from './protocol';
import {remoteShip} from './remote-project-view';
import {readCheckSlot} from './candidate-store';
import type {MediaTreeRow} from './media-workbench';
import type {WorkspaceRequestStore} from './workspace-request-store';

const phases = new Set(['queued', 'assigned', 'running', 'review', 'paused', 'unknown', 'completed', 'refused', 'cancelled']);
const roles = new Set(['build', 'review', 'check']);
const id = (v: unknown): v is string => isUx(v) && v !== '0x0';
const text = (v: unknown, max: number): v is string => typeof v === 'string' && validUnicode(v) && v.length > 0 && Buffer.byteLength(v) <= max;
const unavailable = (label: string, reason: string): MediaTreeRow => ({label, description: 'Unknown', tooltip: reason});
const sessionCommand = (session: string) => ({command: 'readymade.selectSession', title: 'Observe this session', arguments: [session]});

function fleetRows(value: unknown, sessions: Set<string>): MediaTreeRow {
  const unknown = () => unavailable('Fleet workload', 'No valid complete fleet observation. Worker availability and remaining slots are unknown.');
  try {
    const fleet = asRecord(value);
    if (fleet.available !== true || !Array.isArray(fleet.workers) || !Array.isArray(fleet.tasks) || fleet.workers.length > 512 || fleet.tasks.length > 256) return unknown();
    const workers = fleet.workers.map(asRecord), tasks = fleet.tasks.map(asRecord);
    for (const w of workers) if (!text(w.id, 128) || !/^[a-z][a-z0-9-]*$/.test(w.id) || !remoteShip(w.ship) ||
      !isInteger(w.generation, 1) || !isInteger(w.capacity, 1) || !Array.isArray(w.roles) || !w.roles.length || w.roles.length > 3 ||
      w.roles.some(r => !roles.has(String(r))) || new Set(w.roles).size !== w.roles.length || !id(w.inspection) || typeof w.observed !== 'boolean') return unknown();
    for (const t of tasks) if (!id(t.id) || !id(t.session) || !text(t.project, 128) || !text(t.objective, 8192) ||
      !roles.has(String(t.role)) || !phases.has(String(t.phase)) || typeof t.released !== 'boolean' ||
      t.worker !== '' && !remoteShip(t.worker) || !Array.isArray(t.evidence) || t.evidence.length > 4096 || !t.evidence.every(id)) return unknown();
    if (new Set(workers.map(w => w.id)).size !== workers.length || new Set(workers.map(w => w.ship)).size !== workers.length ||
      new Set(tasks.map(t => t.id)).size !== tasks.length) return unknown();
    const taskRow = (t: JsonObject): MediaTreeRow => ({label: `Task ${t.id}`, description: `${t.phase} · ${t.released ? 'released' : 'not released'}`,
      tooltip: `Project ${t.project}\nSession ${t.session}\nRole ${t.role}\nWorker ${t.worker || 'unassigned'}\nRetained task state; not proof of current execution.`,
      command: sessions.has(String(t.session)) ? sessionCommand(String(t.session)) : undefined});
    const children: MediaTreeRow[] = workers.map(w => {
      const assigned = tasks.filter(t => t.worker === w.ship);
      return {label: `${w.id} · ${w.ship}`, description: `Configured concurrency: ${w.capacity}`,
        tooltip: `Generation ${w.generation}\nRoles ${(w.roles as string[]).join(', ')}\n${w.observed ? 'Worker inspection retained' : 'No worker inspection retained'}. Neither proves online status or free slots.`,
        children: [{label: `${assigned.length} retained tasks · ${assigned.filter(t => !t.released).length} not released`,
          children: assigned.map(taskRow)}]};
    });
    const registered = new Set(workers.map(w => w.ship));
    const other = tasks.filter(t => !registered.has(t.worker));
    if (other.length) children.push({label: 'Unassigned or no longer registered worker', description: `${other.length} retained tasks`, children: other.map(taskRow)});
    children.push({label: 'Online workers and free slots: unknown'});
    return {label: 'Fleet workload', description: `${workers.length} configured workers · ${tasks.length} retained tasks`, children};
  } catch {return unknown();}
}

/** The owner's native capacity page: every lifetime wall, or Unknown with the ship's own reason. */
export function capacityRows(value: unknown, owner: string): MediaTreeRow | undefined {
  try {
    const page = asRecord(value);
    if (page.schema !== 'native-capacity-v1' || page.owner !== owner || page.available !== true || !Array.isArray(page.figures) || page.figures.length > 32) return undefined;
    const rows = page.figures.map(v => {
      const f = asRecord(v);
      if (!text(f.name, 128)) throw new Error('figure');
      if (f.available === false) {
        if (!text(f.reason, 128)) throw new Error('figure');
        return unavailable(String(f.name), `The ship could not read this figure: ${f.reason}.`);
      }
      if (f.available !== true || !isInteger(f.used, 0) || !isInteger(f.limit, 1) || !isInteger(f.remaining, 0) || !text(f.note, 512) ||
          f.remaining !== Math.max(0, (f.limit as number) - (f.used as number)) || f.settled !== null && !isInteger(f.settled, 0, f.used as number)) throw new Error('figure');
      const settled = f.settled === null ? '' : ` · ${f.settled} settled still counted`;
      const near = (f.remaining as number) * 8 <= (f.limit as number) ? 'nearly full · ' : '';
      return {label: String(f.name), description: `${near}${f.used} / ${f.limit} · ${f.remaining} left${settled}`, tooltip: String(f.note)} as MediaTreeRow;
    });
    return {label: 'Remaining capacity', description: `${rows.length} walls`, tooltip: 'Read from the owner\'s ship: used, limit, remaining, and settled records that still count.', children: rows};
  } catch {return undefined;}
}

/** Presentation of already observed native data only. No requests, retries or admission decisions. */
export function workloadRows(owner: string, snapshot?: CodingSnapshot,
  requests?: Pick<WorkspaceRequestStore, 'owner' | 'catalog' | 'requests'>, capacity?: unknown): MediaTreeRow[] {
  const children: MediaTreeRow[] = [];
  const valid = remoteShip(owner) && snapshot?.owner === owner && id(snapshot.cursor);
  const state = valid ? snapshot : undefined;
  let sessions = new Set<string>();
  let complete = false;
  try {
    const meta = asRecord(state?.sessionCatalog);
    if (state?.catalogLoaded === true && meta.schema === 'native-coding-session-catalog-v2' && meta.owner === owner &&
      meta.available === true && meta.permissionGranted === false && id(meta.digest) && isInteger(meta.total, 0, 512) &&
      state.sessions.length === meta.total && state.sessions.every(s => id(s.id) && text(s.project, 128))) {
      sessions = new Set(state.sessions.map(s => String(s.id))); complete = sessions.size === meta.total;
    }
  } catch { /* Missing or old catalog has no completeness evidence. */ }
  if (!complete) sessions = new Set();
  children.push(complete ? {label: 'Coding sessions', description: `${sessions.size} retained · complete catalog`,
    tooltip: 'Across all projects. The server has not reported its current admission limit or remaining session capacity.'} :
    unavailable('Coding sessions', 'Complete catalog not observed; an empty or partial list does not establish remaining capacity.'));
  const catalog = requests?.owner === owner ? requests.catalog : undefined;
  const loaded = catalog ? requests!.requests : [];
  if (catalog && id(catalog.catalog) && isInteger(catalog.total, 0, 512) && loaded.length <= catalog.total &&
    (catalog.next === null ? loaded.length === catalog.total : isInteger(catalog.next, loaded.length, catalog.total - 1) && catalog.next === loaded.length)) {
    children.push({label: 'Shared coding requests', description: `${loaded.length} of ${catalog.total} loaded · ${catalog.next === null ? 'complete catalog' : 'incomplete'}`,
      tooltip: 'Last retained request catalog, across all projects. Unloaded request status and remaining admission capacity are unknown.',
      command: {command: 'readymade.workspaceRequests', title: 'Observe shared requests'},
      children: ['reserved', 'submitted', 'unknown', 'recorded', 'refused'].map(status => ({label: `${status}: ${loaded.filter(r => r.status === status).length} loaded`}))});
  } else children.push(unavailable('Shared coding requests', 'No complete or partial request catalog has been validated for this owner. Unloaded requests are unknown.'));
  children.push(fleetRows(state?.fleet, sessions));
  const slot = readCheckSlot(state?.checkSlot, owner);
  children.push({label: `Candidate check slot: ${slot.status}`, description: slot.blockerCount === null ? undefined : `${slot.blockerCount} blocking candidates`,
    tooltip: `${slot.notice}${slot.observedAt ? `\nObserved ${slot.observedAt}` : ''}`,
    children: [...slot.blockers.map(b => ({label: `Candidate ${b.candidate}`, description: `${b.stage} · ${b.reason ?? 'condition not reported'}`,
      tooltip: `Session ${b.session}\nRequest ${b.request}${b.worker ? `\nWorker ${b.worker.ship} · ${b.worker.phase}\nWorker request ${b.worker.request}\nCheck ticket ${b.worker.ticket}` : '\nWorker correlation unavailable'}`,
      command: sessions.has(b.session) ? sessionCommand(b.session) : undefined})),
      ...(slot.truncated ? [{label: `Showing ${slot.blockers.length} of ${slot.blockerCount} blockers`}] : [])]});
  children.push(capacityRows(capacity, owner) ??
    {label: 'Remaining admission capacity: unknown', tooltip: 'Session, request, grant, journal and archive limits need an explicit native capacity observation.'});
  return [{id: 'workload', label: 'Workload', icon: 'dashboard', tooltip: 'Last native observations across all projects. Refresh to observe again; these counts do not authorize work.',
    command: state ? {command: 'readymade.refresh', title: 'Refresh native observations'} : undefined, children}];
}
