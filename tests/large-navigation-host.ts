import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import type {ReadymadeWorkspace} from '../src/extension';

async function acceptance() {
  const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
  if (process.env.READYMADE_BUILTIN_EXTENSION) assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
  const {SourcePager} = await import(join(extension.extensionPath, 'dist/src/source-pager.js')) as typeof import('../src/source-pager');
  const {DurablePageJournal} = await import(join(extension.extensionPath, 'dist/src/page-journal.js')) as typeof import('../src/page-journal');
  const {sourceBasis, sameBasis} = await import(join(extension.extensionPath, 'dist/src/source-store.js')) as typeof import('../src/source-store');
  const session = process.env.READYMADE_LIVE_SESSION, origin = process.env.READYMADE_LIVE_ORIGIN;
  const expected = process.env.READYMADE_EXPECTED_FILE, mode = process.env.READYMADE_PAGE_MODE;
  const path = process.env.READYMADE_LIVE_FILE;
  assert.ok(session && origin && expected && path && ['first', 'finish', 'reopen', 'full'].includes(mode ?? ''));
  const bytes = readFileSync(expected); assert.ok(bytes.length > 61_440);
  const api = await extension.activate();
  try {
    await api.connect(origin);
    const state = await api.client!.codingState(session), selected = state.sessions.find(row => row.id === session); assert.ok(selected);
    assert.equal(selected.phase, 'paused');
    const basis = sourceBasis(selected.source); await api.selectProject(String(selected.project));
    const pager = new SourcePager(api.client!, api.sources!, new DurablePageJournal(join(dirname(process.env.READYMADE_HOST_EVIDENCE!), 'large-page-journal')));
    await api.refresh(session);
    const find = () => api.sources!.progress().find(row => row.session === session && row.path === path && sameBasis(row.source, basis));
    let calls = 0, refusals = 0;
    if (mode === 'full') {
      assert.equal(find(), undefined, 'Full opening must exercise an unread source');
      await vscode.commands.executeCommand('readymade.readFile', path, session, basis);
      assert.equal(find()?.next, null, 'One editor command must complete the whole file');
      assert.equal(vscode.window.activeTextEditor?.document.getText(), bytes.toString('utf8'));
    } else if (mode === 'first') {
      assert.equal(find(), undefined, 'Do not replay a retained first page');
      await pager.start(session, basis, path, String(selected.project), 1); calls++;
    } else {
      assert.ok(find(), 'Reopening must recover retained pages');
      if (mode === 'finish') assert.equal(find()!.next, 2);
      else assert.equal(find()!.next, null);
    }
    for (let step = 0; step < 256; step++) {
      await api.refresh(session);
      const progress = find();
      if (mode === 'first' && progress?.next === 2 || mode !== 'first' && progress?.next === null) break;
      if (mode === 'first') {
        assert.ok(step < 12, 'First page remains unresolved; do not replay');
        await new Promise(resolve => setTimeout(resolve, 1000)); continue;
      }
      assert.ok(progress, 'Retained page disappeared');
      const before = progress.next;
      try {await pager.next(progress.key, String(selected.project)); calls++;}
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('The ship refused this page as too large.')) throw error;
        refusals++; calls++; continue; // Exact retained refusal permits a smaller request.
      }
      for (let poll = 0; poll < 12 && find()?.next === before; poll++) {
        await new Promise(resolve => setTimeout(resolve, 1000)); await api.refresh(session);
      }
      assert.notEqual(find()?.next, before, 'Page outcome unresolved; do not replay');
    }
    const progress = find(); assert.ok(progress);
    if (mode === 'first') {assert.equal(progress.next, 2); assert.equal(progress.lines, 1);}
    else {
      assert.equal(progress.next, null, 'Bounded page traversal did not complete');
      const file = api.sources!.sources().find(row => row.session === session && row.path === path && sameBasis(row.source, basis)); assert.ok(file);
      assert.deepEqual(Buffer.from(api.sources!.bytes(file)), bytes);
      await api.openSource(file.uri);
      assert.equal(vscode.window.activeTextEditor!.document.getText(), bytes.toString('utf8'));
      await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(vscode.Uri.parse(file.uri), Buffer.from('forbidden'))));
      if (mode === 'reopen') assert.equal(calls, 0);
    }
    return {live: true, mode, session, source: basis, path, bytes: progress.bytes, lines: progress.lines, next: progress.next,
      calls: mode === 'full' ? null : calls, refusals: mode === 'full' ? null : refusals, exactBytes: mode !== 'first'};
  } finally {api.dispose();}
}
export async function run(): Promise<void> {
  const file = process.env.READYMADE_HOST_EVIDENCE!;
  try {writeFileSync(file, JSON.stringify({passed: true, ...await acceptance()}, null, 2), {mode: 0o600});}
  catch (error) {writeFileSync(file, JSON.stringify({passed: false, error: error instanceof Error ? error.message : String(error)}, null, 2), {mode: 0o600}); throw error;}
}
