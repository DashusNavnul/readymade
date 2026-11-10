import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

async function language(root: string): Promise<object> {
  const provider = vscode.extensions.getExtension('ms-python.python');
  assert.ok(provider); await provider.activate();
  await vscode.workspace.getConfiguration('python').update('languageServer', 'Jedi', vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('python').update('defaultInterpreterPath', process.env.READYMADE_TEST_PYTHON_BIN, vscode.ConfigurationTarget.Workspace);
  const helper = vscode.Uri.file(join(root, 'helper.py')), main = vscode.Uri.file(join(root, 'main.py'));
  writeFileSync(helper.fsPath, 'def twice(value):\n    return value * 2\n');
  writeFileSync(main.fsPath, 'from helper import twice\nanswer = twice(6)\nprint(answer)\n');
  const document = await vscode.workspace.openTextDocument(main);
  await vscode.window.showTextDocument(document);
  assert.equal(document.languageId, 'python');
  let definitions: (vscode.Location | vscode.LocationLink)[] | undefined;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', main, new vscode.Position(1, 11));
    if (definitions?.some(d => ('targetUri' in d ? d.targetUri : d.uri).toString() === helper.toString())) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(definitions?.some(d => ('targetUri' in d ? d.targetUri : d.uri).toString() === helper.toString()), 'Python cross-file definition');
  const helperDocument = await vscode.workspace.openTextDocument(helper);
  const rename = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', helper, new vscode.Position(0, 5), 'double_value');
  assert.ok(rename?.entries().some(([uri]) => uri.toString() === helper.toString()));
  assert.ok(rename.entries().some(([uri]) => uri.toString() === main.toString()));
  assert.equal(await vscode.workspace.applyEdit(rename), true);
  assert.match(helperDocument.getText(), /def double_value/);
  assert.match(document.getText(), /double_value\(6\)/);
  return {provider: provider.id, version: provider.packageJSON.version, languageServer: 'Jedi', definition: true, crossFileRename: true};
}

async function debugging(root: string): Promise<object> {
  const runtime = process.env.READYMADE_TEST_PYTHON_BIN; assert.ok(runtime, 'Supply the actual Python runtime path');
  const adapter = vscode.extensions.getExtension('ms-python.debugpy'); assert.ok(adapter); await adapter.activate();
  const program = vscode.Uri.file(join(root, 'debug.py'));
  writeFileSync(program.fsPath, 'value = 6\ndoubled = value * 2\nprint(doubled)\n');
  const name = `Readymade debugger acceptance ${Date.now()}`;
  const stops: {threadId: number; reason: string}[] = [], output: string[] = [];
  const events: object[] = [];
  let session: vscode.DebugSession | undefined, terminated = false;
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker(s) {
      events.push({session: s.id, name: s.name, parent: s.parentSession?.id, type: s.type});
      if (s.name !== name && s.parentSession?.name !== name) return;
      return {onDidSendMessage(message) {
        if (message.type !== 'event') return;
        events.push({session: s.id, event: message.event, reason: message.body?.reason});
        if (message.event === 'stopped') {session = s; stops.push(message.body);}
        if (message.event === 'output') output.push(message.body.output);
        if (message.event === 'terminated' && session?.id === s.id) terminated = true;
      }};
    }
  });
  const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(program, new vscode.Position(1, 0)));
  vscode.debug.addBreakpoints([breakpoint]);
  try {
    assert.equal(await vscode.debug.startDebugging(undefined, {type: 'debugpy', request: 'launch', name,
      program: program.fsPath, cwd: root, python: runtime, console: 'internalConsole', redirectOutput: true, justMyCode: true}), true);
    await until(() => stops.length === 1 && !!session, 'actual breakpoint stop');
    assert.equal(stops[0].reason, 'breakpoint');
    const stack = await session!.customRequest('stackTrace', {threadId: stops[0].threadId});
    assert.equal(realpathSync(stack.stackFrames[0].source.path), realpathSync(program.fsPath));
    assert.equal(stack.stackFrames[0].line, 2);
    const before = await session!.customRequest('evaluate', {expression: 'value', frameId: stack.stackFrames[0].id, context: 'watch'});
    assert.equal(before.result, '6');
    await session!.customRequest('next', {threadId: stops[0].threadId});
    await until(() => stops.length === 2, 'step over');
    const next = await session!.customRequest('stackTrace', {threadId: stops[1].threadId});
    assert.equal(next.stackFrames[0].line, 3);
    const after = await session!.customRequest('evaluate', {expression: 'doubled', frameId: next.stackFrames[0].id, context: 'watch'});
    assert.equal(after.result, '12');
    await session!.customRequest('continue', {threadId: stops[1].threadId});
    await until(() => terminated, 'normal debug termination');
    assert.match(output.join(''), /\b12\b/);
    return {adapter: adapter.id, version: adapter.packageJSON.version, runtime, breakpoint: true, stack: true, watch: true, stepOver: true, output: true, normalTermination: true};
  } finally {
    writeFileSync(process.env.READYMADE_HOST_EVIDENCE + '.debug', JSON.stringify({events, stops, output}, null, 2), {mode: 0o600});
    vscode.debug.removeBreakpoints([breakpoint]);
    if (session && !terminated) await vscode.debug.stopDebugging(session);
    tracker.dispose();
  }
}

export async function run(): Promise<void> {
  const evidence = process.env.READYMADE_HOST_EVIDENCE!;
  try {
    const extension = vscode.extensions.getExtension('pataphor.readymade-ship-workspace'); assert.ok(extension);
    assert.ok(process.env.READYMADE_BUILTIN_EXTENSION, 'Qualification requires the shipped extension');
    assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
    const root = process.env.READYMADE_PYTHON_ROOT; assert.ok(root);
    assert.equal(realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), realpathSync(root));
    const result = {passed: true, editor: vscode.version, platform: process.platform, architecture: process.arch, root,
      language: await language(root), debugger: await debugging(root)};
    writeFileSync(evidence, JSON.stringify(result, null, 2), {mode: 0o600});
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({passed: false, error: String(error), stack: error instanceof Error ? error.stack : undefined}), {mode: 0o600}); throw error;
  }
}
