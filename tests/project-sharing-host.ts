import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadymadeWorkspace } from '../src/extension';
import type {PageJournal} from '../src/source-pager';
import type { JsonObject } from '../src/protocol';

async function acceptance() {
  const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
  if (process.env.READYMADE_BUILTIN_EXTENSION) assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
  const {ProjectSharingView} = await import(join(extension.extensionPath, 'dist/src/project-sharing-view.js')) as typeof import('../src/project-sharing-view');
  const {SharingJournal} = await import(join(extension.extensionPath, 'dist/src/project-sharing-journal.js')) as typeof import('../src/project-sharing-journal');
  const {ShipClient} = await import(join(extension.extensionPath, 'dist/src/ship-client.js')) as typeof import('../src/ship-client');
  const api = await extension.activate(); api.projectSharing.dispose();
  const commands = await vscode.commands.getCommands();
  for (const name of ['projectSharing', 'copySharedProjectLink', 'grantProjectAccess', 'revokeProjectAccess', 'recoverProjectAccess']) assert.ok(commands.includes('readymade.' + name));
  const directory = mkdtempSync(join(tmpdir(), 'readymade-sharing-host-')), journal = new SharingJournal(directory);
  const observation = {schema: 'readymade-project-sharing-view-v1', owner: '~zod', project: 'demo', peer: '~nec', expected: '0x123', member: true,
    baseDesk: 'demo-base', workingDesk: 'demo-work', grant: {generation: '2', desk: 'demo-work', paths: ['/lib/example/hoon'], view: true, suggest: false, revoked: false}};
  const posts: JsonObject[] = []; let result: JsonObject = {}, driftRead = false;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/~/login') {req.resume(); res.setHeader('Set-Cookie', 'urbauth-~zod=fixture; Path=/'); res.end('{}'); return;}
    if (req.method === 'GET') {
      if (req.url?.endsWith('/project-sharing')) {if (driftRead) project = 'other'; res.end(JSON.stringify(observation));}
      else if (req.url?.endsWith('/project-sharing-result')) res.end(JSON.stringify(result));
      else res.end(JSON.stringify({nonce: '0v1', cursor: '0x1', owner: '~zod', session: '0x4', ready: true, after: 0, projects: [], records: [], sessions: []}));
      return;
    }
    let body = ''; req.on('data', c => {body += c.toString();}); req.on('end', () => {
      const command = JSON.parse(body); posts.push(command);
      assert.equal(new SharingJournal(directory).entries().length, 1);
      result = {schema: 'readymade-project-sharing-result-v1', request: command.request, owner: '~zod', project: 'demo', peer: '~nec', operation: command.operation, intent: '0x456', status: 'confirmed'};
      req.socket.destroy();
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ShipClient(`http://127.0.0.1:${address.port}`, async () => 'fixture');
  let project = 'demo', confirm: () => Promise<boolean> = async () => false;
  const dialog = async (detail: string) => {assert.match(detail, /Revoke ~nec's access to demo/); return confirm();};
  let view = new ProjectSharingView(() => project, () => {}, journal, dialog);
  try {
    await client.signIn(); await client.codingState('0x4'); view.connect(client); await view.observe('~nec');
    assert.ok(view.rows()[0].children!.some(r => r.command?.command === 'readymade.revokeProjectAccess'));
    assert.match(vscode.window.activeTextEditor!.document.getText(), /\/lib\/example\/hoon/);
    observation.grant.generation = '3';
    await view.copyLink(extension.id);
    const copied = vscode.Uri.parse(await vscode.env.clipboard.readText()), fields = new URLSearchParams(copied.query);
    assert.equal(copied.scheme, vscode.env.uriScheme); assert.equal(copied.authority, extension.id); assert.equal(copied.path, '/shared-project');
    assert.deepEqual(Object.fromEntries(fields), {owner: '~zod', project: 'demo', generation: '3', peer: '~nec'});
    observation.grant.revoked = true; await assert.rejects(view.copyLink(extension.id), /current read access/);
    assert.equal(await vscode.env.clipboard.readText(), copied.toString());
    observation.grant.revoked = false; observation.grant.generation = '2'; await view.observe('~nec');
    if (process.env.READYMADE_SHARING_INTERACTIVE === '1') {
      // The editor test runner refuses modal dialogs; retain real quick-input UI.
      view.dispose(); view = new ProjectSharingView(() => project, () => {}, journal, async detail => {
        assert.equal(detail, 'Share with ~nec\nProject: demo\nDesk: demo-work\n/lib/example/hoon\n\nRead and suggest changes. Access lasts until revoked. Suggestions do not automatically apply changes.');
        return true;
      }); view.connect(client);
      await view.observe('~nec'); await assert.rejects(view.change(false), /outcomeUnknown/);
      assert.equal(posts.length, 1);
      assert.equal(posts[0].operation, 'grant'); assert.equal(posts[0].desk, 'demo-work');
      assert.equal(posts[0].paths, '/lib/example/hoon'); assert.equal(posts[0].permission, 'view-suggest');
      await view.recover(journal.entries()[0].command.request); assert.equal(posts.length, 1);
      assert.ok(view.rows()[0].children!.some(r => r.command?.command === 'readymade.copySharedProjectLink'));
      return {fixture: true, scriptedConfirmation: true, confirmationTextVerified: true, nativeGrantPickers: true, exactSelection: true, lostResponseRecoveredWithoutReplay: true, posts: posts.length};
    }
    await view.change(true); assert.equal(posts.length, 0); assert.equal(journal.entries().length, 0);
    confirm = async () => {project = 'other'; view.rows(); return true;}; await assert.rejects(view.change(true), /Project changed/);
    project = 'demo'; await view.observe('~nec'); confirm = async () => {observation.expected = '0x234'; return true;};
    await assert.rejects(view.change(true), /Sharing state changed/); assert.equal(posts.length, 0);
    observation.expected = '0x123'; await view.observe('~nec'); confirm = async () => {view.dispose(); return true;};
    await assert.rejects(view.change(true), /Project changed/);
    view = new ProjectSharingView(() => project, () => {}, journal, dialog); view.connect(client); confirm = async () => true;
    await view.observe('~nec'); await assert.rejects(view.change(true)); assert.equal(posts.length, 1);
    await assert.rejects(view.change(true), /not be sent again/); assert.equal(posts.length, 1);
    const retained = journal.entries()[0]; assert.equal(retained.command.operation, 'revoke');
    assert.equal(posts[0].generation, '2');
    view.dispose(); view = new ProjectSharingView(() => project, () => {}, new SharingJournal(directory), dialog); view.connect(client);
    await view.recover(retained.command.request); assert.equal(posts.length, 1);
    assert.ok(view.rows()[0].children!.some(r => r.command?.command === 'readymade.copySharedProjectLink'));
    observation.grant.revoked = true; await view.recover(retained.command.request);
    assert.ok(!view.rows()[0].children!.some(r => r.command?.command === 'readymade.copySharedProjectLink'));
    await assert.rejects(view.copyLink(extension.id), /current read access/); assert.equal(posts.length, 1);
    driftRead = true; await assert.rejects(view.recover(retained.command.request), /Project changed/);
    assert.ok(!view.rows()[0].children!.some(r => r.command?.command === 'readymade.copySharedProjectLink'));
    driftRead = false; project = 'demo'; await view.recover(retained.command.request);
    const doc = vscode.window.activeTextEditor!.document;
    for (let n = 0; n < 100 && !doc.getText().includes('Status: confirmed'); n++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.match(doc.getText(), /Status: confirmed/); assert.match(doc.getText(), /No request was resent/);
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(doc.uri, Buffer.from('forbidden'))));
    project = 'other'; assert.equal(view.rows()[0].children!.length, 1); await assert.rejects(view.recover(retained.command.request));
    return {fixture: true, scriptedConfirmation: true, cancellation: true, projectIsolation: true, staleObservationRefused: true,
      disposalRefused: true, lostResponseRecoveredWithoutReplay: true, readonly: true, posts: posts.length, grantPickerTested: false};
  } finally {view.dispose(); client.close(); api.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
}
export async function run(): Promise<void> {
  const file = process.env.READYMADE_HOST_EVIDENCE!;
  try {writeFileSync(file, JSON.stringify({passed: true, ...await acceptance(), inbox: await inboxAcceptance(), invitations: await invitationAcceptance()}, null, 2), {mode: 0o600});}
  catch (error) {writeFileSync(file, JSON.stringify({passed: false, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined}), {mode: 0o600}); throw error;}
}

async function inboxAcceptance() {
  const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
  const module = async <T>(name: string): Promise<T> => await import(join(extension.extensionPath, 'dist/src/' + name + '.js')) as T;
  const {ProjectInboxView} = await module<typeof import('../src/project-inbox-view')>('project-inbox-view');
  const {ShipClient} = await module<typeof import('../src/ship-client')>('ship-client');
  const {SourceStore} = await module<typeof import('../src/source-store')>('source-store');
  const {SourceLoader} = await module<typeof import('../src/source-loader')>('source-loader');
  const {SourcePager} = await module<typeof import('../src/source-pager')>('source-pager');
  const {DraftStore} = await module<typeof import('../src/draft-store')>('draft-store');
  const {DraftProvider} = await module<typeof import('../src/draft-provider')>('draft-provider');
  const {remoteSourceHash} = await module<typeof import('../src/remote-project-view')>('remote-project-view');
  const basis = {id: '0x4', owner: '~zod', desk: 'work', number: 4, root: '0v10', commit: '0v5'};
  const original = 'first\nsecond\nthird\n', source = 'first\nsecond\npeer\n', path = '/lib/example/hoon';
  const receipt = {receiptHash: '0x1', peer: '~nec', receivedAt: '~2026.11.09', generation: '1', request: '0x2', path,
    sourceHash: remoteSourceHash(source), parentRoot: '0x20', snapshotDigest: '0x3', desk: basis.desk, revision: '4', originalHash: remoteSourceHash(original)};
  const value = {path, mark: 'hoon', blob: '0x7', start: 1, total: 3, text: original, bytes: Buffer.byteLength(original), lines: 3, next: null};
  const record = {id: '0x8', sequence: 0, kind: 'tool', text: JSON.stringify({version: 'native-coding-tool-result-v1', call_id: '0x8',
    context: {session: '0x6', request: '0x8', source: basis}, output: {kind: 'read', ...value}}),
    file: {kind: 'read', session: '0x6', request: '0x8', callId: '0x8', source: basis, value}};
  let writes = 0, stale = false, project = 'shared';
  const server = createServer((req, res) => {
    req.resume(); res.setHeader('content-type', 'application/json');
    if (req.url === '/~/login') {res.setHeader('set-cookie', 'urbauth-~zod=fixture; Path=/'); res.end('{}'); return;}
    if (req.method !== 'GET') {writes++; res.statusCode = 599; res.end('{}'); return;}
    if (req.url === '/apps/readymade-collab/project-inbox') {
      assert.equal(req.headers['x-readymade-project'], 'shared');
      res.end(JSON.stringify({schema: 'readymade-project-inbox-v1', owner: '~zod', project: 'shared', permissionGranted: false, committed: false,
        receipts: [req.headers['x-readymade-project-receipt'] ? {...receipt, source} : receipt]})); return;
    }
    if (req.url?.startsWith('/apps/pataphor-native/coding/state?')) {
      const session = req.url.split('?')[1].split('&')[0];
      res.end(JSON.stringify({nonce: '0v1', cursor: '0x1', owner: '~zod', session, ready: true, after: 1, projects: [], records: [record],
        sessions: [{id: '0x6', project: 'shared', source: stale ? {...basis, number: 5} : basis}]})); return;
    }
    res.statusCode = 599; res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ShipClient(`http://127.0.0.1:${address.port}`, async () => 'fixture'), sources = new SourceStore(client);
  const drafts = new DraftStore(mkdtempSync(join(tmpdir(), 'readymade-inbox-host-'))), disk = new Map<string, unknown>();
  const journal: PageJournal = {get: <T>(key: string) => disk.get(key) as T | undefined, update: async (key, value) => {disk.set(key, value);}};
  const loader = new SourceLoader(sources, new SourcePager(client, sources, journal));
  const transport = client as typeof client & {projectInbox(project: string, receipt?: string): Promise<unknown>};
  let confirmMerge: () => Promise<boolean> = async () => false;
  const view = new ProjectInboxView(() => ({client, project, sources, loader, drafts}), (c, p, r) => {assert.equal(c, client); return transport.projectInbox(p, r);}, async () => {}, () => {}, () => confirmMerge());
  const registrations = [vscode.workspace.registerFileSystemProvider('readymade-draft', new DraftProvider(drafts), {isCaseSensitive: true}),
    vscode.window.registerTreeDataProvider('readymade.workspace', {getChildren: (row?: import('../src/media-workbench').MediaTreeRow) => row?.children ?? view.rows(),
      getTreeItem: row => {const item = new vscode.TreeItem(row.label, row.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None); item.command = row.command; return item;}}),
    vscode.commands.registerCommand('readymade.projectInbox', () => view.observe()),
    vscode.commands.registerCommand('readymade.openInboxSuggestion', (receipt: string) => view.show(receipt)),
    vscode.commands.registerCommand('readymade.importInboxSuggestion', (receipt: string) => view.import(receipt))];
  try {
    await client.signIn(); await vscode.commands.executeCommand('readymade.projectInbox');
    await vscode.commands.executeCommand('readymade.workspace.focus');
    assert.equal(view.rows()[0].label, 'Inbox'); assert.ok(view.rows()[0].children!.some(row => row.label === path));
    await vscode.commands.executeCommand('readymade.openInboxSuggestion', receipt.receiptHash);
    assert.equal(vscode.window.activeTextEditor!.document.uri.scheme, 'readymade-inbox'); assert.equal(vscode.window.activeTextEditor!.document.getText(), source);
    await vscode.commands.executeCommand('readymade.importInboxSuggestion', receipt.receiptHash);
    const draft = drafts.list()[0]; assert.ok(draft); assert.equal(vscode.window.activeTextEditor!.document.uri.toString(), draft.uri);
    assert.equal(draft.text, source); assert.equal(draft.snapshot.text, original); assert.equal(draft.snapshot.session, '0x6'); assert.deepEqual(draft.snapshot.source, basis);
    assert.equal(draft.pending, undefined); assert.equal(sources.sources().length, 1); assert.equal(writes, 0);
    const document = vscode.window.activeTextEditor!.document;
    const replace = async (text: string) => {const edit = new vscode.WorkspaceEdit(); edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit));};
    const local = 'owner\nsecond\nthird\n'; await replace(local);
    await view.import(receipt.receiptHash); assert.equal(document.getText(), local, 'Cancel preserves the dirty buffer');
    confirmMerge = async () => {assert.ok(vscode.workspace.textDocuments.some(d => d.uri.scheme === 'readymade-inbox' && d.getText() === 'owner\nsecond\npeer\n')); return true;};
    await view.import(receipt.receiptHash); assert.equal(document.getText(), 'owner\nsecond\npeer\n');
    assert.equal(drafts.get(draft.id).text, source, 'Apply does not save the journal'); assert.ok(document.isDirty);
    await vscode.commands.executeCommand('undo'); assert.equal(document.getText(), local, 'One Undo restores only the preceding owner buffer');
    confirmMerge = async () => {await replace('late\nsecond\nthird\n'); return true;};
    await assert.rejects(view.import(receipt.receiptHash), /changed during preview/); assert.equal(document.getText(), 'late\nsecond\nthird\n');
    confirmMerge = async () => {stale = true; return true;};
    await assert.rejects(view.import(receipt.receiptHash), /changed during confirmation/); stale = false;
    confirmMerge = async () => {project = 'other'; return true;};
    await assert.rejects(view.import(receipt.receiptHash), /changed during preview/); project = 'shared';
    await replace('first\nsecond\nconflict\n'); confirmMerge = async () => {throw Error('Conflicting edits must not offer automatic apply');};
    await view.import(receipt.receiptHash); assert.equal(document.getText(), 'first\nsecond\nconflict\n'); assert.equal(drafts.get(draft.id).text, source);
    stale = true; await assert.rejects(view.import(receipt.receiptHash), /No current owner session/); assert.equal(drafts.get(draft.id).text, source);
    project = 'other'; await assert.rejects(view.import(receipt.receiptHash), /Refresh/); assert.equal(writes, 0);
    return {renderedInbox: true, openedSuggestion: true, realSourceStoreLoaderPath: true, importedOwnerDraft: true, originalAndCommitPreserved: true,
      existingDraftPreserved: true, mergePreview: true, scriptedMergeConfirmation: true, ownerLocalUndo: true, overlapPreserved: true, documentDriftRefused: true, staleSessionRefused: true, noAutomaticAcceptance: true, nativeWrites: writes};
  } finally {view.dispose(); registrations.forEach(item => item.dispose()); client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
}

async function invitationAcceptance() {
  const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
  const module = async <T>(name: string): Promise<T> => await import(join(extension.extensionPath, 'dist/src/' + name + '.js')) as T;
  const {ProjectInvitationsView, joinProjectLink} = await module<typeof import('../src/project-invitations-view')>('project-invitations-view');
  const {InvitationJournal} = await module<typeof import('../src/project-invitation-journal')>('project-invitation-journal');
  const {ShipClient} = await module<typeof import('../src/ship-client')>('ship-client');
  const rows: import('../src/project-invitations').InvitationRow[] = [], posts: JsonObject[] = [];
  const results = new Map<string, JsonObject>(); let peer = false, ambiguous = false;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/~/login') {req.resume(); res.setHeader('set-cookie', `urbauth-${peer ? '~nec' : '~zod'}=fixture; Path=/`); res.end('{}'); return;}
    if (req.method === 'GET') {
      if (req.url?.endsWith('/project-members')) {
        const kind = req.headers['x-readymade-project-kind'];
        const list = kind === 'members' ? [{ship: '~nec', role: 'contributor', joinedAt: '~2026.11.09'}] : ambiguous ? [...rows, {...rows[0], id: '0xabd'}] : rows;
        res.end(JSON.stringify({schema: 'readymade-project-members-v1', project: 'demo', authority: '~zod', permissionGranted: false,
          inviteUntil: '~2026.11.10', kind, catalog: '0x9', offset: 0, total: list.length, next: null, rows: list}));
      } else if (req.url?.endsWith('/project-invitation-result')) res.end(JSON.stringify(results.get(String(req.headers['x-readymade-project-request']))));
      else {assert.equal(peer, false); res.end(JSON.stringify({nonce: '0v1', cursor: '0x1', owner: '~zod', session: '0x4', ready: true, after: 0, projects: [], records: [], sessions: []}));}
      return;
    }
    let body = ''; req.on('data', chunk => {body += chunk;}); req.on('end', () => {
      const command = JSON.parse(body); posts.push(command);
      const outcome = command.operation === 'invite-member' ? 'project-invited' : command.operation === 'join' ? 'project-joined' : 'invitation-expired';
      const result = {schema: 'readymade-project-invitation-result-v1', request: command.request, authority: '~zod', project: 'demo', operation: command.operation,
        digest: '0xdef', status: 'accepted', permissionGranted: false, outcome};
      results.set(command.request, result);
      if (command.operation === 'invite-member') rows.push({id: '0xabc', target: command.target, role: command.role, issuedBy: '~zod', expiresAt: command.expiresAt, expired: false});
      if (command.operation === 'join') {req.socket.destroy(); return;}
      res.end(JSON.stringify(result));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`, owner = new ShipClient(origin, async () => 'fixture'), guest = new ShipClient(origin, async () => 'fixture');
  const directory = mkdtempSync(join(tmpdir(), 'readymade-invitations-host-')), ownerJournal = new InvitationJournal(join(directory, 'owner')), guestJournal = new InvitationJournal(join(directory, 'guest'));
  let current = owner, journal = ownerJournal;
  let view = new ProjectInvitationsView(extension.id, () => current, () => 'demo', async () => current, journal, () => {});
  const tree = vscode.window.registerTreeDataProvider('readymade.workspace', {getChildren: (row?: import('../src/media-workbench').MediaTreeRow) => row?.children ?? view.rows(),
    getTreeItem: row => {const item = new vscode.TreeItem(row.label, row.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None); item.command = row.command; return item;}});
  try {
    await owner.signIn(); await owner.codingState('0x4'); await view.invite('~nec', 'contributor');
    await vscode.commands.executeCommand('readymade.workspace.focus');
    assert.equal(view.rows()[0].label, 'Project Invitations');
    await view.observe('members');
    const member = view.rows()[0].children!.find(row => row.label === '~nec')!;
    assert.deepEqual(member.children![0].command, {command: 'readymade.projectSharing', title: 'Manage Shared Files', arguments: ['~nec']});
    assert.equal(posts.length, 1);
    const invitation = ownerJournal.entries()[0]; await view.copyLink(invitation.command.request);
    const copied = await vscode.env.clipboard.readText(), link = joinProjectLink(vscode.Uri.parse(copied), extension.id);
    assert.equal(link.invitation, '0xabc'); assert.notEqual(link.invitation, '0xdef'); assert.equal(link.target, '~nec');
    assert.throws(() => joinProjectLink(vscode.Uri.parse(copied + '&origin=https://foreign.example'), extension.id));
    ambiguous = true; await assert.rejects(view.copyLink(invitation.command.request), /One exact/); assert.equal(await vscode.env.clipboard.readText(), copied); ambiguous = false;
    rows[0].expired = true; await view.observe('invitations');
    assert.ok(JSON.stringify(view.rows()).includes('Close Expired Invitation'));
    await view.closeInvitation('0xabc', true); assert.equal(posts[1].operation, 'expire-invitation');
    rows[0].expired = false; peer = true; await guest.signIn(); assert.equal(guest.snapshot, undefined);
    view.dispose(); current = guest; journal = guestJournal;
    view = new ProjectInvitationsView(extension.id, () => current, () => undefined, async () => current, journal, () => {});
    await assert.rejects(view.join(vscode.Uri.parse(copied).with({query: new URLSearchParams({...link, target: '~bud'}).toString()})), /for ~bud/);
    await assert.rejects(view.join(copied)); assert.equal(posts.length, 3); assert.equal(posts[2].operation, 'join');
    await assert.rejects(view.join(copied), /retained/); assert.equal(posts.length, 3);
    const retained = journal.entries()[0]; view.dispose();
    view = new ProjectInvitationsView(extension.id, () => current, () => undefined, async () => current, new InvitationJournal(join(directory, 'guest')), () => {});
    await view.check(retained.command.request); assert.equal(posts.length, 3);
    assert.ok(JSON.stringify(view.rows()).includes('Joined — ask owner for shared files'));
    return {renderedInvitations: true, nativeIdNotActionDigest: true, ambiguousLinkRefused: true, explicitExpiredCleanup: true, recipientBound: true, joinedWithoutViki: true, lostJoinObservedWithoutReplay: true};
  } finally {tree.dispose(); view.dispose(); owner.close(); guest.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
}
