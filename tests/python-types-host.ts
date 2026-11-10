import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {lstatSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}

export async function run(): Promise<void> {
  const evidence = process.env.READYMADE_HOST_EVIDENCE!;
  const observations: object[] = [];
  try {
    const root = process.env.READYMADE_PYTHON_ROOT; assert.ok(root);
    const stat = lstatSync(root);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(stat.uid, process.getuid?.()); assert.equal(stat.mode & 0o777, 0o700);
    assert.equal(realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), realpathSync(root));
    const extension = vscode.extensions.getExtension('pataphor.readymade-ship-workspace'); assert.ok(extension);
    assert.ok(process.env.READYMADE_BUILTIN_EXTENSION);
    assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
    const provider = vscode.extensions.getExtension('detachhead.basedpyright'); assert.ok(provider);
    const configuration = vscode.workspace.getConfiguration('basedpyright');
    await configuration.update('importStrategy', 'useBundled', vscode.ConfigurationTarget.Workspace);
    await configuration.update('analysis.typeCheckingMode', 'standard', vscode.ConfigurationTarget.Workspace);
    await provider.activate();
    const helper = vscode.Uri.file(join(root, 'typed_helper.py'));
    const main = vscode.Uri.file(join(root, 'typed_main.py'));
    writeFileSync(helper.fsPath, 'def twice(value: int) -> int:\n    return value * 2\n', {flag: 'wx', mode: 0o600});
    const invalid = 'from typed_helper import twice\nanswer = twice("six")\ncount: int = "wrong"\n';
    const valid = 'from typed_helper import twice\nanswer = twice(6)\ncount: int = 12\n';
    writeFileSync(main.fsPath, invalid, {flag: 'wx', mode: 0o600});
    const document = await vscode.workspace.openTextDocument(main);
    await vscode.window.showTextDocument(document);
    assert.equal(document.languageId, 'python');
    const diagnostics = () => vscode.languages.getDiagnostics(main).filter(d => d.source?.toLowerCase() === 'basedpyright');
    const code = (d: vscode.Diagnostic) => String(typeof d.code === 'object' ? d.code.value : d.code);
    const capture = (phase: string) => observations.push({phase, version: document.version,
      diagnostics: diagnostics().map(d => ({code: code(d), message: d.message, source: d.source,
        severity: d.severity, text: document.getText(d.range), line: d.range.start.line}))});
    await until(() => ['reportArgumentType', 'reportAssignmentType'].every(rule => diagnostics().some(d => code(d) === rule)), 'cross-file argument and assignment type errors');
    capture('invalid');
    for (const [rule, line, text] of [['reportArgumentType', 1, '"six"'], ['reportAssignmentType', 2, '"wrong"']] as const) {
      const diagnostic = diagnostics().find(d => code(d) === rule)!;
      assert.equal(diagnostic.range.start.line, line);
      assert.equal(document.getText(diagnostic.range), text);
      assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
    }
    const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', main, new vscode.Position(1, 11));
    const hoverText = hover?.flatMap(h => h.contents.map(c => typeof c === 'string' ? c : c.value)).join('\n');
    assert.match(hoverText ?? '', /value: int/); assert.match(hoverText ?? '', /-> int/);
    const replace = async (text: string) => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(main, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
      assert.equal(await vscode.workspace.applyEdit(edit), true);
    };
    await replace(valid);
    await until(() => diagnostics().length === 0, 'type errors clear after correction'); capture('corrected');
    await replace(invalid);
    await until(() => diagnostics().some(d => code(d) === 'reportArgumentType'), 'type errors return after invalid edit'); capture('invalid-again');
    await replace(valid);
    await until(() => diagnostics().length === 0, 'type errors clear again'); capture('corrected-again');
    assert.equal(await document.save(), true);
    writeFileSync(evidence, JSON.stringify({passed: true, editor: vscode.version, platform: process.platform,
      architecture: process.arch, provider: provider.id, version: provider.packageJSON.version,
      importStrategy: 'useBundled', typeCheckingMode: 'standard', crossFileArgumentTypes: true,
      assignmentTypes: true, typedHover: true, repeatedLiveDiagnosticRecovery: true}, null, 2), {mode: 0o600});
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({passed: false, error: String(error), stack: error instanceof Error ? error.stack : undefined}), {mode: 0o600}); throw error;
  } finally {
    writeFileSync(evidence + '.diagnostics', JSON.stringify(observations, null, 2), {mode: 0o600});
  }
}
