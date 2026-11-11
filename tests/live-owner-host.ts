import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {joinProjectLink} from '../src/project-invitations-view';
import {sharedProjectLink} from '../src/remote-source-view';
import type {InvitationPage} from '../src/project-invitations';
import type {SharingView} from '../src/project-sharing';
import type {SessionSharingCommand, SessionSharingOutcome, SessionSharingSnapshot} from '../src/session-sharing';
import {LiveFailure, LiveTimeout, acceptQuickInput, copied, errorInfo, invitationAction, liveRun, mergeHandoff, need, needShip, pasteQuickInput,
  readHandoff, seen, sleep, within, type LiveContext} from './live-ship-support';

// Live acceptance on the OWNER's own running ship. One phase per launch (READYMADE_LIVE_PHASE):
// invite | share | revoke | members | share-session | unshare-session | remove. Every write is the product
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
  const project = await ownProject(c); c.record.peer = peer; c.record.role = 'contributor';
  const accepted = await invitationAction(c, 'invite-member', () => c.api.invitations.invite(peer, 'contributor'));
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
  // The three real pickers, in the screen's order: desk, files, permission ("Read files" is listed first).
  await changeSharing(c, peer, false,
    `Share with ${peer}\nProject: ${project}\nDesk: ${desk}\n${path}\n\nRead files. Access lasts until revoked. Suggestions do not automatically apply changes.`,
    [() => acceptQuickInput(desks.indexOf(desk)), () => pasteQuickInput(path), () => acceptQuickInput(0)]);
  const after = await observeSharing(c, peer, 'sharing-after');
  if (!after.grant || after.grant.revoked || !after.grant.view || after.grant.desk !== desk || !after.grant.paths.includes(path)) throw new LiveFailure('grant-not-current');
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
async function sessionCommand(c: LiveContext, peer: string, operation: 'share' | 'unshare' | 'remove', act: () => Promise<void>, maySend: () => boolean = () => true): Promise<SessionSharingSnapshot> {
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
  return liveRun('live-owner-host', {invite, share, revoke, members, 'share-session': c => sessionChange(c, 'share'), 'unshare-session': c => sessionChange(c, 'unshare'), remove});
}
