import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {writeFileSync, realpathSync} from 'node:fs';
import type {ReadymadeWorkspace} from '../src/extension';

// Live acceptance, in the real app window, that a ship running on this computer is connected with NO question:
// no address box, no login-code box, no list. Any prompt fails the test. Reads only; signs in, changes nothing.
//   READYMADE_LOCAL_SHIP   the ship that must end up connected
//   READYMADE_LOCAL_PHASE  named    a join link named this ship (several ships may be running)
//                          address  only its localhost address was given, as remembered text
//                          open     the app just opened: the only running ship connects, or none when unclear
//   READYMADE_LOCAL_ORIGIN the address, for the address phase
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
  const evidence: Record<string, unknown> = {passed: false, phase: process.env.READYMADE_LOCAL_PHASE};
  try {
    const ship = process.env.READYMADE_LOCAL_SHIP, phase = process.env.READYMADE_LOCAL_PHASE;
    assert.ok(ship && (phase === 'named' || phase === 'address' || phase === 'open'), 'configuration');
    const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
    const builtin = !!process.env.READYMADE_BUILTIN_EXTENSION;
    if (builtin) assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION!));
    evidence.ext = builtin ? 'bundled' : 'development';
    const api = await extension.activate();
    const prompts: string[] = [];
    const window = vscode.window as unknown as Record<string, unknown>;
    // In the packaged app this stand-in cannot see the extension's own prompts (separate API objects): there the
    // guard is the phase limit above, since an app waiting for a person never finishes by itself.
    for (const name of ['showInputBox', 'showQuickPick']) window[name] = async (...args: unknown[]) => {prompts.push(name + ': ' + JSON.stringify((args[1] ?? args[0] ?? {}) as object).slice(0, 80)); return undefined;};
    if (phase !== 'open') assert.equal(api.media.connectedClient, undefined, 'nothing is connected when the app opens in a fresh profile');
    if (phase === 'open') {
      // The app has just opened with connecting-on-open allowed (READYMADE_NO_AUTO_CONNECT=0) and no history; the
      // extension is already doing it. READYMADE_LOCAL_SHIP names the ship that must connect by itself, or is
      // "none" when several ships run and nothing is clear to choose: then it must stay disconnected. No prompt.
      const deadline = Date.now() + (ship === 'none' ? 6000 : 20000);
      while (Date.now() < deadline && !(ship !== 'none' && api.media.connectedClient)) await new Promise(resolve => setTimeout(resolve, 100));
      evidence.prompts = prompts; assert.deepEqual(prompts, [], 'no prompt of any kind');
      const now = api.media.connectedClient;
      if (ship === 'none') {assert.equal(now, undefined, 'nothing clear to choose: stays disconnected'); evidence.connected = null;}
      else {assert.equal(now?.browserCookies(now.origin)[0]?.name, 'urbauth-' + ship); assert.equal(api.media.connectedLocalPlanet?.ship, ship); evidence.connected = ship;}
      evidence.passed = true;
      throw new Done();
    }
    const started = Date.now();
    const client = phase === 'named' ? await api.media.connectClient(undefined, undefined, undefined, ship) : await api.media.connectClient(process.env.READYMADE_LOCAL_ORIGIN);
    evidence.milliseconds = Date.now() - started; evidence.prompts = prompts;
    const cookies = client.browserCookies(client.origin);
    assert.deepEqual(prompts, [], 'no prompt of any kind');
    assert.equal(cookies.length, 1); assert.equal(cookies[0].name, 'urbauth-' + ship);
    assert.equal(api.media.connectedLocalPlanet?.ship, ship, 'recognised as a ship on this computer');
    evidence.connected = ship; evidence.signedInByItself = true; evidence.passed = true;
  } catch (error) {if (!(error instanceof Done)) {evidence.error = error instanceof assert.AssertionError ? error.message : 'failed; private details omitted'; evidence.errorCode = (error as {code?: unknown}).code ?? null;
    try {const now = (vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace')!.exports as ReadymadeWorkspace).media.connectedClient; evidence.connectedInstead = now ? now.browserCookies(now.origin)[0]?.name.slice('urbauth-'.length) : null;} catch { /* not connected */ }}}
  if (process.env.READYMADE_HOST_EVIDENCE) writeFileSync(process.env.READYMADE_HOST_EVIDENCE, JSON.stringify(evidence), {mode: 0o600});
  await vscode.commands.executeCommand('workbench.action.closeWindow');
}
