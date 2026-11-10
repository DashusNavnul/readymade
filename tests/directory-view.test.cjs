const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
const original = Module._load;
let DirectoryView;
try {
  Module._load = function (name, ...args) { return name === 'vscode' ? {} : original.call(this, name, ...args); };
  ({DirectoryView} = require('../dist/src/directory-view.js'));
} finally { Module._load = original; }

function view(store) {
  let renders = 0;
  const instance = new DirectoryView({}, () => 'demo', () => renders++);
  instance.client = {origin: 'https://zod.example'};
  instance.store = store;
  instance.listing = {binding: {project: 'demo', origin: 'https://zod.example'}, entries: [], next: 0};
  return {instance, rendered: () => renders};
}
test('settled listings and refusals render without an additional network dependency', async () => {
  for (const outcome of [{entries: [{path: '/lib/a/hoon'}], next: null}, {entries: [], next: 0, refusal: {reason: 'source-denied'}}]) {
    let submitted = 0;
    const {instance, rendered} = view({next: async binding => {submitted++; return {binding, ...outcome};},
      refresh: async () => {throw new Error('An already-settled result must not depend on another read');}});
    await instance.next(); assert.equal(submitted, 1); assert.equal(rendered(), 1);
    assert.deepEqual(instance.listing.entries, outcome.entries);
    assert.deepEqual(instance.listing.refusal, outcome.refusal);
  }
});
test('pending results still observe once and never submit a second command', async () => {
  let submitted = 0, observed = 0;
  const {instance} = view({next: async binding => {submitted++; return {binding, pending: {cursor: 0}, entries: [], next: 0};},
    refresh: async binding => {observed++; return {binding, entries: [], next: null};}});
  await instance.next(); assert.equal(submitted, 1); assert.equal(observed, 1); assert.equal(instance.listing.next, null);
});
test('unknown submission restores the held intent and propagates failure without replay', async () => {
  let submitted = 0, observed = 0;
  const {instance, rendered} = view({next: async () => {submitted++; throw new Error('unknown outcome');},
    refresh: async binding => {observed++; return {binding, pending: {cursor: 0}, entries: [], next: 0};}});
  await assert.rejects(instance.next(), /unknown outcome/);
  assert.equal(submitted, 1); assert.equal(observed, 1); assert.equal(rendered(), 1); assert.ok(instance.listing.pending);
});

test('a settled page from an old connection cannot repopulate a reconnected view', async () => {
  let finish;
  const {instance, rendered} = view({next: binding => new Promise(resolve => {finish = () => resolve({binding, entries: [], next: null});})});
  const pending = instance.next();
  instance.connect({origin: 'https://zod.example'});
  finish(); await pending;
  assert.equal(instance.listing, undefined); assert.equal(rendered(), 0);
});

test('unknown delivery recovers only through its original store after reconnect', async () => {
  let fail, observed = 0, replacementReads = 0;
  const {instance, rendered} = view({next: () => new Promise((_, reject) => {fail = reject;}),
    refresh: async binding => {observed++; return {binding, entries: [], next: 0, pending: {cursor: 0}};}});
  const pending = instance.next();
  instance.connect({origin: 'https://zod.example'});
  instance.store = {refresh: async () => {replacementReads++; throw new Error('wrong connection');}};
  fail(new Error('unknown outcome'));
  await assert.rejects(pending, /unknown outcome/);
  assert.equal(observed, 1); assert.equal(replacementReads, 0);
  assert.equal(instance.listing, undefined); assert.equal(rendered(), 0);
});

test('a refresh from an old connection cannot replace the new directory view', async () => {
  let finish;
  const {instance, rendered} = view({refresh: binding => new Promise(resolve => {finish = () => resolve({binding, entries: [], next: null});})});
  const pending = instance.refresh();
  instance.connect({origin: 'https://zod.example'});
  finish(); await pending;
  assert.equal(instance.listing, undefined); assert.equal(rendered(), 0);
});

test('reconnecting during open does not display or request a page from the abandoned listing', async () => {
  let finish, started;
  const opening = new Promise(resolve => {started = resolve;});
  const {instance, rendered} = view({open: () => new Promise(resolve => {
    finish = () => resolve({binding: {project: 'demo'}, entries: [], next: 0}); started();
  })});
  instance.client.codingState = async () => ({sessions: [{id: '0x1', project: 'demo'}]});
  const pending = instance.open('0x1', '/'); await opening;
  instance.connect(instance.client);
  finish(); await pending;
  assert.equal(instance.listing, undefined); assert.equal(rendered(), 0);
});

test('a delayed refresh cannot replace a newly selected directory or project', async () => {
  for (const change of ['directory', 'project']) {
    let finish;
    const {instance, rendered} = view({refresh: binding => new Promise(resolve => {finish = () => resolve({binding, entries: [], next: null});})});
    const pending = instance.refresh(), held = instance.listing;
    const selected = {...held, entries: [{path: '/lib/new/hoon'}]};
    if (change === 'directory') instance.listing = selected;
    else instance.project = () => 'another';
    finish(); await pending;
    assert.equal(instance.listing, change === 'directory' ? selected : held);
    assert.equal(rendered(), 0);
  }
});
