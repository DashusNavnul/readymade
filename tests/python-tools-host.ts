import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {realpathSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

export async function run(): Promise<void> {
  const evidence = process.env.READYMADE_HOST_EVIDENCE!;
  try {
    const root = process.env.READYMADE_PYTHON_ROOT, runtime = process.env.READYMADE_TEST_PYTHON_BIN;
    assert.ok(root); assert.ok(runtime); assert.ok(process.env.READYMADE_BUILTIN_EXTENSION);
    const extension = vscode.extensions.getExtension('pataphor.readymade-ship-workspace'); assert.ok(extension);
    assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
    assert.equal(realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), realpathSync(root));
    const provider = vscode.extensions.getExtension('charliermarsh.ruff'); assert.ok(provider);
    await provider.activate();
    const uri = vscode.Uri.file(join(root, 'format_check.py'));
    writeFileSync(uri.fsPath, 'import os\n\nvalue= 6\nprint( value*2 )\n', {flag: 'wx'});
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    assert.equal(document.languageId, 'python');
    const diagnostics = () => vscode.languages.getDiagnostics(uri).filter(d => d.source?.toLowerCase() === 'ruff');
    const code = (d: vscode.Diagnostic) => String(typeof d.code === 'object' ? d.code.value : d.code);
    await until(() => diagnostics().some(d => code(d) === 'F401'), 'unused import diagnostic');
    const unused = diagnostics().find(d => code(d) === 'F401')!;
    assert.equal(unused.range.start.line, 0);
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, unused.range, 'quickfix', 20);
    writeFileSync(evidence + '.actions', JSON.stringify(actions, null, 2), {mode: 0o600});
    const fix = actions?.find(a => a.edit && a.isPreferred && a.title === 'Ruff (F401): Remove unused import: `os`');
    assert.ok(fix?.edit, 'real unused-import quick fix');
    assert.equal(await vscode.workspace.applyEdit(fix.edit), true);
    assert.ok(!document.getText().includes('import os'));
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', uri, {tabSize: 4, insertSpaces: true});
    assert.ok(edits?.length, 'real formatter edits');
    const formatting = new vscode.WorkspaceEdit(); formatting.set(uri, edits);
    assert.equal(await vscode.workspace.applyEdit(formatting), true);
    assert.equal(document.getText(), 'value = 6\nprint(value * 2)\n');
    assert.equal(await document.save(), true);
    await until(() => diagnostics().length === 0, 'diagnostic clears after fix');
    assert.equal(execFileSync(runtime, [uri.fsPath], {encoding: 'utf8', timeout: 10000}).trim(), '12');
    const invalid = new vscode.WorkspaceEdit();
    invalid.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), 'print(missing_value)\n');
    assert.equal(await vscode.workspace.applyEdit(invalid), true);
    await until(() => diagnostics().some(d => code(d) === 'F821'), 'undefined name after edit');
    const missing = diagnostics().find(d => code(d) === 'F821')!;
    assert.equal(document.getText(missing.range), 'missing_value');
    const repair = new vscode.WorkspaceEdit(); repair.replace(uri, missing.range, '12');
    assert.equal(await vscode.workspace.applyEdit(repair), true);
    await until(() => diagnostics().length === 0, 'diagnostic clears after repair');
    assert.equal(await document.save(), true);
    writeFileSync(evidence, JSON.stringify({passed: true, editor: vscode.version, platform: process.platform,
      architecture: process.arch, provider: provider.id, version: provider.packageJSON.version,
      unusedImport: true, quickFix: true, formatting: true, executedOutput: '12', undefinedName: true,
      liveDiagnosticRecovery: true}, null, 2), {mode: 0o600});
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({passed: false, error: String(error), stack: error instanceof Error ? error.stack : undefined}), {mode: 0o600});
    throw error;
  }
}
