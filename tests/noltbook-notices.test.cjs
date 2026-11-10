const test = require('node:test'), assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
test('notice preparation verifies source identity, retains unresolved files and refuses corrupt inputs before output', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util, pathlib, tempfile, tarfile, io, json, hashlib
spec=importlib.util.spec_from_file_location('notices','backend/noltbook/prepare-notices.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
h=lambda b:hashlib.sha256(b).hexdigest()
with tempfile.TemporaryDirectory() as temporary:
 root=pathlib.Path(temporary);here=root/'noltbook';up=root/'upstream';here.mkdir();up.mkdir()
 def archive(file,entries):
  with tarfile.open(file,'w') as t:
   for name,data in entries.items():
    member=tarfile.TarInfo(name);member.size=len(data);t.addfile(member,io.BytesIO(data))
 source=root/'source.tar';stock=root/'stock.tar'
 archive(source,{'a':b'inherited','b':b'original'})
 archive(stock,{'old/a':b'inherited','LICENSE':b'original upstream notice'})
 nm={'commit':'n','archiveSha256':h(source.read_bytes()),'files':{k:{'archivePath':k,'bytes':len(v),'sha256':h(v)} for k,v in {'a':b'inherited','b':b'original'}.items()}}
 um={'commit':'u','archiveSha256':h(stock.read_bytes()),'files':{'a':{'archivePath':'old/a','upstreamSha256':h(b'inherited')}},'licenses':{'NOTICE.txt':{'archivePath':'LICENSE','sha256':h(b'original upstream notice')}}}
 (here/'manifest.json').write_text(json.dumps(nm));(up/'manifest.json').write_text(json.dumps(um));(up/'NOTICE.txt').write_bytes(b'original upstream notice')
 report=m.prepare(source,stock,root/'good',here)
 assert list(report['exactInheritedFiles'])==['a'] and report['unresolvedFiles']==['b']
 assert report['fullNoticeCoverage'] is False and report['releaseApproved'] is False
 assert (root/'good/NOTICE.txt').read_bytes()==b'original upstream notice'
 def refuse(out):
  try:m.prepare(source,stock,out,here)
  except ValueError:return
  raise AssertionError('corrupt input accepted')
 refuse(root/'good')
 old=source.read_bytes();source.write_bytes(old+b'corrupt');refuse(root/'bad-archive');assert not (root/'bad-archive').exists();source.write_bytes(old)
 nm['files']['a']['sha256']='0'*64;(here/'manifest.json').write_text(json.dumps(nm));refuse(root/'bad-source');assert not (root/'bad-source').exists()
 nm['files']['a']['sha256']=h(b'inherited');(here/'manifest.json').write_text(json.dumps(nm))
 (up/'NOTICE.txt').write_bytes(b'changed');refuse(root/'bad-notice');assert not (root/'bad-notice').exists()
`], {cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
});

test('derived notices require exact original bytes, edit contexts and final output while preserving unresolved files', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util, pathlib, tempfile, tarfile, io, json, hashlib, copy
spec=importlib.util.spec_from_file_location('notices','backend/noltbook/prepare-notices.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
h=lambda b:hashlib.sha256(b).hexdigest()
with tempfile.TemporaryDirectory() as temporary:
 root=pathlib.Path(temporary);here=root/'noltbook';up=root/'upstream';here.mkdir();up.mkdir()
 original=b'alpha\\nold\\nomega\\n';derived=b'alpha\\nnew\\nomega\\n';notice=b'original upstream notice'
 def archive(file,entries):
  with tarfile.open(file,'w') as t:
   for name,data in entries.items():
    member=tarfile.TarInfo(name);member.size=len(data);t.addfile(member,io.BytesIO(data))
 source=root/'source.tar';stock=root/'stock.tar';archive(source,{'derived':derived,'unknown':b'unknown'});archive(stock,{'original':original,'LICENSE':notice})
 nm={'commit':'n','archiveSha256':h(source.read_bytes()),'files':{k:{'archivePath':k,'bytes':len(v),'sha256':h(v)} for k,v in {'derived':derived,'unknown':b'unknown'}.items()}}
 pin={'archivePath':'original','upstreamSha256':h(original),'candidateSha256':h(derived),'transform':'exact-line-splices-v1','edits':[{'start':1,'end':2,'old':['old\\n'],'new':['new\\n']}]}
 um={'commit':'u','archiveSha256':h(stock.read_bytes()),'files':{'derived':pin},'licenses':{'NOTICE.txt':{'archivePath':'LICENSE','sha256':h(notice)}}}
 (here/'manifest.json').write_text(json.dumps(nm));(up/'manifest.json').write_text(json.dumps(um));(up/'NOTICE.txt').write_bytes(notice)
 r=m.prepare(source,stock,root/'good',here)
 assert r['schema']=='readymade-noltbook-inherited-notices-v2'
 assert r['exactInheritedFiles']=={} and list(r['derivedInheritedFiles'])==['derived'] and r['unresolvedFiles']==['unknown']
 assert r['derivedInheritedFiles']['derived']['derivations']==[pin]
 assert r['upstreamManifestSHA256']==h((up/'manifest.json').read_bytes())
 assert r['releaseApproved'] is False and r['fullNoticeCoverage'] is False
 assert (root/'good/NOTICE.txt').read_bytes()==notice
 for index,kind in enumerate(['original','context','output','transform','overlap']):
  bad=copy.deepcopy(um);p=bad['files']['derived']
  if kind=='original':p['upstreamSha256']='0'*64
  if kind=='context':p['edits'][0]['old']=['wrong\\n']
  if kind=='output':p['edits'][0]['new']=['wrong\\n']
  if kind=='transform':p['transform']='unknown'
  if kind=='overlap':p['edits'].append(copy.deepcopy(p['edits'][0]))
  (up/'manifest.json').write_text(json.dumps(bad));out=root/('bad-'+str(index))
  try:m.prepare(source,stock,out,here)
  except ValueError:pass
  else:raise AssertionError('invalid derivation accepted: '+kind)
  assert not out.exists()
`], {cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
});
