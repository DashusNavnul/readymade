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

async function language(root: string): Promise<object> {
  const provider = vscode.extensions.getExtension('vscode.typescript-language-features');
  assert.ok(provider); await provider.activate();
  const helper = vscode.Uri.file(join(root, 'helper.ts')), main = vscode.Uri.file(join(root, 'main.ts'));
  writeFileSync(helper.fsPath, 'export function twice(value:number){return value*2;}\n');
  writeFileSync(main.fsPath, 'import {twice} from "./helper";\nconst value: number = "wrong";\nconst result = twice(6);\nresult.toFixed();\n');
  const document = await vscode.workspace.openTextDocument(main);
  await vscode.window.showTextDocument(document);
  assert.equal(document.languageId, 'typescript');
  await until(() => vscode.languages.getDiagnostics(main).some(d => d.code === 2322), 'real TypeScript type error');
  const completion = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', main, new vscode.Position(3, 7));
  assert.ok(completion?.items.some(i => (typeof i.label === 'string' ? i.label : i.label.label) === 'toFixed'));
  const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', main, new vscode.Position(2, 7));
  assert.ok(hover?.some(h => h.contents.some(c => (typeof c === 'string' ? c : c.value).includes('number'))));
  const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', main, new vscode.Position(2, 17));
  assert.ok(definitions?.some(d => ('targetUri' in d ? d.targetUri : d.uri).toString() === helper.toString()));
  const helperDocument = await vscode.workspace.openTextDocument(helper);
  const rename = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', helper, new vscode.Position(0, 18), 'doubleValue');
  assert.ok(rename && rename.entries().some(([uri]) => uri.toString() === helper.toString()));
  assert.ok(rename.entries().some(([uri]) => uri.toString() === main.toString()));
  assert.equal(await vscode.workspace.applyEdit(rename), true);
  assert.match(helperDocument.getText(), /function doubleValue/);
  assert.match(document.getText(), /doubleValue\(6\)/);
  const format = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', helper, {tabSize: 2, insertSpaces: true});
  assert.ok(format?.length);
  const edits = new vscode.WorkspaceEdit(); edits.set(helper, format);
  const start = document.getText().indexOf('"wrong"'); assert.ok(start >= 0);
  edits.replace(main, new vscode.Range(document.positionAt(start), document.positionAt(start + 7)), '6');
  assert.equal(await vscode.workspace.applyEdit(edits), true);
  assert.equal(await document.save(), true); assert.equal(await helperDocument.save(), true);
  await until(() => !vscode.languages.getDiagnostics(main).some(d => d.severity === vscode.DiagnosticSeverity.Error), 'type error clears after edit');
  return {provider: provider.id, version: provider.packageJSON.version, diagnostics: true, completion: true, hover: true, definition: true, crossFileRename: true, formatting: true};
}

async function debugging(root: string): Promise<object> {
  const runtime = process.env.READYMADE_TEST_NODE_BIN; assert.ok(runtime, 'Supply the actual Node runtime path');
  const adapter = vscode.extensions.getExtension('ms-vscode.js-debug'); assert.ok(adapter); await adapter.activate();
  const program = vscode.Uri.file(join(root, 'debug.cjs'));
  writeFileSync(program.fsPath, 'const input = 6;\nconst doubled = input * 2;\nconsole.log(doubled);\n');
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
    assert.equal(await vscode.debug.startDebugging(undefined, {type: 'pwa-node', request: 'launch', name,
      program: program.fsPath, cwd: root, runtimeExecutable: runtime, console: 'internalConsole', outputCapture: 'std', skipFiles: ['<node_internals>/**']}), true);
    await until(() => stops.length === 1 && !!session, 'actual breakpoint stop');
    assert.equal(stops[0].reason, 'breakpoint');
    const stack = await session!.customRequest('stackTrace', {threadId: stops[0].threadId});
    assert.equal(realpathSync(stack.stackFrames[0].source.path), realpathSync(program.fsPath));
    assert.equal(stack.stackFrames[0].line, 2);
    const before = await session!.customRequest('evaluate', {expression: 'input', frameId: stack.stackFrames[0].id, context: 'watch'});
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
    const root = mkdtempSync(join(tmpdir(), 'readymade-language-'));
    const result = {passed: true, editor: vscode.version, platform: process.platform, architecture: process.arch, root,
      language: await language(root), debugger: await debugging(root)};
    writeFileSync(evidence, JSON.stringify(result, null, 2), {mode: 0o600});
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({passed: false, error: String(error), stack: error instanceof Error ? error.stack : undefined}), {mode: 0o600}); throw error;
  }
}
