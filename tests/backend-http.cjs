const {createHash}=require('node:crypto');
const shared=require('./noltbook-http.cjs');

function pins() {
  const manifest=require('../backend/assembly-manifest.json');
  if(manifest.schema!=='readymade-backend-assembly-v1')throw Error('Unsupported assembly manifest');
  return ['codemirror.js','hoon-editor.js','native-coding-files.js','native-coding.js'].map(name=>{
    const pin=manifest.files['ui/'+name];
    if(!pin || !Number.isSafeInteger(pin.bytes) || pin.bytes<1 || pin.bytes>16*1024*1024 || !/^[a-f0-9]{64}$/.test(pin.sha256))throw Error('Invalid editor asset pin');
    return {route:'/apps/pataphor-native/coding/'+name,bytes:pin.bytes,sha256:pin.sha256};
  });
}

async function verifyAssets(origin,cookie,expected=pins()) {
  const results=[];
  for(const pin of expected){
    const response=await fetch(origin+pin.route,{headers:{cookie},redirect:'manual',signal:AbortSignal.timeout(30000)});
    if(response.status!==200 || !/^(?:application|text)\/javascript(?:\s*;|$)/i.test(response.headers.get('content-type')??'')){
      await response.body?.cancel();throw Error('Authenticated JavaScript response refused');
    }
    const hash=createHash('sha256');let bytes=0;
    for await(const chunk of response.body){
      bytes+=chunk.length;
      if(bytes>pin.bytes)throw Error('Asset exceeds pinned size');
      hash.update(chunk);
    }
    const sha256=hash.digest('hex');
    if(bytes!==pin.bytes || sha256!==pin.sha256)throw Error('Served asset differs from pinned source');
    results.push({route:pin.route,status:200,bytes,sha256,exactPinnedSource:true});
  }
  const denied=await fetch(origin+'/apps/pataphor-native/coding',{redirect:'manual',signal:AbortSignal.timeout(30000)});
  await denied.body?.cancel();
  if(denied.status===403)return {authenticated:results,unauthenticatedStatus:403,denial:'forbidden'};
  let location;
  try{location=new URL(denied.headers.get('location'),origin);}catch{throw Error('Login redirect missing');}
  if(![302,303,307,308].includes(denied.status) || location.origin!==origin || location.username || location.password ||
      !['/~/login','/~/login/'].includes(location.pathname))throw Error('Anonymous access was not redirected to this ship login');
  return {authenticated:results,unauthenticatedStatus:denied.status,denial:'same-origin-login'};
}

const run=options=>shared.run(options,{pins,verifyAssets,label:'Readymade editor'});
if(require.main===module)run(shared.options(process.argv.slice(2))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={pins,verifyAssets,run};
