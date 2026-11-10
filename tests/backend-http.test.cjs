const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {options,digest}=require('./noltbook-http.cjs');
const {pins,verifyAssets,run}=require('./backend-http.cjs');

test('HTTP verifier requires explicit target and pins current backend editor assets',()=>{
  for(const args of [[],['--auth-file','x','--output','y'],['--auth-file','x','--output','y','--ship','~zod]'],['--auth-file','x','--output','y','--ship','~zod','--ship','~nec']]) assert.throws(()=>options(args));
  assert.equal(options(['--auth-file','x','--ship','~zod','--output','y']).ship,'~zod');
  const expected=pins();
  assert.equal(expected.length,4);
  for(const row of expected){
    const name=row.route.split('/').at(-1);
    assert.equal(row.sha256,require('../backend/assembly-manifest.json').files['ui/'+name].sha256);
  }
});

test('HTTP verifier accepts exact assets and same-origin login; rejects altered, oversized, redirected or public responses',async()=>{
  const main=Buffer.from('const main = 1;'),canvas=Buffer.from('const second = 2;');
  const expected=[{route:'/apps/pataphor-native/coding/one.js',bytes:main.length,sha256:digest(main)},{route:'/apps/pataphor-native/coding/two.js',bytes:canvas.length,sha256:digest(canvas)}];
  let mode='good'; const requests=[];
  const server=http.createServer((req,res)=>{
    requests.push({method:req.method,url:req.url,authenticated:!!req.headers.cookie});
    if(!req.headers.cookie){
      if(mode==='forbidden'){res.writeHead(403);res.end('Owner authentication required.');return;}
      if(mode==='anonymous-error'){res.writeHead(500);res.end();return;}
      if(mode==='public'){res.writeHead(200);res.end(main);return;}
      const location=mode==='foreign-login'?'https://elsewhere.invalid/~/login':mode==='lookalike-login'?'/~/login-not':mode==='missing-login'?undefined:'/~/login?redirect=%2Fapps%2Fpataphor-native%2Fcoding';
      res.writeHead(307,location?{location}:{});res.end();return;
    }
    if(mode==='redirect'){res.writeHead(302,{location:'/unexpected'});res.end();return;}
    const body=req.url.endsWith('two.js')?canvas:main;
    res.writeHead(mode==='error'?500:200,{'content-type':mode==='content-type'?'text/plain':'application/javascript; charset=utf-8'});
    res.end(mode==='oversized'?Buffer.concat([body,Buffer.from('x')]):mode==='changed'?Buffer.alloc(body.length,120):mode==='short'?body.subarray(1):body);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const origin='http://127.0.0.1:'+server.address().port;
    const result=await verifyAssets(origin,'test-cookie',expected);
    assert.equal(result.authenticated.length,2);assert.equal(result.unauthenticatedStatus,307);
    assert.deepEqual(requests.map(r=>r.authenticated),[true,true,false]);
    mode='forbidden';
    const forbidden=await verifyAssets(origin,'test-cookie',expected);
    assert.equal(forbidden.unauthenticatedStatus,403);assert.equal(forbidden.denial,'forbidden');
    for(mode of ['changed','oversized','short','content-type','error','redirect','public','anonymous-error','foreign-login','lookalike-login','missing-login'])await assert.rejects(verifyAssets(origin,'test-cookie',expected));
    assert(requests.every(r=>r.method==='GET'&&r.url!=='/unexpected'));
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('HTTP verifier rejects exposed auth and existing evidence before contacting a ship',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'readymade-http-input-'));
  try{
    const authFile=path.join(root,'auth.json'),output=path.join(root,'out');
    fs.writeFileSync(authFile,JSON.stringify({origin:'http://127.0.0.1:1',code:'test-only'}));fs.chmodSync(authFile,0o644);
    await assert.rejects(run({authFile,ship:'~zod',root:output}),/private/);assert(!fs.existsSync(output));
    fs.chmodSync(authFile,0o600);fs.mkdirSync(output);
    await assert.rejects(run({authFile,ship:'~zod',root:output}),/EEXIST/);
    assert.deepEqual(fs.readdirSync(output),[]);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
