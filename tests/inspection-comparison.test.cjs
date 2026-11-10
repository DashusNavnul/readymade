const {test} = require('node:test');
const {execFileSync} = require('node:child_process');
const path = require('node:path');

test('inspection accounting binds actual caller watches and preserves unrelated Spider records', () => {
  execFileSync('python3', ['-c', String.raw`
import importlib.util,json,tempfile,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('inspection',Path('backend/install/compare-inspection.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);n=m.n
def tup(*items):
    result=items[-1]
    for item in reversed(items[:-1]):result=(item,result)
    return result
def listing(items):
    result=0
    for item in reversed(items):result=(item,result)
    return result
def mapping(items):
    result=0
    for item in items:result=tup(item,result,0)
    return result
def frame(noun):
    bits=[]
    def put(value,count):bits.extend((value>>i)&1 for i in range(count))
    def jam(value):
        if isinstance(value,tuple):put(1,1);put(0,1);jam(value[0]);jam(value[1]);return
        put(0,1);size=value.bit_length()
        if not size:put(1,1);return
        width=size.bit_length();put(0,width);put(1,1)
        put(size-(1<<(width-1)),width-1);put(value,size)
    jam(noun)
    data=sum(value<<i for i,value in enumerate(bits)).to_bytes((len(bits)+7)//8,'little')
    return b'\0'+len(data).to_bytes(4,'little')+data
def snapshot(label,change=None):
    inner,outer,shared=[n.atom(x) for x in ('inner'+label,'outer'+label,'retained')]
    route=listing([n.atom('khan'),0,103])
    link=listing([n.atom(x) if isinstance(x,str) else x for x in
                  ['gall','use','spider',77,'~let','thread',outer,'test','wire']])
    parent=listing([n.atom(x) for x in ['khan','fyrd','~let','base','date','noun']])
    iw=listing([route,link,0]);ow=listing([route,parent,0])
    data={'version':8,'starting':0,'scrying':0,'type':11,'code':12,'owner':n.atom('base'),
          'inner':inner,'outer':outer,'observer':inner,'route':route,
          'tid':[(i,listing([i])) for i in [inner,outer,shared]],
          'serving':[(i,tup(0,n.atom('noun'),n.atom('base'))) for i in [inner,outer,shared]],
          'running':[listing([i]) for i in [inner,outer,shared]],
          'watches':[(iw,(7,listing([n.atom('thread-result'),inner]))),
                     (ow,(7,listing([n.atom('thread-result'),outer]))),
                     (listing([999]),(7,listing([n.atom('existing')])))]}
    if change:change(data)
    state=tup(data['version'],data['starting'],listing(data['running']),mapping(data['tid']),
              mapping(data['serving']),data['scrying'])
    fields=[n.atom('live'),0,0,0,ord(label),mapping(data['watches']),0,0,data['code'],
            (1,(data['type'],state)),0,0,0,0,0,0]
    app=tup(n.atom('spider'),1,data['owner'],0,(20,tup(*fields)))
    body=tup(n.atom('readymade-private-install-snapshot-v1'),100,7,n.atom('candidate'),2,
             n.atom('live'),123,listing([app]),0,0)
    if data['observer'] is not None:body=tup(n.atom('readymade-observed-install-snapshot-v1'),data['observer'],body)
    return frame(tup(0,n.atom('avow'),0,n.atom('noun'),body))
a,b=snapshot('a'),snapshot('b')
r=m.compare(a,b)
assert r['qualifiedInspectionOnly'] and all(r['checks'].values())
assert not r['strictSpiderCarrierEqual'] and not r['strictSavedDataEqual'] and not r['statisticsEqual']
assert 'not whole-installation' in r['scope']
changes=[
 ('appIdentityExact',lambda d:d.update(owner=n.atom('other'))),
 ('savedTypeExact',lambda d:d.update(type=99)),
 ('protectedCarrierFieldsExact',lambda d:d.update(code=99)),
 ('versionStartingScryingExact',lambda d:d.update(starting=1)),
 ('versionStartingScryingExact',lambda d:d.update(scrying=1)),
 ('otherThreadRecordsExact',lambda d:d['tid'].__setitem__(-1,(n.atom('retained'),99))),
 ('otherServingRecordsExact',lambda d:d['serving'].__setitem__(-1,(n.atom('retained'),99))),
 ('otherRunningRecordsExact',lambda d:d['running'].append(listing([n.atom('extra')]))),
 ('otherResultWatchesExact',lambda d:d['watches'].__setitem__(-1,(listing([999]),(7,listing([n.atom('changed')]))))),
]
for key,change in changes:
    r=m.compare(a,snapshot('b',change));assert not r['qualifiedInspectionOnly'] and not r['checks'][key],key
assert not m.compare(a,a)['qualifiedInspectionOnly']
bad=[lambda d:d.update(observer=None),lambda d:d.update(observer=n.atom('not-present')),
     lambda d:d.update(version=7),lambda d:d['watches'].pop(0),
     lambda d:d['watches'].append((listing([123]),d['watches'][0][1])),
     lambda d:d['watches'].__setitem__(0,(d['watches'][0][0],(8,d['watches'][0][1][1]))),
     lambda d:d['watches'].__setitem__(0,(listing([d['route'],listing([n.atom('wrong')])]),d['watches'][0][1])),
     lambda d:d['serving'].__setitem__(0,(d['inner'],99)),
     lambda d:d['running'].append(listing([d['inner']])),
     lambda d:d['tid'].append(d['tid'][0])]
for change in bad:
    try:m.compare(a,snapshot('b',change))
    except ValueError:pass
    else:raise AssertionError('Malformed or unbound observer admitted')
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory);before=root/'before';after=root/'after';output=root/'report'
    before.write_bytes(a);after.write_bytes(b)
    sys.argv=['compare','--before',str(before),'--after',str(after),'--output',str(output)]
    assert m.main()==0
    assert output.stat().st_mode & 0o777 == 0o600
    assert json.loads(output.read_text())['qualifiedInspectionOnly']
    try:m.main()
    except ValueError:pass
    else:raise AssertionError('Report overwritten')
spec=importlib.util.spec_from_file_location('preservation',Path('backend/noltbook/verify-preservation.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
def install(label,**changes):
    native=n.unpack(n.cue_frame(snapshot(label)),5)
    observed=n.unpack(native[4],3);body=n.unpack(observed[2],10)
    after=label=='b'
    def app(name,data,owner='base',type_id=11):
        fields=[n.atom('live'),0,0,0,0,0,0,0,12,(1,(type_id,data)),0,0,0,0,0,0]
        return tup(n.atom(name),1,n.atom(owner),0,(20,tup(*fields)))
    catalog=[(n.atom('existing'),42)]+([(n.atom('candidate'),99)] if after else [])
    apps=list(n.rows(body[7]))+[app('hood',42),app('docket',(6,mapping(catalog))),
          app('other',changes.get('saved',42),type_id=changes.get('saved_type',11))]
    if after:
        apps.extend(app(name,0,changes.get('new_owner','candidate')) for name in ['noltbook','noltbook-calls'])
    if changes.get('remove_app'):apps.pop(1)
    if changes.get('extra_app'):apps.append(app('unexpected',0))
    if changes.get('missing_new'):apps.pop()
    body[7]=listing(apps)
    def desk(live,revision=2,policy=0):return tup(revision,mapping([(revision,123)]),0,0,policy,0,0,n.atom(live),0)
    desks=[((7,n.atom('candidate')),desk('live' if after else 'dead',policy=changes.get('target_policy',0))),
           ((7,n.atom('base')),desk('live',policy=changes.get('other_policy',0)))]
    if after:desks.append(((7,n.atom('noltbook-data')),desk(changes.get('data_live','dead'),1)))
    if changes.get('remove_desk'):desks.pop(1)
    if changes.get('extra_desk'):desks.append(((7,n.atom('extra')),desk('dead')))
    body[8]=mapping(desks)
    def route(name,duct=0):return tup((0,listing([n.atom('apps'),n.atom(name)])),duct,(n.atom('app'),n.atom(name)))
    routes=[route('existing',changes.get('old_duct',0))]+([route('noltbook')] if after else [])
    if changes.get('remove_route'):routes.pop(0)
    if changes.get('extra_route'):routes.append(route('extra'))
    body[9]=listing(routes);body[5]=n.atom('live' if after else 'dead');body[6]=changes.get('root',123)
    return frame(tup(*native[:4],tup(*observed[:2],tup(*body))))
before,after=install('a'),install('b')
r=p.verify(before,after)
assert r['preservationQualified'] and all(r['checks'].values())
assert not r['strictPriorCarrierEquality']
assert r['priorApps']['other']['strictSavedDataEqual']
assert not r['priorApps']['docket']['strictSavedDataEqual']
assert 'post-check' in r['scope']
assert not p.verify(install('a',root=999),install('b',root=999))['preservationQualified']
assert not p.verify(after,after)['preservationQualified']
assert not p.verify(after,after)['remainingChecksRun']
for change in [dict(saved=43),dict(saved_type=99),dict(new_owner='wrong'),dict(remove_app=True),
               dict(extra_app=True),dict(missing_new=True),dict(target_policy=1),dict(other_policy=1),
               dict(data_live='live'),dict(remove_desk=True),dict(extra_desk=True),dict(old_duct=99),
               dict(remove_route=True),dict(extra_route=True),dict(root=999)]:
    assert not p.verify(before,install('b',**change))['preservationQualified'],change
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory);a=root/'before';b=root/'after';out=root/'report'
    a.write_bytes(before);b.write_bytes(after)
    sys.argv=['verify','--before',str(a),'--after',str(b),'--output',str(out)]
    assert p.main()==0 and out.stat().st_mode & 0o777==0o600
    try:p.main()
    except ValueError:pass
    else:raise AssertionError('Preservation report overwritten')
    b.write_bytes(install('b',saved=43));sys.argv[-1]=str(root/'failed')
    assert p.main()==2 and not json.loads((root/'failed').read_text())['preservationQualified']
spec=importlib.util.spec_from_file_location('backend_preservation',Path('backend/install/verify-preservation.py'))
q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
names=['graf','cantrip','viki','cli-inference','multiplayer-runtime','readymade-collab',
       'native-coding-source-import','pataphor-native-console','pataphor-page']
routes={'/graf':'graf','/apps/qpc-ark':'viki','/apps/pataphor-cli':'cli-inference',
        '/apps/readymade-collab':'readymade-collab','/apps/pataphor-native':'pataphor-native-console',
        '/apps/pataphor':'pataphor-page'}
def full_install(label,change=None):
    raw=n.unpack(n.cue_frame(install(label)),5)
    observed=n.unpack(raw[4],3);body=n.unpack(observed[2],10)
    apps=[n.unpack(row,5) for row in n.rows(body[7])]
    desks=dict(n.tree(body[8]));http=list(n.rows(body[9]))
    if label=='b':
        seed=apps[-1];apps=apps[:-2]
        for row in apps:
            if row[0]==n.atom('docket'):
                fields=n.unpack(row[4][1],16)
                fields[9]=(1,(11,(6,mapping([(n.atom('existing'),42)]))))
                row[4]=(20,tup(*fields))
        apps.extend([n.atom(name),*seed[1:]] for name in names)
        del desks[(7,n.atom('noltbook-data'))]
        for name in ['host-viki','hot-viki']:
            desks[(7,n.atom(name))]=tup(0,0,0,0,(0,0),0,0,n.atom('dead'),0)
        http=http[:-1]+[tup((0,listing([n.atom(s) for s in path.strip('/').split('/')])),0,
                           (n.atom('app'),n.atom(app))) for path,app in routes.items()]
    if change:change(apps,desks,http,body)
    body[7]=listing([tup(*row) for row in apps]);body[8]=mapping(list(desks.items()));body[9]=listing(http)
    return frame(tup(*raw[:4],tup(*observed[:2],tup(*body))))
a,b=full_install('a'),full_install('b')
r=q.verify(a,b,n.LEGACY_APP_SET)
assert r['preservationQualified'] and all(r['checks'].values()),r
assert r['priorApps']['docket']['strictSavedDataEqual'] and not r['strictPriorCarrierEquality']
assert not q.verify(b,b,n.LEGACY_APP_SET)['preservationQualified']
assert not q.verify(before,after,n.LEGACY_APP_SET)['preservationQualified']
def corrupt_app(apps,name,index,value):
    row=next(row for row in apps if row[0]==n.atom(name))
    fields=n.unpack(row[4][1],16);fields[index]=value;row[4]=(20,tup(*fields))
bad_full=[
    lambda a,d,r,b:a.pop(),
    lambda a,d,r,b:a.pop(1),
    lambda a,d,r,b:a[-1].__setitem__(2,n.atom('foreign')),
    lambda a,d,r,b:corrupt_app(a,'docket',9,(1,(11,99))),
    lambda a,d,r,b:corrupt_app(a,'other',9,(1,(12,42))),
    lambda a,d,r,b:corrupt_app(a,'other',4,123),
    lambda a,d,r,b:corrupt_app(a,'hood',8,999),
    lambda a,d,r,b:d.__setitem__((7,n.atom('hot-viki')),tup(0,0,0,0,0,0,0,n.atom('dead'),0)),
    lambda a,d,r,b:d.pop((7,n.atom('host-viki'))),
    lambda a,d,r,b:d.__setitem__((7,n.atom('extra')),0),
    lambda a,d,r,b:d.__setitem__((7,n.atom('base')),0),
    lambda a,d,r,b:r.pop(),
    lambda a,d,r,b:r.append(r[-1]),
    lambda a,d,r,b:r.__setitem__(-1,tup(n.unpack(r[-1],3)[0],0,(n.atom('app'),n.atom('wrong')))),
    lambda a,d,r,b:r.__setitem__(0,tup(n.unpack(r[0],3)[0],99,n.unpack(r[0],3)[2])),
    lambda a,d,r,b:b.__setitem__(6,999),
]
for change in bad_full:
    assert not q.verify(a,full_install('b',change),n.LEGACY_APP_SET)['preservationQualified']
override=lambda a,d,r,b:d.__setitem__((7,n.atom('host-law')),0)
assert not q.verify(full_install('a',override),full_install('b',override),n.LEGACY_APP_SET)['preservationQualified']
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory);left=root/'before';right=root/'after';out=root/'report'
    left.write_bytes(a);right.write_bytes(b)
    sys.argv=['verify','--before',str(left),'--after',str(right),'--output',str(out)]
    sys.argv.extend(['--app-set',n.LEGACY_APP_SET])
    assert q.main()==0 and out.stat().st_mode & 0o777==0o600
    assert json.loads(out.read_text())['preservationQualified']
    try:q.main()
    except ValueError:pass
    else:raise AssertionError('Backend report overwritten')
    right.write_bytes(full_install('b',bad_full[0]));sys.argv[sys.argv.index('--output')+1]=str(root/'failed')
    assert q.main()==2
# The new policy requires exactly ten apps and seven routes, without relabeling old receipts.
assert not q.verify(a,b)['preservationQualified']
names.append('readymade-editing');routes['/apps/readymade-editing']='readymade-editing'
a10,b10=full_install('a'),full_install('b')
r=q.verify(a10,b10)
assert r['preservationQualified'] and r['schema']=='readymade-backend-preservation-v2'
assert r['appSet']==n.CURRENT_APP_SET and r['checks']['freshTenAppAddition']
assert 'freshNineAppAddition' not in r['checks']
assert not q.verify(a10,b10,n.LEGACY_APP_SET)['preservationQualified']
for change in bad_full:
    assert not q.verify(a10,full_install('b',change))['preservationQualified']
comparison=n.compare(a10,b10)
assert comparison['expectedAppsAdded'] and not comparison['expectedNineAppsAdded']
assert n.compare(a,b,app_set=n.LEGACY_APP_SET)['expectedNineAppsAdded']
try:q.verify(a10,b10,'unversioned')
except ValueError:pass
else:raise AssertionError('Unknown app set accepted')
`], {cwd: path.resolve(__dirname, '..'), timeout: 15000, stdio: 'pipe'});
});
