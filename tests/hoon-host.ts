import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReadymadeWorkspace} from '../src/extension';

export async function run(): Promise<void> {
  const evidence = process.env.READYMADE_HOST_EVIDENCE!;
  try {
    const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
    assert.ok(process.env.READYMADE_BUILTIN_EXTENSION);
    assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
    const api = await extension.activate();
    const {snapshotFrom} = await import(join(extension.extensionPath, 'dist/src/source-store.js')) as typeof import('../src/source-store');
    const text = '|=  a=@\n(add a 1)\n';
    const snapshot = snapshotFrom({origin: 'https://example.test', ship: '~zod', session: '0x1',
      source: {id: '0x2', owner: '~zod', desk: 'base', number: 1, root: '0v1', commit: '0v2'},
      path: '/app/example/hoon', blob: '0x3', mark: 'hoon', text});
    // A read-only source fixture exercises the exact production URI, without contacting a ship.
    const source = vscode.workspace.registerTextDocumentContentProvider('urbit-source', {provideTextDocumentContent: () => text});
    try {
      const root = mkdtempSync(join(tmpdir(), 'readymade-hoon-'));
      const local = vscode.Uri.file(join(root, 'example.hoon')); writeFileSync(local.fsPath, text);
      const draft = api.drafts.create(snapshot);
      const documents = [];
      for (const uri of [local, vscode.Uri.parse(snapshot.uri), vscode.Uri.parse(draft.uri)]) {
        const document = await vscode.workspace.openTextDocument(uri);
        assert.equal(document.languageId, 'hoon', uri.toString());
        documents.push({scheme: uri.scheme, language: document.languageId});
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(draft.uri));
      const editor = await vscode.window.showTextDocument(document);
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      await vscode.commands.executeCommand('editor.action.commentLine');
      assert.match(document.lineAt(0).text, /^::/);
      assert.equal(await document.save(), true);
      assert.equal(api.drafts.get(draft.uri).text, document.getText());
      await vscode.commands.executeCommand('editor.action.commentLine');
      assert.equal(document.getText(), text);
      const empty = await vscode.workspace.openTextDocument({language: 'hoon', content: ''});
      await vscode.window.showTextDocument(empty);
      await vscode.commands.executeCommand('type', {text: '('});
      assert.equal(empty.getText(), '()');
      writeFileSync(evidence, JSON.stringify({passed: true, editor: vscode.version, documents,
        draftCommentToggle: true, draftSave: true, bracketPairing: true, sourceFixture: true}, null, 2), {mode: 0o600});
    } finally {source.dispose(); api.dispose();}
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({passed: false, error: String(error), stack: error instanceof Error ? error.stack : undefined}, null, 2), {mode: 0o600}); throw error;
  }
}
