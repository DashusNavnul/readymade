import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadymadeWorkspace } from '../src/extension';
import type { AnswerDialogs } from '../src/completion-view';
import type { JsonObject } from '../src/protocol';

async function acceptance(): Promise<JsonObject> {
  const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
  if (process.env.READYMADE_BUILTIN_EXTENSION) assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
  const {CompletionView} = await import(join(extension.extensionPath, 'dist/src/completion-view.js')) as typeof import('../src/completion-view');
  const {CompletionJournal} = await import(join(extension.extensionPath, 'dist/src/completion-journal.js')) as typeof import('../src/completion-journal');
  const {ShipClient} = await import(join(extension.extensionPath, 'dist/src/ship-client.js')) as typeof import('../src/ship-client');
  const api = await extension.activate(); api.answerReview.dispose();
  const directory = mkdtempSync(join(tmpdir(), 'readymade-answer-host-')), journal = new CompletionJournal(directory);
  const source = {owner: '~zod', desk: 'work', number: '1', root: '0v1', commit: '0v2'};
  let proposal: JsonObject = {tag: 'native-coding-completion-proposal-v1', digest: '0x2', session: '0x1', project: 'demo', objective: 'Explain the verified result',
    configuration: '0x3', source, accepted: {...source, desk: 'base'}, grant: '0x4', assignment: null,
    latest: '0x5', head: '0x6', sequence: '10', model: '0x7', snapshot: '0x8', evidence: [{record: '0x9', tool: '0xa', result: '0xb'}]};
  const receipts = new Map<string, JsonObject>(), posts: JsonObject[] = [];
  let drop = false;
  const state = (session: string) => ({nonce: '0v1', cursor: '0x1', owner: '~zod', session, ready: true, after: 0, projects: [], records: [], sessions: [{id: '0x1', project: 'demo'}]});
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/~/login') {req.resume(); res.setHeader('Set-Cookie', 'urbauth-~zod=fixture; Path=/'); res.end('{}'); return;}
    if (req.url?.startsWith('/apps/pataphor-native/coding/state?')) {res.end(JSON.stringify(state(req.url.split('?')[1].split('&')[0]))); return;}
    if (req.url?.startsWith('/apps/pataphor-native/coding/completion?session=0x1')) {
      const expected = new URL(req.url, 'http://localhost').searchParams.get('proposal');
      res.end(JSON.stringify({available: true, session: '0x1', campaigns: [], ownerReceipt: expected ? receipts.get(expected) ?? null : null,
        proposal: {ready: true, reason: '', value: proposal}})); return;
    }
    if (req.url === '/apps/pataphor-native/coding/action' && req.method === 'POST') {
      let body = ''; req.on('data', chunk => {body += chunk.toString();}); req.on('end', () => {
        const command = JSON.parse(body); posts.push(command);
        receipts.set(command.proposal, {key: '0xc', session: command.session, proposal: command.proposal, judgment: '0xd', historical: true, verdict: 'complete', reason: command.reason});
        if (drop) {req.socket.destroy(); return;} res.end(JSON.stringify(state('0x1')));
      }); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ShipClient(`http://127.0.0.1:${address.port}`, async () => 'fixture');
  let project = 'demo', reason: string | undefined = 'Reviewed exact answer';
  let confirm: () => Promise<boolean> = async () => false;
  const dialogs: AnswerDialogs = {reason: async () => reason, confirm: async (selected, detail) => {
    assert.equal(selected, 'demo'); assert.match(detail, /Proposal 0x/); assert.ok(detail.includes(`Reason: ${reason}`));
    assert.match(detail, /does not accept code changes/); return confirm();
  }};
  // Every change the editor reports for the review document, so a failure can show how the document got that way.
  const timeline: string[] = [], began = Date.now();
  const watch = vscode.workspace.onDidChangeTextDocument(event => {
    if (event.document.uri.scheme !== 'readymade-answer-review') return;
    timeline.push(`${Date.now() - began}ms document v${event.document.version} now ${event.document.getText().length} chars; edits [offset, replaced, inserted]: ${JSON.stringify(event.contentChanges.map(c => [c.rangeOffset, c.rangeLength, c.text.length]))}`);
  });
  let view = new CompletionView(journal, () => project, () => {}, dialogs);
  try {
    await client.signIn(); await client.codingState('0x1'); view.connect(client);
    await view.observe('0x1'); reason = undefined; await view.accept();
    reason = 'Reviewed exact answer'; await view.accept(); assert.equal(posts.length, 0); assert.equal(journal.entries().length, 0);
    confirm = async () => {project = 'other'; view.rows(); return true;};
    await assert.rejects(view.accept(), /Project changed/); assert.equal(posts.length, 0);
    project = 'demo'; await view.observe('0x1');
    confirm = async () => {proposal = {...proposal, digest: '0xe'}; return true;};
    await assert.rejects(view.accept(), /proposal changed/); assert.equal(journal.entries().length, 0);
    await view.observe('0x1'); confirm = async () => {view.dispose(); return true;};
    await assert.rejects(view.accept(), /Project changed/); assert.equal(posts.length, 0);
    view = new CompletionView(journal, () => project, () => {}, dialogs); view.connect(client);
    confirm = async () => true; drop = true; await view.observe('0x1');
    await assert.rejects(view.accept(), /outcome is not known/);
    assert.equal(posts.length, 1); assert.equal(journal.entries()[0].receipt, undefined);
    view.dispose(); view = new CompletionView(new CompletionJournal(directory), () => project, () => {}, dialogs); view.connect(client);
    const recovery = view.rows()[0].children!.find(row => row.command?.command === 'readymade.recoverAnswer')!;
    assert.ok(recovery); await view.recover(String(recovery.command!.arguments![0]));
    assert.equal(posts.length, 1); assert.equal(journal.entries()[0].receipt!.proposal, '0xe');
    // The document must end as exactly the recovered result. (The editor mixed two texts here about one run in four,
    // until changes were announced one at a time: see src/settled-documents.ts.)
    let shown: {evidence?: {receipt?: {reason?: string}}} | undefined, last = '';
    for (let n = 0; n < 100 && !shown?.evidence?.receipt; n++) {
      const editor = vscode.window.activeTextEditor; const seen = editor?.document.getText() ?? ''; let parses = 'parses as JSON'; try {JSON.parse(seen);} catch (error) {parses = `does not parse: ${error instanceof Error ? error.message : 'unknown'}`;}
      last = `${editor?.document.uri.toString() ?? 'no active editor'} (${seen.length} characters, ${parses}, has a receipt key: ${seen.includes('"receipt"')}); its end: ${seen.slice(-300)}`;
      try {shown = JSON.parse(editor!.document.getText());} catch { /* Provider updates can briefly show the cleared scope. */ }
      if (!shown?.evidence?.receipt) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(shown?.evidence?.receipt?.reason, reason, `The recovered receipt never appeared. Last seen: ${last}\nDocument changes:\n${timeline.slice(-12).join('\n')}`);
    proposal = {...proposal, digest: '0xf'}; drop = false; await view.observe('0x1'); await view.accept();
    assert.equal(posts.length, 2); assert.equal(journal.entries().filter(e => e.receipt).length, 2);
    assert.deepEqual(posts[1], {kind: 'completion-accept', session: '0x1', proposal: '0xf', consent: true, reason, nonce: '0v1'});
    const document = vscode.window.activeTextEditor!.document;
    assert.equal(document.uri.scheme, 'readymade-answer-review');
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(document.uri, Buffer.from('forbidden'))));
    return {fixture: true, scriptedDialogs: true, cancelledWithoutWrite: true, changedProjectRefused: true, staleProposalRefused: true,
      disposalRefused: true, lostResponseRecoveredWithoutReplay: true, confirmedExactProposal: true, readonlyReceipt: true, posts: posts.length};
  } finally {watch.dispose(); view.dispose(); client.close(); api.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
}
export async function run(): Promise<void> {
  const file = process.env.READYMADE_HOST_EVIDENCE!;
  try {writeFileSync(file, JSON.stringify({passed: true, host: vscode.version, ...await acceptance()}, null, 2), {mode: 0o600});}
  catch (error) {writeFileSync(file, JSON.stringify({passed: false, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined}), {mode: 0o600}); throw error;}
}
