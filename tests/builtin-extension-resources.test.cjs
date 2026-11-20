const test = require('node:test'), assert = require('node:assert/strict');
const {patchSource} = require('../platform/builtin-extension-resources.cjs');
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
