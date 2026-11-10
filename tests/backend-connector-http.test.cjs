const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {verifyConnector,run}=require('./backend-connector-http.cjs');
const {digest,decimal}=require('../backend/install/extract-connector.cjs');

test('connector HTTP proof requires valid source and exact anonymous owner refusal without writes',async()=>{
  const files=['Cargo.toml','Cargo.lock','src/main.rs','src/connect.rs','src/connect_cli.rs','src/connect_state.rs']
    .map(path=>({path,text:'// fixture\n',bytes:11,sha256:digest('// fixture\n')}));
  const source={protocol:'pataphor-connector-source-v1',sourceContract:'rust-cargo-locked-v1',digestEncoding:'little-endian-urbit-hex',instructions:'Build separately.',files,
    manifest:digest(files.map(f=>`${f.path}\n${decimal(f.bytes)}\n${f.sha256}\n`).join(''))};
  let mode='good';const requests=[];
  const server=http.createServer((req,res)=>{
    requests.push({method:req.method,path:req.url});
    if(req.headers.cookie){
      if(mode==='redirect'){res.writeHead(302,{location:'/unexpected'});res.end();return;}
      res.writeHead(mode==='insecure'?403:200,{'content-type':mode==='html'?'text/html':'application/json'});
      const body=structuredClone(source);if(mode==='corrupt')body.files[0].text='bad';
      res.end(JSON.stringify(mode==='insecure'?{status:'secure-transport-required'}:body));return;
    }
    res.writeHead(mode==='public'?200:mode==='server-error'?500:403,{'content-type':'application/json'});
    res.end(mode==='oversized-denial'?'x'.repeat(8193):JSON.stringify({status:mode==='anonymous-insecure'?'secure-transport-required':'owner-required'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const origin='http://127.0.0.1:'+server.address().port;
    const result=await verifyConnector(origin,'private-fixture');
    assert.equal(result.sourceFiles,6);assert.equal(result.sourceValidated,true);assert.equal(result.executionTested,false);
    assert(!JSON.stringify(result).includes('fixture'));
    for(mode of ['redirect','insecure','html','corrupt','public','server-error','anonymous-insecure','oversized-denial'])await assert.rejects(verifyConnector(origin,'private-fixture'));
    assert(requests.every(row=>row.method==='GET'&&row.path==='/apps/pataphor-cli/source'));
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('connector qualification refuses HTTP or exposed credentials before creating evidence',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'connector-https-'));
  try{
    const authFile=path.join(root,'auth.json'),out=path.join(root,'proof');
    fs.writeFileSync(authFile,JSON.stringify({origin:'http://127.0.0.1:1',code:'fixture'}),{mode:0o600});
    await assert.rejects(run({authFile,ship:'~zod',root:out}),/requires HTTPS/);assert(!fs.existsSync(out));
    fs.chmodSync(authFile,0o644);
    await assert.rejects(run({authFile,ship:'~zod',root:out}),/private/);assert(!fs.existsSync(out));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
