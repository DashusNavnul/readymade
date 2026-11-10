import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DurablePageJournal} from '../src/page-journal';

const key = 'readymade.page:' + 'a'.repeat(64) + ':1';
const directory = () => fs.mkdtempSync(join(tmpdir(), 'readymade-page-journal-'));
test('page intents survive independent windows and refuse stale updates', async () => {
  const path = directory(), a = new DurablePageJournal(path), b = new DurablePageJournal(path);
  assert.equal(a.get(key), undefined); assert.equal(b.get(key), undefined);
  await a.update(key, {count: 2});
  await assert.rejects(b.update(key, {count: 200}), /EEXIST/);
  assert.deepEqual(b.get(key), {count: 2});
  await b.update(key, {count: 2, request: '0x123'});
  assert.deepEqual(new DurablePageJournal(path).get(key), {count: 2, request: '0x123'});
});
test('available legacy intents migrate before another window can send', () => {
  const path = directory(), legacy = {get: <T>() => ({count: 2} as T)};
  assert.deepEqual(new DurablePageJournal(path, legacy).get(key), {count: 2});
  assert.deepEqual(new DurablePageJournal(path).get(key), {count: 2});
});
test('partial writes and unsafe permissions fail closed', async () => {
  const path = directory(), journal = new DurablePageJournal(path);
  journal.get(key); await journal.update(key, {count: 2});
  const folder = join(path, fs.readdirSync(path)[0]);
  fs.writeFileSync(join(folder, '2.json'), '{', {mode: 0o600});
  assert.throws(() => new DurablePageJournal(path).get(key));
  fs.chmodSync(path, 0o777);
  assert.throws(() => new DurablePageJournal(path).get(key), /private/);
});
