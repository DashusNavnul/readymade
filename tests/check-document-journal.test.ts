import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CheckDocumentJournal} from '../src/check-document-journal';
import {digest} from '../src/source-store';

test('opened evidence is exact, private, immutable and readable by a fresh journal', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'check-doc-'));
  try {
    const directory = join(root, 'reports'), journal = new CheckDocumentJournal(directory);
    assert.equal(journal.read(digest('absent')), undefined);
    const text = JSON.stringify({origin: 'https://zod.example', project: 'demo', detail: 'λ\nerror'}), key = journal.retain(text);
    const file = join(directory, key + '.json'), before = fs.statSync(file);
    assert.equal(new CheckDocumentJournal(directory).read(key), text);
    assert.equal(journal.retain(text), key); assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700); assert.equal(before.mode & 0o777, 0o600);
    assert.notEqual(journal.retain(text.replace('zod', 'nec')), key);
    fs.writeFileSync(file, 'corrupt'); assert.throws(() => journal.read(key), /identity/);
    assert.throws(() => journal.retain(text), /identity/); assert.equal(fs.readFileSync(file, 'utf8'), 'corrupt');
    assert.throws(() => journal.read('../outside'), /identity/);
    assert.throws(() => journal.retain('x'.repeat(1048577)), /limit/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('unsafe permissions, links and oversized records cannot supply recovered evidence', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'check-doc-'));
  try {
    const directory = join(root, 'reports'), journal = new CheckDocumentJournal(directory), key = journal.retain('report'), file = join(directory, key + '.json');
    fs.chmodSync(file, 0o644); assert.throws(() => journal.read(key), /private/); fs.chmodSync(file, 0o600);
    fs.chmodSync(directory, 0o755); assert.throws(() => journal.read(key), /private/); fs.chmodSync(directory, 0o700);
    fs.linkSync(file, join(root, 'hardlink')); assert.throws(() => journal.read(key), /private/); fs.unlinkSync(join(root, 'hardlink'));
    fs.unlinkSync(file); fs.symlinkSync(join(root, 'missing'), file); assert.throws(() => journal.read(key)); fs.unlinkSync(file);
    fs.writeFileSync(file, 'x'.repeat(1048577), {mode: 0o600}); assert.throws(() => journal.read(key), /limit/);
    const link = join(root, 'linked'); fs.symlinkSync(directory, link); assert.throws(() => new CheckDocumentJournal(link).read(key), /private/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('recent evidence discovery is bounded, ordered and read-only', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'check-doc-'));
  try {
    const directory = join(root, 'reports'), journal = new CheckDocumentJournal(directory);
    assert.deepEqual(journal.recent(), []);
    const keys = Array.from({length: 65}, (_, n) => {
      const key = journal.retain(`report ${n}`); fs.utimesSync(join(directory, key + '.json'), 1000 + n, 1000 + n); return key;
    });
    const entries = new CheckDocumentJournal(directory).recent();
    assert.deepEqual(entries.map(e => e.key), keys.slice(1).reverse());
    assert.equal(entries[0].text, 'report 64'); assert.equal(journal.read(keys[0]), 'report 0');
    assert.equal(fs.readdirSync(directory).length, 65);
    fs.writeFileSync(join(directory, keys[64] + '.json'), 'corrupt'); assert.throws(() => journal.recent(), /identity/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
