import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import type {BrowserTab} from 'vscode';
import {ComposerJournal, attachComposerJournal} from '../src/composer-journal';
const key = 'nb-composer-v1/'+JSON.stringify(['let','note-1']);
const value = JSON.stringify({version:1,text:'Unsent 🜁',replyingTo:null,replyingToEid:null,editingMsgId:null,editingEid:null,replyLabel:''});
function fixture() { const root=fs.mkdtempSync(join(tmpdir(),'composer-journal-'));fs.chmodSync(root,0o700);return {root,journal:new ComposerJournal(root,'https://ship.example','let')}; }
test('maximum escaped draft remains readable after a fresh journal opens it', () => {
  const {root,journal}=fixture();try {
    const row=JSON.parse(value);row.text='';
    const remaining=1024*1024-Buffer.byteLength(JSON.stringify(row));
    row.text='\\'.repeat(Math.floor(remaining/2))+'x'.repeat(remaining%2);
    const large=JSON.stringify(row),longKey='nb-composer-v1/'+JSON.stringify(['let','n'.repeat(1900)]);
    assert.equal(Buffer.byteLength(large),1024*1024);
    journal.set(longKey,large);
    const file=join(journal.directory,fs.readdirSync(journal.directory)[0]);
    assert.ok(fs.statSync(file).size>2*1024*1024);
    assert.deepEqual(new ComposerJournal(root,journal.origin,journal.ship).entries(),[[longKey,large]]);
    row.text+='x';assert.throws(()=>journal.set(longKey,JSON.stringify(row)),/exceeds backup limit/);
    assert.deepEqual(journal.entries(),[[longKey,large]]);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('private drafts survive a new journal; identities, schema and cookies remain isolated', () => {
  const {root,journal}=fixture();try {
    journal.set(key,value);assert.deepEqual(new ComposerJournal(root,journal.origin,'let').entries(),[[key,value]]);
    assert.deepEqual(new ComposerJournal(root,journal.origin,'zod').entries(),[]);
    assert.deepEqual(new ComposerJournal(root,'https://other.example','let').entries(),[]);
    assert.throws(()=>journal.set('urbauth-~let','secret'));assert.throws(()=>journal.set('nb-composer-v1/["zod","note-1"]',value));
    assert.throws(()=>journal.set(key,'{"version":1,"cookie":"secret"}'));
    const file=join(journal.directory,fs.readdirSync(journal.directory)[0]);assert.equal(fs.statSync(file).mode&0o777,0o600);
    journal.set(key);assert.deepEqual(new ComposerJournal(root,journal.origin,'let').entries(),[]);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('hydration is origin/path scoped, runs once per ephemeral session and cannot resurrect a cleared draft on reload', () => {
  const {root,journal}=fixture();try {
    journal.set(key,value);const local=new Map(),session=new Map();
    const storage=(map:Map<string,string>)=>({getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>map.set(k,v)});
    const context={location:{origin:journal.origin,pathname:'/apps/noltbook/'},localStorage:storage(local),sessionStorage:storage(session)};
    const source=journal.hydrationScript();runInNewContext(source,context);assert.equal(local.get(key),value);
    local.delete(key);runInNewContext(source,context);assert.equal(local.size,0);
    session.clear();context.location.origin='https://foreign.example';runInNewContext(source,context);assert.equal(local.size,0);
    context.location.origin=journal.origin;context.location.pathname='/apps/groups/';runInNewContext(source,context);assert.equal(local.size,0);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('unsafe files and directories are refused without overwriting evidence', () => {
  const {root,journal}=fixture();try {
    journal.set(key,value);const file=join(journal.directory,fs.readdirSync(journal.directory)[0]);fs.chmodSync(file,0o644);
    assert.throws(()=>journal.entries());assert.throws(()=>journal.set(key,value));
    fs.chmodSync(file,0o600);fs.writeFileSync(file,'corrupt');assert.throws(()=>journal.entries());assert.equal(fs.readFileSync(file,'utf8'),'corrupt');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('browser bridge captures only the authenticated origin, target and exact draft keys', async () => {
  const {root,journal}=fixture();let receive:(x:unknown)=>void=()=>undefined;
  const url='about:blank#readymade-'+ 'a'.repeat(32), methods:string[]=[];let warnings=0;
  const channel={onDidReceiveMessage:(fn:typeof receive)=>{receive=fn;return {dispose(){}};},onDidClose:()=>({dispose(){}}),close:async()=>{},sendMessage:async(message:unknown)=>{
    const row=message as {id:number;method:string};methods.push(row.method);
    const result=row.method==='Target.getTargets'?{targetInfos:[{type:'page',url,targetId:'target'}]}:row.method==='Target.attachToTarget'?{sessionId:'owned'}:{};
    queueMicrotask(()=>receive({id:row.id,result}));
  }};
  let attachment;
  try {
    attachment=await attachComposerJournal({url,startCDPSession:async()=>channel} as unknown as BrowserTab,journal,()=>warnings++);
    const event=(origin:string,k:string,v:string,target='owned')=>receive({sessionId:target,method:'DOMStorage.domStorageItemAdded',params:{storageId:{securityOrigin:origin,isLocalStorage:true},key:k,newValue:v}});
    event('https://foreign.example',key,value);event(journal.origin,'urbauth-~let','secret');event(journal.origin,key,value,'foreign');assert.deepEqual(journal.entries(),[]);
    event(journal.origin,key,value);assert.deepEqual(journal.entries(),[[key,value]]);
    event(journal.origin,key,'invalid');assert.equal(warnings,1);assert.deepEqual(journal.entries(),[[key,value]]);
    assert.ok(methods.includes('Page.addScriptToEvaluateOnNewDocument'));
    receive({sessionId:'owned',method:'DOMStorage.domStorageItemRemoved',params:{storageId:{securityOrigin:journal.origin,isLocalStorage:true},key}});assert.deepEqual(journal.entries(),[]);
  }finally{attachment?.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
