import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {writeFileSync, realpathSync} from 'node:fs';
import type {ReadymadeWorkspace} from '../src/extension';
import * as http from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
const homes = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('readymade.welcome'));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!check()) {if (Date.now() >= deadline) throw Error('Readymade Home did not reach the expected tab state.'); await new Promise(resolve => setTimeout(resolve, 25));}
}
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
  if (process.env.READYMADE_BUILTIN_EXTENSION) assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
  const api = await extension.activate();
  assert.equal(api.client, undefined); assert.equal(api.media.connectedClient, undefined);
  assert.ok(homes().length <= 1);
  await vscode.commands.executeCommand('readymade.home'); await until(() => homes().length === 1);
  for (const tab of homes()) assert.equal(await vscode.window.tabGroups.close(tab), true);
  await until(() => homes().length === 0);
  const document = await vscode.workspace.openTextDocument({content: 'My unfinished project\n', language: 'plaintext'});
  await vscode.window.showTextDocument(document, {preview: false, preserveFocus: false});
  const original = document.getText(), dirty = document.isDirty;
  assert.equal(dirty, true);
  const active = vscode.window.activeTextEditor, layout = await vscode.commands.executeCommand('vscode.getEditorLayout');
  api.home.showOnStartup();
  assert.equal(homes().length, 0); assert.equal(vscode.window.activeTextEditor, active);
  assert.deepEqual(await vscode.commands.executeCommand('vscode.getEditorLayout'), layout);
  await vscode.commands.executeCommand('readymade.home'); await until(() => homes().length === 1);
  const first = homes()[0];
  await vscode.commands.executeCommand('readymade.home'); api.home.refresh(); api.home.refresh();
  assert.equal(homes().length, 1); assert.equal(homes()[0], first);
  assert.equal(document.getText(), original); assert.equal(document.isDirty, dirty);
  assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === document.uri.toString())));
  assert.deepEqual(await vscode.commands.executeCommand('vscode.getEditorLayout'), layout);
  assert.equal(await vscode.window.tabGroups.close(first), true); await until(() => homes().length === 0);
  await vscode.commands.executeCommand('readymade.home'); await until(() => homes().length === 1);
  assert.equal(document.getText(), original); assert.equal(document.isDirty, dirty);
  assert.equal(api.client, undefined); assert.equal(api.media.connectedClient, undefined);
  assert.deepEqual(await vscode.commands.executeCommand('vscode.getEditorLayout'), layout);
  const config = vscode.workspace.getConfiguration('readymade'), previous = config.inspect<boolean>('callNotifications')?.globalValue;
  await config.update('callNotifications', false, vscode.ConfigurationTarget.Global);
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === 'POST' && request.url === '/~/login') {
      request.resume(); request.on('end', () => {response.writeHead(204, {'Set-Cookie': 'urbauth-~zod=fixture-session-secret; Path=/'}); response.end();}); return;
    }
    assert.equal(request.method, 'GET');
    if (['/apps/landscape/', '/apps/glurff/', '/apps/noltbook/', '/apps/groups/', '/apps/lattice/app'].includes(request.url!)) {
      response.writeHead(200, {'Content-Type': 'text/html'}); response.end('<!doctype html><title>Fixture app</title>');
    } else {response.writeHead(404, {'Content-Type': 'application/json'}); response.end('{"error":"missing"}');}
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = await api.media.connectClient(origin, async () => 'fixture-private-code'); assert.ok(client);
    await api.setup.show(client);
    assert.equal(api.setup.state.ship, '~zod'); assert.equal(api.setup.state.origin, origin);
    const panels = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('readymade.setup'));
    await until(() => panels().length === 1); const firstSetup = panels()[0];
    await api.setup.show(client); assert.equal(panels()[0], firstSetup);
    await until(() => !api.setup.state.checking && !!api.setup.state.report);
    assert.equal(api.client, undefined); assert.equal(api.media.connectedClient, client);
    assert.equal(api.setup.state.report!.checks.find(row => row.name === 'Native coding protocol')!.status, 'unverified');
    assert.equal(api.setup.state.report!.checks.filter(row => row.status === 'observed').length, 6);
    const boundary = api.setup as unknown as {panel: vscode.WebviewPanel; receive(panel: vscode.WebviewPanel, message: unknown): Promise<void>};
    assert.match(boundary.panel.webview.html, /Connected as/); assert.match(boundary.panel.webview.html, /Coding needs the Readymade ship-side apps/);
    assert.equal(boundary.panel.webview.html.includes('fixture-session-secret'), false); assert.equal(boundary.panel.webview.html.includes('fixture-private-code'), false);
    const before = requests.length;
    await api.setup.show(); assert.equal(panels()[0], firstSetup);
    for (const action of ['install', 'signup', 'buyout', 'transfer', 'coding']) await boundary.receive(boundary.panel, {action});
    await boundary.receive(boundary.panel, {action: 'groups', extra: 'forbidden'});
    assert.equal(requests.length, before); assert.equal(requests.filter(row => row.startsWith('POST ')).length, 1);
    assert.equal(document.getText(), original); assert.equal(document.isDirty, dirty);
    assert.deepEqual(await vscode.commands.executeCommand('vscode.getEditorLayout'), layout);
    assert.equal(api.media.connectedClient, client);
    assert.equal(await vscode.window.tabGroups.close(firstSetup!), true);
    await until(() => panels().length === 0); assert.equal(api.setup.state.origin, undefined);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await config.update('callNotifications', previous, vscode.ConfigurationTarget.Global);
  }
  if (process.env.READYMADE_HOST_EVIDENCE) writeFileSync(process.env.READYMADE_HOST_EVIDENCE, JSON.stringify({passed: true, installedExtension: extension.extensionPath, actualHomeCommand: true, singleton: true, reopen: true, dirtyEditorPreserved: true, layoutPreserved: true, startupDoesNotStealExistingEditor: true, noAutomaticConnection: true, appOnlyConnectionRetained: true, missingCodingDoesNotLogout: true, unsupportedActionsRefused: true, fixture: true, nativeCalls: 0, buttonDispatchTested: false, serializedRestartTested: false}), {flag: 'wx', mode: 0o600});
}
