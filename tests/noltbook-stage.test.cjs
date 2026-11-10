const {test} = require('node:test');
const {execFileSync} = require('node:child_process');
const path = require('node:path');

test('Noltbook staging pins component bytes and preserves the fresh clone before any native commit', () => {
  execFileSync('python3', ['-c', String.raw`
import importlib.util,json,tempfile,os,copy
from pathlib import Path
spec=importlib.util.spec_from_file_location('stage',Path('backend/noltbook/stage-source.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def setup(root):
    source=root/'source';mount=root/'mount';receipt=root/'receipt'
    source.mkdir();mount.mkdir()
    incoming={'app/noltbook.hoon':b'notes','app/noltbook-calls.hoon':b'calls',
              'sys.kelvin':b'new','lib/noltbook/index.html':b'upstream'}
    prior={name:b'base' for name in ('sys/hoon.hoon','sys/zuse.hoon','sys/lull.hoon','sys/vane/clay.hoon')}
    prior.update({'sys.kelvin':b'old','lib/retained.hoon':b'keep'})
    for directory,files in [(source,incoming),(mount,prior)]:
        for name,data in files.items():
            p=directory/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
    manifest={'commit':'pinned','files':{name:{'sha256':m.staging.digest(data),'bytes':len(data)} for name,data in incoming.items()}}
    return source,mount,receipt,manifest,prior,incoming
with tempfile.TemporaryDirectory() as temporary:
    source,mount,receipt,manifest,prior,incoming=setup(Path(temporary).resolve())
    assert m.stage_source(source,mount,receipt,manifest=manifest)==len(prior.keys()|incoming.keys())
    assert m.staging.inventory(mount)[0]=={**prior,**incoming}
    assert (receipt/'originals/sys.kelvin').read_bytes()==b'old'
    assert (receipt/'originals/sys.kelvin').stat().st_mode & 0o777==0o600
    assert json.loads((receipt/'complete.json').read_text())['nativeCommitSubmitted'] is False
    try:m.stage_source(source,mount,receipt.with_name('retry'),manifest=manifest)
    except ValueError as error:assert 'already present' in str(error)
    else:raise AssertionError('Staged candidate reapplied')
for case in ['hash','missing','extra','empty-dir','base-missing','already-present','source-link',
             'mount-link','hardlink','nested','receipt-exists','overlap','overlay-drift']:
    with tempfile.TemporaryDirectory() as temporary:
        root=Path(temporary).resolve();source,mount,receipt,manifest,prior,incoming=setup(root)
        if case=='hash':(source/'sys.kelvin').write_bytes(b'wrong')
        if case=='missing':(source/'sys.kelvin').unlink()
        if case=='extra':(source/'extra.hoon').write_bytes(b'extra')
        if case=='empty-dir':(source/'extra').mkdir()
        if case=='base-missing':(mount/'sys/hoon.hoon').unlink()
        if case=='already-present':(mount/'app').mkdir();(mount/'app/noltbook.hoon').write_bytes(b'old')
        if case=='source-link':(root/'linked').symlink_to(source);source=root/'linked'
        if case=='mount-link':(root/'linked').symlink_to(mount);mount=root/'linked'
        if case=='hardlink':(source/'sys.kelvin').unlink();os.link(mount/'sys.kelvin',source/'sys.kelvin')
        if case=='nested':receipt=mount/'receipt'
        if case=='receipt-exists':receipt.mkdir()
        if case=='overlap':source=mount
        before={p.relative_to(mount).as_posix():p.read_bytes() for p in mount.rglob('*') if p.is_file()}
        kwargs={'manifest':manifest}
        if case=='overlay-drift':kwargs.update(readymade_media=True,overlay={'schema':'bad'})
        try:m.stage_source(source,mount,receipt,**kwargs)
        except (ValueError,KeyError):pass
        else:raise AssertionError(case+' accepted')
        assert before=={p.relative_to(mount).as_posix():p.read_bytes() for p in mount.rglob('*') if p.is_file()},case
with tempfile.TemporaryDirectory() as temporary:
    source,mount,receipt,manifest,prior,incoming=setup(Path(temporary).resolve())
    name='lib/noltbook/index.html';(source/name).write_bytes(b'corrected')
    overlay={'schema':'readymade-noltbook-media-overlay-v1','path':name,'upstreamCommit':'pinned',
             'inputSha256':manifest['files'][name]['sha256'],'outputSha256':m.staging.digest(b'corrected'),'outputBytes':9}
    original=copy.deepcopy(manifest)
    m.stage_source(source,mount,receipt,True,manifest,overlay)
    assert (mount/name).read_bytes()==b'corrected' and manifest==original
with tempfile.TemporaryDirectory() as temporary:
    source,mount,receipt,manifest,_,_=setup(Path(temporary).resolve())
    original=m.staging.os.replace
    def fail(*args):raise OSError('injected interruption')
    m.staging.os.replace=fail
    try:
        try:m.stage_source(source,mount,receipt,manifest=manifest)
        except OSError:pass
        else:raise AssertionError('Write interruption hidden')
    finally:m.staging.os.replace=original
    assert (receipt/'originals/sys.kelvin').read_bytes()==b'old'
    assert not (receipt/'complete.json').exists()
`], {cwd: path.resolve(__dirname, '..'), timeout: 15000, stdio: 'pipe'});
});

test('Receipt-enabled staging and compilation share effective pins without changing upstream identity', () => {
  execFileSync('python3', ['-c', String.raw`
import copy, importlib.util,json,tempfile
from pathlib import Path
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,Path('backend/noltbook')/file)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
r=load('r','reconstruct.py');stage=load('s','stage-source.py');prepare=load('p','prepare-compilation.py')
manifest=json.loads(Path('backend/noltbook/manifest.json').read_text());original=copy.deepcopy(manifest)
media=json.loads(Path('backend/noltbook/media-overlay.json').read_text());recipe=json.loads(Path('backend/noltbook/document-receipts-overlay.json').read_text())
try:r.document_receipts_manifest(manifest)
except ValueError:pass
else:raise AssertionError('Media-less manifest accepted')
effective=copy.deepcopy(manifest);effective['files'][media['path']].update(sha256=media['outputSha256'],bytes=media['outputBytes'])
result=r.document_receipts_manifest(effective)
assert len(result['files'])==40 and manifest==original and len(effective['files'])==39
assert result['documentReceiptsOverlaySHA256']==r.digest(Path('backend/noltbook/document-receipts-overlay.json').read_bytes())
for name,pin in recipe['changes'].items():assert result['files'][name]['sha256']==pin['outputSha256']
for name in effective['files']:
    if name not in recipe['changes']:assert result['files'][name]==effective['files'][name]
for case in ['input','collision','media','identity']:
    bad=copy.deepcopy(effective)
    if case=='input':bad['files']['app/noltbook.hoon']['sha256']='0'*64
    if case=='collision':bad['files']['lib/noltbook-document-receipts.hoon']={'sha256':'0'*64,'bytes':1}
    if case=='media':bad['files'][media['path']]['sha256']='0'*64
    if case=='identity':bad['commit']='different'
    try:r.document_receipts_manifest(bad)
    except ValueError:pass
    else:raise AssertionError(case)
with tempfile.TemporaryDirectory() as tmp:
    root=Path(tmp).resolve()
    for fn in [lambda:stage.stage_source(root/'missing',root/'mount',root/'receipt',document_receipts=True),lambda:prepare.prepare(root/'missing','~zod','test-docs',2,1,root/'out',document_receipts=True)]:
        try:fn()
        except ValueError as error:assert 'media' in str(error)
        else:raise AssertionError('Missing media accepted')
    assert not list(root.iterdir())
`], {cwd: path.resolve(__dirname, '..'), timeout: 15000, stdio: 'pipe'});
});
