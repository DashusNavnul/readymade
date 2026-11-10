"use strict";
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

// Exact completion paths in the VSCodium archive pinned by package.sh.
// Auto-closing terminals must never enter either the shared or dedicated reuse cache.
const anchors = ['T!==void 0)switch(e.command.presentation.panel)', 'C!==void 0)switch(e.command.presentation.panel)'];
function patchSource(source) {
  for (const anchor of anchors) {
    if (source.split(anchor).length !== 2) throw new Error('Unexpected task terminal completion source');
  }
  for (const anchor of anchors) source = source.replace(anchor, anchor.replace(')switch', '&&e.command.presentation.close!==true)switch'));
  return source;
}
function patchBundle(root) {
  const file = path.join(root, 'out/vs/workbench/workbench.desktop.main.js');
  const manifest = path.join(root, 'product.json');
  const key = 'vs/workbench/workbench.desktop.main.js';
  const checksum = value => crypto.createHash('sha256').update(value).digest('base64').replace(/=+$/, '');
  const source = fs.readFileSync(file, 'utf8'), product = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (product.checksums?.[key] !== checksum(source)) throw new Error('Task terminal checksum mismatch');
  const patched = patchSource(source);
  fs.writeFileSync(file, patched);
  product.checksums[key] = checksum(patched);
  fs.writeFileSync(manifest, JSON.stringify(product, null, 2) + '\n');
}
module.exports = {patchSource, patchBundle};
if (require.main === module) patchBundle(process.argv[2]);
