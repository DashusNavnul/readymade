import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {joinProjectLink} from '../src/project-invitations-view';
import {sharedProjectLink} from '../src/remote-source-view';
import type {InvitationPage} from '../src/project-invitations';
import type {SharingView} from '../src/project-sharing';
import type {SessionSharingCommand, SessionSharingOutcome, SessionSharingSnapshot} from '../src/session-sharing';
import {dateAtomMillis} from '../src/editing-activity';
import {LiveFailure, LiveTimeout, acceptQuickInput, copied, errorInfo, invitationAction, liveRun, mergeHandoff, need, needShip, pasteQuickInput,
  readHandoff, seen, sleep, within, type LiveContext} from './live-ship-support';

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
  await ownProject(c); c.record.peer = peer; c.record.request = request; c.record.session = session;
  await c.timed('read-inbox', () => c.api.inbox.observe(), 60000);
  const row = (c.api.inbox.receipts ?? []).find(row => row.request === request && row.peer === peer);
  if (!row) throw new LiveFailure('suggestion-not-in-inbox');
  c.record.path = row.path; c.record.basis = `${row.desk} revision ${row.revision}`;
  const offered = (c.api.inbox.rows()[0].children ?? []).find(item => item.children?.some(action => action.command?.arguments?.[0] === row.receiptHash))
    ?.children?.find(action => action.command?.command === 'readymade.importInboxSuggestion');
  c.record.offeredInTree = offered?.label;
  if (!offered) throw new LiveFailure('import-not-offered');
  const before = new Set(c.api.drafts.list().map(d => d.uri));
  await c.timed('import', () => c.api.inbox.import(row.receiptHash), 180000);
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

/** The owner starts the governed review of the prepared candidate once, then reads until the reviewer decides. */
async function review(c: LiveContext): Promise<void> {
  const handoff = readHandoff(need('READYMADE_HANDOFF')), id = handoff.candidate, session = handoff.candidateSession;
  if (!id || !session) throw new LiveFailure('handoff-without-candidate');
  const project = await ownProject(c); c.record.candidate = id; c.record.session = session;
  const checked = await settledCandidate(c, session, id, cand => cand.stage === 'review' || cand.stage === 'refused', 40, 5000);
  c.record.checked = checked.cand ? `${checked.cand.stage}/${checked.cand.decision}` : null;
  if (checked.cand?.stage !== 'review' || checked.cand.decision !== 'pending') throw new LiveFailure('candidate-not-ready-for-review');
  const offered = (c.api.codeReview.rows()[0].children ?? []).some(row => row.command?.command === 'readymade.startCodeReview' && row.command.arguments?.[0] === id);
  c.record.offeredInTree = offered;
  if (!offered) throw new LiveFailure('review-not-offered');
  const accepted = confirmations(c, c.api.codeReview, 'confirm', detail => detail.includes(project) && detail.includes(id) && /A passing native decision can apply/.test(detail));
  c.mark('review-submit');
  try {await c.timed('start-review', () => c.api.codeReview.start(id), 120000); c.record.write = 'submitted';}
  catch (error) {c.record.write = accepted() ? 'unknown' : 'not-sent'; c.record.writeError = errorInfo(error, true); throw new LiveFailure('review-' + c.record.write);}
  // The reviewer is a model run by the owner's ship: allow up to fifteen minutes, reading every fifteen seconds.
  const decided = await settledCandidate(c, session, id, cand => cand.decision !== 'pending' || cand.stage === 'refused', 60, 15000);
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

export function run(): Promise<void> {
  return liveRun('live-owner-host', {invite, share, revoke, members, 'share-session': c => sessionChange(c, 'share'), 'share-session-limited': sessionLimit, 'answer-suggestion': answerSuggestion, reviewer, 'import-suggestion': importSuggestion, review, apply, 'unshare-session': c => sessionChange(c, 'unshare'), 'project-sharing': projectSetting, remove});
}
