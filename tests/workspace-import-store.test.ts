import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as http from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {WorkspaceImportStore, type WorkspaceImportPreview} from '../src/workspace-import-store';
import {ShipClient} from '../src/ship-client';
import {remoteSourceHash} from '../src/remote-project-view';
import type {CodingSnapshot, JsonObject} from '../src/protocol';
const context={owner:'~zod',project:'demo',session:'0x1'}, choice={note:'group-one',eid:'0v1',grant:'0x2'};
const source={id:'0x3',owner:'~zod',desk:'work',number:1,root:'0v4',commit:'0v5'};
function receipt(p: WorkspaceImportPreview): JsonObject {return {schema:'readymade-workspace-request-v1',owner:p.owner,requester:p.owner,nonce:p.nonce,requestDigest:p.requestDigest,binding:'0xa',generation:'1',authority:p.owner,project:'demo',noteHost:'~nec',note:p.note,session:p.session,nativeRequest:'0xb',text:p.text,message:{author:p.author,eid:p.eid,revision:p.revision,content:remoteSourceHash(p.text)},sourceDesk:p.sourceDesk,sourceRevision:p.sourceRevision,sourceRoot:p.sourceRoot,sourceCommit:p.sourceCommit,status:'reserved',evidence:null,retainedOnly:true,executionAuthorized:false,taskCompleted:false,mayResubmit:false,recoveryRequired:false};}
function fixture(t: {after(fn:()=>void):void}) {
  const directory=fs.mkdtempSync(join(tmpdir(),'readymade-import-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let live=true,owner='~zod',lost=false,replyPatch:JsonObject={},preview:WorkspaceImportPreview;
  const calls: string[]=[];
  const client={origin:'http://localhost:8080',snapshot:{ready:true,owner:'~zod',session:'0x1',sessions:[{id:'0x1',project:'demo',source}],projects:[],records:[]} as unknown as CodingSnapshot,
    browserCookies:()=>[{name:'urbauth-'+owner,value:'fixture'}], codingState:async()=>client.snapshot,
    workspaceImport:async(route:string,_headers:Record<string,string>,body?:JsonObject):Promise<JsonObject>=>{
      calls.push(route);
      if(route==='import-preview') {preview={schema:'readymade-workspace-import-preview-v1',owner:'~zod',nonce:body!.nonce as string,session:'0x1',...choice,previewDigest:'0x6',requestDigest:'0x7',author:'~nec',revision:'0',text:'Fix the full message.\nKeep source intact.',sourceDesk:'work',sourceRevision:'1',sourceRoot:'0v4',sourceCommit:'0v5',executionAuthorized:false};return {...preview,...replyPatch};}
      if(route==='import-confirm'){assert.ok(fs.readdirSync(directory).some(n=>n.endsWith('.json')),'intent precedes POST');if(lost)throw new Error('connection lost');return {...receipt(preview),...replyPatch};}
      if(route==='request')return {...receipt(preview),...replyPatch};
      if(route==='import-options')return {schema:'readymade-workspace-import-options-v1',owner:'~zod',session:'0x1',notes:[{id:'group-one',title:'Team'}],grants:[{id:'0x2',session:'0x1',label:'demo',operations:['read']}],executionAuthorized:false,...replyPatch};
      return {schema:'readymade-workspace-import-messages-v1',owner:'~zod',note:'group-one',catalog:'0x8',offset:0,total:1,next:null,messages:[{eid:'0v1',revision:'0',author:'~nec',text:'Excerpt'}],executionAuthorized:false,...replyPatch};
    }};
  const store=()=>new WorkspaceImportStore(directory,client,context,()=>live);
  return {directory,store,client,calls,setLive:(v:boolean)=>{live=v;},setOwner:(v:string)=>{owner=v;},setLost:()=>{lost=true;},patch:(v:JsonObject)=>{replyPatch=v;}};
}
test('canonical options and pages; no authority from malformed/duplicate pagination',async t=>{
  const f=fixture(t),s=f.store();assert.equal((await s.options()).notes[0].id,'group-one');assert.equal((await s.messages('group-one')).messages[0].text,'Excerpt');
  f.patch({next:0});await assert.rejects(s.messages('group-one'));f.patch({catalog:'0x9'});await assert.rejects(s.messages('group-one',0,'0x8'));
  await assert.rejects(s.messages('group-one',64));assert.equal(f.calls.filter(r=>r.includes('confirm')).length,0);
});
test('full preview, durable confirm, restart GET-only recovery, duplicate claim refused',async t=>{
  const f=fixture(t),s=f.store(),p=await s.preview(choice);assert.match(p.text,/Keep source/);await s.confirm(p);assert.equal(s.list()[0].events.at(-1)?.status,'observed');
  const restored=f.store();await restored.recover(p.nonce);await assert.rejects(restored.confirm(p));
  const again=await restored.preview(choice);await assert.rejects(restored.confirm(again));assert.equal(f.calls.filter(r=>r==='import-confirm').length,1);
});
test('lost confirmation never reposts; recovery mismatch preserved as error',async t=>{
  const f=fixture(t),s=f.store(),p=await s.preview(choice);f.setLost();await assert.rejects(s.confirm(p),/lost/);
  f.patch({project:'other'});await assert.rejects(f.store().recover(p.nonce));assert.equal(s.list()[0].events.filter(e=>e.status==='error').length,2);
  f.patch({});await f.store().recover(p.nonce);assert.equal(f.calls.filter(r=>r==='import-confirm').length,1);assert.match(s.list()[0].events[1].detail,/lost/);
});
test('wrong actor, changed source, altered preview and context drift prevent confirmation',async t=>{
  const f=fixture(t),s=f.store(),p=await s.preview(choice);await assert.rejects(s.confirm({...p,text:'changed'}));
  f.client.snapshot.sessions[0].source={...source,number:2};await assert.rejects(s.confirm(p));f.client.snapshot.sessions[0].source=source;
  f.setOwner('~nec');await assert.rejects(s.confirm(p));f.setOwner('~zod');f.setLive(false);await assert.rejects(s.confirm(p));assert.equal(f.calls.filter(r=>r==='import-confirm').length,0);
});
test('changed current session cannot be silently restored by preflight',async t=>{
  const f=fixture(t),s=f.store(),p=await s.preview(choice);f.client.snapshot.session='0x9';await assert.rejects(s.confirm(p));assert.equal(f.calls.filter(r=>r==='import-confirm').length,0);
});
test('complete message hash and source correlation required after confirmation',async t=>{
  const f=fixture(t),s=f.store(),p=await s.preview(choice);f.patch({message:{author:p.author,eid:p.eid,revision:p.revision,content:'0x1'}});await assert.rejects(s.confirm(p));assert.equal(s.list()[0].events.at(-1)?.status,'error');
});
test('real HTTP import transport fixes auth/origin/header/body and refuses replay/extra headers',async t=>{
  const captures:{url:string;headers:http.IncomingHttpHeaders;body:string}[]=[];
  const server=http.createServer((req,res)=>{const chunks:Buffer[]=[];req.on('data',(b:Buffer)=>chunks.push(b));req.on('end',()=>{captures.push({url:req.url!,headers:req.headers,body:Buffer.concat(chunks).toString()});if(req.url==='/~/login'){res.writeHead(200,{'set-cookie':'urbauth-~zod=fixture; Path=/'});res.end();return;}res.writeHead(200,{'content-type':'application/json'});res.end('{"okay":true}');});});
  server.listen(0,'127.0.0.1');await once(server,'listening');const client=new ShipClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,async()=> 'fixture');t.after(()=>{client.close();server.closeAllConnections();server.close();});await client.signIn();
  const body={schema:'readymade-workspace-import-v1',operation:'confirm',nonce:'11111111-1111-4111-8111-111111111111',session:'0x1',...choice,previewDigest:'0x6'};
  await client.workspaceImport('import-confirm',{},body);const c=captures.at(-1)!;assert.equal(c.headers.origin,client.origin);assert.equal(c.headers['x-readymade-workspace-import'],'v1');assert.match(c.headers.cookie!,/urbauth-~zod/);assert.deepEqual(JSON.parse(c.body),body);
  await assert.rejects(client.workspaceImport('import-confirm',{},body));await assert.rejects(client.workspaceImport('import-options',{'Cookie':'evil'}));assert.equal(captures.length,2);
});

test('two windows claim one immutable message once, retaining both outcome histories',async t=>{
  const f=fixture(t),a=f.store(),b=new WorkspaceImportStore(f.directory,f.client,{session:context.session,project:context.project,owner:context.owner}),pa=await a.preview(choice),pb=await b.preview(choice);
  // Fixture answers the last preview; keep this race focused on dispatch/claims.
  f.setLost();const outcomes=await Promise.allSettled([a.confirm(pa),b.confirm(pb)]);
  assert.equal(outcomes.filter(x=>x.status==='rejected').length,2);assert.equal(f.calls.filter(r=>r==='import-confirm').length,1);
  assert.equal(a.list().length,2);assert.ok(a.list().every(i=>i.events.some(e=>e.status==='error')));
});

test('canonical native IDs reject leading-zero aliases before dispatch',async t=>{
  const f=fixture(t),s=f.store();await assert.rejects(s.preview({...choice,eid:'0v01'}));await assert.rejects(s.preview({...choice,grant:'0x02'}));
  await assert.rejects(s.messages('group-one',0,'0x08'));assert.equal(f.calls.length,0);
  f.patch({previewDigest:'0x06'});await assert.rejects(s.preview(choice));assert.equal(f.calls.filter(r=>r==='import-confirm').length,0);
});
