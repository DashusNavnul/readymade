import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {admissionsLeft, answerCommand, dateAtomText, proposalDismiss, handoffDocument, memoryLabel, memorySupersede, memoryUnsupersede, memoryView, overviewProblems, overviewReport, ownerOverview, ownerTasks, policyReport, policySet, standingPolicy, tasksReport} from '../src/owner-pages';

const page = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(__dirname, '../../tests/fixtures/native', name + '.json'), 'utf8')) as Record<string, unknown>;

test('the overview reads the real page and says what waits on the owner', () => {
  const o = ownerOverview(page('overview')), r = overviewReport(o);
  assert.ok(o.decisions.length > 0); assert.equal(o.unavailable.length, 0); assert.equal(typeof o.admissionsLeft, 'number');
  assert.match(r.status, new RegExp(`^${o.decisions.length} decisions? waiting on you`)); assert.equal(r.sections[0]!.title, 'Waiting on you');
  assert.equal(r.sections[0]!.lines.length, o.decisions.length); assert.equal(r.note, undefined);
  const blocked = overviewProblems(o); assert.equal(blocked.length, o.blockers.length);
  if (blocked.length) {assert.ok(blocked[0]!.title.length > 0); assert.ok(!blocked[0]!.title.includes(': '));}
  assert.match(overviewReport({...o, unavailable: ['candidate ledger']}).note!, /could not read: candidate ledger.*missing below, not empty/);
  assert.match(overviewReport({...o, decisions: [], blockers: []}).status, /^Nothing is waiting on you\./);
  // With a source the ship could not read, "nothing" is not claimed, and a count is said to be partial.
  assert.match(overviewReport({...o, decisions: [], blockers: [], unavailable: ['tasks']}).status, /^No decision found, but the ship could not read every part\./);
  assert.match(overviewReport({...o, blockers: [], unavailable: ['tasks']}).status, /^\d+ decisions? waiting on you in the parts the ship could read\./);
  // A question line can carry 2,048 bytes of question and 1,024 of consequence; the page must still read.
  const long = {kind: 'question', what: 'Question on task x: ' + 'q'.repeat(2048) + ' If unanswered: ' + 'c'.repeat(1024)};
  assert.equal(ownerOverview({...page('overview'), decisions: [long]}).decisions[0]!.what.length, long.what.length);
  assert.throws(() => ownerOverview({...page('overview'), decisions: [{kind: 'question', what: 'q'.repeat(8193)}]}));
  // A moment this app sends is written as the ship writes one, and the app's own reader takes it back.
  assert.equal(dateAtomText(Date.UTC(2026, 11, 1, 3, 5, 9)), '~2026.12.01..03.05.09'); assert.equal(dateAtomText(Date.UTC(2027, 0, 5, 0, 45, 26)), '~2027.01.05..00.45.26');
  assert.throws(() => ownerOverview({...page('overview'), schema: 'owner-overview-v2'}));
  assert.throws(() => ownerOverview({...page('overview'), running: [{kind: 'x'}]}));
  assert.throws(() => ownerOverview({...page('overview'), policyAdmissionsLeft: -1}));
});

test('tasks: open questions lead, each with an answer action; a mismatched count is refused', () => {
  const t = ownerTasks(page('tasks'))!, r = tasksReport(t), open = t.questions.filter(q => q.open);
  assert.ok(open.length >= 1); assert.equal(r.sections[0]!.lines[0]!.action?.id, `answer:${open[0]!.id}`);
  assert.match(r.sections[0]!.lines[0]!.detail!, /Why it matters: /); assert.ok(t.tasks.some(row => row.blockedBy.length > 0));
  assert.ok(t.proposals.length >= 1); assert.match(r.sections[2]!.lines[0]!.detail!, /policy version \d+\nEvidence: /);
  // A question its asker withdrew is closed, shown as withdrawn, and offers no answer.
  const raw = page('tasks'), first = (raw.questions as Record<string, unknown>[]).find(q => q.open)!;
  const gone = ownerTasks({...raw, openQuestions: (raw.openQuestions as number) - 1, questions: (raw.questions as Record<string, unknown>[]).map(q => q === first ? {...q, open: false, withdrawn: true} : q)})!;
  const line = tasksReport(gone).sections[0]!.lines.find(l => l.text === first.text)!;
  assert.equal(line.action, undefined); assert.equal(line.mark, 'ok'); assert.match(line.detail!, /withdrew this question; it needs no answer\.$/);
  assert.equal(t.questions.every(q => q.withdrawn === false), true, 'a ship that does not send the field means not withdrawn');
  assert.throws(() => ownerTasks({...raw, questions: [{...first, open: true, withdrawn: true}]}), 'withdrawn and open cannot both hold');
  // A proposal that is still open can be dismissed; a closed one says how it ended and offers nothing.
  const open0 = r.sections[2]!.lines[0]!, pid = t.proposals[0]!.id;
  assert.equal(open0.action?.id, `dismiss-proposal:${pid}`); assert.deepEqual(proposalDismiss(pid), {action: 'dismiss-proposal', id: pid});
  const closedOne = tasksReport(ownerTasks({...raw, proposals: (raw.proposals as Record<string, unknown>[]).map(p => ({...p, closed: 'withdrawn'}))})!).sections[2]!.lines[0]!;
  assert.equal(closedOne.action, undefined); assert.match(closedOne.detail!, /^Withdrawn by claude\. /);
  assert.throws(() => ownerTasks({...raw, proposals: (raw.proposals as Record<string, unknown>[]).map(p => ({...p, closed: 'erased'}))}));
  assert.equal(ownerTasks({schema: 'owner-tasks-v1', available: false}), undefined);
  assert.throws(() => ownerTasks({...page('tasks'), openQuestions: 99}));
  assert.throws(() => ownerTasks({...page('tasks'), tasks: [{task: 'Bad Task', claims: 1, holder: null, until: null, blockedBy: []}]}));
  assert.equal(ownerTasks({...page('tasks'), tasks: [{task: 'busy', claims: 257, holder: null, until: null, blockedBy: []}]})!.tasks[0]!.claims, 257, 'a task released after its 256th claim still reads');
  assert.deepEqual(answerCommand(open[0]!.id, '  Keep it.  '), {action: 'answer', id: open[0]!.id, text: 'Keep it.'});
  assert.throws(() => answerCommand(open[0]!.id, '   ')); assert.throws(() => answerCommand('12', 'x'));
});

test('the standing policy reads the real page; a set command is checked before it is sent', () => {
  const p = standingPolicy(page('policy'))!, r = policyReport(p);
  assert.equal(p.chain, 'valid'); assert.ok(p.inForce); assert.ok(p.versions.some(v => v.revoked)); assert.match(r.status, /in force for pataphor-demo-mp/);
  assert.deepEqual(r.actions!.map(a => a.id), ['set', 'revoke']);
  const cmd = policySet(p.inForce!); assert.equal(cmd.action, 'set'); assert.deepEqual(cmd.tools, [...p.inForce!.tools]);
  assert.throws(() => policySet({...p.inForce!, tools: []})); assert.throws(() => policySet({...p.inForce!, tools: ['rm']}));
  // A stored version may hold a path with an empty part; the history must still read, and such a path is never sent.
  const raw = page('policy') as {versions: {body: {paths: string[]} | null}[]}, odd = raw.versions.findIndex(v => v.body);
  const history = {...raw, versions: raw.versions.map((v, i) => i === odd ? {...v, body: {...v.body!, paths: ['/lib/a/']}} : v)};
  assert.ok(standingPolicy(history)!.versions.some(v => v.body?.paths.includes('/lib/a/')));
  assert.throws(() => policySet({...p.inForce!, paths: ['/lib/a/']})); assert.throws(() => standingPolicy({...raw, versions: raw.versions.map((v, i) => i === odd ? {...v, body: {...v.body!, paths: ['lib/a']}} : v)}));
  assert.throws(() => policySet({...p.inForce!, paths: ['lib/a/hoon']})); assert.throws(() => policySet({...p.inForce!, resources: {...p.inForce!.resources, maxAdmissions: 0}}));
  // Admissions left: the limit less what was dispatched under the version in force, never below zero.
  const newest = Math.max(...p.versions.map(v => v.version)), limit = p.inForce!.resources.maxAdmissions;
  assert.equal(admissionsLeft(p, []), limit); assert.equal(admissionsLeft(p, [{policyVersion: newest}, {policyVersion: newest - 1}, {}]), limit - 1);
  assert.equal(admissionsLeft(p, Array.from({length: limit + 3}, () => ({policyVersion: newest}))), 0);
  assert.equal(admissionsLeft({...p, inForce: undefined}, []), 0); assert.equal(admissionsLeft(undefined, []), undefined);
  assert.equal(standingPolicy({schema: 'standing-policy-view-v1', available: false, error: 'x'}), undefined);
  assert.match(policyReport({...p, inForce: undefined}).status, /No policy is in force/);
  assert.match(policyReport({...p, chain: 'standing-policy-history-gap'}).note!, /does not check out/);
  assert.throws(() => standingPolicy({...page('policy'), versions: [{version: 1, at: '~2026.11.17', issuer: '~zod', revoked: true, digest: '0x1', body: {}}]}));
});

test('a handoff document says what each memory is and what was left out', () => {
  const v = memoryView(page('memory-handoff')), doc = handoffDocument(v, '~zod');
  assert.equal(v.view, 'handoff'); assert.ok(v.packet!.bytes <= v.packet!.budget); assert.ok(v.agents.length > 0);
  assert.match(doc, /^# Handoff from ~zod/); assert.match(doc, /## What changed since ~/); assert.match(doc, /more did not fit and are not shown/);
  for (const m of v.packet!.items) assert.ok(doc.includes(`### ${m.name}`));
  assert.ok(!v.packet!.items.some(m => m.standing === 'unlabelled') || doc.includes('UNLABELLED (a model wrote this'));
  assert.throws(() => memoryView({...page('memory-handoff'), packet: {...(page('memory-handoff').packet as object), bytes: 99999}}));
  assert.throws(() => memoryView({schema: 'operator-memory-view-v1', error: 'owner-required'}));
  assert.deepEqual(memoryLabel({name: 'a.md', hash: '1a2b3c4d'}, 'question'), {kind: 'label', name: 'a.md', hash: '1a2b3c4d', standing: 'question'});
  assert.throws(() => memoryLabel({name: 'a.md', hash: '1a2b3c4d'}, 'ruling' as 'fact'));
  assert.deepEqual(memorySupersede('new.md', 'old.md', ' Replaced. '), {kind: 'supersede', new: 'new.md', old: 'old.md', reason: 'Replaced.'});
  assert.throws(() => memorySupersede('a.md', 'a.md', 'x')); assert.throws(() => memorySupersede('a.md', 'b.md', ' '));
  assert.deepEqual(memoryUnsupersede('new.md', 'old.md'), {kind: 'unsupersede', new: 'new.md', old: 'old.md'}); assert.throws(() => memoryUnsupersede('a.md', 'a.md'));
});
