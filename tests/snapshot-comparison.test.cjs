const {test} = require('node:test');
const {execFileSync} = require('node:child_process');
const path = require('node:path');

test('offline native snapshot comparison preserves strict failures and validates framing', () => {
  execFileSync('python3', ['-c', String.raw`
import importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('comparison',Path('backend/install/compare-snapshots.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def tup(*items):
    out=items[-1]
    for value in reversed(items[:-1]):out=(value,out)
    return out
def listing(items):
    out=0
    for value in reversed(items):out=(value,out)
    return out
def frame(noun):
    bits=[]
    def put(value,n):bits.extend((value>>i)&1 for i in range(n))
    def mat(value):
        n=value.bit_length()
        if not n:put(1,1);return
        width=n.bit_length();put(0,width);put(1,1);put(n-(1<<(width-1)),width-1);put(value,n)
    def jam(value):
        if isinstance(value,tuple):put(1,1);put(0,1);jam(value[0]);jam(value[1])
        else:put(0,1);mat(value)
    jam(noun)
    data=sum(value<<i for i,value in enumerate(bits)).to_bytes((len(bits)+7)//8,'little')
    return b'\0'+len(data).to_bytes(4,'little')+data
def carrier(saved):
    return (20,tup(m.atom('live'),0,0,0,0,0,0,0,0,(1,(m.atom('type'),saved)),0,0,0,0,0,0))
def snapshot(saved=42,owner=6,revision=2,include=True,live=0,root=123,wrapped=False,desks=0,routes=0):
    apps=listing([tup(m.atom('old-app'),1,m.atom('base'),live,carrier(saved))]) if include else 0
    body=tup(m.atom('readymade-private-install-snapshot-v1'),100,owner,m.atom('readymade'),revision,m.atom('live'),root,apps,desks,routes)
    if wrapped:body=(m.atom('readymade-activation-submitted-v2' if wrapped==2 else 'readymade-activation-submitted-v1'),body)
    return frame(tup(0,m.atom('avow'),0,m.atom('noun'),body))
a=snapshot();b=snapshot(wrapped=True)
r=m.compare(a,b);assert r['strictWholeCarrierEquality'] and r['savedStateEquality']=={'old-app':True}
assert not r['expectedNineAppsAdded'];assert 'comparison-only' in r['verdict']
assert m.compare(a,snapshot(wrapped=2))['strictWholeCarrierEquality']
assert r['appSet']==m.CURRENT_APP_SET and r['schema']=='readymade-install-comparison-v2'
r=m.compare(a,snapshot(saved=43));assert not r['strictWholeCarrierEquality'];assert r['savedStateEquality']=={'old-app':False}
assert r['carrierDetails']['old-app']['changedFields']==['old-state']
assert r['carrierDetails']['old-app']['savedTypeEqual'] and not r['carrierDetails']['old-app']['savedDataEqual']
r=m.compare(a,snapshot(include=False));assert r['removedApps']==['old-app'] and not r['strictWholeCarrierEquality']
r=m.compare(a,snapshot(live=1));assert not r['allAfterAppsLive'];assert 'live' in r['changedExistingApps']['old-app']
assert not m.compare(a,snapshot(root=999))['sourceCommitEqual']
def desks(live,revision=2):
    return tup(((6,m.atom('readymade')),tup(revision,0,0,0,0,0,0,m.atom(live),0)),0,0)
r=m.compare(snapshot(desks=desks('dead')),snapshot(desks=desks('live')))
assert r['deskDetails']==[{'ownerNumber':'6','desk':'readymade','changedFields':['liv']}]
r=m.compare(snapshot(desks=desks('dead')),snapshot(desks=desks('live',3)))
assert r['deskDetails'][0]['changedFields']==['let','liv']
r=m.compare(snapshot(),snapshot(desks=desks('dead',0)))
assert r['addedDeskDetails']==[{'ownerNumber':'6','desk':'readymade','revision':0,'live':'dead','nonemptyFields':['liv']}]
route=tup((0,listing([m.atom('apps'),m.atom('example')])),0,(m.atom('app'),m.atom('example')))
r=m.compare(snapshot(),snapshot(routes=listing([route])))
assert r['addedRouteDetails']==[{'path':'/apps/example','app':'example'}]
assert m.compare(snapshot(),snapshot(routes=listing([tup(0,0,0)])))['addedRouteDetails']==[{'unrecognized':True}]
for bad in [snapshot(owner=7),snapshot(revision=3)]:
    try:m.compare(a,bad)
    except ValueError:pass
    else:raise AssertionError('Mismatched identity/revision accepted')
for bad in [a[:-1],a+b'\0',b'\1'+a[1:],b'\0\1\0\0\0\3',b'\0\2\0\0\0\2\0']:
    try:m.cue_frame(bad)
    except ValueError:pass
    else:raise AssertionError('Invalid frame accepted')
# Public Vere eval -jn encoding of [[1 2] [1 2]], including a shared-cell reference.
assert m.cue_frame(bytes([0,3,0,0,0,197,200,73]))==((1,2),(1,2))
try:m.cue_frame(a,max_nodes=2)
except ValueError as e:assert 'node limit' in str(e)
else:raise AssertionError('Node limit not enforced')
import tempfile,sys,os
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory);before=root/'before';after=root/'after';output=root/'report'
    before.write_bytes(a);after.write_bytes(b)
    sys.argv=['compare','--before',str(before),'--after',str(after),'--output',str(output)]
    m.main();assert output.stat().st_mode & 0o777 == 0o600
    original=output.read_bytes()
    try:m.main()
    except ValueError:pass
    else:raise AssertionError('Existing report overwritten')
    assert output.read_bytes()==original
    link=root/'linked';link.symlink_to(before)
    try:m.read_frame(link)
    except OSError:pass
    else:raise AssertionError('Linked input accepted')
# DAG equality must be iterative and share-aware, even at extreme depth.
x=1;y=1
for _ in range(3000):x=(x,x);y=(y,y)
assert m.equal(x,y) and not m.equal(x,(y,0))
# Carrier diagnostics separate statistics, saved type and actual saved data.
old=m.unpack(carrier(42)[1],16);new=old.copy();new[4]=99
d=m.carrier_detail('hood',old,new)
assert d['changedFields']==['stats'] and d['savedTypeEqual'] and d['savedDataEqual']
new=old.copy();new[9]=(1,(m.atom('different-type'),42))
d=m.carrier_detail('hood',old,new);assert not d['savedTypeEqual'] and d['savedDataEqual']
new[9]=(0,(m.atom('type'),42));assert not m.carrier_detail('hood',old,new)['savedVaseRecognized']
new[9]=0;assert not m.carrier_detail('hood',old,new)['savedVaseRecognized']
def mapping(items):
    out=0
    for key,value in items:out=tup((m.atom(key),value),out,0)
    return out
def spider(thread,shared=42,starting=0):
    data=tup(1,starting,listing([listing([m.atom(thread)])]),
             mapping([(thread,1),('shared',shared)]),mapping([(thread,2),('shared',shared)]),0)
    return m.unpack(carrier(data)[1],16)
left=old.copy();right=old.copy()
left[5]=mapping([('old',1),('shared',2)]);right[5]=mapping([('new',1),('shared',3)])
assert m.carrier_detail('spider',left,right)['bitt']=={'removed':1,'added':1,'changedShared':1}
x=spider('khan-fyrd--old');y=spider('khan-fyrd--new')
d=m.carrier_detail('spider',x,y)
assert not d['savedDataEqual'] and d['savedTypeEqual']
assert d['spider']['tid']=={'removed':['khan-fyrd--old'],'added':['khan-fyrd--new'],'changedShared':[]}
assert d['spider']['runningBefore']==[('khan-fyrd--old',)]
assert 'qualified' not in d['spider']
d=m.carrier_detail('spider',x,spider('khan-fyrd--new',shared=43,starting=1))
assert d['spider']['tid']['changedShared']==['shared']
assert not d['spider']['exactFields']['starting']
bad=x.copy();bad[9]=(1,(m.atom('type'),42))
assert 'unrecognized' in m.carrier_detail('spider',x,bad)['spider']
# Component selection changes expectations, never hides unrelated state changes.
def installed(names,owner='readymade',saved=42):
    native=m.unpack(m.cue_frame(snapshot(saved=saved)),5)
    body=m.unpack(native[4],10)
    body[7]=listing(list(m.rows(body[7]))+[
        tup(m.atom(n),1,m.atom(owner),0,carrier(0)) for n in names])
    return frame(tup(*native[:4],tup(*body)))
names=['noltbook','noltbook-calls']
r=m.compare(a,installed(names),'noltbook')
assert r['expectedAppsAdded'] and r['newOwnersCorrect']
assert r['expectedApps']==sorted(names) and r['component']=='noltbook'
assert not r['expectedNineAppsAdded'] and 'comparison-only' in r['verdict']
assert not m.compare(a,installed(names))['expectedAppsAdded']
assert not m.compare(a,installed(names[:1]),'noltbook')['newOwnersCorrect']
assert not m.compare(a,installed(names,owner='wrong'),'noltbook')['newOwnersCorrect']
assert not m.compare(a,installed(names+['unexpected']),'noltbook')['expectedAppsAdded']
r=m.compare(a,installed(names,saved=99),'noltbook')
assert r['expectedAppsAdded'] and not r['savedStateEquality']['old-app']
assert not r['strictWholeCarrierEquality']
try:m.compare(a,b,'anything')
except ValueError:pass
else:raise AssertionError('Unknown component accepted')
def docket(entries,version=6):
    return m.unpack(carrier((version,mapping(entries)))[1],16)
x=docket([('existing',42)])
y=docket([('existing',42),('readymade',99)])
d=m.carrier_detail('docket',x,y)
assert d['docket']=={'removed':[],'added':['readymade'],'changedShared':[]}
assert not d['savedDataEqual'] and d['savedTypeEqual']
assert m.carrier_detail('docket',x,docket([('existing',43)]))['docket']['changedShared']==['existing']
assert m.carrier_detail('docket',x,docket([]))['docket']['removed']==['existing']
assert 'unrecognized' in m.carrier_detail('docket',x,docket([],version=7))['docket']
duplicate=docket([('existing',1),('existing',2)])
assert 'unrecognized' in m.carrier_detail('docket',x,duplicate)['docket']
def docket_snapshot(fields):
    native=m.unpack(m.cue_frame(snapshot()),5);body=m.unpack(native[4],10)
    body[7]=listing([tup(m.atom('docket'),1,m.atom('base'),0,(20,tup(*fields)))])
    return frame(tup(*native[:4],tup(*body)))
r=m.compare(docket_snapshot(x),docket_snapshot(y),'noltbook')
assert r['docketRegistrationOnly'] and not r['savedStateEquality']['docket']
assert not r['strictWholeCarrierEquality'] and not r['expectedAppsAdded']
assert 'comparison-only' in r['verdict']
for wrong in [docket([('existing',43),('readymade',99)]),
              docket([('existing',42),('wrong-desk',99)]),
              docket([('existing',42),('readymade',99),('extra',1)]),
              docket([('readymade',99)]),docket([],version=7)]:
    assert not m.compare(docket_snapshot(x),docket_snapshot(wrong),'noltbook')['docketRegistrationOnly']
wrong=y.copy();wrong[9]=(1,(m.atom('changed-type'),wrong[9][1][1]))
assert not m.compare(docket_snapshot(x),docket_snapshot(wrong))['docketRegistrationOnly']
def observed(data,identity,prepared=False,submitted=False):
    native=m.unpack(m.cue_frame(data),5)
    body=tup(m.atom('readymade-observed-install-snapshot-v1'),identity,native[4])
    if prepared:body=(m.atom('readymade-activation-prepared-v1'),body)
    if submitted:body=(m.atom('readymade-activation-submitted-v1'),body)
    return frame(tup(*native[:4],body))
r=m.compare(observed(a,m.atom('before'),True),observed(a,m.atom('after')))
assert r['observerThreads']=={'before':'before','after':'after'}
assert r['strictWholeCarrierEquality']
submitted=observed(a,m.atom('submit-observer'),submitted=True)
r=m.compare(observed(a,m.atom('preflight-observer'),True),submitted)
assert r['observerThreads']=={'before':'preflight-observer','after':'submit-observer'}
assert r['strictWholeCarrierEquality'] and r['savedStateEquality']=={'old-app':True}
assert m.compare(a,b)['observerThreads']=={'before':None,'after':None}
assert m.compare(a,observed(a,m.atom('after')))['observerThreads']=={'before':None,'after':'after'}
for bad in [0,(1,2),1<<2049]:
    try:m.snapshot(observed(a,bad))
    except ValueError:pass
    else:raise AssertionError('Invalid observer identity accepted')
`], {cwd: path.resolve(__dirname, '..'), timeout: 15000, stdio: 'pipe'});
});
