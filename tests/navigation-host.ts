import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {realpathSync, writeFileSync} from 'node:fs';
import type {ReadymadeWorkspace} from '../src/extension';
import type {MediaTreeRow} from '../src/media-workbench';

function flatten(rows: MediaTreeRow[]): MediaTreeRow[] {
  return rows.flatMap(row => [row, ...flatten(row.children ?? [])]);
}
async function acceptance() {
  const durations: Record<string, number> = {};
  const requests: {operation: string; after?: number; startedMs: number; durationMs: number; passed: boolean}[] = [];
  const started = performance.now();
  let previous = performance.now();
  const mark = (stage: string) => { const now = performance.now(); durations[stage] = now - previous; previous = now; };
  const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
  if (process.env.READYMADE_BUILTIN_EXTENSION) assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
  const session = process.env.READYMADE_LIVE_SESSION, origin = process.env.READYMADE_LIVE_ORIGIN;
  assert.ok(session && origin, 'Live navigation requires an explicit origin and session');
  const api = await extension.activate();
  mark('activation');
  try {
    await api.connect(origin);
    mark('connection');
    const client = api.client!, read = client.codingState.bind(client), tool = client.codingTool.bind(client);
    client.codingState = async (...args) => {
      const at = performance.now(); let passed = false;
      try { const result = await read(...args); passed = true; return result; }
      finally { requests.push({operation: 'state', after: args[1] ?? 0, startedMs: at - started, durationMs: performance.now() - at, passed}); }
    };
    client.codingTool = async (...args) => {
      const at = performance.now(); let passed = false;
      try { const result = await tool(...args); passed = true; return result; }
      finally { requests.push({operation: 'tool', startedMs: at - started, durationMs: performance.now() - at, passed}); }
    };
    const state = await api.client!.codingState(session), selected = state.sessions.find(row => row.id === session); assert.ok(selected);
    mark('sessionObservation');
    await api.selectProject(String(selected.project));
    mark('projectSelection');
    await api.files.open(session, '/lib');
    mark('directoryOpen');
    let rows = flatten(api.files.rows());
    for (let attempt = 0; attempt < 12 && rows.some(row => row.label === 'Waiting for retained result'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await api.files.refresh(); rows = flatten(api.files.rows());
    }
    mark('directorySettlement');
    const refusal = rows.find(row => row.label.startsWith('Refused:'));
    assert.equal(refusal, undefined, refusal?.label);
    assert.ok(!rows.some(row => row.label === 'Waiting for retained result'), 'Directory receipt remains unresolved; do not replay');
    const files = rows.filter(row => row.command?.command === 'readymade.readFile');
    assert.ok(files.length > 0, 'Live directory must contain source files');
    const file = files.find(row => row.tooltip === '/lib/session-estimate/hoon'); assert.ok(file);
    await vscode.commands.executeCommand(file.command!.command, ...file.command!.arguments!);
    mark('fileRead');
    await api.refresh(session);
    mark('sessionRefresh');
    const currentSource = api.client!.snapshot?.sessions.find(row => row.id === session)?.source as {id?: string} | undefined;
    assert.ok(currentSource?.id, 'Fresh selected source must be available');
    const source = api.sources!.sources().find(row => row.session === session && row.source.id === currentSource.id && row.path === '/lib/session-estimate/hoon');
    assert.ok(source, 'Read must resolve to a complete retained file');
    await api.openSource(source.uri);
    mark('sourcePresentation');
    const document = vscode.window.activeTextEditor!.document;
    assert.equal(document.uri.scheme, 'urbit-source');
    assert.equal(Buffer.byteLength(document.getText()), source.byteLength);
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(document.uri, Buffer.from('forbidden'))));
    let directoryReconnect;
    if (process.env.READYMADE_TEST_DIRECTORY_RECONNECT === '1') {
      const observed = client.codingState.bind(client);
      let release!: () => void, received!: () => void, rejectRead!: (error: unknown) => void;
      const gate = new Promise<void>(resolve => {release = resolve;});
      const response = new Promise<void>((resolve, reject) => {received = resolve; rejectRead = reject;});
      client.codingState = async (...args) => {
        try {
          const state = await observed(...args);
          received(); await gate; return state;
        } catch (error) {rejectRead(error); throw error;}
      };
      const pending = api.files.refresh();
      // Attach a handler immediately; the original operation is still awaited below.
      void pending.catch(() => undefined);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([response, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Directory response did not arrive')), 30000);
        })]);
        api.files.connect(client);
      } finally {
        clearTimeout(timeout); client.codingState = observed; release();
      }
      await pending;
      assert.equal(flatten(api.files.rows()).filter(row => row.command?.command === 'readymade.readFile').length, 0,
        'Old response repopulated the reconnected directory');
      await api.files.open(session, '/lib');
      const reopened = flatten(api.files.rows()).filter(row => row.command?.command === 'readymade.readFile');
      assert.deepEqual(reopened.map(row => row.tooltip), files.map(row => row.tooltip));
      directoryReconnect = {scope: 'Packaged directory controller rebound to the same authenticated live client; real GET response delayed by harness',
        staleResponseDiscarded: true, reopenedFiles: reopened.length};
      mark('directoryReconnect');
    }
    return {live: true, session, project: selected.project, listedFiles: files.length, path: source.path,
      source: source.source, bytes: source.byteLength, contentHash: source.contentHash, readOnly: true, directoryReconnect,
      timings: {clock: 'monotonic performance.now', unit: 'milliseconds', scope: 'Sequential awaited operations; excludes application startup before test entry; request trace starts after connection', durations, requests}};
  } finally {api.dispose();}
}
export async function run(): Promise<void> {
  const file = process.env.READYMADE_HOST_EVIDENCE!;
  try {writeFileSync(file, JSON.stringify({passed: true, ...await acceptance()}, null, 2), {mode: 0o600});}
  catch (error) {writeFileSync(file, JSON.stringify({passed: false, error: error instanceof Error ? error.message : String(error)}, null, 2), {mode: 0o600}); throw error;}
}
