import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

// Narrow structural view of the built-in Git extension's public API:
// https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
interface Repository {
  state: {indexChanges: {uri: vscode.Uri}[]; workingTreeChanges: {uri: vscode.Uri}[]; untrackedChanges: {uri: vscode.Uri}[]};
  status(): Promise<void>; add(paths: string[]): Promise<void>; diff(cached?: boolean): Promise<string>;
}
interface GitExtension {getAPI(version: 1): {init(root: vscode.Uri): Promise<Repository | null>}}
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
function quote(value: string): string {return "'" + value.replace(/'/g, "'\\''") + "'";}

export async function run(): Promise<void> {
  const evidence = process.env.READYMADE_HOST_EVIDENCE!;
  let terminal: vscode.Terminal | undefined;
  try {
    const root = process.env.READYMADE_CORE_ROOT, node = process.env.READYMADE_TEST_NODE_BIN;
    assert.ok(root && node);
    assert.equal(readFileSync(join(root, '.readymade-test-root'), 'utf8'), 'isolated local editor acceptance\n');
    assert.equal(realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), realpathSync(root));
    const extension = vscode.extensions.getExtension('pataphor.readymade-ship-workspace'); assert.ok(extension);
    assert.ok(process.env.READYMADE_BUILTIN_EXTENSION);
    assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
    await extension.activate();
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git'); assert.ok(gitExtension);
    const git = await gitExtension.activate();
    assert.equal(existsSync(join(root, '.git')), false, 'Only initialize a fresh disposable fixture');
    const repository = await git.getAPI(1).init(vscode.Uri.file(root)); assert.ok(repository);
    const uri = vscode.Uri.file(join(root, 'example.txt'));
    writeFileSync(uri.fsPath, 'original value\n');
    const document = await vscode.workspace.openTextDocument(uri);
    const left = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const right = await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
    assert.notEqual(left.viewColumn, right.viewColumn);
    assert.equal(left.document, right.document);
    const edit = new vscode.WorkspaceEdit(); edit.replace(uri, new vscode.Range(0, 0, 0, 14), 'edited value');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(await document.save(), true);
    assert.equal(readFileSync(uri.fsPath, 'utf8'), 'edited value\n');
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*.txt'));
    assert.ok(files.some(file => realpathSync(file.fsPath) === realpathSync(uri.fsPath)));
    await repository.status();
    const unstaged = [...repository.state.workingTreeChanges, ...repository.state.untrackedChanges];
    assert.ok(unstaged.some(change => realpathSync(change.uri.fsPath) === realpathSync(uri.fsPath)));
    await repository.add([uri.fsPath]); await repository.status();
    assert.ok(repository.state.indexChanges.some(change => realpathSync(change.uri.fsPath) === realpathSync(uri.fsPath)));
    assert.match(await repository.diff(true), /\+edited value/);
    const receipt = join(root, 'terminal-result.json'), script = join(root, 'terminal-proof.cjs'), nonce = randomUUID();
    writeFileSync(script, 'require("node:fs").writeFileSync(process.argv[2], JSON.stringify({cwd:process.cwd(),nonce:process.env.READYMADE_PROOF_NONCE}));\n');
    let closed = false, exitCode: number | undefined;
    const listener = vscode.window.onDidCloseTerminal(t => {if (t === terminal) {closed = true; exitCode = t.exitStatus?.code;}});
    try {
      terminal = vscode.window.createTerminal({name: 'Readymade local terminal acceptance', cwd: root,
        shellPath: '/bin/zsh', shellArgs: ['-f'], env: {READYMADE_PROOF_NONCE: nonce}});
      terminal.show(); assert.ok(await terminal.processId);
      terminal.sendText(`${quote(node)} ${quote(script)} ${quote(receipt)}; exit $?`, true);
      await until(() => existsSync(receipt) && closed, 'real terminal command and normal exit');
      assert.equal(exitCode, 0);
      const result = JSON.parse(readFileSync(receipt, 'utf8'));
      assert.equal(realpathSync(result.cwd), realpathSync(root)); assert.equal(result.nonce, nonce);
    } finally {listener.dispose();}
    writeFileSync(evidence, JSON.stringify({passed: true, editor: vscode.version, root, localFolder: true,
      splitEditors: true, editAndSave: true, fileSearch: true, git: {provider: gitExtension.id,
        version: gitExtension.packageJSON.version, untrackedDetection: true, staging: true, stagedDiff: true, committed: false},
      terminal: {realPTY: true, cwd: true, environment: true, commandExecuted: true, normalExit: true}}, null, 2), {mode: 0o600});
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({passed: false, error: String(error), stack: error instanceof Error ? error.stack : undefined}, null, 2), {mode: 0o600}); throw error;
  } finally {terminal?.dispose();}
}
