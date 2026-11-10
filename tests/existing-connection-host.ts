import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {realpathSync, writeFileSync} from 'node:fs';
import type {ReadymadeWorkspace} from '../src/extension';
import {readSavedCode, ShipClientError} from '../src/ship-client';
import {discoverLocalPlanets} from '../src/planet-discovery';

async function until(check: () => boolean, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() >= deadline) throw Error('Existing connection did not reach the required state.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// Root-invoked acceptance against an explicitly selected, already running owned ship.
// Never reads keyfiles or performs source installation, coding or model operations.
export async function run(): Promise<void> {
  const config = vscode.workspace.getConfiguration('readymade');
  const previous = config.inspect<boolean>('callNotifications')?.globalValue;
  let api: ReadymadeWorkspace | undefined, created: string | undefined, phase = 'configuration';
  const diagnostics: {extensionPath?: string; getterPresent?: boolean; independentDiscovery?: Awaited<ReturnType<typeof discoverLocalPlanets>>['diagnostics'][]; discoveryStatus?: ReadymadeWorkspace['media']['localDiscoveryStatus']; observedNamesOrigins: {ship: string; origin: string}[]; count: number; connectingOutcome: string; connectingError?: {name: string; code?: string}} = {observedNamesOrigins: [], count: 0, connectingOutcome: 'not-started'};
  const errorInfo = (error: unknown) => ({name: error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : 'Error',
    ...(error instanceof ShipClientError && /^[A-Za-z]{1,64}$/.test(error.code) ? {code: error.code} : {})});
  const evidence = process.env.READYMADE_HOST_EVIDENCE;
  try {
    const origin = process.env.READYMADE_LIVE_ORIGIN, owner = process.env.READYMADE_EXPECTED_SHIP;
    assert.ok(origin && owner && evidence);
    assert.equal(new URL(origin).origin, origin);
    assert.match(owner, /^~[a-z-]{3,128}(?![\s\S])/);
    const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace');
    assert.ok(extension);
    diagnostics.extensionPath = extension.extensionPath;
    if (process.env.READYMADE_BUILTIN_EXTENSION) assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
    await config.update('callNotifications', false, vscode.ConfigurationTarget.Global);
    api = await extension.activate();
    diagnostics.getterPresent = 'localPlanets' in api.media;
    assert.equal(api.client, undefined); assert.equal(api.media.connectedClient, undefined);
    assert.equal(api.media.controller?.state().length ?? 0, 0);
    diagnostics.independentDiscovery = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      phase = 'local-discovery-' + attempt;
      const discovered = await discoverLocalPlanets();
      diagnostics.independentDiscovery.push(discovered.diagnostics);
      assert.equal(discovered.planets.filter(planet => planet.ship === owner && planet.origin === origin).length, 1);
    }
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('workbench.action.quickOpenSelectNext'));
    assert.ok(commands.includes('workbench.action.acceptSelectedQuickOpenItem'));
    phase = 'picker-start';
    let retainedCode: string | undefined;
    const connecting = api.media.connectClient(undefined, async address => {
      assert.equal(address, origin);
      retainedCode = await readSavedCode(address);
      if (!retainedCode) throw Error('Private saved credentials are unavailable.');
      return retainedCode;
    });
    diagnostics.connectingOutcome = 'pending';
    void connecting.then(() => {diagnostics.connectingOutcome = 'resolved';}, error => {diagnostics.connectingOutcome = 'rejected'; diagnostics.connectingError = errorInfo(error);});
    phase = 'picker-wait-list';
    await until(() => {
      diagnostics.discoveryStatus = api!.media.localDiscoveryStatus;
      const rows = api!.media.localPlanets;
      diagnostics.observedNamesOrigins = rows.map(({ship, origin}) => ({ship, origin})); diagnostics.count = rows.length;
      return rows.some(planet => planet.ship === owner && planet.origin === origin);
    }, 10000);
    phase = 'picker-snapshot';
    const choices = api.media.localPlanets;
    const index = choices.findIndex(planet => planet.ship === owner && planet.origin === origin);
    assert.ok(index >= 0);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.deepEqual(api.media.localPlanets, choices);
    for (let i = 0; i < index; i++) {phase = 'picker-next-' + i; await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');}
    phase = 'picker-accept';
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    phase = 'private-sign-in';
    const client = await connecting;
    assert.ok(client); assert.equal(client.origin, origin);
    const cookies = client.browserCookies(origin);
    assert.equal(cookies.length, 1); assert.equal(cookies[0].name, 'urbauth-' + owner);
    phase = 'setup-pages';
    await api.setup.show(client);
    assert.equal(api.setup.state.ship, owner); assert.equal(api.setup.state.origin, origin);
    await until(() => !api!.setup.state.checking, 31000);
    const report = api.setup.state.report; assert.ok(report);
    assert.equal(report.origin, origin);
    assert.equal(report.checks.find(row => row.name === 'Landscape')?.status, 'observed');
    assert.equal(api.client, undefined); assert.equal(api.media.connectedClient, client);
    const boundary = api.setup as unknown as {panel: vscode.WebviewPanel; receive(panel: vscode.WebviewPanel, message: unknown): Promise<void>};
    const html = boundary.panel.webview.html;
    for (const cookie of cookies) assert.equal(html.includes(cookie.value), false);
    assert.ok(retainedCode); assert.equal(html.includes(retainedCode), false); retainedCode = undefined;
    phase = 'landscape';
    await boundary.receive(boundary.panel, {action: 'landscape'});
    const rows = api.media.controller?.state() ?? [];
    assert.equal(rows.length, 1); created = rows[0].bindingId;
    await until(() => api!.media.controller?.state().some(row => row.bindingId === created && row.ready && !row.closed) === true, 30000);
    const row = api.media.controller!.state().find(item => item.bindingId === created)!;
    assert.equal(row.kind, 'landscape'); assert.equal(row.origin, origin);
    assert.equal(row.url, origin + '/apps/landscape/');
    if (row.currentURL) {assert.equal(new URL(row.currentURL).origin, origin); assert.ok(new URL(row.currentURL).pathname.startsWith('/apps/landscape'));}
    assert.equal(api.client, undefined); assert.equal(api.media.connectedClient, client);
    phase = 'close-owned-tab';
    await api.media.controller!.close(created); created = undefined;
    assert.equal(api.media.controller!.state().length, 0);
    writeFileSync(evidence, JSON.stringify({passed: true, fixture: false, actualExistingShipLogin: true, owner, origin,
      actualPlanetPicker: true, selectionVerified: true, noTypedOrigin: true, discoveryStatus: api.media.localDiscoveryStatus,
      landscapeOpened: true, landscapeNativeBindingReady: true, landscapeDOMVerified: false, appOnlyConnection: true,
      noShipInstallation: true, noCodingOrModelExecution: true, callNotificationsDisabled: true,
      onlyCreatedTabClosed: true, secretValuesExcluded: true, checks: report.checks}), {flag: 'wx', mode: 0o600});
  } catch (error) {
    if (evidence) writeFileSync(evidence, JSON.stringify({passed: false, fixture: false, phase, diagnostics, errorInfo: errorInfo(error), error: 'Existing-ship connection acceptance failed; private error details omitted.'}), {flag: 'wx', mode: 0o600});
    throw Error('Existing-ship connection acceptance failed; see the redacted phase receipt.');
  } finally {
    try {
      try {if (created) await api?.media.controller?.close(created);}
      finally {api?.dispose(); await config.update('callNotifications', previous, vscode.ConfigurationTarget.Global);}
    } catch {throw Error('Existing-ship acceptance cleanup failed; private details omitted.');}
  }
}
