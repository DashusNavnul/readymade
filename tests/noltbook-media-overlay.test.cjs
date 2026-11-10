const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
test('Media overlay refuses changed source, ambiguous edits and unpinned output', () => {
  const script = String.raw`
import copy, importlib.util
spec=importlib.util.spec_from_file_location('reconstruct','backend/noltbook/reconstruct.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
old=b'one\ntwo\nthree\n';new=b'one\nfixed\nthree\n'
r={'schema':'readymade-noltbook-media-overlay-v1','path':'lib/noltbook/index.html',
   'inputSha256':m.digest(old),'outputSha256':m.digest(new),'outputBytes':len(new),
   'edits':[{'before':'two\n','after':'fixed\n'}]}
assert m.apply_media_overlay(old,r)==new
for case in ['source','schema','path','missing','empty','ambiguous','output-hash','output-size','second-apply']:
    data=old;recipe=copy.deepcopy(r)
    if case=='source':data+=b'changed'
    if case=='schema':recipe['schema']='unknown'
    if case=='path':recipe['path']='app/noltbook.hoon'
    if case=='missing':recipe['edits'][0]['before']='absent'
    if case=='empty':recipe['edits'][0]['before']=''
    if case=='ambiguous':
        data=old+old;recipe['inputSha256']=m.digest(data)
    if case=='output-hash':recipe['outputSha256']='0'*64
    if case=='output-size':recipe['outputBytes']+=1
    if case=='second-apply':data=new
    try:m.apply_media_overlay(data,recipe)
    except ValueError:pass
    else:raise AssertionError('Accepted '+case)
print('Pinned overlay and nine refusal cases passed')
`;
  const result = spawnSync('python3', ['-c', script], {cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/nine refusal cases passed/);
});

function composer(storage = new Map(), ship = 'let') {
  const vm = require('node:vm');
  const recipe = require('../backend/noltbook/media-overlay.json');
  const edit = recipe.edits.find(e => e.before === 'function handleComposerInput(el){');
  const source = edit.after.slice(0, -edit.before.length);
  const elements = new Map();
  for (const id of ['chatInput', 'replyLabel', 'replyBar', 'chatInputArea']) elements.set(id, {
    value: '', textContent: '', classList: {toggle(_name, value) { this.visible = value; }},
    appendChild(el) { elements.set(el.id, el); }
  });
  const events = {};
  const context = vm.createContext({api: {ship}, state: {currentNoteId: 'first'},
    document: {getElementById: id => elements.get(id), createElement: () => ({setAttribute() {}})},
    localStorage: {getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k)},
    window: {addEventListener: (name, fn) => { events[name] = fn; }},
    autoResize() {}, updateInputMirror() {}
  });
  vm.runInContext(source, context);
  return {context, elements, events, storage, input: elements.get('chatInput'),
    run: code => vm.runInContext(code, context)};
}

test('unsent Unicode composer restores after a new page and isolates ships and notes', () => {
  const a = composer(); a.run("restoreComposerDraft('first')");
  a.input.value = 'Draft 🜁\nsecond line'; a.events.pagehide();
  const b = composer(a.storage); b.run("restoreComposerDraft('first')");
  assert.equal(b.input.value, a.input.value);
  b.context.state.currentNoteId = 'second'; b.run("restoreComposerDraft('second')");
  assert.equal(b.input.value, '');
  const other = composer(a.storage, 'zod'); other.run("restoreComposerDraft('first')");
  assert.equal(other.input.value, '');
});

test('reply and edit targets retain their exact identities and visible composer mode', () => {
  const a = composer(); a.run("restoreComposerDraft('first')");
  Object.assign(a.context.state, {replyingTo: 42, replyingToEid: 'reply-eid', editingMsgId: 17, editingEid: 'edit-eid'});
  a.elements.get('replyLabel').textContent = '↩ replying to ~zod';
  a.input.value = 'edited draft'; a.run('saveComposerDraft()');
  const b = composer(a.storage); b.run("restoreComposerDraft('first')");
  for (const key of ['replyingTo', 'replyingToEid', 'editingMsgId', 'editingEid']) assert.equal(b.context.state[key], a.context.state[key]);
  assert.equal(b.elements.get('replyBar').classList.visible, true);
  assert.equal(b.elements.get('replyLabel').textContent, '↩ replying to ~zod');
  assert.match(b.input.placeholder, /editing message/);
});

test('cleared submitted text stays cleared while newer typing survives', () => {
  const a = composer(); a.run("restoreComposerDraft('first')");
  a.input.value = 'send this'; a.run('saveComposerDraft()');
  a.input.value = ''; a.run('saveComposerDraft()');
  const b = composer(a.storage); b.run("restoreComposerDraft('first')"); assert.equal(b.input.value, '');
  a.input.value = 'new typing'; a.run('saveComposerDraft()');
  b.run("restoreComposerDraft('first')"); assert.equal(b.input.value, 'new typing');
});

test('storage failures are visible and corrupt copies are never overwritten by restore', () => {
  const a = composer(); a.run("restoreComposerDraft('first')"); a.input.value = 'keep me';
  a.context.localStorage.setItem = () => { throw Error('quota'); };
  assert.equal(a.run('saveComposerDraft()'), false);
  assert.equal(a.input.value, 'keep me'); assert.match(a.elements.get('composerDraftWarning').textContent, /Copy your text/);
  const key = a.run("composerDraftKey('second')"); a.storage.set(key, 'corrupt');
  assert.throws(() => a.run("restoreComposerDraft('second')"));
  assert.equal(a.storage.get(key), 'corrupt'); assert.equal(a.input.value, 'keep me');
});

test('permission refresh keeps the restored edit prompt and resets it for a normal message', () => {
  const a = composer(); a.run("restoreComposerDraft('first')");
  a.input.style = {}; a.context.inp = a.input;
  const edit = require('../backend/noltbook/media-overlay.json').edits.find(e => e.before.includes("inp.disabled=false;inp.placeholder='message...';"));
  assert.ok(edit, 'permission refresh must preserve composer mode');
  a.context.state.editingMsgId = 17;
  a.run(edit.after); assert.match(a.input.placeholder, /editing message/);
  a.context.state.editingMsgId = null;
  a.run(edit.after); assert.equal(a.input.placeholder, 'message...');
});

test('Document receipt overlay reproduces five pinned changes and refuses drift or collisions', () => {
  const script = String.raw`
import copy, importlib.util, json
from pathlib import Path
spec=importlib.util.spec_from_file_location('reconstruct','backend/noltbook/reconstruct.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
recipe=json.loads(Path('backend/noltbook/document-receipts-overlay.json').read_text())
original=b'first\nold\nlast\n';updated=b'first\nnew\nlast\n'
base={f'unchanged/{i}.hoon':b'untouched' for i in range(35)}
for name,pin in recipe['changes'].items():
    pin.clear();pin.update(inputSha256=None if name.startswith('lib/') else m.digest(original),outputSha256=m.digest(updated),outputBytes=len(updated))
    if name.startswith('lib/'):pin['create']=updated.decode()
    else:
        base[name]=original;pin['edits']=[dict(start=1,end=2,old=['old\n'],new=['new\n'])]
result=m.apply_document_receipts(base,recipe)
assert len(base)==39 and len(result)==40
assert all(result[n]==updated for n in recipe['changes'])
assert all(result[n]==b for n,b in base.items() if n.startswith('unchanged/'))
for case in ['input','collision','path','context','overlap','hash','size','media','count']:
    source=dict(base);r=copy.deepcopy(recipe);name='app/noltbook.hoon'
    if case=='input':source[name]+=b'drift'
    if case=='collision':source['lib/noltbook-document-receipts.hoon']=b'foreign'
    if case=='path':r['changes']['../bad.hoon']=r['changes'].pop(name)
    if case=='context':r['changes'][name]['edits'][0]['old']=['wrong\n']
    if case=='overlap':r['changes'][name]['edits']*=2
    if case=='hash':r['changes'][name]['outputSha256']='0'*64
    if case=='size':r['changes'][name]['outputBytes']+=1
    if case=='media':r['baseMediaOverlaySHA256']='0'*64
    if case=='count':r['sourceFileCount']=41
    try:m.apply_document_receipts(source,r)
    except ValueError:pass
    else:raise AssertionError(case)
print('Receipt overlay reproduction and refusal checks passed')
`;
  const result = spawnSync('python3', ['-c', script], {cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:30000});
  assert.equal(result.status, 0, result.stderr);
  const missingMedia = spawnSync('python3', ['backend/noltbook/reconstruct.py', 'absent.tar.gz', 'unused-output', '--document-receipts'], {cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:30000});
  assert.notEqual(missingMedia.status, 0); assert.match(missingMedia.stderr, /requires --readymade-media/);
});
