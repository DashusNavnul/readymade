const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {ShipClient}=require('../dist/src/ship-client.js');

function bindings(control) {
  assert.equal(control.protocol,'pataphor-cli-v1');
  assert(Array.isArray(control.bindings));
  const keys=new Set(),labels=new Set();
  return control.bindings.map(row=>{
    assert.deepEqual(Object.keys(row).sort(),['active','backend','connector','key']);
    assert(typeof row.active==='boolean' && ['codex','claude'].includes(row.backend));
    for(const name of ['key','connector'])assert(typeof row[name]==='string' && /^[a-z0-9-]{1,64}$/.test(row[name]));
    assert(!keys.has(row.key));keys.add(row.key);
    if(row.active){assert(!labels.has(row.connector));labels.add(row.connector);}
    return {...row};
  }).sort((a,b)=>a.key.localeCompare(b.key));
}
function verify(before,after,expected) {
  assert(!before.some(row=>row.key===expected.key||row.connector===expected.connector),'Binding already exists');
  assert.deepEqual(after,[...before,{...expected,active:true}].sort((a,b)=>a.key.localeCompare(b.key)),
    'Expected exactly one new active binding, with prior bindings unchanged');
}
async function control(client) {
  const cookie=client.browserCookies(client.origin).map(row=>row.name+'='+row.value).join('; ');
  const response=await fetch(client.origin+'/apps/pataphor-cli/control',{
    headers:{cookie},redirect:'manual',signal:AbortSignal.timeout(30000)});
  assert(response.status===200 && /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''),'Owner control unavailable');
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;assert(bytes<=1024*1024,'Control too large');chunks.push(chunk);}
  // Only public binding fields are retained; never write the control nonce.
  return bindings(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
function options(args) {
  const result={},names=['auth-file','ship','binary','backend','connector','key','output'];
  for(let i=0;i<args.length;i+=2){
    const key=args[i]?.slice(2);assert(args[i]?.startsWith('--')&&names.includes(key)&&args[i+1]&&!Object.hasOwn(result,key),'Invalid arguments');
    result[key]=args[i+1];
  }
  assert(names.every(name=>result[name]),'Required: --auth-file --ship --binary --backend --connector --key --output');
  assert(/^~[a-z]+(?:-[a-z]+)*$/.test(result.ship));assert(['codex','claude'].includes(result.backend));
  for(const name of ['connector','key'])assert(/^[a-z][a-z0-9-]{0,63}$/.test(result[name]));
  return result;
}
async function run(values) {
  const o=options(Object.entries(values).flatMap(([k,v])=>['--'+k,v]));
  const authPath=path.resolve(o['auth-file']),stat=fs.lstatSync(authPath);
  assert(stat.isFile()&&!stat.isSymbolicLink()&&!(stat.mode&0o077),'Private auth file required');
  const auth=JSON.parse(fs.readFileSync(authPath));
  assert(new URL(auth.origin).protocol==='https:','HTTPS required');
  const binary=fs.realpathSync(o.binary);assert(fs.statSync(binary).isFile());
  const root=path.resolve(o.output);assert(!fs.existsSync(root),'New evidence directory required');
  // Existing ancestors must not redirect evidence or credentials through links.
  for(let parent=path.dirname(root);;parent=path.dirname(parent)){
    const st=fs.lstatSync(parent);assert(st.isDirectory()&&!st.isSymbolicLink(),'Real output parent required');
    if(parent===path.dirname(parent))break;
  }
  const client=new ShipClient(auth.origin,async()=>auth.code),expected={key:o.key,backend:o.backend,connector:o.connector};
  fs.mkdirSync(root,{mode:0o700});
  const save=(name,data)=>fs.writeFileSync(path.join(root,name+'.json'),JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});
  let stage='owner-check',pairInvoked=false;
  try{
    save('plan',{owner:o.ship,origin:client.origin,...expected,binarySHA256:createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
      scope:'One explicit provider pairing; no worker or model execution',automaticReplay:false});
    await client.signIn();assert.equal((await client.codingState()).owner,o.ship);
    const before=await control(client);save('before',{bindings:before});
    assert(!before.some(row=>row.key===o.key||row.connector===o.connector),'Choose unused binding labels');
    const state=path.join(root,'state'),workspace=path.join(root,'workspace');
    fs.mkdirSync(state,{mode:0o700});fs.mkdirSync(workspace,{mode:0o700});
    const login=path.join(state,'login-code');fs.writeFileSync(login,auth.code,{mode:0o600,flag:'wx'});
    stage='pair-once';pairInvoked=true;
    try{
      await promisify(execFile)(binary,['--url',client.origin,'--backend',o.backend,'--connector',o.connector,'--key',o.key,
        '--state',state,'--workspace',workspace,'--pair','--login-code-file',login],{maxBuffer:1024*1024});
      save('process',{exitCode:0});
    }catch{throw Error('Pair command failed; inspect native state before any further action');}
    stage='postcheck';const after=await control(client);save('after',{bindings:after});verify(before,after,expected);
    assert.equal((await client.codingState()).owner,o.ship);
    const pairPath=path.join(state,'pair.json'),pairStat=fs.lstatSync(pairPath);
    assert(pairStat.isFile()&&!pairStat.isSymbolicLink()&&!(pairStat.mode&0o077));
    const pair=JSON.parse(fs.readFileSync(pairPath));
    for(const [key,value] of Object.entries({...expected,origin:client.origin,protocol:'pataphor-cli-v1'}))assert.equal(pair[key],value);
    assert(typeof pair.capability==='string'&&pair.capability.startsWith('0v'));
    assert(!fs.existsSync(path.join(state,'journal.json'))&&!fs.existsSync(path.join(state,'running.lock')));
    assert.deepEqual(fs.readdirSync(workspace),[]);
    save('qualified',{owner:o.ship,...expected,priorBindingsPreserved:true,pairingVerified:true,executionTested:false,modelJobs:0});
    console.log('HTTPS pairing verified; prior bindings unchanged. No worker or model job started.');
  }catch{
    save('failure',{stage,pairInvoked,automaticReplay:false,qualified:false});
    throw Error('Provider pairing unqualified at '+stage+'; inspect retained evidence and native state. Do not rerun.');
  }finally{client.close();}
}
if(require.main===module)run(options(process.argv.slice(2))).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={bindings,verify,options,run};
