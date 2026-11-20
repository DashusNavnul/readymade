const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const {patchSource, patchLocation} = require('../platform/builtin-extension-resources.cjs');
// The shape of the pinned editor's code: one service lists the folders it serves, another knows where the built-in extensions are.
const source = 'class Environment{constructor(dir){this.appRoot="/app";this.extensionsPath="/person";this.dir=dir}get builtinExtensionsPath(){return this.dir??"/app/extensions"}}'
  + 'class Files{constructor(e){this.roots=[];this.addValidFileRoot(e.appRoot),this.addValidFileRoot(e.extensionsPath)}addValidFileRoot(root){this.roots.push(root)}}';
const roots = (code, dir) => new Function(code + ';return new Files(new Environment(' + JSON.stringify(dir) + ')).roots;')();
test('the editor serves files from the built-in extensions folder, wherever packaging put it', () => {
  assert.deepEqual(roots(source, '/outer/extensions'), ['/app', '/person'], 'unpatched: a folder outside the app is not served');
  assert.deepEqual(roots(patchSource(source), '/outer/extensions'), ['/app', '/outer/extensions', '/person']);
  assert.deepEqual(roots(patchSource(source)), ['/app', '/app/extensions', '/person'], 'the default place stays served');
});
test('the patch refuses a changed, duplicated or already patched file-root list', () => {
  assert.throws(() => patchSource(source.replace('e.appRoot),', 'e.appRoot);')), /Unexpected/);
  assert.throws(() => patchSource(source + source), /Unexpected/);
  assert.throws(() => patchSource(patchSource(source)), /Unexpected/);
  assert.throws(() => patchSource(source.replace('get builtinExtensionsPath(){', 'get builtInPath(){')), /Unexpected/);
});
// The getter as the pinned editor ships it (two of its seven programs, with their own minified names).
const located = name => `class E{constructor(a){this.args=a}get builtinExtensionsPath(){let ${name}=this.args["builtin-extensions-dir"];return ${name}?Ct(${name}):Ne(D(tt.asFileUri("").fsPath,"..","extensions"))}get other(){return 1}}`;
const where = (code, args, out) => new Function('Ct', 'Ne', 'D', 'tt', code + ';return new E(' + JSON.stringify(args) + ').builtinExtensionsPath;')(
  path.resolve, path.normalize, path.join, {asFileUri: () => ({fsPath: out})});
const out = '/Applications/Readymade Workspace.app/Contents/Resources/VSCodium.app/Contents/Resources/app/out';
test('every program of the editor finds its built-in extensions in the outer app, whatever it is started with', () => {
  assert.equal(where(located('e'), {}, out), '/Applications/Readymade Workspace.app/Contents/Resources/VSCodium.app/Contents/Resources/app/extensions', 'unpatched: inside the editor app');
  assert.equal(where(located('e'), {'builtin-extensions-dir': '/elsewhere'}, out), '/elsewhere', 'unpatched: wherever the caller says');
  for (const name of ['e', 'n', '$o']) {
    const patched = patchLocation(located(name));
    assert.equal(where(patched, {}, out), '/Applications/Readymade Workspace.app/Contents/Resources/extensions');
    assert.equal(where(patched, {'builtin-extensions-dir': '/elsewhere'}, out), '/Applications/Readymade Workspace.app/Contents/Resources/extensions', 'a caller cannot name another folder');
    assert.equal(where(patched, {'builtin-extensions-dir': false}, out), '/Applications/Readymade Workspace.app/Contents/Resources/extensions');
    assert.match(patched, /get other\(\)\{return 1\}\}$/, 'the code after the getter is untouched');
  }
});
test('the folder patch refuses any shape but the pinned one', () => {
  assert.throws(() => patchLocation(located('e') + located('e')), /Unexpected/, 'two getters');
  assert.throws(() => patchLocation(patchLocation(located('e'))), /Unexpected/, 'already patched');
  assert.throws(() => patchLocation(located('e').replace('"..","extensions"', '"..","..","extensions"')), /Unexpected/, 'another default');
  assert.throws(() => patchLocation(located('e').replace('this.args["builtin-extensions-dir"]', 'this.args.builtin')), /Unexpected/, 'another argument');
  assert.throws(() => patchLocation('class E{}'), /Unexpected/, 'no getter');
});
