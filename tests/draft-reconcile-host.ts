import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {ReadymadeWorkspace} from '../src/extension';

export async function run(): Promise<void> {
  const evidence = process.env.READYMADE_HOST_EVIDENCE!;
  const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
  assert.ok(process.env.READYMADE_BUILTIN_EXTENSION);
  assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
  const api = await extension.activate();
  try {
    const origin = process.env.READYMADE_LIVE_ORIGIN, session = process.env.READYMADE_LIVE_SESSION;
    assert.ok(origin && session); await api.connect(origin);
    const state = await api.client!.codingState(session), selected = state.sessions.find(row => row.id === session);
    assert.ok(selected); assert.equal(selected.project, 'readymade-multifile-parity');
    await api.selectProject(String(selected.project)); await api.refresh(session);
    const sourceId = (selected.source as {id: string}).id;
    const versions = api.sources!.sources().filter(row => row.session === session && row.path === '/lib/session-estimate/hoon');
    const current = versions.find(row => row.source.id === sourceId);
    const previous = versions.find(row => row.source.id !== sourceId && row.source.number === 1);
    assert.ok(current && previous); assert.equal(current.source.number, 2);
    assert.equal(api.drafts.list().length, 0, 'Use a fresh isolated test profile');
    const before = api.sources!.openSnapshot(previous), latest = api.sources!.openSnapshot(current);
    const conflict = process.env.READYMADE_TEST_DRAFT_CONFLICT === '1';
    const marker = conflict ? '(mul participants' : '^-  @ud';
    const replacement = conflict ? '(add participants' : '^-  @ud  :: reconciliation preview';
    assert.equal(before.text.split(marker).length, 2); assert.equal(latest.text.split(marker).length, 2);
    await api.openSource(previous.uri); await vscode.commands.executeCommand('readymade.createDraft');
    const original = vscode.window.activeTextEditor!; assert.equal(original.document.uri.scheme, 'readymade-draft');
    const originalUri = original.document.uri.toString(), journal = api.drafts.get(originalUri);
    const local = before.text.replace(marker, replacement), expected = latest.text.replace(marker, replacement);
    assert.equal(await original.edit(edit => edit.replace(new vscode.Range(original.document.positionAt(0),
      original.document.positionAt(original.document.getText().length)), local)), true);
    assert.equal(original.document.isDirty, true);
    let submissions = 0;
    const nativeTool = api.client!.codingTool.bind(api.client);
    api.client!.codingTool = async () => {submissions++; throw new Error('Reconciliation must not submit a native tool for retained reads');};
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([vscode.commands.executeCommand('readymade.reconcileDraft'), new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Reconciliation UI deadline; no native command was submitted')), 45000);
      })]);
    } finally {clearTimeout(deadline);}
    const merged = vscode.window.activeTextEditor!;
    assert.notEqual(merged.document.uri.toString(), originalUri);
    if (conflict) {
      assert.equal(merged.document.getText(), latest.text, 'Resolution buffer must begin with exact current source');
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(tab?.input instanceof vscode.TabInputTextDiff);
      assert.equal(tab.input.original.toString(), originalUri);
      assert.equal(tab.input.modified.toString(), merged.document.uri.toString());
      assert.equal(await merged.edit(edit => edit.replace(new vscode.Range(merged.document.positionAt(0),
        merged.document.positionAt(merged.document.getText().length)), expected)), true);
    }
    assert.equal(merged.document.getText(), expected);
    assert.equal(original.document.getText(), local); assert.equal(original.document.isDirty, true);
    assert.deepEqual(api.drafts.get(originalUri), journal);
    assert.equal(await merged.document.save(), true);
    const retained = api.drafts.get(merged.document.uri.toString());
    assert.equal(retained.snapshot.uri, current.uri); assert.equal(retained.text, expected); assert.equal(retained.pending, undefined);
    let candidate: string | undefined, request: string | undefined;
    const prepare = process.env.READYMADE_TEST_RECONCILE_PREPARE === '1';
    if (prepare) {
      assert.equal(conflict, false, 'Native acceptance uses only the comment-only automatic merge');
      assert.equal(selected.phase, 'paused');
      const grants = state.grants as {revoked: boolean; writable: string[]; protected: string[]; operations: string[]}[];
      assert.ok(grants.some(g => !g.revoked && g.writable.includes(current.path) && g.operations.includes('replace') &&
        g.protected.includes('/lib/preserve/hoon')));
      const {candidateCommand} = await import(join(extension.extensionPath, 'dist/src/candidate-command.js')) as typeof import('../src/candidate-command');
      const input = candidateCommand(retained.snapshot, expected);
      writeFileSync(evidence + '.intent.json', JSON.stringify({session, source: current.source, draft: retained.id,
        input, originalHash: latest.contentHash, expectedText: expected, maximumSubmissions: 1,
        acceptanceAllowed: false, deploymentAllowed: false}, null, 2), {mode: 0o600, flag: 'wx'});
      api.client!.codingTool = async (target, source, command) => {
        assert.equal(submissions, 0); assert.equal(target, session); assert.equal(source, current.source.id); assert.equal(command, input);
        submissions++; return nativeTool(target, source, command);
      };
      await vscode.commands.executeCommand('readymade.prepareCandidate');
      for (let attempt = 0; attempt < 20; attempt++) {
        await api.refresh(session);
        const pending = api.drafts.get(retained.id).pending;
        if (pending?.phase === 'candidate' || pending?.phase === 'refused') break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      const pending = api.drafts.get(retained.id).pending;
      assert.equal(pending?.phase, 'candidate', 'Observe retained outcome; never rerun this submission');
      assert.equal(pending?.input, input); assert.equal(pending?.text, expected);
      candidate = pending.candidate; request = pending.request; assert.ok(candidate && request);
      assert.equal(submissions, 1);
    }
    const final = await api.client!.codingState(session);
    assert.deepEqual(final.sessions.find(row => row.id === session)?.source, selected.source); assert.equal(submissions, prepare ? 1 : 0);
    assert.deepEqual(api.drafts.get(originalUri), journal); assert.equal(original.document.getText(), local);
    writeFileSync(evidence, JSON.stringify({passed: true, live: true, scope: prepare ? 'Packaged reconciliation and one native candidate preparation; no acceptance or deployment' : 'Packaged registered command; real retained revisions; local draft only',
      project: selected.project, session, originalSource: previous.source, currentSource: current.source,
      originalBytes: before.byteLength, currentBytes: latest.byteLength, currentContentHash: latest.contentHash,
      unsavedOriginalPreserved: true, originalJournalPreserved: true, mergedSaved: true, nativeSubmissions: submissions,
      conflictUIExercised: conflict, candidatePrepared: prepare, candidate, request}, null, 2), {mode: 0o600});
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({passed: false, error: String(error)}), {mode: 0o600}); throw error;
  } finally {api.dispose();}
}
