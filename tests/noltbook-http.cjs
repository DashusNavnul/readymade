const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {ShipClient} = require('../dist/src/ship-client.js');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function options(args) {
  const values = {};
  for (let i=0; i<args.length; i+=2) {
    const key=args[i];
    if (!['--auth-file','--ship','--output'].includes(key) || !args[i+1] || key in values) throw Error('Expected unique auth-file, ship and output arguments');
    values[key]=args[i+1];
  }
  if (!values['--auth-file'] || !values['--output'] || !/^~[a-z]+(?:-[a-z]+)*$/.test(values['--ship']??'')) throw Error('Explicit private auth file, ship and new output required');
  return {authFile:path.resolve(values['--auth-file']),ship:values['--ship'],root:path.resolve(values['--output'])};
}

function pins() {
  const manifest = require('../backend/noltbook/manifest.json');
  const overlay = require('../backend/noltbook/media-overlay.json');
  const main = manifest.files['lib/noltbook/index.html'];
  if (overlay.schema !== 'readymade-noltbook-media-overlay-v1' || overlay.upstreamCommit !== manifest.commit ||
      overlay.path !== 'lib/noltbook/index.html' || overlay.inputSha256 !== main.sha256) throw Error('Media pins disagree');
  const rows = [
    {route:'/apps/noltbook', bytes:overlay.outputBytes, sha256:overlay.outputSha256},
    {route:'/apps/noltbook/pkg/canvas', ...manifest.files['lib/noltbook/apps/canvas/index.html']},
  ].map(({route,bytes,sha256})=>({route,bytes,sha256}));
  for (const row of rows) if (!Number.isSafeInteger(row.bytes) || row.bytes<1 || row.bytes>16*1024*1024 || !/^[a-f0-9]{64}$/.test(row.sha256)) throw Error('Invalid asset pin');
  return rows;
}

async function verifyAssets(origin, cookie, expected=pins()) {
  const results=[];
  for (const pin of expected) {
    const response=await fetch(origin+pin.route,{headers:{cookie},redirect:'manual',signal:AbortSignal.timeout(30000)});
    if (response.status!==200 || !/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type')??'')) {
      await response.body?.cancel(); throw Error('Authenticated HTML response refused');
    }
    const hash=createHash('sha256'); let bytes=0;
    for await (const chunk of response.body) {
      bytes+=chunk.length;
      if (bytes>pin.bytes) throw Error('Asset exceeds pinned size');
      hash.update(chunk);
    }
    const sha256=hash.digest('hex');
    if (bytes!==pin.bytes || sha256!==pin.sha256) throw Error('Served asset differs from pinned source');
    results.push({route:pin.route,status:response.status,bytes,sha256,exactPinnedSource:true});
  }
  const denied=await fetch(origin+'/apps/noltbook',{redirect:'manual',signal:AbortSignal.timeout(30000)});
  await denied.body?.cancel();
  let location;
  try { location=new URL(denied.headers.get('location'),origin); } catch { throw Error('Login redirect missing'); }
  if (![302,303,307,308].includes(denied.status) || location.origin!==origin || location.username || location.password ||
      !['/~/login','/~/login/'].includes(location.pathname)) throw Error('Anonymous access was not redirected to this ship login');
  return {authenticated:results,unauthenticatedRedirect:denied.status};
}

async function verifyIdentity(client, ship) {
  const cookies=client.browserCookies(client.origin);
  if (cookies.length!==1 || cookies[0].name!==`urbauth-${ship}`) throw Error('Authenticated owner cookie mismatch');
  const cookie=cookies.map(c=>c.name+'='+c.value).join('; ');
  // Eyre supplies these independently of the installed application set.
  for (const route of ['/~/host','/~/name']) {
    const response=await fetch(client.origin+route,{headers:{cookie},redirect:'manual',signal:AbortSignal.timeout(30000)});
    if (response.status!==200 || !/^text\/plain(?:\s*;|$)/i.test(response.headers.get('content-type')??'')) {
      await response.body?.cancel(); throw Error('Native identity response refused');
    }
    let text='';
    for await (const chunk of response.body) {
      text+=Buffer.from(chunk).toString('utf8');
      if (Buffer.byteLength(text)>256) throw Error('Native identity response exceeds limit');
    }
    if (text!==ship) throw Error('Native host or authenticated requester mismatch');
  }
  return {owner:ship,origin:client.origin,proof:'Eyre host, authenticated requester and owner cookie'};
}

async function run({authFile,ship,root}, verification={pins,verifyAssets,label:'Noltbook'}) {
  const stat=fs.lstatSync(authFile);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode&0o077)) throw Error('Auth file must be private and regular');
  let auth;
  try { auth=JSON.parse(fs.readFileSync(authFile)); } catch { throw Error('Invalid private auth file'); }
  if (typeof auth.origin!=='string' || typeof auth.code!=='string') throw Error('Invalid private auth file');
  const expected=verification.pins();
  const client=new ShipClient(auth.origin,async()=>auth.code);
  let stage='login';
  fs.mkdirSync(root,{mode:0o700});
  const save=(name,data)=>fs.writeFileSync(path.join(root,name+'.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
  try {
    save('plan',{ship,origin:client.origin,expected,scope:verification.scope??'Authenticated pinned HTTP assets and anonymous isolation; no app writes or media capture'});
    await client.signIn();
    stage='identity';
    save('identity',await verifyIdentity(client,ship));
    stage='assets';
    const cookie=client.browserCookies(client.origin).map(c=>c.name+'='+c.value).join('; ');
    const result=await verification.verifyAssets(client.origin,cookie,expected);
    save('qualified',{...result,owner:ship,scope:verification.scope??'HTTP asset delivery only; not rendered UI, messaging, media or preservation proof'});
    console.log(verification.message??'Pinned '+verification.label+' assets match; anonymous access is denied.');
    return result;
  } catch {
    save('failure',{stage,automaticReplay:false,qualified:false});
    throw Error(verification.label+' HTTP verification failed at '+stage+'; inspect private receipts.');
  } finally {client.close();}
}

if (require.main===module) run(options(process.argv.slice(2))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={options,pins,verifyAssets,verifyIdentity,run,digest};
