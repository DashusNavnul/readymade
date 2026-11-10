import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DraftStore} from '../src/draft-store';
import {snapshotFrom} from '../src/source-store';
import type {CodingSnapshot} from '../src/protocol';

test('large draft freezes a bounded patch and reopens unknown intent without replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'readymade-large-draft-'));
  const source = {id: '0x1', owner: '~zod', desk: 'work', number: 1, root: '0v1', commit: '0v2'};
  const text = 'original line\n'.repeat(6000);
  const snapshot = snapshotFrom({origin: 'https://zod.example', ship: '~zod', session: '0x2', source,
    path: '/lib/large/hoon', blob: '0x3', mark: 'hoon', text});
  const store = new DraftStore(directory), draft = store.create(snapshot);
  store.save(draft.id, text + 'new\n'); let posts = 0;
  const state: CodingSnapshot = {owner: '~zod', ready: true, nonce: '0v1', cursor: '0x0', session: '0x2', after: 0,
    projects: [], sessions: [{id: '0x2', source}], records: []};
  const client = {origin: 'https://zod.example', snapshot: state, codingTool: async (_session: string, _source: string, input: string): Promise<CodingSnapshot> => {
    posts++; assert.equal(input, '/patch /lib/large/hoon 0x3 6001 0 0\nnew\n'); throw new Error('lost reply');
  }};
  await assert.rejects(store.prepare(draft.id, client), /lost reply/);
  store.save(draft.id, text + 'later\n');
  const reopened = new DraftStore(directory), retained = reopened.get(draft.id);
  assert.equal(retained.pending?.text, text + 'new\n'); assert.equal(retained.text, text + 'later\n');
  assert.equal(retained.pending?.phase, 'unknown');
  await assert.rejects(reopened.prepare(draft.id, client), /retained/); assert.equal(posts, 1);
});

test('a 1 MiB draft and escaped source survive private journal reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'readymade-large-storage-'));
  const snapshot = snapshotFrom({origin: 'https://zod.example', ship: '~zod', session: '0x2',
    source: {id: '0x1', owner: '~zod', desk: 'work', number: 1, root: '0v1', commit: '0v2'},
    path: '/lib/large/hoon', blob: '0x3', mark: 'hoon', text: '\t'.repeat(1_048_576)});
  const store = new DraftStore(directory), draft = store.create(snapshot);
  store.save(draft.id, 'a' + snapshot.text.slice(1));
  const retained = new DraftStore(directory).get(draft.id);
  assert.equal(retained.snapshot.text, snapshot.text);
  assert.equal(retained.text, 'a' + snapshot.text.slice(1));
});

test('sparse multi-patch draft retains one frozen proposal after a lost response', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'readymade-sparse-draft-'));
  const source = {id: '0x1', owner: '~zod', desk: 'work', number: 1, root: '0v1', commit: '0v2'};
  const text = 'unchanged line\n'.repeat(6000), edited = 'first\n' + text + 'last\n';
  const store = new DraftStore(directory), row = store.create(snapshotFrom({origin: 'https://zod.example', ship: '~zod', session: '0x2', source,
    path: '/lib/large/hoon', blob: '0x3', mark: 'hoon', text}));
  store.save(row.id, edited); let posts = 0;
  const state: CodingSnapshot = {owner: '~zod', ready: true, nonce: '0v1', cursor: '0x0', session: '0x2', after: 0,
    projects: [], sessions: [{id: '0x2', source}], records: []};
  const client = {origin: 'https://zod.example', snapshot: state, codingTool: async (_session: string, _source: string, input: string): Promise<CodingSnapshot> => {
    posts++; assert.match(input, /^\/patches 2\n/); throw new Error('lost reply');
  }};
  await assert.rejects(store.prepare(row.id, client), /lost reply/);
  store.save(row.id, edited + 'later\n');
  const reopened = new DraftStore(directory); assert.equal(reopened.get(row.id).pending?.text, edited);
  await assert.rejects(reopened.prepare(row.id, client), /retained/); assert.equal(posts, 1);
});
