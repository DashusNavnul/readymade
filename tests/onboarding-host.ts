import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {lstatSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import type {ReadymadeWorkspace} from '../src/extension';
import type {JsonObject} from '../src/protocol';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) { if (await check()) return; await wait(250); }
  throw new Error('Timed out: ' + label);
}
class CDP {
  private count = 0;
  private readonly pending = new Map<number, { resolve(value: JsonObject): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private readonly events: vscode.Disposable;
  private sessionId?: string;
  constructor(private readonly channel: vscode.BrowserCDPSession) {
    this.events = channel.onDidReceiveMessage(message => {
      const row = message as { id?: number; error?: unknown; result?: JsonObject };
      if (typeof row.id !== 'number') return;
      const item = this.pending.get(row.id); if (!item) return;
      this.pending.delete(row.id); clearTimeout(item.timer);
      if (row.error) item.reject(new Error('CDP request refused')); else item.resolve(row.result ?? {});
    });
  }
  async request(method: string, params: JsonObject = {}, target = this.sessionId): Promise<JsonObject> {
    const id = ++this.count;
    const reply = new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP response expired: ' + method)); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
    });
    await this.channel.sendMessage({ id, method, params, ...(target ? { sessionId: target } : {}) }); return reply;
  }
  async attach(url: string): Promise<void> {
    const result = await this.request('Target.getTargets');
    const targets = result.targetInfos as { type: string; url: string; targetId: string }[];
    const target = targets.find(t => t.type === 'page' && t.url === url); assert.ok(target, 'Managed page CDP target');
    const attached = await this.request('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    this.sessionId = String(attached.sessionId);
  }
  async evaluate<T>(expression: string): Promise<T> {
    const reply = await this.request('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (reply.exceptionDetails) throw new Error('Managed page evaluation failed');
    return (reply.result as JsonObject).value as T;
  }
  async close(): Promise<void> { this.events.dispose(); await this.channel.close(); }
}

interface Display {project: string; workspace: string; detail: string; hash: string}
interface Layout {width: number; client: number; scroll: number; controls: {tag: string; width: number; client: number; scroll: number}[]}

function workspaceState(value: unknown): {rows: JsonObject[]; selected?: JsonObject} {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  const state = value as JsonObject;
  assert.ok(Array.isArray(state.rows));
  for (const row of state.rows) assert.ok(row && typeof row === 'object' && !Array.isArray(row));
  if (state.selected != null) assert.ok(typeof state.selected === 'object' && !Array.isArray(state.selected));
  return {rows: state.rows as JsonObject[], selected: state.selected as JsonObject | undefined};
}

// Uses an existing ready workspace. Page requests cannot submit mutations.
export async function run(): Promise<void> {
  const evidence = process.env.READYMADE_HOST_EVIDENCE!;
  let api: ReadymadeWorkspace | undefined, channel: CDP | undefined, events: vscode.Disposable | undefined;
  const writes: string[] = [], errors: string[] = [];
  try {
    const authPath = process.env.READYMADE_LIVE_AUTH, installed = process.env.READYMADE_BUILTIN_EXTENSION;
    const ship = process.env.READYMADE_EXPECTED_SHIP, project = process.env.READYMADE_LIVE_PROJECT;
    const working = process.env.READYMADE_WORKING_DESK;
    assert.ok(authPath && installed && ship && project && working, 'Supply private auth, installed extension, ship, project and working desk');
    const info = lstatSync(authPath);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.equal(info.mode & 0o777, 0o600); assert.equal(info.uid, process.getuid?.());
    const auth = JSON.parse(readFileSync(authPath, 'utf8')) as {origin: string; code: string};
    assert.equal(typeof auth.origin, 'string'); assert.equal(typeof auth.code, 'string');
    const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace');
    assert.ok(extension); assert.equal(realpathSync(extension.extensionPath), realpathSync(installed));
    api = await extension.activate();
    await api.connect(auth.origin, async origin => {assert.equal(origin, auth.origin); return auth.code;});
    assert.ok(api.client); const client = api.client;
    const initial = await client.codingState(); assert.equal(initial.owner, ship); assert.equal(initial.ready, true);
    const matches = workspaceState(initial.workspaces).rows.filter(row => row.project === project && row.working === working);
    assert.equal(matches?.length, 1, 'Exactly one matching retained workspace');
    const row = matches![0]; assert.equal(row.phase, 'ready'); assert.equal(typeof row.id, 'string');
    const id = row.id as string;
    const before = await client.codingState(id);
    const selected = workspaceState(before.workspaces).selected; assert.ok(selected); assert.equal(selected.ready, true);
    assert.equal(selected.id, id); assert.equal(selected.project, project); assert.equal(typeof selected.holder, 'string');
    assert.ok(selected.accepted && typeof selected.accepted === 'object');
    const acceptedSource = selected.accepted as JsonObject; assert.equal(typeof acceptedSource.desk, 'string');
    assert.ok(Number.isSafeInteger(acceptedSource.number));
    const {NativeMediaBrowser} = await import(join(installed, 'dist/src/media-browser.js')) as typeof import('../src/media-browser');
    const browser = new NativeMediaBrowser(api.media.bridge);
    const bootstrap = 'about:blank#readymade-' + randomBytes(16).toString('hex');
    const tab = await browser.open(bootstrap), raw = await tab.startCDPSession();
    channel = new CDP(raw); const cdp = channel; await cdp.attach(bootstrap);
    events = raw.onDidReceiveMessage(async message => {
      const event = message as {method?: string; params?: {requestId: string; request: {method: string}}};
      if (event.method === 'Runtime.exceptionThrown') errors.push('Page runtime exception');
      if (event.method !== 'Fetch.requestPaused' || !event.params) return;
      const {requestId, request} = event.params;
      try {
        if (!['GET', 'HEAD'].includes(request.method)) {
          writes.push(request.method); await cdp.request('Fetch.failRequest', {requestId, errorReason: 'BlockedByClient'});
        } else await cdp.request('Fetch.continueRequest', {requestId});
      } catch {errors.push('Request interception failed');}
    });
    await cdp.request('Runtime.enable'); await cdp.request('Network.enable');
    await cdp.request('Network.setCookies', {cookies: client.browserCookies(auth.origin).map(cookie => ({...cookie, url: auth.origin, httpOnly: true}))});
    await cdp.request('Fetch.enable', {patterns: [{urlPattern: '*', requestStage: 'Request'}]});
    await cdp.request('Page.navigate', {url: auth.origin + '/apps/pataphor-native/coding'});
    await until(() => cdp.evaluate<boolean>(`[...document.querySelectorAll('#project option')].some(e=>e.value===${JSON.stringify(project)})`), 'native project');
    await cdp.evaluate(`(()=>{const e=document.getElementById('project');e.value=${JSON.stringify(project)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    const selector = '[aria-label="Prepared session workspace"]';
    await until(() => cdp.evaluate<boolean>(`[...document.querySelectorAll(${JSON.stringify(selector + ' option')})].some(e=>e.value===${JSON.stringify(row.id)})`), 'workspace option');
    await cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(row.id)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    const accepted = `Accepted ${acceptedSource.desk} at revision ${acceptedSource.number}`;
    const ready = () => cdp.evaluate<boolean>(`!!document.querySelector('#native-session-workspaces pre')?.textContent.includes(${JSON.stringify(accepted)})`);
    await until(ready, 'native workspace readiness');
    const read = () => cdp.evaluate<Display>(`({project:document.getElementById('project').value,workspace:document.querySelector(${JSON.stringify(selector)}).value,detail:document.querySelector('#native-session-workspaces pre').textContent,hash:location.hash})`);
    const display = await read(); assert.equal(display.project, project); assert.equal(display.workspace, row.id);
    assert.ok(display.detail.includes(`Worker ${selected.holder}`)); assert.ok(display.detail.includes('Ready.'));
    await cdp.evaluate(`window.ReadymadeCodingNavigate('setup')`);
    const layouts: Layout[] = [];
    for (const width of [360, 768, 1280]) {
      await cdp.request('Emulation.setDeviceMetricsOverride', {width, height: 900, deviceScaleFactor: 1, mobile: false}); await wait(300);
      const layout = await cdp.evaluate<Layout>(`(()=>{const r=document.getElementById('native-session-workspaces');return {width:innerWidth,client:r.clientWidth,scroll:r.scrollWidth,controls:[...r.querySelectorAll('select,input,pre,button')].map(e=>({tag:e.tagName,width:e.getBoundingClientRect().width,client:e.clientWidth,scroll:e.scrollWidth}))}})()`);
      assert.equal(layout.width, width); assert.ok(layout.client > 0); assert.ok(layout.scroll <= layout.client + 1, 'Workspace pane overflow');
      for (const control of layout.controls) {assert.ok(control.width <= layout.client + 1, 'Control overflow'); if (control.tag === 'PRE') assert.ok(control.scroll <= control.client + 1, 'Detail overflow');}
      layouts.push(layout);
      const screenshot = await cdp.request('Page.captureScreenshot', {format: 'png'});
      assert.equal(typeof screenshot.data, 'string'); writeFileSync(evidence + `.${width}.png`, Buffer.from(screenshot.data as string, 'base64'), {mode: 0o600});
    }
    const served = await cdp.evaluate<string>(`fetch('/apps/pataphor-native/coding/native-coding-session-workspace.js',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('Script HTTP failure');return r.text()})`);
    const servedSHA256 = createHash('sha256').update(served).digest('hex');
    const manifest = JSON.parse(readFileSync(join(__dirname, '../../backend/assembly-manifest.json'), 'utf8'));
    assert.equal(servedSHA256, manifest.files['ui/native-coding-session-workspace.js'].sha256);
    await cdp.request('Page.reload'); await until(ready, 'reloaded workspace'); assert.deepEqual(await read(), display);
    const after = await client.codingState(id);
    assert.deepEqual(workspaceState(after.workspaces).selected, selected); assert.deepEqual(after.openings, before.openings); assert.deepEqual(after.sessions, before.sessions);
    assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    writeFileSync(evidence, JSON.stringify({passed: true, ship, project, working, workspace: row.id, servedSHA256, layouts,
      reloadRecovered: true, canonicalRecordsUnchanged: true, pageWrites: writes, runtimeErrors: errors,
      scope: 'Existing workspace recovery and responsive layout against installed services; no setup submission or model execution'}, null, 2), {mode: 0o600});
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({passed: false, error: error instanceof Error ? error.message : 'Onboarding check failed', pageWrites: writes, runtimeErrors: errors}), {mode: 0o600});
    throw error;
  } finally {events?.dispose(); if (channel) await channel.close(); api?.dispose();}
}
