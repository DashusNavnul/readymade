import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {joinProjectLink} from '../src/project-invitations-view';
import {sharedProjectLink} from '../src/remote-source-view';
import type {RemoteSourceObservation} from '../src/remote-project-view';
import type {RemoteProjectSessionsReply} from '../src/remote-project-sessions';
import {LiveFailure, errorInfo, invitationAction, liveRun, need, needShip, readHandoff, seen, type LiveContext} from './live-ship-support';

// Live acceptance on the PEER's own running ship. One phase per launch (READYMADE_LIVE_PHASE):
// join | sessions. The links come from the owner phases through the READYMADE_HANDOFF file. The peer
// never needs a coding connection: joining and reading shared work use only the app sign-in.

async function join(c: LiveContext): Promise<void> {
  const owner = needShip('READYMADE_OWNER_SHIP'), project = need('READYMADE_PROJECT'), joinLink = readHandoff(need('READYMADE_HANDOFF')).joinLink;
  if (!joinLink) throw new LiveFailure('handoff-without-join-link');
  const link = joinProjectLink(vscode.Uri.parse(joinLink, true), c.extension.id);
  assert.deepEqual({authority: link.authority, project: link.project, target: link.target}, {authority: owner, project, target: c.ship});
  c.record.owner = owner; c.record.invitation = link.invitation;
  await invitationAction(c, 'join', () => c.api.invitations.join(joinLink));
  assert.equal(c.client.snapshot, undefined); c.record.joinedWithoutCodingConnection = true;
}

// Read-only views of what the shared tree holds in memory, for the receipt. Nothing is changed through them.
interface SourceInternals {
  state: string; settled: boolean; observation?: RemoteSourceObservation;
  sessionLists: Map<string, {reply?: RemoteProjectSessionsReply; note?: string; busy: boolean}>;
}

async function sessions(c: LiveContext): Promise<void> {
  const owner = needShip('READYMADE_OWNER_SHIP'), project = need('READYMADE_PROJECT'), text = readHandoff(need('READYMADE_HANDOFF')).sharedProjectLink;
  const wantStatus = process.env.READYMADE_EXPECT_STATUS, wantCount = process.env.READYMADE_EXPECT_SESSIONS;
  if (wantStatus !== undefined && !['ready', 'refused', 'uncertain'].includes(wantStatus)) throw new LiveFailure('invalid-READYMADE_EXPECT_STATUS');
  if (wantCount !== undefined && !/^(?:0|[1-9][0-9]?)$/.test(wantCount)) throw new LiveFailure('invalid-READYMADE_EXPECT_SESSIONS');
  if (!text) throw new LiveFailure('handoff-without-shared-project-link');
  const link = sharedProjectLink(vscode.Uri.parse(text, true), c.extension.id);
  assert.deepEqual({owner: link.owner, project: link.project, peer: link.peer}, {owner, project, peer: c.ship});
  if (!(await vscode.commands.getCommands(true)).includes('readymade.refreshSharedSessions')) throw new LiveFailure('refresh-shared-sessions-not-registered');
  c.record.owner = owner; c.record.generation = link.generation; c.record.expected = {status: wantStatus, sessions: wantCount === undefined ? undefined : Number(wantCount)};
  const source = c.api.remoteSource as unknown as SourceInternals;

  // 1. Open the link as the product does. Any outcome of the source read is evidence, not a failure:
  //    the granted path may not exist on the desk, and the owner may refuse or not answer.
  let opened: unknown;
  try {await c.timed('open-shared-project', () => c.api.remoteSource.open(text), 60000);} catch (error) {opened = error;}
  const observation = source.observation;
  c.record.sourceRead = {state: source.state, settled: source.settled, ...(opened ? {error: errorInfo(opened, true)} : {}),
    ...(observation ? {desk: observation.desk, revision: observation.revision, observedAt: observation.observedAt,
      files: observation.files.map(file => ({path: file.path, bytes: Buffer.byteLength(file.text)}))} : {})};
  c.observed('source-read', source.state);

  // 2. Click the Sessions group's own refresh row. A request still pending is only read again by one more click.
  const label = `Sessions · ${owner} / ${project}`;
  const group = () => (c.api.remoteSource.rows()[0].children ?? []).find(row => row.label === label);
  const held = () => source.sessionLists.get(JSON.stringify([c.ship, owner, project]));
  const refresh = group()?.children?.find(row => row.command?.command === 'readymade.refreshSharedSessions')?.command;
  if (!refresh) throw new LiveFailure('sessions-row-missing');
  assert.deepEqual(refresh.arguments, [owner, project]);
  let clicks = 0, failed: unknown;
  do {
    clicks++;
    try {await c.timed('refresh-shared-sessions-' + clicks, () => Promise.resolve(vscode.commands.executeCommand(refresh.command, ...(refresh.arguments ?? []))), 75000);}
    catch (error) {failed = error;}
    const reply = held()?.reply;
    c.observed('sessions', reply?.status ?? 'no-reply', reply && 'reason' in reply ? reply.reason : held()?.note);
  } while (!failed && held()?.reply?.status === 'pending' && clicks < 2);

  // 3. Record what the ship answered and what a user sees in the tree.
  const list = held(), reply = list?.reply, shown = group();
  c.record.sessionsClicks = clicks; c.record.sessionsTree = shown ? seen([shown])[0] : undefined;
  if (list?.note) c.record.sessionsNote = list.note;
  if (failed) c.record.sessionsError = errorInfo(failed, true);
  if (!reply) throw new LiveFailure(list?.note?.startsWith('Outcome unknown') ? 'sessions-outcome-unknown' : 'sessions-no-reply');
  const listed = reply.status === 'ready' ? reply.observation : null;
  c.record.sessions = {status: reply.status, request: reply.request, permissionGranted: reply.permissionGranted,
    ...('reason' in reply ? {reason: reply.reason, deadline: reply.deadline, retainedUntil: reply.retainedUntil} : {}),
    ...(listed ? {observedAt: listed.observedAt, truncated: listed.truncated, count: listed.sessions.length,
      sessions: listed.sessions.map(row => ({id: row.id, phase: row.phase, desk: row.working.desk, revision: row.working.revision}))} : {})};
  if (failed) throw new LiveFailure('sessions-refresh-failed');
  if (!['ready', 'refused', 'uncertain'].includes(reply.status)) throw new LiveFailure(reply.status === 'pending' ? 'sessions-not-settled' : 'sessions-' + reply.status);
  if (wantStatus !== undefined && reply.status !== wantStatus) throw new LiveFailure('sessions-status-unexpected');
  if (wantCount !== undefined && listed?.sessions.length !== Number(wantCount)) throw new LiveFailure('sessions-count-unexpected');
}

export function run(): Promise<void> {return liveRun('live-peer-host', {join, sessions});}
