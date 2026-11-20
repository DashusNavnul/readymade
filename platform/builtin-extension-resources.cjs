"use strict";
// Packaging-only repair for the main process of the editor pinned by package.sh (out/mainImpl.js).
// The editor hands files to its own windows only from a short list of folders: its app folder, the person's
// extensions folder and two storage folders. Its built-in extensions normally sit inside the app folder.
// Readymade packages them beside the editor app (package.sh says why), so that folder joins the list.
// Without it a built-in theme's file-icon font is refused (measured 2026-11-19 in the app's main log:
// "Refused to load resource …/Contents/Resources/extensions/theme-seti/icons/seti.woff").
const anchor = 'this.addValidFileRoot(e.appRoot),';
const added = 'this.addValidFileRoot(e.builtinExtensionsPath),';
function patchSource(source) {
  if (source.split(anchor).length !== 2 || source.includes(added) || !source.includes('get builtinExtensionsPath(){')) {
    throw new Error('Unexpected editor file-root list; package refused.');
  }
  return source.replace(anchor, anchor + added);
}
module.exports = {patchSource};
if (require.main === module) {
  const fs = require('node:fs');
  const file = process.argv[2];
  if (!file || process.argv.length !== 3 || !fs.lstatSync(file).isFile()) throw new Error('Expected one regular editor main-process file.');
  fs.writeFileSync(file, patchSource(fs.readFileSync(file, 'utf8')));
}
