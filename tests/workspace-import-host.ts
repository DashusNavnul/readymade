import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {existsSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {ReadymadeWorkspace} from '../src/extension';
import type {ShipClient} from '../src/ship-client';
import type {JsonObject} from '../src/protocol';
import type {WorkspaceImportPreview} from '../src/workspace-import-store';
import type {WorkspaceReturnPreview} from '../src/workspace-return-store';
import {remoteSourceHash} from '../src/remote-project-view';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {for (let n = 0; n < 100; n++) {if (check()) return; await wait(50);} throw new Error('Import picker did not reach expected stage');}
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
  const api = await extension.activate(), context = (api as unknown as {context: vscode.ExtensionContext}).context, source = {id: '0x3', owner: '~zod', desk: 'work', number: 1, root: '0v4', commit: '0v5'};
  let preview!: WorkspaceImportPreview, confirms = 0, lost = false, eid = '0v1'; const calls: string[] = [], retained: JsonObject[] = [];
  let returnConfirms=0; const returnCalls:string[]=[]; let returnPreview!:WorkspaceReturnPreview;
  let resultReads=0, driftResult=false;
  const receipt = (p: WorkspaceImportPreview): JsonObject => ({schema: 'readymade-workspace-request-v1', owner: p.owner, requester: p.owner, nonce: p.nonce, requestDigest: p.requestDigest, binding: '0xa', generation: '1', authority: p.owner, project: 'demo', noteHost: '~zod', note: p.note, session: p.session, nativeRequest: '0xb', text: p.text, message: {author: p.author, eid: p.eid, revision: p.revision, content: remoteSourceHash(p.text)}, sourceDesk: p.sourceDesk, sourceRevision: p.sourceRevision, sourceRoot: p.sourceRoot, sourceCommit: p.sourceCommit, status: 'reserved', evidence: null, retainedOnly: true, executionAuthorized: false, taskCompleted: false, mayResubmit: false, recoveryRequired: false});
  const client = {origin: 'http://localhost:18899', snapshot: {ready: true, owner: '~zod', session: '0x1', sessions: [{id: '0x1', project: 'demo', source}], projects: [], records: []}, browserCookies: () => [{name: 'urbauth-~zod', value: 'fixture'}], codingState: async () => client.snapshot,
    workspaceResult: async (_requester:string,nonce:string) => {
      resultReads++;const r=retained.find(row=>row.nonce===nonce)!;if(driftResult)api.workspaceRequests.rows('other');
      const before={owner:'~zod',desk:'work',revision:'1',root:'0v4',commit:'0v5'},middle={...before,revision:'2',root:'0v6',commit:'0v7'},after={...before,revision:'3',root:'0v8',commit:'0v9'};
      return {schema:'readymade-workspace-result-v1',owner:'~zod',requester:'~zod',nonce,project:'demo',session:'0x1',requestDigest:r.requestDigest,nativeRequest:r.nativeRequest,instruction:'0xd',judgment:'0xe',status:'verified',source:before,resultSource:after,
        changes:[{candidate:'0x21',path:'/lib/demo/hoon',kind:'modify',beforeSource:before,afterSource:middle,beforeHash:'0x31',afterHash:'0x32',beforeText:'first\n',afterText:'second\n'},{candidate:'0x22',path:'/lib/demo/hoon',kind:'modify',beforeSource:middle,afterSource:after,beforeHash:'0x32',afterHash:'0x33',beforeText:'second\n',afterText:'third\n'}],
        checks:[{tool:'0x23',candidate:'0x21',diagnostic:{name:'compile',passed:false,detail:'Exact failed compiler diagnostic',source:{...middle,desk:'nc-21'},artifacts:['0x24']}}],changesStatus:'changed',checksStatus:'recorded',evidence:['0x25'],resultDigest:'0x26',executionAuthorized:false,disclosureAuthorized:false};
    },
    workspaceReturn: async (operation:string,params:JsonObject) => {
      returnCalls.push(operation);const r=retained.find(row=>row.nonce===params.nonce)!;
      if(operation==='preview') {const text='Owner-written summary (not a native verdict):\n'+String(params.summary)+'\nFull file contents and checks: first → second → third; FAIL compile: Exact failed compiler diagnostic';
        const report=await client.workspaceResult(String(r.requester),String(r.nonce));
        returnPreview={schema:'readymade-workspace-return-v2',owner:'~zod',requester:'~zod',nonce:String(r.nonce),project:'demo',session:'0x1',requestDigest:String(r.requestDigest),nativeRequest:'0xb',submissionEvidence:'0xc',sourceDesk:'work',sourceRevision:'1',sourceRoot:'0v4',sourceCommit:'0v5',noteHost:'~zod',note:String(r.note),author:preview.author,eid:preview.eid,messageRevision:'0',instruction:'0xd',judgment:'0xe',evidence:['0x25'],membership:'0x10',audience:['~zod','~nec'],summary:String(params.summary),text,payloadDigest:remoteSourceHash(text),previewDigest:'0x11',status:'preview',postedEid:null,executionAuthorized:false,report:report as unknown as NonNullable<WorkspaceReturnPreview['report']>};return returnPreview as unknown as JsonObject;}
      if(operation==='confirm'){returnConfirms++;assert.ok(readdirSync(join(context.globalStorageUri.fsPath,'workspace-returns')).some(n=>n.endsWith('.json')));throw Error('Lost share response');}
      assert.equal(operation,'result');return {...returnPreview,status:'posted',postedEid:'0v12'} as unknown as JsonObject;
    },
    workspaceImport: async (route: string, _headers: Record<string, string>, body?: JsonObject) => {
      calls.push(route);
      if (route === 'import-options') return {schema: 'readymade-workspace-import-options-v1', owner: '~zod', session: '0x1', notes: [{id: 'group-one', title: 'Team'}], grants: [{id: '0x2', session: '0x1', label: 'Read source', operations: ['read']}], executionAuthorized: false};
      if (route === 'import-messages') return {schema: 'readymade-workspace-import-messages-v1', owner: '~zod', note: 'group-one', catalog: '0x8', offset: 0, total: 1, next: null, messages: [{eid, revision: '0', author: '~nec', text: 'Picker excerpt'}], executionAuthorized: false};
      if (route === 'import-preview') {preview = {schema: 'readymade-workspace-import-preview-v1', owner: '~zod', nonce: String(body!.nonce), session: '0x1', note: 'group-one', eid, grant: '0x2', previewDigest: '0x6', requestDigest: '0x7', author: '~nec', revision: '0', text: 'Full canonical message.\nPreserve every line.', sourceDesk: 'work', sourceRevision: '1', sourceRoot: '0v4', sourceCommit: '0v5', executionAuthorized: false}; return preview;}
      if (route === 'import-confirm') {confirms++; const directory = join(context.globalStorageUri.fsPath, 'workspace-imports'); assert.ok(existsSync(directory) && readdirSync(directory).some(name => name.endsWith('.json'))); const row = receipt(preview); retained.push(row); if (lost) throw new Error('Lost confirmation response'); return row;}
      assert.equal(route, 'request'); return receipt(preview);
    }, workspaceRequest: async (operation: string, params: {nonce?: string}) => {
      if (operation === 'catalog') return {status: 200, body: {schema: 'readymade-workspace-catalog-v1', owner: '~zod', catalog: '0x9', offset: 0, total: retained.length, next: null, executionAuthorized: false, requests: retained.map(row => ({requester: row.requester, nonce: row.nonce, requestDigest: row.requestDigest, project: row.project, session: row.session, status: row.status}))}};
      assert.equal(operation, 'read'); const row = retained.find(value => value.nonce === params.nonce); assert.ok(row); return {status: 200, body: row};
    }};
  api.workspaceRequests.connect(client as unknown as ShipClient, '~zod'); api.workspaceRequests.rows('demo');
  const view = api.workspaceRequests.imports;
  view.confirmImport = async p => {const doc = vscode.window.activeTextEditor?.document; assert.equal(doc?.uri.scheme, 'readymade-import-preview'); assert.deepEqual(JSON.parse(doc!.getText()), p); assert.equal(p.text, 'Full canonical message.\nPreserve every line.'); return true;};
  const drive = async () => {
    calls.length = 0; const running = vscode.commands.executeCommand('readymade.importSharedMessage'); void running.then(undefined, () => {});
    await until(() => calls.includes('import-options')); await wait(250); await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await until(() => calls.includes('import-messages')); await wait(250); await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await wait(250); await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); return running;
  };
  try {
    await drive(); assert.equal(confirms, 1); assert.equal(api.workspaceRequests.store?.selection?.nonce, preview.nonce); assert.equal(api.workspaceRequests.store?.canSubmit, false);
    assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'readymade-request');
    view.confirmImport = async () => {api.workspaceRequests.rows('other'); return true;}; await assert.rejects(drive(), /Project or session changed/); assert.equal(confirms, 1); api.workspaceRequests.rows('demo');
    view.confirmImport = async () => true; lost = true; eid = '0v2'; await assert.rejects(drive(), /Lost confirmation/); assert.equal(confirms, 2); const unknown = preview.nonce;
    assert.ok(view.rows().some(row => row.description === 'Outcome unconfirmed — no resend'));
    await vscode.commands.executeCommand('readymade.checkSharedMessageImport', unknown); assert.equal(confirms, 2); assert.equal(api.workspaceRequests.store?.selection?.nonce, unknown);
    const original=retained.find(row=>row.nonce===unknown)!;original.status='recorded';original.evidence='0xc';
    const model=api.workspaceRequests.store!;await model.load();model.select(model.requests.find(row=>row.nonce===unknown)!);await model.read();
    const returns=api.workspaceRequests.returns;returns.promptSummary=async()=> 'Owner-written fixture summary';
    returns.confirmShare=async p=>{const doc=vscode.window.activeTextEditor!.document;assert.equal(doc.uri.scheme,'readymade-return-preview');assert.ok(doc.getText().endsWith(p.text));assert.ok(doc.getText().includes('Audience (2): ~zod, ~nec'));assert.ok(doc.getText().includes('OWNER-WRITTEN SUMMARY'));assert.ok(doc.getText().includes('FULL NATIVE FILE AND CHECK REPORT'));assert.ok(doc.getText().includes('FAIL compile'));api.workspaceRequests.rows('other');return true;};
    await assert.rejects(returns.share(),/Selected request, project or session changed/);assert.equal(returnConfirms,0);api.workspaceRequests.rows('demo');
    returns.confirmShare=async p=>{assert.ok(vscode.window.activeTextEditor!.document.getText().endsWith(p.text));return true;};
    await assert.rejects(returns.share(),/Lost share response/);assert.equal(returnConfirms,1);assert.equal(returns.state(),'check');
    await assert.rejects(returns.share(),/already claimed/);await returns.check();assert.equal(returnConfirms,1);assert.equal(returnCalls.at(-1),'result');
    assert.ok(vscode.window.activeTextEditor!.document.getText().includes('Posted message: 0v12'));assert.ok(vscode.window.activeTextEditor!.document.getText().endsWith(returnPreview.text));
    const draft=await vscode.workspace.openTextDocument({content:'Unpublished local work',language:'plaintext'}),draftText=draft.getText(),draftDirty=draft.isDirty;
    const inspect=async(index:number)=>{const priorReads=resultReads,action=vscode.commands.executeCommand('readymade.inspectWorkspaceResult');void action.then(undefined,()=>{});await until(()=>resultReads>priorReads);await until(()=>vscode.window.activeTextEditor?.document.uri.path.endsWith('/summary.txt')===true);await wait(300);
      const summary=vscode.window.activeTextEditor!.document.getText();assert.ok(summary.includes('ORIGINAL SOURCE'));assert.ok(summary.includes('RESULT SOURCE'));assert.ok(summary.includes('FAIL compile'));assert.ok(summary.includes('revisions 1 → 2'));assert.ok(summary.includes('revisions 2 → 3'));
      for(let n=0;n<index;n++)await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');await action;};
    await inspect(0);assert.ok(vscode.window.activeTextEditor!.document.getText().includes('Exact failed compiler diagnostic'));assert.ok(vscode.window.activeTextEditor!.document.getText().includes('%nc-21 revision 2'));
    await inspect(2);const tab=vscode.window.tabGroups.activeTabGroup.activeTab;assert.ok(tab?.input instanceof vscode.TabInputTextDiff);const diff=tab.input as vscode.TabInputTextDiff;
    const left=await vscode.workspace.openTextDocument(diff.original),right=await vscode.workspace.openTextDocument(diff.modified);assert.equal(left.getText(),'second\n');assert.equal(right.getText(),'third\n');assert.notEqual(left.uri.toString(),right.uri.toString());
    assert.equal(vscode.workspace.fs.isWritableFileSystem('readymade-workspace-result'),false);
    assert.equal((await vscode.workspace.fs.stat(right.uri)).permissions,vscode.FilePermission.Readonly);
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(right.uri,Buffer.from('forbidden'))));
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(right.uri)).toString('utf8'),'third\n');
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(),right.uri.toString());
    await vscode.commands.executeCommand('type',{text:'forbidden'}).then(()=>{},()=>{});assert.equal(right.getText(),'third\n');
    // Privileged extension edits bypass the editor's readonly UI; they must never replace backing evidence or be reused.
    const edit=new vscode.WorkspaceEdit();edit.insert(right.uri,new vscode.Position(0,0),'forbidden');assert.equal(await vscode.workspace.applyEdit(edit),true);assert.equal(right.getText(),'forbiddenthird\n');
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(right.uri,Buffer.from(right.getText()))));
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(right.uri)).toString('utf8'),'third\n');
    await assert.rejects(inspect(2),/Historical evidence buffer changed/);assert.equal(draft.getText(),draftText);assert.equal(draft.isDirty,draftDirty);
    driftResult=true;await assert.rejects(Promise.resolve(vscode.commands.executeCommand('readymade.inspectWorkspaceResult')));assert.equal(returnConfirms,1);api.workspaceRequests.rows('demo');
    if (process.env.READYMADE_HOST_EVIDENCE) writeFileSync(process.env.READYMADE_HOST_EVIDENCE, JSON.stringify({passed: true, actualInstalledEditor: true, fixture: true, realPickers: true, fullNativePreviewRendered: true, scriptedConfirmation: true, exactImportedRequestSelected: true, changedContextRefused: true, lostReplyRecoveredWithoutResend: true, richResultSummary:true, historicalUserTypingBlocked:true, backingEvidenceImmutable:true, extensionAPIBufferImmutability:false, privilegedBufferMutationObserved:true, tamperedBufferReuseRefused:true, exactFailedDiagnostic:true, samePathRevisionsSeparated:true, dirtyDraftPreserved:true, resultContextDriftRefused:true, returnPreviewRendered:true, returnContextDriftRefused:true, lostShareRecoveredWithoutResend:true, actualDialogClick:false, executionCalls: 0, nativeCalls: 0}), {flag: 'wx', mode: 0o600});
  } finally {api.workspaceRequests.disconnect();}
}
