// Packaging-only repair for the pinned upstream macOS CLI. Preserve its
// symlink resolution, argument handling and copyright/license header.
const oldRoot = 'echo "${SOURCE_DIR%%${SOURCE_DIR#*.app}}"';
const newRoot = 'echo "${SOURCE_DIR%/Contents/Resources/app/bin}"';
function patchNestedCli(source) {
  if (source.split(oldRoot).length !== 2) throw new Error('Unexpected upstream CLI root discovery; package refused.');
  return source.replace(oldRoot, newRoot);
}
module.exports = {patchNestedCli};
if (require.main === module) {
  const fs = require('node:fs');
  const file = process.argv[2];
  if (!file || process.argv.length !== 3 || !fs.lstatSync(file).isFile()) throw new Error('Expected one regular upstream CLI file.');
  fs.writeFileSync(file, patchNestedCli(fs.readFileSync(file, 'utf8')));
}
