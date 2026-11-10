const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {options,pins,verifyAssets,verifyIdentity,run,digest}=require('./noltbook-http.cjs');

test('Native identity needs matching host, requester and owner cookie without a coding app',async()=>{
  let mode='good';const paths=[];
  const server=http.createServer((req,res)=>{
    paths.push(req.url);assert.equal(req.headers.cookie,'urbauth-~bud=test-only');
    if(!['/~/host','/~/name'].includes(req.url)){res.writeHead(404);res.end();return;}
    if(mode==='redirect'){res.writeHead(302,{location:'/elsewhere'});res.end();return;}
    res.writeHead(mode==='denied'?403:200,{'content-type':mode==='html'?'text/html':'text/plain'});
    res.end(mode==='oversized'?'x'.repeat(257):mode===req.url?'~wes':mode==='whitespace'?' ~bud ':'~bud');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const client={origin:'http://127.0.0.1:'+server.address().port,browserCookies:()=>[{name:'urbauth-~bud',value:'test-only'}]};
    assert.equal((await verifyIdentity(client,'~bud')).owner,'~bud');assert.deepEqual(paths,['/~/host','/~/name']);
    for(mode of ['/~/host','/~/name','redirect','denied','html','oversized','whitespace'])await assert.rejects(verifyIdentity(client,'~bud'));
    const count=paths.length;
    for(const cookies of [[],[{name:'urbauth-~wes',value:'test-only'}],[{name:'urbauth-~bud',value:'test-only'},{name:'urbauth-~wes',value:'test-only'}]])
      await assert.rejects(verifyIdentity({...client,browserCookies:()=>cookies},'~bud'));
    assert.equal(paths.length,count);assert(paths.every(p=>['/~/host','/~/name'].includes(p)));
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('HTTP verifier requires explicit target and pins corrected media rather than upstream HTML',()=>{
  for(const args of [[],['--auth-file','x','--output','y'],['--auth-file','x','--output','y','--ship','~zod]'],['--auth-file','x','--output','y','--ship','~zod','--ship','~nec']]) assert.throws(()=>options(args));
  assert.equal(options(['--auth-file','x','--ship','~zod','--output','y']).ship,'~zod');
  const expected=pins();
  assert.equal(expected[0].sha256,require('../backend/noltbook/media-overlay.json').outputSha256);
  assert.equal(expected[1].sha256,require('../backend/noltbook/manifest.json').files['lib/noltbook/apps/canvas/index.html'].sha256);
});

test('HTTP verifier accepts exact assets and same-origin login; rejects altered, oversized, redirected or public responses',async()=>{
  const main=Buffer.from('<html>main</html>'),canvas=Buffer.from('<html>canvas</html>');
  const expected=[{route:'/apps/noltbook',bytes:main.length,sha256:digest(main)},{route:'/apps/noltbook/pkg/canvas',bytes:canvas.length,sha256:digest(canvas)}];
  let mode='good'; const requests=[];
  const server=http.createServer((req,res)=>{
    requests.push({method:req.method,url:req.url,authenticated:!!req.headers.cookie});
    if(!req.headers.cookie){
      if(mode==='public'){res.writeHead(200);res.end(main);return;}
      const location=mode==='foreign-login'?'https://elsewhere.invalid/~/login':mode==='lookalike-login'?'/~/login-not':mode==='missing-login'?undefined:'/~/login?redirect=%2Fapps%2Fnoltbook';
      res.writeHead(307,location?{location}:{});res.end();return;
    }
    if(mode==='redirect'){res.writeHead(302,{location:'/unexpected'});res.end();return;}
    const body=req.url.endsWith('canvas')?canvas:main;
    res.writeHead(mode==='error'?500:200,{'content-type':mode==='content-type'?'text/plain':'text/html; charset=utf-8'});
    res.end(mode==='oversized'?Buffer.concat([body,Buffer.from('x')]):mode==='changed'?Buffer.alloc(body.length,120):mode==='short'?body.subarray(1):body);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const origin='http://127.0.0.1:'+server.address().port;
    const result=await verifyAssets(origin,'test-cookie',expected);
    assert.equal(result.authenticated.length,2);assert.equal(result.unauthenticatedRedirect,307);
    assert.deepEqual(requests.map(r=>r.authenticated),[true,true,false]);
    for(mode of ['changed','oversized','short','content-type','error','redirect','public','foreign-login','lookalike-login','missing-login'])await assert.rejects(verifyAssets(origin,'test-cookie',expected));
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
