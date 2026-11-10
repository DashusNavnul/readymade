import * as vscode from 'vscode';
import {join} from 'node:path';
import {digest} from './source-store';
import type {ShipClient} from './ship-client';
import type {WorkspaceRequestDetail} from './workspace-request-store';
import {WorkspaceReturnStore, type WorkspaceReturnPreview, type WorkspaceReturnReply} from './workspace-return-store';
import {workspaceReturnDocument} from './workspace-return-preview';
export interface WorkspaceReturnBinding {client:ShipClient;request:WorkspaceRequestDetail}
/** Explicit disclosure of an owner-written summary with native completion references. */
export class WorkspaceReturnView implements vscode.Disposable {
  private busy=false;
  private closed=false;
  private readonly documents=new Map<string,string>();
  private readonly provider:vscode.Disposable;
  constructor(private readonly context:vscode.ExtensionContext,private readonly binding:()=>WorkspaceReturnBinding|undefined,private readonly changed:()=>void){
    this.provider=vscode.workspace.registerTextDocumentContentProvider('readymade-return-preview',{provideTextDocumentContent:uri=>{const body=this.documents.get(uri.toString());if(body===undefined)throw Error('Result-sharing preview is unavailable.');return body;}});
  }
  private key(b:WorkspaceReturnBinding):string{return JSON.stringify([b.client.origin,b.request.owner,b.request.project,b.request.session,b.request.requester,b.request.nonce,b.request.requestDigest]);}
  private current(b:WorkspaceReturnBinding):boolean{const now=this.binding();return !this.closed&&!!now&&now.client===b.client&&this.key(now)===this.key(b);}
  private guard(b:WorkspaceReturnBinding):void{if(!this.current(b))throw Error('Selected request, project or session changed. Return to the original request to check its result.');}
  private requireBinding():WorkspaceReturnBinding{const b=this.binding();if(this.closed||!b)throw Error('Select the original recorded group request in its current coding session.');return {client:b.client,request:structuredClone(b.request)};}
  private store(b:WorkspaceReturnBinding):WorkspaceReturnStore{return new WorkspaceReturnStore(join(this.context.globalStorageUri.fsPath,'workspace-returns'),b.client,b.request,()=>this.current(b));}
  state():'share'|'check'|'unavailable'{try{const b=this.requireBinding();return this.store(b).intent()?'check':'share';}catch{return 'unavailable';}}
  private async inspect(value:WorkspaceReturnPreview|WorkspaceReturnReply,b:WorkspaceReturnBinding):Promise<void>{
    this.guard(b);const text=workspaceReturnDocument(value,b.request),uri=vscode.Uri.parse('readymade-return-preview:/'+b.request.nonce+'/'+digest(text)+'.txt');
    if(!this.documents.has(uri.toString())&&this.documents.size>=64)throw Error('This window retains 64 sharing previews. Open a new window to inspect another.');
    this.documents.set(uri.toString(),text);const document=await vscode.workspace.openTextDocument(uri);this.guard(b);
    await vscode.window.showTextDocument(document,{preview:false,preserveFocus:false});this.guard(b);
  }
  promptSummary=async ():Promise<string|undefined>=>vscode.window.showInputBox({title:'Share result with original group',prompt:'Owner-written summary (up to 8 KiB). Native completion references are attached separately.',ignoreFocusOut:true});
  confirmShare=async (p:WorkspaceReturnPreview):Promise<boolean>=>(await vscode.window.showWarningMessage('Share this exact result with the original group?',{modal:true,detail:`Audience: ${p.audience.join(', ')}\nGroup: ${p.note} on ${p.noteHost}\nProject: ${p.project}\nPreview: ${p.previewDigest}\n\n${p.text}\n\nThis sends one message. An unconfirmed outcome must be checked, never resent.`},'Share once'))==='Share once';
  async share():Promise<void>{
    if(this.busy)throw Error('A result-sharing operation is already open.');const b=this.requireBinding(),store=this.store(b);this.busy=true;this.changed();
    try{if(store.intent())throw Error('A share was already claimed. Check its result; do not resend.');
      const summary=await this.promptSummary();this.guard(b);if(summary===undefined)return;
      const preview=await store.preview(summary);this.guard(b);await this.inspect(preview,b);this.guard(b);
      const confirmed=await this.confirmShare(preview);this.guard(b);if(!confirmed)return;
      const result=await store.confirm(preview);this.guard(b);await this.inspect(result,b);this.guard(b);
      void vscode.window.showInformationMessage(result.status==='posted'?'Result observed in the original group.':'Share attempted. Delivery is unconfirmed; use Check shared result.');
    }finally{this.busy=false;this.changed();}
  }
  async check():Promise<void>{
    if(this.busy)throw Error('Wait for the current result-sharing operation.');const b=this.requireBinding();this.busy=true;
    try{const result=await this.store(b).recover();this.guard(b);await this.inspect(result,b);this.guard(b);void vscode.window.showInformationMessage(result.status==='posted'?'Result observed in the original group.':'Delivery remains unconfirmed. No message was resent.');}
    finally{this.busy=false;this.changed();}
  }
  dispose():void{this.closed=true;this.provider.dispose();this.documents.clear();}
}
