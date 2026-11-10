import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {lstatSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}

/** Requires an owned remote process and an already authenticated loopback tunnel.
 * The tunnel is a transport only; this uses the installed Python debug adapter. */
export async function run(): Promise<void> {
  const evidence = process.env.READYMADE_HOST_EVIDENCE!;
  const events: object[] = [];
  let session: vscode.DebugSession | undefined, terminated = false;
  let tracker: vscode.Disposable | undefined, breakpoint: vscode.SourceBreakpoint | undefined;
  try {
    const root = process.env.READYMADE_PYTHON_ROOT, configPath = process.env.READYMADE_REMOTE_DEBUG_CONFIG;
    assert.ok(root && configPath && process.env.READYMADE_BUILTIN_EXTENSION);
    for (const path of [root, configPath]) {
      const info = lstatSync(path); assert.equal(info.uid, process.getuid?.());
      assert.ok(!info.isSymbolicLink());
      assert.equal(info.mode & 0o777, path === root ? 0o700 : 0o600);
    }
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.ok(Number.isInteger(config.port) && config.port > 0 && config.port < 65536);
    assert.ok(Number.isInteger(config.pid) && config.pid > 0);
    assert.equal(config.platform, 'Linux');
    assert.match(config.remoteRoot, /^\/[A-Za-z0-9_/-]+$/);
    assert.ok(!config.remoteRoot.split('/').includes('..'));
    const extension = vscode.extensions.getExtension('pataphor.readymade-ship-workspace'); assert.ok(extension);
    assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
    assert.equal(realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), realpathSync(root));
    const adapter = vscode.extensions.getExtension('ms-python.debugpy'); assert.ok(adapter); await adapter.activate();
    const program = vscode.Uri.file(join(root, 'remote.py'));
    const source = readFileSync(program.fsPath, 'utf8');
    assert.equal(createHash('sha256').update(source).digest('hex'), config.sourceSha256);
    const line = source.split('\n').indexOf('doubled = value * 2'); assert.ok(line >= 0);
    const name = `Readymade remote Python ${Date.now()}`;
    const stops: {threadId: number; reason: string}[] = [];
    tracker = vscode.debug.registerDebugAdapterTrackerFactory('debugpy', {createDebugAdapterTracker(s) {
      if (s.name !== name && s.parentSession?.name !== name) return;
      session = s;
      return {onDidSendMessage(message) {
        if (message.type !== 'event') return;
        events.push({event: message.event, reason: message.body?.reason});
        if (message.event === 'stopped') {session = s; stops.push(message.body);}
        if (message.event === 'terminated') terminated = true;
      }};
    }});
    breakpoint = new vscode.SourceBreakpoint(new vscode.Location(program, new vscode.Position(line, 0)));
    vscode.debug.addBreakpoints([breakpoint]);
    assert.equal(await vscode.debug.startDebugging(undefined, {type: 'debugpy', request: 'attach', name,
      connect: {host: '127.0.0.1', port: config.port}, justMyCode: true,
      pathMappings: [{localRoot: root, remoteRoot: config.remoteRoot}]}), true);
    await until(() => stops.length === 1 && !!session, 'remote breakpoint');
    assert.equal(stops[0].reason, 'breakpoint');
    const stack = await session!.customRequest('stackTrace', {threadId: stops[0].threadId});
    assert.equal(realpathSync(stack.stackFrames[0].source.path), realpathSync(program.fsPath));
    assert.equal(stack.stackFrames[0].line, line + 1);
    const evaluate = async (expression: string, frameId: number): Promise<string> =>
      (await session!.customRequest('evaluate', {expression, frameId, context: 'watch'})).result;
    assert.equal(await evaluate('value', stack.stackFrames[0].id), '7');
    assert.equal(Number(await evaluate("__import__('os').getpid()", stack.stackFrames[0].id)), config.pid);
    assert.equal(await evaluate("__import__('sys').platform", stack.stackFrames[0].id), "'linux'");
    await session!.customRequest('next', {threadId: stops[0].threadId});
    await until(() => stops.length === 2, 'remote step over');
    const next = await session!.customRequest('stackTrace', {threadId: stops[1].threadId});
    assert.equal(await evaluate('doubled', next.stackFrames[0].id), '14');
    await session!.customRequest('continue', {threadId: stops[1].threadId});
    await until(() => terminated, 'remote debugger termination');
    writeFileSync(evidence, JSON.stringify({passed: true, editor: vscode.version, clientPlatform: process.platform,
      adapter: adapter.id, version: adapter.packageJSON.version, remotePid: config.pid, remotePlatform: 'Linux',
      sourceSha256: config.sourceSha256, pathMapping: true, breakpoint: true, watch: true,
      stepOver: true, debuggerTerminated: true, processExitRequiresIndependentReadback: true}, null, 2), {mode: 0o600});
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({passed: false, error: String(error), stack: error instanceof Error ? error.stack : undefined}), {mode: 0o600}); throw error;
  } finally {
    if (session && !terminated) await Promise.resolve(session.customRequest('disconnect', {terminateDebuggee: false})).catch(() => undefined);
    if (breakpoint) vscode.debug.removeBreakpoints([breakpoint]);
    tracker?.dispose();
    writeFileSync(evidence + '.debug', JSON.stringify({events, terminated}, null, 2), {mode: 0o600});
  }
}
