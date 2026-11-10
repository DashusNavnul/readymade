const test=require('node:test'),assert=require('node:assert/strict');
const {bindings,verify,options}=require('./backend-provider-pair.cjs');
test('pairing proof requires exactly one new native binding and preserves all prior fields',()=>{
  const prior={key:'old',connector:'old-label',backend:'claude',active:false};
  const expected={key:'new',connector:'new-label',backend:'codex'};
  const before=bindings({protocol:'pataphor-cli-v1',nonce:'private',bindings:[prior]});
  const after=bindings({protocol:'pataphor-cli-v1',bindings:[prior,{...expected,active:true}]});
  verify(before,after,expected);assert(!JSON.stringify(before).includes('private'));
  const retired=bindings({protocol:'pataphor-cli-v1',bindings:[prior,{...prior,key:'2-old',active:true}]});
  verify(retired,bindings({protocol:'pataphor-cli-v1',bindings:[...retired,{...expected,active:true}]}),expected);
  for(const rows of [[],[prior],[{...expected,active:false},prior],[{...expected,active:true},{...prior,active:true}],
    [{...expected,active:true},{...prior,backend:'codex'}]])assert.throws(()=>verify(before,rows,expected));
  assert.throws(()=>verify(after,after,expected));
  for(const rows of [[prior,prior],[{...prior,capability:'private'}],[{...prior,active:'true'}],[{...prior,backend:'other'}]])
    assert.throws(()=>bindings({protocol:'pataphor-cli-v1',bindings:rows}));
});
test('pairing command rejects worker flags, missing identity, reused options and unsafe labels',()=>{
  const args=['--auth-file','/private/auth','--ship','~sev','--binary','/private/connect','--backend','codex','--connector','remote-test','--key','remote-test','--output','/private/new'];
  assert.equal(options(args).ship,'~sev');
  for(const bad of [args.slice(2),[...args,'--turns','1'],[...args,'--key','other'],args.map(x=>x==='remote-test'?'../bad':x)])assert.throws(()=>options(bad));
});
