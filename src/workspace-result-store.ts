import {asRecord, validUnicode, type JsonObject} from './protocol';
import {originOf, validPath} from './source-store';
import {remoteShip} from './remote-project-view';
import type {ShipClient} from './ship-client';
import type {WorkspaceRequestDetail} from './workspace-request-store';

export interface WorkspaceResultSource {owner:string;desk:string;revision:string;root:string;commit:string}
export interface WorkspaceResultChange {candidate:string;path:string;kind:'add'|'modify'|'delete';beforeSource:WorkspaceResultSource;afterSource:WorkspaceResultSource;beforeHash:string|null;afterHash:string|null;beforeText:string|null;afterText:string|null}
export interface WorkspaceResultCheck {tool:string;candidate:string|null;diagnostic:{name:string;passed:boolean;detail:string;source:WorkspaceResultSource;artifacts:string[]}}
export interface WorkspaceResult {
  schema:'readymade-workspace-result-v1';owner:string;requester:string;nonce:string;project:string;session:string;
  requestDigest:string;nativeRequest:string;instruction:string;judgment:string;status:'verified';
  source:WorkspaceResultSource;resultSource:WorkspaceResultSource;changes:WorkspaceResultChange[];checks:WorkspaceResultCheck[];
  changesStatus:'none'|'changed';checksStatus:'none-performed'|'recorded';evidence:string[];resultDigest:string;
  executionAuthorized:false;disclosureAuthorized:false;
}
const keys=['schema','owner','requester','nonce','project','session','requestDigest','nativeRequest','instruction','judgment','status','source','resultSource','changes','checks','changesStatus','checksStatus','evidence','resultDigest','executionAuthorized','disclosureAuthorized'];
function requireValue(ok:unknown):asserts ok {if(!ok)throw new Error('Native workspace result is unavailable, malformed, or belongs to another request.');}
const ux=(v:unknown):v is string=>typeof v==='string'&&/^0x(?:0|[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*)$/.test(v)&&v.length<=81&&BigInt(v.replaceAll('.',''))<(1n<<256n);
const id=(v:unknown):v is string=>ux(v)&&v!=='0x0';
const uv=(v:unknown):v is string=>typeof v==='string'&&/^0v(?:0|[1-9a-v][0-9a-v]{0,4}(?:\.[0-9a-v]{5})*)$/.test(v)&&v.length<=64&&[...v.slice(2).replaceAll('.','')].reduce((n,c)=>n*32n+BigInt(parseInt(c,32)),0n)<(1n<<256n);
const ud=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,2}(?:\.[0-9]{3})*$/.test(v)&&v.length<=26&&BigInt(v.replaceAll('.',''))<(1n<<64n);
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&validUnicode(v)&&!v.includes('\0')&&Buffer.byteLength(v)<=max;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
function exact(v:unknown,fields:string[]):JsonObject {const r=asRecord(v);requireValue(Object.keys(r).length===fields.length&&fields.every(k=>Object.hasOwn(r,k)));return r;}
function source(v:unknown):WorkspaceResultSource {const r=exact(v,['owner','desk','revision','root','commit']);requireValue(remoteShip(r.owner)&&typeof r.desk==='string'&&/^[a-z][a-z0-9-]{0,127}$/.test(r.desk)&&ud(r.revision)&&uv(r.root)&&r.root!=='0v0'&&uv(r.commit)&&r.commit!=='0v0');return r as unknown as WorkspaceResultSource;}
const sameSource=(a:WorkspaceResultSource,b:WorkspaceResultSource)=>['owner','desk','revision','root','commit'].every(k=>a[k as keyof WorkspaceResultSource]===b[k as keyof WorkspaceResultSource]);
function requestSource(r:WorkspaceRequestDetail):WorkspaceResultSource {requireValue(remoteShip(r.owner)&&r.requester===r.owner&&uuid(r.nonce)&&text(r.project,128)&&!!r.project&&[r.session,r.requestDigest,r.nativeRequest,r.evidence].every(id)&&r.status==='recorded'&&r.executionAuthorized===false);return source({owner:r.owner,desk:r.sourceDesk,revision:r.sourceRevision,root:r.sourceRoot,commit:r.sourceCommit});}
/** Native receipt and Clay page hashes are opaque; authenticated native joins bind the retained text. */
export function workspaceResult(value:unknown,request:WorkspaceRequestDetail):WorkspaceResult {
  const original=requestSource(request),r=exact(value,keys);requireValue(Buffer.byteLength(JSON.stringify(r))<=524288);
  requireValue(r.schema==='readymade-workspace-result-v1'&&r.status==='verified'&&r.executionAuthorized===false&&r.disclosureAuthorized===false&&['owner','requester','nonce','project','session','requestDigest','nativeRequest'].every(k=>r[k]===request[k])&&[r.instruction,r.judgment,r.resultDigest].every(id));
  const before=source(r.source),after=source(r.resultSource);requireValue(sameSource(before,original)&&after.owner===before.owner&&after.desk===before.desk);
  requireValue(Array.isArray(r.changes)&&r.changes.length<=32&&Array.isArray(r.checks)&&r.checks.length<=64&&Array.isArray(r.evidence)&&r.evidence.length>0&&r.evidence.every(id));
  let bytes=0,current=before,lastCandidate:string|undefined;const seen=new Set<string>(),groups=new Map<string,{before:WorkspaceResultSource;after:WorkspaceResultSource}>();
  for(const item of r.changes){
    const c=exact(item,['candidate','path','kind','beforeSource','afterSource','beforeHash','afterHash','beforeText','afterText']);requireValue(id(c.candidate)&&typeof c.path==='string'&&validPath(c.path)&&c.path.split('/').slice(1).every(p=>p.length<=128)&&['add','modify','delete'].includes(String(c.kind)));
    const a=source(c.beforeSource),b=source(c.afterSource);requireValue(a.owner===original.owner&&b.owner===original.owner&&a.desk===original.desk&&b.desk===original.desk&&BigInt(b.revision.replaceAll('.',''))===BigInt(a.revision.replaceAll('.',''))+1n);
    const prior=groups.get(c.candidate);if(prior){requireValue(lastCandidate===c.candidate&&sameSource(prior.before,a)&&sameSource(prior.after,b));}else{requireValue(sameSource(current,a));groups.set(c.candidate,{before:a,after:b});current=b;lastCandidate=c.candidate;}
    const key=c.candidate+'\n'+c.path;requireValue(!seen.has(key));seen.add(key);
    for(const side of ['before','after']){const h=c[side+'Hash'],t=c[side+'Text'];requireValue(h===null?t===null:ux(h)&&text(t,32768));if(typeof t==='string')bytes+=Buffer.byteLength(t);}
    requireValue(c.kind==='add'?c.beforeHash===null&&c.afterHash!==null:c.kind==='delete'?c.beforeHash!==null&&c.afterHash===null:c.beforeHash!==null&&c.afterHash!==null&&c.beforeHash!==c.afterHash);
  }
  requireValue(bytes<=65536&&sameSource(current,after)&&r.changesStatus===(r.changes.length?'changed':'none')&&r.checksStatus===(r.checks.length?'recorded':'none-performed'));
  for(const item of r.checks){const c=exact(item,['tool','candidate','diagnostic']),d=exact(c.diagnostic,['name','passed','detail','source','artifacts']);requireValue(id(c.tool)&&(c.candidate===null||id(c.candidate))&&typeof d.name==='string'&&/^[a-z][a-z0-9-]*$/.test(d.name)&&typeof d.passed==='boolean'&&text(d.detail,524288)&&Array.isArray(d.artifacts)&&d.artifacts.every(ux));const diagnosticSource=source(d.source);requireValue(diagnosticSource.owner===request.owner);if(c.candidate===null)requireValue([before,...[...groups.values()].map(g=>g.after)].some(s=>sameSource(s,diagnosticSource)));else requireValue(text(d.detail,32768)&&d.artifacts.length<=4);}
  return structuredClone(r) as unknown as WorkspaceResult;
}
/** Read-only observation; stale or unavailable reads never become a verified empty report. */
export class WorkspaceResultStore {
  private readonly origin:string;private readonly request:WorkspaceRequestDetail;private held?:WorkspaceResult;private busy=false;
  constructor(private readonly client:Pick<ShipClient,'origin'|'browserCookies'|'workspaceResult'>,request:WorkspaceRequestDetail,private readonly active:()=>boolean=()=>true){this.origin=originOf(client.origin);requestSource(request);this.request=structuredClone(request);}
  private guard():void{const cookies=this.client.browserCookies(this.origin).filter(c=>c.name.startsWith('urbauth-'));requireValue(this.active()&&this.client.origin===this.origin&&cookies.length===1&&cookies[0].name==='urbauth-'+this.request.owner);}
  get observation():WorkspaceResult|undefined{try{this.guard();return this.held&&structuredClone(this.held);}catch{this.held=undefined;return undefined;}}
  async read():Promise<WorkspaceResult>{requireValue(!this.busy);this.busy=true;this.held=undefined;try{this.guard();const value=await this.client.workspaceResult(this.request.requester,this.request.nonce);this.guard();const report=workspaceResult(value,this.request);this.held=report;return structuredClone(report);}finally{this.busy=false;}}
}
