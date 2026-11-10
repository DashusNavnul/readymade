import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {readFileSync, realpathSync, statSync, writeFileSync} from 'node:fs';
import {join, isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';

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
  const events: object[] = [], stops: {threadId: number; reason: string}[] = [];
  let session: vscode.DebugSession | undefined, terminated = false, exitCode: number | undefined;
  let tracker: vscode.Disposable | undefined, breakpoint: vscode.SourceBreakpoint | undefined;
  try {
    const installed = process.env.READYMADE_BUILTIN_EXTENSION; assert.ok(installed);
    const extension = vscode.extensions.getExtension('pataphor.readymade-ship-workspace'); assert.ok(extension);
    assert.equal(realpathSync(extension.extensionPath), realpathSync(installed));
    const root = process.env.READYMADE_LLDB_ROOT; assert.ok(root);
    assert.equal(statSync(root).mode & 0o777, 0o700); assert.equal(statSync(root).uid, process.getuid!());
    assert.equal(readFileSync(join(root, '.readymade-lldb-acceptance'), 'utf8'), 'isolated lldb acceptance\n');
    assert.equal(realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), realpathSync(root));
    const compiler = process.env.READYMADE_CLANG_BIN; assert.ok(compiler && isAbsolute(compiler));
    const source = vscode.Uri.file(join(root, 'debug.cpp')), program = join(root, 'debug-program');
    writeFileSync(source.fsPath, 'int main() {\n  int value = 6;\n  int doubled = value * 2;\n  return doubled == 12 ? 0 : 1;\n}\n', {flag: 'wx'});
    execFileSync(compiler, ['-g', '-O0', source.fsPath, '-o', program], {timeout: 30000});
    const adapter = vscode.extensions.getExtension('vadimcn.vscode-lldb'); assert.ok(adapter); await adapter.activate();
    const name = `Readymade C++ debugger acceptance ${Date.now()}`;
    tracker = vscode.debug.registerDebugAdapterTrackerFactory('lldb', {
      createDebugAdapterTracker(s) {
        if (s.name !== name) return;
        session = s;
        return {onDidSendMessage(message) {
          if (message.type !== 'event') return;
          events.push({event: message.event, body: message.body});
          if (message.event === 'stopped') stops.push(message.body);
          if (message.event === 'exited') exitCode = message.body.exitCode;
          if (message.event === 'terminated') terminated = true;
        }};
      }
    });
    breakpoint = new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(2, 0)));
    vscode.debug.addBreakpoints([breakpoint]);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source));
    assert.equal(await vscode.debug.startDebugging(undefined, {type: 'lldb', request: 'launch', name,
      program, cwd: root, terminal: 'console', stopOnEntry: false}), true);
    await until(() => stops.length > 0 && !!session, 'Source breakpoint');
    assert.equal(stops[0].reason, 'breakpoint');
    const stack = await session!.customRequest('stackTrace', {threadId: stops[0].threadId});
    const frame = stack.stackFrames[0];
    assert.equal(realpathSync(frame.source.path), realpathSync(source.fsPath)); assert.equal(frame.line, 3);
    const value = await session!.customRequest('evaluate', {expression: 'value', frameId: frame.id, context: 'watch'});
    assert.equal(value.result, '6');
    await session!.customRequest('next', {threadId: stops[0].threadId});
    await until(() => stops.length > 1, 'Step over');
    assert.equal(stops[1].reason, 'step');
    const next = await session!.customRequest('stackTrace', {threadId: stops[1].threadId});
    assert.equal(next.stackFrames[0].line, 4);
    const doubled = await session!.customRequest('evaluate', {expression: 'doubled', frameId: next.stackFrames[0].id, context: 'watch'});
    assert.equal(doubled.result, '12');
    const scopes = await session!.customRequest('scopes', {frameId: next.stackFrames[0].id});
    const variables: {name: string; value: string}[] = [];
    for (const scope of scopes.scopes) {
      if (!scope.expensive) variables.push(...(await session!.customRequest('variables', {variablesReference: scope.variablesReference})).variables);
    }
    assert.ok(variables.some(v => v.name === 'doubled' && v.value === '12'));
    await session!.customRequest('continue', {threadId: stops[1].threadId});
    await until(() => terminated && exitCode !== undefined, 'Normal program exit');
    assert.equal(exitCode, 0);
    writeFileSync(evidence, JSON.stringify({passed: true, editor: vscode.version, platform: process.platform,
      architecture: process.arch, root, adapter: adapter.id, version: adapter.packageJSON.version,
      breakpoint: true, sourceStack: true, watch: true, stepOver: true, variables: true,
      normalTermination: true, exitCode}, null, 2), {mode: 0o600});
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({passed: false, error: String(error), stack: error instanceof Error ? error.stack : undefined}), {mode: 0o600});
    throw error;
  } finally {
    writeFileSync(evidence + '.debug', JSON.stringify({events, stops, terminated, exitCode}, null, 2), {mode: 0o600});
    if (breakpoint) vscode.debug.removeBreakpoints([breakpoint]);
    if (session && !terminated) await vscode.debug.stopDebugging(session);
    tracker?.dispose();
  }
}
