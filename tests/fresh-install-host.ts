import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {lstatSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import type {ReadymadeWorkspace} from '../src/extension';

// Recover a completed real session in a clean packaged editor, without new jobs.
async function completedAcceptance(api: ReadymadeWorkspace, session: string) {
  const id = process.env.READYMADE_LIVE_CANDIDATE;
  const expectedFile = process.env.READYMADE_EXPECTED_FILE;
  assert.ok(id && expectedFile && api.client && api.sources);
  const state = await api.client.codingState(session);
  const selected = state.sessions.find(row => row.id === session);
  assert.ok(selected); assert.equal(selected.phase, 'complete');
  await api.selectProject(String(selected.project));
  await api.refresh(session);
  const native = state.reviews?.find(row => row.id === id);
  assert.ok(native); assert.equal(native.stage, 'applied'); assert.equal(native.decision, 'approve');
  await api.codeReview.observe(session); await api.codeReview.show(id);
  const candidateDocument = vscode.window.activeTextEditor!.document;
  assert.equal(candidateDocument.uri.scheme, 'readymade-candidate');
  const shown = JSON.parse(candidateDocument.getText());
  assert.equal(shown.id, id); assert.equal(shown.session, session);
  assert.equal(shown.project, selected.project);
  for (const field of ['landed', 'basis', 'edits', 'checks']) assert.deepEqual(shown[field], native[field]);
  assert.equal(shown.stage, 'applied'); assert.equal(shown.decision, 'approve');
  assert.equal(shown.reviewProcess.campaign.outcome, 'accept');
  assert.equal(shown.edits.length, 1); assert.equal(shown.checks.length, 2);
  assert.ok(shown.checks.every((check: {passed: boolean}) => check.passed));
  await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(candidateDocument.uri, Buffer.from('forbidden'))));
  await api.checks.observe(session);
  const reports = api.checks.rows()[0].children!.filter(row => row.command?.command === 'readymade.showCheck');
  assert.ok(reports.length > 0);
  await api.checks.show(String(reports.at(-1)!.command!.arguments![0]));
  const checkDocument = vscode.window.activeTextEditor!.document;
  assert.equal(checkDocument.uri.scheme, 'readymade-checks');
  const check = JSON.parse(checkDocument.getText());
  assert.equal(check.session, session); assert.equal(check.sourceStatus, 'Matches observed session source');
  assert.ok(check.values.length > 0 && check.values.every((value: {passed: boolean}) => value.passed));
  const source = api.sources.sources().find(row => row.session === session && row.path === '/lib/session-estimate/hoon' && row.source.number === 2);
  assert.ok(source); assert.deepEqual(source.source, selected.source);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(source.uri));
  await vscode.window.showTextDocument(document, {preview: false});
  assert.equal(document.getText(), readFileSync(expectedFile, 'utf8'));
  await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(document.uri, Buffer.from('forbidden'))));
  const other = state.sessions.find(row => row.project !== selected.project); assert.ok(other);
  await api.selectProject(String(other.project)); await assert.rejects(api.codeReview.show(id));
  await assert.rejects(api.checks.show(check.key));
  return {session, candidate: id, project: selected.project, phase: selected.phase,
    retainedSourceHash: source.contentHash, checks: shown.checks.length, checkReports: reports.length,
    nativeReviewAccepted: true, exactCandidateDisplay: true, exactLandedSource: true,
    readonlyDocuments: true, projectIsolation: true};
}

// Actual installed services only. No fixture, ship mutation or credential prompt.
export async function run(): Promise<void> {
  const evidence = process.env.READYMADE_HOST_EVIDENCE!;
  let api: ReadymadeWorkspace | undefined;
  try {
    const credentialFile = process.env.READYMADE_LIVE_AUTH;
    const expectedShip = process.env.READYMADE_EXPECTED_SHIP;
    assert.ok(credentialFile && expectedShip && process.env.READYMADE_BUILTIN_EXTENSION);
    const info = lstatSync(credentialFile);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(info.uid, process.getuid?.());
    const auth = JSON.parse(readFileSync(credentialFile, 'utf8')) as {origin: string; code: string};
    assert.equal(typeof auth.origin, 'string');
    assert.equal(typeof auth.code, 'string');
    const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace');
    assert.ok(extension);
    assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
    api = await extension.activate();
    await api.connect(auth.origin, async origin => {
      assert.equal(origin, auth.origin);
      return auth.code;
    });
    assert.equal(api.snapshot?.ship, expectedShip);
    assert.ok(api.client && api.sources);
    assert.equal(api.client.snapshot?.owner, expectedShip);
    assert.equal(api.client.snapshot?.ready, true);
    const session = process.env.READYMADE_LIVE_SESSION;
    if (!session) {
      assert.equal(api.client.snapshot?.sessions.length, 0, 'Requires a fresh installation');
      assert.equal(api.sources.sources().length, 0);
    }
    const completed = session ? await completedAcceptance(api, session) : undefined;
    const secureTransportRefusal = process.env.READYMADE_EXPECT_SECURE_TRANSPORT === '1';
    if (secureTransportRefusal) {
      await assert.rejects(api.client.requestJSON('/apps/pataphor-cli/source'), {code: 'secureTransportRequired', status: 403});
    }
    await vscode.commands.executeCommand('readymade.workspace.focus');
    await api.refresh();
    assert.equal(api.snapshot?.ship, expectedShip);
    assert.equal(api.client.snapshot?.ready, true);
    writeFileSync(evidence, JSON.stringify({passed: true, host: vscode.version,
      extension: extension.packageJSON.version, ship: expectedShip, actualInstalledExtension: true,
      actualShipHTTP: true, workspaceFocused: true, freshSessionCount: completed ? undefined : 0, completed, refreshPassed: true, secureTransportRefusal,
      scope: completed ? 'Real completed-session recovery in packaged editor; no new coding execution or media proof' : 'Fresh workspace connection and refresh; no coding execution or media proof'}, null, 2), {mode: 0o600});
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({passed: false, error: error instanceof Error ? error.message : 'Host test failed'}), {mode: 0o600});
    throw error;
  } finally {api?.dispose();}
}
