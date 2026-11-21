import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {joinProjectLink, type GuestServiceSteps} from '../src/project-invitations-view';
import {GUEST_SOURCE} from '../src/guest-service';
import {sharedProjectLink} from '../src/remote-source-view';
import type {RemoteSourceObservation} from '../src/remote-project-view';
import {LiveFailure, errorInfo, invitationAction, liveRun, mergeHandoff, need, needShip, readHandoff, seen, until, type LiveContext} from './live-ship-support';
import {streamText} from '../src/collab-pages';

// Live acceptance on the PEER's own running ship. One phase per launch (READYMADE_LIVE_PHASE):
// join | sessions | suggest. The links come from the owner phases through the READYMADE_HANDOFF file. The peer
// never needs a coding connection: joining and reading shared work use only the app sign-in.

async function join(c: LiveContext): Promise<void> {
  const owner = needShip('READYMADE_OWNER_SHIP'), project = need('READYMADE_PROJECT'), joinLink = readHandoff(need('READYMADE_HANDOFF')).joinLink;
  if (!joinLink) throw new LiveFailure('handoff-without-join-link');
  const link = joinProjectLink(vscode.Uri.parse(joinLink, true), c.extension.id);
  assert.deepEqual({authority: link.authority, project: link.project, target: link.target}, {authority: owner, project, target: c.ship});
  c.record.owner = owner; c.record.invitation = link.invitation;
  // The guest's own ship may not run the collaboration service yet; joining installs it after one modal
  // confirmation. The test runner refuses modal dialogs, so a scripted stand-in answers Install only to text
  // that names the service, its source ship and desk. Every other step (kiln poke, waiting) is product code.
  c.record.guestBefore = await c.client.guestServiceRead();
  const views = c.api.invitations as unknown as {guest: GuestServiceSteps}, real = views.guest;
  let confirmations = 0, polls = 0; const started = Date.now();
  views.guest = {...real, pause: async ms => {polls++; await real.pause(ms);},
    confirm: async detail => {
      confirmations++;
      const ok = confirmations === 1 && /collaboration service/.test(detail) && detail.includes(GUEST_SOURCE.ship) && detail.includes('%' + GUEST_SOURCE.desk);
      Object.assign(c.record, {scriptedConfirmation: true, confirmations, confirmationOffered: detail.slice(0, 600), confirmationTextVerified: ok});
      return ok;
    }};
  try {await invitationAction(c, 'join', () => c.api.invitations.join(joinLink));} finally {views.guest = real;}
  c.record.guestAfter = await c.client.guestServiceRead();
  Object.assign(c.record, {guestPolls: polls, guestConfirmations: confirmations, joinSeconds: Math.round((Date.now() - started) / 1000)});
  assert.equal(c.client.snapshot, undefined); c.record.joinedWithoutCodingConnection = true;
}

// Read-only views of what the shared tree holds in memory, for the receipt. Nothing is changed through them.
interface SourceInternals {
  state: string; settled: boolean; observation?: RemoteSourceObservation;
  sessionLists: Map<string, {pages: {complete: boolean; note: string; sessions: readonly {id: string; phase: string; inspection: string; working: {desk: string; revision: string}}[]}; busy: boolean}>;
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
  // The list is read page by page and held in memory. `ready`: every page was read; `refused`: the owner refused a
  // page; `uncertain`: a page was not answered or not provided, and one more click reads that same page again.
  const status = (): 'ready' | 'refused' | 'uncertain' | 'unread' => {
    const pages = held()?.pages;
    return !pages ? 'unread' : pages.complete ? 'ready' : pages.note.startsWith('The owner refused') ? 'refused' : 'uncertain';
  };
  let clicks = 0, failed: unknown;
  do {
    clicks++; failed = undefined;
    try {await c.timed('refresh-shared-sessions-' + clicks, () => Promise.resolve(vscode.commands.executeCommand(refresh.command, ...(refresh.arguments ?? []))), 75000);}
    catch (error) {failed = error;}
    c.observed('sessions', status(), held()?.pages.note);
  } while (status() === 'uncertain' && clicks < 2);

  // 3. Record what the ship answered and what a user sees in the tree.
  const pages = held()?.pages, shown = group(), settled = status();
  c.record.sessionsClicks = clicks; c.record.sessionsTree = shown ? seen([shown])[0] : undefined;
  if (pages) c.record.sessionsNote = pages.note;
  if (failed) c.record.sessionsError = errorInfo(failed, true);
  if (!pages) throw new LiveFailure('sessions-no-list');
  c.record.sessions = {status: settled, count: pages.sessions.length,
    sessions: pages.sessions.map(row => ({id: row.id, phase: row.phase, desk: row.working.desk, revision: row.working.revision}))};
  if (failed) throw new LiveFailure('sessions-refresh-failed');
  if (wantStatus !== undefined && settled !== wantStatus) throw new LiveFailure('sessions-status-unexpected');
  if (wantCount !== undefined && pages.sessions.length !== Number(wantCount)) throw new LiveFailure('sessions-count-unexpected');
}

/**
 * The collaborator opens the shared project, edits one shared file as a local draft and sends it to the owner
 * as a suggestion: one submission, then only reads of the retained request until the owner's ship has recorded it.
 */
async function suggest(c: LiveContext): Promise<void> {
  const owner = needShip('READYMADE_OWNER_SHIP'), project = need('READYMADE_PROJECT'), handoff = need('READYMADE_HANDOFF'), text = readHandoff(handoff).sharedProjectLink;
  if (!text) throw new LiveFailure('handoff-without-shared-project-link');
  const link = sharedProjectLink(vscode.Uri.parse(text, true), c.extension.id);
  assert.deepEqual({owner: link.owner, project: link.project, peer: link.peer}, {owner, project, peer: c.ship});
  const source = c.api.remoteSource as unknown as SourceInternals & {suggestions: {list(): readonly {draftId: string; request: string; phase: string; recoveries?: readonly {phase: string}[]}[]}};
  await c.timed('open-shared-project', () => c.api.remoteSource.open(text), 90000);
  const observation = source.observation; c.record.sourceState = source.state;
  if (source.state !== 'Read-only shared files' || !observation?.files.length) throw new LiveFailure('shared-source-not-readable');
  const file = observation.files[0]; c.record.path = file.path; c.record.bytes = Buffer.byteLength(file.text);
  await c.timed('edit-draft', () => c.api.remoteSource.editDraft(file.path), 30000);
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.getText() !== file.text) throw new LiveFailure('draft-did-not-open');
  const line = `::  suggested in a live test ${Date.now().toString(36)}\n`, end = editor.document.positionAt(file.text.length);
  if (!await editor.edit(edit => edit.insert(end, (file.text.endsWith('\n') ? '' : '\n') + line))) throw new LiveFailure('draft-edit-refused');
  const draft = editor.document.uri.toString(), before = new Set(source.suggestions.list().map(row => row.request)); c.record.added = line.trim();
  c.mark('suggestion-submit');
  let failed: unknown;
  try {await c.timed('send-suggestion', () => c.api.remoteSource.sendSuggestion(draft), 90000);} catch (error) {failed = error;}
  // The journal names a draft by its own id, not its address: the retained suggestion is the one that was not there before.
  const created = source.suggestions.list().find(row => !before.has(row.request)), held = () => source.suggestions.list().find(row => row.request === created?.request);
  let record = held();
  if (!record) {c.record.write = 'not-sent'; if (failed) c.record.writeError = errorInfo(failed, true); throw new LiveFailure('suggestion-not-sent');}
  c.record.request = record.request; c.record.write = 'submitted'; c.observed('suggestion', record.phase);
  if (failed) c.record.sendError = errorInfo(failed, true);
  // Read the retained request until the owner's ship shows it recorded. Nothing is sent again.
  for (let reads = 0; reads < 12 && record.phase !== 'recorded' && record.recoveries?.at(-1)?.phase !== 'recorded' && !/^refused/.test(record.phase); reads++) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    try {await c.timed('check-suggestion-' + reads, () => c.api.remoteSource.checkSuggestion(record!.request), 60000);} catch (error) {c.observed('check', 'unavailable', errorInfo(error).code);}
    record = held() ?? record; c.observed('suggestion', record.recoveries?.at(-1)?.phase ?? record.phase);
  }
  const phase = record.recoveries?.at(-1)?.phase ?? record.phase; c.record.phase = phase;
  if (phase !== 'recorded') throw new LiveFailure('suggestion-' + phase);
  c.mark('handoff'); mergeHandoff(handoff, {suggestionRequest: record.request, suggestionPath: file.path});
}

/**
 * The collaborator edits TWO shared files as local drafts and sends them as ONE suggestion with the product's
 * send command (draft ids as its arguments, so no picker is scripted), then only reads the retained request.
 * READYMADE_GENERATION, when set, names the current grant generation if the handoff link carries an older one.
 */
async function suggestBundle(c: LiveContext): Promise<void> {
  const owner = needShip('READYMADE_OWNER_SHIP'), project = need('READYMADE_PROJECT'), handoff = need('READYMADE_HANDOFF');
  const old = readHandoff(handoff).sharedProjectLink;
  if (!old) throw new LiveFailure('handoff-without-shared-project-link');
  const base = sharedProjectLink(vscode.Uri.parse(old, true), c.extension.id), generation = process.env.READYMADE_GENERATION ?? base.generation;
  const text = vscode.Uri.from({scheme: vscode.env.uriScheme, authority: c.extension.id, path: '/shared-project',
    query: new URLSearchParams({owner: base.owner, project: base.project, generation, peer: base.peer}).toString()}).toString();
  const link = sharedProjectLink(vscode.Uri.parse(text, true), c.extension.id);
  assert.deepEqual({owner: link.owner, project: link.project, peer: link.peer}, {owner, project, peer: c.ship});
  type Bundles = {list(): readonly {request: string; drafts: readonly string[]; phase: string; reason?: string; receiptHash?: string; intent: {files: readonly {path: string}[]}}[]};
  const source = c.api.remoteSource as unknown as SourceInternals & {bundles: Bundles; drafts: {list(): readonly {id: string; uri: string; path: string}[]}};
  if (!(await vscode.commands.getCommands(true)).includes('readymade.sendSharedBundle')) throw new LiveFailure('send-shared-bundle-not-registered');
  await c.timed('open-shared-project', () => c.api.remoteSource.open(text), 90000);
  const observation = source.observation; c.record.sourceState = source.state; c.record.generation = generation;
  if (source.state !== 'Read-only shared files' || !observation || observation.files.length < 2) throw new LiveFailure('two-shared-files-not-readable');
  c.record.revision = observation.revision; c.record.root = observation.root;
  const stamp = Date.now().toString(36), files = observation.files.slice(0, 2), ids: string[] = [];
  for (const file of files) {
    await c.timed('edit-draft-' + file.path, () => c.api.remoteSource.editDraft(file.path), 30000);
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.getText() !== file.text) throw new LiveFailure('draft-did-not-open');
    const line = `::  two-file suggestion from the Readymade app ${stamp}\n`, end = editor.document.positionAt(file.text.length);
    if (!await editor.edit(edit => edit.insert(end, (file.text.endsWith('\n') ? '' : '\n') + line))) throw new LiveFailure('draft-edit-refused');
    const draft = source.drafts.list().find(row => row.uri === editor.document.uri.toString());
    if (!draft) throw new LiveFailure('draft-not-retained');
    ids.push(draft.id);
  }
  c.record.paths = files.map(f => f.path);
  const before = new Set(source.bundles.list().map(row => row.request));
  c.mark('bundle-submit');
  let failed: unknown;
  try {await c.timed('send-bundle', () => Promise.resolve(vscode.commands.executeCommand('readymade.sendSharedBundle', ids)), 90000);} catch (error) {failed = error;}
  const created = source.bundles.list().find(row => !before.has(row.request)), held = () => source.bundles.list().find(row => row.request === created?.request);
  let record = held();
  if (!record) {c.record.write = 'not-sent'; if (failed) c.record.writeError = errorInfo(failed, true); throw new LiveFailure('bundle-not-sent');}
  c.record.request = record.request; c.record.write = 'submitted'; c.record.sentFiles = record.intent.files.map(f => f.path); c.observed('bundle', record.phase);
  if (failed) c.record.sendError = errorInfo(failed, true);
  const final = ['recorded', 'refused', 'uncertain', 'refused-before-submit'];
  for (let reads = 0; reads < 12 && !final.includes(record.phase); reads++) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    try {await c.timed('check-bundle-' + reads, () => Promise.resolve(vscode.commands.executeCommand('readymade.checkSharedBundle', record!.request)), 60000);}
    catch (error) {c.observed('check', 'unavailable', errorInfo(error).code);}
    record = held() ?? record; c.observed('bundle', record.phase, record.reason);
  }
  const row = (c.api.remoteSource.rows()[0].children ?? []).find(r => r.label === `Suggestion · ${record!.intent.files.length} files`);
  Object.assign(c.record, {phase: record.phase, reason: record.reason, receiptHash: record.receiptHash, tree: row ? seen([row])[0] : undefined});
  if (record.phase !== 'recorded') throw new LiveFailure('bundle-' + record.phase);
}

/**
 * The collaborator's side of the native pages, in the real window: new notices from the owner, a live stream of a
 * shared session (opened, then closed), file presence on a shared file, and one work request the owner must refuse
 * (a session that is not shared), so nothing is queued on the owner's ship.
 */
async function nativePeer(c: LiveContext): Promise<void> {
  const owner = needShip('READYMADE_OWNER_SHIP'), project = need('READYMADE_PROJECT'), text = readHandoff(need('READYMADE_HANDOFF')).sharedProjectLink;
  if (!text) throw new LiveFailure('handoff-without-shared-project-link');
  const native = c.api.native, record: Record<string, unknown> = {};
  c.record.native = record;
  record.newNotices = await c.timed('read-inbox', () => native.readInbox(true), 30000);
  record.newNoticesAgain = await c.timed('read-inbox-again', () => native.readInbox(true), 30000);
  await c.timed('notices-screen', async () => {await vscode.commands.executeCommand('readymade.notices'); await until(() => !!native.notices.shown && native.notices.shown.status !== 'Reading the ship…', 30000);}, 45000);
  record.notices = native.notices.shown!.status; record.firstReceived = native.notices.shown!.sections[1]?.lines[0];
  try {await c.timed('open-shared-project', () => c.api.remoteSource.open(text), 60000);} catch (error) {record.openError = errorInfo(error, true);}
  try {await c.timed('list-shared-sessions', () => c.api.remoteSource.refreshSessions(owner, project), 75000);} catch (error) {record.sessionsError = errorInfo(error, true);}
  const shared = c.api.remoteSource.sharedSessions(); record.sharedSessions = shared.map(s => ({session: s.session.slice(0, 11), phase: s.phase}));
  if (shared.length) {
    const s = shared[0]!;
    record.follow = await c.timed('follow', () => native.follow(s), 30000);
    try {await until(() => native.followed.some(f => f.session === s.session && f.phase !== 'connecting'), 20000);} catch { /* recorded as it stands */ }
    record.stream = native.followed.map(f => ({phase: f.phase, reason: f.reason, sequence: f.sequence, text: streamText(f)}));
    record.unfollow = await c.timed('unfollow', () => native.unfollow(s), 30000);
    // Following the same session again must start from the sequence this computer last saw.
    const sequence = (record.stream as {sequence: number}[])[0]?.sequence ?? 0;
    record.followAgain = await c.timed('follow-again', () => native.follow(s), 30000);
    if (sequence) assert.equal(record.followAgain, `Following again from sequence ${sequence}.`);
    record.unfollowAgain = await c.timed('unfollow-again', () => native.unfollow(s), 30000);
    record.refusedAsk = await c.timed('ask-unshared-session', () => native.ask({owner, project, session: '0x1'}, 'Live check: this session is not shared, so the owner must refuse this.'), 30000);
    // One real request on the shared session: the owner queues it (the session is not idle, so it cannot start),
    // and it is withdrawn at once, so nothing is left on the owner's ship and nothing runs.
    if (process.env.READYMADE_ASK_AND_WITHDRAW === '1') {
      const real = await c.timed('ask-shared-session', () => native.ask(s, 'Live check: this request is withdrawn at once and must never run.'), 30000);
      record.realAsk = real.said; assert.equal(real.refused, false, real.said); assert.match(real.said, /queued your request/);
      record.withdrawn = await c.timed('withdraw', () => native.withdraw(real.nonce), 30000);
      assert.match(String(record.withdrawn), /withdrew your request\. Nothing ran\.$/);
      record.withdrawnAgain = await c.timed('withdraw-again', () => native.withdraw(real.nonce), 30000);
    }
    // What was asked is kept on this computer and shown with where it stands.
    await c.timed('work-screen', async () => {await vscode.commands.executeCommand('readymade.workRequests'); await until(() => !!native.work.shown && native.work.shown.status !== 'Reading the ship…', 30000);}, 45000);
    record.workScreen = {status: native.work.shown!.status, asked: native.work.shown!.sections[1]?.lines.slice(0, 2)};
  }
  const source = c.api.remoteSource as unknown as {observation?: RemoteSourceObservation; uri(o: RemoteSourceObservation, path: string): vscode.Uri};
  if (source.observation?.files.length) {
    const file = source.observation.files[0]!;
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source.uri(source.observation, file.path)));
    record.presenceOffByDefault = (await c.timed('presence-off', async () => {await native.tellPresence(); return native.presenceShown.text;}, 30000)) || 'hidden';
    await vscode.workspace.getConfiguration('readymade').update('sharePresence', true, vscode.ConfigurationTarget.Global);
    // Turning the setting on reports by itself; wait for what the status bar then says.
    await c.timed('presence', async () => {await native.tellPresence(); await until(() => native.presenceShown.text !== '', 20000);}, 30000);
    record.presence = {file: file.path, ...native.presenceShown};
  }
  assert.equal(record.newNoticesAgain, 0, 'a notice is shown once');
}

/**
 * A profile with no join of its own (a new computer), connected to a ship that joined a project earlier: read
 * which projects their owners confirm. Reads only: the ship's own request list, and one membership read per
 * project. Nothing is joined, left or sent, and nothing is written to the profile's invitation journal.
 */
async function joined(c: LiveContext): Promise<void> {
  const owner = needShip('READYMADE_OWNER_SHIP'), project = need('READYMADE_PROJECT');
  const view = c.api.invitations, journal = (view as unknown as {journal: {entries(): unknown[]}}).journal;
  c.record.owner = owner; c.record.retainedBefore = journal.entries().length;
  await c.timed('read-joined-projects', () => view.discover(true), 150000);
  const rows = seen(view.rows())[0]?.children ?? [];
  // Every row of the group as a person sees it: its name, the words beside it, and the names of its actions.
  c.record.rows = rows.map(row => ({label: row.label, description: row.description, actions: row.children?.map(child => child.label) ?? []}));
  const found = rows.find(row => row.label === project && row.description?.startsWith(owner + ' · '));
  c.record.joined = found ? {description: found.description, tooltip: found.tooltip, actions: found.children?.map(child => child.label) ?? []} : null;
  c.record.leaveOffered = found?.children?.some(child => child.label === 'Leave Project…') ?? false;
  c.record.retainedAfter = journal.entries().length;
  c.observed('joined-project', found?.description ?? 'not listed');
  if (process.env.READYMADE_EXPECT_MEMBER === '1') {
    assert.equal(found?.description, owner + ' · member'); assert.equal(c.record.leaveOffered, true);
  }
  assert.equal(c.record.retainedAfter, c.record.retainedBefore);
}
export function run(): Promise<void> {return liveRun('live-peer-host', {join, sessions, suggest, 'suggest-bundle': suggestBundle, 'native-peer': nativePeer, joined});}
