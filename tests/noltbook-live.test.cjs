const test=require('node:test');
const assert=require('node:assert/strict');
const {options,run}=require('./noltbook-live.cjs');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
test('Live Noltbook test requires explicit ship and refuses ambiguous arguments before any login',()=>{
  for(const args of [[],['--auth-file','a','--output','b'],['--auth-file','a','--ship','~zod]','--output','b'],['--auth-file','a','--ship','~zod','--ship','~nec','--output','b']])assert.throws(()=>options(args));
  assert.equal(options(['--auth-file','a','--ship','~zod','--output','b']).ship,'~zod');
});
test('Live Noltbook test refuses exposed credentials and existing evidence directories before network activity',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'readymade-noltbook-input-'));
  try {
    const authFile=path.join(root,'auth.json');const output=path.join(root,'output');
    fs.writeFileSync(authFile,JSON.stringify({origin:'http://127.0.0.1:1',code:'test-only'}),{mode:0o644});
    fs.chmodSync(authFile,0o644); // Establish the adverse mode even under the packager's private umask.
    await assert.rejects(run({authFile,root:output,ship:'~zod'}),/private/);assert.equal(fs.existsSync(output),false);
    fs.chmodSync(authFile,0o600);fs.mkdirSync(output);
    await assert.rejects(run({authFile,root:output,ship:'~zod'}),/EEXIST/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
