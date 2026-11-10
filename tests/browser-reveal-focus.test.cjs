'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const {patchSource} = require('../platform/browser-reveal.cjs');
function fixture(change) {
  const source = 'nui=class extends x{constructor(e,t,i,n,r,a){super();this.editorService=t; async $closeBrowserTab(e){let t=this._knownBrowsers.get(e); m(4,Dt),m(5,V)],nui)';
  const patched = patchSource(source, 'main');
  const start = patched.indexOf('async $revealReadymadeBrowserTab('), end = patched.indexOf('async $closeBrowserTab(');
  let now = 0, synced = 0, focuses = 0;
  const input = {resource: {}}, browser = {input}, main = {windowId: 1}, floating = {windowId: 2};
  const group = {id: 4, activeEditor: input, focus() { focuses++; }};
  const groups = {activePart: main, activeGroup: {id: 0}, getGroup: () => group, getPart: () => floating};
  const context = {
    _knownBrowsers: new Map([[9, browser]]), editorGroupsService: groups,
    editorService: {findEditors: () => [{editor: input, groupId: 4}], openEditor: async () => {}},
    readymadeNativeHost: {focusWindow: async options => assert.deepEqual(options.targetWindowId, 2)},
    _syncActiveBrowserTab: async () => { synced++; }
  };
  const methods = vm.runInNewContext('({' + patched.slice(start, end) + '})', {
    Date: {now: () => now},
    setTimeout: (resolve, ms) => { now += ms; change({now, groups, group, floating, context}); queueMicrotask(resolve); }
  });
  return {run: () => methods.$revealReadymadeBrowserTab.call(context, 9), state: () => ({now, synced, focuses})};
}
test('native reveal waits for delayed native window and editor group focus before resolving', async () => {
  const f = fixture(({now, groups, group, floating}) => {
    if (now >= 60) groups.activePart = floating;
    if (now >= 100) groups.activeGroup = group;
  });
  await f.run();
  assert.deepEqual(f.state(), {now: 100, synced: 1, focuses: 1});
});
test('native reveal refuses unsettled focus instead of running the next command in another window', async () => {
  const f = fixture(() => {});
  await assert.rejects(f.run(), /focus did not settle/);
  assert.deepEqual(f.state(), {now: 5000, synced: 0, focuses: 1});
});
test('native reveal refuses a tab removed while waiting without refocusing or navigating again', async () => {
  const f = fixture(({context}) => context._knownBrowsers.delete(9));
  await assert.rejects(f.run(), /moved during reveal/);
  assert.deepEqual(f.state(), {now: 20, synced: 0, focuses: 1});
});
