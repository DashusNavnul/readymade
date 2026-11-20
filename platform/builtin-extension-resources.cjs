"use strict";
// Packaging-only repairs for the editor pinned by package.sh, which packages the editor's built-in extensions
// beside the editor app instead of inside it (package.sh says why).
//
// 1. Where they are. Each of the editor's programs (main, windows, shared process, terminal host, agent host,
//    command line) computes the folder itself: a `--builtin-extensions-dir` argument, or else `extensions` next to
//    its own code. Here that becomes one fixed place, `Contents/Resources/extensions` of the outer app, and the
//    argument is no longer read. So no way of starting the editor can miss the folder (a second launch handed to an
//    editor already running, the command line run in-process), and no caller can point it at another folder.
// 2. Serving their files. The editor hands files to its own windows only from a short list of folders: its app
//    folder, the person's extensions folder and two storage folders. The built-in folder joins that list. Without
//    it a built-in theme's file-icon font is refused (measured 2026-11-19 in the app's main log:
//    "Refused to load resource …/Contents/Resources/extensions/theme-seti/icons/seti.woff").
const anchor = 'this.addValidFileRoot(e.appRoot),';
const added = 'this.addValidFileRoot(e.builtinExtensionsPath),';
const getter = 'get builtinExtensionsPath(){';
// `let e=this.args["builtin-extensions-dir"];return e?resolve(e):normalize(join(FileAccess.asFileUri("").fsPath,"..","extensions"))`
const located = /get builtinExtensionsPath\(\)\{let ([\w$]+)=this\.args\["builtin-extensions-dir"\];return \1\?[\w$]+\(\1\):([\w$]+\([\w$]+\([\w$]+\.asFileUri\(""\)\.fsPath,)"\.\.","extensions"\)\)\}/g;
// From the editor's `app/out`: app, Resources, Contents, the editor app, then the outer app's Contents/Resources.
const outer = '"..","..","..","..","..","extensions"))}';
/** The file-root list of the main process, with the built-in folder added. */
function patchSource(source) {
  if (source.split(anchor).length !== 2 || source.includes(added) || !source.includes(getter)) {
    throw new Error('Unexpected editor file-root list; package refused.');
  }
  return source.replace(anchor, anchor + added);
}
/** One program's source, with its built-in folder fixed to the outer app's. Refuses any shape but the pinned one. */
function patchLocation(source) {
  const found = [...source.matchAll(located)];
  if (found.length !== 1 || source.split(getter).length !== 2) throw new Error('Unexpected built-in extensions folder code; package refused.');
  return source.replace(located, (_all, _name, head) => getter + 'return ' + head + outer);
}
module.exports = {patchSource, patchLocation, getter};
if (require.main === module) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const app = process.argv[2];
  if (!app || process.argv.length !== 3 || !fs.lstatSync(app).isDirectory()) throw new Error('Expected the editor\'s app folder.');
  const out = path.join(app, 'out'), productFile = path.join(app, 'product.json'), product = JSON.parse(fs.readFileSync(productFile, 'utf8'));
  // The editor compares some of its files with checksums in product.json and calls itself unsupported on a mismatch.
  const checksum = value => crypto.createHash('sha256').update(value).digest('base64').replace(/=+$/, '');
  const programs = [];
  const walk = folder => {
    for (const entry of fs.readdirSync(folder, {withFileTypes: true})) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.js') && fs.readFileSync(file, 'utf8').includes(getter)) programs.push(file);
    }
  };
  walk(out);
  const main = path.join(out, 'mainImpl.js');
  if (!programs.includes(main)) throw new Error('The editor\'s main process does not locate built-in extensions; package refused.');
  for (const file of programs.sort()) {
    const key = path.relative(out, file).split(path.sep).join('/'), source = fs.readFileSync(file, 'utf8'), sealed = product.checksums?.[key] !== undefined;
    if (sealed && product.checksums[key] !== checksum(source)) throw new Error('Editor checksum mismatch before patching: ' + key);
    const located = patchLocation(source), patched = file === main ? patchSource(located) : located;
    fs.writeFileSync(file, patched);
    if (sealed) product.checksums[key] = checksum(patched);
    console.log(key + (sealed ? ' (checksum updated)' : ''));
  }
  fs.writeFileSync(productFile, JSON.stringify(product, null, 2) + '\n');
}
