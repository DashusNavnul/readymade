import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {writeFileSync, realpathSync, mkdtempSync, chmodSync, existsSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReadymadeWorkspace} from '../src/extension';
import type {GuestServiceSteps} from '../src/project-invitations-view';
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
  const requests: string[] = []; let invitationService = false, joinDispatches = 0;
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === 'POST' && request.url === '/~/login') {
      request.resume(); request.on('end', () => {response.writeHead(204, {'Set-Cookie': 'urbauth-~zod=fixture-session-secret; Path=/'}); response.end();}); return;
    }
    assert.equal(request.method, 'GET');
    if (invitationService && request.url === '/apps/readymade-collab/project-invitation-requests') {
      assert.equal(request.headers['x-readymade-invitation-offset'], '0');
      response.writeHead(200, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({schema: 'readymade-project-invitation-catalog-v1', owner: '~zod', permissionGranted: false, catalog: '0x1', offset: 0, total: 0, next: null, requests: []})); return;
    }
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
    for (const action of ['install', 'signup', 'buyout', 'transfer', 'coding', 'join']) await boundary.receive(boundary.panel, {action});
    await boundary.receive(boundary.panel, {action: 'groups', extra: 'forbidden'});
    assert.equal(requests.length, before); assert.equal(requests.filter(row => row.startsWith('POST ')).length, 1);
    assert.equal(document.getText(), original); assert.equal(document.isDirty, dirty);
    assert.deepEqual(await vscode.commands.executeCommand('vscode.getEditorLayout'), layout);
    assert.equal(api.media.connectedClient, client);
    assert.equal(await vscode.window.tabGroups.close(firstSetup!), true);
    await until(() => panels().length === 0); assert.equal(api.setup.state.origin, undefined);
    // An older collaboration service is updated only after asking, naming the ship it would come from.
    {
      const view = api.invitations as unknown as {guest: GuestServiceSteps; ensureProtocol(client: unknown, actor: string, from: {ship: string; desk: string}): Promise<void>};
      const ship = client as unknown as {guestDeskRead?: () => Promise<{protocol: number}>; guestServiceInstall?: (from: unknown) => Promise<unknown>};
      const steps = view.guest, asked: string[] = [], installs: unknown[] = [], from = {ship: '~nec', desk: 'readymade-peer'};
      let protocol = 0, answer = false;
      ship.guestDeskRead = async () => ({protocol});
      ship.guestServiceInstall = async source => {installs.push(source); protocol = 1; return undefined;};
      view.guest = {...steps, pollMs: 1, deadlineMs: 2000, progress: (_title, work) => work(), confirm: async (detail, title, action) => {asked.push(`${title} | ${action} | ${detail}`); return answer;}};
      try {
        await assert.rejects(view.ensureProtocol(client, '~zod', from), /Not joined: your ship's collaboration service is older/);
        assert.equal(installs.length, 0, 'declining installs nothing'); assert.equal(asked.length, 1);
        assert.match(asked[0], /^Update the collaboration service\? \| Update \| .*install the current one from ~nec \(desk %readymade-peer.*Only do this for a ship you trust/);
        answer = true; await view.ensureProtocol(client, '~zod', from);
        assert.deepEqual(installs, [from]); assert.equal(asked.length, 2);
        await view.ensureProtocol(client, '~zod', from);
        assert.equal(asked.length, 2, 'a current service is not asked about'); assert.equal(installs.length, 1);
      } finally {view.guest = steps; delete ship.guestDeskRead; delete ship.guestServiceInstall;}
    }
    // A result that settles after the first reads is still shown: the app keeps reading by itself and sends nothing again.
    {
      const view = api.invitations as unknown as {guest: GuestServiceSteps; journal: {recover(client: unknown, intent: unknown): Promise<{status: string}>}; observed: Map<string, {status: string}>;
        key(intent: unknown): string; settle(client: unknown, intent: unknown, first: {status: string}): Promise<{status: string}>};
      const steps = view.guest, recover = view.journal.recover, intent = {version: 1, origin: client.origin, actor: '~zod', command: {request: '01234567-89ab-4cde-8fab-0123456789ab', authority: '~nec', project: 'demo', operation: 'leave'}};
      let reads = 0;
      view.journal.recover = async () => ({status: ++reads < 11 ? 'submitted' : 'accepted'});
      view.guest = {...steps, pause: async () => undefined};
      try {
        const first = await view.settle(client, intent, {status: 'submitted'});
        assert.equal(first.status, 'submitted', 'the first eight reads did not settle it'); assert.ok(reads >= 8);
        await until(() => view.observed.get(view.key(intent))?.status === 'accepted');
        assert.equal(reads, 11, 'reading stops once the result is settled');
        await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(reads, 11);
      } finally {view.guest = steps; view.journal.recover = recover; view.observed.delete(view.key(intent));}
    }
    invitationService = true;
    await api.setup.show(client); await until(() => !api.setup.state.checking && !!api.setup.state.report);
    assert.equal(api.setup.state.report!.checks.find(row => row.name === 'Project invitations')!.status, 'observed');
    assert.equal(api.setup.state.report!.owner, undefined); assert.equal(api.client, undefined);
    assert.match(boundary.panel.webview.html, /<button data-action="join">Join a workspace<\/button>/);
    assert.match(boundary.panel.webview.html, /do not need a local coding worker/);
    const originalJoin = api.invitations.join;
    api.invitations.join = async () => {joinDispatches++;};
    try {
      const beforeJoin = requests.length;
      await boundary.receive(boundary.panel, {action: 'join', extra: 'forbidden'});
      await boundary.receive(boundary.panel, {action: 'coding'});
      assert.equal(joinDispatches, 0);
      await boundary.receive(boundary.panel, {action: 'join'});
      assert.equal(joinDispatches, 1, 'Setup dispatches the existing invitation flow without local coding');
      assert.equal(requests.length, beforeJoin, 'The host test traps joining before prompting or sending a command');
    } finally {api.invitations.join = originalJoin;}
    assert.equal(document.getText(), original); assert.equal(document.isDirty, dirty);
    assert.deepEqual(await vscode.commands.executeCommand('vscode.getEditorLayout'), layout);
    assert.equal(api.media.connectedClient, client);
    assert.equal(requests.filter(row => row.startsWith('POST ')).length, 1);
    assert.equal(await vscode.window.tabGroups.close(panels()[0]!), true);
    await until(() => panels().length === 0);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await config.update('callNotifications', previous, vscode.ConfigurationTarget.Global);
  }
  // The command line: a stand-in assistant program answers with one listed command; the typed line reaches it on standard input only.
  const askDir = mkdtempSync(join(tmpdir(), 'rm-ask-')), fake = join(askDir, 'claude'), seen = join(askDir, 'seen.txt');
  const canned = (plan: unknown) => JSON.stringify({type: 'result', is_error: false, result: JSON.stringify(plan)});
  const answerWith = (plan: unknown) => {writeFileSync(fake, `#!/bin/sh\ncat > '${seen}'\nprintf '%s' '${canned(plan)}'\n`); chmodSync(fake, 0o755);};
  const settings = vscode.workspace.getConfiguration('readymade'), earlier = settings.inspect<string>('assistantPath')?.globalValue;
  await settings.update('assistantPath', fake, vscode.ConfigurationTarget.Global);
  try {
    await vscode.commands.executeCommand('readymade.home'); await until(() => homes().length === 1);
    const line = api.home as unknown as {panel: vscode.WebviewPanel; reply: string; error: string; busy: boolean; receive(panel: vscode.WebviewPanel, message: unknown): Promise<void>};
    assert.match(line.panel.webview.html, /<input id="ask" type="text" maxlength="500"/);
    answerWith({say: 'Opening Home.', steps: [{command: 'readymade.home', args: []}]});
    for (const bad of [{ask: 'go home', extra: 1}, {ask: 7}, {ask: '   '}, {ask: 'a\nb'}, {ask: 'x'.repeat(501)}]) await line.receive(line.panel, bad);
    assert.equal(existsSync(seen), false, 'a malformed message starts nothing');
    await line.receive(line.panel, {ask: '  go home  '});
    assert.equal(readFileSync(seen, 'utf8'), 'go home'); assert.equal(line.error, ''); assert.equal(line.reply, 'Opening Home.\nRan: Home'); assert.equal(line.busy, false);
    answerWith({say: 'x', steps: [{command: 'workbench.action.closeWindow', args: []}]});
    await line.receive(line.panel, {ask: 'close the window'});
    assert.match(line.error, /named a command Readymade does not offer here\)\. Nothing was run\.$/); assert.equal(line.reply, '');
    answerWith({say: 'x', steps: [{command: 'readymade.inviteAndCopyLink', args: ['~sampel-palnet']}]});
    await line.receive(line.panel, {ask: 'invite someone'});
    assert.match(line.error, /a ship you did not type\)\. Nothing was run\.$/);
    assert.equal(homes().length, 1);
  } finally {await settings.update('assistantPath', earlier, vscode.ConfigurationTarget.Global); rmSync(askDir, {recursive: true, force: true});}
  if (process.env.READYMADE_HOST_EVIDENCE) writeFileSync(process.env.READYMADE_HOST_EVIDENCE, JSON.stringify({passed: true, installedExtension: extension.extensionPath, actualHomeCommand: true, singleton: true, reopen: true, dirtyEditorPreserved: true, layoutPreserved: true, startupDoesNotStealExistingEditor: true, noAutomaticConnection: true, appOnlyConnectionRetained: true, missingCodingDoesNotLogout: true, unsupportedActionsRefused: true, guestJoinWithoutLocalCoding: true, joinDispatches, joinSubmissionTrapped: true, fixture: true, nativeCalls: 0, buttonDispatchTested: false, serializedRestartTested: false}), {flag: 'wx', mode: 0o600});
}
