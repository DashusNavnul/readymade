import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ReadymadeWorkspace} from '../src/extension';
import {readSavedCode, type ShipClient} from '../src/ship-client';
import {discoverLocalPlanets} from '../src/planet-discovery';
import {remoteShip} from '../src/remote-project-view';
import type {MediaTreeRow} from '../src/media-workbench';

// Shared by live-owner-host and live-peer-host: connect to one ALREADY RUNNING real ship through the
// real running-ship picker, run one phase, and write one redacted receipt. Nothing here starts, installs
// or modifies a ship, and no write is ever repeated. The connect sequence follows existing-connection-host.

export class LiveFailure extends Error {constructor(readonly reason: string) {super('Live phase failed: ' + reason); this.name = 'LiveFailure';}}
export class LiveTimeout extends Error {constructor(readonly step: string) {super('Live step exceeded its time limit: ' + step); this.name = 'LiveTimeout';}}
export interface Observed {at: number; source: string; status: string; reason?: string}
export interface LiveContext {
  readonly api: ReadymadeWorkspace; readonly extension: vscode.Extension<ReadymadeWorkspace>; readonly client: ShipClient;
  readonly ship: string; readonly origin: string;
  /** Phase evidence, merged into the receipt whether the phase passes or fails. Never put a secret here. */
  readonly record: Record<string, unknown>;
  mark(step: string): void;
  observed(source: string, status: string, reason?: string): void;
  timed<T>(step: string, work: () => Promise<T>, limit: number): Promise<T>;
}
export type LivePhase = (context: LiveContext) => Promise<void>;
export interface SeenRow {label: string; description?: string; tooltip?: string; children?: SeenRow[]}

export const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));
export async function until(check: () => boolean, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() >= deadline) throw Error('Live ship did not reach the required state.');
    await sleep(50);
  }
}
/** Bounds a wait. It cannot cancel the product operation, so a timed-out write is always an unknown write. */
export async function within<T>(work: Promise<T>, limit: number, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  void work.then(() => {}, () => {});
  try {return await Promise.race([work, new Promise<never>((_resolve, reject) => {timer = setTimeout(() => reject(new LiveTimeout(step)), limit);})]);}
  finally {clearTimeout(timer);}
}
export function need(name: string): string {
  const value = process.env[name];
  if (!value || value.length > 2048) throw new LiveFailure('missing-' + name);
  return value;
}
export function needShip(name: string): string {
  const value = need(name);
  if (!remoteShip(value)) throw new LiveFailure('invalid-' + name);
  return value;
}
/** A login code has the shape of a moon name without its sig; session cookies are long @uv atoms. */
const redact = (text: string): string => text.replace(/(?<![~a-z-])[a-z]{6}(?:-[a-z]{6}){3}(?![a-z-])/g, '[redacted]').replace(/0v[0-9a-v.]{16,}/g, '[redacted]').slice(0, 400);
/** `product` admits the redacted message of an error raised by a product screen after sign-in. */
export function errorInfo(error: unknown, product = false): {name: string; code?: string; message?: string} {
  const code = (error as {code?: unknown} | null)?.code;
  return {name: error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : 'Error',
    ...(typeof code === 'string' && /^[A-Za-z]{1,64}$/.test(code) ? {code} : {}),
    ...(product && error instanceof Error ? {message: redact(error.message)} : {})};
}
export function seen(rows: readonly MediaTreeRow[] | undefined): SeenRow[] {
  return (rows ?? []).map(row => ({label: row.label, ...(row.description === undefined ? {} : {description: row.description}),
    ...(row.tooltip === undefined ? {} : {tooltip: row.tooltip}), ...(row.children ? {children: seen(row.children)} : {})}));
}

function privateFile(info: fs.Stats, limit: number): void {
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > limit) throw new LiveFailure('file-not-private');
}
function readPrivate(path: string, limit: number): string {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {privateFile(fs.fstatSync(fd), limit); return fs.readFileSync(fd, 'utf8');} finally {fs.closeSync(fd);}
}
/** Called only from the credentials callback. The code is returned to the product sign-in and kept nowhere else. */
function codeFromFile(path: string): string {
  let code: string;
  try {code = readPrivate(path, 256).trim();} catch {throw Error('Private login code file is unavailable.');}
  if (!/^[a-z]{6}(?:-[a-z]{6}){3}$/.test(code)) throw Error('Private login code file is unavailable.');
  return code;
}

export interface Handoff {joinLink?: string; sharedProjectLink?: string; suggestionRequest?: string; suggestionPath?: string; candidate?: string; candidateSession?: string}
/** Links, the id and file of a suggestion, and the candidate prepared from it, that one phase leaves for the next to find. A link names ships, a project and an invitation or grant generation; none of this is a credential. */
export function readHandoff(path: string, optional = false): Handoff {
  if (!isAbsolute(path)) throw new LiveFailure('handoff-path-not-absolute');
  let text: string;
  try {text = readPrivate(path, 8192);}
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error instanceof LiveFailure ? new LiveFailure('handoff-not-private') : new LiveFailure('handoff-unavailable');
  }
  let value: unknown; try {value = JSON.parse(text);} catch {throw new LiveFailure('handoff-invalid');}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new LiveFailure('handoff-invalid');
  for (const [key, link] of Object.entries(value)) if (!['joinLink', 'sharedProjectLink', 'suggestionRequest', 'suggestionPath', 'candidate', 'candidateSession'].includes(key) || typeof link !== 'string' || link.length > 2048) throw new LiveFailure('handoff-invalid');
  return value as Handoff;
}
export function mergeHandoff(path: string, patch: Handoff): void {
  const next = {...readHandoff(path, true), ...patch}, temporary = `${path}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {fs.writeFileSync(fd, JSON.stringify(next, null, 2)); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    fs.renameSync(temporary, path);
  } catch (error) {fs.rmSync(temporary, {force: true}); throw error;}
}

/** Runs one product copy action and returns what it put on the clipboard, then restores the prior text. */
export async function copied(work: () => Promise<void>): Promise<string> {
  const prior = await vscode.env.clipboard.readText(), sentinel = 'readymade-live-' + randomUUID();
  try {
    await vscode.env.clipboard.writeText(sentinel); await work();
    const text = await vscode.env.clipboard.readText();
    if (!text || text === sentinel) throw new LiveFailure('nothing-copied');
    return text;
  } finally {await vscode.env.clipboard.writeText(prior);}
}
/** Quick inputs offer no readiness signal to an extension; existing host tests wait a fixed interval too. */
export async function acceptQuickInput(index = 0): Promise<void> {
  await sleep(1000);
  for (let i = 0; i < index; i++) await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
}
/** Replaces the focused input box's text by select-all and paste, as a person would, then accepts it. */
export async function pasteQuickInput(text: string): Promise<void> {
  await sleep(1000);
  const prior = await vscode.env.clipboard.readText();
  try {
    await vscode.env.clipboard.writeText(text);
    await vscode.commands.executeCommand('editor.action.selectAll');
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await sleep(300);
  } finally {await vscode.env.clipboard.writeText(prior);}
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
}

/** The one retained invitation action of this launch, as the Project Invitations tree shows it. */
export function invitationOutcome(api: ReadymadeWorkspace, operation: 'invite-member' | 'join'): {status: string; request: string; actions: string[]} | undefined {
  const rows = (api.invitations.rows()[0].children ?? []).filter(row => row.description?.startsWith(operation + ' · '));
  if (rows.length > 1) throw new LiveFailure('several-retained-' + operation + '-actions');
  if (!rows.length) return undefined;
  const request: unknown = rows[0].children?.find(child => child.command?.command === 'readymade.checkProjectInvitation')?.command?.arguments?.[0];
  if (typeof request !== 'string') throw new LiveFailure('retained-action-without-request');
  return {status: rows[0].description!.slice(operation.length + 3), request, actions: (rows[0].children ?? []).map(child => child.label)};
}
/** One submission through the product screen, then read-only "Check Result" observations until the ship settles it. */
export async function invitationAction(context: LiveContext, operation: 'invite-member' | 'join', submit: () => Promise<void>): Promise<{status: string; request: string; actions: string[]}> {
  let failed: unknown;
  // A join may first install the collaboration service on the guest's own ship (download and compile: minutes).
  try {await context.timed(operation + '-submit', submit, operation === 'join' ? 600000 : 60000);} catch (error) {failed = error;}
  let row = invitationOutcome(context.api, operation);
  if (failed) {
    // A retained intent means the request may have left this computer. It is never sent again.
    const unknown = failed instanceof LiveTimeout || row !== undefined;
    context.record.write = unknown ? 'unknown' : 'not-sent'; context.record.writeError = errorInfo(failed, true);
    if (row) {
      context.record.request = row.request;
      try {await within(context.api.invitations.check(row.request), 20000, operation + '-observe'); context.record.observedAfterUnknown = invitationOutcome(context.api, operation)?.status;}
      catch (error) {context.record.observedAfterUnknown = errorInfo(error, true);}
    }
    throw new LiveFailure(operation + (unknown ? '-outcome-unknown' : '-not-sent'));
  }
  if (!row) throw new LiveFailure(operation + '-cancelled-before-submission');
  context.record.write = 'submitted'; context.record.request = row.request; context.observed('submit', row.status);
  for (let n = 0; n < 20 && !['accepted', 'refused'].includes(row.status); n++) {
    context.mark(operation + '-observe-' + n); await sleep(1500);
    try {await within(context.api.invitations.check(row.request), 20000, operation + '-observe');}
    catch (error) {context.observed('check', 'observation-unavailable', errorInfo(error).code); continue;}
    row = invitationOutcome(context.api, operation)!; context.observed('check', row.status);
  }
  context.record.actions = row.actions;
  if (row.status !== 'accepted') throw new LiveFailure(operation + '-' + (row.status === 'refused' ? 'refused' : 'not-settled'));
  return row;
}

/** Entry point of both live modules: READYMADE_LIVE_PHASE selects exactly one phase per launch. */
export async function liveRun(module: string, phases: Readonly<Record<string, LivePhase>>): Promise<void> {
  const config = vscode.workspace.getConfiguration('readymade');
  const previous = config.inspect<boolean>('callNotifications')?.globalValue;
  const evidence = process.env.READYMADE_HOST_EVIDENCE, phase = process.env.READYMADE_LIVE_PHASE ?? '', started = Date.now();
  const timings: Record<string, number> = {}, statuses: Observed[] = [], record: Record<string, unknown> = {};
  const diagnostics: {extensionPath?: string; credentialSource?: string; independentDiscovery?: Awaited<ReturnType<typeof discoverLocalPlanets>>['diagnostics'][]; discoveryStatus?: ReadymadeWorkspace['media']['localDiscoveryStatus'];
    observedNamesOrigins: {ship: string; origin: string}[]; count: number; connectingOutcome: string; connectingError?: ReturnType<typeof errorInfo>} = {observedNamesOrigins: [], count: 0, connectingOutcome: 'not-started'};
  let api: ReadymadeWorkspace | undefined, marker = 'configuration', connected = false;
  const origin = process.env.READYMADE_LIVE_ORIGIN, ship = process.env.READYMADE_EXPECTED_SHIP;
  const receipt = () => ({fixture: false, module, phase, ship, origin, project: process.env.READYMADE_PROJECT, editor: vscode.version,
    extensionPath: diagnostics.extensionPath, credentialSource: diagnostics.credentialSource, connected,
    statuses, timings, elapsedMs: Date.now() - started, secretValuesExcluded: true, ...record});
  try {
    assert.ok(evidence && origin && ship);
    if (!Object.hasOwn(phases, phase)) throw new LiveFailure('unknown-phase');
    assert.equal(new URL(origin).origin, origin); assert.ok(remoteShip(ship));
    // Explicit test-only credential sources. Exactly one is used, and only inside the sign-in callback below.
    const codeFile = process.env.READYMADE_TEST_CODE_FILE, credentialOrigin = process.env.READYMADE_TEST_CREDENTIAL_ORIGIN ?? origin;
    if (codeFile) {
      if (process.env.READYMADE_TEST_CREDENTIAL_ORIGIN || !isAbsolute(codeFile)) throw new LiveFailure('ambiguous-credential-source');
      privateFile(fs.lstatSync(codeFile), 256); // Refuse before connecting; the content is not read here.
    } else if (credentialOrigin !== origin) {
      const target = new URL(origin), credential = new URL(credentialOrigin);
      const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
      assert.equal(credential.origin, credentialOrigin);
      assert.equal(target.protocol, 'http:'); assert.equal(credential.protocol, target.protocol);
      assert.ok(loopback.has(target.hostname) && loopback.has(credential.hostname));
      assert.equal(credential.port, target.port);
    }
    diagnostics.credentialSource = codeFile ? 'private-code-file' : 'saved-login';
    const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace');
    assert.ok(extension);
    diagnostics.extensionPath = extension.extensionPath;
    if (process.env.READYMADE_BUILTIN_EXTENSION) assert.equal(fs.realpathSync(extension.extensionPath), fs.realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
    await config.update('callNotifications', false, vscode.ConfigurationTarget.Global);
    api = await extension.activate();
    assert.equal(api.client, undefined); assert.equal(api.media.connectedClient, undefined);
    assert.equal(api.media.controller?.state().length ?? 0, 0);
    diagnostics.independentDiscovery = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      marker = 'local-discovery-' + attempt;
      const discovered = await discoverLocalPlanets();
      diagnostics.independentDiscovery.push(discovered.diagnostics);
      assert.equal(discovered.planets.filter(planet => planet.ship === ship && planet.origin === origin).length, 1);
    }
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('workbench.action.quickOpenSelectNext'));
    assert.ok(commands.includes('workbench.action.acceptSelectedQuickOpenItem'));
    marker = 'picker-start';
    const connecting = api.media.connectClient(undefined, async address => {
      assert.equal(address, origin);
      const code = codeFile ? codeFromFile(codeFile) : await readSavedCode(credentialOrigin);
      if (!code) throw Error('Private saved credentials are unavailable.');
      return code;
    });
    diagnostics.connectingOutcome = 'pending';
    void connecting.then(() => {diagnostics.connectingOutcome = 'resolved';}, error => {diagnostics.connectingOutcome = 'rejected'; diagnostics.connectingError = errorInfo(error);});
    marker = 'picker-wait-list';
    await until(() => {
      diagnostics.discoveryStatus = api!.media.localDiscoveryStatus;
      const rows = api!.media.localPlanets;
      diagnostics.observedNamesOrigins = rows.map(({ship, origin}) => ({ship, origin})); diagnostics.count = rows.length;
      return rows.some(planet => planet.ship === ship && planet.origin === origin);
    }, 10000);
    marker = 'picker-snapshot';
    const choices = api.media.localPlanets;
    const index = choices.findIndex(planet => planet.ship === ship && planet.origin === origin);
    assert.ok(index >= 0);
    await sleep(250);
    assert.deepEqual(api.media.localPlanets, choices);
    for (let i = 0; i < index; i++) {marker = 'picker-next-' + i; await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');}
    marker = 'picker-accept';
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    marker = 'private-sign-in';
    let client: ShipClient;
    try {client = await within(connecting, 45000, marker);}
    catch (error) {
      // A rejected code makes the product ask for another one privately. Dismiss that prompt; type nothing.
      if (error instanceof LiveTimeout) {await vscode.commands.executeCommand('workbench.action.closeQuickOpen'); await sleep(2000);}
      throw error;
    }
    assert.ok(client); assert.equal(client.origin, origin);
    const cookies = client.browserCookies(origin);
    assert.equal(cookies.length, 1); assert.equal(cookies[0].name, 'urbauth-' + ship);
    assert.equal(api.client, undefined); assert.equal(api.media.connectedClient, client);
    connected = true; timings.connect = Date.now() - started;
    const live = api;
    await phases[phase]({api: live, extension, client, ship, origin, record,
      mark: step => {marker = step;},
      observed: (source, status, reason) => {statuses.push({at: Date.now() - started, source, status, ...(reason === undefined ? {} : {reason})});},
      timed: async (step, work, limit) => {
        marker = step; const from = Date.now();
        try {return await within(work(), limit, step);} finally {timings[step] = Date.now() - from;}
      }});
    marker = 'receipt';
    fs.writeFileSync(evidence, JSON.stringify({passed: true, actualPlanetPicker: true, noTypedOrigin: true, ...receipt()}, null, 2), {flag: 'wx', mode: 0o600});
  } catch (error) {
    if (evidence) fs.writeFileSync(evidence, JSON.stringify({passed: false, ...receipt(), marker, failure: error instanceof LiveFailure ? error.reason : undefined,
      diagnostics, errorInfo: errorInfo(error, connected), error: 'Live acceptance phase failed; private error details omitted.'}, null, 2), {flag: 'wx', mode: 0o600});
    throw Error('Live acceptance phase failed; see the redacted phase receipt.');
  } finally {
    try {api?.dispose(); await config.update('callNotifications', previous, vscode.ConfigurationTarget.Global);}
    catch {throw Error('Live acceptance cleanup failed; private details omitted.');}
  }
}
