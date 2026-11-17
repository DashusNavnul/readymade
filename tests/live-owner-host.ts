import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {joinProjectLink} from '../src/project-invitations-view';
import {sharedProjectLink} from '../src/remote-source-view';
import type {InvitationPage} from '../src/project-invitations';
import type {SharingView} from '../src/project-sharing';
import type {SessionSharingCommand, SessionSharingOutcome, SessionSharingSnapshot} from '../src/session-sharing';
import {dateAtomMillis} from '../src/editing-activity';
import {LiveFailure, LiveTimeout, acceptQuickInput, copied, errorInfo, invitationAction, liveRun, mergeHandoff, need, needShip, pasteQuickInput,
  readHandoff, seen, sleep, until, within, type LiveContext} from './live-ship-support';
import {ownerTasks, standingPolicy} from '../src/owner-pages';
import {collabNotices} from '../src/collab-pages';

// Live acceptance on the OWNER's own running ship. One phase per launch (READYMADE_LIVE_PHASE):
// invite | share | revoke | members | answer-suggestion | reviewer | import-suggestion | review | apply | share-session | share-session-limited | unshare-session | project-sharing (READYMADE_SETTING=on|off) | remove. Every write is the product
// screen's own single submission; an unknown outcome is recorded and fails the phase, and nothing is sent twice.

/** What an owner does first: connect coding to the ship already signed in, then choose the project. Reads only. */
async function ownProject(c: LiveContext): Promise<string> {
  const project = need('READYMADE_PROJECT');
  await c.timed('coding-connect', () => c.api.connect(c.origin), 120000);
  assert.equal(c.api.client, c.client); assert.equal(c.client.snapshot?.owner, c.ship);
  await c.timed('select-project', () => c.api.selectProject(project), 60000);
  assert.equal(c.api.project, project);
  return project;
}

async function invite(c: LiveContext): Promise<void> {
  const peer = needShip('READYMADE_PEER_SHIP'), handoff = need('READYMADE_HANDOFF');
  assert.notEqual(peer, c.ship); readHandoff(handoff, true); // Refuse an unusable handoff before any write.
  // READYMADE_INVITE_ROLE names another role: for a ship that is already a member that is a role offer, applied when it accepts the new link.
  const role = process.env.READYMADE_INVITE_ROLE ?? 'contributor'; assert.ok(role === 'contributor' || role === 'observer' || role === 'maintainer');
  const project = await ownProject(c); c.record.peer = peer; c.record.role = role;
  const accepted = await invitationAction(c, 'invite-member', async () => {await c.api.invitations.invite(peer, role);});
  const joinLink = await c.timed('copy-join-link', () => copied(() => c.api.invitations.copyLink(accepted.request)), 60000);
  const link = joinProjectLink(vscode.Uri.parse(joinLink, true), c.extension.id);
  assert.deepEqual({authority: link.authority, project: link.project, target: link.target}, {authority: c.ship, project, target: peer});
  c.record.joinLink = joinLink; c.record.invitation = link.invitation;
  c.mark('handoff'); mergeHandoff(handoff, {joinLink});
}

// The sharing screen keeps its observation, its rendered text and its confirmation dialog private. The
// dialog is modal and the editor test runner refuses modal dialogs, so it is the one piece of product code
// replaced here: the scripted version answers Confirm only to the exact text a user would be shown.
interface SharingInternals {
  confirm: (detail: string) => Thenable<boolean>; confirmRemoval: (detail: string) => Thenable<boolean>; held?: SharingView; text: string;
  sessions?: {peer: string; snapshot?: SessionSharingSnapshot; note?: string; last?: {command: SessionSharingCommand; outcome: SessionSharingOutcome}};
}
const internals = (c: LiveContext) => c.api.projectSharing as unknown as SharingInternals;
const sharingStatus = (c: LiveContext): string => /^Status: (.+)$/m.exec(internals(c).text)?.[1] ?? 'unreported';
function sharingRequest(c: LiveContext, peer: string): string | undefined {
  const rows = (c.api.projectSharing.rows()[0].children ?? []).filter(row => row.command?.command === 'readymade.recoverProjectAccess' && row.description === peer);
  if (rows.length > 1) throw new LiveFailure('several-retained-sharing-requests');
  const request: unknown = rows[0]?.command?.arguments?.[0];
  return typeof request === 'string' ? request : undefined;
}
async function observeSharing(c: LiveContext, peer: string, step: string): Promise<SharingView> {
  await c.timed(step, () => c.api.projectSharing.observe(peer), 30000);
  const held = internals(c).held, sessions = internals(c).sessions; assert.ok(held);
  c.record[step] = {rows: seen(c.api.projectSharing.rows()[0].children), member: held.member, baseDesk: held.baseDesk, workingDesk: held.workingDesk, grant: held.grant,
    ...(sessions?.peer === peer ? {sessionSharing: {note: sessions.note, ...sessions.snapshot}} : {})};
  return held;
}
/** Exactly one sharing submission, then read-only "Check sharing request" observations until it settles. */
async function changeSharing(c: LiveContext, peer: string, revoke: boolean, expected: string, prompts: (() => Promise<void>)[]): Promise<string> {
  const operation = revoke ? 'revoke' : 'grant'; let confirmations = 0, offered: string | undefined, settled = false, failed: unknown;
  internals(c).confirm = async detail => {confirmations++; offered = detail; return detail === expected;};
  c.mark(operation + '-submit');
  const changing = c.api.projectSharing.change(revoke);
  void changing.then(() => {settled = true;}, () => {settled = true;});
  try {
    for (const prompt of prompts) {if (settled) break; await prompt();}
    await within(changing, 60000, operation + '-submit');
  } catch (error) {
    failed = error;
    // An open prompt means nothing was confirmed. Dismiss it so the screen returns without submitting.
    if (error instanceof LiveTimeout) {await vscode.commands.executeCommand('workbench.action.closeQuickOpen'); await sleep(3000);}
  }
  const request = sharingRequest(c, peer), confirmed = confirmations === 1 && offered === expected;
  Object.assign(c.record, {scriptedConfirmation: true, confirmations, confirmationTextVerified: confirmed});
  if (!confirmed && offered !== undefined) c.record.confirmationOffered = String(offered).slice(0, 600);
  if (failed || !request) {
    // The journal retains the request before it is sent, so no retained request means nothing left this computer.
    const unknown = request !== undefined || confirmed && !settled;
    c.record.write = unknown ? 'unknown' : 'not-sent'; if (failed) c.record.writeError = errorInfo(failed, true);
    if (request) {
      c.record.request = request;
      try {await within(c.api.projectSharing.recover(request), 20000, operation + '-observe'); c.record.observedAfterUnknown = sharingStatus(c);}
      catch (error) {c.record.observedAfterUnknown = errorInfo(error, true);}
    }
    throw new LiveFailure(operation + (unknown ? '-outcome-unknown' : failed ? '-not-sent' : confirmations ? '-confirmation-text-mismatch' : '-prompts-not-driven'));
  }
  c.record.write = 'submitted'; c.record.request = request;
  let status = sharingStatus(c); c.observed('submit', status);
  for (let n = 0; n < 20 && status === 'unconfirmed'; n++) {
    c.mark(operation + '-observe-' + n); await sleep(1500);
    try {await within(c.api.projectSharing.recover(request), 20000, operation + '-observe');}
    catch (error) {c.observed('check', 'observation-unavailable', errorInfo(error).code); continue;}
    status = sharingStatus(c); c.observed('check', status);
  }
  c.record.status = status;
  if (status === 'unconfirmed' || status === 'unreported') throw new LiveFailure(operation + '-not-settled');
  return status;
}

async function share(c: LiveContext): Promise<void> {
  const peer = needShip('READYMADE_PEER_SHIP'), path = need('READYMADE_SHARE_PATH'), wanted = process.env.READYMADE_SHARE_DESK, handoff = need('READYMADE_HANDOFF');
  if (!/^\/(?:app|lib|ted)\/(?:[a-z0-9-]{1,63}\/){1,6}hoon$/.test(path)) throw new LiveFailure('invalid-READYMADE_SHARE_PATH');
  readHandoff(handoff, true);
  const project = await ownProject(c); c.record.peer = peer; c.record.path = path;
  const before = await observeSharing(c, peer, 'sharing-before');
  if (!before.member) throw new LiveFailure('peer-not-member');
  const desks = [...new Set([before.workingDesk, before.baseDesk].filter((desk): desk is string => desk !== null))], desk = wanted ?? desks[0];
  c.record.desksOffered = desks; c.record.desk = desk;
  if (!desks.includes(desk)) throw new LiveFailure('desk-not-offered');
  // The three real pickers, in the screen's order: desk, files, permission ("Read files" is listed first,
  // "Read and suggest changes" second; READYMADE_SHARE_PERMISSION=view-suggest chooses the second).
  const suggesting = process.env.READYMADE_SHARE_PERMISSION === 'view-suggest'; c.record.permission = suggesting ? 'view-suggest' : 'view';
  await changeSharing(c, peer, false,
    `Share with ${peer}\nProject: ${project}\nDesk: ${desk}\n${path}\n\n${suggesting ? 'Read and suggest changes' : 'Read files'}. Access lasts until revoked. Suggestions do not automatically apply changes.`,
    [() => acceptQuickInput(desks.indexOf(desk)), () => pasteQuickInput(path), () => acceptQuickInput(suggesting ? 1 : 0)]);
  const after = await observeSharing(c, peer, 'sharing-after');
  if (!after.grant || after.grant.revoked || !after.grant.view || after.grant.suggest !== suggesting || after.grant.desk !== desk || !after.grant.paths.includes(path)) throw new LiveFailure('grant-not-current');
  const text = await c.timed('copy-shared-project-link', () => copied(() => c.api.projectSharing.copyLink(c.extension.id)), 60000);
  const link = sharedProjectLink(vscode.Uri.parse(text, true), c.extension.id);
  assert.deepEqual({owner: link.owner, project: link.project, peer: link.peer, file: link.file}, {owner: c.ship, project, peer, file: undefined});
  c.record.sharedProjectLink = text; c.record.generation = link.generation;
  c.mark('handoff'); mergeHandoff(handoff, {sharedProjectLink: text});
}

async function revoke(c: LiveContext): Promise<void> {
  const peer = needShip('READYMADE_PEER_SHIP'), project = await ownProject(c); c.record.peer = peer;
  const before = await observeSharing(c, peer, 'sharing-before');
  if (!before.grant || before.grant.revoked) throw new LiveFailure('no-current-grant');
  c.record.generation = before.grant.generation;
  await changeSharing(c, peer, true, `Revoke ${peer}'s access to ${project}?`, []);
  const after = await observeSharing(c, peer, 'sharing-after');
  if (!after.grant?.revoked) throw new LiveFailure('grant-not-revoked');
}

/**
 * Each owner action through the real client, chosen so the ship must refuse it: nothing on the ship changes, and the
 * ship's own reason must come back in words. The handoff is a read. Two actions are skipped when their page is absent.
 */
async function nativeActions(c: LiveContext): Promise<void> {
  await ownProject(c);
  const native = c.api.native, said: Record<string, unknown> = {};
  c.record.actions = said;
  const policy = standingPolicy((await c.client.nativePage('/apps/pataphor-native/coding/policy.json')).value);
  if (policy?.inForce) said.policyUnchanged = await c.timed('policy-unchanged', () => native.setPolicy(policy.inForce!), 30000);
  const notices = collabNotices((await c.client.nativePage('/apps/readymade-collab/notices')).value, c.ship);
  const delivered = notices?.outbox.find(n => n.status === 'delivered');
  if (delivered) said.retryDelivered = await c.timed('retry-delivered', () => native.retry(delivered.id), 30000);
  const tasks = ownerTasks((await c.client.nativePage('/apps/pataphor-native/coding/tasks')).value);
  const answered = tasks?.questions.find(q => !q.open);
  if (answered) said.answerAgain = await c.timed('answer-again', () => native.answer(answered.id, 'Live check: a second answer must be refused.'), 30000);
  said.answerMissing = await c.timed('answer-missing', () => native.answer('0x1', 'Live check: no such question.'), 30000);
  // Revoking the policy in force, only when asked (READYMADE_REVOKE_POLICY=1): used to put a test project back as it was.
  if (process.env.READYMADE_REVOKE_POLICY === '1') {
    said.revoked = await c.timed('revoke-policy', () => native.revokePolicy(), 30000);
    assert.equal(said.revoked, 'Revoked. No policy is in force.');
    await sleep(3000);
    const after = standingPolicy((await c.client.nativePage('/apps/pataphor-native/coding/policy.json')).value);
    said.afterRevoke = {inForce: !!after?.inForce, versions: after?.versions.length, chain: after?.chain}; assert.equal(after?.inForce, undefined);
    said.revokedAgain = await c.timed('revoke-policy-again', () => native.revokePolicy(), 30000);
    assert.match(String(said.revokedAgain), /^Refused by the ship: standing policy not in force\./);
  }
  // Dismissing one queued request named by READYMADE_DISMISS_WORK (a request created by these checks, never a person's).
  const stuck = process.env.READYMADE_DISMISS_WORK;
  if (stuck) {
    said.dismissed = await c.timed('dismiss-work', () => native.dismiss(stuck), 30000);
    assert.equal(said.dismissed, 'Dismissed. Its requester is told, and nothing runs.');
    said.dismissedAgain = await c.timed('dismiss-work-again', () => native.dismiss(stuck), 30000);
    assert.match(String(said.dismissedAgain), /^Refused by the ship: work request started\./);
  }
  // One success, on a question created for this check (READYMADE_TEST_QUESTION): answered once, then closed on the ship.
  const mine = process.env.READYMADE_TEST_QUESTION;
  if (mine) {
    assert.ok(tasks?.questions.some(q => q.id === mine && q.open && q.task.startsWith('live-check-')), 'the test question must be open and a live-check task');
    said.answered = await c.timed('answer-test-question', () => native.answer(mine, 'Yes. Answered from the Readymade window by the live check.'), 30000);
    assert.equal(said.answered, 'Your answer is stored. The task can be claimed again.');
    await sleep(3000);
    const after = ownerTasks((await c.client.nativePage('/apps/pataphor-native/coding/tasks')).value)?.questions.find(q => q.id === mine);
    said.afterAnswer = after && {open: after.open, answer: after.answer}; assert.equal(after?.open, false);
    said.answeredTwice = await c.timed('answer-test-question-again', () => native.answer(mine, 'A second answer.'), 30000);
    assert.match(String(said.answeredTwice), /^Refused by the ship: question answered\. .+ Nothing changed\.$/);
  }
  said.labelStale = await c.timed('label-stale', () => native.label({name: 'MEMORY.md', hash: '00000000'}, 'fact'), 30000);
  said.unsupersedeNone = await c.timed('unsupersede-none', () => native.unsupersede('MEMORY.md', 'easil.md'), 30000);
  // A proposal that is already closed cannot be closed again; one the ship does not hold is named as missing.
  const shut = tasks?.proposals.find(p => p.closed);
  if (shut) {said.dismissClosed = await c.timed('dismiss-closed-proposal', () => native.dismissProposal(shut.id), 30000); assert.match(String(said.dismissClosed), /^Refused by the ship: proposal closed\./);}
  said.dismissMissing = await c.timed('dismiss-missing-proposal', () => native.dismissProposal('0x1'), 30000);
  const doc = await c.timed('handoff', () => native.handoffText('claude', need('READYMADE_PROJECT')), 45000);
  said.handoff = {chars: doc.length, title: doc.split('\n')[0], sections: doc.split('\n').filter(l => l.startsWith('## ')).map(l => l.slice(0, 60))};
  for (const key of ['policyUnchanged', 'retryDelivered', 'answerAgain', 'answerMissing', 'labelStale', 'unsupersedeNone', 'dismissMissing']) {
    if (said[key] !== undefined) assert.match(String(said[key]), /^Refused by the ship: .+\. Nothing changed\.$/, key);
  }
  assert.match(doc, /^# Handoff from ~/);
}

/** Opens every native screen through its real command and records what each one showed. Read-only. */
async function nativeScreens(c: LiveContext): Promise<void> {
  await ownProject(c);
  const screens: [string, () => {shown?: {status: string; sections: readonly {title: string; lines: readonly unknown[]}[]}}][] = [
    ['overview', () => c.api.native.overview], ['tasksAndQuestions', () => c.api.native.tasks], ['notices', () => c.api.native.notices],
    ['suggestionHistory', () => c.api.native.history], ['workRequests', () => c.api.native.work], ['sessionRoles', () => c.api.native.roles],
    ['standingPolicy', () => c.api.native.policy], ['presenceBoard', () => c.api.native.board]];
  const seen: Record<string, unknown> = {};
  for (const [command, panel] of screens) {
    await c.timed('screen-' + command, async () => {
      await vscode.commands.executeCommand('readymade.' + command);
      await until(() => !!panel().shown && panel().shown!.status !== 'Reading the ship…', 30000);
    }, 45000);
    const shown = panel().shown!;
    assert.ok(shown.sections.length > 0, `${command} showed no sections: ${shown.status}`);
    seen[command] = {status: shown.status.slice(0, 160), sections: shown.sections.map(s => `${s.title}: ${s.lines.length}`)};
    c.observed(command, 'shown');
  }
  const rows = c.api.native.rows(), overview = rows.find(row => row.id === 'native-overview'), pages = rows.find(row => row.id === 'native-pages');
  assert.ok(overview && pages);
  seen.treeRow = `${overview.label}: ${overview.description}, ${overview.children?.length ?? 0} blockers as problems`;
  seen.shipGroup = (pages.children ?? []).map(row => row.description ? `${row.label} (${row.description})` : row.label);
  assert.ok((pages.children ?? []).every(row => row.command?.command.startsWith('readymade.')));
  const registered = new Set(await vscode.commands.getCommands(true));
  for (const row of pages.children ?? []) assert.ok(registered.has(row.command!.command), `${row.command!.command} is not registered`);
  c.record.screens = seen;
}

async function members(c: LiveContext): Promise<void> {
  const project = await ownProject(c), view = c.api.invitations as unknown as {page?: InvitationPage}, rows: {ship: string; role: string}[] = [];
  for (let n = 0; n < 8; n++) {
    await c.timed('members-page-' + n, () => c.api.invitations.observe('members', n > 0), 30000);
    const page = view.page; assert.ok(page && page.kind === 'members' && page.project === project && page.authority === c.ship);
    for (const row of page.rows) if ('ship' in row) rows.push({ship: row.ship, role: row.role});
    if (page.next !== null) continue;
    assert.equal(rows.length, page.total);
    c.record.members = rows; c.record.total = page.total;
    if (process.env.READYMADE_PEER_SHIP) c.record.peerIsMember = rows.some(row => row.ship === process.env.READYMADE_PEER_SHIP);
    return;
  }
  throw new LiveFailure('members-exceed-bounded-read');
}

/** Chooses the collaborator through the screen and returns their agent-session standing as that read showed it. */
async function standing(c: LiveContext, peer: string, step: string): Promise<SessionSharingSnapshot> {
  await observeSharing(c, peer, step);
  const sessions = internals(c).sessions;
  if (sessions?.peer !== peer || !sessions.snapshot) throw new LiveFailure('session-standing-unavailable');
  return sessions.snapshot;
}
/**
 * One session-sharing command through the screen, which sends it once and then only reads. The ship keeps no
 * journal for these, so the receipt records how the screen settled it and then the standing a fresh read shows.
 * `maySend` is false only while it is certain that nothing left this computer.
 */
async function sessionCommand(c: LiveContext, peer: string, operation: SessionSharingCommand['operation'], act: () => Promise<void>, maySend: () => boolean = () => true): Promise<SessionSharingSnapshot> {
  let failed: unknown, after: SessionSharingSnapshot | undefined;
  try {await c.timed(operation + '-submit', act, 90000);} catch (error) {failed = error;}
  const last = internals(c).sessions?.last, outcome = last?.command.operation === operation && last.command.peer === peer ? last.outcome : undefined;
  c.record.note = internals(c).sessions?.note;
  if (outcome) {
    c.record.outcome = outcome.status === 'refused' ? {status: outcome.status, reason: outcome.reason} : {status: outcome.status, holds: outcome.holds};
    c.observed('settle', outcome.status, outcome.status === 'refused' ? outcome.reason : undefined);
  }
  c.record.write = outcome ? outcome.status === 'refused' ? 'refused' : outcome.status === 'unknown' ? 'unknown' : 'submitted' : failed && maySend() ? 'unknown' : 'not-sent';
  if (failed) c.record.writeError = errorInfo(failed, true);
  let failure: LiveFailure | undefined;
  if (c.record.write !== 'submitted') failure = new LiveFailure(operation + (c.record.write === 'unknown' ? '-outcome-unknown' : c.record.write === 'refused' ? '-refused' : '-not-sent'));
  // Read the standing again either way: after an unknown or refused command it is evidence, never a retry.
  try {after = await standing(c, peer, 'sharing-after');} catch (error) {failure ??= error instanceof LiveFailure ? error : new LiveFailure('session-standing-unavailable');}
  if (failure || !after) throw failure ?? new LiveFailure('session-standing-unavailable');
  return after;
}

async function sessionChange(c: LiveContext, operation: 'share' | 'unshare'): Promise<void> {
  const peer = needShip('READYMADE_PEER_SHIP'), session = need('READYMADE_SESSION'), shared = operation === 'share';
  if (!/^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(session)) throw new LiveFailure('invalid-READYMADE_SESSION');
  await ownProject(c); c.record.peer = peer; c.record.session = session;
  const before = await standing(c, peer, 'sharing-before'), row = before.sessions.find(row => row.id === session);
  if (!row) throw new LiveFailure('session-not-listed');
  if (row.shared === shared) throw new LiveFailure('requested-state-already-holds');
  // The tree must offer exactly this action for this session, carrying the full id.
  const command = shared ? 'readymade.shareSession' : 'readymade.unshareSession';
  const offered = (c.api.projectSharing.rows()[0].children ?? []).some(item => item.children?.some(action => action.command?.command === command && action.command.arguments?.[0] === session));
  c.record.offeredInTree = offered;
  if (!offered) throw new LiveFailure(operation + '-not-offered');
  const after = await sessionCommand(c, peer, operation, () => c.api.projectSharing.sessionSharing(operation, session));
  if (after.sessions.find(row => row.id === session)?.shared !== shared) throw new LiveFailure(shared ? 'session-not-shared' : 'session-still-shared');
}

/**
 * A share with a time limit, through the screen: the tree offers it for this session, the one list (how long) is
 * answered with its first entry, and the standing a fresh read shows then names the moment the share ends.
 */
async function sessionLimit(c: LiveContext): Promise<void> {
  const peer = needShip('READYMADE_PEER_SHIP'), session = need('READYMADE_SESSION');
  if (!/^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(session)) throw new LiveFailure('invalid-READYMADE_SESSION');
  await ownProject(c); c.record.peer = peer; c.record.session = session;
  const before = await standing(c, peer, 'sharing-before');
  if (!before.sessions.some(row => row.id === session)) throw new LiveFailure('session-not-listed');
  c.record.timeLimits = before.timeLimits;
  if (!before.timeLimits) throw new LiveFailure('ship-keeps-no-time-limits');
  const offered = (c.api.projectSharing.rows()[0].children ?? []).some(item => item.children?.some(action => action.command?.command === 'readymade.shareSessionUntil' && action.command.arguments?.[0] === session));
  c.record.offeredInTree = offered;
  if (!offered) throw new LiveFailure('share-until-not-offered');
  const started = Date.now();
  const after = await sessionCommand(c, peer, 'share-until', async () => {
    const sharing = c.api.projectSharing.sessionSharing('share-until', session);
    void sharing.then(() => {}, () => {});
    await acceptQuickInput(); // "How long…": the first entry, one hour.
    await sharing;
  });
  const row = after.sessions.find(row => row.id === session); c.record.until = row?.until ?? null;
  if (!row?.shared || !row.until) throw new LiveFailure('share-has-no-limit');
  const ahead = dateAtomMillis(row.until) - started; c.record.limitMinutesAhead = Math.round(ahead / 60000);
  if (ahead < 59 * 60000 || ahead > 62 * 60000) throw new LiveFailure('limit-is-not-one-hour');
  const shown = (c.api.projectSharing.rows()[0].children ?? []).find(item => item.children?.some(action => action.command?.arguments?.[0] === session));
  c.record.rowShows = shown?.description;
  if (!/shared until /.test(String(shown?.description))) throw new LiveFailure('row-does-not-show-the-limit');
}

/**
 * The owner reads its inbox, finds the suggestion the collaborator's phase sent (its request id is in the
 * handoff), and tells the collaborator what became of it (READYMADE_ANSWER=taken|declined) from the row's own action.
 */
async function answerSuggestion(c: LiveContext): Promise<void> {
  const peer = needShip('READYMADE_PEER_SHIP'), answer = need('READYMADE_ANSWER'), request = readHandoff(need('READYMADE_HANDOFF')).suggestionRequest;
  if (answer !== 'taken' && answer !== 'declined') throw new LiveFailure('invalid-READYMADE_ANSWER');
  if (!request) throw new LiveFailure('handoff-without-suggestion');
  await ownProject(c); c.record.peer = peer; c.record.request = request;
  await c.timed('read-inbox', () => c.api.inbox.observe(), 60000);
  const receipts = c.api.inbox.receipts ?? [], row = receipts.find(row => row.request === request && row.peer === peer);
  c.record.inbox = receipts.map(row => ({peer: row.peer, path: row.path, request: row.request})).slice(0, 8); c.record.waitingBefore = c.api.inbox.waiting;
  if (!row) throw new LiveFailure('suggestion-not-in-inbox');
  c.record.path = row.path;
  const tree = () => (c.api.inbox.rows()[0].children ?? []).find(item => item.children?.some(action => action.command?.arguments?.[0] === row.receiptHash));
  const offered = tree()?.children?.find(action => action.command?.command === 'readymade.answerInboxSuggestion' && action.command.arguments?.[1] === answer);
  c.record.offeredInTree = offered?.label;
  if (!offered) throw new LiveFailure('answer-not-offered');
  c.mark('answer-submit');
  try {await c.timed('answer', () => c.api.inbox.answer(row.receiptHash, answer), 60000); c.record.write = 'submitted';}
  catch (error) {c.record.write = 'unknown'; c.record.writeError = errorInfo(error, true); throw new LiveFailure('answer-not-sent');}
  c.record.rowAfter = tree()?.description; c.record.waitingAfter = c.api.inbox.waiting;
  if (!String(tree()?.description).includes(answer === 'taken' ? 'told: taken' : 'told: not taken')) throw new LiveFailure('row-does-not-show-the-answer');
}

// ===== taking a collaborator's suggestion: reviewer, import, review, apply (goal step 43) =====
// The candidate screen and the reviewer screen keep their modal confirmations private, like the sharing screen; the
// scripted stand-ins below answer Confirm once, and only to text naming the project and the effect a user would read.
interface ConfirmInternals {confirm: (detail: string) => Thenable<boolean>; confirmApply?: (detail: string) => Thenable<boolean>}
const confirmations = (c: LiveContext, view: object, slot: 'confirm' | 'confirmApply', wanted: (detail: string) => boolean) => {
  let count = 0, accepted = false;
  (view as ConfirmInternals)[slot] = async detail => {
    count++; accepted = count === 1 && wanted(detail);
    Object.assign(c.record, {scriptedConfirmation: true, confirmations: count, confirmationOffered: detail.slice(0, 600), confirmationTextVerified: accepted});
    return accepted;
  };
  return () => accepted;
};
const sessionOf = (): string => {
  const session = need('READYMADE_SESSION');
  if (!/^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(session)) throw new LiveFailure('invalid-READYMADE_SESSION');
  return session;
};

/** The owner chooses the project's reviewer (READYMADE_REVIEWER, a provider key) through the reviewer screen, once. */
async function reviewer(c: LiveContext): Promise<void> {
  const key = need('READYMADE_REVIEWER'), session = sessionOf(), project = await ownProject(c); c.record.reviewer = key; c.record.session = session;
  await c.timed('observe-reviewer', () => c.api.reviewPolicy.observe(session), 60000);
  const held = (c.api.reviewPolicy as unknown as {held?: {policy: {scope?: {model?: string; enabled?: boolean; generation?: string}; providers: {key: string}[]}}}).held;
  c.record.before = held?.policy.scope ?? null; c.record.providers = held?.policy.providers.map(p => p.key);
  if (!held?.policy.providers.some(p => p.key === key)) throw new LiveFailure('reviewer-not-offered');
  const accepted = confirmations(c, c.api.reviewPolicy, 'confirm', detail => detail.includes(project) && detail.includes(`Reviewer ${key}`) && /can apply code changes/.test(detail));
  c.mark('reviewer-submit');
  try {await c.timed('configure-reviewer', () => c.api.reviewPolicy.configure(false, key), 90000); c.record.write = 'submitted';}
  catch (error) {c.record.write = accepted() ? 'unknown' : 'not-sent'; c.record.writeError = errorInfo(error, true); throw new LiveFailure('reviewer-' + c.record.write);}
  await c.timed('observe-reviewer-after', () => c.api.reviewPolicy.observe(session), 60000);
  const after = (c.api.reviewPolicy as unknown as {held?: {policy: {scope?: {enabled?: boolean; generation?: string}}}}).held?.policy.scope;
  c.record.after = after ?? null;
  if (!after?.enabled) throw new LiveFailure('review-not-enabled');
}

/**
 * The owner reads the inbox, imports the collaborator's suggestion (request id from the handoff) as its own local
 * draft with the row's own action, and prepares one candidate from that draft. The candidate id goes to the handoff.
 */
async function importSuggestion(c: LiveContext): Promise<void> {
  const peer = needShip('READYMADE_PEER_SHIP'), handoff = need('READYMADE_HANDOFF'), request = readHandoff(handoff).suggestionRequest, session = sessionOf();
  if (!request) throw new LiveFailure('handoff-without-suggestion');
  const project = await ownProject(c); c.record.peer = peer; c.record.request = request; c.record.session = session;
  await c.timed('read-inbox', () => c.api.inbox.observe(), 60000);
  const row = (c.api.inbox.receipts ?? []).find(row => row.request === request && row.peer === peer);
  if (!row) throw new LiveFailure('suggestion-not-in-inbox');
  c.record.path = row.path; c.record.basis = `${row.desk} revision ${row.revision}`;
  const offered = (c.api.inbox.rows()[0].children ?? []).find(item => item.children?.some(action => action.command?.arguments?.[0] === row.receiptHash))
    ?.children?.find(action => action.command?.command === 'readymade.importInboxSuggestion');
  c.record.offeredInTree = offered?.label;
  if (!offered) throw new LiveFailure('import-not-offered');
  const before = new Set(c.api.drafts.list().map(d => d.uri));
  // Several of the owner's tasks can sit on the suggestion's revision (a task's source moves on when its change lands). The product
  // then asks which task takes it; answer as a person would: type the intended task's id into the real picker and accept.
  const tasks = (await c.timed('read-tasks', () => c.api.client!.codingState(), 60000)).sessions.filter(task => {
    const source = task.source as {desk?: unknown; number?: unknown} | null;
    return task.project === project && !!source && source.desk === row.desk && Number.isSafeInteger(source.number) && BigInt(source.number as number) === BigInt(row.revision.replaceAll('.', ''));
  }).length;
  c.record.tasksOnThisRevision = tasks;
  const importing = c.api.inbox.import(row.receiptHash); importing.catch(() => undefined);
  if (tasks > 1) {await sleep(4000); await pasteQuickInput('Session ' + session);}
  await c.timed('import', () => importing, 180000);
  const draft = c.api.drafts.list().find(d => !before.has(d.uri) && d.snapshot.session === session);
  if (!draft) throw new LiveFailure('import-made-no-draft');
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.uri.toString() !== draft.uri) throw new LiveFailure('draft-not-opened');
  c.record.draftChanged = draft.text !== draft.snapshot.text; c.record.draftBytes = Buffer.byteLength(draft.text);
  if (!c.record.draftChanged) throw new LiveFailure('draft-has-no-change');
  c.mark('candidate-submit');
  try {await c.timed('prepare-candidate', async () => {await vscode.commands.executeCommand('readymade.prepareCandidate');}, 90000);}
  catch (error) {c.record.prepareError = errorInfo(error, true);}
  let pending = c.api.drafts.get(draft.uri).pending;
  for (let n = 0; n < 40 && pending?.phase !== 'candidate' && pending?.phase !== 'refused'; n++) {
    await sleep(3000);
    try {await c.timed('refresh-' + n, () => c.api.refresh(session), 60000);} catch (error) {c.observed('refresh', 'unavailable', errorInfo(error).code);}
    pending = c.api.drafts.get(draft.uri).pending; c.observed('candidate', pending?.phase ?? 'none');
  }
  c.record.write = pending ? pending.phase === 'issued' ? 'not-sent' : 'submitted' : 'not-sent';
  c.record.candidatePhase = pending?.phase ?? null; c.record.candidate = pending?.candidate ?? null;
  if (pending?.phase !== 'candidate' || !pending.candidate) throw new LiveFailure('candidate-not-prepared');
  c.mark('handoff'); mergeHandoff(handoff, {candidate: pending.candidate, candidateSession: session});
}

/**
 * Goal items 23-24: the owner imports one WHOLE multi-file suggestion (READYMADE_BUNDLE_RECEIPT, or the newest one on the
 * session's revision) into one draft with the row's own action, then prepares one candidate for every file with the
 * draft row's own action. The candidate id goes to the handoff for the existing review phase. Nothing is sent twice.
 */
async function importBundle(c: LiveContext): Promise<void> {
  const session = sessionOf(), handoff = need('READYMADE_HANDOFF'), project = await ownProject(c); c.record.session = session;
  const task = (await c.timed('read-tasks', () => c.api.client!.codingState(session), 60000)).sessions.find(t => t.id === session);
  const source = task?.source as {desk?: string; number?: number} | undefined;
  if (task?.project !== project || !source?.desk || !Number.isSafeInteger(source.number)) throw new LiveFailure('session-not-in-project');
  c.record.sessionRevision = `${source.desk} revision ${source.number}`;
  await c.timed('read-inbox', () => c.api.inbox.observe(), 60000);
  const bundles = (c.api.inbox.rows()[0].children ?? []).filter(row => row.children?.[0]?.command?.command === 'readymade.importInboxBundle');
  c.record.bundlesShown = bundles.length;
  const wanted = process.env.READYMADE_BUNDLE_RECEIPT;
  const row = bundles.find(r => wanted ? r.children![0].command!.arguments![0] === wanted : String(r.tooltip).startsWith(`${source.desk} · revision ${source.number}\n`));
  if (!row) throw new LiveFailure('no-bundle-on-this-revision');
  const receipt = String(row.children![0].command!.arguments![0]); c.record.receipt = receipt; c.record.peer = row.description; c.record.files = row.label;
  const before = new Set(c.api.drafts.listBundles().map(d => d.id));
  const tasks = (await c.api.client!.codingState()).sessions.filter(t => {
    const s = t.source as {desk?: unknown; number?: unknown} | null;
    return t.project === project && !!s && s.desk === source.desk && s.number === source.number;
  }).length;
  c.record.tasksOnThisRevision = tasks;
  const importing = c.api.inbox.importBundle(receipt); importing.catch(() => undefined);
  if (tasks > 1) {await sleep(4000); await pasteQuickInput('Session ' + session);}
  await c.timed('import-bundle', () => importing, 240000);
  const draft = c.api.drafts.listBundles().find(d => !before.has(d.id));
  if (!draft) throw new LiveFailure('import-made-no-draft');
  c.record.draft = {id: draft.id, files: draft.files.map(f => f.snapshot.path), origin: draft.receipt.peer, receipt: draft.receipt.receiptHash,
    changed: draft.files.map(f => f.text !== f.snapshot.text)};
  const shown = (c.api.inbox.rows()[0].children ?? []).find(r => r.label === 'Imported Multi-File Drafts')?.children?.find(r => r.tooltip?.includes(receipt));
  c.record.originShown = shown?.description;
  if (shown?.description !== `from ${draft.receipt.peer}`) throw new LiveFailure('origin-not-shown');
  const prepare = shown.children?.find(r => r.command?.command === 'readymade.prepareBundleCandidate');
  if (!prepare) throw new LiveFailure('prepare-not-offered');
  c.mark('candidate-submit');
  try {await c.timed('prepare-candidate', async () => {await vscode.commands.executeCommand('readymade.prepareBundleCandidate', draft.id);}, 120000);}
  catch (error) {c.record.prepareError = errorInfo(error, true);}
  let pending = c.api.drafts.getBundle(draft.id).pending;
  for (let n = 0; n < 40 && pending?.phase !== 'candidate' && pending?.phase !== 'refused'; n++) {
    await sleep(3000);
    try {await c.timed('refresh-' + n, () => c.api.refresh(session), 60000);} catch (error) {c.observed('refresh', 'unavailable', errorInfo(error).code);}
    pending = c.api.drafts.getBundle(draft.id).pending; c.observed('candidate', pending?.phase ?? 'none');
  }
  c.record.write = pending ? pending.phase === 'issued' ? 'not-sent' : 'submitted' : 'not-sent';
  c.record.candidatePhase = pending?.phase ?? null; c.record.candidate = pending?.candidate ?? null; c.record.candidateReason = pending?.reason ?? null;
  if (pending?.phase !== 'candidate' || !pending.candidate) throw new LiveFailure('candidate-not-prepared');
  c.mark('handoff'); mergeHandoff(handoff, {candidate: pending.candidate, candidateSession: session});
}

/** Goal item 25, read-only: compare one suggestion (READYMADE_BUNDLE_RECEIPT, hot or archived) with the owner's current files. */
async function compareBundle(c: LiveContext): Promise<void> {
  const receipt = need('READYMADE_BUNDLE_RECEIPT'); await ownProject(c); c.record.receipt = receipt;
  await c.timed('read-inbox', () => c.api.inbox.observe(), 60000);
  await c.timed('read-history', () => c.api.inbox.observeHistory(), 60000);
  const find = () => [...(c.api.inbox.rows()[0].children ?? []), ...((c.api.inbox.rows()[0].children ?? []).find(r => r.label === 'History')?.children ?? [])]
    .find(r => r.children?.some(a => a.command?.command === 'readymade.compareInboxBundle' && a.command.arguments?.[0] === receipt));
  if (!find()) throw new LiveFailure('bundle-not-listed');
  const tabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input instanceof vscode.TabInputTextDiff).map(t => t.label);
  const before = tabs().length;
  await c.timed('compare', () => c.api.inbox.compareBundle(receipt), 180000);
  c.record.summary = find()?.children?.find(a => a.command?.command === 'readymade.compareInboxBundle')?.description;
  c.record.diffTabs = tabs().slice(before); c.record.write = 'none';
  if (!c.record.summary) throw new LiveFailure('no-comparison-shown');
  if (process.env.READYMADE_RESOLVE === 'mine') {
    // Goal item 26: keep the owner's version of every moved file, take the suggestion for the rest; local drafts only.
    const compareRow = () => find()?.children?.find(a => a.command?.command === 'readymade.compareInboxBundle');
    for (const row of compareRow()?.children ?? []) if (row.description === 'changed since suggested: choose') c.api.inbox.chooseBundleFile(receipt, String(row.label), 'mine');
    c.record.choices = (compareRow()?.children ?? []).map(r => [r.label, r.description]);
    const before = new Set(c.api.drafts.list().map(d => d.uri));
    c.api.inbox.resolveBundle(receipt);
    c.record.drafts = c.api.drafts.list().filter(d => !before.has(d.uri)).map(d => ({path: d.snapshot.path, revision: d.snapshot.source.number, changed: d.text !== d.snapshot.text}));
  }
}

/** Reads the candidate until the ship's own checks settle it: stage 'review' with a pending decision, or a refusal. */
async function settledCandidate(c: LiveContext, session: string, id: string, until: (cand: {stage: string; decision: string; landed?: unknown}) => boolean, reads: number, gap: number) {
  for (let n = 0; ; n++) {
    try {await c.timed('observe-' + n, () => c.api.codeReview.observe(session), 60000);} catch (error) {c.observed('observe', 'unavailable', errorInfo(error).code);}
    const held = (c.api.codeReview as unknown as {held?: {candidates: {id: string; stage: string; decision: string; landed?: unknown}[]; review?: {campaigns: {candidate: string; pending?: boolean; outcome?: string; reason?: string; mode?: string}[]}}}).held;
    const cand = held?.candidates.find(row => row.id === id), campaign = held?.review?.campaigns.find(row => row.candidate === id);
    c.observed('candidate', cand ? `${cand.stage}/${cand.decision}` : 'missing', campaign ? (campaign.reason || campaign.outcome || (campaign.pending ? 'waiting for ' + campaign.mode : campaign.mode)) : undefined);
    if (cand && until(cand) || n + 1 >= reads) return {cand, campaign};
    await sleep(gap);
  }
}

/** Reads until the checks settle, starts the governed review once unless the ship already opened one for this candidate
 * (a project with an enabled review scope does that itself when the checks pass), then reads until the reviewer decides. */
async function review(c: LiveContext): Promise<void> {
  const handoff = readHandoff(need('READYMADE_HANDOFF')), id = handoff.candidate, session = handoff.candidateSession;
  if (!id || !session) throw new LiveFailure('handoff-without-candidate');
  const project = await ownProject(c); c.record.candidate = id; c.record.session = session;
  const checked = await settledCandidate(c, session, id, cand => cand.stage === 'review' || cand.stage === 'refused', 40, 5000);
  c.record.checked = checked.cand ? `${checked.cand.stage}/${checked.cand.decision}` : null;
  if (checked.cand?.stage !== 'review' || checked.cand.decision !== 'pending') throw new LiveFailure('candidate-not-ready-for-review');
  const offered = (c.api.codeReview.rows()[0].children ?? []).some(row => row.command?.command === 'readymade.startCodeReview' && row.command.arguments?.[0] === id);
  c.record.offeredInTree = offered; c.record.startedByShip = !!checked.campaign;
  if (checked.campaign) {
    if (offered) throw new LiveFailure('review-offered-twice');
    c.record.write = 'not-needed';
  } else {
    if (!offered) throw new LiveFailure('review-not-offered');
    const accepted = confirmations(c, c.api.codeReview, 'confirm', detail => detail.includes(project) && detail.includes(id) && /A passing native decision can apply/.test(detail));
    c.mark('review-submit');
    try {await c.timed('start-review', () => c.api.codeReview.start(id), 120000); c.record.write = 'submitted';}
    catch (error) {c.record.write = accepted() ? 'unknown' : 'not-sent'; c.record.writeError = errorInfo(error, true); throw new LiveFailure('review-' + c.record.write);}
  }
  // The reviewer is a model run by the owner's ship: allow up to fifteen minutes (READYMADE_REVIEW_WAIT_MINUTES shortens the
  // wait so one launch stays inside the ten-minute cap; a later read-only inspect-change reads the decision), every fifteen seconds.
  const minutes = Number(process.env.READYMADE_REVIEW_WAIT_MINUTES ?? 15);
  const decided = await settledCandidate(c, session, id, cand => cand.decision !== 'pending' || cand.stage === 'refused', Math.max(1, Math.min(60, Math.round(minutes * 4))), 15000);
  c.record.decision = decided.cand ? `${decided.cand.stage}/${decided.cand.decision}` : null; c.record.campaign = decided.campaign ?? null;
  if (decided.cand?.decision !== 'approve') throw new LiveFailure(decided.cand?.decision === 'pending' ? 'review-not-decided' : 'review-did-not-approve');
}

/** The owner applies the approved candidate once and reads until the ship reports it landed. */
async function apply(c: LiveContext): Promise<void> {
  const handoff = readHandoff(need('READYMADE_HANDOFF')), id = handoff.candidate, session = handoff.candidateSession;
  if (!id || !session) throw new LiveFailure('handoff-without-candidate');
  const project = await ownProject(c); c.record.candidate = id; c.record.session = session;
  const before = await settledCandidate(c, session, id, () => true, 1, 0);
  c.record.before = before.cand ? `${before.cand.stage}/${before.cand.decision}` : null;
  const offered = (c.api.codeReview.rows()[0].children ?? []).some(row => row.command?.command === 'readymade.applyCandidate' && row.command.arguments?.[0] === id);
  c.record.offeredInTree = offered;
  if (!offered) throw new LiveFailure('apply-not-offered');
  const accepted = confirmations(c, c.api.codeReview, 'confirmApply', detail => detail.includes(project) && /Apply the reviewed source to the working project/.test(detail));
  c.mark('apply-submit');
  try {await c.timed('apply', () => c.api.codeReview.apply(id), 180000); c.record.write = 'submitted';}
  catch (error) {c.record.write = accepted() ? 'unknown' : 'not-sent'; c.record.writeError = errorInfo(error, true);}
  const landed = await settledCandidate(c, session, id, cand => !!cand.landed || cand.stage === 'refused', 24, 5000);
  c.record.after = landed.cand ? `${landed.cand.stage}/${landed.cand.decision}` : null; c.record.landed = landed.cand?.landed ?? null;
  if (!landed.cand?.landed) throw new LiveFailure(c.record.write === 'submitted' ? 'not-landed' : 'apply-' + c.record.write);
}

async function projectSetting(c: LiveContext): Promise<void> {
  const peer = needShip('READYMADE_PEER_SHIP'), setting = need('READYMADE_SETTING'), project = await ownProject(c);
  if (setting !== 'on' && setting !== 'off') throw new LiveFailure('invalid-READYMADE_SETTING');
  c.record.peer = peer; c.record.setting = setting;
  const before = await standing(c, peer, 'sharing-before');
  c.record.sharedBefore = before.sessions.filter(row => row.shared).map(row => row.id);
  if (before.sessionSharing === setting) throw new LiveFailure('requested-state-already-holds');
  const offered = (c.api.projectSharing.rows()[0].children ?? []).some(item => item.children?.some(action => action.command?.command === 'readymade.projectSessionSharing' && action.command.arguments?.[0] === setting));
  c.record.offeredInTree = offered;
  if (!offered) throw new LiveFailure('project-sharing-not-offered');
  // Scripted stand-in for the modal dialog: Confirm only to text naming the project and the policy change.
  let accepted = false, confirmations = 0;
  internals(c).confirm = async detail => {
    confirmations++; accepted = confirmations === 1 && detail.includes(project) && detail.includes('inspect') && (setting === 'on' ? /Allow agent sessions/.test(detail) : /Stop all session sharing/.test(detail));
    Object.assign(c.record, {scriptedConfirmation: true, confirmations, confirmationOffered: detail.slice(0, 600), confirmationTextVerified: accepted});
    return accepted;
  };
  const after = await sessionCommand(c, peer, setting === 'on' ? 'sharing-on' : 'sharing-off', () => c.api.projectSharing.projectSessionSharing(setting === 'on'), () => accepted);
  c.record.sharedAfter = after.sessions.filter(row => row.shared).map(row => row.id);
  if (after.sessionSharing !== setting) throw new LiveFailure('project-setting-not-changed');
  if (setting === 'off' && (after.inspectable || after.sessions.some(row => row.shared))) throw new LiveFailure('sharing-still-live-after-off');
}

async function remove(c: LiveContext): Promise<void> {
  const peer = needShip('READYMADE_PEER_SHIP'), project = await ownProject(c); c.record.peer = peer;
  await standing(c, peer, 'sharing-before');
  const offered = (c.api.projectSharing.rows()[0].children ?? []).some(row => row.command?.command === 'readymade.removeCollaborator' && row.label === `Remove ${peer} from this project…`);
  c.record.offeredInTree = offered;
  if (!offered) throw new LiveFailure('remove-not-offered'); // Nothing to remove: not a member, no live file grant, no shared session.
  // Scripted stand-in for the modal dialog: Confirm only if the text names the ship, the project and all three effects.
  let accepted = false, confirmations = 0;
  internals(c).confirmRemoval = async detail => {
    const mentions = {ship: detail.includes(peer), project: detail.includes(project), membership: /member/i.test(detail), files: /file/i.test(detail), sessions: /session/i.test(detail)};
    confirmations++; accepted = confirmations === 1 && Object.values(mentions).every(Boolean);
    Object.assign(c.record, {scriptedConfirmation: true, confirmations, confirmationMentions: mentions, confirmationOffered: detail.slice(0, 800), confirmationTextVerified: accepted});
    return accepted;
  };
  const after = await sessionCommand(c, peer, 'remove', () => c.api.projectSharing.removeCollaborator(), () => accepted);
  if (after.member || after.viewGrant === 'live' || after.sessions.some(row => row.shared)) throw new LiveFailure('collaborator-not-removed');
}

/** Opens the real candidate and check documents without submitting anything. Reuse the same private
 * profile on another launch to verify that reopening observes the same native outcome. */
async function inspectChange(c: LiveContext): Promise<void> {
  const {candidate: id, candidateSession: session} = readHandoff(need('READYMADE_HANDOFF'));
  if (!id || !session) throw new LiveFailure('handoff-without-candidate');
  const project = await ownProject(c);
  await c.timed('observe-candidate', () => c.api.codeReview.observe(session), 60000);
  await c.timed('open-candidate', () => c.api.codeReview.show(id), 30000);
  const document = vscode.window.activeTextEditor?.document;
  assert.equal(document?.uri.scheme, 'readymade-candidate'); assert.ok(document);
  const candidate = JSON.parse(document.getText());
  assert.equal(candidate.id, id); assert.equal(candidate.session, session); assert.equal(candidate.project, project);
  assert.equal(candidate.owner, c.ship); assert.equal(candidate.snapshotKind, 'candidate');
  if (process.env.READYMADE_EXPECTED_STAGE) assert.equal(candidate.stage, process.env.READYMADE_EXPECTED_STAGE);
  if (candidate.stage === 'applied') {assert.equal(candidate.decision, 'approve'); assert.ok(candidate.landed);}
  c.record.candidateDocument = candidate; c.record.candidateRows = seen(c.api.codeReview.rows());
  if (process.env.READYMADE_EXPECTED_DIFF === '1') {
    assert.equal(candidate.edits.length, 1); assert.ok(candidate.edits[0].preview);
    const diff = vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => tab.input)
      .find((input): input is vscode.TabInputTextDiff => input instanceof vscode.TabInputTextDiff &&
        input.original.scheme === document.uri.scheme && input.original.path.startsWith(document.uri.path.replace(/candidate\.json$/, 'source/')));
    assert.ok(diff, 'The exact candidate must be visible in a diff editor');
    const original = await vscode.workspace.openTextDocument(diff.original), proposed = await vscode.workspace.openTextDocument(diff.modified);
    assert.equal(original.getText(), candidate.edits[0].preview.original);
    assert.equal(proposed.getText(), candidate.edits[0].preview.proposed);
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(diff.modified, Buffer.from('forbidden'))));
    c.record.diff = {original: diff.original.toString(), proposed: diff.modified.toString(), exact: true, readonly: true};
  }
  await c.timed('observe-checks', () => c.api.checks.observe(session), 60000);
  const reports = c.api.checks.rows()[0].children?.filter(row => row.command?.command === 'readymade.showCheck') ?? [];
  c.record.checkRows = seen(c.api.checks.rows());
  if (reports.length) {
    await c.timed('open-check', () => c.api.checks.show(String(reports[0].command!.arguments![0])), 30000);
    c.record.checkDocument = JSON.parse(vscode.window.activeTextEditor!.document.getText());
  }
  c.record.write = 'none';
}

export function run(): Promise<void> {
  return liveRun('live-owner-host', {'native-screens': nativeScreens, 'native-actions': nativeActions, invite, share, revoke, members, 'share-session': c => sessionChange(c, 'share'), 'share-session-limited': sessionLimit, 'answer-suggestion': answerSuggestion, reviewer, 'import-suggestion': importSuggestion, 'import-bundle': importBundle, 'compare-bundle': compareBundle, review, apply, 'inspect-change': inspectChange, 'unshare-session': c => sessionChange(c, 'unshare'), 'project-sharing': projectSetting, remove});
}
