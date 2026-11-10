import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadymadeWorkspace } from '../src/extension';
import type { JsonObject } from '../src/protocol';

async function liveAcceptance() {
  const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
  if (process.env.READYMADE_BUILTIN_EXTENSION) assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
  const api = await extension.activate();
  try {
    const session = process.env.READYMADE_LIVE_SESSION, id = process.env.READYMADE_LIVE_CANDIDATE;
    assert.ok(session && id, 'Live candidate acceptance requires exact session and candidate IDs');
    await api.connect(process.env.READYMADE_LIVE_ORIGIN);
    const state = await api.client!.codingState(session), selected = state.sessions.find(row => row.id === session);
    assert.ok(selected); await api.selectProject(String(selected.project));
    assert.ok(state.reviews); const native = state.reviews.find(row => row.id === id);
    assert.ok(native); assert.equal(native.stage, 'applied'); assert.equal(native.decision, 'approve');
    await api.codeReview.observe(session); await api.codeReview.show(id);
    const document = vscode.window.activeTextEditor!.document, shown = JSON.parse(document.getText());
    assert.equal(document.uri.scheme, 'readymade-candidate');
    assert.equal(shown.id, id); assert.equal(shown.session, session);
    assert.equal(shown.project, selected.project); assert.equal(shown.stage, 'applied');
    assert.deepEqual(shown.landed, native.landed); assert.deepEqual(shown.basis, native.basis);
    assert.deepEqual(shown.edits, native.edits); assert.deepEqual(shown.checks, native.checks);
    assert.equal(shown.edits.length, Number(process.env.READYMADE_EXPECTED_CHANGES ?? 2));
    assert.equal(shown.checks.length, Number(process.env.READYMADE_EXPECTED_CHECKS ?? 3));
    let sparseCommandBytes: number | undefined;
    if (process.env.READYMADE_BASELINE_FILE || process.env.READYMADE_EXPECTED_FILE) {
      assert.ok(process.env.READYMADE_BASELINE_FILE && process.env.READYMADE_EXPECTED_FILE);
      const {candidateCommand} = await import(join(extension.extensionPath, 'dist/src/candidate-command.js')) as typeof import('../src/candidate-command');
      const text = readFileSync(process.env.READYMADE_BASELINE_FILE, 'utf8');
      const expected = readFileSync(process.env.READYMADE_EXPECTED_FILE, 'utf8');
      assert.equal(Buffer.byteLength(text), 103810); assert.equal(Buffer.byteLength(expected), 103821);
      assert.equal(shown.edits[0].path, '/lib/large-session-estimate/hoon');
      const command = candidateCommand({path: shown.edits[0].path, blob: shown.edits[0].before, mark: 'hoon', text}, expected);
      assert.match(command, /^\/patches 2\n/); sparseCommandBytes = Buffer.byteLength(command); assert.equal(sparseCommandBytes, 369);
    }
    assert.ok(shown.checks.every((check: {passed: boolean}) => check.passed));
    assert.equal(shown.reviewProcess.campaign.outcome, 'accept');
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(document.uri, Buffer.from('forbidden'))));
    const other = state.sessions.find(row => row.project !== selected.project); assert.ok(other);
    await api.selectProject(String(other.project)); await assert.rejects(api.codeReview.show(id));
    return {live: true, session, candidate: id, project: selected.project, landed: shown.landed,
      changes: shown.edits.length, checks: shown.checks.length, sparseCommandBytes, readonly: true, projectIsolation: true};
  } finally {api.dispose();}
}

async function acceptance() {
  const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
  if (process.env.READYMADE_BUILTIN_EXTENSION) assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
  const {CandidateView} = await import(join(extension.extensionPath, 'dist/src/candidate-view.js')) as typeof import('../src/candidate-view');
  const {CandidateJournal} = await import(join(extension.extensionPath, 'dist/src/candidate-journal.js')) as typeof import('../src/candidate-journal');
  const {CheckDocumentJournal} = await import(join(extension.extensionPath, 'dist/src/check-document-journal.js')) as typeof import('../src/check-document-journal');
  const {ShipClient} = await import(join(extension.extensionPath, 'dist/src/ship-client.js')) as typeof import('../src/ship-client');
  const api = await extension.activate(); api.codeReview.dispose();
  const directory = mkdtempSync(join(tmpdir(), 'readymade-code-review-host-')), journal = new CandidateJournal(directory);
  const archive = new CheckDocumentJournal(join(directory, 'documents'));
  const basis = {id: '0x1', owner: '~zod', desk: 'work', number: 1, root: '0v1', commit: '0v2'};
  const candidate = {id: '0x2', session: '0x4', request: '0x3', actor: '~zod', basis, sourceId: '0x1', source: '1', stage: 'review', decision: 'pending',
    workspace: '', artifact: '', reason: '', landed: null as typeof basis | null, edits: [{path: '/lib/a/hoon', kind: 'modify', before: '0x5', after: '0x6'}], checkCount: 0, checks: []};
  const solo = {schema: 'native-coding-solo-review-view-v1', available: true, project: 'demo',
    scope: {project: 'demo', generation: '1', enabled: true, providerKey: 'reviewer', provider: 'codex', model: 'fixture-model', binding: '0xa' as string | undefined}, campaigns: [] as JsonObject[]};
  let canApply = true;
  const state = (session: string) => ({candidateDecide: canApply, nonce: '0v1', cursor: '0x1', owner: '~zod', session, ready: true, after: 0, projects: [], records: [],
    sessions: [{id: '0x4', project: 'demo', source: candidate.landed ?? basis}], reviews: [candidate, {...candidate, id: '0x7', request: '0x8'}], soloReview: solo});
  const posts: JsonObject[] = [];
  let failReads = false;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/~/login') {req.resume(); res.setHeader('Set-Cookie', 'urbauth-~zod=fixture; Path=/'); res.end('{}'); return;}
    if (req.method === 'GET' && failReads) {res.statusCode = 503; res.end('{}'); return;}
    if (req.method === 'GET') {res.end(JSON.stringify(state(req.url!.split('?')[1].split('&')[0]))); return;}
    let body = ''; req.on('data', c => {body += c.toString();}); req.on('end', () => {posts.push(JSON.parse(body)); req.socket.destroy();});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ShipClient(`http://127.0.0.1:${address.port}`, async () => 'fixture');
  let project = 'demo', confirm: () => Promise<boolean> = async () => false;
  const dialog = async (detail: string) => {assert.match(detail, /Candidate 0x2/); assert.match(detail, /can apply these changes/); return confirm();};
  let view = new CandidateView(() => project, () => {}, journal, dialog, archive);
  try {
    await client.signIn(); await client.codingState('0x4'); view.connect(client); await view.observe('0x4');
    await view.show('0x2'); const first = vscode.window.activeTextEditor!.document, firstText = first.getText();
    await view.show('0x7'); const second = vscode.window.activeTextEditor!.document;
    assert.notEqual(first.uri.toString(), second.uri.toString(), 'Different candidates need distinct documents');
    assert.equal(JSON.parse(second.getText()).id, '0x7'); assert.equal(first.getText(), firstText);
    project = 'other'; view.rows(); await assert.rejects(view.show('0x2'));
    assert.equal(first.getText(), firstText); project = 'demo'; await view.observe('0x4');
    solo.scope.binding = undefined; await view.observe('0x4');
    assert.ok(!view.rows()[0].children!.some(r => r.command?.command === 'readymade.startCodeReview'));
    await assert.rejects(view.start('0x2'), /Update the backend/); assert.equal(posts.length, 0);
    solo.scope.binding = '0xa'; await view.observe('0x4');
    assert.ok(view.rows()[0].children!.some(r => r.command?.command === 'readymade.startCodeReview'));
    await view.start('0x2'); assert.equal(posts.length, 0); assert.equal(journal.entries().length, 0);
    confirm = async () => {project = 'other'; view.rows(); return true;}; await assert.rejects(view.start('0x2'), /Project changed/);
    project = 'demo'; await view.observe('0x4'); confirm = async () => {solo.scope.generation = '2'; return true;};
    await assert.rejects(view.start('0x2'), /scope changed/); assert.equal(posts.length, 0);
    await view.observe('0x4'); confirm = async () => {view.dispose(); return true;}; await assert.rejects(view.start('0x2'), /Project changed/);
    view = new CandidateView(() => project, () => {}, journal, dialog, archive); view.connect(client); confirm = async () => true;
    await view.observe('0x4'); await assert.rejects(view.start('0x2'), /outcomeUnknown/); assert.equal(posts.length, 1);
    assert.deepEqual(posts[0], {kind: 'solo-review-start', session: '0x4', candidate: '0x2', scopeBinding: '0xa', nonce: '0v1'});
    assert.ok(!view.rows()[0].children!.some(r => r.command?.command === 'readymade.startCodeReview' && r.command.arguments?.[0] === '0x2'));
    view.dispose(); view = new CandidateView(() => project, () => {}, new CandidateJournal(directory), dialog, archive); view.connect(client);
    await view.recover('0x4', '0x2'); assert.equal(posts.length, 1);
    const pendingDocument = vscode.window.activeTextEditor!.document, pendingText = pendingDocument.getText();
    solo.campaigns = [{candidate: '0x2', mode: 'resolve', pending: null, reason: '', outcome: 'accept', attempt: 0}];
    await view.recover('0x4', '0x2'); assert.equal(posts.length, 1);
    for (let n = 0; n < 100; n++) {
      try {if (JSON.parse(vscode.window.activeTextEditor!.document.getText()).campaign?.outcome === 'accept') break;} catch { /* Await document event. */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const doc = vscode.window.activeTextEditor!.document, result = JSON.parse(doc.getText());
    assert.notEqual(doc.uri.toString(), pendingDocument.uri.toString()); assert.equal(pendingDocument.getText(), pendingText);
    assert.equal(result.campaign.outcome, 'accept'); assert.equal(result.candidate.landed, undefined);
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(doc.uri, Buffer.from('forbidden'))));
    project = 'other'; assert.equal(view.rows()[0].children!.length, 1); await assert.rejects(view.recover('0x4', '0x2'));
    const recoveredText = doc.getText(); assert.equal(JSON.parse(recoveredText).campaign.outcome, 'accept');
    project = 'demo'; failReads = true; await assert.rejects(view.observe('0x4')); assert.equal(doc.getText(), recoveredText);
    const snapshots = [first, pendingDocument, doc].map(d => ({uri: d.uri, text: d.getText()}));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    view.dispose(); view = new CandidateView(() => undefined, () => {}, journal, dialog, new CheckDocumentJournal(join(directory, 'documents')));
    for (const saved of snapshots) {
      assert.equal((await vscode.workspace.openTextDocument(saved.uri)).getText(), saved.text);
      await assert.rejects(Promise.resolve(vscode.workspace.openTextDocument(saved.uri.with({query: 'alias=1'}))));
      await assert.rejects(Promise.resolve(vscode.workspace.openTextDocument(saved.uri.with({path: saved.uri.path.replace(/(candidate|recovery)\.json$/, 'other.json')}))));
    }
    await assert.rejects(view.start('0x2')); await assert.rejects(view.recover('0x4', '0x2'));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const picker = view.openSaved();
    await new Promise(resolve => setTimeout(resolve, 750));
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await picker;
    const savedDocument = vscode.window.activeTextEditor!.document;
    assert.ok(snapshots.some(s => s.uri.toString() === savedDocument.uri.toString() && s.text === savedDocument.getText()));
    assert.equal(posts.length, 1);
    failReads = false; project = 'demo'; candidate.id = '0x1234.5678'; candidate.decision = 'approve'; solo.campaigns = [];
    let applyConsent: () => Promise<boolean> = async () => false;
    const applyDialog = async (detail: string) => {assert.match(detail, /working project/); assert.match(detail, /deployed separately/); return applyConsent();};
    view.dispose(); view = new CandidateView(() => project, () => {}, journal, dialog, archive, applyDialog); view.connect(client);
    await view.observe('0x4'); assert.ok(view.rows()[0].children!.some(r => r.command?.command === 'readymade.applyCandidate'));
    await view.apply(candidate.id); assert.equal(posts.length, 1);
    applyConsent = async () => {project = 'other'; view.rows(); return true;};
    await assert.rejects(view.apply(candidate.id), /Project changed/); assert.equal(posts.length, 1);
    project = 'demo'; applyConsent = async () => true; canApply = false; await view.observe('0x4');
    assert.ok(!view.rows()[0].children!.some(r => r.command?.command === 'readymade.applyCandidate'));
    await assert.rejects(view.apply(candidate.id), /Update the backend/); assert.equal(posts.length, 1);
    canApply = true; await view.observe('0x4'); await assert.rejects(view.apply(candidate.id), /outcomeUnknown/);
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1], {kind: 'candidate-decide', owner: '~zod', project: 'demo', session: '0x4', candidate: candidate.id, basis: '0x1', consent: true, nonce: '0v1'});
    assert.ok(!view.rows()[0].children!.some(r => r.command?.command === 'readymade.applyCandidate' && r.command.arguments?.[0] === candidate.id));
    view.dispose(); view = new CandidateView(() => project, () => {}, new CandidateJournal(directory), dialog, archive, applyDialog); view.connect(client);
    await view.checkApplied('0x4', candidate.id); assert.equal(JSON.parse(vscode.window.activeTextEditor!.document.getText()).applied, false);
    candidate.stage = 'applied'; candidate.landed = {...basis, id: '0x9', number: 2, root: '0v3', commit: '0v4'};
    await view.checkApplied('0x4', candidate.id); const appliedDocument = vscode.window.activeTextEditor!.document;
    assert.equal(JSON.parse(appliedDocument.getText()).applied, true); assert.equal(posts.length, 2);
    const dottedArchive = new CheckDocumentJournal(join(directory, 'dotted'));
    dottedArchive.retain(appliedDocument.getText()); const appliedText = appliedDocument.getText();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    view.dispose(); view = new CandidateView(() => undefined, () => {}, journal, dialog, dottedArchive);
    const dottedPicker = view.openSaved(); await new Promise(resolve => setTimeout(resolve, 750));
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); await dottedPicker;
    assert.equal(vscode.window.activeTextEditor!.document.getText(), appliedText); assert.equal(posts.length, 2);
    return {fixture: true, scriptedDialogs: true, cancellation: true, projectIsolation: true, staleScopeRefused: true, disposalRefused: true,
      distinctCandidates: true, immutableRecoveryObservations: true, failedRefreshPreservesEvidence: true, offlineSnapshotRecovery: true, savedReviewPicker: true,
      lostResponseRecoveredWithoutReplay: true, acceptanceSeparateFromLanding: true, explicitApply: true, applyCancellation: true, legacyBackendRefused: true,
      applyUnknownRecoveredWithoutReplay: true, canonicalDottedIDOfflinePicker: true, readonly: true, posts: posts.length};
  } finally {view.dispose(); client.close(); api.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
}
export async function run(): Promise<void> {
  const file = process.env.READYMADE_HOST_EVIDENCE!;
  try {writeFileSync(file, JSON.stringify({passed: true, ...await (process.env.READYMADE_LIVE_ORIGIN ? liveAcceptance() : acceptance())}, null, 2), {mode: 0o600});}
  catch (error) {writeFileSync(file, JSON.stringify({passed: false, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined}), {mode: 0o600}); throw error;}
}
