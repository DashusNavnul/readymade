const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');

test('Noltbook native preparation binds every source, inactive desk and base preservation before app builds', () => {
  const script = String.raw`
import importlib.util, json, tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('noltbook_prepare','backend/noltbook/prepare-compilation.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def fixture(root):
    source=root/'source'; source.mkdir()
    files={'desk.bill':b'~[%noltbook %noltbook-calls]', 'sys.kelvin':b'[%zuse 408]',
           'desk.docket-0':b'~[]', 'lib/docket.hoon':b'|% --',
           'app/noltbook.hoon':b'42', 'app/noltbook-calls.hoon':b'43',
           'lib/name.with-dot.hoon':b'44'}
    for name,data in files.items():
        p=source/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(data)
    manifest={'commit':'fixture','files':{n:{'bytes':len(d),'sha256':m.digest(d)} for n,d in files.items()}}
    return source,manifest
with tempfile.TemporaryDirectory() as temporary:
    root=Path(temporary).resolve(); source,manifest=fixture(root); output=root/'prepared'
    result=m.prepare(source,'~zod','test-noltbook',2,1,output,manifest)
    assert len(result['files'])==3 and result['fullNoticeQualified'] is False
    for name,sha in result['files'].items(): assert m.digest((output/name).read_bytes())==sha
    proof=(output/'00-source.hoon').read_text()
    for text in ['=(~zod our.b)', '=(our.b src.b)', '=(%dead liv.d)', '(~ ren.d)', '(~ wic.d)',
                 '/~zod/base/1', '/~zod/test-noltbook/2', '(silt (weld original additions))',
                 '(levy preserved', 'from-clauses:mime', '/lib/(crip "name.with-dot")/hoon']:
        assert text in proof, text
    for name in result['files']: assert 'send-raw-card' not in (output/name).read_text()
    try: m.prepare(source,'~zod','test-noltbook',2,1,output,manifest)
    except ValueError: pass
    else: raise AssertionError('Existing output accepted')
    assert json.loads((output/'packet.json').read_text())==result
cases=['hash','missing','extra','link','root-link','bad-ship','bad-desk','base-desk','revision','base-revision','path']
for case in cases:
    with tempfile.TemporaryDirectory() as temporary:
        root=Path(temporary).resolve(); source,manifest=fixture(root); output=root/'out'
        ship,desk,revision,base='~zod','test-noltbook',2,1
        if case=='hash': (source/'app/noltbook.hoon').write_bytes(b'changed')
        if case=='missing': (source/'desk.bill').unlink()
        if case=='extra': (source/'extra.hoon').write_bytes(b'42')
        if case=='link':
            (source/'desk.bill').unlink(); (source/'desk.bill').symlink_to(source/'sys.kelvin')
        if case=='root-link':
            (root/'linked').symlink_to(source); source=root/'linked'
        if case=='bad-ship': ship='~zod]'
        if case=='bad-desk': desk='test/desk'
        if case=='base-desk': desk='base'
        if case=='revision': revision=0
        if case=='base-revision': base=0
        if case=='path':
            try: m.clay_path('../escape.hoon')
            except ValueError: continue
            raise AssertionError('Traversal accepted')
        try: m.prepare(source,ship,desk,revision,base,output,manifest)
        except ValueError: pass
        else: raise AssertionError('Accepted '+case)
        assert not output.exists(), case
print('bound native preparation and 11 adverse cases passed')
`;
  const result = spawnSync('python3', ['-c', script], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /11 adverse cases passed/);
});
