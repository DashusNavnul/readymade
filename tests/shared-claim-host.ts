import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {once} from 'node:events';
import type {ReadymadeWorkspace} from '../src/extension';
import type {ShipClient} from '../src/ship-client';

export async function run(): Promise<void> {
  const evidence = process.env.READYMADE_HOST_EVIDENCE!;
  try {
    const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
    assert.ok(process.env.READYMADE_BUILTIN_EXTENSION);
    assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
    const active = await extension.activate();
    for (const name of ['openSharedProject', 'resumeSharedProject', 'refreshSharedProject', 'checkSharedProject', 'openSharedSource']) assert.ok((await vscode.commands.getCommands()).includes('readymade.' + name));
    active.dispose(); // Release registrations before exercising the shipped view with fixture contexts.
    const {WorkspaceRequestView} = await import(join(extension.extensionPath, 'dist/src/workspace-request-view.js')) as typeof import('../src/workspace-request-view');
    const owner = '~zod', directory = mkdtempSync(join(tmpdir(), 'readymade-shared-claim-host-'));
    const row = {requester: '~nec', nonce: '12345678-1234-4234-8234-123456789abc', requestDigest: '0xa', project: 'demo', session: '0xb', status: 'reserved'};
    const detail = {...row, schema: 'readymade-workspace-request-v1', owner, binding: '0xc', generation: '1', authority: owner, noteHost: owner,
      note: 'room', nativeRequest: '0xd', text: 'Fixture request', message: null, sourceDesk: 'demo', sourceRevision: '1', sourceRoot: '0v1', sourceCommit: '0v2',
      evidence: null, retainedOnly: true, executionAuthorized: false, taskCompleted: false, mayResubmit: false, recoveryRequired: false};
    let posts = 0, recoveries = 0;
    const client = {origin: 'https://zod.example', workspaceRequest: async (operation: string) => {
      if (operation === 'submit') {posts++; throw new Error('Fixture response lost');}
      if (operation === 'recover') {recoveries++; return {status: 200, body: {...detail, status: 'recorded', evidence: '0xe'}};}
      if (operation === 'read') return {status: 200, body: detail};
      if (operation === 'catalog') return {status: 200, body: {schema: 'readymade-workspace-catalog-v1', owner, catalog: '0x11', executionAuthorized: false, offset: 0, total: 1, requests: [row], next: null}};
      assert.equal(operation, 'preview');
      return {status: 200, body: {schema: 'readymade-workspace-preview-v1', owner, requester: row.requester, nonce: row.nonce,
        requestDigest: row.requestDigest, scope: '0xf', admission: '0x10', executionAuthorized: false, taskCompleted: false, requiresFreshAdmission: true}};
    }} as unknown as ShipClient;
    for (let window = 0; window < 2; window++) {
      const saved = new Map<string, unknown>(); // A different workspace's memento starts empty.
      const context = {globalStorageUri: vscode.Uri.file(directory), workspaceState: {
        get: (key: string) => saved.get(key), update: async (key: string, value: unknown) => {saved.set(key, value);},
      }} as unknown as vscode.ExtensionContext;
      const view = new WorkspaceRequestView(context, () => {}, async () => {});
      try {
        view.connect(client, owner); const store = view.store!;
        await store.load(); store.select(store.requests[0]); await store.read(); await store.preview(); store.review();
        await assert.rejects(store.submit(), window === 0 ? /response lost/ : /already claimed/);
        assert.equal(store.canRecover, true);
        if (window === 1) {await store.recover(); assert.equal(store.observation?.status, 'recorded');}
      } finally {view.dispose();}
    }
    assert.equal(posts, 1); assert.equal(recoveries, 1);
    const remote = await remoteSourceAcceptance(extension.extensionPath);
    writeFileSync(evidence, JSON.stringify({passed: true, editor: vscode.version, fixture: true, shippedView: true,
      remote, separateWorkspaceMementos: true, submitAttempts: posts, recoveryObservations: recoveries}, null, 2), {mode: 0o600});
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({passed: false, error: String(error), stack: error instanceof Error ? error.stack : undefined}, null, 2), {mode: 0o600}); throw error;
  }
}

async function remoteSourceAcceptance(extensionPath: string) {
  const {RemoteSourceView, sharedProjectLink} = await import(join(extensionPath, 'dist/src/remote-source-view.js')) as typeof import('../src/remote-source-view');
  const {ShipClient} = await import(join(extensionPath, 'dist/src/ship-client.js')) as typeof import('../src/ship-client');
  const {RemoteSuggestionJournal} = await import(join(extensionPath, 'dist/src/remote-suggestion-journal.js')) as typeof import('../src/remote-suggestion-journal');
  const {RemoteDraftStore} = await import(join(extensionPath, 'dist/src/remote-draft-store.js')) as typeof import('../src/remote-draft-store');
  const {RemoteDraftProvider} = await import(join(extensionPath, 'dist/src/remote-draft-provider.js')) as typeof import('../src/remote-draft-provider');
  const {remoteSourceHash} = await import(join(extensionPath, 'dist/src/remote-project-view.js')) as typeof import('../src/remote-project-view');
  const authority = 'pataphor.readymade-ship-workspace', target = {owner: '~zod', project: 'shared-demo', generation: '1', peer: '~nec'};
  const link = vscode.Uri.from({scheme: vscode.env.uriScheme, authority, path: '/shared-project', query: new URLSearchParams(target).toString()});
  for (const uri of [link.with({authority: 'other.extension'}), link.with({fragment: 'x'}), link.with({query: link.query + '&generation=2'}), link.with({query: link.query + '&origin=https://other.example'})]) assert.throws(() => sharedProjectLink(uri, authority));
  let posts = 0, reads = 0, phase = 'ready', suggestionPosts = 0, suggestionRecoveries = 0;
  const viewRequests = new Map<string, string>();
  let suggestionBody: Record<string, string> | undefined;
  const pending = () => ({schema: 'readymade-project-view-result-v1', ...target, request: `0x${posts}`, status: 'pending', reason: 'awaiting-owner',
    deadline: '~2026.11.09..00.00.30', retainedUntil: '~2026.11.09..00.05.30', permissionGranted: false, observation: null});
  const server = createServer((req, res) => {
    req.resume(); res.setHeader('content-type', 'application/json');
    if (req.url === '/~/login') {res.setHeader('set-cookie', 'urbauth-~nec=fixture; Path=/'); res.end('{}'); return;}
    if (req.url === '/apps/readymade-collab/project-suggest' && req.method === 'POST') {
      let body = ''; req.on('data', chunk => {body += chunk.toString();}); req.on('end', () => {suggestionPosts++; suggestionBody = JSON.parse(body); req.socket.destroy();}); return;
    }
    if (req.url === '/apps/readymade-collab/project-suggest-result' && req.method === 'GET') {
      assert.ok(suggestionBody); assert.equal(req.headers['x-readymade-project-suggest-request'], suggestionBody.request);
      res.statusCode = 404; res.end(JSON.stringify({status: 'unknown', message: 'Suggestion not retained; do not resend an unknown outcome.'})); return;
    }
    if (req.url === '/apps/readymade-collab/project-suggest-recover' && req.method === 'POST') {
      let body = ''; req.on('data', chunk => {body += chunk.toString();}); req.on('end', () => {
        assert.ok(suggestionBody); const recovery: Record<string, string> = JSON.parse(body); suggestionRecoveries++;
        const expected: Record<string, string> = {...suggestionBody, schema: 'readymade-project-suggest-recover-v1', grant: '0x1', root: '0x2', snapshotDigest: '0x3'};
        assert.deepEqual(recovery, expected);
        res.statusCode = 202; res.end(JSON.stringify({schema: 'readymade-project-suggest-recovery-result-v1', recovery: true,
          ...target, request: recovery.request, viewRequest: recovery.viewRequest, grant: '0x1', root: '0x2', snapshotDigest: '0x3',
          status: 'watching', reason: 'recovering-receipt', path: recovery.path, sourceHash: remoteSourceHash(recovery.source),
          deadline: pending().deadline, retainedUntil: pending().retainedUntil, permissionGranted: false, committed: false, receiptHash: null}));
      }); return;
    }
    if (req.url === '/apps/readymade-collab/project-suggest-recovery-result' && req.method === 'GET') {
      assert.ok(suggestionBody); assert.equal(req.headers['x-readymade-project-suggest-request'], suggestionBody.request);
      res.end(JSON.stringify({schema: 'readymade-project-suggest-recovery-result-v1', recovery: true, ...target, request: suggestionBody.request, viewRequest: suggestionBody.viewRequest,
        grant: '0x1', root: '0x2', snapshotDigest: '0x3', status: 'recorded', reason: 'suggestion-recorded', path: suggestionBody.path,
        sourceHash: remoteSourceHash(suggestionBody.source), deadline: pending().deadline, retainedUntil: pending().retainedUntil,
        permissionGranted: false, committed: false, receiptHash: '0x4'})); return;
    }
    if (req.url === '/apps/readymade-collab/project-view' && req.method === 'POST') {
      let raw = ''; req.on('data', chunk => {raw += chunk;}); req.on('end', () => {
        posts++; const project = JSON.parse(raw).project; viewRequests.set(`0x${posts}`, project);
        if (phase === 'lost-post') {req.socket.destroy(); return;}
        res.statusCode = 202; res.end(JSON.stringify({...pending(), project}));
      }); return;
    }
    if (req.url === '/apps/readymade-collab/project-view-result' && req.method === 'GET') {
      reads++; const request = String(req.headers['x-readymade-project-view-request']), project = viewRequests.get(request); assert.ok(project);
      const observed = {...pending(), request, project};
      if (phase === 'lost') {req.socket.destroy(); return;}
      if (phase === 'missing') {res.statusCode = 404; res.end(JSON.stringify({status: 'unknown', message: 'Observation not retained; no retry was issued.'})); return;}
      if (phase === 'refused') {res.end(JSON.stringify({...observed, status: 'refused', reason: 'watch-refused'})); return;}
      const text = phase === 'changed' ? 'owner changed source' : posts === 1 ? 'original shared source' : 'new shared source';
      res.end(JSON.stringify({...observed, status: 'ready', reason: 'observed', observation: {owner: target.owner, peer: target.peer, grant: '0x1',
        observedAt: '~2026.11.09', root: '0x2', snapshotDigest: '0x3', desk: 'shared-work', revision: posts === 1 ? '1' : '2', files: [{path: '/lib/shared/hoon', text, hash: remoteSourceHash(text)}]}})); return;
    }
    res.statusCode = 599; res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ShipClient(`http://127.0.0.1:${address.port}`, async () => 'fixture');
  let current: ShipClient | undefined = client;
  const directory = mkdtempSync(join(tmpdir(), 'readymade-remote-draft-host-'));
  let drafts = new RemoteDraftStore(directory), provider = new RemoteDraftProvider(drafts);
  let registrations = [provider, vscode.workspace.registerFileSystemProvider('readymade-remote-draft', provider, {isCaseSensitive: true}),
    vscode.workspace.registerFileSystemProvider('readymade-remote-original', provider, {isCaseSensitive: true, isReadonly: true})];
  let suggestions = new RemoteSuggestionJournal(join(directory, 'suggestions'));
  let view = new RemoteSourceView(authority, () => current, async () => client, () => {}, drafts, suggestions);
  const resumeCommand = vscode.commands.registerCommand('readymade.resumeSharedProject', id => view.resume(String(id)));
  try {
    await client.signIn();
    await assert.rejects(view.open(link.with({query: new URLSearchParams({...target, peer: '~wes'}).toString()})), /for ~wes/); assert.equal(posts, 0);
    await view.open(link); assert.equal(posts, 1); assert.equal(reads, 1); assert.equal(client.snapshot, undefined);
    const first = view.rows()[0].children!.find(row => row.command?.command === 'readymade.openSharedSource')!.command!.arguments![0] as string;
    await view.openFile(first); const document = vscode.window.activeTextEditor!.document;
    assert.equal(document.uri.scheme, 'readymade-remote-source'); assert.equal(document.getText(), 'original shared source');
    await vscode.commands.executeCommand('type', {text: 'forbidden'});
    assert.equal(document.getText(), 'original shared source'); assert.equal(document.isDirty, false);
    assert.equal(view.provideTextDocumentContent(document.uri), 'original shared source');
    await view.refresh(); assert.equal(posts, 2); assert.equal(document.getText(), 'original shared source');
    const next = view.rows()[0].children!.find(row => row.command?.command === 'readymade.openSharedSource')!.command!.arguments![0] as string;
    assert.notEqual(next, first); await view.openFile(next); assert.equal(vscode.window.activeTextEditor!.document.getText(), 'new shared source');
    await view.editDraft('/lib/shared/hoon');
    const draftDocument = vscode.window.activeTextEditor!.document; assert.equal(draftDocument.uri.scheme, 'readymade-remote-draft');
    await vscode.commands.executeCommand('type', {text: 'local edit '}); assert.match(draftDocument.getText(), /local edit/);
    assert.equal(await draftDocument.save(), true);
    const retained = new RemoteDraftStore(directory).get(draftDocument.uri.toString()); assert.equal(retained.text, draftDocument.getText());
    assert.equal(retained.observation.files[0].text, 'new shared source'); assert.equal(posts, 2);
    await view.compare(retained.id); assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputTextDiff)));
    assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.parse(retained.originalUri))).getText(), 'new shared source');
    phase = 'changed'; await assert.rejects(view.sendSuggestion(retained.id), /Reconcile/); assert.equal(suggestionPosts, 0); assert.equal(suggestions.list().length, 0);
    await view.reconcile(retained.id);
    assert.equal(drafts.get(retained.id).text, retained.text); assert.equal(drafts.list().length, 2);
    const reconciled = drafts.list().find(row => row.id !== retained.id)!;
    assert.equal(reconciled.observation.files[0].text, 'owner changed source'); assert.equal(reconciled.text, 'owner changed source');
    assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === reconciled.uri)));
    phase = 'ready'; await assert.rejects(view.sendSuggestion(retained.id)); assert.equal(suggestionPosts, 1);
    assert.equal(suggestions.list()[0].phase, 'unknown');
    const unknownSuggestion = suggestions.list()[0], beforeResume = posts;
    await vscode.window.showTextDocument(draftDocument, {preview: false});
    await vscode.commands.executeCommand('type', {text: 'unsaved after send '});
    const unsavedText = draftDocument.getText(); assert.ok(draftDocument.isDirty);
    view.dispose(); registrations.forEach(item => item.dispose());
    drafts = new RemoteDraftStore(directory); provider = new RemoteDraftProvider(drafts);
    registrations = [provider, vscode.workspace.registerFileSystemProvider('readymade-remote-draft', provider, {isCaseSensitive: true}),
      vscode.workspace.registerFileSystemProvider('readymade-remote-original', provider, {isCaseSensitive: true, isReadonly: true})];
    suggestions = new RemoteSuggestionJournal(join(directory, 'suggestions'));
    view = new RemoteSourceView(authority, () => current, async () => client, () => {}, drafts, suggestions);
    const resumes = view.rows()[0].children!.filter(r => r.command?.command === 'readymade.resumeSharedProject'); assert.equal(resumes.length, 1);
    await vscode.commands.executeCommand(resumes[0].command!.command, ...resumes[0].command!.arguments!);
    assert.equal(posts, beforeResume + 1); assert.equal(suggestionPosts, 1); assert.deepEqual(suggestions.list()[0], unknownSuggestion);
    assert.deepEqual(drafts.get(retained.id), retained); assert.equal(draftDocument.getText(), unsavedText); assert.ok(draftDocument.isDirty);
    assert.match(JSON.stringify(view.rows()), /Read-only shared files/); assert.equal(client.snapshot, undefined);
    const sentViewPosts = posts;
    await assert.rejects(view.sendSuggestion(retained.id), /retained suggestion/); assert.equal(posts, sentViewPosts); assert.equal(suggestionPosts, 1);
    const suggestionRequest = suggestions.list()[0].request;
    await view.checkSuggestion(suggestionRequest); assert.equal(suggestions.list()[0].phase, 'missing'); assert.equal(suggestionRecoveries, 0);
    assert.match(JSON.stringify(view.rows()), /Recover Owner Receipt/);
    await assert.rejects(view.reconcile(retained.id), /Check the retained suggestion/);
    await view.checkSuggestion(suggestionRequest); assert.equal(suggestionRecoveries, 1);
    assert.equal(suggestions.list()[0].recoveries?.at(-1)?.phase, 'watching');
    await view.checkSuggestion(suggestionRequest);
    assert.equal(suggestions.list()[0].phase, 'missing'); assert.equal(suggestions.list()[0].recoveries?.at(-1)?.phase, 'recorded');
    assert.match(JSON.stringify(view.rows()), /Owner receipt recovered/);
    assert.equal(suggestionPosts, 1); assert.equal(suggestionRecoveries, 1);
    await view.reconcile(retained.id); assert.equal(suggestionPosts, 1);
    assert.equal(new RemoteSuggestionJournal(join(directory, 'suggestions')).list()[0].intent.source, retained.text);
    phase = 'lost'; await assert.rejects(view.refresh()); const heldPosts = posts; await assert.rejects(view.refresh()); assert.equal(posts, heldPosts);
    const other = link.with({query: new URLSearchParams({...target, project: 'another-project'}).toString()});
    phase = 'ready'; await view.open(other); assert.equal(posts, heldPosts + 1);
    assert.match(JSON.stringify(view.rows()), /Open shared-demo/);
    await view.open(link); assert.equal(posts, heldPosts + 1); await assert.rejects(view.refresh());
    phase = 'missing'; await view.check(); assert.equal(posts, heldPosts + 1);
    assert.match(JSON.stringify(view.rows()), /Refresh starts a new read/);
    phase = 'ready'; await view.refresh(); assert.equal(posts, heldPosts + 2);
    phase = 'lost-post'; await assert.rejects(view.refresh()); const unknownPosts = posts;
    phase = 'ready'; await view.open(other); assert.equal(posts, unknownPosts);
    await view.open(link); assert.equal(posts, unknownPosts); await assert.rejects(view.refresh());
    assert.match(JSON.stringify(view.rows()), /Outcome unknown/);
    assert.equal(document.getText(), 'original shared source');
    const historicalUri = view.rows()[0].children!.find(row => row.command?.command === 'readymade.openSharedSource')!.command!.arguments![0] as string;
    await view.openFile(historicalUri);
    const historical = vscode.window.activeTextEditor!.document, historicalText = view.provideTextDocumentContent(historical.uri);
    const draftBeforeTamper = drafts.get(retained.id), suggestionBeforeTamper = suggestions.get(suggestionRequest);
    const localBeforeTamper = draftDocument.getText(), dirtyBeforeTamper = draftDocument.isDirty;
    const alter = new vscode.WorkspaceEdit(); alter.insert(historical.uri, new vscode.Position(0, 0), 'altered evidence ');
    assert.equal(await vscode.workspace.applyEdit(alter), true);
    assert.notEqual(historical.getText(), historicalText);
    await assert.rejects(view.openFile(historicalUri), /Historical evidence buffer changed/);
    assert.equal(view.provideTextDocumentContent(historical.uri), historicalText);
    const original = await vscode.workspace.openTextDocument(vscode.Uri.parse(retained.originalUri));
    const originalBytes = Buffer.from(provider.readFile(original.uri));
    const alterOriginal = new vscode.WorkspaceEdit(); alterOriginal.insert(original.uri, new vscode.Position(0, 0), 'altered original ');
    assert.equal(await vscode.workspace.applyEdit(alterOriginal), true);
    assert.notEqual(original.getText(), originalBytes.toString());
    await assert.rejects(view.compare(retained.id), /Historical evidence buffer changed/);
    assert.deepEqual(Buffer.from(provider.readFile(original.uri)), originalBytes);
    assert.deepEqual(drafts.get(retained.id), draftBeforeTamper); assert.deepEqual(suggestions.get(suggestionRequest), suggestionBeforeTamper);
    assert.equal(draftDocument.getText(), localBeforeTamper); assert.equal(draftDocument.isDirty, dirtyBeforeTamper);
    assert.equal(posts, unknownPosts); assert.equal(suggestionPosts, 1);
    current = undefined; await assert.rejects(view.refresh()); assert.ok(view.rows()[0].children!.some(row => row.label.includes('Connection changed')));
    return {historicalSnapshotReuseRefused: true, originalComparisonReuseRefused: true, extensionAPIBufferImmutability: false, historicalBackingUnchanged: true, resumeSavedProject: true, resumeFreshRead: true, unknownSuggestionPreservedOnResume: true, dirtyBufferPreservedOnResume: true, independentProjectSwitching: true, correlatedMissingExplicitRefresh: true, uncorrelatedReadNeverRetried: true, explicitConflictReconciliation: true, oldDraftPreserved: true, staleBasisRefused: true, suggestionLostResponseRecovered: true, suggestionPosts, suggestionRecoveries, editableLocalDraft: true, privateDraftRestored: true, originalDiff: true, renderedReadOnlySource: true, immutableOlderRevision: true, noLocalViki: true, peerBoundLink: true, singleSubmission: true, explicitRecovery: true, posts, reads};
  } finally {resumeCommand.dispose(); view.dispose(); registrations.forEach(item => item.dispose()); client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
}
