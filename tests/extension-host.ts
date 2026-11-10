import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReadymadeWorkspace } from '../src/extension';
import { DraftStore } from '../src/draft-store';
import { snapshotFrom } from '../src/source-store';
import { DraftReviewView, readDraftReviewContext } from '../src/draft-review-view';
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
  return { owner: '~zod', ready: true, nonce: '0v1', cursor: '0x1', session, after: 0, projects: [{id: 'demo', title: 'Demo'}, {id: 'empty', title: 'No sessions yet'}, {id: 'other', title: 'Other project'}], sessions: [{ id: '0x1', project: 'demo', source: basis }, {id: '0x2', project: 'other', source: basis}], records: [record] };
}
async function fixtureAcceptance(api: ReadymadeWorkspace): Promise<JsonObject> {
  const requests: string[] = [];
  let pageLoaded = false;
  let listed = false;
  const pagedState = (session: string): CodingSnapshot => {
    const result = fixture(session), base = result.records[0];
    const record = (last: boolean): JsonObject => {
      const row = structuredClone(base), file = row.file as JsonObject, value = file.value as JsonObject;
      Object.assign(value, {path: '/lib/paged/hoon', total: 2, start: last ? 2 : 1,
        text: last ? 'last\n' : 'first\n', bytes: last ? 5 : 6, next: last ? null : 2});
      row.id = last ? '0x12' : '0x11'; row.sequence = last ? 2 : 1;
      const parsed = JSON.parse(row.text as string); parsed.output = {kind: 'read', ...value}; row.text = JSON.stringify(parsed);
      return row;
    };
    result.records.push(record(false)); if (pageLoaded) result.records.push(record(true)); return result;
  };
  const directoryState = (session: string): CodingSnapshot => {
    const state = pagedState(session); if (!listed) return state;
    const source = state.sessions[0].source, request = '0x456';
    const entries = ['/lib/test/hoon', '/lib/paged/hoon'].map(path => ({path, mark: 'hoon', blob: '0x99'}));
    state.records.push({id: '0x20', sequence: 3, kind: 'tool', text: JSON.stringify({version: 'native-coding-tool-result-v1', call_id: request,
      context: {session: '0x1', request, project: 'demo', source}, output: {kind: 'list', entries: entries.map(e => ({...e, bytes: null})), next: null}}),
      file: {kind: 'list', session: '0x1', request, callId: request, source, value: {entries, next: null}}});
    for (const historical of [false, true]) {
      const checked = historical ? {...source as JsonObject, id: '0xdef', commit: '0v3'} : source;
      const checkRequest = historical ? '0x999' : '0x998', sequence = historical ? 4 : 5;
      const value = {name: 'compile', passed: !historical, detail: historical ? 'Old compiler failure' : 'Native fixture compile passed', source: checked, artifacts: ['0x123']};
      state.records.push({id: checkRequest, sequence, kind: 'tool', text: JSON.stringify({version: 'native-coding-tool-result-v1', call_id: checkRequest,
        context: {project: 'demo', session: '0x1', request: checkRequest, configuration: '0x3', source: checked}, output: {kind: 'diagnostics', values: [value]}}),
        file: {version: 'native-coding-problems-v1', kind: 'diagnostics', project: 'demo', session: '0x1', configuration: '0x3', request: checkRequest,
          callId: checkRequest, recordedAt: '~2026.11.4', source: checked, value: {values: [value]}}});
    }
    state.records.sort((a, b) => Number(a.sequence) - Number(b.sequence));
    state.after = 6; state.more = false; state.reset = false;
    return state;
  };
  const state = { phase: 2, generation: 7, inputNext: 3, offset: 4, connected: true, nonce: '0v1', cursor: '0v2', control: { revision: 5, viewer: '' }, driver: { revision: '0', fault: null } };
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`); response.setHeader('Content-Type', 'application/json');
    if (request.url === '/~/login' && request.method === 'POST') {
      request.resume(); response.writeHead(204, { 'Set-Cookie': 'urbauth-~zod=fixture; Path=/; HttpOnly', Location: '/' }); response.end(); return;
    }
    if (request.url === '/apps/glurff/' || request.url === '/apps/noltbook/' || request.url === '/apps/landscape/' || request.url === '/apps/groups/' || request.url === '/apps/lattice/app') { assert.equal(request.headers.cookie, 'urbauth-~zod=fixture'); response.setHeader('Content-Type', 'text/html'); response.end('<title>Ship app fixture</title>'); return; }
    if (request.url === '/apps/pataphor-native/coding/action' && request.method === 'POST') {
      let body = ''; request.on('data', chunk => { body += chunk.toString(); });
      request.on('end', () => {
        const input = JSON.parse(body);
        if (process.env.READYMADE_TEST_DIRECTORY_CHOOSER === '1') writeFileSync(process.env.READYMADE_HOST_EVIDENCE! + '.fixture-action.json', JSON.stringify({input, listed, interactive: process.env.READYMADE_TEST_DIRECTORY_CHOOSER}), {mode: 0o600});
        if (input.kind === 'terminal' && input.session === '0x1' && input.source === '0xabc' && input.input === (process.env.READYMADE_TEST_DIRECTORY_CHOOSER === '1' ? '/list / 0 64' : '/list /lib 0 64') && !listed) {
          listed = true; const reply = directoryState('0x1');
          reply.commandReceipt = {version: 'native-coding-command-receipt-v1', target: 'viki', session: '0x1', source: '0xabc', request: '0x456'};
          response.end(JSON.stringify(reply)); return;
        }
        if (input.kind !== 'terminal' || input.session !== '0x1' || input.source !== '0xabc' || input.input !== '/read /lib/paged/hoon 2 200' || pageLoaded) {
          response.writeHead(400); response.end('{}'); return;
        }
        pageLoaded = true; response.end(JSON.stringify(pagedState('0x1')));
      }); return;
    }
    if (request.method !== 'GET') { response.writeHead(500); response.end('{}'); return; }
    if (request.url?.startsWith('/apps/pataphor-native/coding/state?')) response.end(JSON.stringify(directoryState(request.url.split('?')[1]!.split('&')[0]!)));
    else if (request.url === '/apps/pataphor-native/coding/completion?session=0x1') response.end(JSON.stringify({available: true, session: '0x1', campaigns: [], ownerReceipt: null, proposal: {ready: false, reason: 'completion-pending-work', value: null}}));
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
    const foreign = api.drafts.create(snapshotFrom({origin: 'http://127.0.0.1:1', ship: '~nec', session: '0x1', source: {id: '0xabc', owner: '~nec', desk: 'fixture', number: 1, root: '0v1', commit: '0v2'}, path: '/lib/test/hoon', blob: '0x99', mark: 'hoon', text: 'foreign\n'}));
    api.drafts.save(foreign.id, 'private foreign edit\n');
    api.changes.refresh({origin: foreign.snapshot.origin, ship: '~nec', project: 'demo', sessions: new Map([['0x1', 'demo']])});
    assert.equal(api.changes.changes.resourceStates.length, 1);
    const [shared, concurrent] = await Promise.all([api.media.connectClient(origin, async () => 'fixture-code'), api.media.connectClient(origin, async () => 'fixture-code')]);
    assert.equal(api.changes.changes.resourceStates.length, 0, 'A media-only login must hide another ship’s retained Changes');
    await assert.rejects(api.changes.review(foreign.id), /context/);
    assert.equal(shared, concurrent, 'Concurrent app/workspace authentication must share one session');
    await api.connect(origin, async () => { throw new Error('A second login was requested'); });
    assert.equal(api.client, shared);
    const launch = vscode.window.createTerminal({ name: 'Landscape command proof', shellPath: '/bin/zsh', shellArgs: ['-f', '-c', 'landscape'] });
    try { await until(() => !!api.media.controller?.state().some(s => s.kind === 'landscape' && s.ready), 30000); }
    finally { launch.dispose(); }
    assert.ok(requests.includes('GET /apps/landscape/'), 'Typing landscape must open the authenticated app');
    const groupsTerminal = vscode.window.createTerminal({ name: 'Groups command proof', shellPath: '/bin/zsh', shellArgs: ['-f', '-c', 'groups'] });
    try { await until(() => !!api.media.controller?.state().some(s => s.kind === 'groups' && s.ready), 30000); }
    finally { groupsTerminal.dispose(); }
    assert.ok(requests.includes('GET /apps/groups/'), 'Typing groups must open the authenticated Tlon app');
    const groupState = api.media.controller!.state().find(s => s.kind === 'groups')!;
    const groupsLoads = requests.filter(r => r === 'GET /apps/groups/').length;
    const reopened = await vscode.commands.executeCommand('readymade.groups') as {bindingId: string};
    assert.equal(reopened.bindingId, groupState.bindingId);
    assert.equal(requests.filter(r => r === 'GET /apps/groups/').length, groupsLoads, 'Groups must reuse its page without reload');
    const latticeTerminal = vscode.window.createTerminal({ name: 'Lattice command proof', shellPath: '/bin/zsh', shellArgs: ['-f', '-c', 'lattice'] });
    try { await until(() => !!api.media.controller?.state().some(s => s.kind === 'lattice' && s.ready), 30000); }
    finally { latticeTerminal.dispose(); }
    assert.ok(requests.includes('GET /apps/lattice/app'), 'Typing lattice must open the authenticated editor');
    const latticeState = api.media.controller!.state().find(s => s.kind === 'lattice')!;
    const latticeLoads = requests.filter(r => r === 'GET /apps/lattice/app').length;
    const latticeAgain = await vscode.commands.executeCommand('readymade.lattice') as {bindingId: string};
    assert.equal(latticeAgain.bindingId, latticeState.bindingId);
    assert.equal(requests.filter(r => r === 'GET /apps/lattice/app').length, latticeLoads);
    for (const app of ['glurff', 'noltbook'] as const) {
      const terminal = vscode.window.createTerminal({name: app + ' command proof', shellPath: '/bin/zsh', shellArgs: ['-f', '-c', app]});
      try { await until(() => !!api.media.controller?.state().some(state => state.kind === app && state.ready), 30000); }
      finally { terminal.dispose(); }
      const route = 'GET /apps/' + app + '/';
      assert.ok(requests.includes(route), 'Terminal command opens the authenticated app');
      const retained = api.media.controller!.state().find(state => state.kind === app)!;
      const loads = requests.filter(request => request === route).length;
      const reopened = await vscode.commands.executeCommand('readymade.' + app) as {bindingId: string};
      assert.equal(reopened.bindingId, retained.bindingId);
      assert.equal(requests.filter(request => request === route).length, loads, 'App command retains its page without reload');
    }
    await api.selectProject('demo'); await api.refresh('0x1');
    await api.selectProject('other'); await api.refresh('0x2');
    const beforeSwitch = requests.length;
    await api.selectProject('demo'); assert.equal(api.client!.snapshot!.session, '0x1');
    await api.selectProject('other'); assert.equal(api.client!.snapshot!.session, '0x2');
    assert.ok(requests.slice(beforeSwitch).every(request => request.startsWith('GET ')), 'Returning to a project only observes its session');
    const client = api.client!, workspaceState = client.workspaceState.bind(client);
    let releaseRefresh!: () => void, enteredRefresh!: () => void;
    const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
    const refreshEntered = new Promise<void>(resolve => { enteredRefresh = resolve; });
    client.workspaceState = async (...args) => { enteredRefresh(); await heldRefresh; return workspaceState(...args); };
    const staleRefresh = api.refresh('0x2'); await refreshEntered;
    await api.selectProject('demo'); releaseRefresh(); await staleRefresh;
    client.workspaceState = workspaceState;
    assert.equal(api.project, 'demo', 'An older refresh cannot undo a newer project selection');
    assert.equal(api.client!.snapshot!.session, '0x1');
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
    if (process.env.READYMADE_TEST_DIRECTORY_CHOOSER === '1') {
      const count = requests.length;
      let settled = false, failure: unknown;
      const browsing = vscode.commands.executeCommand('readymade.browseFiles').then(
        () => { settled = true; }, error => { failure = error; settled = true; });
      try {
        await until(() => requests.length > count);
        await delay(500);
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        await delay(500);
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        await until(() => settled, 10000);
        await browsing;
        if (failure) throw failure;
        assert.equal(listed, true, 'Interactive chooser must submit its default root request');
      } finally { await vscode.commands.executeCommand('workbench.action.closeQuickOpen'); }
    } else await vscode.commands.executeCommand('readymade.browseFiles', '0x1', '/lib');
    const root = api.files.rows()[0], lib = root.children!.find(row => row.label === 'lib')!;
    assert.ok(lib); const fileCommand = lib.children!.find(row => row.label === 'test')!.children![0].command!;
    await vscode.commands.executeCommand(fileCommand.command, ...(fileCommand.arguments ?? []));
    assert.equal(vscode.window.activeTextEditor?.document.getText(), 'old\n');
    await vscode.commands.executeCommand('readymade.refreshFiles');
    await vscode.commands.executeCommand('readymade.moreFiles');
    assert.equal(requests.filter(r => r === 'POST /apps/pataphor-native/coding/action').length, 1);
    await api.selectProject('empty'); assert.equal(api.files.rows()[0].children!.length, 1);
    await api.selectProject('demo');
    const partial = api.sources!.progress().find(p => p.path === '/lib/paged/hoon')!;
    assert.equal(partial.next, 2);
    await vscode.commands.executeCommand('readymade.readNextPage', partial.key);
    const paged = api.sources!.sources().find(p => p.path === partial.path)!;
    assert.ok(paged, 'The completed paged source must be retained');
    await until(() => vscode.window.activeTextEditor?.document.uri.toString() === paged.uri);
    assert.equal(vscode.window.activeTextEditor?.document.getText(), 'first\nlast\n');
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(paged.uri))).toString(), 'first\nlast\n');
    await vscode.commands.executeCommand('readymade.readNextPage', partial.key);
    assert.equal(requests.filter(r => r === 'POST /apps/pataphor-native/coding/action').length, 2);
    await vscode.commands.executeCommand('readymade.checks', '0x1');
    const checks = api.checks.rows()[0].children!.filter(row => row.command?.command === 'readymade.showCheck');
    assert.equal(checks.length, 2);
    assert.equal(checks[0].description, 'observed session source'); assert.equal(checks[1].description, 'historical source');
    const checkKey = checks[0].command!.arguments![0] as string;
    await vscode.commands.executeCommand('readymade.showCheck', checkKey);
    const checkDocument = vscode.window.activeTextEditor!.document;
    assert.equal(checkDocument.uri.scheme, 'readymade-checks');
    assert.match(checkDocument.getText(), /Native fixture compile passed/);
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(checkDocument.uri, Buffer.from('forbidden'))));
    const checkText = checkDocument.getText();
    await vscode.commands.executeCommand('readymade.showCheck', checks[1].command!.arguments![0]);
    const historicalCheck = vscode.window.activeTextEditor!.document;
    assert.notEqual(historicalCheck.uri.toString(), checkDocument.uri.toString());
    assert.match(historicalCheck.getText(), /Old compiler failure/);
    assert.equal(checkDocument.getText(), checkText);
    await vscode.commands.executeCommand('readymade.reviewAnswer', '0x1');
    const answerDocument = vscode.window.activeTextEditor!.document;
    assert.equal(answerDocument.uri.scheme, 'readymade-answer-review'); assert.match(answerDocument.getText(), /completion-pending-work/);
    await assert.rejects(api.answerReview.accept(), /ready answer/);
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(answerDocument.uri, Buffer.from('forbidden'))));
    await api.selectProject('empty');
    await until(() => answerDocument.getText().includes('No answer review observed'));
    assert.equal(checkDocument.getText(), checkText);
    assert.match(historicalCheck.getText(), /Old compiler failure/);
    await assert.rejects(api.checks.show(checkKey), /not available/);
    await api.selectProject('demo');
    await draftReviewAcceptance(api);
    await checkProblemsAcceptance(api);
    assert.equal(requests.filter(r => r.startsWith('POST ')).length, 3, 'Only authentication, listing and explicit pagination may POST');
    return { fixture: true, directoryChooser: process.env.READYMADE_TEST_DIRECTORY_CHOOSER === '1', nativeDraftDiff: true, frozenSubmittedDiff: true, offlineReviewRestored: true, projectChangeIsolation: true, glurffTerminalCommand: true, noltbookTerminalCommand: true, appCommandsRetainWithoutReload: true, latticeTerminalCommand: true, latticeRetainedWithoutReload: true, groupsTerminalCommand: true, groupsRetainedWithoutReload: true, landscapeTerminalCommand: true, projectSelection: true, perProjectSessionRestored: true, emptyProjectRetained: true, requestsBrowseWithoutSubmission: true, sharedAuthentication: true, concurrentAuthentication: true, appDisposalPreservesWorkspace: true, readOnlyCanonical: true, draftSaveIsLocal: true, splitEditors: true, diagnostics: true, persistentNativeProblems: true, exactSourceProblemNavigation: true, offlineProblemFallback: true, breakpoints: true, terminalObserveAndCloseOnly: true, requests: requests.length };
  } catch (error) {
    const native = await api.media.bridge.request('status').catch(() => undefined);
    writeFileSync(process.env.READYMADE_HOST_EVIDENCE + '.media', JSON.stringify({records: api.media.controller?.state(), native, requests}, null, 2), {mode: 0o600});
    throw error;
  } finally { api.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function draftReviewAcceptance(api: ReadymadeWorkspace): Promise<void> {
  const draft = api.drafts.list().find(d => d.snapshot.origin === api.client?.origin); assert.ok(draft);
  const context = {origin: draft.snapshot.origin, ship: draft.snapshot.ship, project: 'demo', sessions: new Map([[draft.snapshot.session, 'demo']])};
  api.changes.refresh(context);
  assert.equal(api.changes.changes.resourceStates.length, 1);
  await api.changes.review(draft.id);
  const diff = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(diff instanceof vscode.TabInputTextDiff);
  assert.equal((await vscode.workspace.openTextDocument(diff.original)).getText(), 'old\n');
  assert.equal(diff.modified.toString(), draft.uri);
  await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(diff.original, Buffer.from('forbidden'))));
  const document = await vscode.workspace.openTextDocument(diff.modified);
  const edit = new vscode.WorkspaceEdit(); edit.insert(document.uri, new vscode.Position(0, 0), 'unsaved\n');
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  assert.equal(document.isDirty, true); assert.equal(document.getText(), 'unsaved\nnew\nold\n');
  assert.equal(api.drafts.get(draft.id).text, 'new\nold\n');
  assert.equal((await vscode.workspace.openTextDocument(diff.original)).getText(), 'old\n');
  assert.equal(await document.save(), true);
  const prepared = fixture('0x1');
  prepared.commandReceipt = {version: 'native-coding-command-receipt-v1', target: 'viki', session: '0x1', source: draft.snapshot.source.id, request: '0x777', delivery: '0x888'};
  prepared.delivery = '0x888: submitted; observing native retention';
  await api.drafts.prepare(draft.id, {origin: context.origin, snapshot: prepared, codingTool: async () => prepared});
  const later = new vscode.WorkspaceEdit(); later.insert(document.uri, new vscode.Position(0, 0), 'later\n');
  assert.equal(await vscode.workspace.applyEdit(later), true); assert.equal(await document.save(), true);
  api.changes.refresh(context); await api.changes.review(draft.id, true);
  const submitted = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(submitted instanceof vscode.TabInputTextDiff);
  assert.equal((await vscode.workspace.openTextDocument(submitted.modified)).getText(), 'unsaved\nnew\nold\n');
  assert.equal(api.drafts.get(draft.id).text, 'later\nunsaved\nnew\nold\n');
  await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(submitted.modified, Buffer.from('forbidden'))));
  api.changes.refresh({...context, project: 'empty'});
  assert.equal(api.changes.changes.resourceStates.length, 0);
  assert.equal(api.changes.submitted.resourceStates.length, 0);
  await assert.rejects(api.changes.review(draft.id), /project|context|available|scope/i);
  api.changes.refresh({...context, origin: 'http://127.0.0.1:1'});
  await assert.rejects(api.changes.review(draft.id), /project|context|available|scope/i);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  api.changes.dispose();
  const restored = new DraftReviewView(new DraftStore(api.drafts.directory));
  try {
    const retained = readDraftReviewContext(JSON.parse(JSON.stringify({...context, sessions: [...context.sessions]})));
    assert.ok(retained); assert.equal(readDraftReviewContext({origin: 'https://bad.example/path', ship: '~zod', sessions: []}), undefined);
    restored.refresh(retained); await restored.review(draft.id, true);
    const reopened = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(reopened instanceof vscode.TabInputTextDiff);
    assert.equal((await vscode.workspace.openTextDocument(reopened.original)).getText(), 'old\n');
    assert.equal((await vscode.workspace.openTextDocument(reopened.modified)).getText(), 'unsaved\nnew\nold\n');
  } finally { restored.dispose(); }
}
async function liveAcceptance(api: ReadymadeWorkspace, origin: string): Promise<JsonObject> {
  await api.connect(origin); const client = api.client!;
  if (process.env.READYMADE_LIVE_CHECK_SESSION) {
    const session = process.env.READYMADE_LIVE_CHECK_SESSION, state = await client.codingState(session);
    const selected = state.sessions.find(row => row.id === session); assert.ok(selected);
    await api.selectProject(String(selected.project)); await api.checks.observe(session);
    const reports = api.checks.rows()[0].children!.filter(row => row.command?.command === 'readymade.showCheck');
    assert.ok(reports.length > 0, 'Live session must retain native diagnostics');
    await api.checks.show(reports[0].command!.arguments![0] as string);
    const document = vscode.window.activeTextEditor!.document;
    const report = JSON.parse(document.getText()); assert.equal(report.owner, api.snapshot?.ship);
    assert.equal(report.session, session); assert.ok(report.values.length > 0);
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(document.uri, Buffer.from('forbidden'))));
    await api.answerReview.observe(session);
    const answer = vscode.window.activeTextEditor!.document;
    assert.equal(answer.uri.scheme, 'readymade-answer-review');
    const review = JSON.parse(answer.getText()).evidence;
    assert.equal(review.context.owner, report.owner); assert.equal(review.context.session, session);
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(answer.uri, Buffer.from('forbidden'))));
    const result = {live: true, checksReadOnly: true, ship: report.owner, project: report.project, session, reports: reports.length,
      answerReviewReadOnly: true, answerReady: !!review.proposal, answerReason: review.reason,
      record: report.sequence, source: report.source.id, checks: report.values.map((v: {name: string; passed: boolean}) => ({name: v.name, passed: v.passed}))};
    api.dispose(); return result;
  }
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
    const result = process.env.READYMADE_EVALUATION_TEST === '1' ? await evaluationAcceptance(api) : process.env.READYMADE_AUTH_DISPOSE_TEST === '1' ? await disposalAcceptance(api) : process.env.READYMADE_LIVE_ORIGIN ? await liveAcceptance(api, process.env.READYMADE_LIVE_ORIGIN) : await fixtureAcceptance(api);
    writeFileSync(file, JSON.stringify({ passed: true, host: vscode.version, extension: extension.packageJSON.version, at: new Date().toISOString(), ...result }, null, 2), { mode: 0o600 });
  } catch (error) {
    writeFileSync(file, JSON.stringify({ passed: false, host: vscode.version, error: error instanceof Error ? error.message : String(error) }, null, 2), { mode: 0o600 }); throw error;
  }
}

async function checkProblemsAcceptance(api: ReadymadeWorkspace): Promise<void> {
  const extension = vscode.extensions.getExtension('pataphor.readymade-ship-workspace')!;
  const {CheckView} = await import(join(extension.extensionPath, 'dist/src/check-view.js')) as typeof import('../src/check-view');
  const {CheckDocumentJournal} = await import(join(extension.extensionPath, 'dist/src/check-document-journal.js')) as typeof import('../src/check-document-journal');
  const descriptor = api.sources!.sources().find(row => row.path === '/lib/test/hoon')!;
  const snapshot = api.sources!.openSnapshot(descriptor);
  const journal = new CheckDocumentJournal(mkdtempSync(join(tmpdir(), 'readymade-problems-host-')));
  const text = JSON.stringify({origin: snapshot.origin, owner: snapshot.ship, project: 'demo', session: snapshot.session, sequence: 9, source: snapshot.source,
    values: [{name: 'compile', passed: false, detail: 'nest-fail\n/lib/test/hoon:<[1 2].[1 3]>'}, {name: 'behavior', passed: false, detail: 'Expected result differs; no source position supplied.'}]}, null, 2);
  journal.retain(text); api.checks.dispose();
  let view = new CheckView(() => 'demo', () => {}, journal, async () => snapshot);
  try {
    await until(() => vscode.languages.getDiagnostics().some(([uri]) => uri.scheme === 'readymade-check-source'));
    const [uri, diagnostics] = vscode.languages.getDiagnostics().find(([uri]) => uri.scheme === 'readymade-check-source')!;
    assert.equal(diagnostics[0].range.start.line, 0); assert.equal(diagnostics[0].range.start.character, 1);
    await vscode.commands.executeCommand('workbench.actions.view.problems');
    await vscode.commands.executeCommand('vscode.open', uri, {selection: diagnostics[0].range, preview: false});
    const editor = vscode.window.activeTextEditor!;
    assert.equal(editor.document.getText(), snapshot.text); assert.equal(editor.selection.start.character, 1);
    await vscode.commands.executeCommand('type', {text: 'forbidden'}); assert.equal(editor.document.getText(), snapshot.text); assert.equal(editor.document.isDirty, false);
    const [reportUri, unlocated] = vscode.languages.getDiagnostics().find(([uri, rows]) => uri.scheme === 'readymade-checks' && rows.some(row => row.message.includes('No usable source location')))!;
    assert.match(unlocated[0].message, /no source position supplied/);
    assert.equal((await vscode.workspace.openTextDocument(reportUri)).getText(), text);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors'); await until(() => editor.document.isClosed); view.dispose();
    view = new CheckView(() => undefined, () => {}, new CheckDocumentJournal(journal.directory));
    assert.equal(vscode.languages.getDiagnostics(uri).length, 1);
    await assert.rejects(Promise.resolve(vscode.workspace.openTextDocument(uri)), /unavailable|cannot|Unable/i);
    assert.match(vscode.languages.getDiagnostics(uri)[0].message, /Source unavailable/);
    assert.equal((await vscode.workspace.openTextDocument(reportUri)).getText(), text);
  } finally {view.dispose();}
}


async function evaluationAcceptance(api: ReadymadeWorkspace): Promise<JsonObject> {
  const extension = vscode.extensions.getExtension('pataphor.readymade-ship-workspace')!;
  const {EvaluationStore} = await import(join(extension.extensionPath, 'dist/src/evaluation-store.js')) as typeof import('../src/evaluation-store');
  const {EvaluationView} = await import(join(extension.extensionPath, 'dist/src/evaluation-view.js')) as typeof import('../src/evaluation-view');
  let allowed = false, ready = false, posts = 0, held = false, holdNext = false, release: (() => void) | undefined;
  const requests: string[] = [], text = '|=  [a=@ud b=@ud]\n(mul a b)\n';
  const nativeState = (session: string): CodingSnapshot => {
    const s = fixture(session), source = s.sessions[0].source as JsonObject;
    s.projects = [{id: 'demo', operations: ['read', 'eval']}]; s.sessions = s.sessions.slice(0, 1);
    s.grants = [{id: '0x2', revoked: false, operations: allowed ? ['read', 'eval'] : ['read'], readable: ['/lib']}];
    const read = s.records[0], file = read.file as JsonObject, value = file.value as JsonObject, raw = JSON.parse(read.text as string);
    Object.assign(value, {text, total: 2, lines: 2, bytes: Buffer.byteLength(text)}); raw.output = {kind: 'read', ...value}; read.text = JSON.stringify(raw);
    if (ready) {
      const values = [{name: 'compile', passed: true, detail: 'Native Ford built the selected immutable source revision.', source, artifacts: ['0x11']},
        {name: 'eval', passed: true, detail: 'Result as jam hex: 0x1e50', source, artifacts: ['0x11', '0x22']}];
      s.records.push({id: '0x99', sequence: 1, kind: 'tool', text: JSON.stringify({version: 'native-coding-tool-result-v1', call_id: '0x33',
        context: {project: 'demo', session: '0x1', actor: '~zod', configuration: '0x3', request: '0x33', source}, output: {kind: 'diagnostics', values}}),
        file: {version: 'native-coding-problems-v1', kind: 'diagnostics', project: 'demo', session: '0x1', configuration: '0x3', request: '0x33', callId: '0x33', recordedAt: '~2026.11.9', source, value: {values}}});
    }
    s.after = ready ? 2 : 1; s.more = false; s.reset = false; return s;
  };
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`); response.setHeader('Content-Type', 'application/json');
    if (request.url === '/~/login' && request.method === 'POST') {request.resume(); response.writeHead(204, {'Set-Cookie': 'urbauth-~zod=fixture; Path=/; HttpOnly'}); response.end(); return;}
    if (request.method === 'GET' && request.url?.startsWith('/apps/pataphor-native/coding/state?')) {
      const send = () => response.end(JSON.stringify(nativeState(request.url!.split('?')[1].split('&')[0])));
      if (holdNext) {holdNext = false; held = true; release = send;} else send(); return;
    }
    if (request.method === 'POST' && request.url === '/apps/pataphor-native/coding/action') {
      let body = ''; request.on('data', chunk => {body += chunk.toString();}); request.on('end', () => {
        const command = JSON.parse(body); posts++;
        assert.equal(request.headers.cookie, 'urbauth-~zod=fixture'); assert.equal(command.kind, 'terminal'); assert.equal(command.session, '0x1'); assert.equal(command.source, '0xabc');
        assert.equal(command.input, '/eval /lib/test/hoon 300000\n(. [3 20])'); assert.equal(api.evaluations.store.list().length, 1, 'Intent must survive a process exit before POST');
        response.end(JSON.stringify({...nativeState('0x1'), commandReceipt: {version: 'native-coding-command-receipt-v1', target: 'viki', session: '0x1', source: '0xabc', request: '0x33', delivery: '0x44'}, delivery: '0x44: submitted; observing native retention'}));
      }); return;
    }
    if (request.url === '/apps/pataphor/remote/state.json') {response.end(JSON.stringify({ship: '~zod', observed: 1, cursor: 1, conversation: {entries: []}, seats: [], candidates: []})); return;}
    if (request.url === '/apps/readymade-collab/workspace-requests') {response.end(JSON.stringify({schema: 'readymade-workspace-catalog-v1', owner: '~zod', catalog: '0x1', offset: 0, total: 0, next: null, requests: [], executionAuthorized: false})); return;}
    response.writeHead(404); response.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  let restored: InstanceType<typeof EvaluationView> | undefined;
  try {
    await api.connect(`http://127.0.0.1:${address.port}`, async () => 'fixture-code'); await api.selectProject('demo'); await api.refresh('0x1');
    const source = api.sources!.sources().find(s => s.path === '/lib/test/hoon')!; assert.ok(source);
    await vscode.commands.executeCommand('readymade.openSource', source.uri);
    assert.equal(vscode.window.activeTextEditor!.document.getText(), text);
    await assert.rejects(api.evaluations.run('(. [3 20])'), /grant/); assert.equal(posts, 0); assert.equal(api.evaluations.store.list().length, 0);
    allowed = true; holdNext = true;
    const pending = api.evaluations.run('(. [3 20])'), cancelled = assert.rejects(pending, /context|source/i);
    await until(() => held);
    const otherFile = join(mkdtempSync(join(tmpdir(), 'readymade-evaluation-selection-')), 'selection.txt');
    writeFileSync(otherFile, 'Selection moved during native preflight.', {mode: 0o600});
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(otherFile)));
    release!(); release = undefined; await cancelled; assert.equal(posts, 0); assert.equal(api.evaluations.store.list().length, 0);
    await vscode.commands.executeCommand('readymade.openSource', source.uri);
    await vscode.commands.executeCommand('readymade.runExpression', '(. [3 20])');
    assert.equal(posts, 1); const row = api.evaluations.store.list()[0]; assert.equal(row.phase, 'pending');
    const directory = api.evaluations.store.directory; await vscode.commands.executeCommand('workbench.action.closeAllEditors'); api.evaluations.dispose();
    ready = true;
    restored = new EvaluationView(new EvaluationStore(directory), () => api.client, () => api.project, () => api.sources!.openSnapshot(source), () => {});
    const before = requests.length; await restored.observe(row.id);
    assert.equal(posts, 1); assert.ok(requests.slice(before).length > 0); assert.ok(requests.slice(before).every(r => r.startsWith('GET ')));
    const document = vscode.window.activeTextEditor!.document; assert.equal(document.uri.scheme, 'readymade-evaluation'); assert.match(document.getText(), /\n60\n/);
    assert.match(document.getText(), /Result as jam hex: 0x1e50/); assert.match(document.getText(), /revision 1/);
    const saved = document.getText(); await vscode.commands.executeCommand('type', {text: 'forbidden'}); assert.equal(document.getText(), saved); assert.equal(document.isDirty, false);
    return {fixture: true, runExpression: true, immutableSource: true, deniedGrantBeforePost: true, selectionRaceRefused: true, durableBeforePost: true, readableNativeValue: '60', reopenedGetOnly: true, readOnlyResult: true, evaluationPosts: posts};
  } finally {restored?.dispose(); api.dispose(); release?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
}
