import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReadymadeWorkspace } from '../src/extension';
import type { CodingSnapshot, JsonObject } from '../src/protocol';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, milliseconds = 5000): Promise<void> {
  for (let n = 0; n < milliseconds / 50; n++) { if (predicate()) return; await delay(50); }
  throw new Error('Extension host observation timed out');
}
function fixture(session: string): CodingSnapshot {
  const basis = { id: '0xabc', owner: '~zod', desk: 'fixture', number: 1, root: '0v1', commit: '0v2' };
  const page = { path: '/lib/test/hoon', mark: 'hoon', blob: '0x99', start: 1, total: 1, text: 'old\n', lines: 1, bytes: 4, next: null };
  const record = { kind: 'tool', id: '0x10', sequence: 0,
    text: JSON.stringify({ version: 'native-coding-tool-result-v1', call_id: '0x100', context: { session: '0x1', request: '0x100', source: basis }, output: { kind: 'read', ...page } }),
    file: { kind: 'read', session: '0x1', request: '0x100', callId: '0x100', source: basis, value: page } };
  return { owner: '~zod', ready: true, nonce: '0v1', cursor: '0x1', session, after: 0, projects: [{id: 'demo', title: 'Demo'}, {id: 'empty', title: 'No sessions yet'}], sessions: [{ id: '0x1', project: 'demo', source: basis }], records: [record] };
}
async function fixtureAcceptance(api: ReadymadeWorkspace): Promise<JsonObject> {
  const requests: string[] = [];
  const state = { phase: 2, generation: 7, inputNext: 3, offset: 4, connected: true, nonce: '0v1', cursor: '0v2', control: { revision: 5, viewer: '' }, driver: { revision: '0', fault: null } };
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`); response.setHeader('Content-Type', 'application/json');
    if (request.url === '/~/login' && request.method === 'POST') {
      request.resume(); response.writeHead(204, { 'Set-Cookie': 'urbauth-~zod=fixture; Path=/; HttpOnly', Location: '/' }); response.end(); return;
    }
    if (request.url === '/apps/glurff/' || request.url === '/apps/landscape/') { assert.equal(request.headers.cookie, 'urbauth-~zod=fixture'); response.setHeader('Content-Type', 'text/html'); response.end('<title>Ship app fixture</title>'); return; }
    if (request.method !== 'GET') { response.writeHead(500); response.end('{}'); return; }
    if (request.url?.startsWith('/apps/pataphor-native/coding/state?')) response.end(JSON.stringify(fixture(request.url.split('?')[1]!.split('&')[0]!)));
    else if (request.url === '/apps/readymade-collab/workspace-requests') response.end(JSON.stringify({schema: 'readymade-workspace-catalog-v1', owner: '~zod', catalog: '0x1', offset: 0, total: 0, next: null, requests: [], executionAuthorized: false}));
    else if (request.url === '/apps/pataphor/remote/state.json') response.end(JSON.stringify({ ship: '~zod', observed: 1, cursor: 1, conversation: { entries: [] }, seats: [], candidates: [] }));
    else if (request.url?.endsWith('/state')) response.end(JSON.stringify(state));
    else if (request.url?.includes('/events?')) response.end(JSON.stringify({ state, offset: 4, reset: false, data: request.url.includes('offset=0') ? Buffer.from('old\n').toString('base64') : '' }));
    else { response.writeHead(404); response.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const origin = `http://127.0.0.1:${address.port}`;
    const [shared, concurrent] = await Promise.all([api.media.connectClient(origin, async () => 'fixture-code'), api.media.connectClient(origin, async () => 'fixture-code')]);
    assert.equal(shared, concurrent, 'Concurrent app/workspace authentication must share one session');
    await api.connect(origin, async () => { throw new Error('A second login was requested'); });
    assert.equal(api.client, shared);
    const launch = vscode.window.createTerminal({ name: 'Landscape command proof', shellPath: '/bin/zsh', shellArgs: ['-f', '-c', 'landscape'] });
    try { await until(() => !!api.media.controller?.state().some(s => s.kind === 'landscape' && s.ready), 30000); }
    finally { launch.dispose(); }
    assert.ok(requests.includes('GET /apps/landscape/'), 'Typing landscape must open the authenticated app');
    await api.selectProject('empty'); assert.equal(api.project, 'empty');
    await api.refresh(); assert.equal(api.project, 'empty', 'An empty project must survive a refresh');
    await api.selectProject('demo'); assert.equal(api.project, 'demo');
    await api.workspaceRequests.store!.load();
    assert.equal(api.workspaceRequests.store!.catalog?.total, 0);
    assert.equal(api.workspaceRequests.store!.canSubmit, false);
    await assert.rejects(api.media.connectClient('http://127.0.0.1:1'), /different ship/);
    assert.equal(api.media.connectedClient, shared, 'Rejected ship switch must preserve the shared session');
    const source = api.sources!.sources()[0]; assert.ok(source);
    const canonical = vscode.Uri.parse(source.uri);
    assert.equal(canonical.toString(), source.uri, 'Canonical URI must round-trip through the real editor URI implementation');
    await until(() => vscode.workspace.fs.isWritableFileSystem('urbit-source') !== undefined);
    assert.equal(vscode.workspace.fs.isWritableFileSystem('urbit-source'), false);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(canonical)).toString(), 'old\n');
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(canonical, Buffer.from('forbidden'))));
    await api.openSource(source.uri); assert.equal(vscode.window.activeTextEditor?.document.getText(), 'old\n');
    await vscode.commands.executeCommand('readymade.createDraft');
    const editor = vscode.window.activeTextEditor!; assert.equal(editor.document.uri.scheme, 'readymade-draft');
    const edit = new vscode.WorkspaceEdit(); edit.insert(editor.document.uri, new vscode.Position(0, 0), 'new\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true); assert.equal(await editor.document.save(), true);
    assert.equal(api.drafts.get(editor.document.uri.toString()).text, 'new\nold\n');
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(canonical)).toString(), 'old\n');
    await api.openSource(source.uri); await vscode.commands.executeCommand('workbench.action.splitEditorRight');
    await until(() => vscode.window.visibleTextEditors.length >= 2);
    assert.ok(vscode.window.visibleTextEditors.length >= 2);
    const diagnostic = vscode.languages.createDiagnosticCollection('readymade-host-proof');
    diagnostic.set(canonical, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'fixture diagnostic', vscode.DiagnosticSeverity.Warning)]);
    await until(() => vscode.languages.getDiagnostics(canonical).some(d => d.message === 'fixture diagnostic'));
    assert.ok(vscode.languages.getDiagnostics(canonical).some(d => d.message === 'fixture diagnostic')); diagnostic.dispose();
    const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(canonical, new vscode.Position(0, 0)));
    vscode.debug.addBreakpoints([breakpoint]); assert.ok(vscode.debug.breakpoints.includes(breakpoint)); vscode.debug.removeBreakpoints([breakpoint]);
    const terminal = await api.openTerminal('pataphor-terminal'); assert.ok(terminal);
    await until(() => api.terminals.get(terminal)?.session.state !== undefined);
    assert.equal(api.terminals.get(terminal)!.session.canInput, false);
    terminal.dispose(); await until(() => !api.terminals.has(terminal));
    await vscode.commands.executeCommand('readymade.selectSession', '0x1'); await api.refresh();
    assert.equal(api.project, 'demo', 'Session observation must align the project');
    const app = await api.media.open('glurff'); assert.equal(app.ready, true);
    assert.equal(api.media.connectedClient, api.client, 'Apps reuse the workspace login');
    await api.media.controller!.disconnect(); api.media.dispose();
    await api.client!.workspaceState();
    assert.equal(requests.filter(r => r.startsWith('POST ')).length, 1, 'Apps and workspace must share one authentication POST');
    assert.ok(requests.some(r => r.includes('coding/state?0x1&')));
    return { fixture: true, landscapeTerminalCommand: true, projectSelection: true, emptyProjectRetained: true, requestsBrowseWithoutSubmission: true, sharedAuthentication: true, concurrentAuthentication: true, appDisposalPreservesWorkspace: true, readOnlyCanonical: true, draftSaveIsLocal: true, splitEditors: true, diagnostics: true, breakpoints: true, terminalObserveAndCloseOnly: true, requests: requests.length };
  } finally { api.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function liveAcceptance(api: ReadymadeWorkspace, origin: string): Promise<JsonObject> {
  await api.connect(origin); const client = api.client!;
  let sourceProof: JsonObject | undefined;
  if (process.env.READYMADE_LIVE_SESSION) {
    await api.refresh(process.env.READYMADE_LIVE_SESSION);
    const source = api.sources!.sources()[0]; assert.ok(source, 'Selected live session must retain one complete source file');
    const canonical = vscode.Uri.parse(source.uri);
    await api.openSource(source.uri);
    await until(() => vscode.workspace.fs.isWritableFileSystem('urbit-source') !== undefined);
    assert.equal(vscode.workspace.fs.isWritableFileSystem('urbit-source'), false);
    const bytes = await vscode.workspace.fs.readFile(canonical);
    assert.equal(bytes.byteLength, source.byteLength);
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(canonical, Buffer.from('forbidden'))));
    await vscode.commands.executeCommand('readymade.createDraft');
    const draft = api.drafts.get(vscode.window.activeTextEditor!.document.uri.toString());
    assert.equal(draft.text, Buffer.from(bytes).toString('utf8'));
    sourceProof = { path: source.path, bytes: bytes.byteLength, contentHash: source.contentHash, canonicalReadOnly: true, separateDraft: true };
  }
  const before = await client.requestJSON('/apps/pataphor-terminal/state');
  const terminal = await api.openTerminal('pataphor-terminal'); assert.ok(terminal);
  await until(() => api.terminals.get(terminal)?.session.state !== undefined);
  assert.equal(api.terminals.get(terminal)!.session.canInput, false);
  terminal.dispose(); await until(() => !api.terminals.has(terminal));
  const after = await client.requestJSON('/apps/pataphor-terminal/state');
  assert.equal(after.generation, before.generation); assert.equal(after.phase, before.phase); assert.deepEqual(after.control, before.control);
  const result = { live: true, ship: api.snapshot?.ship, ready: client.snapshot?.ready, projects: client.snapshot?.projects.length,
    sessions: client.snapshot?.sessions.length, terminalGeneration: after.generation, terminalPhase: after.phase, controlPreserved: true, sourceProof };
  api.dispose(); return result;
}
async function disposalAcceptance(api: ReadymadeWorkspace): Promise<JsonObject> {
  let entered = false, release!: (value: string) => void;
  const code = new Promise<string>(resolve => { release = resolve; });
  const pending = api.media.connectClient('http://127.0.0.1:1', async () => { entered = true; return code; });
  const refused = assert.rejects(pending, /closed/);
  await until(() => entered);
  api.media.dispose(); release('fixture-only');
  await refused;
  assert.equal(api.media.connectedClient, undefined);
  await assert.rejects(api.media.connectClient('http://127.0.0.1:1'), /closed/);
  return { disposedDuringLogin: true, lateConnectionRefused: true };
}
export async function run(): Promise<void> {
  const file = process.env.READYMADE_HOST_EVIDENCE ?? join(mkdtempSync(join(tmpdir(), 'readymade-host-')), 'result.json');
  try {
    const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
    if (process.env.READYMADE_BUILTIN_EXTENSION) assert.equal(realpathSync(extension.extensionUri.fsPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
    const api = await extension.activate();
    const result = process.env.READYMADE_AUTH_DISPOSE_TEST === '1' ? await disposalAcceptance(api) : process.env.READYMADE_LIVE_ORIGIN ? await liveAcceptance(api, process.env.READYMADE_LIVE_ORIGIN) : await fixtureAcceptance(api);
    writeFileSync(file, JSON.stringify({ passed: true, host: vscode.version, extension: extension.packageJSON.version, at: new Date().toISOString(), ...result }, null, 2), { mode: 0o600 });
  } catch (error) {
    writeFileSync(file, JSON.stringify({ passed: false, host: vscode.version, error: error instanceof Error ? error.message : String(error) }, null, 2), { mode: 0o600 }); throw error;
  }
}
