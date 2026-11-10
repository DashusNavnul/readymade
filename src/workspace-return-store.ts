import * as fs from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {workspaceResult, type WorkspaceResult} from './workspace-result-store';
import {join} from 'node:path';
import {asRecord, validUnicode, type JsonObject} from './protocol';
import {digest, originOf} from './source-store';
import {remoteShip, remoteSourceHash} from './remote-project-view';
import type {ShipClient} from './ship-client';
import type {WorkspaceRequestDetail} from './workspace-request-store';

export interface WorkspaceReturnPreview {
  schema: 'readymade-workspace-return-v1'|'readymade-workspace-return-v2'; report?: WorkspaceResult; owner: string; requester: string; nonce: string; project: string; session: string;
  requestDigest: string; nativeRequest: string; submissionEvidence: string;
  sourceDesk: string; sourceRevision: string; sourceRoot: string; sourceCommit: string;
  noteHost: string; note: string; author: string; eid: string; messageRevision: string;
  instruction: string; judgment: string; evidence: string[]; membership: string; audience: string[];
  summary: string; text: string; payloadDigest: string; previewDigest: string;
  status: 'preview'; postedEid: null; executionAuthorized: false;
}
export type WorkspaceReturnReply = Omit<WorkspaceReturnPreview, 'status'|'postedEid'> & {status:'reserved'|'posted';postedEid:string|null};
export interface WorkspaceReturnIntent {version:1|2;origin:string;request:WorkspaceRequestDetail;preview:WorkspaceReturnPreview;events:{at:string;status:'claimed'|'reserved'|'posted'|'error';detail:string}[]}
type Client = Pick<ShipClient,'origin'|'browserCookies'|'workspaceReturn'>;
const claimLimit=(version:1|2)=>version===2?1048576:262144;
const keys=['schema','owner','requester','nonce','project','session','requestDigest','nativeRequest','submissionEvidence','sourceDesk','sourceRevision','sourceRoot','sourceCommit','noteHost','note','author','eid','messageRevision','instruction','judgment','evidence','membership','audience','summary','text','payloadDigest','previewDigest','status','postedEid','executionAuthorized'];
const ux=(v:unknown):v is string=>typeof v==='string'&&/^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(v)&&v.length<=81&&BigInt(v.replaceAll('.',''))<(1n<<256n);
const uv=(v:unknown):v is string=>typeof v==='string'&&/^0v(?:0|[1-9a-v][0-9a-v]{0,4}(?:\.[0-9a-v]{5})*)$/.test(v)&&v.length<=64&&[...v.slice(2).replaceAll('.','')].reduce((n,c)=>n*32n+BigInt(parseInt(c,32)),0n)<(1n<<256n);
const ud=(v:unknown):v is string=>typeof v==='string'&&/^(?:0|[1-9][0-9]{0,2}(?:\.[0-9]{3})*)$/.test(v)&&v.length<=26&&BigInt(v.replaceAll('.',''))<(1n<<64n);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&!!v&&validUnicode(v)&&!v.includes('\0')&&Buffer.byteLength(v)<=max;
function requireValue(ok:unknown):asserts ok {if(!ok)throw new Error('Invalid or changed native result-sharing evidence.');}
function binding(request:WorkspaceRequestDetail): string {return JSON.stringify([request.owner,request.requester,request.nonce,request.project,request.session,request.requestDigest,request.nativeRequest,request.evidence,request.noteHost,request.note,request.text,...['author','eid','revision','content'].map(k=>asRecord(request.message)[k]),request.sourceDesk,request.sourceRevision,request.sourceRoot,request.sourceCommit]);}
export function workspaceReturnPreview(value:unknown,request:WorkspaceRequestDetail,summary:string,version:1|2=2):WorkspaceReturnPreview {
  const p=asRecord(value),fields=version===2?[...keys,'report']:keys;requireValue(Object.keys(p).length===fields.length&&fields.every(k=>Object.hasOwn(p,k))&&Buffer.byteLength(JSON.stringify(p))<=(version===2?524288:131072));
  const m=asRecord(request.message);
  requireValue(p.schema===`readymade-workspace-return-v${version}`&&['owner','requester','nonce','project','session','requestDigest','nativeRequest','sourceDesk','sourceRevision','sourceRoot','sourceCommit','noteHost','note'].every(k=>p[k]===request[k])&&p.submissionEvidence===request.evidence&&p.noteHost===p.owner&&p.author===m.author&&p.eid===m.eid&&p.messageRevision===m.revision);
  requireValue([p.owner,p.requester,p.noteHost,p.author].every(remoteShip)&&uuid(p.nonce)&&[p.session,p.requestDigest,p.nativeRequest,p.submissionEvidence,p.instruction,p.judgment,p.membership,p.payloadDigest,p.previewDigest].every(ux)&&[p.sourceRoot,p.sourceCommit,p.eid].every(uv)&&ud(p.sourceRevision)&&p.sourceRevision!=='0'&&ud(p.messageRevision)&&text(p.project,128)&&text(p.note,128)&&typeof p.sourceDesk==='string'&&/^[a-z][a-z0-9-]{0,127}$/.test(p.sourceDesk));
  requireValue(Array.isArray(p.evidence)&&p.evidence.length>0&&p.evidence.length<=32&&p.evidence.every(ux)&&Array.isArray(p.audience)&&p.audience.length>0&&p.audience.length<=256&&p.audience.every(remoteShip)&&new Set(p.audience).size===p.audience.length&&p.audience.includes(request.owner));
  requireValue(text(summary,8192)&&p.summary===summary&&text(p.text,version===2?131072:65536)&&p.text.includes(version===2?'Owner-written summary (not a native verdict):':'Owner-written summary:')&&p.text.includes(summary)&&p.payloadDigest===remoteSourceHash(p.text)&&p.status==='preview'&&p.postedEid===null&&p.executionAuthorized===false);
  if(version===2){const report=workspaceResult(p.report,request);requireValue(report.instruction===p.instruction&&report.judgment===p.judgment&&isDeepStrictEqual(report.evidence,p.evidence));}
  return structuredClone(p) as unknown as WorkspaceReturnPreview;
}
/** A local disclosure claim never grants native publication or implies delivery. */
export class WorkspaceReturnStore {
  private readonly origin:string;
  private readonly request:WorkspaceRequestDetail;
  private held?:WorkspaceReturnPreview;
  private busy=false;
  constructor(private readonly directory:string,private readonly client:Client,request:WorkspaceRequestDetail,private readonly active:()=>boolean=()=>true,private readonly version:1|2=2){
    this.origin=originOf(client.origin);this.request=structuredClone(request);
    requireValue(remoteShip(request.owner)&&remoteShip(request.requester)&&uuid(request.nonce)&&ux(request.requestDigest)&&request.status==='recorded'&&ux(request.evidence)&&request.noteHost===request.owner&&request.executionAuthorized===false);
    const m=asRecord(request.message);requireValue(remoteShip(m.author)&&uv(m.eid)&&ud(m.revision));
  }
  private guard():void{requireValue(this.active()&&this.client.origin===this.origin);const cookies=this.client.browserCookies(this.origin).filter(c=>c.name.startsWith('urbauth-'));requireValue(cookies.length===1&&cookies[0].name==='urbauth-'+this.request.owner);}
  private dir():void{fs.mkdirSync(this.directory,{recursive:true,mode:0o700});const st=fs.lstatSync(this.directory);requireValue(st.isDirectory()&&!st.isSymbolicLink()&&!(st.mode&0o077)&&(!process.getuid||st.uid===process.getuid()));}
  private file():string{return join(this.directory,digest(JSON.stringify([this.origin,this.request.owner,this.request.requester,this.request.nonce]))+'.json');}
  private sync():void{const fd=fs.openSync(this.directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  private readFile(file:string,max:number):string{const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);requireValue(st.isFile()&&!(st.mode&0o077)&&st.size<=max&&(!process.getuid||st.uid===process.getuid()));return fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}}
  intent():WorkspaceReturnIntent|undefined{
    this.dir();if(!fs.existsSync(this.file()))return;const rawClaim=this.readFile(this.file(),claimLimit(2)),row=asRecord(JSON.parse(rawClaim));requireValue((row.version===1||row.version===2)&&Buffer.byteLength(rawClaim)<=claimLimit(row.version as 1|2)&&row.origin===this.origin&&binding(asRecord(row.request) as WorkspaceRequestDetail)===binding(this.request));
    const raw=asRecord(row.preview),preview=workspaceReturnPreview(raw,this.request,String(raw.summary),row.version as 1|2),log=this.file()+'.events';
    const events:WorkspaceReturnIntent['events']=fs.existsSync(log)?this.readFile(log,262144).trim().split('\n').filter(Boolean).map(line=>{const e=asRecord(JSON.parse(line));requireValue(typeof e.at==='string'&&['claimed','reserved','posted','error'].includes(String(e.status))&&typeof e.detail==='string');return e as unknown as WorkspaceReturnIntent['events'][number];}):[];
    return {version:row.version as 1|2,origin:this.origin,request:structuredClone(this.request),preview,events};
  }
  private event(status:WorkspaceReturnIntent['events'][number]['status'],detail:string):void{
    const fd=fs.openSync(this.file()+'.events',fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW,0o600);
    try{const st=fs.fstatSync(fd);requireValue(st.isFile()&&!(st.mode&0o077)&&st.size<250000&&(!process.getuid||st.uid===process.getuid()));fs.writeFileSync(fd,JSON.stringify({at:new Date().toISOString(),status,detail:detail.slice(0,2048)})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}this.sync();
  }
  private async call(operation:'preview'|'confirm'|'result',summary?:string,previewDigest?:string,version:1|2=this.version):Promise<JsonObject>{this.guard();const value=await this.client.workspaceReturn(operation,{requester:this.request.requester,nonce:this.request.nonce,...(summary===undefined?{}:{summary}),...(previewDigest===undefined?{}:{previewDigest})},version);this.guard();return value;}
  async preview(summary:string):Promise<WorkspaceReturnPreview>{requireValue(!this.busy&&text(summary,8192));this.busy=true;try{this.held=undefined;requireValue(!this.intent());const p=workspaceReturnPreview(await this.call('preview',summary),this.request,summary,this.version);this.held=p;return structuredClone(p);}finally{this.busy=false;}}
  private reply(value:unknown,p:WorkspaceReturnPreview):WorkspaceReturnReply{
    const r=asRecord(value);requireValue(r.status==='reserved'&&r.postedEid===null||r.status==='posted'&&uv(r.postedEid));
    const normalized=workspaceReturnPreview({...r,status:'preview',postedEid:null},this.request,p.summary,p.schema==='readymade-workspace-return-v2'?2:1);requireValue(isDeepStrictEqual(normalized,p));
    const posted=this.intent()?.events.find(e=>e.status==='posted');requireValue(!posted||r.status==='posted'&&r.postedEid===posted.detail);
    return structuredClone(r) as unknown as WorkspaceReturnReply;
  }
  async confirm(value:WorkspaceReturnPreview):Promise<WorkspaceReturnReply>{
    requireValue(!this.busy);this.busy=true;try{this.guard();const p=workspaceReturnPreview(value,this.request,value.summary,this.version);requireValue(this.held&&isDeepStrictEqual(this.held,p));this.dir();requireValue(fs.readdirSync(this.directory).filter(n=>n.endsWith('.json')).length<512);
      const claim=JSON.stringify({version:this.version,origin:this.origin,request:this.request,preview:p});requireValue(Buffer.byteLength(claim)<=claimLimit(this.version));
      const fd=fs.openSync(this.file(),'wx',0o600);try{fs.writeFileSync(fd,claim);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}this.sync();this.event('claimed','Share claimed before dispatch; observe this request only.');
      try{const r=this.reply(await this.call('confirm',p.summary,p.previewDigest),p);this.event(r.status,r.postedEid??'Delivery unconfirmed; do not resend.');return r;}catch(error){this.event('error',error instanceof Error?error.message:'Unknown publication outcome.');throw error;}
    }finally{this.busy=false;}
  }
  async recover():Promise<WorkspaceReturnReply>{requireValue(!this.busy);this.busy=true;try{this.guard();const saved=this.intent();requireValue(saved);try{const r=this.reply(await this.call('result',undefined,undefined,saved.version),saved.preview);this.event(r.status,r.postedEid??'Delivery unconfirmed; do not resend.');return r;}catch(error){this.event('error',error instanceof Error?error.message:'Observation unavailable.');throw error;}}finally{this.busy=false;}}
}
