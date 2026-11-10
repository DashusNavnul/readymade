import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {createServer, type ServerResponse} from 'node:http';
import {writeFileSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import type {ReadymadeWorkspace} from '../src/extension';
import type {DocumentSnapshot, DocumentReceipt} from '../src/noltbook-documents';

async function until(test: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!test()) {if (Date.now() > deadline) throw new Error('Document editor fixture timed out'); await new Promise(resolve => setTimeout(resolve, 25));}
}
async function pick(work: Thenable<unknown>): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 750));
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); await work;
}
async function restorePick(work: Thenable<unknown>): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 750));
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await new Promise(resolve => setTimeout(resolve, 250));
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); await work;
}
async function acceptance() {
  const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
  if (process.env.READYMADE_BUILTIN_EXTENSION) assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
  const api = await extension.activate();
  const {NoltbookDocumentStore} = await import(join(extension.extensionPath, 'dist/src/noltbook-document-store.js')) as typeof import('../src/noltbook-document-store');
  const {NoltbookDocumentsView} = await import(join(extension.extensionPath, 'dist/src/noltbook-documents-view.js')) as typeof import('../src/noltbook-documents-view');
  const {documentReceiptSelector} = await import(join(extension.extensionPath, 'dist/src/noltbook-documents.js')) as typeof import('../src/noltbook-documents');
  const streams = new Set<ServerResponse>(), native = new Map<string, Omit<DocumentSnapshot, 'origin' | 'peer'>>();
  for (const noteId of ['shared-plan', 'conflict-plan', 'unknown-plan', 'durable-plan']) native.set(noteId, {noteId, host: '~zod', canEdit: true, body: 'Original 😀\n', revision: 1,
    updatedBy: '~zod', updatedAt: '~2026.11.09..12.01.01', versions: 0, bytes: 0});
  let selected = 'shared-plan', mode = 'saved', event = 0, saves = 0, connections = 0;
  let denyRead = false, noteNavigations = 0;
  let durable = false, receipt: DocumentReceipt | undefined, queries = 0;
  let unknown: {noteId: string; requestId: number; revision: number} | undefined;
  const emit = (json: unknown) => {for (const stream of streams) stream.write(`id: ${++event}\ndata: ${JSON.stringify({id: 1, response: 'diff', json})}\n\n`);};
  const update = (noteId: string, body: string) => {
    const old = native.get(noteId)!; const value = {...old, body, revision: old.revision + 1}; native.set(noteId, value);
    const {host: _host, canEdit: _canEdit, ...document} = value; void _host; void _canEdit;
    return document;
  };
  const server = createServer(async (req, res) => {
    if (req.url === '/~/login') {req.resume(); res.setHeader('set-cookie', 'urbauth-~zod=fixture; Path=/'); res.end('{}'); return;}
    assert.equal(req.headers.cookie, 'urbauth-~zod=fixture');
    if (req.url?.startsWith('/apps/noltbook/')) {
      assert.equal(new URL(req.url, 'http://fixture').searchParams.get('note'), 'shared-plan');
      noteNavigations++; res.setHeader('content-type', 'text/html'); res.end('<title>Shared document conversation</title><p>shared-plan</p>'); return;
    }
    if (req.url?.startsWith('/~/scry/noltbook/')) {
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/api/document-receipts.json')) {
        if (!durable) {res.writeHead(404).end('{}'); return;}
        res.end(JSON.stringify({schema: 'noltbook-document-receipts-capability-v1', ship: '~zod', version: 1, capacity: 256, retained: receipt ? 1 : 0})); return;
      }
      if (req.url.includes('/api/document-receipts/')) {
        assert.ok(receipt); assert.ok(req.url.endsWith('/' + String(receipt.requestId).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '.json'));
        res.end(JSON.stringify({...receipt, status: 'pending', receipt: null})); return;
      }
      if (req.url.endsWith('/api/notes.json')) {
        res.end(JSON.stringify({notes: [{id: selected, name: 'Team ' + selected, creator: '~zod', type: 'document', visibility: 'private', iconUrl: null,
          headline: null, userCount: 2, lastPreview: null, app: null, active: null}]})); return;
      }
      if (denyRead) {res.writeHead(404).end('{}'); return;}
      const noteId = req.url.split('/')[6], row = native.get(noteId); assert.ok(row);
      if (req.url.endsWith('/history.json')) res.end(JSON.stringify({noteId, versions: 1, bytes: 8, entries: [{revision: 0, body: 'Earlier\n', savedBy: '~zod', savedAt: row.updatedAt}], isHost: true}));
      else res.end(JSON.stringify(row)); return;
    }
    if (req.method === 'GET') {
      streams.add(res); connections++; res.writeHead(200, {'content-type': 'text/event-stream'}); res.flushHeaders();
      res.on('close', () => streams.delete(res)); return;
    }
    let text = ''; for await (const part of req) text += part;
    for (const action of JSON.parse(text || '[]')) {
      if (action.action !== 'poke') continue;
      assert.equal(action.app, 'noltbook');
      if (action.json.action === 'request-document-save-receipt') {
        assert.ok(receipt); queries++;
        assert.deepEqual(action.json.data, {host: receipt.host, requester: receipt.requester, noteId: receipt.noteId, requestId: receipt.requestId, expected: receipt.expected, bodyHash: receipt.bodyHash});
        emit({'document-save-receipt': receipt}); continue;
      }
      assert.equal(action.json.action, durable ? 'save-document-receipted' : 'save-document'); saves++;
      const data = action.json.data, old = native.get(data.noteId)!;
      const retained = new NoltbookDocumentStore(api.documents.store.directory).list().find(r => r.snapshot.noteId === data.noteId)!;
      assert.equal(retained.pending?.requestId, data.requestId, 'Save intent is durable before HTTP dispatch');
      assert.equal(retained.pending?.body, data.body);
      if (durable) {
        assert.equal(retained.pending!.protocol, 'receipted-v1'); assert.equal(data.host, '~zod');
        const document = update(data.noteId, data.body);
        receipt = {schema: 'noltbook-document-receipt-v1', ...documentReceiptSelector(retained.pending!), status: 'recorded',
          receipt: {result: 'saved', revision: document.revision, limit: null, recordedAt: old.updatedAt}};
        update(data.noteId, 'Later shared edit\n'); for (const stream of streams) stream.end();
      } else if (mode === 'conflict') {
        emit({'document-updated': update(data.noteId, 'Other writer\n')});
        emit({'document-save-result': {noteId: data.noteId, requestId: data.requestId, result: 'conflict', revision: old.revision + 1, limit: null}});
      } else {
        assert.equal(data.expected, old.revision); const document = update(data.noteId, data.body);
        if (mode === 'unknown') {
          unknown = {noteId: data.noteId, requestId: data.requestId, revision: document.revision};
          for (const stream of streams) stream.end();
        } else {
          emit({'document-updated': document});
          emit({'document-save-result': {noteId: data.noteId, requestId: data.requestId, result: 'saved', revision: document.revision, limit: null}});
        }
      }
    }
    res.writeHead(204).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const connect = api.media.connectClient.bind(api.media); let connectCalls = 0;
  api.media.connectClient = async () => {connectCalls++; return connect(origin, async () => 'fixture');};
  let reopened: InstanceType<typeof NoltbookDocumentsView> | undefined;
  try {
    assert.equal(api.media.connectedClient, undefined);
    await pick(vscode.commands.executeCommand('readymade.openDocument'));
    assert.equal(connectCalls, 1); assert.equal(api.client, undefined, 'Documents do not require a coding session');
    if (process.env.READYMADE_DOCUMENT_RECONCILE_TEST === '1') {
      selected = 'reconcile-plan';
      const base = {...native.get('shared-plan')!, noteId: selected, body: 'Alpha\nBeta\nGamma\n'};
      native.set(selected, base); await pick(api.documents.open());
      let editor = vscode.window.activeTextEditor!;
      const row = api.documents.store.list().find(r => r.snapshot.noteId === selected)!;
      const local = 'Local alpha\nBeta\nGamma\n', remote = 'Alpha\nBeta\nRemote gamma\n';
      assert.equal(await editor.edit(edit => edit.replace(new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)), local)), true);
      await until(() => api.documents.store.get(row.id).body === local);
      native.set(selected, {...base, body: remote, revision: 2});
      await restorePick(api.documents.reconcile(row.id));
      const merged = 'Local alpha\nBeta\nRemote gamma\n';
      editor = vscode.window.activeTextEditor!;
      assert.equal(editor.document.getText(), merged); assert.ok(editor.document.isDirty);
      await vscode.commands.executeCommand('undo'); assert.equal(editor.document.getText(), local);
      await vscode.commands.executeCommand('redo'); assert.equal(editor.document.getText(), merged);
      const reconciled = api.documents.store.get(row.id);
      assert.equal(reconciled.body, merged); assert.equal(reconciled.snapshot.revision, 2);
      assert.deepEqual(reconciled.reconciliations, [{snapshot: row.snapshot, body: local}]);
      assert.deepEqual(new NoltbookDocumentStore(api.documents.store.directory).get(row.id), reconciled);
      assert.equal(saves, 0);
      const recovery = api.documents.reconcile(row.id);
      await new Promise(resolve => setTimeout(resolve, 750));
      await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); await recovery;
      assert.equal(vscode.window.activeTextEditor!.document.uri.scheme, 'readymade-document-history');
      assert.equal(vscode.window.activeTextEditor!.document.getText(), local);
      assert.deepEqual(api.documents.store.get(row.id), reconciled);
      // An overlapping remote edit keeps both local text and the old CAS basis.
      native.set(selected, {...base, body: 'Other alpha\nBeta\nRemote gamma\n', revision: 3});
      await pick(api.documents.reconcile(row.id));
      assert.deepEqual(api.documents.store.get(row.id), reconciled);
      assert.ok(vscode.workspace.textDocuments.some(d => d.uri.scheme === 'readymade-document-history' && d.getText().startsWith('Other alpha')));
      // A changed buffer while Apply is offered must never adopt the new basis.
      native.set(selected, {...base, body: 'Alpha\nBeta\nRemote gamma\n', revision: 4});
      const drift = api.documents.reconcile(row.id); const rejection = assert.rejects(drift, /changed/);
      await new Promise(resolve => setTimeout(resolve, 750));
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await new Promise(resolve => setTimeout(resolve, 350));
      const originalDoc = vscode.workspace.textDocuments.find(d => d.uri.path === '/' + row.id + '/document.md')!;
      const edit = new vscode.WorkspaceEdit(); edit.insert(originalDoc.uri, new vscode.Position(0, 0), 'New local edit\n');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); await rejection;
      assert.equal(api.documents.store.get(row.id).snapshot.revision, 2);
      assert.equal(api.documents.store.get(row.id).reconciliations!.length, 1); assert.equal(saves, 0);
      // Store law rejects stale transitions and capacity without evicting originals.
      const held = api.documents.store.get(row.id), fresh = {...held.snapshot, revision: 4};
      assert.throws(() => api.documents.store.reconcile(row.id, reconciled, fresh, merged), /changed/);
      for (let i = 1; i < 8; i++) {const current = api.documents.store.prepareReconciliation(row.id, api.documents.store.get(row.id)); api.documents.store.reconcile(row.id, current, {...current.snapshot, revision: current.snapshot.revision + 1}, current.body);}
      const full = api.documents.store.get(row.id);
      assert.throws(() => api.documents.store.prepareReconciliation(row.id, full), /capacity/);
      assert.deepEqual(api.documents.store.get(row.id), full);
      // A privileged extension can alter preview models, but cannot authorize different bytes or replace backing evidence.
      for (const adverse of ['preview-tamper', 'connection-drift']) {
        selected = adverse;
        const adverseBase = {...base, noteId: selected, body: `${adverse} A\nB\nC\n`};
        native.set(selected, adverseBase); await pick(api.documents.open());
        const target = vscode.window.activeTextEditor!, doc = target.document;
        const localBody = `${adverse} LOCAL\nB\nC\n`, remoteBody = `${adverse} A\nB\nREMOTE\n`;
        assert.equal(await target.edit(edit => edit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), localBody)), true);
        const adverseRow = api.documents.store.list().find(r => r.snapshot.noteId === selected)!;
        await until(() => api.documents.store.get(adverseRow.id).body === localBody);
        const retained = api.documents.store.get(adverseRow.id);
        native.set(selected, {...adverseBase, body: remoteBody, revision: 2});
        const originalConfirm = api.documents.confirmReconciliation;
        let ready = false, settle!: (value: boolean) => void;
        const confirmation = new Promise<boolean>(resolve => {settle = resolve;});
        api.documents.confirmReconciliation = async () => {ready = true; return confirmation;};
        const action = api.documents.reconcile(adverseRow.id);
        const refused = assert.rejects(action, adverse === 'preview-tamper' ? /Historical evidence buffer changed/ : /changed/);
        try {
          await new Promise(resolve => setTimeout(resolve, 750)); await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
          await until(() => ready); // Entered only after the actual diff display and both preview guards finish.
          if (adverse === 'preview-tamper') {
            const diff = vscode.window.tabGroups.activeTabGroup.activeTab!.input; assert.ok(diff instanceof vscode.TabInputTextDiff);
            const preview = await vscode.workspace.openTextDocument(diff.modified), exact = preview.getText();
            assert.equal(vscode.workspace.fs.isWritableFileSystem('readymade-document-history'), false);
            assert.equal((await vscode.workspace.fs.stat(preview.uri)).permissions, vscode.FilePermission.Readonly);
            assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), preview.uri.toString());
            await vscode.commands.executeCommand('type', {text: 'forbidden'}).then(() => {}, () => {}); assert.equal(preview.getText(), exact);
            await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(preview.uri, Buffer.from('forbidden'))));
            const mutation = new vscode.WorkspaceEdit(); mutation.insert(preview.uri, new vscode.Position(0, 0), 'privileged ');
            assert.equal(await vscode.workspace.applyEdit(mutation), true); assert.equal(preview.getText(), 'privileged ' + exact);
            settle(true); await refused;
            assert.equal(Buffer.from(await vscode.workspace.fs.readFile(preview.uri)).toString('utf8'), exact);
          } else {
            for (const stream of streams) stream.end();
            await until(() => api.documents.rows()[0].tooltip?.includes('disconnected') === true);
            settle(true); await refused;
          }
        } finally {api.documents.confirmReconciliation = originalConfirm; settle(false); void refused.catch(() => {});}
        assert.equal(doc.getText(), localBody); assert.deepEqual(api.documents.store.get(adverseRow.id), retained); assert.equal(saves, 0);
      }
      const offlineRecovery = api.documents.reconcile(row.id);
      await new Promise(resolve => setTimeout(resolve, 750)); await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); await offlineRecovery;
      assert.equal(vscode.window.activeTextEditor!.document.getText(), local); assert.equal(saves, 0);
      return {installedExtension: extension.extensionPath, localThreeWayMerge: true, originalRecoveryReadonly: true,
        scriptedAdverseConfirmation: true, actualAdverseDialogClick: false, previewTamperApplyRefused: true, previewBackingImmutable: true, extensionAPIBufferImmutability: false, connectionDriftRefused: true, offlineRecoveryAfterDisconnect: true, cleanMergeSingleUndo: true, nativeCalls: 0, recoverySurvivesReload: true, overlapPreservesBasis: true, localDriftRefused: true, staleStoreRefused: true,
        capacityNeverEvicts: true, saves, limitation: 'Installed HTTP fixture; no actual native or peer delivery claimed.'};
    }

    let document = vscode.window.activeTextEditor!.document;
    assert.equal(document.uri.scheme, 'readymade-document'); assert.equal(document.getText(), 'Original 😀\n');
    const first = api.documents.store.list()[0]; assert.equal(first.title, 'Team shared-plan');
    assert.equal(new NoltbookDocumentStore(api.documents.store.directory).get(first.id).title, first.title);
    await vscode.commands.executeCommand('type', {text: 'My edit\n'});
    const typed = document.getText(); assert.ok(document.isDirty); await until(() => api.documents.store.get(first.id).body === typed);
    const navigationDraft = api.documents.store.get(first.id);
    const foreign = api.documents.store.open({...first.snapshot, origin: 'http://127.0.0.1:1', noteId: 'foreign-note'});
    await assert.rejects(api.documents.openInNoltbook(foreign.id), /identity or connection changed/);
    denyRead = true;
    await assert.rejects(api.documents.openInNoltbook(first.id), /unavailable/);
    assert.equal(noteNavigations, 0); denyRead = false;
    await vscode.commands.executeCommand('readymade.openDocumentInNoltbook', first.id);
    await until(() => noteNavigations > 0);
    assert.equal(document.getText(), typed); assert.ok(document.isDirty);
    assert.deepEqual(api.documents.store.get(first.id), navigationDraft);
    assert.equal(api.client, undefined);
    await vscode.window.showTextDocument(document, {preview: false});
    assert.equal(saves, 0); await document.save(); assert.equal(saves, 0, 'Ordinary Save writes no native edit');
    await vscode.commands.executeCommand('readymade.publishDocument', first.id); assert.equal(saves, 1);
    assert.equal(api.documents.store.get(first.id).pending, undefined); assert.equal(native.get(selected)!.body, typed);
    await vscode.commands.executeCommand('type', {text: 'Unsent\n'}); const unsent = document.getText();
    emit({'document-updated': update(selected, 'Remote update\n')});
    await until(() => api.documents.store.get(first.id).remote.revision === 3);
    assert.equal(document.getText(), unsent); assert.ok(document.isDirty);
    await assert.rejects(api.documents.publish(first.id), /changed or is read-only/); assert.equal(saves, 1);
    await pick(api.documents.history(first.id));
    assert.ok(vscode.workspace.textDocuments.some(d => d.uri.scheme === 'readymade-document-history' && d.getText() === 'Earlier\n'));
    const beforeRestore = api.documents.store.get(first.id);
    const restore = api.documents.restore(first.id);
    await restorePick(restore);
    document = vscode.window.activeTextEditor!.document;
    assert.equal(document.getText(), 'Earlier\n'); assert.equal(saves, 1);
    assert.deepEqual(api.documents.store.get(first.id).snapshot, beforeRestore.snapshot, 'Restore cannot silently rebase');
    await vscode.commands.executeCommand('undo'); assert.equal(document.getText(), unsent);
    const drift = api.documents.restore(first.id); const driftRejected = assert.rejects(drift, /changed/);
    await new Promise(resolve => setTimeout(resolve, 750));
    const changedDuringPicker = new vscode.WorkspaceEdit();
    changedDuringPicker.insert(document.uri, new vscode.Position(0, 0), 'Changed during picker');
    assert.equal(await vscode.workspace.applyEdit(changedDuringPicker), true);
    await restorePick(driftRejected);
    assert.notEqual(document.getText(), 'Earlier\n'); assert.equal(saves, 1);
    const previousBody = document.getText(), previousUri = document.uri.toString();
    const layoutBeforeOpen = await vscode.commands.executeCommand('vscode.getEditorLayout');
    selected = 'conflict-plan'; mode = 'conflict'; await pick(api.documents.open());
    document = vscode.window.activeTextEditor!.document;
    assert.equal(vscode.window.tabGroups.activeTabGroup.viewColumn, vscode.window.activeTextEditor!.viewColumn);
    const openedTab = vscode.window.tabGroups.activeTabGroup.activeTab?.input; assert.ok(openedTab instanceof vscode.TabInputText);
    assert.equal(openedTab.uri.toString(), document.uri.toString());
    assert.deepEqual(await vscode.commands.executeCommand('vscode.getEditorLayout'), layoutBeforeOpen);
    await vscode.commands.executeCommand('type', {text: 'Conflicting local\n'});
    const conflict = api.documents.store.list().find(r => r.snapshot.noteId === selected)!;
    assert.equal(document.uri.path, '/' + conflict.id + '/document.md');
    assert.ok(document.getText().includes('Conflicting local'), 'Typing after Open must reach the selected document before Publish');
    await until(() => api.documents.store.get(conflict.id).body === document.getText());
    assert.equal(vscode.workspace.textDocuments.find(d => d.uri.toString() === previousUri)!.getText(), previousBody);
    assert.ok(!api.documents.store.get(first.id).body.includes('Conflicting local'), 'Opening another document must move keyboard focus out of the previous editor');
    await api.documents.publish(conflict.id); assert.equal(saves, 2);
    assert.equal(api.documents.store.get(conflict.id).history.at(-1)!.result.result, 'conflict'); assert.ok(document.getText().includes('Conflicting local'));
    selected = 'unknown-plan'; mode = 'unknown'; await pick(api.documents.open());
    document = vscode.window.activeTextEditor!.document; await vscode.commands.executeCommand('type', {text: 'Unknown local\n'});
    const uncertain = api.documents.store.list().find(r => r.snapshot.noteId === selected)!;
    await assert.rejects(api.documents.publish(uncertain.id)); assert.equal(saves, 3); assert.ok(unknown);
    await assert.rejects(api.documents.restore(uncertain.id), /retained save/);
    await assert.rejects(api.documents.publish(uncertain.id), /retained save/); assert.equal(saves, 3);
    api.documents.dispose();
    reopened = new NoltbookDocumentsView(new NoltbookDocumentStore(api.documents.store.directory), () => api.media.connectedClient, () => {});
    assert.ok(reopened.store.get(uncertain.id).pending); await reopened.open(uncertain.id);
    assert.ok(vscode.window.activeTextEditor!.document.getText().includes('Unknown local'));
    durable = true; // Upgrading the server must never upgrade a previously sent legacy intent.
    const before = connections, check = reopened.check(uncertain.id); void check.catch(() => undefined);
    await until(() => connections > before); await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(reopened.store.get(uncertain.id).pending, 'Matching canonical text alone cannot settle an unknown save');
    emit({'document-save-result': {...unknown, result: 'saved', limit: null}});
    await check; assert.equal(saves, 3); assert.equal(reopened.store.get(uncertain.id).pending, undefined);
    assert.equal(queries, 0);
    selected = 'durable-plan'; await pick(reopened.open());
    document = vscode.window.activeTextEditor!.document; await vscode.commands.executeCommand('type', {text: 'Durable local\n'});
    const durableRow = reopened.store.list().find(r => r.snapshot.noteId === selected)!;
    await assert.rejects(reopened.publish(durableRow.id)); assert.equal(saves, 4);
    const held = reopened.store.get(durableRow.id).pending; assert.equal(held?.protocol, 'receipted-v1');
    reopened.dispose(); reopened = new NoltbookDocumentsView(new NoltbookDocumentStore(api.documents.store.directory), () => api.media.connectedClient, () => {});
    await reopened.open(durableRow.id); await reopened.check(durableRow.id);
    const recovered = reopened.store.get(durableRow.id);
    assert.equal(queries, 1); assert.equal(saves, 4); assert.equal(recovered.pending, undefined);
    assert.deepEqual(recovered.history[0].intent, held); assert.deepEqual(recovered.history[0].receipt, receipt);
    assert.equal(recovered.snapshot.revision, 1); assert.equal(recovered.remote.revision, 3);
    assert.ok(recovered.body.includes('Durable local')); assert.ok(vscode.window.activeTextEditor!.document.getText().includes('Durable local'));
    await assert.rejects(reopened.publish(durableRow.id), /changed or is read-only/); assert.equal(saves, 4);
    const comparison = reopened.compare(durableRow.id); void comparison.catch(() => undefined);
    await until(() => vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.input instanceof vscode.TabInputTextDiff && t.label.includes('Shared Version'))));
    return {installedExtension: extension.extensionPath, titlePicker: true, titleRestored: true, explicitConnectionWithoutViki: true,
      exactNoteNavigation: true, navigationMembershipRefused: true, navigationDirtyPreserved: true,
      realEditorTyping: true, localSaveOnly: true, explicitPublish: true, nativeCASConflictFixture: true, dirtyRemotePreserved: true,
      historicalDiff: true, historicalRestoreUndo: true, historicalRestoreDriftRefused: true, historicalRestoreNoPublish: true, currentDiff: true, unknownRestored: true, exactDelayedReceiptObserved: true, legacyNeverUpgraded: true, durableReceiptRecovered: true, laterRevisionPreserved: true, receiptQueries: queries, automaticResends: 0, saves,
      limitation: 'HTTP/SSE fixture validates the installed editor and protocol; actual native compile and peer receipt delivery require separate verification.'};
  } finally {
    reopened?.dispose(); api.dispose(); for (const stream of streams) stream.end(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
export async function run(): Promise<void> {
  const file = process.env.READYMADE_HOST_EVIDENCE!;
  try {writeFileSync(file, JSON.stringify({passed: true, ...await acceptance()}, null, 2), {mode: 0o600});}
  catch (error) {writeFileSync(file, JSON.stringify({passed: false, error: String(error), stack: error instanceof Error ? error.stack : undefined}), {mode: 0o600}); throw error;}
}
