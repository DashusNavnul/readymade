import test from 'node:test';
import assert from 'node:assert/strict';
import {workloadRows, capacityRows} from '../src/workspace-capacity';
import {projectProblemRows} from '../src/project-problems';
import type {CodingSnapshot} from '../src/protocol';
import type {WorkspaceRequestRow} from '../src/workspace-request-store';
import type {MediaTreeRow} from '../src/media-workbench';

const owner = '~zod';
const blocker = {candidate: '0x3', session: '0x1', request: '0x4', stage: 'checking', reason: 'worker-wait',
  worker: {request: '0x5', ticket: '0x6', ship: '~nec', sent: true, phase: 'dispatched', resultPresent: false, resultReason: null}};
const snapshot = (): CodingSnapshot => ({nonce: '0v1', cursor: '0x8', session: '0x1', owner, ready: true, after: 0, projects: [], records: [],
  sessions: [{id: '0x1', project: 'first'}, {id: '0x2', project: 'second'}], catalogLoaded: true,
  sessionCatalog: {schema: 'native-coding-session-catalog-v2', owner, available: true, permissionGranted: false, total: 2, digest: '0x7'},
  fleet: {available: true, workers: [{id: 'bachelor', ship: '~nec', generation: 2, capacity: 1, roles: ['build', 'check'], inspection: '0x9', observed: true}],
    tasks: [{id: '0x11', session: '0x1', project: 'first', role: 'check', objective: 'Check code', phase: 'unknown', worker: '~nec', released: false, evidence: []},
      {id: '0x12', session: '0x2', project: 'second', role: 'build', objective: 'Build code', phase: 'completed', worker: '~nec', released: true, evidence: ['0x13']}]},
  checkSlot: {schema: 'native-coding-check-slot-v1', owner, observedAt: '~2026.11.13', available: true, condition: 'blocked', blockerCount: 1, truncated: false, blockers: [blocker]}});
const flatten = (rows: MediaTreeRow[]): MediaTreeRow[] => rows.flatMap(r => [r, ...flatten(r.children ?? [])]);
const find = (rows: MediaTreeRow[], label: string) => flatten(rows).find(r => r.label === label)!;

test('workload exposes complete counts, configured concurrency and exact blockers without inventing free capacity', () => {
  const state = snapshot(), before = JSON.stringify(state), rows = workloadRows(owner, state);
  assert.equal(rows[0].label, 'Workload');
  assert.equal(find(rows, 'Coding sessions').description, '2 retained · complete catalog');
  assert.equal(find(rows, 'bachelor · ~nec').description, 'Configured concurrency: 1');
  assert.match(find(rows, 'bachelor · ~nec').tooltip!, /Neither proves online status or free slots/);
  assert.ok(find(rows, '2 retained tasks · 1 not released'));
  assert.equal(find(rows, 'Task 0x11').description, 'unknown · not released');
  assert.deepEqual(find(rows, 'Candidate 0x3').command?.arguments, ['0x1']);
  assert.match(find(rows, 'Candidate 0x3').tooltip!, /Request 0x4\nWorker ~nec · dispatched\nWorker request 0x5\nCheck ticket 0x6/);
  assert.ok(find(rows, 'Remaining admission capacity: unknown'));
  assert.equal(JSON.stringify(state), before);
  assert.ok(flatten(rows).every(r => !r.problem));
  assert.equal(projectProblemRows(rows)[0].children![0].label, 'No reported problems in current observations');
});

test('absent, old, incomplete and foreign coding observations never become empty complete workload', () => {
  for (const state of [undefined, {...snapshot(), owner: '~wes'}, {...snapshot(), catalogLoaded: false},
    {...snapshot(), sessionCatalog: undefined}, {...snapshot(), sessions: []}, {...snapshot(), sessions: [{id: '0x1', project: 'one'}, {id: '0x1', project: 'two'}]}]) {
    const rows = workloadRows(owner, state);
    assert.equal(find(rows, 'Coding sessions').description, 'Unknown');
    assert.ok(!find(rows, 'Candidate 0x3')?.command);
  }
  const foreign = workloadRows(owner, {...snapshot(), owner: '~wes'});
  assert.equal(find(foreign, 'Fleet workload').description, 'Unknown');
  assert.ok(find(foreign, 'Candidate check slot: unknown'));
});

test('request status counts cover only loaded rows and total unknown stays unknown', () => {
  const requests = Array.from({length: 64}, (_, i): WorkspaceRequestRow => ({requester: '~nec', nonce: String(i), requestDigest: '0x1', project: 'first', session: '0x1', status: i ? 'recorded' : 'unknown'}));
  const store = {owner, catalog: {catalog: '0x9', total: 65, next: 64 as number | null}, requests};
  const rows = workloadRows(owner, snapshot(), store);
  assert.equal(find(rows, 'Shared coding requests').description, '64 of 65 loaded · incomplete');
  assert.ok(find(rows, 'unknown: 1 loaded')); assert.ok(find(rows, 'recorded: 63 loaded'));
  assert.match(find(rows, 'Shared coding requests').tooltip!, /Unloaded request status.*unknown/);
  assert.equal(find(workloadRows(owner, snapshot()), 'Shared coding requests').description, 'Unknown');
  assert.equal(find(workloadRows(owner, snapshot(), {...store, owner: '~wes'}), 'Shared coding requests').description, 'Unknown');
  assert.equal(find(workloadRows(owner, snapshot(), {...store, catalog: {...store.catalog, next: null}}), 'Shared coding requests').description, 'Unknown');
  const full = workloadRows(owner, snapshot(), {...store, catalog: {...store.catalog, total: 64, next: null}});
  assert.equal(find(full, 'Shared coding requests').description, '64 of 64 loaded · complete catalog');
});

test('fleet duplicate identities, malformed states and unavailable source stay unknown', () => {
  const base = snapshot().fleet as {available: boolean; workers: Record<string, unknown>[]; tasks: Record<string, unknown>[]};
  for (const fleet of [{...base, available: false}, {...base, workers: [...base.workers, ...base.workers]}, {...base, tasks: [...base.tasks, ...base.tasks]},
    {...base, workers: [{...base.workers[0], capacity: -1}]}, {...base, tasks: [{...base.tasks[0], released: 'false'}]},
    {...base, tasks: [{...base.tasks[0], phase: 'idle'}]}, {...base, workers: [{...base.workers[0], observed: 'yes'}]}]) {
    assert.equal(find(workloadRows(owner, {...snapshot(), fleet}), 'Fleet workload').description, 'Unknown');
  }
  const unassigned = workloadRows(owner, {...snapshot(), fleet: {...base, workers: [], tasks: [{...base.tasks[0], worker: ''}]}});
  assert.ok(find(unassigned, 'Unassigned or no longer registered worker'));
  assert.equal(find(unassigned, 'Fleet workload').description, '0 configured workers · 1 retained tasks');
});

test('truncated check blockers retain exact total, missing correlation cannot become free', () => {
  const state = snapshot(), slot = state.checkSlot as Record<string, unknown>;
  const rows = workloadRows(owner, {...state, checkSlot: {...slot, blockerCount: 40, truncated: true,
    blockers: Array.from({length: 32}, (_, i) => ({...blocker, candidate: '0x' + (i + 1).toString(16)}))}});
  assert.ok(find(rows, 'Showing 32 of 40 blockers'));
  assert.equal(find(rows, 'Candidate check slot: blocked').description, '40 blocking candidates');
  assert.ok(find(workloadRows(owner, {...state, checkSlot: {...slot, blockerCount: 0}}), 'Candidate check slot: unknown'));
  const free = workloadRows(owner, {...state, checkSlot: {...slot, condition: 'free', blockerCount: 0, blockers: []}});
  assert.ok(find(free, 'Candidate check slot: free'));
  assert.match(find(free, 'Candidate check slot: free').tooltip!, /does not prove a check succeeded or authorize work/);
});

test('the native capacity page shows every wall with used, limit, remaining and settled records, and Unknown with its reason', () => {
  const page = {schema: 'native-capacity-v1', owner, available: true, figures: [
    {name: 'Suggestion receipts (hot)', available: true, used: 60, limit: 64, remaining: 4, settled: null, note: 'Archive drains above 48.'},
    {name: 'Coding grants', available: true, used: 163, limit: 512, remaining: 349, settled: 27, note: 'Revoked grants still count.'},
    {name: 'Project invitations', available: false, reason: 'collab-too-old'}]};
  const row = capacityRows(page, owner)!;
  assert.equal(row.label, 'Remaining capacity');
  assert.deepEqual(row.children!.map(r => [r.label, r.description]), [
    ['Suggestion receipts (hot)', 'nearly full · 60 / 64 · 4 left'],
    ['Coding grants', '163 / 512 · 349 left · 27 settled still counted'],
    ['Project invitations', 'Unknown']]);
  assert.match(String(row.children![2].tooltip), /collab-too-old/);
  for (const bad of [{...page, owner: '~nec'}, {...page, schema: 'other'}, {...page, available: false},
    {...page, figures: [{...page.figures[1], remaining: 1}]}, {...page, figures: [{...page.figures[1], settled: 999}]}])
    assert.equal(capacityRows(bad, owner), undefined);
  const rows = workloadRows(owner, undefined, undefined, page)[0].children!;
  assert.equal(rows.at(-1)!.label, 'Remaining capacity');
  assert.equal(workloadRows(owner, undefined, undefined, {...page, owner: '~nec'})[0].children!.at(-1)!.label, 'Remaining admission capacity: unknown');
});
