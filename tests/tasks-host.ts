import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {lstatSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}

export async function run(): Promise<void> {
  const evidence = process.env.READYMADE_HOST_EVIDENCE!;
  const subscriptions: vscode.Disposable[] = [];
  const events: object[] = [];
  try {
    const root = process.env.READYMADE_TASK_ROOT;
    assert.ok(root && process.env.READYMADE_BUILTIN_EXTENSION);
    const info = lstatSync(root);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(info.uid, process.getuid?.()); assert.equal(info.mode & 0o777, 0o700);
    assert.equal(readFileSync(join(root, '.readymade-test-root'), 'utf8'), 'isolated task acceptance\n');
    assert.equal(realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), realpathSync(root));
    const extension = vscode.extensions.getExtension('pataphor.readymade-ship-workspace'); assert.ok(extension);
    assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
    const uri = vscode.Uri.file(join(root, 'example.ts'));
    const label = 'Readymade task acceptance';
    const tasks = await vscode.tasks.fetchTasks();
    const task = tasks.find(item => item.name === label); assert.ok(task);
    assert.equal(task.group?.id, vscode.TaskGroup.Build.id);
    const outcomes: {execution: vscode.TaskExecution; code: number | undefined}[] = [];
    const ended: vscode.TaskExecution[] = [];
    subscriptions.push(vscode.tasks.onDidStartTask(event => events.push({event: 'start', name: event.execution.task.name})));
    subscriptions.push(vscode.tasks.onDidStartTaskProcess(event => events.push({event: 'process-start', name: event.execution.task.name, pid: event.processId})));
    subscriptions.push(vscode.tasks.onDidEndTask(event => {ended.push(event.execution); events.push({event: 'end', name: event.execution.task.name});}));
    subscriptions.push(vscode.tasks.onDidEndTaskProcess(event => {outcomes.push({execution: event.execution, code: event.exitCode}); events.push({event: "process-end", name: event.execution.task.name, code: event.exitCode});}));
    const matching = () => outcomes.filter(item => item.execution.task.name === label);
    if (process.env.READYMADE_TASK_BACKGROUND === '1') {
      assert.equal(task.isBackground, true);
      const processes: number[] = [];
      for (let run = 0; run < 2; run++) {
        if (run) writeFileSync(uri.fsPath, 'const answer: number = "wrong";\n');
        const activeTask = (await vscode.tasks.fetchTasks()).find(item => item.name === label); assert.ok(activeTask);
        const execution = await vscode.tasks.executeTask(activeTask);
        await until(() => vscode.languages.getDiagnostics(uri).some(item => item.source === 'readymade-build' && (item.code === 2322 || item.code === '2322')), 'watch compiler diagnostic');
        assert.equal(matching().length, run, 'Watcher stays active while awaiting the edit');
        writeFileSync(uri.fsPath, 'const answer: number = 42;\n');
        await until(() => matching().length === run + 1 && ended.includes(execution), 'watch task natural completion');
        assert.equal(matching()[run].code, 0);
        await until(() => vscode.languages.getDiagnostics(uri).length === 0, 'watch diagnostic cleared');
        const proof = JSON.parse(readFileSync(join(root, 'watch-result.json'), 'utf8'));
        assert.deepEqual(proof.rounds, [1, 0]); assert.equal(proof.code, 0);
        assert.ok(Number.isSafeInteger(proof.pid)); processes.push(proof.pid);
      }
      assert.notEqual(processes[0], processes[1]);
      writeFileSync(evidence, JSON.stringify({passed: true, editor: vscode.version, background: true,
        realCompilerWatcher: true, compilationsPerProcess: [1, 0], sequentialRuns: 2,
        diagnosticsCleared: true, naturalExit: true, processes}, null, 2), {mode: 0o600});
      return;
    }
    const first = await vscode.tasks.executeTask(task);
    await until(() => matching().length === 1, 'failing compiler task exit');
    assert.equal(matching()[0].code, 2);
    await until(() => vscode.languages.getDiagnostics(uri).some(item => item.code === 2322 || item.code === '2322'), 'compiler problem matcher');
    const diagnostic = vscode.languages.getDiagnostics(uri).find(item => item.code === 2322 || item.code === '2322')!;
    assert.equal(diagnostic.source, "readymade-build");
    assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
    assert.equal(diagnostic.range.start.line, 0);
    await until(() => ended.includes(first), 'first task lifecycle completed');
    writeFileSync(uri.fsPath, 'const answer: number = 42;\n');
    const repairedTask = (await vscode.tasks.fetchTasks()).find(item => item.name === label); assert.ok(repairedTask);
    await vscode.tasks.executeTask(repairedTask);
    await until(() => matching().length === 2, 'repaired compiler task exit');
    assert.equal(matching()[1].code, 0);
    await until(() => vscode.languages.getDiagnostics(uri).length === 0, 'stale task diagnostic cleared');
    writeFileSync(evidence, JSON.stringify({passed: true, editor: vscode.version, configuredBuildTask: true,
      realCompiler: true, failedExit: 2, problemCode: 2322, problemFileAndLine: true,
      repairedExit: 0, diagnosticsCleared: true, platform: process.platform, architecture: process.arch}, null, 2), {mode: 0o600});
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({passed: false, events, active: vscode.tasks.taskExecutions.map(item => item.task.name), diagnostics: vscode.languages.getDiagnostics().map(([uri, diagnostics]) => ({file: uri.fsPath, count: diagnostics.length})), error: String(error), stack: error instanceof Error ? error.stack : undefined}), {mode: 0o600});
    throw error;
  } finally {subscriptions.forEach(item => item.dispose());}
}
