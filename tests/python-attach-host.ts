import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {existsSync, lstatSync, realpathSync, writeFileSync} from 'node:fs';
import {spawn, type ChildProcess} from 'node:child_process';
import {delimiter, join} from 'node:path';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}

export async function run(): Promise<void> {
  const evidence = process.env.READYMADE_HOST_EVIDENCE!;
  const output: string[] = [], errors: string[] = [], events: object[] = [];
  let child: ChildProcess | undefined, session: vscode.DebugSession | undefined;
  let tracker: vscode.Disposable | undefined, breakpoint: vscode.SourceBreakpoint | undefined;
  let exited = false, exitCode: number | null = null, terminated = false;
  try {
    const root = process.env.READYMADE_PYTHON_ROOT, runtime = process.env.READYMADE_TEST_PYTHON_BIN;
    assert.ok(root && runtime && process.env.READYMADE_BUILTIN_EXTENSION);
    const info = lstatSync(root); assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(info.uid, process.getuid?.()); assert.equal(info.mode & 0o777, 0o700);
    const extension = vscode.extensions.getExtension('pataphor.readymade-ship-workspace'); assert.ok(extension);
    assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
    assert.equal(realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), realpathSync(root));
    const adapter = vscode.extensions.getExtension('ms-python.debugpy'); assert.ok(adapter); await adapter.activate();
    const libraries = join(adapter.extensionPath, 'bundled', 'libs');
    assert.ok(existsSync(join(libraries, 'debugpy', '__init__.py')));
    const program = vscode.Uri.file(join(root, 'attach.py'));
    const lines = ['import debugpy, json, sys, time',
      'address = debugpy.listen(("127.0.0.1", 0))',
      'print(json.dumps({"port": address[1]}), flush=True)',
      'deadline = time.monotonic() + 45',
      'while not debugpy.is_client_connected():',
      '    if time.monotonic() >= deadline: sys.exit(2)',
      '    time.sleep(0.05)',
      'debugpy.wait_for_client()', 'value = 7', 'doubled = value * 2', 'print("RESULT", doubled, flush=True)', ''];
    writeFileSync(program.fsPath, lines.join('\n'), {flag: 'wx', mode: 0o600});
    const name = `Readymade Python attach ${Date.now()}`;
    const stops: {threadId: number; reason: string}[] = [];
    tracker = vscode.debug.registerDebugAdapterTrackerFactory('debugpy', {
      createDebugAdapterTracker(s) {
        if (s.name !== name && s.parentSession?.name !== name) return;
        session = s;
        return {onDidSendMessage(message) {
          if (message.type !== 'event') return;
          events.push({event: message.event, reason: message.body?.reason});
          if (message.event === 'stopped') {session = s; stops.push(message.body);}
          if (message.event === 'terminated') terminated = true;
        }};
      }
    });
    breakpoint = new vscode.SourceBreakpoint(new vscode.Location(program, new vscode.Position(lines.indexOf('doubled = value * 2'), 0)));
    vscode.debug.addBreakpoints([breakpoint]);
    child = spawn(runtime, ['-u', program.fsPath], {cwd: root, env: {...process.env,
      PYTHONPATH: [libraries, process.env.PYTHONPATH].filter(Boolean).join(delimiter)}, stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout!.on('data', chunk => output.push(chunk.toString()));
    child.stderr!.on('data', chunk => errors.push(chunk.toString()));
    child.on('error', error => errors.push(String(error)));
    child.on('exit', code => {exited = true; exitCode = code;});
    await until(() => /\{"port":\s*\d+\}/.test(output.join('')) || exited, 'external debug server address');
    assert.equal(exited, false, errors.join(''));
    const port = Number(/\{"port":\s*(\d+)\}/.exec(output.join(''))![1]);
    assert.ok(port > 0 && port < 65536); assert.ok(child.pid);
    assert.equal(await vscode.debug.startDebugging(undefined, {type: 'debugpy', request: 'attach', name,
      connect: {host: '127.0.0.1', port}, justMyCode: true, python: runtime}), true);
    await until(() => stops.length === 1 && !!session, 'attached breakpoint');
    assert.equal(stops[0].reason, 'breakpoint');
    const stack = await session!.customRequest('stackTrace', {threadId: stops[0].threadId});
    assert.equal(realpathSync(stack.stackFrames[0].source.path), realpathSync(program.fsPath));
    assert.equal(stack.stackFrames[0].line, lines.indexOf('doubled = value * 2') + 1);
    const value = await session!.customRequest('evaluate', {expression: 'value', frameId: stack.stackFrames[0].id, context: 'watch'});
    assert.equal(value.result, '7');
    const pid = await session!.customRequest('evaluate', {expression: "__import__('os').getpid()", frameId: stack.stackFrames[0].id, context: 'watch'});
    assert.equal(Number(pid.result), child.pid, 'Attach must target the independently launched process');
    await session!.customRequest('next', {threadId: stops[0].threadId});
    await until(() => stops.length === 2, 'attached step over');
    const next = await session!.customRequest('stackTrace', {threadId: stops[1].threadId});
    const doubled = await session!.customRequest('evaluate', {expression: 'doubled', frameId: next.stackFrames[0].id, context: 'watch'});
    assert.equal(doubled.result, '14');
    await session!.customRequest('continue', {threadId: stops[1].threadId});
    await until(() => exited && terminated, 'normal external process and debugger termination');
    assert.equal(exitCode, 0); assert.match(output.join(''), /RESULT 14/);
    writeFileSync(evidence, JSON.stringify({passed: true, editor: vscode.version, platform: process.platform,
      architecture: process.arch, adapter: adapter.id, version: adapter.packageJSON.version, runtime,
      externalProcess: child.pid, loopbackAttach: true, breakpoint: true, stack: true, watch: true,
      stepOver: true, output: 'RESULT 14', normalTermination: true, pidInjection: false, crossMachine: false}, null, 2), {mode: 0o600});
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({passed: false, error: String(error), stack: error instanceof Error ? error.stack : undefined}), {mode: 0o600}); throw error;
  } finally {
    if (session && !terminated) await Promise.resolve(session.customRequest('disconnect', {terminateDebuggee: false})).catch(() => undefined);
    if (breakpoint) vscode.debug.removeBreakpoints([breakpoint]);
    tracker?.dispose();
    writeFileSync(evidence + '.debug', JSON.stringify({output, errors, events, exited, exitCode, pid: child?.pid}, null, 2), {mode: 0o600});
  }
}
