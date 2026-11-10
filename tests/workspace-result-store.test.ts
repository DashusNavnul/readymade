import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {ShipClient} from '../src/ship-client';
import {workspaceResult, WorkspaceResultStore, type WorkspaceResult} from '../src/workspace-result-store';
import {remoteSourceHash} from '../src/remote-project-view';
import type {WorkspaceRequestDetail} from '../src/workspace-request-store';
const nonce='11111111-1111-4111-8111-111111111111';
const request={owner:'~zod',requester:'~zod',nonce,project:'demo',session:'0x1',requestDigest:'0x2',nativeRequest:'0x3',evidence:'0x4',sourceDesk:'work',sourceRevision:'1',sourceRoot:'0v7',sourceCommit:'0v8',status:'recorded',executionAuthorized:false} as WorkspaceRequestDetail;
const source={owner:'~zod',desk:'work',revision:'1',root:'0v7',commit:'0v8'},after={...source,revision:'2',root:'0v9',commit:'0va'};
function report():WorkspaceResult{return {schema:'readymade-workspace-result-v1',owner:'~zod',requester:'~zod',nonce,project:'demo',session:'0x1',requestDigest:'0x2',nativeRequest:'0x3',instruction:'0x5',judgment:'0x6',status:'verified',source:{...source},resultSource:{...after},changes:[{candidate:'0x7',path:'/lib/demo/hoon',kind:'modify',beforeSource:{...source},afterSource:{...after},beforeHash:'0xc',afterHash:'0xd',beforeText:'old\n',afterText:'new 🪐\n'}],checks:[{tool:'0x8',candidate:'0x7',diagnostic:{name:'compile',passed:false,detail:'Exact native compiler error\n',source:{...after},artifacts:['0x9']}}],changesStatus:'changed',checksStatus:'recorded',evidence:['0xa'],resultDigest:'0xb',executionAuthorized:false,disclosureAuthorized:false};}
test('exact request report preserves diff bytes, failed checks and isolated returned data',()=>{const raw=report(),parsed=workspaceResult(raw,request);assert.deepEqual(parsed,raw);raw.changes[0].afterText='changed';assert.equal(parsed.changes[0].afterText,'new 🪐\n');assert.equal(parsed.checks[0].diagnostic.passed,false);});
test('cross-request/source, unknown fields, authority and malformed atoms refuse',()=>{
 for(const patch of [{owner:'~per'},{requester:'~per'},{nonce:'bad'},{project:'other'},{session:'0xf'},{requestDigest:'0xf'},{nativeRequest:'0xf'},{source:{...source,root:'0v1'}},{resultSource:source},{instruction:'0x05'},{judgment:'0x0'},{resultDigest:'0x'+'f'.repeat(65)},{executionAuthorized:true},{disclosureAuthorized:true},{status:'unavailable'},{extra:true},{evidence:['0x0a']},{changesStatus:'none'},{checksStatus:'none-performed'}])assert.throws(()=>workspaceResult({...report(),...patch},request));
});
test('hashes, byte bounds, path traversal, change shape and revision chain refuse',()=>{
 for(const patch of [{afterHash:'0x0f'},{beforeText:null},{afterText:'x'.repeat(32769),afterHash:remoteSourceHash('x'.repeat(32769))},{path:'/../secret'},{path:'/'+ 'a'.repeat(129)},{kind:'add'},{afterSource:{...after,revision:'1'}},{beforeSource:{...source,commit:'0vf'}}]){const r=report();Object.assign(r.changes[0],patch);assert.throws(()=>workspaceResult(r,request));}
 for(const field of ['root','commit'] as const){const r=report();r.changes[0].afterSource[field]='0v0';r.resultSource[field]='0v0';assert.throws(()=>workspaceResult(r,request));const d=report();d.checks[0].diagnostic.source[field]='0v0';assert.throws(()=>workspaceResult(d,request));}
 const duplicate=report();duplicate.changes.push({...duplicate.changes[0]});assert.throws(()=>workspaceResult(duplicate,request));
 const big=report();big.changes=Array(33).fill(big.changes[0]);assert.throws(()=>workspaceResult(big,request));
 const checks=report();checks.checks[0].diagnostic.source.owner='~per';assert.throws(()=>workspaceResult(checks,request));
 const nul=report();nul.checks[0].diagnostic.detail='bad\0';assert.throws(()=>workspaceResult(nul,request));
});
test('native revision steps and direct diagnostic attribution are exact; candidate staging remains supported',()=>{
 const expanded=report();expanded.evidence=Array(33).fill('0xa');expanded.checks[0].diagnostic.name='a'.repeat(129);assert.doesNotThrow(()=>workspaceResult(expanded,request));
 const gap=report();gap.changes[0].afterSource.revision='3';gap.resultSource.revision='3';assert.throws(()=>workspaceResult(gap,request));
 const staged=report();staged.checks[0].diagnostic.source.desk='nc-candidate';assert.equal(workspaceResult(staged,request).checks[0].diagnostic.source.desk,'nc-candidate');
 staged.checks[0].candidate=null;assert.throws(()=>workspaceResult(staged,request));staged.checks[0].diagnostic.source={...source};assert.equal(workspaceResult(staged,request).checks[0].candidate,null);
 staged.checks[0].diagnostic.detail='x'.repeat(32769);assert.doesNotThrow(()=>workspaceResult(staged,request));staged.checks[0].candidate='0x7';assert.throws(()=>workspaceResult(staged,request));
 const artifacts=report();artifacts.checks[0].diagnostic.artifacts=Array(5).fill('0x1');assert.throws(()=>workspaceResult(artifacts,request));
});
test('verified no changes/no checks differs from unavailable and accepts add/delete with exact nulls',()=>{
 const none={...report(),resultSource:{...source},changes:[],checks:[],changesStatus:'none',checksStatus:'none-performed'};assert.equal(workspaceResult(none,request).checks.length,0);assert.throws(()=>workspaceResult({status:'unavailable',reason:'missing'},request));
 for(const kind of ['add','delete'] as const){const r=report();r.changes[0].kind=kind;const side=kind==='add'?'before':'after';r.changes[0][side+'Hash' as 'beforeHash'|'afterHash']=null;r.changes[0][side+'Text' as 'beforeText'|'afterText']=null;assert.equal(workspaceResult(r,request).changes[0].kind,kind);}
});
test('store binds login/origin/context, clears stale success, and never writes',async()=>{
 let active=true,fail=false,calls=0;const client={origin:'http://localhost:8080',browserCookies:()=>[{name:'urbauth-~zod',value:'fixture'}],workspaceResult:async()=>{calls++;if(fail)throw Error('unavailable');return report() as unknown as import('../src/protocol').JsonObject;}};
 const store=new WorkspaceResultStore(client,request,()=>active);await store.read();const observed=store.observation!;observed.changes[0].afterText='mutated';assert.notEqual(store.observation!.changes[0].afterText,'mutated');active=false;assert.equal(store.observation,undefined);active=true;fail=true;await assert.rejects(store.read());assert.equal(store.observation,undefined);active=false;await assert.rejects(store.read());assert.equal(calls,2);
 let release!:()=>void;active=true;const deferred=new WorkspaceResultStore({...client,workspaceResult:async()=>{await new Promise<void>(r=>release=r);return report() as unknown as import('../src/protocol').JsonObject;}},request,()=>active);const pending=deferred.read();active=false;release();await assert.rejects(pending);assert.equal(deferred.observation,undefined);
});
test('fixed authenticated GET rejects foreign selectors, duplicate JSON and unavailable responses without retry',async t=>{
 let body=JSON.stringify(report()),status=200;const calls:{url:string;method:string;headers:http.IncomingHttpHeaders}[]=[];
 const server=http.createServer((req,res)=>{calls.push({url:req.url!,method:req.method!,headers:req.headers});if(req.url==='/~/login'){res.writeHead(200,{'set-cookie':'urbauth-~zod=fixture; Path=/'});res.end();return;}res.writeHead(status,{'content-type':'application/json'});res.end(body);});server.listen(0,'127.0.0.1');await once(server,'listening');const c=new ShipClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,async()=> 'fixture');t.after(()=>{c.close();server.closeAllConnections();server.close();});
 await assert.rejects(c.workspaceResult('~zod',nonce));assert.equal(calls.length,0);await c.signIn();await assert.rejects(c.workspaceResult('~per',nonce));await assert.rejects(c.workspaceResult('~zod',{toString:()=>nonce} as unknown as string));await assert.rejects(c.workspaceResult('~zod',nonce+'\r\n'));await c.workspaceResult('~zod',nonce);assert.equal(calls.at(-1)!.url,'/apps/readymade-collab/workspace-result');assert.equal(calls.at(-1)!.method,'GET');assert.equal(calls.at(-1)!.headers['x-readymade-workspace-nonce'],nonce);
 body='{"schema":"a","schema":"b"}';await assert.rejects(c.workspaceResult('~zod',nonce));status=503;body='{"status":"unavailable"}';await assert.rejects(c.workspaceResult('~zod',nonce));assert.equal(calls.length,4);status=200;body=JSON.stringify({text:'x'.repeat(524288)});await assert.rejects(c.workspaceResult('~zod',nonce));assert.equal(calls.length,5);
});
