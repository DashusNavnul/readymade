import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadymadeWorkspace } from '../src/extension';
import type { JsonObject } from '../src/protocol';

async function acceptance() {
  const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
  if (process.env.READYMADE_BUILTIN_EXTENSION) assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
  const {ReviewPolicyView} = await import(join(extension.extensionPath, 'dist/src/review-policy-view.js')) as typeof import('../src/review-policy-view');
  const {ReviewPolicyJournal} = await import(join(extension.extensionPath, 'dist/src/review-policy-journal.js')) as typeof import('../src/review-policy-journal');
  const {ShipClient} = await import(join(extension.extensionPath, 'dist/src/ship-client.js')) as typeof import('../src/ship-client');
  const api = await extension.activate(); api.reviewPolicy.dispose();
  const commands = await vscode.commands.getCommands();
  for (const name of ['reviewPolicy', 'configureReviewer', 'disableReviewer', 'recoverReviewer']) assert.ok(commands.includes('readymade.' + name));
  const directory = mkdtempSync(join(tmpdir(), 'readymade-review-policy-host-')), journal = new ReviewPolicyJournal(directory);
  const selected = {key: 'reviewer', binding: '0xa', provider: 'codex', model: 'fixture-model'};
  const solo = {schema: 'native-coding-solo-review-view-v1', available: true, project: 'demo', scope: null as JsonObject | null,
    providers: [selected], campaigns: []};
  const state = (session: string) => ({nonce: '0v1', cursor: '0x1', owner: '~zod', session, ready: true, after: 0,
    projects: [], records: [], sessions: [{id: '0x4', project: 'demo'}], soloReview: solo});
  const posts: JsonObject[] = [];
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/~/login') {req.resume(); res.setHeader('Set-Cookie', 'urbauth-~zod=fixture; Path=/'); res.end('{}'); return;}
    if (req.method === 'GET') {res.end(JSON.stringify(state(req.url!.split('?')[1].split('&')[0]))); return;}
    let body = ''; req.on('data', c => {body += c.toString();}); req.on('end', () => {
      const command = JSON.parse(body); posts.push(command);
      solo.scope = {project: 'demo', generation: String(Number(command.previous) + 1), enabled: command.kind === 'solo-review-enable',
        providerKey: selected.key, provider: selected.provider, model: selected.model, binding: '0xb'};
      if (command.kind === 'solo-review-enable') req.socket.destroy(); else res.end(JSON.stringify(state(command.session)));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ShipClient(`http://127.0.0.1:${address.port}`, async () => 'fixture');
  let project = 'demo', confirm: () => Promise<boolean> = async () => false;
  const dialog = async (detail: string) => {assert.match(detail, /Project demo/); return confirm();};
  let view = new ReviewPolicyView(() => project, () => {}, journal, dialog);
  try {
    await client.signIn(); await client.codingState('0x4'); view.connect(client); await view.observe('0x4');
    assert.ok(view.rows()[0].children!.some(r => r.command?.command === 'readymade.configureReviewer'));
    await view.configure(false, 'reviewer'); assert.equal(posts.length, 0); assert.equal(journal.entries().length, 0);
    confirm = async () => {project = 'other'; view.rows(); return true;}; await assert.rejects(view.configure(false, 'reviewer'), /Project changed/);
    project = 'demo'; await view.observe('0x4'); confirm = async () => {solo.providers = [{...selected, binding: '0xc'}]; return true;};
    await assert.rejects(view.configure(false, 'reviewer'), /selection changed/); assert.equal(posts.length, 0);
    solo.providers = [selected]; await view.observe('0x4'); confirm = async () => {view.dispose(); return true;};
    await assert.rejects(view.configure(false, 'reviewer'), /Project changed/);
    view = new ReviewPolicyView(() => project, () => {}, journal, dialog); view.connect(client); confirm = async () => true;
    await view.observe('0x4'); await assert.rejects(view.configure(false, 'reviewer'), /outcomeUnknown/);
    assert.deepEqual(posts, [{kind: 'solo-review-enable', session: '0x4', project: 'demo', previous: '0', providerKey: 'reviewer', binding: '0xa', consent: true, nonce: '0v1'}]);
    await assert.rejects(view.configure(false, 'reviewer'), /not be submitted again/);
    view.dispose(); view = new ReviewPolicyView(() => project, () => {}, new ReviewPolicyJournal(directory), dialog); view.connect(client);
    await view.recover('0'); assert.equal(posts.length, 1);
    for (let n = 0; n < 100; n++) {
      try {if (JSON.parse(vscode.window.activeTextEditor!.document.getText()).observed?.scope?.enabled) break;} catch { /* Await document event. */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const doc = vscode.window.activeTextEditor!.document, result = JSON.parse(doc.getText());
    assert.equal(result.observed.scope.enabled, true); assert.match(result.notice, /not a delivery receipt/);
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(doc.uri, Buffer.from('forbidden'))));
    await view.configure(true); assert.equal(posts.length, 2);
    assert.deepEqual(posts[1], {kind: 'solo-review-disable', session: '0x4', project: 'demo', previous: '1', nonce: '0v1'});
    assert.ok(!view.rows()[0].children!.some(r => r.command?.command === 'readymade.disableReviewer'));
    project = 'other'; assert.equal(view.rows()[0].children!.length, 1); await assert.rejects(view.recover('0'));
    return {fixture: true, scriptedDialogs: true, cancellation: true, projectIsolation: true, staleProviderRefused: true,
      disposalRefused: true, lostResponseRecoveredWithoutReplay: true, disableConfirmed: true, readonly: true, posts: posts.length};
  } finally {view.dispose(); client.close(); api.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
}
export async function run(): Promise<void> {
  const file = process.env.READYMADE_HOST_EVIDENCE!;
  try {writeFileSync(file, JSON.stringify({passed: true, ...await acceptance()}, null, 2), {mode: 0o600});}
  catch (error) {writeFileSync(file, JSON.stringify({passed: false, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined}), {mode: 0o600}); throw error;}
}
