import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {writeFileSync, realpathSync} from 'node:fs';
import type {ReadymadeWorkspace} from '../src/extension';

// Live acceptance, in the real app window, that a ship running on this computer is connected with NO question:
// no address box, no login-code box, no list. Any prompt fails the test. Reads only; signs in, changes nothing.
//   READYMADE_LOCAL_SHIP   the ship that must end up connected
//   READYMADE_LOCAL_PHASE  named    a join link named this ship (several ships may be running)
//                          address  only its localhost address was given, as remembered text
//   READYMADE_LOCAL_ORIGIN the address, for the address phase
export async function run(): Promise<void> {
  const evidence: Record<string, unknown> = {passed: false, phase: process.env.READYMADE_LOCAL_PHASE};
  try {
    const ship = process.env.READYMADE_LOCAL_SHIP, phase = process.env.READYMADE_LOCAL_PHASE;
    assert.ok(ship && (phase === 'named' || phase === 'address'), 'configuration');
    const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
    const builtin = !!process.env.READYMADE_BUILTIN_EXTENSION;
    if (builtin) assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION!));
    evidence.ext = builtin ? 'bundled' : 'development';
    const api = await extension.activate();
    assert.equal(api.media.connectedClient, undefined, 'nothing is connected when the app opens in a fresh profile');
    const prompts: string[] = [];
    const window = vscode.window as unknown as Record<string, unknown>;
    for (const name of ['showInputBox', 'showQuickPick']) window[name] = async (...args: unknown[]) => {prompts.push(name + ': ' + JSON.stringify((args[1] ?? args[0] ?? {}) as object).slice(0, 80)); return undefined;};
    const started = Date.now();
    const client = phase === 'named' ? await api.media.connectClient(undefined, undefined, undefined, ship) : await api.media.connectClient(process.env.READYMADE_LOCAL_ORIGIN);
    evidence.milliseconds = Date.now() - started; evidence.prompts = prompts;
    const cookies = client.browserCookies(client.origin);
    assert.deepEqual(prompts, [], 'no prompt of any kind');
    assert.equal(cookies.length, 1); assert.equal(cookies[0].name, 'urbauth-' + ship);
    assert.equal(api.media.connectedLocalPlanet?.ship, ship, 'recognised as a ship on this computer');
    evidence.connected = ship; evidence.signedInByItself = true; evidence.passed = true;
  } catch (error) {evidence.error = error instanceof assert.AssertionError ? error.message : 'failed; private details omitted';}
  if (process.env.READYMADE_HOST_EVIDENCE) writeFileSync(process.env.READYMADE_HOST_EVIDENCE, JSON.stringify(evidence), {mode: 0o600});
  await vscode.commands.executeCommand('workbench.action.closeWindow');
}
