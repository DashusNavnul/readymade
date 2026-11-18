import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {boardReport, collabNotices, historyReport, noticeLines, noticeRetry, noticesReport, noticesRoom, noticesSeen, noticesUnseen, noticeText, presenceBoard, presencePlan, presenceReport, presenceTarget, presenceText, refusalName, rolesReport, sessionRoles,
  sessionStreams, streamClose, streamOpen, streamText, suggestionHistory, suggestionSteps, workAsk, workDismiss, workJournal, workJournalAdd, workNonce, workCurrent, workProgress, workQueue, workReport, workWithdraw, workWithdrawable, WORK_JOURNAL_MAX} from '../src/collab-pages';

const page = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(__dirname, '../../tests/fixtures/native', name + '.json'), 'utf8')) as Record<string, unknown>;
const owner = '~zod', peer = '~nec', demo = 'pataphor-demo-mp';

test('notices: the owner sees each outcome, the peer reads plain sentences, newest first', () => {
  const sent = collabNotices(page('owner-notices'), owner)!, got = collabNotices(page('peer-notices'), peer)!;
  assert.ok(sent.outbox.length >= 5); assert.ok(sent.outbox.every(n => n.from === owner && n.status === 'delivered' && n.answeredAt));
  assert.equal(got.inbox.length, sent.outbox.length); assert.ok(got.inbox.every(n => n.to === peer));
  const landed = got.inbox.find(n => n.kind === 'suggestion-landed')!, work = got.inbox.find(n => n.kind === 'work-finished')!;
  assert.match(noticeText(landed), /^~zod landed your suggestion 0x[0-9a-f.]+ in pataphor-demo-mp\. Landed in pataphor-demo-mp-work at revision \d+/);
  assert.match(noticeText(work), /^~zod finished your work request 0x1002 in pataphor-demo-mp\. Finished: judgment/);
  assert.match(noticeText(landed, () => '/lib/session-rate/hoon'), /^~zod landed your suggestion for \/lib\/session-rate\/hoon in pataphor-demo-mp\./);
  assert.equal(noticeText(work, () => '/lib/x/hoon'), noticeText(work), 'a work notice names no file');
  const lines = noticeLines(got);
  assert.equal(lines.length, got.inbox.filter(n => !['suggestion-taken', 'suggestion-declined'].includes(n.kind)).length); assert.ok(lines.length < got.inbox.length, 'answers are left to the share notices');
  assert.match(lines[0]!.day, /^2026-11-17$/); assert.match(lines[0]!.text, /^~zod (?:finished|started|queued|landed) your /);
  assert.equal(noticesUnseen(got, undefined).length, got.inbox.length); assert.equal(noticesUnseen(got, noticesSeen(got)).length, 0);
  assert.deepEqual(noticesUnseen(got, noticesSeen(got).slice(1)), [got.inbox[0]]);
  // A notice made earlier that arrives later is still new: only what was shown counts, never a time.
  const oldest = got.inbox.at(-1)!;
  assert.deepEqual(noticesUnseen(got, noticesSeen(got).filter(id => id !== oldest.id)), [oldest]);
  // A mark of any other shape (an older version kept a time) means nothing was shown.
  assert.equal(noticesUnseen(got, got.inbox[0]!.at).length, got.inbox.length); assert.equal(noticesUnseen(got, [1, null]).length, got.inbox.length);
  const r = noticesReport(sent); assert.match(r.status, /^\d+ sent, 0 received\./); assert.ok(r.sections[0]!.lines.every(l => !l.action));
  const raw = page('owner-notices'), first = (raw.outbox as Record<string, unknown>[])[0]!;
  const lost = collabNotices({...raw, outbox: [{...first, status: 'unknown', retryable: true, answeredAt: null}]}, owner)!;
  assert.equal(noticesReport(lost).sections[0]!.lines[0]!.action?.id, `retry:${lost.outbox[0]!.id}`); assert.match(noticesReport(lost).status, /1 with an unknown outcome/);
  assert.deepEqual(noticeRetry(lost.outbox[0]!.id), {schema: 'readymade-notice-retry-v1', id: lost.outbox[0]!.id});
  assert.throws(() => collabNotices({...raw, outbox: [{...first, status: 'unknown', retryable: false}]}, owner), 'retryable must follow the status');
  assert.throws(() => collabNotices(raw, peer), 'another ship’s page'); assert.throws(() => collabNotices({...raw, outbox: [{...first, from: peer, to: owner}]}, owner));
  assert.equal(collabNotices({...raw, outbox: [{...first, kind: 'future-kind'}]}, owner)!.outbox.length, 0, 'an unknown kind is left out');
  assert.equal(collabNotices({schema: 'readymade-collab-notices-v1', available: false, error: 'notice-store-unavailable'}, owner), undefined);
});

test('suggestion history: four steps per suggestion, as they stand', () => {
  const h = suggestionHistory(page('history'), owner, demo), landed = h.rows.find(s => s.landed && s.answer)!, never = h.rows.find(s => !s.landed)!;
  assert.deepEqual(suggestionSteps(landed).map(s => s.split(' ')[0]), ['Authored', 'Reviewed:', 'Landed', 'Acknowledged']);
  assert.deepEqual(suggestionSteps(never).slice(1), ['Not reviewed', 'Not landed', 'Nothing told to the author yet']);
  const r = historyReport(h); assert.match(r.status, /^53 suggestions, \d+ landed; the newest \d+ are shown\./); assert.equal(r.sections[0]!.lines.length, h.rows.length);
  assert.throws(() => suggestionHistory(page('history'), peer, demo)); assert.throws(() => suggestionHistory(page('history'), owner, 'other'));
  assert.throws(() => suggestionHistory({...page('history'), shown: 1}, owner, demo));
  // a ship from before the field read its whole archive: complete, and nothing is said
  assert.equal(h.archiveComplete, true); assert.doesNotMatch(r.status, /archive/);
  assert.equal(suggestionHistory({...page('history'), archiveComplete: true}, owner, demo).archiveComplete, true);
  const partial = suggestionHistory({...page('history'), archiveComplete: false}, owner, demo);
  assert.equal(partial.archiveComplete, false); assert.match(historyReport(partial).status, /some suggestions may be missing here\.$/);
  assert.throws(() => suggestionHistory({...page('history'), archiveComplete: 'no'}, owner, demo));
});

test('presence: who else has the file, why a report was refused, and what to tell next', () => {
  const mine = presenceBoard(page('peer-presence'), owner, demo);
  assert.deepEqual(mine.refused.map(r => [r.path, r.reason]), [['/desk/bill', 'presence-path-not-shared']]);
  assert.equal(refusalName('poke-ack\n | trace'), 'poke-ack'); assert.equal(refusalName(' | %work-peer-limit'), 'work-peer-limit');
  const entry = (who: string, mode: string, label = '') => ({ship: who, path: '/lib/a/hoon', mode, label, at: '~2026.11.17..10.00.00', until: '~2026.11.17..10.04.00'});
  const board = presenceBoard({schema: 'readymade-file-presence-v1', authority: owner, project: demo, observedAt: '~2026.11.17..10.00.01',
    entries: [entry(owner, 'editing'), entry(peer, 'viewing'), entry('~bud', 'agent', 'claude review 1')], refused: []}, owner, demo);
  assert.equal(presenceText(board, '/lib/a/hoon', peer), '~zod is editing (a private draft); ~bud\'s agent has claimed it (claude review 1)');
  assert.equal(presenceText(board, '/lib/b/hoon', peer), '');
  const shown = boardReport(board, peer);
  assert.match(shown.status, /^3 open on 1 file\./); assert.equal(shown.sections.length, 1); assert.equal(shown.sections[0]!.lines[0]!.mark, 'warning', 'an agent claim stands out');
  assert.equal(shown.sections[0]!.lines[0]!.detail, '~zod: editing (a private draft), until ~2026.11.17..10.04.00\nYou: viewing, until ~2026.11.17..10.04.00\n~bud: claimed by an agent (claude review 1), until ~2026.11.17..10.04.00');
  const refusedBoard = boardReport(mine, peer);
  assert.equal(refusedBoard.sections[1]!.title, 'Not shown'); assert.match(refusedBoard.sections[1]!.lines[0]!.detail!, /^presence path not shared\. That file is not shared with you/);
  assert.throws(() => presenceBoard({...page('peer-presence'), entries: [entry(owner, 'typing')]}, owner, demo));
  assert.deepEqual(presenceReport(owner, demo, '/lib/a/hoon', 'editing'), {schema: 'readymade-file-presence-v1', authority: owner, project: demo, path: '/lib/a/hoon', mode: 'editing', label: '', seconds: '240'});
  assert.throws(() => presenceReport(owner, demo, 'lib/a', 'viewing')); assert.throws(() => presenceReport(owner, demo, '/lib/a/hoon', 'viewing', '', 301));
  const a = {path: '/lib/a/hoon', mode: 'viewing' as const}, t0 = 1_000_000;
  assert.deepEqual(presencePlan(undefined, a, t0), [a]);
  assert.deepEqual(presencePlan({...a, at: t0}, a, t0 + 60_000), [], 'a fresh lease is left alone');
  assert.deepEqual(presencePlan({...a, at: t0}, a, t0 + 120_000), [a], 'renewed at half its life');
  assert.deepEqual(presencePlan({...a, at: t0}, {...a, mode: 'editing'}, t0 + 1), [{...a, mode: 'editing'}]);
  assert.deepEqual(presencePlan({...a, at: t0}, {path: '/lib/b/hoon', mode: 'viewing'}, t0 + 1), [{path: a.path, mode: 'closed'}, {path: '/lib/b/hoon', mode: 'viewing'}]);
  assert.deepEqual(presencePlan({...a, at: t0}, undefined, t0 + 1), [{path: a.path, mode: 'closed'}]); assert.deepEqual(presencePlan(undefined, undefined, t0), []);
});

test('presence target: a shared file goes to its owner, an own file to this ship, anything else nowhere', () => {
  const file = {owner, project: demo, path: '/lib/a/hoon'};
  assert.deepEqual(presenceTarget({scheme: 'readymade-remote-source', path: '/abc/lib/a/hoon'}, peer, undefined, file), {authority: owner, project: demo, path: '/lib/a/hoon', mode: 'viewing'});
  assert.equal(presenceTarget({scheme: 'readymade-remote-original', path: '/abc/lib/a/hoon'}, peer, undefined, file)?.mode, 'viewing');
  assert.equal(presenceTarget({scheme: 'readymade-remote-draft', path: '/abc/lib/a/hoon'}, peer, undefined, file)?.mode, 'editing');
  assert.equal(presenceTarget({scheme: 'readymade-remote-draft', path: '/abc/lib/a/hoon'}, peer, 'mine', undefined), undefined, 'a shared document this window cannot place');
  assert.equal(presenceTarget({scheme: 'readymade-remote-source', path: '/abc/lib/a/hoon'}, owner, undefined, file), undefined, 'never report to oneself as a peer');
  assert.equal(presenceTarget({scheme: 'readymade-remote-source', path: '/x'}, peer, undefined, {...file, path: '/Lib/A'}), undefined);
  assert.deepEqual(presenceTarget({scheme: 'urbit-source', path: '/0123abcd/lib/a/hoon'}, owner, demo, undefined), {authority: owner, project: demo, path: '/lib/a/hoon', mode: 'viewing'});
  assert.equal(presenceTarget({scheme: 'readymade-draft', path: '/0123abcd/lib/a/hoon'}, owner, demo, undefined)?.mode, 'editing');
  assert.equal(presenceTarget({scheme: 'urbit-source', path: '/0123abcd/lib/a/hoon'}, owner, undefined, undefined), undefined, 'no project chosen');
  assert.equal(presenceTarget({scheme: 'urbit-source', path: '/0123abcd'}, owner, demo, undefined), undefined);
  assert.equal(presenceTarget({scheme: 'file', path: '/Users/me/secret.txt'}, owner, demo, file), undefined, 'a local file is never reported');
  assert.equal(presenceTarget({scheme: 'untitled', path: 'Untitled-1'}, owner, demo, undefined), undefined);
});

test('the journal of asked work keeps the request text, survives a bad stored value, and follows the owner’s notices', () => {
  const asked = (nonce: string, patch: object = {}) => ({nonce, owner, project: demo, session: '0xe1b1.e811', text: 'Add a test.', at: 1_800_000_000_000, answer: 'queued' as const, ...patch});
  assert.deepEqual(workJournal(undefined), []); assert.deepEqual(workJournal('junk'), []);
  assert.deepEqual(workJournal([asked('0x1'), {nonce: 'bad'}, null, asked('0x1', {text: 'duplicate'}), asked('0x2', {answer: 'maybe'})]).map(a => a.nonce), ['0x1'], 'only whole entries, each nonce once');
  let list = workJournalAdd([], asked('0x1', {answer: 'unanswered'})); list = workJournalAdd(list, asked('0x2')); list = workJournalAdd(list, asked('0x1'));
  assert.deepEqual(list.map(a => [a.nonce, a.answer]), [['0x1', 'queued'], ['0x2', 'queued']], 'an answer replaces the unanswered entry and moves it first');
  for (let i = 3; i < 80; i++) list = workJournalAdd(list, asked('0x' + i.toString(16)));
  assert.equal(list.length, WORK_JOURNAL_MAX);
  const got = collabNotices(page('peer-notices'), peer)!, mine = asked('0x1002');
  assert.match(workProgress(mine, got.inbox), /^Finished: judgment at sequence \d+, revision \d+\.$/, 'the newest notice about this request');
  assert.equal(workProgress(asked('0x1003'), got.inbox), 'Queued; waiting for the session to be free.');
  assert.equal(workProgress(asked('0x9999'), got.inbox), 'Queued; no progress has been reported yet.');
  assert.match(workProgress(asked('0x9999', {answer: 'refused', reason: 'work-peer-limit'}), got.inbox), /^Refused: work peer limit\. You already have two open requests/);
  assert.match(workProgress(asked('0x9999', {answer: 'unanswered'}), got.inbox), /had not answered when it was read\. It was not sent again\.$/);
  assert.equal(workProgress(asked('0x1002', {owner: '~bud'}), got.inbox), 'Queued; no progress has been reported yet.', 'a notice from another ship is not this owner’s word');
  const report = workReport(workQueue(page('peer-work'), peer), undefined, [mine, asked('0x9999', {answer: 'refused', reason: 'work-peer-limit', text: 'Count lines.'})], got.inbox);
  assert.match(report.status, /2 asked of other owners/); assert.deepEqual(report.sections[1]!.lines.map(l => [l.text, l.mark]), [['Add a test.', 'ok'], ['Count lines.', 'warning']]);
  assert.match(report.sections[1]!.lines[0]!.detail!, /^Finished: judgment.*\n0x1002 to ~zod in pataphor-demo-mp/s);
  // Only a request that is queued and has not been reported as started can be taken back or dismissed.
  assert.ok(workWithdrawable(asked('0x1003'), got.inbox), 'queued, nothing started'); assert.ok(!workWithdrawable(mine, got.inbox), 'already finished');
  assert.ok(!workWithdrawable(asked('0x1003', {answer: 'refused'}), got.inbox));
  // The owner's own notice that it queued the request counts when its first answer was never read here; without one, nothing is offered.
  assert.ok(workWithdrawable(asked('0x1003', {answer: 'unanswered'}), got.inbox)); assert.ok(workWithdrawable(asked('0x1003', {answer: 'unknown'}), got.inbox));
  assert.ok(!workWithdrawable(asked('0x9999', {answer: 'unanswered'}), got.inbox)); assert.ok(!workWithdrawable(asked('0x1003', {answer: 'unanswered', owner: '~bud'}), got.inbox), 'another ship\'s notice is not this owner\'s word');
  // An entry whose first answer was never read is brought up to what the ship holds now, and never past it.
  const row = (status: 'sent' | 'accepted' | 'refused', reason = '') => ({nonce: '0x77', owner: '~zod', project: 'pataphor-demo-mp', session: '0xe1b1.e811', status, reason, at: '~2026.11.17..10.47.00'});
  const waiting = asked('0x77', {answer: 'unknown'});
  assert.equal(workCurrent(waiting, []), waiting); assert.equal(workCurrent(waiting, [row('sent')]).answer, 'unanswered', 'the ship holds it, so it did leave');
  assert.equal(workCurrent(waiting, [row('accepted')]).answer, 'queued'); assert.deepEqual([workCurrent(waiting, [row('refused', 'work-peer-limit')])].map(a => [a.answer, a.reason]), [['refused', 'work-peer-limit']]);
  assert.equal(workCurrent(waiting, [{...row('accepted'), owner: '~bud'}]), waiting); assert.equal(workCurrent(asked('0x77'), [row('refused', 'x')]).answer, 'queued', 'an answer already read is not rewritten');
  assert.equal(workProgress(waiting, got.inbox), 'Unknown whether it was sent: the ship gave no readable answer. It was not sent again.');
  assert.deepEqual(workJournal([asked('0x5', {answer: 'unknown'})]).map(a => a.answer), ['unknown']);
  const actions = workReport(workQueue(page('peer-work'), peer), undefined, [mine, asked('0x1003')], got.inbox).sections[1]!.lines.map(l => l.action?.id);
  // The ship keeps a fixed number of notices: nearly full and full are said, in the notices screen and here.
  const few = collabNotices(page('peer-notices'), peer)!;
  assert.equal(noticesRoom(few), ''); assert.equal(noticesRoom({...few, capacity: 0}), '');
  // The limit is for each direction, not for both together: 9 received of 9 is full, 9 received of 18 is not.
  assert.match(noticesRoom({...few, capacity: few.inbox.length}), /holds as many received notices as it keeps \(9 of 9\): it records no new one/);
  assert.equal(noticesRoom({...few, capacity: few.inbox.length + few.outbox.length + 9}), '');
  assert.match(noticesRoom({...few, capacity: few.inbox.length + 1}), /store of received notices is nearly full \(9 of 10\)/);
  assert.match(noticesReport({...few, capacity: few.inbox.length}).note!, /never sent again by itself\. This ship holds as many received notices/);
  assert.match(workReport(workQueue(page('peer-work'), peer), undefined, [mine], null).note!, /notices could not be read just now/);
  assert.deepEqual(actions, [undefined, 'withdraw:0x1003']);
  const ownerRows = workReport(workQueue(page('owner-work'), owner)).sections[0]!.lines, raw = page('owner-work').requests as Record<string, unknown>[];
  assert.deepEqual(ownerRows.map(l => l.action?.id), raw.map(w => w.status === 'queued' ? `dismiss:${w.id as string}` : undefined));
  assert.deepEqual(workDismiss('0x12ab'), {schema: 'readymade-work-dismiss-v1', id: '0x12ab'}); assert.throws(() => workDismiss('12ab'));
  assert.deepEqual(workWithdraw(asked('0x1003')), {schema: 'readymade-work-withdraw-v1', owner, nonce: '0x1003', project: demo, session: '0xe1b1.e811'});
  const refusedBack = workQueue({...page('peer-work'), withdrawRefused: [{nonce: '0x1003', reason: 'poke-ack\n | %work-request-started\n', at: '~2026.11.17..14.00.00'}]}, peer);
  assert.deepEqual(refusedBack.withdrawRefused, [{nonce: '0x1003', reason: 'work-request-started'}]); assert.deepEqual(workQueue(page('peer-work'), peer).withdrawRefused, []);
  for (const [phase, words] of [['dismissed', /^Dismissed by you before it started/], ['withdrawn', /^Withdrawn by its requester before it started/], ['revoked', /^Not started: its requester lost access to the session while it waited\. Nothing ran\./],
    ['not-started', /^Not started: the session did not take it, so no run began\./], ['session-gone', /^Not finished: its session no longer exists on this ship\./],
    ['not-run', /^Taken, not run: the session holds this instruction and has not started a run of it\. Run the session to do it\./],
    ['stopped', /^Stopped: the session began it and then sat ready without running for ten minutes \(revision 8\)\. Run the session to continue\./]] as const) {
    const ended = workReport(workQueue({...page('owner-work'), requests: [{...raw.find(w => w.status === 'finished')!, outcome: {phase, sequence: 19, revision: 8, at: '~2026.11.17..14.00.00'}}]}, owner)).sections[0]!.lines[0]!;
    assert.match(ended.detail!, words); assert.equal(ended.action, undefined);
    // work the session never began is marked for the owner's attention, never as done
    assert.equal(ended.mark, ['dismissed', 'withdrawn', 'revoked'].includes(phase) ? 'ok' : 'warning');
  }
});

test('session streams: one line each, and exact open and close commands', () => {
  const stream = (patch: object) => ({owner, session: '0xe1b1.e811', project: demo, phase: 'live', reason: 'opening', sequence: 11, reconnects: 0, opened: '~2026.11.17..10.19.27', updated: '~2026.11.17..10.20.30',
    status: {phase: 'paused', at: '~2026.11.17..10.20.30', source: 'pataphor-demo-mp-work/8'}, ...patch});
  const list = (streams: unknown[]) => ({schema: 'readymade-session-streams-v1', peer, observedAt: '~2026.11.17..10.21.00', streams});
  assert.equal(sessionStreams(page('peer-streams'), peer).length, (page('peer-streams').streams as unknown[]).length);
  const [live, quiet, ended] = sessionStreams(list([stream({}), stream({session: '0x2', status: null}), stream({session: '0x3', phase: 'ended', reason: 'inspection-grant-revoked'})]), peer);
  assert.equal(streamText(live!), 'paused · sequence 11 · pataphor-demo-mp-work/8'); assert.equal(streamText(quiet!), 'Live; nothing has changed since sequence 11');
  assert.equal(streamText(ended!), 'Stream ended: inspection grant revoked. The owner stopped sharing this session with you.');
  assert.throws(() => sessionStreams(list([stream({phase: 'open'})]), peer)); assert.throws(() => sessionStreams(list([]), owner));
  assert.deepEqual(streamOpen(owner, demo, 5, '0xdf49.1c93', '0xe1b1.e811', 11), {schema: 'readymade-session-stream-v1', action: 'open', owner, project: demo, generation: '5', inspection: '0xdf49.1c93', session: '0xe1b1.e811', cursor: '11'});
  assert.ok(!('cursor' in streamOpen(owner, demo, 5, '0xdf49.1c93', '0xe1b1.e811'))); assert.throws(() => streamOpen(owner, demo, -1, '0x1', '0x2'));
  // Both numbers go in the ship's own form: digits in threes with dots. Plain "1000" is refused by the ship's parser.
  const far = streamOpen(owner, demo, '1.024', '0xdf49.1c93', '0xe1b1.e811', 1000);
  assert.equal(far.generation, '1.024'); assert.equal(far.cursor, '1.000');
  assert.equal(streamOpen(owner, demo, 1024, '0x1', '0x2', 1_234_567).generation, '1.024'); assert.equal(streamOpen(owner, demo, 0, '0x1', '0x2', 1_234_567).cursor, '1.234.567');
  assert.equal(streamOpen(owner, demo, '0', '0x1', '0x2', 999).cursor, '999');
  for (const bad of ['1024', '01', '1.02', '1,024', '', '-1', ' 1']) assert.throws(() => streamOpen(owner, demo, bad, '0x1', '0x2'), /Invalid stream/, bad);
  assert.deepEqual(streamClose(owner, '0xe1b1.e811'), {schema: 'readymade-session-stream-v1', action: 'close', owner, session: '0xe1b1.e811'});
});

test('work requests: the owner’s queue, the peer’s asks with the ship’s refusal, and roles', () => {
  const q = workQueue(page('owner-work'), owner), mine = workQueue(page('peer-work'), peer);
  assert.ok(q.requests.some(w => w.status === 'finished' && w.outcome?.phase === 'judgment')); assert.ok(q.store);
  const r = workReport(q, 2); assert.match(r.status, /^\d+ open on this ship, 0 asked of other owners\./); assert.match(r.note!, /2 admissions left/);
  assert.equal(workReport(mine).sections[0]!.lines.length, 0);
  const raw = page('owner-work'), done = (raw.requests as Record<string, unknown>[]).find(w => w.status === 'finished')!;
  const refusedRun = workReport(workQueue({...raw, requests: [{...done, outcome: {...(done.outcome as object), phase: 'not-started'}}]}, owner)).sections[0]!.lines[0]!;
  assert.match(refusedRun.detail!, /^Not started: this ship could not start it in the session\. Nothing ran\./); assert.equal(refusedRun.mark, 'warning');
  const asked = workQueue({...page('peer-work'), asked: [{nonce: '0x1004', owner, project: demo, session: '0xe1b1', status: 'refused', reason: 'poke-ack\n | x\n | %work-peer-limit\n', at: '~2026.11.17..10.47.00'}]}, peer);
  assert.equal(asked.asked[0]!.reason, 'work-peer-limit'); assert.match(workReport(asked).sections[1]!.lines[0]!.detail!, /^Refused: work peer limit/);
  assert.throws(() => workQueue(page('owner-work'), peer));
  for (let i = 0; i < 50; i++) assert.match(workNonce(), /^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/);
  const cmd = workAsk(owner, demo, '0xe1b1.e811', '  Add a test.  ', '0x1005');
  assert.deepEqual(cmd, {schema: 'readymade-work-request-v1', owner, nonce: '0x1005', project: demo, session: '0xe1b1.e811', text: 'Add a test.'});
  assert.throws(() => workAsk(owner, demo, '0xe1b1.e811', '   ')); assert.throws(() => workAsk('zod', demo, '0x1', 'x'));
  const roles = sessionRoles(page('roles'), owner, demo), report = rolesReport(demo, roles);
  assert.equal(roles[0]!.controller, owner); assert.deepEqual(roles[0]!.observers, [peer]); assert.match(report.sections[0]!.lines[0]!.detail!, /Controller: ~zod\nRequesters: /);
  assert.throws(() => sessionRoles(page('roles'), owner, 'other'));
});
