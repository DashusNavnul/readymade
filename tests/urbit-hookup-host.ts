import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {writeFileSync, realpathSync} from 'node:fs';
import type {ReadymadeWorkspace} from '../src/extension';

const tabs = (viewType: string) => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes(viewType));
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!check()) {if (Date.now() >= deadline) throw Error('Did not reach: ' + what); await new Promise(resolve => setTimeout(resolve, 25));}
}
// Packaged-window acceptance for the planet screens. Connects to no ship, starts no planet, installs nothing:
// it opens the real screens in the real app and checks what they show with nothing connected.
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
  const builtin = !!process.env.READYMADE_BUILTIN_EXTENSION;
  if (builtin) assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION!));
  const api = await extension.activate();
  assert.equal(api.client, undefined); assert.equal(api.media.connectedClient, undefined); assert.equal(api.media.connectedLocalPlanet, undefined);
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['readymade.installBackend', 'readymade.startPlanet', 'readymade.getUrbit']) assert.ok(commands.includes(name), name + ' is registered');

  await vscode.commands.executeCommand('readymade.startPlanet');
  await until(() => tabs('readymade.planetBoot').length === 1, 'Start a planet tab');
  await until(() => api.planetBoot.presentation.step !== 'checking', 'Start a planet decided what to show');
  const boot = api.planetBoot.presentation;
  // The packaged app carries the runtime; a development checkout does not.
  assert.equal(boot.step, builtin ? 'choose' : 'unavailable'); assert.equal(boot.busy, false);
  if (builtin) assert.ok(Array.isArray(boot.ships));
  await vscode.commands.executeCommand('readymade.startPlanet');
  assert.equal(tabs('readymade.planetBoot').length, 1, 'Reopening reveals the same tab');

  await vscode.commands.executeCommand('readymade.installBackend');
  await until(() => tabs('readymade.backendInstall').length === 1, 'Install Pataphor tab');
  await until(() => api.backendInstall.presentation.step !== 'checking', 'Install Pataphor decided what to show');
  const install = api.backendInstall.presentation;
  // With the installer bundled and no local ship connected it asks for a connection; it never guesses a ship.
  assert.equal(install.step, builtin ? 'no-ship' : 'unavailable'); assert.equal(install.busy, false); assert.equal(install.ship, undefined);
  const boundary = api.backendInstall as unknown as {panel: vscode.WebviewPanel; receive(panel: vscode.WebviewPanel, message: unknown): Promise<void>};
  for (const message of [{action: 'install'}, {action: 'activate'}, {action: 'install', ship: '~zod'}, {action: 'unknown'}, 'install', null]) await boundary.receive(boundary.panel, message);
  assert.equal(api.backendInstall.presentation.step, install.step, 'No message can start an install without a connected local ship');
  assert.equal(api.media.connectedClient, undefined, 'Nothing was connected');

  await vscode.commands.executeCommand('readymade.getUrbit');
  await until(() => tabs('readymade.planetSetup').length === 1, 'Get an Urbit tab');
  const setup = api.planetSetup as unknown as {panel: vscode.WebviewPanel};
  assert.match(setup.panel.webview.html, /data-action="keyfile"/); assert.match(setup.panel.webview.html, /Start my planet/);

  for (const type of ['readymade.planetBoot', 'readymade.backendInstall', 'readymade.planetSetup']) for (const tab of tabs(type)) assert.equal(await vscode.window.tabGroups.close(tab), true);
  if (process.env.READYMADE_HOST_EVIDENCE) writeFileSync(process.env.READYMADE_HOST_EVIDENCE, JSON.stringify({passed: true, installedExtension: extension.extensionPath, builtin,
    commandsRegistered: true, startPlanetScreen: boot.step, knownShips: boot.ships?.length ?? null, installScreen: install.step, forgedMessagesRefused: true,
    keyfileEntryOnGetAnUrbit: true, shipContacted: false, planetStarted: false}) + '\n');
}
