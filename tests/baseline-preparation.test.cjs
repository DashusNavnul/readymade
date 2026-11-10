const test=require('node:test');
const {execFileSync}=require('node:child_process');
const path=require('node:path');

test('source baseline preparation encodes observed native pins and refuses unsafe or incomplete inputs',()=>{
  execFileSync('python3',['-c',String.raw`
import importlib.util,json,hashlib,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('baseline','backend/install/prepare-baseline.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
# Independently decoded native base receipt from the fresh receiver.
root='2b0e08f68fc9c838295b3b97bfe52c00a6ffeea1af6d696d1fe3f591c02a97c'
literal='0vlgs27.mhv4s.ge19b.ctpff.v55g0.advve.k6nmq.qbd3v.hvb4e.05abs'
assert m.uv(int(root,16))==literal
for value in [0,1,31,32,2**64,2**256-1]:
    assert int(m.uv(value)[2:].replace('.',''),32)==value
with tempfile.TemporaryDirectory() as temporary:
    directory=Path(temporary).resolve()
    basis=m.prepare('~lus','owned-source',directory/'basis')
    assert set(basis['files'])=={'00-basis.hoon'} and basis['baseRevision'] is None
    out=directory/'full';packet=m.prepare('~lus','owned-source',out,1234,root)
    assert len(packet['files'])==4 and json.loads((out/'packet.json').read_text())==packet
    for name,pin in packet['files'].items():
        assert hashlib.sha256((out/name).read_bytes()).hexdigest()==pin
    for index,action in enumerate(['isolate','clone','verify'],1):
        text=(out/f'{index:02d}-{action}.hoon').read_text()
        assert text.startswith(f'=/  arg=vase  !>([~lus %owned-source %{action} 1.234 {literal}])')
        assert text.split('\n',1)[1]==Path('backend/install/source-baseline.hoon').read_text()
    original=(out/'packet.json').read_bytes()
    try:m.prepare('~lus','owned-source',out)
    except ValueError:pass
    else:raise AssertionError('Existing output overwritten')
    assert (out/'packet.json').read_bytes()==original
    for index,args in enumerate([
        ('~lus]','owned-source',1,root),('~lus','bad/path',1,root),
        ('~lus','base',1,root),('~lus','hot-viki',1,root),
        ('~lus','owned-source',True,root),('~lus','owned-source',0,root),
        ('~lus','owned-source',None,root),('~lus','owned-source',1,None),
        ('~lus','owned-source',1,'g'),('~lus','owned-source',1,'a'*65),
    ]):
        target=directory/f'bad-{index}'
        try:m.prepare(args[0],args[1],target,args[2],args[3])
        except ValueError:pass
        else:raise AssertionError('Unsafe input admitted')
        assert not target.exists()
    linked=directory/'linked';linked.symlink_to(directory/'basis',target_is_directory=True)
    try:m.prepare('~lus','owned-source',linked/'new')
    except ValueError:pass
    else:raise AssertionError('Linked output admitted')
`],{cwd:path.resolve(__dirname,'..'),timeout:15000,stdio:'pipe'});
});
