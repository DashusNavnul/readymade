import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {ReadymadeWorkspace} from '../src/extension';

async function acceptance() {
  const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
  if (process.env.READYMADE_BUILTIN_EXTENSION) assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
  const {sourceBasis} = await import(join(extension.extensionPath, 'dist/src/source-store.js')) as typeof import('../src/source-store');
  const {candidateCommand} = await import(join(extension.extensionPath, 'dist/src/candidate-command.js')) as typeof import('../src/candidate-command');
  const session = process.env.READYMADE_LIVE_SESSION, origin = process.env.READYMADE_LIVE_ORIGIN;
  const baselineFile = process.env.READYMADE_BASELINE_FILE, expectedFile = process.env.READYMADE_EXPECTED_FILE;
  assert.ok(session && origin && baselineFile && expectedFile);
  const baseline = readFileSync(baselineFile, 'utf8'), expected = readFileSync(expectedFile, 'utf8');
  assert.ok(Buffer.byteLength(baseline) > 90_000 && baseline !== expected);
  const path = '/lib/large-session-estimate/hoon', api = await extension.activate();
  try {
    await api.connect(origin);
    const state = await api.client!.codingState(session), selected = state.sessions.find(s => s.id === session); assert.ok(selected);
    assert.equal(selected.project, 'readymade-large-edit-acceptance'); assert.equal(selected.phase, 'paused');
    const basis = sourceBasis(selected.source); assert.equal(basis.desk, process.env.READYMADE_EXPECTED_DESK ?? 'rm-large-edit-session');
    await api.selectProject(String(selected.project)); await api.refresh(session);
    assert.equal(api.drafts.list().filter(d => d.snapshot.session === session).length, 0, 'Never resubmit an existing test draft');
    await vscode.commands.executeCommand('readymade.readFile', path, session, basis);
    assert.equal(vscode.window.activeTextEditor?.document.getText(), baseline);
    await vscode.commands.executeCommand('readymade.createDraft');
    const editor = vscode.window.activeTextEditor; assert.ok(editor); assert.equal(editor.document.uri.scheme, 'readymade-draft');
    const uri = editor.document.uri.toString();
    const end = editor.document.positionAt(editor.document.getText().length);
    assert.equal(await editor.edit(builder => builder.replace(new vscode.Range(new vscode.Position(0, 0), end), expected)), true);
    assert.equal(await editor.document.save(), true);
    const draft = api.drafts.get(uri); assert.equal(draft.text, expected); assert.equal(draft.snapshot.text, baseline);
    const command = candidateCommand(draft.snapshot, expected); assert.match(command, /^\/patches 2\n/);
    assert.ok(Buffer.byteLength(command) < 512); assert.equal(draft.pending, undefined);
    // Exactly one submit. Subsequent activity only observes retained evidence.
    await vscode.commands.executeCommand('readymade.prepareCandidate');
    for (let poll = 0; poll < 30; poll++) {
      await api.refresh(session);
      const pending = api.drafts.get(uri).pending;
      if (pending?.phase === 'candidate' || pending?.phase === 'refused') break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const retained = api.drafts.get(uri); assert.equal(retained.pending?.phase, 'candidate', JSON.stringify(retained.pending));
    assert.equal(retained.pending?.input, command); assert.equal(retained.pending?.text, expected);
    assert.equal(editor.document.getText(), expected);
    return {live: true, session, source: basis, path, originalBytes: Buffer.byteLength(baseline), editedBytes: Buffer.byteLength(expected),
      commandBytes: Buffer.byteLength(command), patches: 2, candidate: retained.pending!.candidate, request: retained.pending!.request,
      draft: retained.id, oneSubmission: true, checked: false, reviewed: false, landed: false};
  } finally {api.dispose();}
}
export async function run(): Promise<void> {
  const file = process.env.READYMADE_HOST_EVIDENCE!;
  try {writeFileSync(file, JSON.stringify({passed: true, ...await acceptance()}, null, 2), {mode: 0o600});}
  catch (error) {writeFileSync(file, JSON.stringify({passed: false, error: error instanceof Error ? error.message : String(error)}, null, 2), {mode: 0o600}); throw error;}
}
