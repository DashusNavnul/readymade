'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
const url = 'about:blank#readymade-' + 'a'.repeat(32);
const api = { window: {}, commands: { executeCommand: async command => { assert.equal(command, 'workbench.action.keepEditor'); } }, workspace: { getConfiguration: () => ({ get: () => 'ephemeral', inspect: () => ({}), update: async () => {} }) },
  ViewColumn: { Beside: 2 }, ConfigurationTarget: { Global: 1 } };
const original = Module._load;
let NativeMediaBrowser;
try {
  Module._load = function (name, ...args) { return name === 'vscode' ? api : original.call(this, name, ...args); };
  ({ NativeMediaBrowser } = require('../dist/src/media-browser.js'));
} finally { Module._load = original; }
function fixture(request) {
  let closes = 0;
  const tab = { url, close: async () => { closes++; api.window.browserTabs = []; } }, editor = {};
  api.window.browserTabs = []; api.window.tabGroups = {all: [], activeTabGroup: {}};
  api.window.openBrowserTab = async () => {
    api.window.browserTabs = [tab]; api.window.activeBrowserTab = tab;
    api.window.tabGroups = { all: [], activeTabGroup: { activeTab: editor } }; return tab;
  };
  return { tab, browser: new NativeMediaBrowser({ request }), closes: () => closes };
}
test('native bootstrap readiness waits for the exact native navigation to finish before returning, without mutation or reload', async () => {
  const operations = []; let reads = 0;
  const f = fixture(async op => { operations.push(op); return { bootstrapViews: [{ url, bootstrapLoaded: ++reads >= 3 }] }; });
  assert.equal(await f.browser.open(url), f.tab); assert.equal(reads, 3);
  assert.deepEqual(operations, ['status', 'status', 'status']); assert.equal(f.closes(), 0);
  assert.equal(f.browser.isActive(f.tab), true); assert.equal(f.browser.retained(url), undefined);
});
test('ambiguous native bootstrap fails without binding or closing the retained new tab', async () => {
  const f = fixture(async op => { assert.equal(op, 'status'); return { bootstrapViews: [{ url }, { url }] }; });
  await assert.rejects(f.browser.open(url), /More than one native browser/);
  assert.equal(f.browser.retained(url), f.tab); assert.equal(f.closes(), 0);
});
test('a hung read expires within the finite readiness window and retains its exact owned tab', { timeout: 7000 }, async () => {
  let reads = 0;
  const f = fixture(op => { assert.equal(op, 'status'); reads++; return new Promise(() => {}); });
  const started = Date.now(); await assert.rejects(f.browser.open(url), /readiness timed out/);
  assert(Date.now() - started >= 4900 && Date.now() - started < 6500);
  assert.equal(reads, 1); assert.equal(f.browser.retained(url), f.tab); assert.equal(f.closes(), 0);
  await f.browser.close(f.tab); assert.equal(f.browser.retained(url), undefined);
});
test('repeated successful opens do not accumulate handles; failed closed tabs are pruned', async () => {
  let currentURL;
  const f = fixture(async () => ({ bootstrapViews: [{ url: currentURL, bootstrapLoaded: true }] }));
  const open = api.window.openBrowserTab;
  api.window.openBrowserTab = async next => { currentURL = next; return open(next); };
  for (let index = 0; index < 100; index++) {
    const next = 'about:blank#readymade-' + index.toString(16).padStart(32, '0');
    assert.equal(await f.browser.open(next), f.tab); await f.browser.close(f.tab);
  }
  assert.equal(f.browser.created.size, 0); assert.equal(f.closes(), 100);
  const failed = fixture(async () => ({ bootstrapViews: [{ url }, { url }] }));
  await assert.rejects(failed.browser.open(url)); assert.equal(failed.browser.created.size, 1);
  api.window.browserTabs = []; await failed.browser.close(failed.tab);
  assert.equal(failed.browser.created.size, 0); assert.equal(failed.closes(), 0);
});

test('browser activation waits for its new editor instead of binding the previously active editor', async () => {
  const f = fixture(async () => ({bootstrapViews: [{url, bootstrapLoaded: true}]}));
  const old = {}, fresh = {};
  api.window.tabGroups = {all: [{tabs: [old]}], activeTabGroup: {activeTab: old}};
  api.window.openBrowserTab = async () => {
    api.window.browserTabs = [f.tab]; api.window.activeBrowserTab = f.tab;
    setTimeout(() => { api.window.tabGroups.activeTabGroup.activeTab = fresh; }, 100);
    return f.tab;
  };
  assert.equal(await f.browser.open(url), f.tab);
  assert.equal(f.browser.editors.get(f.tab), fresh);
});

test('opening a second browser reveals its exact identity when the first retains focus', async () => {
  const f = fixture(async () => ({bootstrapViews: [{url, bootstrapLoaded: true}]}));
  const old = {}, fresh = {}, previousBrowser = {url};
  const group = {tabs: [old], activeTab: old};
  api.window.tabGroups = {all: [group], activeTabGroup: group};
  let reveals = 0;
  f.tab.reveal = async () => {
    reveals++;
    api.window.activeBrowserTab = f.tab;
    group.activeTab = fresh;
  };
  api.window.openBrowserTab = async () => {
    api.window.browserTabs = [previousBrowser, f.tab];
    api.window.activeBrowserTab = previousBrowser;
    group.tabs.push(fresh);
    return f.tab;
  };
  assert.equal(await f.browser.open(url), f.tab);
  assert.equal(reveals, 1);
  assert.equal(f.browser.editors.get(f.tab), fresh);
  assert.equal(f.closes(), 0);
});

test('moving an app replaces its editor handle without replacing the browser page', async () => {
  const f = fixture(async () => ({bootstrapViews: [{url, bootstrapLoaded: true}]}));
  await f.browser.open(url);
  const old = f.browser.editors.get(f.tab), moved = {label: 'Glurff'};
  const group = {tabs: [moved], activeTab: moved};
  api.window.tabGroups = {all: [group], activeTabGroup: group};
  await f.browser.reveal(f.tab);
  assert.equal(f.browser.editors.get(f.tab), moved);
  assert.equal(f.browser.companionEditors.has(old), false);
  assert.equal(f.closes(), 0);
});

test('reveal finds the moved browser by identity despite another app with the same title and URL', async () => {
  const f = fixture(async () => ({bootstrapViews: [{url, bootstrapLoaded: true}]}));
  await f.browser.open(url);
  const other = {url, title: 'Glurff'}, wrong = {label: 'Glurff'}, moved = {label: 'Glurff'};
  const groups = [{viewColumn: 1, tabs: [wrong], activeTab: wrong}, {viewColumn: 2, tabs: [moved], activeTab: moved}];
  api.window.browserTabs = [other, f.tab]; api.window.activeBrowserTab = other;
  api.window.tabGroups = {all: groups, activeTabGroup: groups[0]};
  const execute = api.commands.executeCommand;
  api.commands.executeCommand = async command => {
    if (command === 'workbench.action.focusNextGroup') setTimeout(() => {
      api.window.tabGroups.activeTabGroup = groups[1]; api.window.activeBrowserTab = f.tab;
    }, 20);
  };
  try {
    await f.browser.reveal(f.tab);
    assert.equal(f.browser.editors.get(f.tab), moved); assert.equal(f.closes(), 0);
  } finally { api.commands.executeCommand = execute; }
});

test('reveal skips ordinary files and does not bind stale browser activation to a file tab', {timeout: 1500}, async () => {
  const f = fixture(async () => ({bootstrapViews: [{url, bootstrapLoaded: true}]}));
  await f.browser.open(url);
  const moved = {}, editors = [...Array.from({length: 40}, () => ({input: {uri: 'file:///fixture'}})), moved];
  const group = {tabs: editors, activeTab: editors[0]};
  api.window.tabGroups = {all: [group], activeTabGroup: group};
  // Deliberately retain the old browser activation while a known file is active.
  api.window.activeBrowserTab = f.tab;
  const execute = api.commands.executeCommand;
  api.commands.executeCommand = async command => {
    if (command === 'workbench.action.firstEditorInGroup') group.activeTab = editors[0];
    if (command === 'workbench.action.nextEditorInGroup') group.activeTab = editors[editors.indexOf(group.activeTab) + 1];
  };
  try {
    await f.browser.reveal(f.tab);
    assert.equal(f.browser.editors.get(f.tab), moved); assert.equal(f.closes(), 0);
  } finally { api.commands.executeCommand = execute; }
});

test('reveal re-observes groups when a focus command makes no transition during a window move', async () => {
  const f = fixture(async () => ({bootstrapViews: [{url, bootstrapLoaded: true}]}));
  await f.browser.open(url);
  const file = {input: {uri: 'file:///code'}}, moved = {};
  const groups = [{tabs: [file], activeTab: file}, {tabs: [moved], activeTab: moved}];
  api.window.tabGroups = {all: groups, activeTabGroup: groups[0]};
  api.window.activeBrowserTab = undefined;
  const execute = api.commands.executeCommand; let focuses = 0;
  api.commands.executeCommand = async command => {
    if (command === 'workbench.action.focusNextGroup' && ++focuses === 2) {
      api.window.tabGroups.activeTabGroup = groups[1]; api.window.activeBrowserTab = f.tab;
    }
  };
  try {
    await f.browser.reveal(f.tab);
    assert.equal(focuses, 2); assert.equal(f.browser.editors.get(f.tab), moved);
    assert.equal(f.closes(), 0);
  } finally { api.commands.executeCommand = execute; }
});

test('native reveal selects the retained tab without consulting stale group state or issuing navigation', async () => {
  const f = fixture(async () => ({bootstrapViews: [{url, bootstrapLoaded: true}]}));
  await f.browser.open(url); let reveals = 0;
  f.tab.reveal = async () => { reveals++; };
  api.window.tabGroups = {all: [], activeTabGroup: {}};
  await f.browser.reveal(f.tab);
  assert.equal(reveals, 1); assert.equal(f.closes(), 0);
  f.tab.reveal = async () => { throw new Error('Missing native editor'); };
  await assert.rejects(f.browser.reveal(f.tab), /Missing native editor/);
  api.window.browserTabs = [];
  await assert.rejects(f.browser.reveal(f.tab), /closed/);
});

test('native reveal patches only the pinned browser methods and refuses drift or repeat application', () => {
  const {patchSource} = require('../platform/browser-reveal.cjs');
  const host = 'startCDPSession(){return i._startCDPSession()},close(){return i._close()}';
  const main = 'nui=class extends x{constructor(e,t,i,n,r,a){super();this.editorService=t; async $closeBrowserTab(e){let t=this._knownBrowsers.get(e); m(4,Dt),m(5,V)],nui)';
  assert.match(patchSource(host, 'host'), /reveal\(\).*i\.id/);
  assert.match(patchSource(main, 'main'), /item.editor===t.input/);
  assert.match(patchSource(main, 'main'), /matches.length!==1/);
  assert.match(patchSource(main, 'main'), /focusWindow\(\{targetWindowId:this.editorGroupsService.getPart/);
  assert.throws(() => patchSource(main.replace('m(5,V)', 'm(5,changed)'), 'main'), /Unexpected/);
  for (const [kind, source] of [['host', host], ['main', main]]) {
    assert.throws(() => patchSource(source + source, kind), /Unexpected/);
    assert.throws(() => patchSource(patchSource(source, kind), kind), /Unexpected/);
    assert.throws(() => patchSource('changed upstream source', kind), /Unexpected/);
  }
});
