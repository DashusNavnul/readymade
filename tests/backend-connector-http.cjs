const fs=require('node:fs');
const shared=require('./noltbook-http.cjs');
const {validate}=require('../backend/install/extract-connector.cjs');

async function responseJSON(response,limit) {
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){
    bytes+=chunk.length;
    if(bytes>limit)throw Error('Connector response exceeds limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function verifyConnector(origin,cookie) {
  const url=origin+'/apps/pataphor-cli/source';
  const response=await fetch(url,{headers:{cookie},redirect:'manual',signal:AbortSignal.timeout(30000)});
  if(response.status!==200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')){
    await response.body?.cancel();throw Error('Secure authenticated connector source unavailable');
  }
  const source=await responseJSON(response,32*1024*1024),files=validate(source);
  const denied=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(30000)});
  if(denied.status!==403){await denied.body?.cancel();throw Error('Anonymous connector source was not denied');}
  const refusal=await responseJSON(denied,8192);
  if(refusal.status!=='owner-required')throw Error('Expected owner denial after the native transport check');
  return {authenticatedStatus:200,sourceManifest:source.manifest,sourceFiles:files.length,
    sourceBytes:files.reduce((total,file)=>total+file.bytes,0),sourceValidated:true,
    anonymousStatus:403,anonymousReason:'owner-required',pairingTested:false,executionTested:false};
}

async function run(options) {
  // Refuse non-HTTPS before shared.run can authenticate or create evidence.
  const stat=fs.lstatSync(options.authFile);
  if(!stat.isFile() || stat.isSymbolicLink() || (stat.mode&0o077))throw Error('Auth file must be private and regular');
  const auth=JSON.parse(fs.readFileSync(options.authFile));
  if(new URL(auth.origin).protocol!=='https:')throw Error('Remote connector qualification requires HTTPS');
  return shared.run(options,{pins:()=>[],verifyAssets:verifyConnector,label:'Readymade connector',
    scope:'HTTPS owner-authenticated connector source and anonymous denial; no pairing, execution or media proof',
    message:'HTTPS connector source validates; anonymous access is denied. No jobs submitted.'});
}
if(require.main===module)run(shared.options(process.argv.slice(2))).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={verifyConnector,run};
