import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import type {ReadymadeWorkspace} from '../src/extension';
import {snapshotFrom} from '../src/source-store';
import {DraftStore} from '../src/draft-store';
import {DraftReviewView} from '../src/draft-review-view';
import type {CodingSnapshot} from '../src/protocol';
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export async function run():Promise<void>{
  const extension=vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace');assert.ok(extension);
  const api=await extension.activate();
  const source={id:'0x3',owner:'~zod',desk:'fixture',number:1,root:'0v4',commit:'0v5'};
  const snapshot=snapshotFrom({origin:'https://historical.invalid',ship:'~zod',session:'0x1',source,path:'/lib/historical/hoon',blob:'0x6',mark:'hoon',text:'original\n'});
  const row=api.drafts.create(snapshot),context={origin:snapshot.origin,ship:snapshot.ship,project:'historical',sessions:new Map([[snapshot.session,'historical']])};
  api.changes.refresh(context);api.drafts.save(row.id,'submitted\n');
  const state:CodingSnapshot={ready:true,owner:'~zod',session:'0x1',nonce:'0v1',cursor:'0x1',after:0,projects:[],sessions:[{id:'0x1',project:'historical',source}],records:[],reviews:[],commandReceipt:{version:'native-coding-command-receipt-v1',target:'viki',session:'0x1',source:'0x3',request:'0x7',delivery:'0x8'},delivery:'0x8: submitted; observing native retention'};
  let fixtureCalls=0;
  await api.drafts.prepare(row.id,{origin:snapshot.origin,snapshot:state,codingTool:async()=>{fixtureCalls++;return state;}});
  api.drafts.save(row.id,'later local\n');api.changes.refresh(context);
  await api.changes.review(row.id,true);
  let tab=vscode.window.tabGroups.activeTabGroup.activeTab?.input;assert.ok(tab instanceof vscode.TabInputTextDiff);
  const original=await vscode.workspace.openTextDocument(tab.original),submitted=await vscode.workspace.openTextDocument(tab.modified);
  assert.equal(original.getText(),'original\n');assert.equal(submitted.getText(),'submitted\n');
  assert.equal(vscode.workspace.fs.isWritableFileSystem('readymade-review'),false);
  assert.equal((await vscode.workspace.fs.stat(submitted.uri)).permissions,vscode.FilePermission.Readonly);
  assert.equal(vscode.window.activeTextEditor?.document.uri.toString(),submitted.uri.toString());
  await vscode.commands.executeCommand('type',{text:'forbidden'}).then(()=>{},()=>{});assert.equal(submitted.getText(),'submitted\n');
  await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(original.uri,Buffer.from('forbidden'))));
  await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(submitted.uri,Buffer.from('forbidden'))));
  await api.changes.review(row.id);tab=vscode.window.tabGroups.activeTabGroup.activeTab?.input;assert.ok(tab instanceof vscode.TabInputTextDiff);assert.equal(tab.modified.toString(),row.uri);
  const working=await vscode.workspace.openTextDocument(tab.modified);assert.equal(working.getText(),'later local\n');
  const editor=await vscode.window.showTextDocument(working,{preview:false,preserveFocus:false});editor.selection=new vscode.Selection(0,0,0,0);assert.equal(vscode.window.activeTextEditor?.document.uri.toString(),working.uri.toString());
  await vscode.commands.executeCommand('type',{text:'X'});assert.equal(working.getText(),'Xlater local\n');
  await vscode.commands.executeCommand('undo');assert.equal(working.getText(),'later local\n');
  await vscode.commands.executeCommand('type',{text:'saved '});assert.equal(await working.save(),true);assert.equal(api.drafts.get(row.id).text,working.getText());
  const savedWorking=working.getText();assert.equal(api.drafts.get(row.id).pending?.text,'submitted\n');
  // Ordinary background rendering reconstructs equivalent maps and must not cancel a review.
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({content:'same context picker'}));
  const sameContext=api.changes.review(undefined,true);void sameContext.catch(()=>{});await wait(300);
  api.changes.refresh({...context,sessions:new Map([...context.sessions].reverse())});
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');await sameContext;
  assert.equal(vscode.window.activeTextEditor?.document.uri.toString(),submitted.uri.toString());assert.equal(submitted.getText(),'submitted\n');
  const edit=new vscode.WorkspaceEdit();edit.insert(submitted.uri,new vscode.Position(0,0),'privileged ');assert.equal(await vscode.workspace.applyEdit(edit),true);assert.equal(submitted.getText(),'privileged submitted\n');
  await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(submitted.uri,Buffer.from(submitted.getText()))));
  assert.equal(Buffer.from(await vscode.workspace.fs.readFile(submitted.uri)).toString('utf8'),'submitted\n');
  await assert.rejects(api.changes.review(row.id,true),/Historical evidence buffer changed/);
  assert.equal(working.getText(),savedWorking);assert.equal(api.drafts.get(row.id).pending?.text,'submitted\n');
  // A context switch during the awaited picker must refuse even if the old row is chosen.
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({content:'picker focus'}));
  const pending=api.changes.review(undefined,true);void pending.catch(()=>{});await wait(300);
  api.changes.refresh({...context,project:'other'});await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');await assert.rejects(pending,/context changed/);
  await assert.rejects(Promise.resolve(vscode.workspace.fs.readFile(original.uri)));api.changes.refresh(context);
  // Restore from the real private journal without network and without reusing altered model URIs.
  const restoredStore=new DraftStore(api.drafts.directory);assert.equal(restoredStore.get(row.id).pending?.text,'submitted\n');
  api.changes.dispose();const restored=new DraftReviewView(restoredStore);
  try{restored.refresh(context);assert.equal(restored.provideTextDocumentContent(original.uri),'original\n');assert.equal(restored.provideTextDocumentContent(submitted.uri),'submitted\n');}
  finally{restored.dispose();}
  if(process.env.READYMADE_HOST_EVIDENCE)writeFileSync(process.env.READYMADE_HOST_EVIDENCE,JSON.stringify({passed:true,fixture:true,nativeCalls:0,httpCalls:0,fixturePrepareCalls:fixtureCalls,userTypingBlocked:true,workingDraftEditable:true,workingUndoAndSave:true,submittedBytesFrozen:true,backingEvidenceImmutable:true,extensionAPIBufferImmutability:false,privilegedBufferMutationObserved:true,tamperedBufferReuseRefused:true,equivalentContextRefreshAccepted:true,projectPickerDriftRefused:true,offlineJournalRestored:true}),{flag:'wx',mode:0o600});
}
