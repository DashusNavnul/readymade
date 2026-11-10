import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NoltbookDocumentStore} from '../src/noltbook-document-store';
import {documentSaveIntent, documentReceiptSelector, documentReceipt, type DocumentSnapshot} from '../src/noltbook-documents';

const snapshot: DocumentSnapshot = {origin: 'https://zod.example', peer: '~zod', host: '~nec', noteId: 'shared-note', canEdit: true,
  body: 'original\n', revision: 1, updatedBy: '~nec', updatedAt: '~2026.11.09', versions: 1, bytes: 9};
function fixture(run: (store: NoltbookDocumentStore) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'readymade-document-'));
  try {run(new NoltbookDocumentStore(directory));} finally {rmSync(directory, {recursive: true, force: true});}
}
test('remote revisions preserve local edits and pending intent through restart', () => fixture(store => {
  const row = store.open(snapshot); store.save(row.id, 'mine 🌙\n');
  const pending = documentSaveIntent(snapshot, 'mine 🌙\n', 1); store.begin(row.id, pending);
  store.observe(row.id, {...snapshot, revision: 2, body: 'theirs\n'});
  const reopened = new NoltbookDocumentStore(store.directory), saved = reopened.get(row.id);
  assert.equal(saved.body, 'mine 🌙\n'); assert.equal(saved.snapshot.revision, 1); assert.equal(saved.remote.revision, 2);
  assert.deepEqual(saved.pending, pending); assert.throws(() => reopened.begin(row.id, pending), /pending/);
  assert.throws(() => reopened.rebase(row.id), /pending/);
}));
test('matching text is not a save receipt; exact correlated result settles and preserves later typing', () => fixture(store => {
  const row = store.open(snapshot); store.save(row.id, 'sent'); store.begin(row.id, documentSaveIntent(snapshot, 'sent', 2));
  store.save(row.id, 'typed later'); const after = {...snapshot, body: 'sent', revision: 2};
  store.observe(row.id, after); assert.ok(store.get(row.id).pending);
  const receipt = {noteId: snapshot.noteId, requestId: 2, result: 'saved' as const, revision: 2, limit: null};
  assert.throws(() => store.settle(row.id, {...receipt, requestId: 3}, after));
  assert.throws(() => store.settle(row.id, receipt, {...after, body: 'wrong'}));
  store.settle(row.id, receipt, after);
  assert.equal(store.get(row.id).body, 'typed later'); assert.equal(store.get(row.id).snapshot.body, 'sent');
  assert.equal(store.get(row.id).pending, undefined); assert.equal(store.get(row.id).history.length, 1);
}));
test('explicit conflict can be rebased without overwriting text; other identities and stale frames refuse', () => fixture(store => {
  const row = store.open(snapshot); store.save(row.id, 'local'); store.begin(row.id, documentSaveIntent(snapshot, 'local', 4));
  store.settle(row.id, {noteId: snapshot.noteId, requestId: 4, result: 'conflict', revision: 2, limit: null});
  store.observe(row.id, {...snapshot, revision: 2, body: 'remote'}); store.rebase(row.id);
  assert.equal(store.get(row.id).body, 'local'); assert.equal(store.get(row.id).snapshot.revision, 2);
  assert.throws(() => store.observe(row.id, snapshot), /stale/);
  assert.throws(() => store.observe(row.id, {...snapshot, revision: 2, host: '~bud'}));
  assert.throws(() => store.observe(row.id, {...snapshot, revision: 2, body: 'conflicting same revision'}));
}));
test('another window cannot overwrite newer retained text or intent', () => fixture(store => {
  const row = store.open(snapshot), other = new NoltbookDocumentStore(store.directory);
  store.save(row.id, 'first window'); assert.throws(() => other.save(row.id, 'second window'), /another window/);
  assert.equal(new NoltbookDocumentStore(store.directory).get(row.id).body, 'first window');
}));
test('dirty editor equal to its original does not silently adopt a newer publication base', () => fixture(store => {
  const row = store.open(snapshot);
  store.observe(row.id, {...snapshot, body: 'remote', revision: 2}, true);
  assert.equal(store.get(row.id).body, snapshot.body); assert.equal(store.get(row.id).snapshot.revision, 1);
  assert.equal(store.get(row.id).remote.revision, 2);
}));

test('durable receipt survives reload and settles historical success without replacing newer local or remote text', () => fixture(store => {
  const row = store.open(snapshot), command = documentSaveIntent(snapshot, 'sent', 51, 'receipted-v1');
  store.save(row.id, command.body); store.begin(row.id, command); store.save(row.id, 'typed after send');
  const result = {noteId: snapshot.noteId, requestId: 51, result: 'saved' as const, revision: 2, limit: null};
  const proof = documentReceipt({schema: 'noltbook-document-receipt-v1', ...documentReceiptSelector(command), status: 'recorded',
    receipt: {result: 'saved', revision: 2, limit: null, recordedAt: '~2026.11.09'}}, command);
  assert.throws(() => store.settle(row.id, result), /evidence missing/);
  assert.throws(() => store.settle(row.id, result, undefined, {...proof, bodyHash: '0x1'}));
  store.observe(row.id, {...snapshot, body: 'another writer', revision: 3});
  store.settle(row.id, result, undefined, proof);
  const saved = new NoltbookDocumentStore(store.directory).get(row.id);
  assert.equal(saved.pending, undefined); assert.equal(saved.body, 'typed after send');
  assert.equal(saved.snapshot.revision, 1); assert.equal(saved.remote.revision, 3);
  assert.deepEqual(saved.history[0].receipt, proof); assert.deepEqual(saved.history[0].intent, command);
}));
test('legacy pending intent cannot be relabeled as a receipted operation after reload', () => fixture(store => {
  const row = store.open(snapshot), legacy = documentSaveIntent(snapshot, 'sent', 52);
  store.save(row.id, legacy.body); store.begin(row.id, legacy);
  const proof = {schema: 'noltbook-document-receipt-v1' as const, ...documentReceiptSelector({...legacy, protocol: 'receipted-v1'}), status: 'recorded' as const,
    receipt: {result: 'saved' as const, revision: 2, limit: null, recordedAt: '~2026.11.09'}};
  const reopened = new NoltbookDocumentStore(store.directory);
  assert.throws(() => reopened.settle(row.id, {noteId: snapshot.noteId, requestId: 52, result: 'saved', revision: 2, limit: null}, undefined, proof));
  assert.deepEqual(reopened.get(row.id).pending, legacy);
}));
