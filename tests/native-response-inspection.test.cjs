const test = require('node:test');
const {execFileSync} = require('node:child_process');
const path = require('node:path');

test('offline native response inspection validates complete frames and never publishes payloads or changes locks', () => {
  execFileSync('python3', ['-c', String.raw`
import importlib.util, json, subprocess, sys, tempfile
from pathlib import Path
script=Path('backend/install/inspect-response.py')
spec=importlib.util.spec_from_file_location('inspection',script)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def tup(*items):
    out=items[-1]
    for value in reversed(items[:-1]):out=(value,out)
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
def response(request=0,kind='avow',outcome=0,mark='noun',payload=None):
    return frame(tup(request,m.native.atom(kind),outcome,m.native.atom(mark),
                     m.native.atom('PRIVATE_FIXTURE') if payload is None else payload))
good=response()
for code,reason in [('meme','memory-exhaustion'),('exit','native-bail'),('PRIVATE_CODE','native-bail')]:
    failed=frame(tup(0,m.native.atom('bail'),m.native.atom(code),m.native.atom('PRIVATE_TRACE')))
    result=m.inspect(failed)
    assert result['nativeOutcome']=='runtime-failure' and result['executionSuccess'] is False
    assert result['failureReason']==reason
    assert not any(result[k] for k in ['identityVerified','operationSemanticsVerified','lockModified','replayAuthorized'])
    assert 'PRIVATE' not in json.dumps(result)
goofs=((m.native.atom('meme'),m.native.atom('PRIVATE_TRACE')),((m.native.atom('exit'),0),0))
native_bail=frame(tup(0,m.native.atom('bail'),goofs))
assert m.inspect(native_bail)['failureReason']=='memory-exhaustion'
assert m.inspect(native_bail)['executionSuccess'] is False
for malformed in [tup(1,m.native.atom('bail'),m.native.atom('meme'),0),
                  tup(0,m.native.atom('bail'),0),
                  tup(0,m.native.atom('bail'),((0,0),0),0),
                  tup(0,m.native.atom('bail'),(m.native.atom('meme'),0),1),
                  tup(0,m.native.atom('bail'),1,(0,0))]:
    try:m.inspect(frame(malformed))
    except ValueError:pass
    else:raise AssertionError('Accepted malformed runtime failure')
for outcome,mark in [(0,'noun'),(1,'thread-fail')]:
    result=m.inspect(response(outcome=outcome,mark=mark))
    assert result['executionSuccess']==(outcome==0)
    assert not any(result[k] for k in ['identityVerified','operationSemanticsVerified','lockModified','replayAuthorized'])
    assert 'PRIVATE_FIXTURE' not in json.dumps(result)
for bad in [response(request=1),response(kind='peek'),response(outcome=2),response(mark='other'),
            response(outcome=1),good[:-1],good+b'\0',b'\1'+good[1:],frame(0),frame((0,0))]:
    try:m.inspect(bad)
    except ValueError:pass
    else:raise AssertionError('Accepted malformed or unrelated result')
try:m.inspect(good,max_nodes=1)
except ValueError:pass
else:raise AssertionError('Ignored node limit')
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory);source=root/'response.newt';source.write_bytes(good)
    lock=root/'owner.json';lock.write_text('original lock')
    output=root/'inspection.json'
    command=[sys.executable,str(script),'--response',str(source),'--output',str(output)]
    subprocess.run(command,check=True,capture_output=True)
    assert output.stat().st_mode & 0o777 == 0o600
    assert json.loads(output.read_text())==m.inspect(good)
    assert source.read_bytes()==good and lock.read_text()=='original lock'
    prior=output.read_bytes();assert subprocess.run(command,capture_output=True).returncode!=0
    assert output.read_bytes()==prior
    link=root/'linked.newt';link.symlink_to(source)
    assert subprocess.run([sys.executable,str(script),'--response',str(link),'--output',str(root/'new')],capture_output=True).returncode!=0
    assert not (root/'new').exists()
    failed=frame(tup(0,m.native.atom('bail'),m.native.atom('meme'),m.native.atom('PRIVATE_TRACE')))
    source.write_bytes(failed);report=root/'failure.json'
    subprocess.run([sys.executable,str(script),'--response',str(source),'--output',str(report)],check=True,capture_output=True)
    assert json.loads(report.read_text())['executionSuccess'] is False
    assert source.read_bytes()==failed and lock.read_text()=='original lock'
`], {cwd: path.resolve(__dirname, '..'), timeout: 15000});
});
