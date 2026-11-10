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


// Observe a completed import and validate its saved local archive; never submit.
export async function run(): Promise<void> {
  const evidence = process.env.READYMADE_HOST_EVIDENCE!;
  let api: ReadymadeWorkspace | undefined, channel: CDP | undefined, events: vscode.Disposable | undefined;
  const writes: string[] = [], errors: string[] = [];
  try {
    const authPath = process.env.READYMADE_LIVE_AUTH, installed = process.env.READYMADE_BUILTIN_EXTENSION;
    const ship = process.env.READYMADE_EXPECTED_SHIP, desk = process.env.READYMADE_IMPORT_DESK;
    const archivePath = process.env.READYMADE_SOURCE_ARCHIVE;
    assert.ok(authPath && installed && ship && desk && archivePath, 'Supply auth, installed extension, ship, import desk and source archive');
    const info = lstatSync(authPath);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.equal(info.mode & 0o777, 0o600); assert.equal(info.uid, process.getuid?.());
    const archiveInfo = lstatSync(archivePath);
    assert.ok(archiveInfo.isFile() && !archiveInfo.isSymbolicLink() && archiveInfo.size > 0 && archiveInfo.size <= 16 * 1024 * 1024,
      'This rendered check accepts regular archives up to 16 MiB');
    const archiveText = readFileSync(archivePath, 'utf8');
    const archive = JSON.parse(archiveText) as {files: {source: string; path: string; mark: string; size: number; sha256: string}[]};
    assert.ok(Array.isArray(archive.files) && archive.files.length > 0);
    const auth = JSON.parse(readFileSync(authPath, 'utf8')) as {origin: string; code: string};
    assert.equal(typeof auth.origin, 'string'); assert.equal(typeof auth.code, 'string');
    const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace');
    assert.ok(extension); assert.equal(realpathSync(extension.extensionPath), realpathSync(installed));
    api = await extension.activate();
    await api.connect(auth.origin, async origin => {assert.equal(origin, auth.origin); return auth.code;});
    assert.ok(api.client); const client = api.client;
    assert.equal((await client.codingState()).owner, ship);
    const before = await client.requestJSON('/apps/pataphor-native/source-import/state');
    const rows = before.rows as JsonObject[]; assert.ok(Array.isArray(rows));
    const matches = rows.filter(row => row.desk === desk); assert.equal(matches.length, 1);
    const row = matches[0]; assert.equal(row.complete, true); assert.equal(row.phase, 'confirmed');
    assert.equal(row.cursor, archive.files.length); assert.equal(row.total, archive.files.length);
    const metadata = archive.files.map(({source: _source, ...meta}) => meta);
    assert.deepEqual(row.files, metadata);
    const {NativeMediaBrowser} = await import(join(installed, 'dist/src/media-browser.js')) as typeof import('../src/media-browser');
    const browser = new NativeMediaBrowser(api.media.bridge), bootstrap = 'about:blank#readymade-' + randomBytes(16).toString('hex');
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
    await cdp.request('Page.navigate', {url: auth.origin + '/apps/pataphor-native/source-import'});
    const load = async (text: string) => {
      await until(() => cdp.evaluate<boolean>(`!!document.querySelector('#native-source-import input')&&!document.querySelector('#native-source-import input').disabled`), 'archive input');
      await cdp.evaluate(`(()=>{const e=document.querySelector('#native-source-import input'),d=new DataTransfer();d.items.add(new File([${JSON.stringify(text)}],'source.json',{type:'application/json'}));e.files=d.files;e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
      await until(() => cdp.evaluate<boolean>(`!document.querySelector('#native-source-import input').disabled`), 'local archive validation');
    };
    const select = async () => {
      await until(() => cdp.evaluate<boolean>(`[...document.querySelectorAll('#native-source-import select')[1].options].some(o=>o.value===${JSON.stringify(row.id)})`), 'retained import');
      await cdp.evaluate(`(()=>{const e=document.querySelectorAll('#native-source-import select')[1];e.value=${JSON.stringify(row.id)};e.dispatchEvent(new Event('change'));return true})()`);
    };
    const display = () => cdp.evaluate<{detail: string; paths: string[]; resendDisabled: boolean}>(`(()=>{const r=document.getElementById('native-source-import');return {detail:[...r.querySelectorAll('pre')].at(-1).textContent,paths:[...r.querySelectorAll('tbody tr')].map(t=>t.cells[0].textContent),resendDisabled:[...r.querySelectorAll('button')].find(b=>b.textContent==='Send next part').disabled}})()`);
    await load(archiveText); await select(); const initial = await display();
    assert.ok(initial.detail.includes('The exact ordered source metadata matches'));
    assert.ok(initial.detail.includes('Source import confirmed.')); assert.equal(initial.resendDisabled, true);
    assert.deepEqual(initial.paths, archive.files.map(file => file.path));
    const corrupted = structuredClone(archive); corrupted.files[0].source += 'x';
    await load(JSON.stringify(corrupted));
    assert.ok(await cdp.evaluate<boolean>(`document.querySelector('#native-source-import [role=status]').textContent.startsWith('Archive refused;')`));
    assert.deepEqual(await display(), initial, 'Corrupt archive must preserve the valid package and disabled resend');
    await cdp.request('Page.reload'); await load(archiveText); await select(); assert.deepEqual(await display(), initial);
    const served = await cdp.evaluate<string>(`fetch('/apps/pataphor-native/source-import.js',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('Script unavailable');return r.text()})`);
    const servedSHA256 = createHash('sha256').update(served).digest('hex');
    const manifest = JSON.parse(readFileSync(join(__dirname, '../../backend/assembly-manifest.json'), 'utf8'));
    assert.equal(servedSHA256, manifest.files['ui/native-coding-source-import.js'].sha256);
    const after = await client.requestJSON('/apps/pataphor-native/source-import/state');
    assert.deepEqual(after.rows, before.rows); assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    writeFileSync(evidence, JSON.stringify({passed: true, ship, desk, import: row.id, files: archive.files.length,
      servedSHA256, archiveSHA256: createHash('sha256').update(archiveText).digest('hex'),
      corruptArchiveRefused: true, reloadRecovered: true, resendDisabled: true, nativeRowsUnchanged: true,
      scope: 'Existing completed import and local archive validation; no submission, OS file dialog or model execution'}, null, 2), {mode: 0o600});
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({passed: false, error: error instanceof Error ? error.message : 'Source import check failed', writes, errors}), {mode: 0o600});
    throw error;
  } finally {events?.dispose(); if (channel) await channel.close(); api?.dispose();}
}
