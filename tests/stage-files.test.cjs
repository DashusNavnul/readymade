const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');

test('mount staging preserves originals and refuses unsafe or incomplete input before writes', () => {
  const script = String.raw`
import importlib.util, json, os, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('stage_files', 'backend/install/stage-files.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def setup(root):
    source, mount, receipt = [root/n for n in ['source','mount','receipt']]
    source.mkdir(); mount.mkdir(); (source/'lib').mkdir(); (mount/'lib').mkdir()
    (source/'lib/a.hoon').write_bytes(b'new'); (source/'desk.bill').write_bytes(b'~[]')
    (mount/'lib/a.hoon').write_bytes(b'old')
    manifest = {'schema':'readymade-backend-assembly-v1','files':{
        n:{'bytes':len(d),'sha256':m.digest(d)} for n,d in m.inventory(source)[0].items()}}
    return manifest, source, mount, receipt
def capture(root):
    return {p.relative_to(root).as_posix(): (os.readlink(p) if p.is_symlink() else
        p.read_bytes() if p.is_file() else 'directory') for p in root.rglob('*')}
with tempfile.TemporaryDirectory() as temp:
    args = setup(Path(temp)); manifest,source,mount,receipt = args
    assert m.stage(*args) == 2
    assert m.inventory(mount) == m.inventory(source)
    assert (receipt/'originals/lib/a.hoon').read_bytes() == b'old'
    assert (receipt.stat().st_mode & 0o777) == 0o700
    assert ((receipt/'originals/lib/a.hoon').stat().st_mode & 0o777) == 0o600
    assert json.loads((receipt/'complete.json').read_text())['nativeCommitSubmitted'] is False
    before = capture(mount)
    try: m.stage(*args)
    except ValueError: pass
    else: raise AssertionError('Existing receipt accepted')
    assert capture(mount) == before
cases = ['hash','missing','extra-source','extra-mount','empty-directory','symlink-source',
         'symlink-mount','hardlink-mount','source-root-link','mount-root-link','nested-receipt',
         'same-root','traversal','obstructed-directory']
for case in cases:
    with tempfile.TemporaryDirectory() as temp:
        root=Path(temp); manifest,source,mount,receipt=setup(root)
        if case=='hash': (source/'lib/a.hoon').write_bytes(b'bad')
        if case=='missing': (source/'desk.bill').unlink()
        if case=='extra-source': (source/'extra').write_bytes(b'x')
        if case=='extra-mount': (mount/'extra').write_bytes(b'x')
        if case=='empty-directory': (mount/'unexpected').mkdir()
        if case=='symlink-source':
            (source/'desk.bill').unlink(); (source/'desk.bill').symlink_to(mount/'lib/a.hoon')
        if case=='symlink-mount':
            (mount/'lib/a.hoon').unlink(); (mount/'lib/a.hoon').symlink_to(source/'lib/a.hoon')
        if case=='hardlink-mount':
            (mount/'lib/a.hoon').unlink(); os.link(source/'lib/a.hoon',mount/'lib/a.hoon')
        if case=='source-root-link':
            (root/'linked').symlink_to(source); source=root/'linked'
        if case=='mount-root-link':
            (root/'linked').symlink_to(mount); mount=root/'linked'
        if case=='nested-receipt': receipt=mount/'receipt'
        if case=='same-root': source=mount
        if case=='traversal': manifest['files']['../bad']={'bytes':0,'sha256':m.digest(b'')}
        if case=='obstructed-directory':
            (mount/'lib/a.hoon').unlink(); (mount/'lib').rmdir(); (mount/'lib').write_bytes(b'x')
        before=capture(mount)
        try: m.stage(manifest,source,mount,receipt)
        except ValueError: pass
        else: raise AssertionError('Accepted '+case)
        assert capture(mount)==before, case
        assert not receipt.exists(), case
# Simulate a write failure after preflight; retain originals and never claim completion.
with tempfile.TemporaryDirectory() as temp:
    args=setup(Path(temp)); original=m.os.replace
    def fail(*unused): raise OSError('injected write failure')
    m.os.replace=fail
    try:
        try: m.stage(*args)
        except OSError: pass
        else: raise AssertionError('Failure swallowed')
    finally: m.os.replace=original
    assert (args[3]/'plan.json').exists()
    assert (args[3]/'originals/lib/a.hoon').read_bytes()==b'old'
    assert not (args[3]/'complete.json').exists()
print('success, 14 adverse preflights and interrupted-write retention passed')
`;
  const result = spawnSync('python3', ['-c', script], {cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000});
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /14 adverse preflights/);
});
