'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// A stand-in editor: it holds open documents, hears each announcement, and applies it only when the test says so.
const listeners = new Set(), open = [];
class EventEmitter {
  constructor() {this.heard = new Set(); this.event = cb => {this.heard.add(cb); return {dispose: () => this.heard.delete(cb)};};}
  fire(value) {for (const cb of [...this.heard]) cb(value);}
  dispose() {this.heard.clear();}
}
const vscode = {EventEmitter, workspace: {textDocuments: open, onDidChangeTextDocument: cb => {listeners.add(cb); return {dispose: () => listeners.delete(cb)};}}};
const original = Module._load;
let SettledDocuments;
try {
  Module._load = function (name, ...args) {return name === 'vscode' ? vscode : original.call(this, name, ...args);};
  ({SettledDocuments} = require('../dist/src/settled-documents'));
} finally {Module._load = original;}

const uri = name => ({toString: () => `review:/${name}`});
/** One document and the screen text behind it. `asked` is every announcement, with the text the editor would fetch. */
function setup(t, shown, quietMs = 10_000) {
  open.length = 0; listeners.clear();
  const at = uri('a.json'), state = {text: 'first', asked: []};
  const document = shown === undefined ? undefined : {uri: at, text: shown, getText() {return this.text;}};
  if (document) open.push(document);
  const documents = new SettledDocuments(asked => asked.toString() === at.toString() ? state.text : undefined, quietMs);
  documents.onDidChange(() => state.asked.push(state.text));
  t.after(() => documents.dispose());
  /** The editor finishes an update: the document becomes `text`, and the change is reported. */
  const land = (text, changes = 1) => {document.text = text; for (const cb of [...listeners]) cb({document, contentChanges: Array(changes).fill({})});};
  return {at, state, documents, document, land};
}

test('a document no editor holds is announced each time, and nothing is waited for', t => {
  const x = setup(t, undefined);
  x.documents.changed(x.at); x.state.text = 'second'; x.documents.changed(x.at);
  assert.deepEqual(x.state.asked, ['first', 'second']); assert.equal(x.documents.inFlight, 0);
});

test('while one change is on its way no other is announced; when it lands, the newest text follows', t => {
  const x = setup(t, 'old');
  x.documents.changed(x.at); x.state.text = 'second'; x.documents.changed(x.at); x.state.text = 'third'; x.documents.changed(x.at);
  assert.deepEqual(x.state.asked, ['first'], 'three changes, one announcement'); assert.equal(x.documents.inFlight, 1);
  x.land('first'); assert.deepEqual(x.state.asked, ['first', 'third'], 'the text in between is skipped'); assert.equal(x.documents.inFlight, 1);
  x.land('third'); assert.deepEqual(x.state.asked, ['first', 'third']); assert.equal(x.documents.inFlight, 0);
  x.state.text = 'fourth'; x.documents.changed(x.at); assert.equal(x.state.asked.at(-1), 'fourth');
});

test('a document that already shows the text is not announced; line endings do not count as a difference', t => {
  const x = setup(t, 'a\r\nb'); x.state.text = 'a\nb';
  x.documents.changed(x.at); assert.deepEqual(x.state.asked, []); assert.equal(x.documents.inFlight, 0);
});

test('a document that comes out wrong is announced again, a bounded number of times, and later changes still work', t => {
  const x = setup(t, 'old');
  x.documents.changed(x.at);
  for (let n = 0; n < 10 && x.documents.inFlight; n++) x.land('first with the tail of old');
  assert.equal(x.state.asked.length, 4, 'once, then three repairs'); assert.equal(x.documents.inFlight, 0);
  x.state.text = 'second'; x.documents.changed(x.at); x.land('second');
  assert.equal(x.state.asked.at(-1), 'second'); assert.equal(x.documents.inFlight, 0);
  // One repair is enough when the editor then gets it right.
  const y = setup(t, 'old'); y.documents.changed(y.at); y.land('mixed'); y.land('first');
  assert.deepEqual(y.state.asked, ['first', 'first']); assert.equal(y.documents.inFlight, 0);
});

test('a report with no edit in it is not taken as the change having landed', t => {
  const x = setup(t, 'old');
  x.documents.changed(x.at); x.state.text = 'second'; x.land('old', 0);
  assert.deepEqual(x.state.asked, ['first']); assert.equal(x.documents.inFlight, 1);
});

test('when the editor reports nothing for a while, the document is looked at anyway', async t => {
  const x = setup(t, 'old', 15);
  x.documents.changed(x.at); await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(x.state.asked.length >= 2, 'announced again after the quiet time'); assert.equal(x.documents.inFlight, 1);
  x.land('first'); assert.equal(x.documents.inFlight, 0);
  const settled = x.state.asked.length; await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(x.state.asked.length, settled, 'nothing more once it shows the text');
});

test('a document that is not this screen\'s is never announced, and nothing is announced after closing', t => {
  const x = setup(t, 'old'), other = uri('b.json');
  open.push({uri: other, getText: () => 'x'}); x.documents.changed(other);
  assert.deepEqual(x.state.asked, []); assert.equal(x.documents.inFlight, 0);
  x.documents.changed(x.at); x.documents.dispose(); x.land('first'); x.state.text = 'second'; x.documents.changed(x.at);
  assert.deepEqual(x.state.asked, ['first']); assert.equal(x.documents.inFlight, 0);
});
