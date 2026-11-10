import { test } from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkspaceSubmissionGate} from '../src/workspace-submission-gate';
import assert from 'node:assert/strict';
import type { ShipClient } from '../src/ship-client';
import type { JsonObject } from '../src/protocol';
import { WorkspaceRequestStore, type WorkspaceRequestJournal, type WorkspaceRequestRow, type WorkspaceRequestStatus } from '../src/workspace-request-store';

const owner = '~zod';
const row = (index = 1): WorkspaceRequestRow => ({requester: '~nec', nonce: `12345678-1234-4234-8234-${index.toString(16).padStart(12, '0')}`,
  requestDigest: '0xa', project: 'demo', session: '0xb', status: 'reserved'});
const detail = (status: WorkspaceRequestStatus = 'reserved', selected = row()): JsonObject => ({...selected,
  schema: 'readymade-workspace-request-v1', owner, binding: '0xc', generation: '1', authority: owner, noteHost: owner,
  note: 'work-room', nativeRequest: '0xd', text: 'Change the selected project safely.', message: null,
  sourceDesk: 'demo', sourceRevision: '1.234', sourceRoot: '0v1', sourceCommit: '0v2', status,
  evidence: ['recorded', 'refused'].includes(status) ? '0xe' : null, retainedOnly: true, executionAuthorized: false,
  taskCompleted: false, mayResubmit: false, recoveryRequired: ['submitted', 'unknown'].includes(status)});
const preview = (): JsonObject => ({schema: 'readymade-workspace-preview-v1', owner, requester: row().requester,
  nonce: row().nonce, requestDigest: row().requestDigest, scope: '0xf', admission: '0x10', executionAuthorized: false,
  taskCompleted: false, requiresFreshAdmission: true});
const catalog = (rows = [row()], offset = 0, total = rows.length, revision = '0x11'): JsonObject => ({schema: 'readymade-workspace-catalog-v1', owner,
  catalog: revision, executionAuthorized: false, offset, total, requests: rows, next: offset + rows.length === total ? null : offset + rows.length});
function fixture(saved?: WorkspaceRequestJournal, claim = async (_row: WorkspaceRequestRow): Promise<void> => {}) {
  const calls: {operation: string; parameters: unknown}[] = [], saves: WorkspaceRequestJournal[] = [];
  const state = {catalog: catalog(), read: detail(), preview: preview(), completion: completion(), submit: detail('submitted'), recover: detail('recorded'), failPost: false, failSave: false};
  const transport: Pick<ShipClient, 'workspaceRequest'> = {workspaceRequest: async (operation, parameters) => {
    calls.push({operation, parameters: structuredClone(parameters)});
    if (operation === 'submit' || operation === 'recover') {
      assert.equal(saves.at(-1)?.entries[0].attempted, true, 'POST must follow durable attempted marker');
      if (state.failPost) throw new Error('Wire outcome unknown');
    }
    const body = state[operation];
    return {status: body.status === 'refused' ? 409 : body.status === 'submitted' ? 202 : 200, body: structuredClone(body)};
  }};
  const persistence = {saved, claim, save: async (journal: WorkspaceRequestJournal) => {
    if (state.failSave) throw new Error('Journal write failed'); saves.push(structuredClone(journal));
  }};
  return {state, calls, saves, transport, persistence, store: new WorkspaceRequestStore(owner, transport, persistence)};
}
async function ready(f: ReturnType<typeof fixture>): Promise<void> {
  await f.store.load(); f.store.select(f.store.requests[0]); await f.store.read(); await f.store.preview(); f.store.review();
}

test('retained request requires current read, permission preview and explicit review before one submission', async () => {
  const f = fixture(); await f.store.load(); f.store.select(f.store.requests[0]);
  await assert.rejects(f.store.submit(), /Review/); assert.equal(f.store.canReview, false);
  await f.store.read(); assert.equal(f.store.canReview, false); await f.store.preview(); assert.equal(f.store.canReview, true);
  await assert.rejects(f.store.submit(), /Review/); const review = f.store.review(); assert.equal(review.scope, '0xf');
  await f.store.submit(); assert.equal(f.store.observation?.status, 'submitted'); assert.equal(f.store.observation?.taskCompleted, false);
  assert.equal(f.store.observation?.nativeRequest, '0xd'); assert.equal(f.store.observation?.sourceRevision, '1.234');
  assert.match(f.store.notice, /acceptance is unconfirmed/); assert.equal(f.store.canSubmit, false);
  await assert.rejects(f.store.submit(), /Review/);
  assert.deepEqual(f.calls.filter(c => c.operation === 'submit'), [{operation: 'submit', parameters: {requester: '~nec', nonce: row().nonce, requestDigest: '0xa', scope: '0xf'}}]);
});

test('unknown submission survives selection and restart, then explicit recovery retains exact evidence', async () => {
  const f = fixture(); await ready(f); f.state.failPost = true;
  await assert.rejects(f.store.submit(), /unknown/); assert.equal(f.store.uncertain, true);
  f.store.select(); f.store.select(f.store.requests[0]); await assert.rejects(f.store.read(), /unconfirmed/);
  const g = fixture(f.saves.at(-1)); await g.store.load(); g.store.select(g.store.requests[0]);
  await assert.rejects(g.store.read(), /unconfirmed/); await g.store.preview(); assert.equal(g.store.canReview, false);
  await assert.rejects(g.store.submit(), /Review/); assert.equal(g.calls.some(c => c.operation === 'submit'), false);
  await g.store.recover(); assert.equal(g.store.observation?.status, 'recorded'); assert.equal(g.store.uncertain, false);
  assert.match(g.store.notice, /Task completion has not been verified/); assert.equal(g.store.observation?.evidence, '0xe');
  g.state.read = detail('recorded'); await g.store.read();
  g.state.read.evidence = '0xff'; await assert.rejects(g.store.read(), /changed/);
});

test('persistence refusal and absent persistence send no mutation and cannot silently retry', async () => {
  const f = fixture(); await ready(f); f.state.failSave = true;
  await assert.rejects(f.store.submit(), /Journal write failed/); assert.equal(f.store.uncertain, true);
  assert.equal(f.calls.some(c => c.operation === 'submit'), false); f.state.failSave = false;
  await assert.rejects(f.store.submit(), /Review/);
  const readOnly = new WorkspaceRequestStore(owner, f.transport);
  await readOnly.load(); readOnly.select(readOnly.requests[0]); await readOnly.read(); await readOnly.preview(); readOnly.review();
  await assert.rejects(readOnly.submit(), /Durable request journal/); assert.equal(f.calls.some(c => c.operation === 'submit'), false);
});

test('selection and later observations invalidate reviewed scope; no permission is restored from a journal', async () => {
  const f = fixture(); await ready(f); const selection = f.store.exportSelection();
  f.store.select(selection); assert.equal(f.store.canSubmit, false); await f.store.read(); await f.store.preview(); f.store.review();
  f.state.preview.scope = '0x20'; await f.store.preview(); assert.equal(f.store.canSubmit, false);
  assert.equal(f.store.review().scope, '0x20'); await f.store.load(); assert.equal(f.store.canSubmit, false);
  const g = fixture(f.saves.at(-1)); await g.store.load(); g.store.select(selection); assert.equal(g.store.canReview, false);
});

test('catalog pages bind owner, revision, total and identity, preserving old rows on failure', async () => {
  const f = fixture(); f.state.catalog = catalog(Array.from({length: 64}, (_, i) => row(i + 1)), 0, 65);
  await f.store.load(); assert.equal(f.store.catalog?.next, 64);
  f.state.catalog = catalog([row(65)], 64, 65, '0x12'); await assert.rejects(f.store.load(true), /catalog/);
  assert.equal(f.store.requests.length, 64); await assert.rejects(f.store.load(true), /again/);
  f.state.catalog = catalog(Array.from({length: 64}, (_, i) => row(i + 1)), 0, 65); await f.store.load();
  f.state.catalog = catalog([row(65)], 64, 65); await f.store.load(true); assert.equal(f.store.requests.length, 65);
  assert.deepEqual(f.calls.at(-1), {operation: 'catalog', parameters: {offset: 64, catalog: '0x11'}});
  f.state.catalog = catalog([row(), row()]); await assert.rejects(f.store.load(), /identity changed/);
  assert.equal(f.store.requests.length, 65);
});

test('changed selected metadata and foreign owner never become execution context', async () => {
  const f = fixture(); await ready(f);
  f.state.catalog = catalog([{...row(), project: 'other-project'}]); await assert.rejects(f.store.load(), /identity changed/);
  assert.equal(f.store.selection?.project, 'demo'); assert.equal(f.store.canSubmit, false);
  f.state.catalog = {...catalog(), owner: '~bud'}; await assert.rejects(f.store.load(), /catalog/);
  f.state.catalog = catalog([{...row(), requestDigest: '0x99'}]); await assert.rejects(f.store.load(), /identity changed/);
  f.state.catalog = catalog(); await f.store.load(); f.store.select(row());
  f.state.read = {...detail(), session: '0x99'}; await assert.rejects(f.store.read(), /Mismatched/);
  f.state.read = detail(); await f.store.read();
  f.state.preview = {...preview(), owner: '~bud'}; await assert.rejects(f.store.preview(), /permission/);
});

test('native immutable fields and message revisions cannot change under one request digest', async () => {
  const f = fixture(); await ready(f);
  for (const changed of [{text: 'different instruction'}, {sourceRoot: '0v9'}, {nativeRequest: '0x99'},
    {message: {author: '~nec', eid: '0v1', revision: '1', content: '0x42'}}]) {
    f.state.read = {...detail(), ...changed}; await assert.rejects(f.store.read(), /changed/);
  }
  f.state.read = {...detail(), taskCompleted: true}; await assert.rejects(f.store.read(), /Mismatched/);
  f.state.read = {...detail(), mayResubmit: true}; await assert.rejects(f.store.read(), /Mismatched/);
});

test('native refused409 is a retained refusal, not successful execution or a retry opportunity', async () => {
  const f = fixture(); await ready(f); f.state.submit = detail('refused'); await f.store.submit();
  assert.equal(f.store.observation?.status, 'refused'); assert.match(f.store.notice, /No task completion/);
  assert.equal(f.store.canReview, false); await assert.rejects(f.store.submit(), /Review/);
});

test('selection cannot change during a pending transport, and disposal never replays a mutation', async () => {
  const f = fixture(); await ready(f);
  let finish!: (value: {status: number; body: JsonObject}) => void;
  const original = f.transport.workspaceRequest;
  f.transport.workspaceRequest = async (operation, parameters) => operation === 'submit' ? await new Promise(resolve => {finish = resolve;}) : original(operation, parameters);
  const pending = f.store.submit(); await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => f.store.select(), /busy/); assert.equal(f.store.busy, true); f.store.dispose();
  finish({status: 202, body: detail('submitted')}); await assert.rejects(pending, /unavailable|closed/);
  assert.equal(f.saves.at(-1)?.entries[0].attempted, true); await assert.rejects(f.store.recover(), /closed/);
});

test('journal corruption, mixed owners and duplicate keys fail closed without a network request', () => {
  const f = fixture();
  for (const saved of [{version: 1, owner: '~bud', entries: []}, {version: 2, owner, entries: []},
    {version: 1, owner, entries: [{...row(), attempted: 'yes'}]},
    {version: 1, owner, entries: [{...row(), attempted: false}, {...row(), attempted: false}]}]) {
    assert.throws(() => new WorkspaceRequestStore(owner, f.transport, {...f.persistence, saved}), /journal/);
  }
  assert.equal(f.calls.length, 0);
});

test('observed rows and details are detached copies; caller mutations cannot alter approval state', async () => {
  const f = fixture(); await ready(f);
  const rows = f.store.requests as WorkspaceRequestRow[]; rows[0].project = 'forged';
  f.store.observation!.text = 'forged'; f.store.exportJournal().entries[0].attempted = true;
  assert.equal(f.store.selection?.project, 'demo'); assert.equal(f.store.observation?.text, detail().text); assert.equal(f.store.canSubmit, true);
});


test('two windows and a fresh workspace cannot resend one shared request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'readymade-request-claims-'));
  try {
    const make = () => fixture(undefined, async selected => new WorkspaceSubmissionGate(directory, 'https://zod.example', owner).claim(selected));
    const first = make(), second = make(); await ready(first); await ready(second);
    first.state.failPost = true; second.state.failPost = true;
    await Promise.allSettled([first.store.submit(), second.store.submit()]);
    assert.equal([...first.calls, ...second.calls].filter(c => c.operation === 'submit').length, 1);
    const reopened = make(); await ready(reopened);
    await assert.rejects(reopened.store.submit(), /already claimed/);
    assert.equal(reopened.calls.some(c => c.operation === 'submit'), false);
    assert.equal(reopened.store.canRecover, true);
    await reopened.store.recover(); assert.equal(reopened.store.observation?.status, 'recorded');
    assert.equal(reopened.calls.filter(c => c.operation === 'recover').length, 1);
  } finally {rmSync(directory, {recursive: true, force: true});}
});

function codingPages() {
  const base = {owner, ready: true, session: '0xb', phase: 'complete', nonce: '0v1', reset: false, projects: [],
    sessions: [{id: '0xb', project: 'demo', phase: 'complete', source: {owner, desk: 'demo', number: 1235, root: '0v3', commit: '0v4'}}],
    reviews: [{session: '0xb', decision: 'approve', stage: 'applied', checks: [{passed: true}]}]};
  return [{...base, after: 1, cursor: '0x31', more: true, records: [{id: '0x31', sequence: 0, kind: 'operator', text: 'Another instruction'}]},
    {...base, after: 2, cursor: '0x32', more: false, records: [{id: '0x32', sequence: 1, kind: 'judgment', text: 'Native completion judgment'}]},
    {...base, after: 2, cursor: '0x32', more: false, records: []}];
}
async function codingFixture(pages = codingPages()) {
  const f = fixture(); f.state.read = detail('recorded');
  const reads: unknown[][] = [];
  Object.assign(f.transport, {codingState: async (...args: unknown[]) => {
    reads.push(args); assert.ok(pages.length, 'Unexpected extra read'); return structuredClone(pages.shift());
  }});
  await f.store.load(); f.store.select(f.store.requests[0]); await f.store.read();
  return {...f, reads};
}
test('shared request reads paginated linked results without claiming request completion or sending work', async () => {
  const f = await codingFixture(); await f.store.observeCoding();
  assert.deepEqual(f.reads, [['0xb', 0, '0x0'], ['0xb', 1, '0x31'], ['0xb', 2, '0x32']]);
  assert.equal(f.store.codingOutcome?.phase, 'complete'); assert.equal(f.store.codingOutcome?.records.length, 2);
  assert.equal(f.store.codingOutcome?.requestCompletionVerified, false); assert.equal(f.store.observation?.taskCompleted, false);
  assert.match(f.store.codingOutcome!.notice, /later instructions/);
  assert.ok(f.calls.every(c => ['catalog', 'read'].includes(c.operation)));
  f.store.codingOutcome!.records.length = 0; assert.equal(f.store.codingOutcome?.records.length, 2);
  await f.store.read(); assert.equal(f.store.codingOutcome, undefined);
});
test('linked results reject wrong owner, project, session, source and unrelated candidates', async () => {
  for (const mutate of [
    (p: ReturnType<typeof codingPages>[number]) => {p.owner = '~nec';},
    (p: ReturnType<typeof codingPages>[number]) => {p.session = '0xff';},
    (p: ReturnType<typeof codingPages>[number]) => {p.sessions[0].project = 'other';},
    (p: ReturnType<typeof codingPages>[number]) => {p.sessions[0].source.desk = 'other';},
    (p: ReturnType<typeof codingPages>[number]) => {p.sessions[0].source.number = 1;},
    (p: ReturnType<typeof codingPages>[number]) => {p.reviews[0].session = '0xff';},
  ]) {
    const pages = codingPages(); mutate(pages[0]); const f = await codingFixture(pages);
    await assert.rejects(f.store.observeCoding()); assert.equal(f.store.codingOutcome, undefined);
  }
});
test('linked results reject gaps, duplicates, resets and history growth during the final read', async () => {
  for (const mutate of [
    (p: ReturnType<typeof codingPages>) => {p[1].records[0].sequence = 2;},
    (p: ReturnType<typeof codingPages>) => {p[1].records[0].id = '0x31';},
    (p: ReturnType<typeof codingPages>) => {p[1].reset = true;},
    (p: ReturnType<typeof codingPages>) => {p[1].phase = p[1].sessions[0].phase = 'inference';},
    (p: ReturnType<typeof codingPages>) => {p[2].records = [{id: '0x33', sequence: 2, kind: 'operator', text: 'New request'}]; p[2].after = 3;},
  ]) {
    const pages = structuredClone(codingPages()); mutate(pages); const f = await codingFixture(pages);
    await assert.rejects(f.store.observeCoding()); assert.equal(f.store.codingOutcome, undefined);
  }
});
test('closing during linked observation discards the result and prevents stale presentation', async () => {
  const f = await codingFixture();
  Object.assign(f.transport, {codingState: async () => {f.store.dispose(); throw new Error('Closed during read');}});
  await assert.rejects(f.store.observeCoding()); assert.equal(f.store.codingOutcome, undefined);
});

function completion(status = 'superseded'): JsonObject {
  return {schema: 'readymade-workspace-completion-v1', owner, requester: row().requester, nonce: row().nonce,
    requestDigest: '0xa', nativeRequest: '0xd', session: '0xb', submissionEvidence: '0xe', status,
    instruction: '0x31', judgment: status === 'complete' ? '0x32' : null, evidence: status === 'complete' ? ['0x33'] : [],
    reason: status === 'complete' ? 'native-completion' : 'later-owner-instruction', taskCompleted: status === 'complete', executionAuthorized: false};
}
test('native completion is separately bound to the exact request and cleared on refresh or close', async () => {
  const f = fixture(); f.state.read = detail('recorded');
  await f.store.load(); f.store.select(f.store.requests[0]); await f.store.read(); await f.store.observeCompletion();
  assert.equal(f.store.requestOutcome?.status, 'superseded'); assert.equal(f.store.observation?.taskCompleted, false);
  assert.ok(f.calls.every(c => ['catalog', 'read', 'completion'].includes(c.operation)));
  f.store.requestOutcome!.status = 'complete'; assert.equal(f.store.requestOutcome?.status, 'superseded');
  await f.store.read(); assert.equal(f.store.requestOutcome, undefined);
  f.state.completion = completion('complete'); await f.store.observeCompletion();
  assert.equal((f.store.requestOutcome as JsonObject | undefined)?.taskCompleted, true); assert.equal(f.store.observation?.taskCompleted, false);
  f.store.dispose(); assert.equal(f.store.requestOutcome, undefined);
});
test('completion rejects crossed request identities, missing judgment evidence and false completion flags', async () => {
  for (const change of [{owner: '~nec'}, {requester: '~zod'}, {nonce: 'other'}, {requestDigest: '0xff'},
    {nativeRequest: '0xff'}, {session: '0xff'}, {submissionEvidence: '0xff'}, {evidence: []},
    {judgment: null}, {instruction: null}, {taskCompleted: false}, {executionAuthorized: true}, {reason: 'unrelated'}]) {
    const f = fixture(); f.state.read = detail('recorded'); f.state.completion = {...completion('complete'), ...change};
    await f.store.load(); f.store.select(f.store.requests[0]); await f.store.read();
    await assert.rejects(f.store.observeCompletion(), /Mismatched/); assert.equal(f.store.requestOutcome, undefined);
  }
});
