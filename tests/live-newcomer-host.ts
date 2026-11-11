import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {writeFileSync, readFileSync, realpathSync} from 'node:fs';
import type {ReadymadeWorkspace} from '../src/extension';
import {joinProjectLink, type GuestServiceSteps} from '../src/project-invitations-view';

// Live acceptance of what a NEWCOMER does, in the real app window, on a real ship running on this computer.
// The window starts with nothing connected and no saved login. Any address box, login-code box or list fails
// the run: the person types nothing. One phase per launch (READYMADE_NEWCOMER_PHASE):
//   join            open the join link in READYMADE_HANDOFF: the app connects the ship the link names, installs the
//                   collaboration service on it if it is missing (one confirmation), and joins
//   leave           leave the project that join joined (same profile: READYMADE_TEST_USER_DIR)
//   remove-service  remove the collaboration service from the ship (READYMADE_NEWCOMER_SHIP)
// Modal confirmations cannot be clicked by a test, so a stand-in answers yes and records the exact text shown.
class Done extends Error {}

/** The whole phase must finish by itself. An app left waiting for a person (a list, a box, a dialog) ends here as a failure, not a hang. */
const PHASE_LIMIT_MS = Number(process.env.READYMADE_PHASE_LIMIT_MS ?? 120000);
export async function run(): Promise<void> {
  let finished = false;
  const limit = new Promise<void>(resolve => setTimeout(() => {
    if (finished) return resolve();
    if (process.env.READYMADE_HOST_EVIDENCE) writeFileSync(process.env.READYMADE_HOST_EVIDENCE, JSON.stringify({passed: false, phase: process.env.READYMADE_LOCAL_PHASE ?? process.env.READYMADE_NEWCOMER_PHASE,
      error: `did not finish by itself in ${PHASE_LIMIT_MS / 1000} s: the app was waiting for a person`}), {mode: 0o600});
    void vscode.commands.executeCommand('workbench.action.closeQuickOpen').then(() => vscode.commands.executeCommand('workbench.action.closeWindow')); resolve();
  }, PHASE_LIMIT_MS));
  await Promise.race([phase().finally(() => {finished = true;}), limit]);
}
async function phase(): Promise<void> {
  const record: Record<string, unknown> = {passed: false, fixture: false, phase: process.env.READYMADE_NEWCOMER_PHASE};
  const started = Date.now();
  try {
    const phase = process.env.READYMADE_NEWCOMER_PHASE, ship = process.env.READYMADE_NEWCOMER_SHIP;
    assert.ok(ship && ['join', 'leave', 'remove-service'].includes(String(phase)), 'configuration');
    const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
    const builtin = !!process.env.READYMADE_BUILTIN_EXTENSION;
    if (builtin) assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION!));
    record.ext = builtin ? 'bundled' : 'development';
    const api = await extension.activate();
    const prompts: string[] = [], confirmations: string[] = [];
    const window = vscode.window as unknown as Record<string, unknown>;
    // In the packaged app this stand-in cannot see the extension's own prompts (separate API objects): there the
    // guard is the phase limit above, since an app waiting for a person never finishes by itself.
    for (const name of ['showInputBox', 'showQuickPick']) window[name] = async (...args: unknown[]) => {prompts.push(name + ': ' + JSON.stringify((args[1] ?? args[0] ?? {}) as object).slice(0, 80)); return undefined;};
    const views = api.invitations as unknown as {guest: GuestServiceSteps}, real = views.guest;
    views.guest = {...real, confirm: async (detail, title) => {confirmations.push(`${title ?? 'Install the collaboration service?'} | ${detail}`.slice(0, 400)); return true;}};
    const rows = () => (api.invitations.rows()[0].children ?? []).map(row => ({label: row.label, description: row.description, actions: (row.children ?? []).map(child => child.label), request: (row.children ?? []).find(child => child.command?.command === 'readymade.leaveProject')?.command?.arguments?.[0] as string | undefined}));
    const connected = () => api.media.connectedClient;
    const finish = () => {record.prompts = prompts; record.confirmations = confirmations; record.seconds = Math.round((Date.now() - started) / 100) / 10;
      assert.deepEqual(prompts, [], 'the person was asked to type or choose something'); record.passed = true; throw new Done();};

    if (phase === 'join') {
      assert.equal(connected(), undefined, 'nothing connected when the app opens');
      const joinLink = JSON.parse(readFileSync(process.env.READYMADE_HANDOFF!, 'utf8')).joinLink as string;
      const link = joinProjectLink(vscode.Uri.parse(joinLink, true), extension.id);
      assert.equal(link.target, ship); record.owner = link.authority; record.project = link.project; record.linkNamesSource = link.source ?? null;
      await api.invitations.join(joinLink);
      const client = connected(); assert.ok(client, 'the join connected the ship');
      assert.equal(client.browserCookies(client.origin)[0]?.name, 'urbauth-' + ship); record.connectedByTheLink = ship;
      record.serviceAfter = (await client.guestServiceRead()).status; record.protocolAfter = (await client.guestDeskRead()).protocol;
      // Joined now: a row of this project is accepted and offers Leave (the app offers it only while joined).
      // A busy owner ship can settle the join after the app's first reads; the row then changes by itself, with no click.
      const until = Date.now() + 90000; let joined = rows().find(row => row.label === link.project && row.request);
      record.rowRightAfterJoin = rows().find(row => row.label === link.project)?.description;
      while (!joined && Date.now() < until) {await new Promise(resolve => setTimeout(resolve, 200)); joined = rows().find(row => row.label === link.project && row.request);}
      record.joinRow = joined; record.rowsAfterJoin = rows().map(row => `${row.label}: ${row.description}`).slice(2, 10);
      assert.equal(joined?.description, 'join · accepted');
      finish();
    }
    // The later phases reopen the same profile: the ship reconnects by itself, as it would for the person.
    const deadline = Date.now() + 20000;
    let client = connected();
    if (!client) {void api.media.reconnectLast(); while (Date.now() < deadline && !(client = connected())) await new Promise(resolve => setTimeout(resolve, 100));}
    if (!client) client = await api.media.connectClient(undefined, undefined, undefined, ship);
    assert.equal(client.browserCookies(client.origin)[0]?.name, 'urbauth-' + ship);
    if (phase === 'leave') {
      // The app reads retained results by itself after connecting; wait for the joined row to offer Leave.
      const until = Date.now() + 20000; let held = rows().find(row => row.request);
      if (!held) void api.invitations.observeRetained();
      while (!held && Date.now() < until) {await new Promise(resolve => setTimeout(resolve, 200)); held = rows().find(row => row.request);}
      record.rowsOnReopen = rows().map(row => `${row.label}: ${row.description}`).slice(0, 6);
      assert.ok(held?.request, 'the joined project offers Leave after reopening, with no Check Result click');
      // READYMADE_LEAVE_BY=command leaves the way the command palette and the Home command line do: no row, no ID.
      const byCommand = process.env.READYMADE_LEAVE_BY === 'command'; record.leaveBy = byCommand ? 'command' : 'row';
      record.joinsHeld = rows().filter(row => /^join · accepted/.test(row.description ?? '')).length;
      if (byCommand) await vscode.commands.executeCommand('readymade.leaveProject'); else await api.invitations.leave(held.request);
      const left = rows().filter(row => /^leave · /.test(row.description ?? '')).at(-1); record.leaveRow = left; assert.equal(left?.description, 'leave · accepted');
      // Left now: no row offers Leave any more, however many joins (a role change is a second one) came before.
      record.leaveOfferedAfter = rows().some(row => row.request); assert.equal(record.leaveOfferedAfter, false, 'Leave is not offered for a project already left');
      if (byCommand) {
        let refusal = ''; try {await vscode.commands.executeCommand('readymade.leaveProject');} catch (error) {refusal = error instanceof Error ? error.message : String(error);}
        record.secondLeave = refusal; assert.match(refusal, /has not joined a project it can leave/);
      }
      finish();
    }
    record.serviceBefore = await client.guestServiceDeskRead();
    await api.invitations.removeGuestService();
    record.serviceAfter = await client.guestServiceDeskRead(); record.stateAfter = (await client.guestServiceRead()).status;
    finish();
  } catch (error) {if (!(error instanceof Done)) {record.error = error instanceof Error ? error.message.slice(0, 300) : 'failed'; record.seconds = Math.round((Date.now() - started) / 100) / 10;}}
  if (process.env.READYMADE_HOST_EVIDENCE) writeFileSync(process.env.READYMADE_HOST_EVIDENCE, JSON.stringify(record), {mode: 0o600});
  await vscode.commands.executeCommand('workbench.action.closeWindow');
}
