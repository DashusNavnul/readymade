import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as http from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {workspaceReturnDocument} from '../src/workspace-return-preview';
import {ShipClient} from '../src/ship-client';
import {WorkspaceReturnStore, workspaceReturnPreview, type WorkspaceReturnPreview} from '../src/workspace-return-store';
import {remoteSourceHash} from '../src/remote-project-view';
import type {WorkspaceRequestDetail} from '../src/workspace-request-store';
import type {JsonObject} from '../src/protocol';
const nonce='11111111-1111-4111-8111-111111111111',summary='I checked the result.\nThe native receipt is below.';
const request={schema:'readymade-workspace-request-v1',owner:'~zod',requester:'~zod',nonce,project:'demo',session:'0x1',requestDigest:'0x2',nativeRequest:'0x3',evidence:'0x4',binding:'0x5',generation:'1',authority:'~zod',noteHost:'~zod',note:'team',text:'Original request',message:{author:'~per',eid:'0v6',revision:'0',content:remoteSourceHash('Original request')},sourceDesk:'work',sourceRevision:'1',sourceRoot:'0v7',sourceCommit:'0v8',status:'recorded',executionAuthorized:false,taskCompleted:false,recoveryRequired:false} as WorkspaceRequestDetail;
function preview():WorkspaceReturnPreview {const text='Owner-written summary:\n'+summary+'\nNative completion receipt: 0x9';return {schema:'readymade-workspace-return-v1',owner:'~zod',requester:'~zod',nonce,project:'demo',session:'0x1',requestDigest:'0x2',nativeRequest:'0x3',submissionEvidence:'0x4',sourceDesk:'work',sourceRevision:'1',sourceRoot:'0v7',sourceCommit:'0v8',noteHost:'~zod',note:'team',author:'~per',eid:'0v6',messageRevision:'0',instruction:'0x9',judgment:'0xa',evidence:['0xb'],membership:'0xc',audience:['~zod','~per'],summary,text,payloadDigest:remoteSourceHash(text),previewDigest:'0xd',status:'preview',postedEid:null,executionAuthorized:false};}
function fixture(t:{after(fn:()=>void):void}){
 const directory=fs.mkdtempSync(join(tmpdir(),'readymade-return-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));let active=true,lost=false,patch:JsonObject={};const calls:string[]=[];
 const client={origin:'http://localhost:8080',browserCookies:()=>[{name:'urbauth-~zod',value:'fixture'}],workspaceReturn:async(operation:'preview'|'confirm'|'result'):Promise<JsonObject>=>{calls.push(operation);if(operation==='confirm'){assert.ok(fs.readdirSync(directory).some(n=>n.endsWith('.json')));if(lost)throw Error('response lost');}return {...preview(),...(operation==='preview'?{}:{status:operation==='confirm'?'reserved':'posted',postedEid:operation==='confirm'?null:'0ve'}),...patch};}};
 return {client,directory,calls,store:()=>new WorkspaceReturnStore(directory,client,request,()=>active,1),patch:(p:JsonObject)=>{patch=p;},lost:()=>{lost=true;},inactive:()=>{active=false;}};
}
test('strict native preview binds original request, audience, summary and exact payload hash',()=>{
 assert.deepEqual(workspaceReturnPreview(preview(),request,summary,1),preview());
 for(const patch of [{evidence:Array(33).fill('0xb')},{project:'other'},{note:'other'},{noteHost:'~per'},{author:'~nec'},{messageRevision:'1'},{submissionEvidence:'0xf'},{audience:['~per']},{audience:['~zod','~zod']},{payloadDigest:'0xf'},{instruction:'0x09'},{status:'posted'},{text:'Forged native verdict'},{extra:true}])assert.throws(()=>workspaceReturnPreview({...preview(),...patch},request,summary,1));
});
test('reserved is not delivery; restart reads only and retains posted EID',async t=>{
 const f=fixture(t),s=f.store(),p=await s.preview(summary);const reordered=Object.fromEntries(Object.entries(p).reverse()) as unknown as WorkspaceReturnPreview;assert.equal((await s.confirm(reordered)).status,'reserved');const restored=f.store();assert.equal((await restored.recover()).postedEid,'0ve');
 await assert.rejects(restored.preview(summary));await assert.rejects(restored.confirm(p));assert.deepEqual(f.calls,['preview','confirm','result']);
 f.patch({postedEid:'0vf'});await assert.rejects(restored.recover());assert.equal(restored.intent()?.events.at(-1)?.status,'error');
});
test('lost share retains exact disclosure; missing or changed observation never permits repost',async t=>{
 const f=fixture(t),s=f.store(),p=await s.preview(summary);f.lost();await assert.rejects(s.confirm(p),/lost/);assert.deepEqual(f.store().intent()?.preview,p);
 f.patch({membership:'0xf'});await assert.rejects(f.store().recover());f.patch({});assert.equal((await f.store().recover()).status,'posted');assert.equal(f.calls.filter(x=>x==='confirm').length,1);assert.match(f.store().intent()!.events[1].detail,/lost/);
});
test('changed consent/context and remote-host/pending request refuse before publication',async t=>{
 const f=fixture(t),s=f.store(),p=await s.preview(summary);await assert.rejects(s.confirm({...p,summary:'changed'}));f.inactive();await assert.rejects(s.confirm(p));assert.equal(f.calls.filter(x=>x==='confirm').length,0);
 assert.throws(()=>new WorkspaceReturnStore(f.directory,f.client,{...request,noteHost:'~per'}));assert.throws(()=>new WorkspaceReturnStore(f.directory,f.client,{...request,status:'reserved'}));
});
test('two windows race one immutable native request with exclusive durable claim',async t=>{
 const f=fixture(t),a=f.store(),b=f.store(),pa=await a.preview(summary),pb=await b.preview(summary);const outcomes=await Promise.allSettled([a.confirm(pa),b.confirm(pb)]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.calls.filter(x=>x==='confirm').length,1);
});
test('real transport fixes routes/auth/CSRF and forbids repeated confirm or destination injection',async t=>{
 const captures:{route:string;method:string;headers:http.IncomingHttpHeaders;body:string}[]=[];let responseStatus=200,responseBody='{}';
 const server=http.createServer((req,res)=>{const chunks:Buffer[]=[];req.on('data',(b:Buffer)=>chunks.push(b));req.on('end',()=>{captures.push({route:req.url!,method:req.method!,headers:req.headers,body:Buffer.concat(chunks).toString()});if(req.url==='/~/login'){res.writeHead(200,{'set-cookie':'urbauth-~zod=fixture; Path=/'});res.end();return;}res.writeHead(responseStatus,{'content-type':'application/json'});res.end(responseBody);});});server.listen(0,'127.0.0.1');await once(server,'listening');
 const c=new ShipClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,async()=> 'fixture');t.after(()=>{c.close();server.closeAllConnections();server.close();});
 await assert.rejects(c.workspaceReturn('preview',{requester:'~zod',nonce,summary}));assert.equal(captures.length,0);await c.signIn();
 const params={requester:'~zod',nonce,summary,previewDigest:'0xd'};await c.workspaceReturn('confirm',params,1);const post=captures.at(-1)!;assert.equal(post.route,'/apps/readymade-collab/workspace-return-confirm');assert.equal(post.headers.origin,c.origin);assert.equal(post.headers['x-readymade-workspace-return'],'v1');assert.match(post.headers.cookie!,/urbauth-~zod/);assert.deepEqual(JSON.parse(post.body),{schema:'readymade-workspace-return-v1',operation:'confirm',...params});
 await assert.rejects(c.workspaceReturn('confirm',params,1));await assert.rejects(c.workspaceReturn('preview',{requester:'~zod',nonce,summary,note:'other'}));await c.workspaceReturn('result',{requester:'~zod',nonce},1);assert.equal(captures.at(-1)!.method,'GET');assert.equal(captures.at(-1)!.headers['x-readymade-workspace-nonce'],nonce);assert.equal(captures.length,3);
 const next={...params,nonce:'22222222-2222-4222-8222-222222222222'};await c.workspaceReturn('confirm',next);
 assert.equal(captures.at(-1)!.route,'/apps/readymade-collab/workspace-return-rich-confirm');assert.equal(captures.at(-1)!.headers['x-readymade-workspace-return'],'v2');assert.equal(JSON.parse(captures.at(-1)!.body).schema,'readymade-workspace-return-v2');
 await assert.rejects(c.workspaceReturn('confirm',next,1));await c.workspaceReturn('result',{requester:'~zod',nonce:next.nonce});assert.equal(captures.at(-1)!.route,'/apps/readymade-collab/workspace-return-rich-result');
 responseBody=JSON.stringify({padding:'x'.repeat(140000)});assert.equal(String((await c.workspaceReturn('result',{requester:'~zod',nonce:next.nonce})).padding).length,140000);
 await assert.rejects(c.workspaceReturn('result',{requester:'~zod',nonce},1));
 responseBody=JSON.stringify({padding:'x'.repeat(524288)});await assert.rejects(c.workspaceReturn('result',{requester:'~zod',nonce:next.nonce}));
 for(const status of [404,409]){responseStatus=status;responseBody=JSON.stringify({error:'unavailable'});const before:number=captures.length;await assert.rejects(c.workspaceReturn('preview',{requester:'~zod',nonce:next.nonce,summary}));assert.equal(captures.length,before+1);assert.equal(captures.at(-1)!.route,'/apps/readymade-collab/workspace-return-rich-preview');}
});

test('readable disclosure preserves exact Unicode message and separates summary from native evidence',()=>{
 const p={...preview(),summary:'Owner says: café 🪐\nSecond line',text:'Exact text\r\n**literal markup** 🪐\n'};
 const body=workspaceReturnDocument(p,request);
 assert.match(body,/Preview — nothing sent/);assert.match(body,/Conversation: team/);assert.match(body,/Audience \(2\): ~zod, ~per/);
 assert.ok(body.includes('ORIGINAL REQUEST\nOriginal request'));assert.ok(body.includes('OWNER-WRITTEN SUMMARY\n'+p.summary));
 assert.match(body,/Original source: %work · revision 1/);assert.match(body,/Completion judgment: 0xa/);assert.match(body,/Evidence references:\n  0xb/);
 assert.match(body,/not changed-file diffs or check reports/);assert.ok(body.endsWith(p.text));assert.equal(p.text,'Exact text\r\n**literal markup** 🪐\n');
 const pending=workspaceReturnDocument({...p,status:'reserved',postedEid:null},request);assert.match(pending,/Delivery unconfirmed/);assert.doesNotMatch(pending,/Posted message:/);
 const posted=workspaceReturnDocument({...p,status:'posted',postedEid:'0ve'},request);assert.match(posted,/canonical group message observed/);assert.match(posted,/Posted message: 0ve/);assert.ok(posted.endsWith(p.text));
});

function richPreview():WorkspaceReturnPreview {
 const p=preview(),source={owner:p.owner,desk:p.sourceDesk,revision:p.sourceRevision,root:p.sourceRoot,commit:p.sourceCommit},after={...source,revision:'2',root:'0v9',commit:'0va'};
 const report:NonNullable<WorkspaceReturnPreview['report']>={schema:'readymade-workspace-result-v1',owner:p.owner,requester:p.requester,nonce:p.nonce,project:p.project,session:p.session,requestDigest:p.requestDigest,nativeRequest:p.nativeRequest,instruction:p.instruction,judgment:p.judgment,status:'verified',source,resultSource:after,
 changes:[{candidate:'0x20',path:'/lib/test/hoon',kind:'modify',beforeSource:source,afterSource:after,beforeHash:'0x21',afterHash:'0x22',beforeText:'old\n',afterText:'new\n'}],checks:[{tool:'0x23',candidate:'0x20',diagnostic:{name:'compile',passed:false,detail:'Exact failed check',source:{...after,desk:'nc-20'},artifacts:[]}}],changesStatus:'changed',checksStatus:'recorded',evidence:p.evidence,resultDigest:'0x24',executionAuthorized:false,disclosureAuthorized:false};
 const text='Owner-written summary (not a native verdict):\n'+summary+'\nChanged files:\nold\nnew\nNative check verdict: FAIL\nExact failed check';
 return {...p,schema:'readymade-workspace-return-v2',report,text,payloadDigest:remoteSourceHash(text)};
}
test('v2 requires complete strictly correlated report and retains opaque Clay hashes',()=>{
 const p=richPreview();assert.deepEqual(workspaceReturnPreview(p,request,summary),p);assert.throws(()=>workspaceReturnPreview(preview(),request,summary));
 for(const patch of [{report:undefined},{instruction:'0xf'},{evidence:['0xf']},{report:{...p.report,project:'other'}},{report:{...p.report,source:{...p.report!.source,root:'0vb'}}},{report:{...p.report,changes:[],changesStatus:'none'}},{report:{...p.report,checksStatus:'none-performed'}}])assert.throws(()=>workspaceReturnPreview({...p,...patch},request,summary));
 const large=p.text+'x'.repeat(131072-Buffer.byteLength(p.text));assert.doesNotThrow(()=>workspaceReturnPreview({...p,text:large,payloadDigest:remoteSourceHash(large)},request,summary));assert.throws(()=>workspaceReturnPreview({...p,text:large+'x',payloadDigest:remoteSourceHash(large+'x')},request,summary));
 const body=workspaceReturnDocument(p,request);assert.match(body,/FULL NATIVE FILE AND CHECK REPORT/);assert.match(body,/modify \/lib\/test\/hoon/);assert.match(body,/FAIL compile/);assert.doesNotMatch(body,/not included in this message/);assert.ok(body.endsWith(p.text));
});
test('v2 lost or malformed delivery retains exclusive claim and recovery version across restart',async t=>{
 const f=fixture(t),calls:string[]=[];let malformed=true;
 const client={...f.client,workspaceReturn:async(op:'preview'|'confirm'|'result',_params:JsonObject,version:1|2=2):Promise<JsonObject>=>{calls.push(`${version}:${op}`);assert.equal(version,2);if(op==='confirm')assert.ok(fs.readdirSync(f.directory).some(n=>n.endsWith('.json')));const p=richPreview();return (op==='preview'?p:{...p,status:'posted',postedEid:'0ve',...(malformed?{report:{...p.report,judgment:'0xff'}}:{})}) as unknown as JsonObject;}};
 const s=new WorkspaceReturnStore(f.directory,client,request),p=await s.preview(summary);
 const changed=structuredClone(p);changed.report!.checks[0].diagnostic.detail='different';await assert.rejects(s.confirm(changed));assert.deepEqual(calls,['2:preview']);
 const reordered={...p,report:Object.fromEntries(Object.entries(p.report!).reverse())} as WorkspaceReturnPreview;
 reordered.report!.checks=reordered.report!.checks.map(c=>({...c,diagnostic:Object.fromEntries(Object.entries(c.diagnostic).reverse()) as typeof c.diagnostic}));
 await assert.rejects(s.confirm(reordered));assert.equal(s.intent()?.version,2);assert.equal(s.intent()?.events.at(-1)?.status,'error');
 const restored=new WorkspaceReturnStore(f.directory,client,request);await assert.rejects(restored.preview(summary));await assert.rejects(restored.confirm(p));await assert.rejects(restored.recover());malformed=false;assert.equal((await restored.recover()).status,'posted');assert.deepEqual(calls,['2:preview','2:confirm','2:result','2:result']);
 const legacy=new WorkspaceReturnStore(f.directory,client,request,()=>true,1);await assert.rejects(legacy.preview(summary));
});
test('default v2 store recovers old v1 claims GET-only and shares cross-version exclusive filename',async t=>{
 const f=fixture(t),legacy=f.store(),p=await legacy.preview(summary);await legacy.confirm(p);const calls:string[]=[];
 const client={...f.client,workspaceReturn:async(op:'preview'|'confirm'|'result',_params:JsonObject,version:1|2=2):Promise<JsonObject>=>{calls.push(`${version}:${op}`);assert.equal(op,'result');assert.equal(version,1);return {...preview(),status:'posted',postedEid:'0ve'};}};
 const modern=new WorkspaceReturnStore(f.directory,client,request);assert.equal(modern.intent()?.version,1);await assert.rejects(modern.preview(summary));assert.equal((await modern.recover()).status,'posted');assert.deepEqual(calls,['1:result']);assert.equal(fs.readdirSync(f.directory).filter(n=>n.endsWith('.json')).length,1);
});
test('v1 and v2 windows contend for the same durable claim before either confirm dispatch',async t=>{
 const f=fixture(t);let confirms=0;
 const client={...f.client,workspaceReturn:async(op:'preview'|'confirm'|'result',_params:JsonObject,version:1|2=2):Promise<JsonObject>=>{const p=version===1?preview():richPreview();if(op==='confirm')confirms++;return {...p,...(op==='preview'?{}:{status:'reserved',postedEid:null})} as unknown as JsonObject;}};
 const old=new WorkspaceReturnStore(f.directory,client,request,()=>true,1),modern=new WorkspaceReturnStore(f.directory,client,request),a=await old.preview(summary),b=await modern.preview(summary);
 const results=await Promise.allSettled([old.confirm(a),modern.confirm(b)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(confirms,1);assert.equal(fs.readdirSync(f.directory).filter(n=>n.endsWith('.json')).length,1);
});
test('claim serialization exactly at read ceiling recovers; one byte over refuses before claim or POST',async t=>{
 for(const excess of [0,1]){
  const f=fixture(t),p=richPreview();let confirms=0;
  const client={...f.client,workspaceReturn:async(op:'preview'|'confirm'|'result'):Promise<JsonObject>=>{if(op==='confirm')confirms++;return {...p,...(op==='preview'?{}:{status:'reserved',postedEid:null})} as unknown as JsonObject;}};
  const expanded={...request,padding:''};const size=Buffer.byteLength(JSON.stringify({version:2,origin:client.origin,request:expanded,preview:p}));expanded.padding='x'.repeat(1048576-size+excess);
  const store=new WorkspaceReturnStore(f.directory,client,expanded),observed=await store.preview(summary);
  if(excess){await assert.rejects(store.confirm(observed));assert.equal(confirms,0);assert.equal(fs.readdirSync(f.directory).filter(n=>n.endsWith('.json')).length,0);}
  else {await store.confirm(observed);assert.equal(confirms,1);assert.equal(new WorkspaceReturnStore(f.directory,client,expanded).intent()?.version,2);}
 }
});
