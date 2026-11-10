const test = require('node:test');
const {execFileSync} = require('node:child_process');
const path = require('node:path');

test('offline operation verification distinguishes eligibility and rejects altered request/result bindings', () => {
  execFileSync('python3', ['-c', String.raw`
import importlib.util,json,subprocess,sys,tempfile
from pathlib import Path
script=Path('backend/install/verify-operation.py')
spec=importlib.util.spec_from_file_location('verifier',script)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
a=m.n.atom
def tup(*items):
    out=items[-1]
    for item in reversed(items[:-1]):out=(item,out)
    return out
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
def receiver(eligible=0,present=1,apps=0,version=2):
    return tup(a('readymade-receiver-check-v'+str(version)),161,a('readymade'),eligible,0,0,present,1,apps,0)
assert m.interpret(receiver(),'receiver','readymade')['eligible'] is True
assert m.interpret(receiver(),'receiver','readymade')['appSet']==m.n.CURRENT_APP_SET
assert m.interpret(receiver(version=1),'receiver','readymade',receiver_version=1)['appSet']==m.n.LEGACY_APP_SET
assert m.interpret(receiver(eligible=1,present=0),'receiver','readymade')['eligible'] is False
for value in [receiver(eligible=0,present=0),receiver(eligible=2),receiver(apps=7),receiver(version=1),receiver(version=3)]:
    try:m.interpret(value,'receiver','readymade')
    except ValueError:pass
    else:raise AssertionError('Invalid eligibility accepted')
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory);packet=root/'packet';receipt=root/'receipt';receipt.mkdir()
    subprocess.run([sys.executable,'backend/install/prepare-operation.py','--ship','~lus','--desk','readymade','--operation','observe','--output',str(packet)],check=True,capture_output=True)
    source=(packet/'operation.hoon').read_bytes()
    guarded=('=/  readymade-transport  (strand ,vase)\n;<  readymade-bowl=bowl  bind:readymade-transport  get-bowl\n?>  &(=(~lus our.readymade-bowl) =(our.readymade-bowl src.readymade-bowl))\n').encode()+source
    request=frame(tup(0,a('fyrd'),a('base'),a('khan-eval'),a('noun'),a('ted-eval'),int.from_bytes(guarded,'little')))
    payload=tup(a('readymade-stage-observed-v1'),161,a('readymade'),(0,tup(4,a('live'),0,(0,123))))
    response=frame(tup(0,a('avow'),0,a('noun'),payload))
    files={'source.hoon':guarded,'request.newt':request,'response.newt':response,
      'plan.json':json.dumps({'ship':'~lus','operation':'strand','sourceSHA256':m.sha(source)}).encode(),
      'submitted.json':json.dumps({'requestSHA256':m.sha(request)}).encode(),
      'result.json':json.dumps({'status':'native-success','executionSuccess':True,'responseSHA256':m.sha(response)}).encode()}
    for name,data in files.items():(receipt/name).write_bytes(data)
    good=m.verify(packet,receipt)
    assert good['observation']['revision']==4 and good['observation']['state']=='live'
    assert not any(good[k] for k in ['currentReadinessVerified','writeAuthorized','lockModified'])
    for name in files:
        original=(receipt/name).read_bytes()
        (receipt/name).write_bytes(b'{}' if name.endswith('.json') else b'altered')
        try:m.verify(packet,receipt)
        except (ValueError,KeyError):pass
        else:raise AssertionError('Altered receipt accepted: '+name)
        (receipt/name).write_bytes(original)
    original=(packet/'operation.hoon').read_bytes();(packet/'operation.hoon').write_bytes(original+b'\n')
    try:m.verify(packet,receipt)
    except ValueError:pass
    else:raise AssertionError('Changed prepared operation accepted')
    (packet/'operation.hoon').write_bytes(original)
    output=root/'verified.json';lock=root/'lock';lock.write_text('unchanged')
    command=[sys.executable,str(script),'--packet',str(packet),'--receipt',str(receipt),'--output',str(output)]
    subprocess.run(command,check=True,capture_output=True)
    assert json.loads(output.read_text())==good and output.stat().st_mode & 0o777==0o600
    assert subprocess.run(command,capture_output=True).returncode!=0
    assert lock.read_text()=='unchanged'
# Bind an actual newly prepared receiver template to a v2 result; reject v1 substitution.
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory);packet=root/'packet';receipt=root/'receipt';receipt.mkdir()
    subprocess.run([sys.executable,'backend/install/prepare-operation.py','--ship','~lus','--desk','readymade','--operation','receiver','--output',str(packet)],check=True,capture_output=True)
    source=(packet/'operation.hoon').read_bytes()
    guarded=('=/  readymade-transport  (strand ,vase)\n;<  readymade-bowl=bowl  bind:readymade-transport  get-bowl\n?>  &(=(~lus our.readymade-bowl) =(our.readymade-bowl src.readymade-bowl))\n').encode()+source
    request=frame(tup(0,a('fyrd'),a('base'),a('khan-eval'),a('noun'),a('ted-eval'),int.from_bytes(guarded,'little')))
    (receipt/'source.hoon').write_bytes(guarded);(receipt/'request.newt').write_bytes(request)
    (receipt/'plan.json').write_text(json.dumps({'ship':'~lus','operation':'strand','sourceSHA256':m.sha(source)}))
    (receipt/'submitted.json').write_text(json.dumps({'requestSHA256':m.sha(request)}))
    for version in [2,1]:
        response=frame(tup(0,a('avow'),0,a('noun'),receiver(version=version)))
        (receipt/'response.newt').write_bytes(response)
        (receipt/'result.json').write_text(json.dumps({'status':'native-success','executionSuccess':True,'responseSHA256':m.sha(response)}))
        if version==2:
            result=m.verify(packet,receipt)
            assert result['observation']['eligible'] and result['observation']['appSet']==m.n.CURRENT_APP_SET
        else:
            try:m.verify(packet,receipt)
            except ValueError:pass
            else:raise AssertionError('Historical receiver result accepted for current template')
`], {cwd: path.resolve(__dirname, '..'), timeout: 20000});
});
