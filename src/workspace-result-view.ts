import * as vscode from 'vscode';
import {HistoricalDocuments} from './historical-documents';
import {digest} from './source-store';
import {ShipClientError} from './ship-client';
import {WorkspaceResultStore, type WorkspaceResult, type WorkspaceResultSource} from './workspace-result-store';
import type {WorkspaceReturnBinding} from './workspace-return-view';
const sourceLabel=(s:WorkspaceResultSource)=>`${s.owner}/%${s.desk} revision ${s.revision}\nRoot: ${s.root}\nCommit: ${s.commit}`;
/** Historical inspection only. Immutable documents never save or disclose work. */
export class WorkspaceResultView implements vscode.Disposable {
  private closed=false;
  private busy=false;
  private readonly documents=new HistoricalDocuments('readymade-workspace-result');
  private readonly registrations:vscode.Disposable[];
  constructor(private readonly binding:()=>WorkspaceReturnBinding|undefined){
    this.registrations=[this.documents,
      vscode.commands.registerCommand('readymade.inspectWorkspaceResult',async()=>{try{await this.open();}catch(error){void vscode.window.showErrorMessage(error instanceof Error?error.message:'Request result unavailable.');throw error;}})];
  }
  private current(b:WorkspaceReturnBinding):boolean{const now=this.binding();return !this.closed&&!!now&&now.client===b.client&&['owner','requester','nonce','project','session','requestDigest','nativeRequest'].every(k=>now.request[k]===b.request[k]);}
  private guard(b:WorkspaceReturnBinding):void{if(!this.current(b))throw Error('Selected request, project or session changed. Reopen Files and Checks for the selected request.');}
  private retain(b:WorkspaceReturnBinding,r:WorkspaceResult,name:string,text:string):vscode.Uri{
    this.guard(b);const key=digest(JSON.stringify([b.client.origin,r.owner,r.requester,r.nonce,r.requestDigest,r.resultDigest,name,text]));
    const uri=vscode.Uri.parse(`readymade-workspace-result:/${key}/${encodeURIComponent(name)}`);
    return this.documents.retain(uri,text);
  }
  private verifyDocument(doc:vscode.TextDocument,b:WorkspaceReturnBinding):void{this.documents.verify(doc,()=>this.guard(b));}
  private async document(uri:vscode.Uri,b:WorkspaceReturnBinding):Promise<vscode.TextDocument>{return this.documents.open(uri,()=>this.guard(b));}
  private async show(uri:vscode.Uri,b:WorkspaceReturnBinding):Promise<void>{const doc=await this.document(uri,b);this.verifyDocument(doc,b);await vscode.window.showTextDocument(doc,{preview:false,preserveFocus:false});this.verifyDocument(doc,b);}
  private summary(r:WorkspaceResult,b:WorkspaceReturnBinding):string{return [
    'Files and checks for this request',`Project: ${r.project}`,`Session: ${r.session}`,`Original request: ${r.nonce}`,String(b.request.text),'',
    'ORIGINAL SOURCE',sourceLabel(r.source),'','RESULT SOURCE',sourceLabel(r.resultSource),'',
    'CHANGED FILES',...(r.changes.length?r.changes.map((c,i)=>`${i+1}. ${c.kind} ${c.path} · revisions ${c.beforeSource.revision} → ${c.afterSource.revision}\n   Candidate: ${c.candidate}`):['Native evidence verifies no file changes for this request.']),'',
    'CHECKS',...(r.checks.length?r.checks.map(c=>`${c.diagnostic.passed?'PASS':'FAIL'} ${c.diagnostic.name} · %${c.diagnostic.source.desk} revision ${c.diagnostic.source.revision}`):['Native evidence records no checks performed for this request.']),'',
    'CORRELATION',`Request digest: ${r.requestDigest}`,`Native request: ${r.nativeRequest}`,`Instruction: ${r.instruction}`,`Judgment: ${r.judgment}`,`Result: ${r.resultDigest}`,
    'Evidence references:',...r.evidence,'','Read-only historical evidence. This does not execute, apply, deploy or share anything.',
  ].join('\n');}
  private checks(r:WorkspaceResult):string{return ['Native checks for the selected request',`Project: ${r.project}`,`Request: ${r.requestDigest}`,'',
    ...(r.checks.length?r.checks.flatMap((c,i)=>[`${i+1}. ${c.diagnostic.passed?'PASS':'FAIL'} — ${c.diagnostic.name}`,`Tool: ${c.tool}`,`Candidate: ${c.candidate??'Direct tool result'}`,sourceLabel(c.diagnostic.source),'Exact diagnostic:',c.diagnostic.detail,'Artifacts:',...c.diagnostic.artifacts,'']):['No checks performed, according to this verified native result.']),
    'Check source may be a private candidate staging desk; it is labeled above. No result has been rerun.',
  ].join('\n');}
  async open():Promise<void>{
    if(this.busy)throw Error('A request result inspection is already open.');const selected=this.binding();if(this.closed||!selected)throw Error('Select a recorded shared request in its project and coding session first.');
    const b={client:selected.client,request:structuredClone(selected.request)};this.busy=true;
    try{
      let r:WorkspaceResult;
      try{r=await new WorkspaceResultStore(b.client,b.request,()=>this.current(b)).read();}
      catch(error){this.guard(b);if(error instanceof ShipClientError)throw Error('Files and Checks is unavailable on this ship. It requires the native workspace-result backend and complete request-attributed evidence. No empty report was substituted.');throw error;}
      this.guard(b);await this.show(this.retain(b,r,'summary.txt',this.summary(r,b)),b);this.guard(b);
      const items=[{label:'View exact check diagnostics',description:`${r.checks.length} recorded`,index:-1},...r.changes.map((c,index)=>({label:`${c.kind} ${c.path}`,description:`revisions ${c.beforeSource.revision} → ${c.afterSource.revision} · ${c.candidate}`,index}))];
      const pick=await vscode.window.showQuickPick(items,{title:'Files and Checks — Inspect historical evidence',matchOnDescription:true});this.guard(b);if(!pick)return;
      if(pick.index===-1){await this.show(this.retain(b,r,'checks.txt',this.checks(r)),b);return;}
      const c=r.changes[pick.index];if(!c)throw Error('The selected historical change is unavailable.');
      const left=this.retain(b,r,`${pick.index+1}-before.txt`,c.beforeText??''),right=this.retain(b,r,`${pick.index+1}-after.txt`,c.afterText??'');
      const leftDoc=await this.document(left,b),rightDoc=await this.document(right,b);this.verifyDocument(leftDoc,b);this.verifyDocument(rightDoc,b);
      await vscode.commands.executeCommand('vscode.diff',left,right,`${c.path} · ${c.kind} · ${c.beforeSource.revision} → ${c.afterSource.revision}`,{preview:false});this.verifyDocument(leftDoc,b);this.verifyDocument(rightDoc,b);
    }finally{this.busy=false;}
  }
  dispose():void{this.closed=true;this.registrations.forEach(r=>r.dispose());}
}
