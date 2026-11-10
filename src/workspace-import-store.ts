import * as fs from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {asRecord, isInteger, isUv, isUx, validUnicode, type JsonObject} from './protocol';
import {digest, originOf, sourceBasis, type SourceBasis} from './source-store';
import {remoteShip, remoteSourceHash} from './remote-project-view';
import type {ShipClient} from './ship-client';
import type {WorkspaceRequestDetail} from './workspace-request-store';

export interface WorkspaceImportContext {owner: string; project: string; session: string}
export interface WorkspaceImportChoice {note: string; eid: string; grant: string}
export interface WorkspaceImportPreview extends WorkspaceImportChoice {
  schema: 'readymade-workspace-import-preview-v1'; owner: string; nonce: string; session: string;
  previewDigest: string; requestDigest: string; author: string; revision: string; text: string;
  sourceDesk: string; sourceRevision: string; sourceRoot: string; sourceCommit: string; executionAuthorized: false;
}
export interface WorkspaceImportOptions {notes: {id: string; title: string}[]; grants: {id: string; session: string; label: string; operations: string[]}[]}
export interface WorkspaceImportMessages {catalog: string; offset: number; total: number; next: number | null; messages: {eid: string; revision: string; author: string; text: string}[]}
export interface WorkspaceImportIntent {version: 1; origin: string; context: WorkspaceImportContext; preview: WorkspaceImportPreview; events: {at: string; status: 'claimed' | 'observed' | 'error'; detail: string}[]}
type Client = Pick<ShipClient, 'origin' | 'browserCookies' | 'codingState' | 'snapshot' | 'workspaceImport'>;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const ux = (v: unknown): v is string => isUx(v) && /^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(v) && BigInt(v.replaceAll('.', '')) < 1n << 256n;
const uv = (v: unknown): v is string => isUv(v) && /^0v(?:0|[1-9a-v][0-9a-v]{0,4}(?:\.[0-9a-v]{5})*)$/.test(v) && v.length <= 64 && [...v.slice(2).replaceAll('.', '')].reduce((n, c) => n * 32n + BigInt(parseInt(c, 32)), 0n) < 1n << 256n;
const ud = (v: unknown): v is string => typeof v === 'string' && /^(?:0|[1-9][0-9]{0,2}(?:\.[0-9]{3})*)$/.test(v) && v.length <= 26 && BigInt(v.replaceAll('.', '')) < 1n << 64n;
const text = (v: unknown, max: number, empty = false): v is string => typeof v === 'string' && (empty || !!v) && validUnicode(v) && !/[\0\r\n]/.test(v) && Buffer.byteLength(v) <= max;
const bodyText = (v: unknown): v is string => typeof v === 'string' && !!v && validUnicode(v) && !v.includes('\0') && Buffer.byteLength(v) <= 16384;
function requireValue(ok: unknown): asserts ok {if (!ok) throw new Error('Invalid or changed native shared-message import.');}
function exact(value: unknown, keys: string[], max = 65536): JsonObject {
  const row = asRecord(value); requireValue(Buffer.byteLength(JSON.stringify(row)) <= max && Object.keys(row).length === keys.length && keys.every(k => Object.hasOwn(row, k))); return row;
}
function previewValue(value: unknown): WorkspaceImportPreview {
  const p = exact(value, ['schema','owner','nonce','session','note','eid','grant','previewDigest','requestDigest','author','revision','text','sourceDesk','sourceRevision','sourceRoot','sourceCommit','executionAuthorized']);
  requireValue(p.schema === 'readymade-workspace-import-preview-v1' && remoteShip(p.owner) && uuid(p.nonce) && ux(p.session) && text(p.note,128) && uv(p.eid) && [p.grant,p.previewDigest,p.requestDigest].every(ux) && remoteShip(p.author) && ud(p.revision) && bodyText(p.text) && typeof p.sourceDesk === 'string' && /^[a-z][a-z0-9-]{0,127}$/.test(p.sourceDesk) && ud(p.sourceRevision) && p.sourceRevision !== '0' && uv(p.sourceRoot) && uv(p.sourceCommit) && p.executionAuthorized === false);
  return structuredClone(p) as unknown as WorkspaceImportPreview;
}
function sourceMatches(p: WorkspaceImportPreview, source: SourceBasis): boolean {return p.owner === source.owner && p.sourceDesk === source.desk && p.sourceRevision.replaceAll('.', '') === String(source.number) && p.sourceRoot === source.root && p.sourceCommit === source.commit;}

/** Owner import only. Confirmation retains a request; it never dispatches coding. */
export class WorkspaceImportStore {
  private readonly origin: string;
  private readonly context: WorkspaceImportContext;
  private readonly previews = new Map<string, WorkspaceImportPreview>();
  private busy = false;
  constructor(private readonly directory: string, private readonly client: Client, context: WorkspaceImportContext, private readonly active: () => boolean = () => true) {
    this.origin = originOf(client.origin); this.context = {owner: context.owner, project: context.project, session: context.session};
    requireValue(remoteShip(context.owner) && text(context.project,128) && ux(context.session));
  }
  private identity(): void {
    requireValue(this.active() && this.client.origin === this.origin);
    const cookies = this.client.browserCookies(this.origin).filter(c => c.name.startsWith('urbauth-'));
    requireValue(cookies.length === 1 && cookies[0].name === 'urbauth-' + this.context.owner);
  }
  private source(): SourceBasis {
    this.identity(); const state = this.client.snapshot, c = this.context;
    requireValue(state && state.ready && state.owner === c.owner && state.session === c.session);
    const rows = state.sessions.filter(s => s.id === c.session); requireValue(rows.length === 1 && rows[0].project === c.project);
    const source = sourceBasis(rows[0].source); requireValue(source.owner === c.owner); return source;
  }
  private async fresh(): Promise<SourceBasis> {this.source(); await this.client.codingState(this.context.session); return this.source();}
  private async request(route: string, headers: Record<string,string> = {}, body?: JsonObject): Promise<JsonObject> {
    this.identity(); const value = await this.client.workspaceImport(route, headers, body); this.identity(); return value;
  }
  async options(): Promise<WorkspaceImportOptions> {
    this.source(); const v = exact(await this.request('import-options', {'x-readymade-import-session': this.context.session}), ['schema','owner','session','notes','grants','executionAuthorized']); this.source();
    requireValue(v.schema === 'readymade-workspace-import-options-v1' && v.owner === this.context.owner && v.session === this.context.session && v.executionAuthorized === false && Array.isArray(v.notes) && v.notes.length <= 64 && Array.isArray(v.grants) && v.grants.length <= 64);
    const notes = v.notes.map(raw => {const n = exact(raw,['id','title']); requireValue(text(n.id,128) && text(n.title,256,true)); return {id:n.id,title:n.title};});
    const grants = v.grants.map(raw => {const g = exact(raw,['id','session','label','operations']); requireValue(ux(g.id) && g.session === this.context.session && text(g.label,128) && Array.isArray(g.operations) && g.operations.length <= 16 && g.operations.every(op => typeof op === 'string' && /^[a-z-]{1,32}$/.test(op))); return {id:g.id,session:g.session,label:g.label,operations:g.operations as string[]};});
    requireValue(new Set(notes.map(n=>n.id)).size === notes.length && new Set(grants.map(g=>g.id)).size === grants.length); return {notes,grants};
  }
  async messages(note: string, offset = 0, catalog?: string): Promise<WorkspaceImportMessages> {
    this.source(); requireValue(text(note,128) && isInteger(offset,0,4095) && (catalog === undefined ? offset === 0 : ux(catalog)));
    const v = exact(await this.request('import-messages', {'x-readymade-import-note': Buffer.from(note).toString('latin1'), 'x-readymade-import-offset': String(offset), ...(catalog ? {'x-readymade-import-catalog':catalog} : {})}), ['schema','owner','note','catalog','offset','total','next','messages','executionAuthorized']); this.source();
    requireValue(v.schema === 'readymade-workspace-import-messages-v1' && v.owner === this.context.owner && v.note === note && ux(v.catalog) && (!catalog || v.catalog === catalog) && v.offset === offset && isInteger(v.total,0,4096) && Array.isArray(v.messages) && v.messages.length <= 64 && v.executionAuthorized === false);
    const messages = v.messages.map(raw => {const m = exact(raw,['eid','revision','author','text']); requireValue(uv(m.eid) && ud(m.revision) && remoteShip(m.author) && bodyText(m.text)); return {eid:m.eid,revision:m.revision,author:m.author,text:m.text};});
    const end = offset + messages.length; requireValue(end <= v.total && (v.next === null ? end === v.total : v.next === end && end > offset && end < v.total) && new Set(messages.map(m=>m.eid)).size === messages.length);
    return {catalog:v.catalog,offset,total:v.total,next:v.next as number|null,messages};
  }
  async preview(choice: WorkspaceImportChoice): Promise<WorkspaceImportPreview> {
    requireValue(!this.busy && text(choice.note,128) && uv(choice.eid) && ux(choice.grant) && this.previews.size < 64); this.busy = true;
    try {
      const source = await this.fresh(), nonce = randomUUID();
      const p = previewValue(await this.request('import-preview', {}, {schema:'readymade-workspace-import-v1',operation:'preview',nonce,session:this.context.session,...choice}));
      requireValue(p.owner === this.context.owner && p.session === this.context.session && p.nonce === nonce && p.note === choice.note && p.eid === choice.eid && p.grant === choice.grant && sourceMatches(p,source) && sourceMatches(p,this.source()));
      this.previews.set(nonce,p); return structuredClone(p);
    } finally {this.busy=false;}
  }
  private dir(): void {
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700}); const st=fs.lstatSync(this.directory);
    requireValue(st.isDirectory() && !st.isSymbolicLink() && !(st.mode & 0o077) && (!process.getuid || st.uid === process.getuid()));
  }
  private file(nonce: string): string {requireValue(uuid(nonce)); return join(this.directory,digest(JSON.stringify([this.origin,this.context.owner,nonce]))+'.json');}
  private syncDirectory(): void {const fd=fs.openSync(this.directory,fs.constants.O_RDONLY); try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  private read(nonce: string): WorkspaceImportIntent {
    this.dir(); const path=this.file(nonce), st=fs.lstatSync(path); requireValue(st.isFile() && !st.isSymbolicLink() && !(st.mode & 0o077) && st.size <= 65536 && (!process.getuid || st.uid===process.getuid()));
    const v=asRecord(JSON.parse(fs.readFileSync(path,'utf8'))), p=previewValue(v.preview); requireValue(v.version===1 && v.origin===this.origin && JSON.stringify(v.context)===JSON.stringify(this.context) && p.nonce===nonce && p.owner===this.context.owner && p.session===this.context.session);
    const log=path+'.events'; let events: WorkspaceImportIntent['events']=[];
    if(fs.existsSync(log)){const ls=fs.lstatSync(log);requireValue(ls.isFile()&&!ls.isSymbolicLink()&&!(ls.mode&0o077)&&ls.size<=262144);events=fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line=>{const e=asRecord(JSON.parse(line));requireValue(typeof e.at==='string'&&['claimed','observed','error'].includes(String(e.status))&&typeof e.detail==='string');return e as unknown as WorkspaceImportIntent['events'][number];});}
    return {version:1,origin:this.origin,context:structuredClone(this.context),preview:p,events};
  }
  private event(nonce: string,status: 'claimed'|'observed'|'error',detail: string): void {
    const file=this.file(nonce)+'.events';const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW,0o600);
    try{const st=fs.fstatSync(fd);requireValue(st.isFile()&&!(st.mode&0o077)&&st.size<250000);fs.writeFileSync(fd,JSON.stringify({at:new Date().toISOString(),status,detail:detail.slice(0,2048)})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);} this.syncDirectory();
  }
  list(): WorkspaceImportIntent[] {
    this.dir(); const files=fs.readdirSync(this.directory).filter(n=>/^[0-9a-f]{64}\.json$/.test(n));requireValue(files.length<=512);
    return files.flatMap(name=>{const st=fs.lstatSync(join(this.directory,name));requireValue(st.isFile()&&!st.isSymbolicLink()&&st.size<=65536);const v=asRecord(JSON.parse(fs.readFileSync(join(this.directory,name),'utf8')));return v.origin===this.origin&&JSON.stringify(v.context)===JSON.stringify(this.context)?[this.read(previewValue(v.preview).nonce)]:[];});
  }
  private receipt(value: unknown,p: WorkspaceImportPreview): WorkspaceRequestDetail {
    const r=exact(value,['schema','owner','requester','nonce','requestDigest','binding','generation','authority','project','noteHost','note','session','nativeRequest','text','message','sourceDesk','sourceRevision','sourceRoot','sourceCommit','status','evidence','retainedOnly','executionAuthorized','taskCompleted','mayResubmit','recoveryRequired']);
    const m=exact(r.message,['author','eid','revision','content']);
    requireValue(r.schema==='readymade-workspace-request-v1'&&r.owner===p.owner&&r.requester===p.owner&&r.authority===p.owner&&r.project===this.context.project&&r.nonce===p.nonce&&r.requestDigest===p.requestDigest&&r.session===p.session&&r.note===p.note&&r.text===p.text&&['sourceDesk','sourceRevision','sourceRoot','sourceCommit'].every(k=>r[k]===p[k as keyof WorkspaceImportPreview])&&m.author===p.author&&m.eid===p.eid&&m.revision===p.revision&&m.content===remoteSourceHash(p.text)&&ux(r.binding)&&ux(r.nativeRequest)&&ud(r.generation)&&r.generation!=='0'&&remoteShip(r.noteHost)&&['reserved','submitted','unknown','recorded','refused'].includes(String(r.status))&&r.retainedOnly===true&&r.executionAuthorized===false&&r.taskCompleted===false&&r.mayResubmit===false&&r.recoveryRequired===['submitted','unknown'].includes(String(r.status))&&(['recorded','refused'].includes(String(r.status))?ux(r.evidence):r.evidence===null));
    return structuredClone(r) as WorkspaceRequestDetail;
  }
  async confirm(value: WorkspaceImportPreview): Promise<WorkspaceRequestDetail> {
    requireValue(!this.busy);this.busy=true;
    try {
      const p=previewValue(value);requireValue(JSON.stringify(this.previews.get(p.nonce))===JSON.stringify(p));const source=await this.fresh();requireValue(sourceMatches(p,source));this.dir();requireValue(this.list().length<512);
      const fd=fs.openSync(this.file(p.nonce),'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({version:1,origin:this.origin,context:this.context,preview:p}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}this.syncDirectory();
      try {
        // Keep recovery evidence even if a second window already claimed this message.
        const target=join(this.directory,digest(JSON.stringify([this.origin,this.context,p.note,p.eid,p.revision,remoteSourceHash(p.text)]))+'.claim');
        let claim: number;
        try {claim=fs.openSync(target,'wx',0o600);} catch(error) {if((error as NodeJS.ErrnoException).code==='EEXIST') throw new Error('This message was already claimed in this profile. Check the retained import; do not confirm again.');throw error;}
        try{fs.writeFileSync(claim,JSON.stringify({nonce:p.nonce,preview:p}));fs.fsyncSync(claim);}finally{fs.closeSync(claim);}this.syncDirectory();
        this.event(p.nonce,'claimed','Confirmation claimed before dispatch; recovery observes only.');
        this.source();const r=this.receipt(await this.request('import-confirm',{}, {schema:'readymade-workspace-import-v1',operation:'confirm',nonce:p.nonce,session:p.session,note:p.note,eid:p.eid,grant:p.grant,previewDigest:p.previewDigest}),p);this.event(p.nonce,'observed',r.status);return r;
      } catch(error){this.event(p.nonce,'error',error instanceof Error?error.message:'Confirmation outcome unavailable.');throw error;}
    } finally{this.busy=false;}
  }
  async recover(nonce: string): Promise<WorkspaceRequestDetail> {
    requireValue(!this.busy);this.busy=true;
    try {this.identity();const p=this.read(nonce).preview;
      try{const r=this.receipt(await this.request('request',{'x-readymade-workspace-requester':this.context.owner,'x-readymade-workspace-nonce':nonce}),p);this.event(nonce,'observed',r.status);return r;}
      catch(error){this.event(nonce,'error',error instanceof Error?error.message:'Observation unavailable.');throw error;}
    } finally{this.busy=false;}
  }
}
