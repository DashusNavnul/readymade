'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

// These anchors belong to the hash-pinned VSCodium archive in package.sh.
// Refuse changed upstream code rather than guessing another browser's identity.
const anchors = {
  host: 'startCDPSession(){return i._startCDPSession()},close(){return i._close()}',
  main: 'async $closeBrowserTab(e){let t=this._knownBrowsers.get(e);'
};
const nativeReveal = 'async $revealReadymadeBrowserTab(e){const t=this._knownBrowsers.get(e);if(!t)throw new Error("Unknown retained browser");const matches=this.editorService.findEditors(t.input.resource).filter(item=>item.editor===t.input);if(matches.length!==1)throw new Error("Retained browser editor is missing or ambiguous");await this.readymadeNativeHost.focusWindow({targetWindowId:this.editorGroupsService.getPart(matches[0].groupId).windowId});await this.editorService.openEditor(t.input,{preserveFocus:false},matches[0].groupId);const group=this.editorGroupsService.getGroup(matches[0].groupId);if(!group)throw new Error("Retained browser group disappeared");group.focus();const deadline=Date.now()+5000;do{await new Promise(resolve=>setTimeout(resolve,20));if(this._knownBrowsers.get(e)!==t||this.editorGroupsService.getGroup(matches[0].groupId)!==group)throw new Error("Retained browser moved during reveal");if(this.editorGroupsService.activePart===this.editorGroupsService.getPart(matches[0].groupId)&&this.editorGroupsService.activeGroup===group&&group.activeEditor===t.input){await this._syncActiveBrowserTab();return}}while(Date.now()<deadline);throw new Error("Retained browser focus did not settle");}';

function patchSource(source, kind) {
  const anchor = anchors[kind];
  if (!anchor || source.split(anchor).length !== 2 || source.includes('$revealReadymadeBrowserTab')) throw new Error('Unexpected browser reveal source');
  if (kind === 'main') {
    const constructor = 'nui=class extends x{constructor(e,t,i,n,r,a){super();this.editorService=t;';
    const services = 'm(4,Dt),m(5,V)],nui)';
    if (source.split(constructor).length !== 2 || source.split(services).length !== 2) throw new Error('Unexpected browser reveal services');
    source = source.replace(constructor, 'nui=class extends x{constructor(e,t,i,n,r,a,c){super();this.readymadeNativeHost=c;this.editorService=t;')
      .replace(services, 'm(4,Dt),m(5,V),m(6,pe("nativeHostService"))],nui)');
  }
  return source.replace(anchor, kind === 'host'
    ? anchor + ',reveal(){return i._proxy.$revealReadymadeBrowserTab(i.id)}'
    : nativeReveal + anchor);
}

function patchBundle(root) {
  if (!root) throw new Error('Expected staged app root');
  const productFile = path.join(root, 'product.json');
  if (!fs.lstatSync(productFile).isFile()) throw new Error('Expected regular product manifest');
  const product = JSON.parse(fs.readFileSync(productFile, 'utf8'));
  const checksum = source => crypto.createHash('sha256').update(source).digest('base64').replace(/=+$/, '');
  const files = [['host', 'out/vs/workbench/api/node/extensionHostProcess.js'], ['main', 'out/vs/workbench/workbench.desktop.main.js']];
  const changes = files.map(([kind, relative]) => {
    const file = path.join(root, relative);
    if (!fs.lstatSync(file).isFile()) throw new Error('Expected regular upstream source');
    const source = fs.readFileSync(file, 'utf8'), key = relative.slice(4);
    if (product.checksums?.[key] !== checksum(source)) throw new Error('Upstream browser checksum mismatch: ' + key);
    const patched = patchSource(source, kind);
    return {file, source: patched, key, checksum: checksum(patched)};
  });
  // Validate both original files before changing the staged bundle. Retain all
  // other integrity entries; never disable the editor's integrity service.
  for (const change of changes) {
    fs.writeFileSync(change.file, change.source);
    product.checksums[change.key] = change.checksum;
  }
  fs.writeFileSync(productFile, JSON.stringify(product, null, 2) + '\n');
}
module.exports = {patchSource, patchBundle};
if (require.main === module) patchBundle(process.argv[2]);
