import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {readFileSync, realpathSync, statSync, writeFileSync} from 'node:fs';
import {join, isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

export async function run(): Promise<void> {
  const evidence = process.env.READYMADE_HOST_EVIDENCE!;
  try {
    const installed = process.env.READYMADE_BUILTIN_EXTENSION; assert.ok(installed);
    const workspace = vscode.extensions.getExtension('pataphor.readymade-ship-workspace'); assert.ok(workspace);
    assert.equal(realpathSync(workspace.extensionPath), realpathSync(installed));
    const root = process.env.READYMADE_CLANGD_ROOT; assert.ok(root);
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(root).uid, process.getuid!());
    assert.equal(readFileSync(join(root, '.readymade-clangd-acceptance'), 'utf8'), 'isolated clangd acceptance\n');
    assert.equal(realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), realpathSync(root));
    const server = process.env.READYMADE_CLANGD_BIN, compiler = process.env.READYMADE_CLANG_BIN;
    assert.ok(server && isAbsolute(server)); assert.ok(compiler && isAbsolute(compiler));
    const config = vscode.workspace.getConfiguration('clangd');
    await config.update('path', server, vscode.ConfigurationTarget.Workspace);
    await config.update('checkUpdates', false, vscode.ConfigurationTarget.Workspace);
    await config.update('restartAfterCrash', false, vscode.ConfigurationTarget.Workspace);
    await config.update('arguments', ['--background-index=false'], vscode.ConfigurationTarget.Workspace);
    const header = vscode.Uri.file(join(root, 'helper.hpp')), main = vscode.Uri.file(join(root, 'main.cpp'));
    writeFileSync(header.fsPath, '#pragma once\ninline int twice(int value) { return value * 2; }\n', {flag: 'wx'});
    writeFileSync(main.fsPath, '#include "helper.hpp"\nint main() { return twice(6) == 12 ? 0 : 1; }\n', {flag: 'wx'});
    writeFileSync(join(root, 'compile_commands.json'), JSON.stringify([{directory: root, file: main.fsPath,
      arguments: [compiler, '-std=c++17', '-c', main.fsPath]}]), {flag: 'wx'});
    const extension = vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd'); assert.ok(extension);
    await extension.activate();
    const document = await vscode.workspace.openTextDocument(main); await vscode.window.showTextDocument(document);
    assert.equal(document.languageId, 'cpp');
    const declaration = await vscode.workspace.openTextDocument(header);
    let locations: (vscode.Location | vscode.LocationLink)[] | undefined;
    const deadline = Date.now() + 30000;
    do {
      locations = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', main, new vscode.Position(1, 22));
      if (locations?.some(l => ('targetUri' in l ? l.targetUri : l.uri).toString() === header.toString())) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.ok(locations?.some(l => ('targetUri' in l ? l.targetUri : l.uri).toString() === header.toString()), 'Cross-file definition');
    const rename = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', main, new vscode.Position(1, 22), 'double_value');
    assert.ok(rename?.entries().some(([u]) => u.toString() === main.toString()));
    assert.ok(rename.entries().some(([u]) => u.toString() === header.toString()));
    assert.equal(await vscode.workspace.applyEdit(rename), true);
    assert.match(document.getText(), /double_value\(6\)/); assert.match(declaration.getText(), /int double_value/);
    assert.equal(await document.save(), true); assert.equal(await declaration.save(), true);
    await until(() => vscode.languages.getDiagnostics(main).every(d => d.severity !== vscode.DiagnosticSeverity.Error), 'Renamed project has no type errors');
    const offset = document.getText().indexOf('double_value(6)');
    const fault = new vscode.WorkspaceEdit();
    fault.replace(main, new vscode.Range(document.positionAt(offset), document.positionAt(offset + 'double_value(6)'.length)), 'double_value("wrong")');
    assert.equal(await vscode.workspace.applyEdit(fault), true); await document.save();
    await until(() => vscode.languages.getDiagnostics(main).some(d => d.severity === vscode.DiagnosticSeverity.Error &&
      d.range.start.line === 1 && /matching|convert|argument/i.test(d.message)), 'Real clangd invalid-argument diagnostic');
    const diagnostics = vscode.languages.getDiagnostics(main).filter(d => d.severity === vscode.DiagnosticSeverity.Error);
    assert.ok(diagnostics.some(d => d.range.start.line === 1 && /matching|convert|argument/.test(d.message)), 'Error belongs to invalid argument');
    const repair = new vscode.WorkspaceEdit();
    const bad = document.getText().indexOf('"wrong"');
    repair.replace(main, new vscode.Range(document.positionAt(bad), document.positionAt(bad + 7)), '6');
    assert.equal(await vscode.workspace.applyEdit(repair), true); await document.save();
    await until(() => vscode.languages.getDiagnostics(main).every(d => d.severity !== vscode.DiagnosticSeverity.Error), 'Diagnostic clears after repair');
    const executable = join(root, 'acceptance');
    execFileSync(compiler, ['-std=c++17', main.fsPath, '-o', executable], {timeout: 30000});
    execFileSync(executable, [], {timeout: 5000});
    writeFileSync(evidence, JSON.stringify({passed: true, editor: vscode.version, platform: process.platform,
      architecture: process.arch, root, provider: extension.id, version: extension.packageJSON.version,
      server: execFileSync(server, ['--version'], {encoding: 'utf8', timeout: 5000}).trim(),
      crossFileDefinition: true, crossFileRename: true, typeDiagnostic: diagnostics.map(d => d.message),
      repairClearsDiagnostic: true, realCompilerBuild: true, executableExitZero: true}, null, 2), {mode: 0o600});
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({passed: false, error: String(error), stack: error instanceof Error ? error.stack : undefined}), {mode: 0o600});
    throw error;
  }
}
