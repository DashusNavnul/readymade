import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {realpathSync, writeFileSync} from 'node:fs';
import type {ReadymadeWorkspace} from '../src/extension';
const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
  tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('readymade.planetSetup'));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!check()) {if (Date.now() >= deadline) throw Error('Planet setup did not reach the expected state.'); await new Promise(resolve => setTimeout(resolve, 25));}
}
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
  if (process.env.READYMADE_BUILTIN_EXTENSION) assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
  const api = await extension.activate();
  const inventory = () => api.planetSetup.inventory;
  assert.equal(api.client, undefined); assert.equal(api.media.connectedClient, undefined);
  assert.equal(inventory(), undefined); assert.equal(tabs().length, 0);
  const document = await vscode.workspace.openTextDocument({content: 'Keep my work\n', language: 'plaintext'});
  await vscode.window.showTextDocument(document, {preview: false});
  const text = document.getText(), layout = await vscode.commands.executeCommand('vscode.getEditorLayout');
  assert.equal(document.isDirty, true);
  const originalFetch = globalThis.fetch;
  let calls = 0, aborted = false;
  globalThis.fetch = async (input, options) => {
    assert.equal(input, 'https://updates.orraah.com/api/planets');
    assert.equal(options?.method, 'GET'); assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'error');
    assert.deepEqual(options?.headers, {Accept: 'application/json'});
    calls++;
    if (calls === 1) return new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {aborted = true; reject(Error('closed'));}, {once: true});
    });
    if (calls === 3) return new Response('unavailable', {status: 503});
    return Response.json({planets: calls === 2 ? [{patp: '~sampel-palnet', status: 'available'}, {patp: '~winter-palnet', status: 'reserved'}] : []});
  };
  try {
    await vscode.commands.executeCommand('readymade.getUrbit'); await until(() => calls === 1 && tabs().length === 1);
    api.planetSetup.refresh(); api.planetSetup.refresh(); assert.equal(calls, 1);
    assert.equal(await vscode.window.tabGroups.close(tabs()[0]), true); await until(() => aborted && tabs().length === 0);
    assert.equal(inventory(), undefined);
    await vscode.commands.executeCommand('readymade.getUrbit'); await until(() => inventory()?.planets.length === 2 && tabs().length === 1);
    assert.equal(tabs().length, 1); const first = tabs()[0];
    const boundary = api.planetSetup as unknown as {panel: vscode.WebviewPanel; openWebsite(uri: vscode.Uri): Promise<boolean>; receive(panel: vscode.WebviewPanel, message: unknown): Promise<void>};
    const external: string[] = [];
    boundary.openWebsite = async uri => {external.push(uri.toString()); return true;};
    const html = boundary.panel.webview.html;
    assert.match(html, /id="checkout" disabled/); assert.match(html, /Paid but no planet key/);
    assert.equal(html.includes('data-action="checkout"'), false);
    assert.equal(html.includes('store/checkout/planet-identity'), false);
    const before = inventory();
    for (const action of ['signup', 'subscribe', 'buyout', 'transfer', 'checkout']) await boundary.receive(boundary.panel, {action});
    assert.equal(calls, 2); assert.deepEqual(inventory(), before); assert.deepEqual(external, []);
    await boundary.receive(boundary.panel, {action: 'support', url: 'https://wrong.invalid'});
    assert.deepEqual(external, []);
    await boundary.receive(boundary.panel, {action: 'support'});
    assert.deepEqual(external, ['https://www.orraah.com/support']);
    await boundary.receive(boundary.panel, {action: 'setup'});
    assert.deepEqual(external, ['https://www.orraah.com/support', 'https://www.orraah.com/download']);
    assert.equal(api.media.connectedClient, undefined);
    const copy = inventory()!; copy.planets.splice(0); assert.equal(inventory()?.planets.length, 2);
    await vscode.commands.executeCommand('readymade.getUrbit'); await until(() => calls === 3);
    assert.equal(tabs().length, 1); assert.equal(tabs()[0], first);
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(inventory(), undefined);
    assert.equal(await vscode.window.tabGroups.close(first), true); await until(() => tabs().length === 0);
    await vscode.commands.executeCommand('readymade.getUrbit'); await until(() => inventory() !== undefined && tabs().length === 1);
    assert.deepEqual(inventory()?.planets, []);
    assert.equal(calls, 4); assert.equal(document.getText(), text); assert.equal(document.isDirty, true);
    assert.deepEqual(await vscode.commands.executeCommand('vscode.getEditorLayout'), layout);
    assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === document.uri.toString())));
    assert.equal(api.client, undefined); assert.equal(api.media.connectedClient, undefined);
    if (process.env.READYMADE_HOST_EVIDENCE) writeFileSync(process.env.READYMADE_HOST_EVIDENCE, JSON.stringify({passed: true,
      installedExtension: extension.extensionPath, fixtureCatalog: true, liveProvider: false, singleton: true,
      closeAborts: true, reopen: true, emptySuccess: true, failureClearsInventory: true, inventoryCopyIsolated: true,
      unsupportedSignupBillingAndTransferMessagesIgnored: true, checkoutDisabled: true, staleCheckoutMessageRefused: true,
      fixedRecoveryAndSetupDispatch: true, fixtureExternalOpener: true, externalSitesActuallyOpened: false,
      dirtyEditorPreserved: true, layoutPreserved: true, noAutomaticConnection: true, purchaseAttempted: false}), {flag: 'wx', mode: 0o600});
  } finally {globalThis.fetch = originalFetch; for (const tab of tabs()) await vscode.window.tabGroups.close(tab);}
}
