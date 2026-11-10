import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

async function open(root: string, name: string, text: string, language: string) {
  const uri = vscode.Uri.file(join(root, name)); writeFileSync(uri.fsPath, text);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  assert.equal(document.languageId, language);
  return document;
}

async function completion(document: vscode.TextDocument, needle: string, expected: string) {
  const offset = document.getText().indexOf(needle); assert.ok(offset >= 0);
  const result = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider',
    document.uri, document.positionAt(offset + needle.length));
  assert.ok(result?.items.some(i => (typeof i.label === 'string' ? i.label : i.label.label) === expected), `Missing completion ${expected}`);
}

async function format(document: vscode.TextDocument) {
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', document.uri, {tabSize: 2, insertSpaces: true});
  assert.ok(edits?.length, `No formatting edits for ${document.languageId}`);
  const change = new vscode.WorkspaceEdit(); change.set(document.uri, edits);
  assert.equal(await vscode.workspace.applyEdit(change), true);
  assert.equal(await document.save(), true);
}

async function css(root: string) {
  const document = await open(root, 'style.css', '.card{colr:red;color:blue;}\n', 'css');
  await until(() => vscode.languages.getDiagnostics(document.uri).some(d => d.message.includes('colr')), 'CSS unknown property');
  await completion(document, '.card{col', 'color');
  const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, document.positionAt(document.getText().indexOf('color:') + 2));
  assert.ok(hover?.length, 'CSS property hover');
  const edits = new vscode.WorkspaceEdit();
  edits.replace(document.uri, new vscode.Range(document.positionAt(6), document.positionAt(10)), 'color');
  assert.equal(await vscode.workspace.applyEdit(edits), true); await document.save();
  await until(() => !vscode.languages.getDiagnostics(document.uri).some(d => d.message.includes('colr')), 'CSS error clears');
  await format(document);
  return {diagnostics: true, completion: true, hover: true, formatting: true, correction: true};
}

async function html(root: string) {
  const document = await open(root, 'index.html', '<!DOCTYPE html>\n<html><head><link rel="stylesheet" href="./style.css"></head><body><div class="card">Hello</div></body></html>\n', 'html');
  await completion(document, '<html><head><link rel="stylesheet" href="./style.css"></head><body><di', 'div');
  const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', document.uri);
  assert.ok(links?.some(l => l.target?.toString() === vscode.Uri.file(join(root, 'style.css')).toString()), 'HTML resolves local stylesheet');
  const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, document.positionAt(document.getText().indexOf('<div') + 2));
  assert.ok(hover?.length, 'HTML tag hover');
  await format(document);
  return {completion: true, localStylesheetNavigation: true, hover: true, formatting: true};
}

async function json(root: string) {
  const uri = vscode.Uri.file(join(root, 'project-config.json'));
  const config = vscode.workspace.getConfiguration('json');
  const previous = config.inspect('schemas')?.globalValue;
  try {
    await config.update('schemas', [{fileMatch: [uri.fsPath], schema: {type: 'object', properties: {count: {type: 'number'}, mode: {enum: ['shared', 'solo']}}, required: ['count', 'mode'], additionalProperties: false}}], vscode.ConfigurationTarget.Global);
    const document = await open(root, 'project-config.json', '{"count":"wrong","mode":"shared"}\n', 'json');
    await until(() => vscode.languages.getDiagnostics(uri).some(d => d.message.includes('number')), 'JSON schema type error');
    await completion(document, '{"count":"wrong","mode":"sh', '"shared"');
    const edits = new vscode.WorkspaceEdit();
    const offset = document.getText().indexOf('"wrong"');
    edits.replace(uri, new vscode.Range(document.positionAt(offset), document.positionAt(offset + 7)), '2');
    assert.equal(await vscode.workspace.applyEdit(edits), true); await document.save();
    await until(() => vscode.languages.getDiagnostics(uri).length === 0, 'JSON schema error clears');
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri);
    assert.ok(symbols?.some(s => s.name === 'count'), 'JSON outline');
    await format(document);
    return {localSchemaDiagnostics: true, enumCompletion: true, outline: true, formatting: true, correction: true};
  } finally {await config.update('schemas', previous, vscode.ConfigurationTarget.Global);}
}

export async function run(): Promise<void> {
  const evidence = process.env.READYMADE_HOST_EVIDENCE!;
  try {
    const extension = vscode.extensions.getExtension('pataphor.readymade-ship-workspace'); assert.ok(extension);
    assert.ok(process.env.READYMADE_BUILTIN_EXTENSION, 'Requires the packaged built-in extension');
    assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
    const providers = [];
    for (const id of ['vscode.css-language-features', 'vscode.html-language-features', 'vscode.json-language-features']) {
      const provider = vscode.extensions.getExtension(id); assert.ok(provider); await provider.activate();
      providers.push({id, version: provider.packageJSON.version});
    }
    const root = mkdtempSync(join(tmpdir(), 'readymade-web-language-'));
    const result = {passed: true, editor: vscode.version, platform: process.platform, architecture: process.arch, providers, root,
      css: await css(root), html: await html(root), json: await json(root)};
    writeFileSync(evidence, JSON.stringify(result, null, 2), {mode: 0o600});
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({passed: false, error: String(error), stack: error instanceof Error ? error.stack : undefined}), {mode: 0o600}); throw error;
  }
}
