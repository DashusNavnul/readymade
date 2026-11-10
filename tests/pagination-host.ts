import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import type {ReadymadeWorkspace} from '../src/extension';

async function acceptance() {
  const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
  const {SourcePager} = await import(join(extension.extensionPath, 'dist/src/source-pager.js')) as typeof import('../src/source-pager');
  const {DurablePageJournal} = await import(join(extension.extensionPath, 'dist/src/page-journal.js')) as typeof import('../src/page-journal');
  const {sourceBasis, sameBasis} = await import(join(extension.extensionPath, 'dist/src/source-store.js')) as typeof import('../src/source-store');
  const session = process.env.READYMADE_LIVE_SESSION, origin = process.env.READYMADE_LIVE_ORIGIN;
  const expected = process.env.READYMADE_EXPECTED_FILE, mode = process.env.READYMADE_PAGE_MODE;
  assert.ok(session && origin && expected && (mode === 'first' || mode === 'finish'));
  const api = await extension.activate(), path = '/lib/session-duration/hoon';
  try {
    await api.connect(origin); const state = await api.client!.codingState(session);
    const selected = state.sessions.find(row => row.id === session); assert.ok(selected);
    const basis = sourceBasis(selected.source); await api.selectProject(String(selected.project));
    await api.refresh(session);
    const find = () => api.sources!.progress().find(row => row.session === session && row.path === path && sameBasis(row.source, basis));
    if (mode === 'first') {
      assert.equal(find(), undefined, 'Choose an unread live source; do not replay a retained page');
      const pager = new SourcePager(api.client!, api.sources!, new DurablePageJournal(join(dirname(process.env.READYMADE_HOST_EVIDENCE!), 'initial-page-journal')));
      await pager.start(session, basis, path, String(selected.project), 1);
    } else {
      assert.equal(find()?.next, 2, 'Reopened window must recover the exact partial read');
      await vscode.commands.executeCommand('readymade.readNextPage', find()!.key);
    }
    for (let attempt = 0; attempt < 12; attempt++) {
      await api.refresh(session);
      if (mode === 'first' ? find()?.next === 2 : find()?.next === null) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const progress = find(); assert.ok(progress);
    if (mode === 'first') {
      assert.equal(progress.next, 2); assert.equal(progress.lines, 1);
      assert.ok(!api.sources!.sources().some(row => row.path === path && sameBasis(row.source, basis)));
    } else {
      assert.equal(progress.next, null);
      const file = api.sources!.sources().find(row => row.path === path && sameBasis(row.source, basis)); assert.ok(file);
      assert.deepEqual(Buffer.from(api.sources!.bytes(file)), readFileSync(expected));
      await api.openSource(file.uri);
      assert.equal(vscode.window.activeTextEditor!.document.getText(), readFileSync(expected, 'utf8'));
      await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(vscode.Uri.parse(file.uri), Buffer.from('forbidden'))));
    }
    return {live: true, mode, session, source: basis, path, lines: progress.lines, bytes: progress.bytes, next: progress.next, exactBytes: mode === 'finish'};
  } finally {api.dispose();}
}
export async function run(): Promise<void> {
  const file = process.env.READYMADE_HOST_EVIDENCE!;
  try {writeFileSync(file, JSON.stringify({passed: true, ...await acceptance()}, null, 2), {mode: 0o600});}
  catch (error) {writeFileSync(file, JSON.stringify({passed: false, error: error instanceof Error ? error.message : String(error)}, null, 2), {mode: 0o600}); throw error;}
}
