const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');

test('Backend activation preparation binds immutable target and checks without executing; rejects drift and unsafe input', () => {
  const script = String.raw`
import importlib.util, json, tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('activation','backend/install/prepare-activation.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def fixture(root):
    checks=root/'checks';checks.mkdir()
    apps=['graf','cantrip','viki','cli-inference','multiplayer-runtime','readymade-collab',
          'native-coding-source-import','pataphor-native-console','pataphor-page','readymade-editing']
    names=['00-source.hoon','10-marks.hoon','11-runtime.hoon']+[f'{i:02d}-app-{app}.hoon' for i,app in enumerate(apps,1)]
    files={name:m.digest(name.encode()) for name in names}
    for name in names:(checks/name).write_text(name)
    packet={'schema':'readymade-native-compilation-packet-v1','ship':'~nec','desk':'owned-notes','revision':1234,'files':files,'apps':apps,'assemblyManifestSHA256':m.digest(Path('backend/assembly-manifest.json').read_bytes())}
    (checks/'packet.json').write_text(json.dumps(packet))
    return checks,packet
with tempfile.TemporaryDirectory() as temp:
    root=Path(temp).resolve();checks,packet=fixture(root);out=root/'out'
    result=m.prepare(checks,'0123456789abcdef'*4,47,out)
    assert result['ship']=='~nec' and result['existingApps']==47
    assert result['schema']=='readymade-backend-activation-packet-v2'
    assert result['appSet']=='readymade-backend-ten-apps-v2' and result['apps']==packet['apps']
    assert len(result['apps'])==10 and len(result['routes'])==7
    assert '/apps/readymade-editing' in result['routes']
    assert set(result['files'])=={'00-preflight.hoon','01-activate.hoon','02-post-install.hoon','03-snapshot.hoon'}
    for name,sha in result['files'].items():assert m.digest((out/name).read_bytes())==sha
    pre=(out/'00-preflight.hoon').read_text();act=(out/'01-activate.hoon').read_text()
    assert pre.replace('%.n])','%.y])',1)==act
    assert '[~nec %owned-notes 1.234 0x123.4567.89ab.cdef.' in act
    for guard in ['=(~ collisions)','=(root.parameters root)','?>  !override-present','=(~ conflicts)','readymade-observed-install-snapshot-v1 tid.b']:
        assert guard in act,guard
    assert act.count('send-raw-card')==1 and '[%zest target.parameters %live]' in act
    assert '%load' not in act and '~let' not in act and '~dashus' not in act
    assert act.index('?.  submit.parameters')<act.index('send-raw-card')
    assert '%readymade-activation-prepared-v2' in pre and '%readymade-activation-submitted-v2' in act
    receiver=Path('backend/install/receiver-check.hoon').read_text()
    assert '%readymade-receiver-check-v2' in receiver and 'send-raw-card' not in receiver
    for text in [receiver,act]:
        assert '%readymade-editing]' in text and '/apps/readymade-editing]' in text
        assert '=(~ conflicts)' in text and 'collisions' in text
    post=(out/'02-post-install.hoon').read_text();snapshot=(out/'03-snapshot.hoon').read_text()
    assert '%readymade-backend-post-install-v2' in post
    for guard in ['=(root.parameters','=(%live liv.d)','*dome:clay','%host-viki','%hot-viki','(levy wanted','(add 10 existing-apps.parameters)','(levy ~(tap by names)']:
        assert guard in post,guard
    for text in [post,snapshot]:
        assert 'send-raw-card' not in text and '%load' not in text
        assert '~let' not in text and '~dashus' not in text
    assert 'egg=egg-any:gall' in snapshot and 'apps ds bindings' in snapshot
    assert json.loads((out/'packet.json').read_text())==result
cases=['root','count','bool-count','ship','desk','base','data-desk','revision','schema','missing','drift','symlink','packet-link','existing','manifest','apps','historical-nine','missing-editing-check']
for case in cases:
    with tempfile.TemporaryDirectory() as temp:
        root=Path(temp).resolve();checks,packet=fixture(root);out=root/'out';pin='a'*64;count=47
        if case=='root':pin='a'*63+']'
        if case=='count':count=0
        if case=='bool-count':count=True
        if case=='ship':packet['ship']='~nec]'
        if case=='desk':packet['desk']='x/y'
        if case=='base':packet['desk']='base'
        if case=='data-desk':packet['desk']='noltbook-data'
        if case=='revision':packet['revision']=True
        if case=='schema':packet['schema']='other'
        if case=='manifest':packet['assemblyManifestSHA256']='wrong'
        if case=='apps':packet['apps'].reverse()
        if case=='historical-nine':packet['apps'].remove('readymade-editing')
        if case=='missing-editing-check':del packet['files']['10-app-readymade-editing.hoon']
        if case=='missing':del packet['files']['11-runtime.hoon']
        if case=='drift':(checks/'00-source.hoon').write_text('changed')
        if case=='symlink':
            target=checks/'00-source.hoon';target.unlink();target.symlink_to(checks/'01-app-graf.hoon')
        (checks/'packet.json').write_text(json.dumps(packet))
        if case=='packet-link':
            target=checks/'packet.json';target.rename(checks/'original.json');target.symlink_to(checks/'original.json')
        if case=='existing':out.mkdir();(out/'keep').write_text('retained')
        try:m.prepare(checks,pin,count,out)
        except ValueError:pass
        else:raise AssertionError('Accepted '+case)
        if case=='existing':assert (out/'keep').read_text()=='retained'
        else:assert not out.exists(),case
print('activation preparation and 18 adverse cases passed')
`;
  const result = spawnSync('python3', ['-c', script], {cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000});
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /18 adverse cases passed/);
});
