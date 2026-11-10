const fs = require('node:fs');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {ShipClient} = require('../dist/src/ship-client.js');
const path = require('node:path');
const {verifyIdentity} = require('./noltbook-http.cjs');
function options(args) {
  const opts = {};
  for (let i=0;i<args.length;i+=2) {
    const key=args[i];
    if (!['--auth-file','--ship','--output'].includes(key) || !args[i+1] || key in opts) throw Error('Expected unique --auth-file, --ship and --output arguments');
    opts[key]=args[i+1];
  }
  if (!opts['--auth-file'] || !opts['--output'] || !/^~[a-z]+(?:-[a-z]+)*$/.test(opts['--ship']??'')) throw Error('Explicit auth file, ship and new output directory required');
  return {authFile:path.resolve(opts['--auth-file']),ship:opts['--ship'],root:path.resolve(opts['--output'])};
}
async function run(config) {
const {root,ship}=config;
const stat=fs.lstatSync(config.authFile);
assert.ok(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077), 'Auth file must be private and regular');
const auth=JSON.parse(fs.readFileSync(config.authFile));
assert.equal(typeof auth.origin,'string');assert.equal(typeof auth.code,'string');
fs.mkdirSync(root,{mode:0o700});
let client, cookie, seq = 0, channel, note;
const save = (name, data) => fs.writeFileSync(`${root}/${name}.json`, JSON.stringify(data, null, 2), {flag:'wx',mode:0o600});
async function login() {
  if (client) client.close();
  client = new ShipClient(auth.origin, async () => auth.code);
  await client.signIn();
  await verifyIdentity(client,ship);
  cookie = client.browserCookies(auth.origin).map(c => c.name+'='+c.value).join('; ');
}
async function request(path, method='GET', body) {
  const res = await fetch(auth.origin+path, {method, headers:{cookie,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'manual',signal:AbortSignal.timeout(30000)});
  const text = await res.text();
  assert.ok(res.status>=200 && res.status<300, `HTTP ${res.status} for ${method} ${path}`);
  return text ? JSON.parse(text) : null;
}
async function scry(path) {return request('/~/scry/noltbook/api/'+path+'.json');}
async function poke(action,data) {
  const id = ++seq;
  save(`submitted-${id}`,{id,action,data,channel,at:new Date().toISOString()});
  await request(channel,'PUT',[{id,action:'poke',ship:ship.slice(1),app:'noltbook',mark:'noltbook-action',json:{action,data}}]);
  save(`transport-${id}`,{status:'accepted by HTTP; canonical readback still required'});
}
async function observe(path, accept) {
  const deadline=Date.now()+30000;
  do {
    const value=await scry(path);
    if(accept(value))return value;
    await new Promise(r=>setTimeout(r,250));
  }while(Date.now()<deadline);
  throw Error('Canonical readback not observed; do not replay prior mutation');
}
try {
  await login();
  save('identity',{owner:ship,origin:client.origin,proof:'Eyre host, authenticated requester and owner cookie'});
  const before=await scry('notes');save('before',before);
  const name='Readymade fresh messaging '+randomUUID();
  channel='/~/channel/readymade-proof-'+randomUUID();
  save('prospective',{name,channel,scope:'Local frontend transport create/send/edit/relogin/delete; no remote recipient or media claim'});
  await poke('create-note',{name});
  const created=await observe('notes',v=>v.notes.some(n=>n.name===name));
  note=created.notes.find(n=>n.name===name);save('created',note);
  const noteId=note.id;
  assert.ok(noteId);
  const first='Fresh installation message — Unicode ✓';
  await poke('send-message',{noteId,text:first,clientId:'readymade-fresh-1'});
  const posted=await observe('notes/'+encodeURIComponent(noteId),v=>v.messages.some(m=>m.text===first));save('posted',posted);
  assert.equal(posted.messages.length,1);
  const message=posted.messages[0];assert.equal(message.author,ship);assert.ok(message.eid);
  const edited='Edited and retained after a fresh login ✓';
  await poke('edit-message',{noteId,msgId:message.id,eid:message.eid,text:edited});
  const changed=await observe('notes/'+encodeURIComponent(noteId),v=>v.messages.length===1&&v.messages[0].text===edited&&v.messages[0].edited);save('edited',changed);
  await login();
  const recovered=await scry('notes/'+encodeURIComponent(noteId));assert.deepEqual(recovered,changed);save('recovered',recovered);
  await poke('delete-message',{noteId,msgId:message.id,eid:message.eid});
  const deleted=await observe('notes/'+encodeURIComponent(noteId),v=>v.messages.length===0);save('message-deleted',deleted);
  await poke('delete-note',{id:noteId});
  const after=await observe('notes',v=>!v.notes.some(n=>n.id===noteId));
  assert.deepEqual(after,before);save('after',after);
  await request(channel,'PUT',[{id:++seq,action:'delete'}]);
  save('qualified',{create:true,send:true,edit:true,reloginRetainedExact:true,deleteMessage:true,deleteNote:true,originalNotesExact:true,scope:'One owned ship through real frontend HTTP transport, not two-operator or video proof'});
  console.log('Fresh local messaging passed; original note list restored.');
} catch(e) {save('failure',{name:e.name,message:e.message,noteId:note?.id,channel,sequence:seq,automaticReplay:false});throw e;} finally {client?.close();}
}
if(require.main===module) run(options(process.argv.slice(2))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={options,run};
