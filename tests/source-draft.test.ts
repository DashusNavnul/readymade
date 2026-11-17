import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SourceStore, snapshotFrom, type SourceSnapshot } from '../src/source-store';
import { DraftStore, type BundleDraftRecord } from '../src/draft-store';
import { SourcePager, type PageJournal } from '../src/source-pager';
import type { CodingSnapshot, JsonObject } from '../src/protocol';
import {bundleCandidateCommand} from '../src/candidate-command';
import {importInboxBundle, type InboxBundleDetail} from '../src/project-inbox';
import {remoteSourceHash} from '../src/remote-project-view';

const origin = 'https://files.example';
const basis = { id: '0xabc', owner: '~zod', desk: 'fixture', number: 1, root: '0v1', commit: '0v2' };
function state(records: JsonObject[] = []): CodingSnapshot {
  return { nonce: '0v1', cursor: '0x123', session: '0x1', owner: '~zod', ready: true, after: records.length,
    fileReadReady: {schema: 'native-coding-file-read-ready-v1', owner: '~zod', session: '0x1', available: true, ready: true, reason: 'ready'},
    projects: [], sessions: [{ id: '0x1', source: basis }], records, reviews: [] };
}
function page(text: string, start = 1, total = 1, next: number | null = null): JsonObject {
  return { path: '/lib/test/hoon', mark: 'hoon', blob: '0x99', start, total, text,
    lines: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0, bytes: Buffer.byteLength(text), next };
}
function read(value = page('old\n'), sequence = 0): JsonObject {
  const request = `0x${100 + sequence}`, callId = `read-session-${sequence}`;
  const { mark: _mark, lines: _lines, bytes: _bytes, ...output } = value;
  return { id: `0x${10 + sequence}`, sequence, kind: 'tool',
    text: JSON.stringify({ version: 'native-coding-tool-result-v1', call_id: callId,
      context: { session: '0x1', request, source: basis }, output: { kind: 'read', ...output } }),
    file: { kind: 'read', session: '0x1', request, callId, source: basis, value } };
}
function snapshot(text = 'old\n'): SourceSnapshot {
  const store = new SourceStore({ origin, codingState: async () => state([read(page(text))]) });
  store.ingest(state([read(page(text))])); return store.openSnapshot(store.sources()[0]);
}
function candidate(before = '0x99'): CodingSnapshot {
  const request = '0x777', context = { session: '0x1', request, source: basis };
  const reply = state([{ id: '0x50', sequence: 1, kind: 'tool', text: JSON.stringify({
    version: 'native-coding-tool-result-v1', call_id: request, context,
    output: { kind: 'candidate', id: '0xcafe', previous: null, basis, context,
      edits: [{ kind: 'modify', path: '/lib/test/hoon', before, after: '0x98' }] } }) }]);
  reply.commandReceipt = { version: 'native-coding-command-receipt-v1', target: 'viki', session: '0x1', source: basis.id, request, delivery: '0xa' };
  reply.delivery = '0xa: submitted; observing native retention'; return reply;
}
function privateDirectory(t: { after(fn: () => void): void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-source-draft-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return path.join(root, 'drafts');
}

function pageJournal(): PageJournal {
  const values = new Map<string, unknown>();
  return {get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => { values.set(key, value); }};
}

test('page progress follows contiguous evidence, including out-of-order and empty files', () => {
  const store = new SourceStore({origin, codingState: async () => state()});
  store.ingest(state([read(page('last', 3, 3), 2)]));
  const key = store.progress()[0].key;
  assert.equal(store.progress()[0].next, 1); assert.equal(store.progress()[0].lines, 0);
  store.ingest(state([read(page('α\n', 1, 3, 2))]));
  assert.equal(store.progress()[0].key, key); assert.equal(store.progress()[0].next, 2);
  assert.equal(store.progress()[0].bytes, 3);
  store.ingest(state([read(page('middle\n', 2, 3, 3), 1)]));
  assert.equal(store.progress()[0].next, null); assert.equal(store.progress()[0].lines, 3);
  assert.equal(store.openSnapshot(store.sources()[0]).text, 'α\nmiddle\nlast');
  const empty = new SourceStore({origin, codingState: async () => state()});
  empty.ingest(state([read(page('', 1, 0))])); assert.equal(empty.progress()[0].next, null);
});

test('next-page request binds fresh source and completes the exact immutable file', async () => {
  const initial = state([read(page('first\n', 1, 2, 2))]); initial.sessions[0].project = 'demo';
  let posts = 0;
  const client = {origin, codingState: async () => initial, codingTool: async (session: string, source: string, input: string) => {
    posts++; assert.equal(session, '0x1'); assert.equal(source, basis.id); assert.equal(input, '/read /lib/test/hoon 2 200');
    return state([read(page('last', 2, 2), 1)]);
  }};
  const store = new SourceStore(client); store.ingest(initial);
  const pager = new SourcePager(client, store, pageJournal()), key = store.progress()[0].key;
  await assert.rejects(pager.next(key, 'private'), /project changed/); assert.equal(posts, 0);
  initial.sessions[0].source = {...basis, commit: '0v3'};
  await assert.rejects(pager.next(key, 'demo'), /source or project changed/); assert.equal(posts, 0);
  initial.sessions[0].source = basis;
  await pager.next(key, 'demo'); assert.equal(posts, 1);
  assert.equal(store.openSnapshot(store.sources()[0]).text, 'first\nlast');
  await pager.next(key, 'demo'); assert.equal(posts, 1);
});

test('lost page delivery survives pager reconstruction and cannot replay until evidence advances', async () => {
  let posts = 0; const initial = state([read(page('first\n', 1, 3, 2))]);
  const client = {origin, codingState: async () => initial, codingTool: async () => { posts++; throw new Error('lost reply'); }};
  const store = new SourceStore(client); store.ingest(initial); const journal = pageJournal(), key = store.progress()[0].key;
  await assert.rejects(new SourcePager(client, store, journal).next(key), /lost reply/);
  await assert.rejects(new SourcePager(client, store, journal).next(key), /already requested/); assert.equal(posts, 1);
  store.ingest(state([read(page('second\n', 2, 3, 3), 1)]));
  await assert.rejects(new SourcePager(client, store, journal).next(key), /lost reply/); assert.equal(posts, 2);
});

test('failed durable page marker refuses network submission', async () => {
  let posts = 0; const initial = state([read(page('first\n', 1, 2, 2))]);
  const client = {origin, codingState: async () => initial, codingTool: async () => { posts++; return state(); }};
  const store = new SourceStore(client); store.ingest(initial);
  const pager = new SourcePager(client, store, {get: () => undefined, update: async () => { throw new Error('disk full'); }});
  await assert.rejects(pager.next(store.progress()[0].key), /disk full/); assert.equal(posts, 0);
});

test('only an exact retained size refusal permits a smaller explicit page request', async () => {
  let observed = state([read(page('first\n', 1, 2, 2))]);
  let posts = 0;
  const refusal = state([{kind: 'tool', text: JSON.stringify({version: 'native-coding-tool-result-v1', call_id: '0x777',
    context: {request: '0x777', session: '0x1', source: basis}, output: {kind: 'refused', reason: 'read-page-too-large'}})}]);
  refusal.commandReceipt = {version: 'native-coding-command-receipt-v1', target: 'viki', session: '0x1', source: basis.id, request: '0x777', delivery: '0xa'};
  const client = {origin, codingState: async () => observed, codingTool: async (_session: string, _source: string, input: string) => {
    posts++;
    if (posts === 1) { assert.ok(input.endsWith(' 200')); return refusal; }
    assert.ok(input.endsWith(' 100')); return state([read(page('last', 2, 2), 1)]);
  }};
  const store = new SourceStore(client); store.ingest(observed); const journal = pageJournal(), key = store.progress()[0].key;
  await assert.rejects(new SourcePager(client, store, journal).next(key), /fewer lines/);
  observed = structuredClone(refusal);
  const wrong = JSON.parse(observed.records[0].text as string); wrong.context.source.commit = '0v3';
  observed.records[0].text = JSON.stringify(wrong);
  await assert.rejects(new SourcePager(client, store, journal).next(key), /already requested/); assert.equal(posts, 1);
  wrong.context.source = basis; wrong.context.request = '0x888'; observed.records[0].text = JSON.stringify(wrong);
  await assert.rejects(new SourcePager(client, store, journal).next(key), /already requested/); assert.equal(posts, 1);
  observed = refusal;
  await new SourcePager(client, store, journal).next(key); assert.equal(posts, 2);
  assert.equal(store.progress()[0].next, null);
});

test('first-page size refusal recovers from a fresh observation without needing partial bytes', async () => {
  let observed = state(), posts = 0;
  const refused = state([{kind: 'tool', text: JSON.stringify({version: 'native-coding-tool-result-v1', call_id: '0x777',
    context: {request: '0x777', session: '0x1', source: basis}, output: {kind: 'refused', reason: 'read-page-too-large'}})}]);
  refused.commandReceipt = {version: 'native-coding-command-receipt-v1', target: 'viki', session: '0x1', source: basis.id, request: '0x777'};
  const client = {origin, codingState: async () => observed, codingTool: async (_s: string, _b: string, input: string) => {
    posts++; assert.equal(input, `/read /lib/test/hoon 1 ${posts === 1 ? 200 : 100}`);
    observed = posts === 1 ? refused : state([read()]); return observed;
  }};
  const store = new SourceStore(client), disk = pageJournal();
  await assert.rejects(new SourcePager(client, store, disk).start('0x1', basis, '/lib/test/hoon'), /fewer lines/);
  assert.equal(store.progress().length, 0);
  await new SourcePager(client, store, disk).start('0x1', basis, '/lib/test/hoon');
  assert.equal(store.openSnapshot(store.sources()[0]).text, 'old\n');
  await new SourcePager(client, store, disk).start('0x1', basis, '/lib/test/hoon'); assert.equal(posts, 2);
});

test('changing initial page size cannot replay unknown delivery', async () => {
  let posts = 0;
  const client = {origin, codingState: async () => state(), codingTool: async () => { posts++; throw new Error('lost'); }};
  const store = new SourceStore(client), disk = pageJournal();
  await assert.rejects(new SourcePager(client, store, disk).start('0x1', basis, '/lib/test/hoon'), /lost/);
  await assert.rejects(new SourcePager(client, store, disk).start('0x1', basis, '/lib/test/hoon', undefined, 1), /already requested/);
  assert.equal(posts, 1);
});

test('canonical projection assembles only exact complete pages; browsing copies bytes without POST', async () => {
  let gets = 0;
  const first = read(page('α\n', 1, 2, 2)), last = read(page('🙂e\u0301', 2, 2), 1);
  const store = new SourceStore({ origin, codingState: async selected => { assert.equal(selected, '0x0'); gets++; return state([first]); } });
  assert.equal((await store.refresh()).length, 0, 'Partial source appeared complete');
  store.ingest(state([last])); const descriptor = store.sources()[0], held = store.openSnapshot(descriptor);
  assert.equal(held.text, 'α\n🙂e\u0301'); assert.equal(held.byteLength, Buffer.byteLength(held.text));
  const bytes = store.bytes(descriptor); bytes[0] = 0;
  assert.equal(store.openSnapshot(descriptor).text, held.text); assert.equal(gets, 1);
  assert.equal(store.openSnapshot(held.uri.split('?')[0]).uri, held.uri, 'Pinned hash path did not survive directory browsing');
  assert.throws(() => store.openSnapshot(held.uri + 'tamper'));
  assert.notEqual(snapshotFrom({ ...held, uri: undefined, key: undefined, origin: 'https://other.example' }).uri, held.uri);
  assert.notEqual(snapshotFrom({ ...held, uri: undefined, key: undefined, source: { ...basis, number: 2 } }).uri, held.uri);
  assert.ok(Object.isFrozen(held) && Object.isFrozen(held.source));
});

test('contradictory page/source/boundaries cannot replace retained canonical bytes', () => {
  const store = new SourceStore({ origin, codingState: async () => state() }); store.ingest(state([read()]));
  const prior = store.sources()[0], invalid = read();
  (invalid.file as JsonObject).source = { ...basis, commit: '0v3' };
  assert.throws(() => store.ingest(state([invalid])));
  assert.equal(store.openSnapshot(prior).text, 'old\n');
  assert.throws(() => store.ingest(state([read(page('changed\n'))])));
  assert.throws(() => store.ingest(state([read({ ...page('old\n'), bytes: 999 })])));
  assert.throws(() => store.ingest(state([read({ ...page('old\n'), next: 1 })])));
  assert.throws(() => store.ingest(state([read({ ...page('old\n'), path: '/../hoon' })])));
  assert.equal(store.openSnapshot(prior).text, 'old\n');
});

test('native tool call IDs differ from request IDs and derived projection metadata stays exact', () => {
  const store = new SourceStore({ origin, codingState: async () => state() }), native = read();
  const result = JSON.parse(native.text as string) as JsonObject;
  assert.notEqual(result.call_id, (native.file as JsonObject).request);
  assert.equal(Object.hasOwn(result.output as JsonObject, 'bytes'), false);
  store.ingest(state([{ kind: 'tool', file: 'not a file projection', text: 'not JSON' }, { kind: 'tool', file: { kind: 'list' } }, native]));
  assert.equal(store.openSnapshot(store.sources()[0]).text, 'old\n');
  const wrongCall = read(); (wrongCall.file as JsonObject).callId = 'another-call';
  assert.throws(() => store.ingest(state([wrongCall])));
  const wrongRequest = read(); (wrongRequest.file as JsonObject).request = '0x999';
  assert.throws(() => store.ingest(state([wrongRequest])));
  const wrongExtra = read(), extra = JSON.parse(wrongExtra.text as string) as JsonObject;
  (extra.output as JsonObject).bytes = 999; wrongExtra.text = JSON.stringify(extra);
  assert.throws(() => store.ingest(state([wrongExtra])));
  assert.equal(store.openSnapshot(store.sources()[0]).text, 'old\n');
});

test('private saves preserve exact UTF8/source identity, restart and permissions without any client', t => {
  const directory = privateDirectory(t), drafts = new DraftStore(directory), source = snapshot();
  const created = drafts.create(source), text = '\uFEFFcafé🙂e\u0301\n';
  drafts.save(created.uri, text);
  const recovered = new DraftStore(directory).get(created.id);
  assert.deepEqual(Buffer.from(recovered.text), Buffer.from(text));
  assert.equal(recovered.snapshot.uri, source.uri); assert.equal(recovered.snapshot.text, 'old\n');
  assert.equal(recovered.pending, undefined);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(directory, `${created.id}.json`)).mode & 0o777, 0o600);
  assert.throws(() => drafts.save(created.id, '\ud800'));
  assert.throws(() => drafts.save(created.id, '🙂'.repeat(262_145)));
  assert.equal(drafts.get(created.id).text, text);
  Reflect.set(recovered.snapshot.source, 'number', 99);
  assert.equal(drafts.get(created.id).snapshot.source.number, 1, 'External mutation changed stored source identity');
});

test('fresh full source/origin/session fences reject candidates before any request', async t => {
  const drafts = new DraftStore(privateDirectory(t)), row = drafts.create(snapshot()); drafts.save(row.id, 'new\n');
  let posts = 0; const client = { origin, snapshot: state(), codingTool: async () => { posts++; return candidate(); } };
  client.snapshot.sessions = [{ id: '0x1', source: { ...basis, root: '0v3' } }];
  await assert.rejects(drafts.prepare(row.id, client));
  client.snapshot = state(); client.origin = 'https://other.example'; await assert.rejects(drafts.prepare(row.id, client));
  client.origin = origin; client.snapshot.session = '0x0'; await assert.rejects(drafts.prepare(row.id, client));
  assert.equal(posts, 0); assert.equal(drafts.get(row.id).pending, undefined);
});

test('frozen intent is durable before POST; only exact retained candidate evidence counts', async t => {
  const directory = privateDirectory(t), drafts = new DraftStore(directory), row = drafts.create(snapshot());
  const edited = 'changed café🙂\n'; drafts.save(row.id, edited); let posts = 0;
  const client = { origin, snapshot: state(), codingTool: async (session: string, source: string, input: string) => {
    posts++; const onDisk = new DraftStore(directory).get(row.id);
    assert.equal(onDisk.pending?.phase, 'issued'); assert.equal(onDisk.pending?.text, edited); assert.equal(onDisk.pending?.nonce, '0v1');
    assert.equal(input, `/replace /lib/test/hoon 0x99 hoon\n${edited}`); assert.equal(onDisk.pending?.input, input);
    assert.equal(session, '0x1'); assert.equal(source, basis.id); return candidate();
  } };
  const result = await drafts.prepare(row.id, client);
  assert.equal(result.pending?.phase, 'candidate'); assert.equal(result.pending?.candidate, '0xcafe');
  assert.equal(new DraftStore(directory).get(row.id).pending?.request, '0x777');
  drafts.save(row.id, 'later private edit\n'); assert.equal(drafts.get(row.id).pending?.text, edited);
  await assert.rejects(drafts.prepare(row.id, client)); assert.equal(posts, 1);
  assert.equal(drafts.get(row.id).snapshot.text, 'old\n', 'Candidate submission pretended canonical source was applied');
});

test('unknown delivery survives restart/new nonce and cannot replay', async t => {
  const directory = privateDirectory(t), drafts = new DraftStore(directory), row = drafts.create(snapshot()); drafts.save(row.id, 'new\n');
  let posts = 0; const client = { origin, snapshot: state(), codingTool: async () => { posts++; throw new Error('Disconnected after send'); } };
  await assert.rejects(drafts.prepare(row.id, client));
  const recovered = new DraftStore(directory); assert.equal(recovered.get(row.id).pending?.phase, 'unknown');
  client.snapshot.nonce = '0v2'; await assert.rejects(recovered.prepare(row.id, client)); assert.equal(posts, 1);
  assert.equal(recovered.get(row.id).pending?.input, '/replace /lib/test/hoon 0x99 hoon\nnew\n');
});

test('bad candidate blob/receipt stays unknown and unrelated records cannot settle the intent', async t => {
  const drafts = new DraftStore(privateDirectory(t)), row = drafts.create(snapshot()); drafts.save(row.id, 'new\n');
  const client = { origin, snapshot: state(), codingTool: async () => candidate('0x66') };
  await assert.rejects(drafts.prepare(row.id, client)); assert.equal(drafts.get(row.id).pending?.phase, 'unknown');
  const foreign = candidate(); foreign.owner = '~bus'; drafts.observe(row.id, foreign);
  assert.equal(drafts.get(row.id).pending?.phase, 'unknown');
});

test('storage corruption, symlinks and failed pre-POST intent cannot overwrite valuable drafts', async t => {
  const directory = privateDirectory(t), drafts = new DraftStore(directory), row = drafts.create(snapshot()); drafts.save(row.id, 'new\n');
  const file = path.join(directory, `${row.id}.json`), prior = fs.readFileSync(file);
  let posts = 0; const client = { origin, snapshot: state(), codingTool: async () => { posts++; return candidate(); } };
  fs.chmodSync(directory, 0o755); await assert.rejects(drafts.prepare(row.id, client)); fs.chmodSync(directory, 0o700);
  assert.equal(posts, 0); assert.deepEqual(fs.readFileSync(file), prior);
  fs.writeFileSync(file, 'valuable external journal'); assert.throws(() => drafts.save(row.id, 'discarded'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'valuable external journal'); assert.throws(() => new DraftStore(directory));
  fs.unlinkSync(file); const sentinel = path.join(path.dirname(directory), 'sentinel'); fs.writeFileSync(sentinel, prior, { mode: 0o600 });
  fs.symlinkSync(sentinel, file); assert.throws(() => new DraftStore(directory)); assert.deepEqual(fs.readFileSync(sentinel), prior);
});

test('CRLF/C1 bytes remain visible in canonical/private buffers but cannot become a replace command', async t => {
  const drafts = new DraftStore(privateDirectory(t)), row = drafts.create(snapshot('old\r\n')); drafts.save(row.id, 'changed\n');
  let posts = 0; const client = { origin, snapshot: state(), codingTool: async () => { posts++; return candidate(); } };
  await assert.rejects(drafts.prepare(row.id, client)); assert.equal(posts, 0);
  assert.equal(drafts.get(row.id).snapshot.text, 'old\r\n');
});

function bundleState(): CodingSnapshot {const value = state(); value.sessions[0].project = 'demo'; return value;}
function bundleDraft(store: DraftStore, texts = ['first changed\n', 'second changed\n']): BundleDraftRecord {
  const sources = [snapshot(), snapshotFrom({...snapshot(), uri: undefined, key: undefined, path: '/lib/second/hoon', blob: '0x88'})];
  const receipt: InboxBundleDetail = {kind: 'bundle', receiptHash: '0x123', peer: '~nec', receivedAt: '~2026.11.16', generation: '1', request: '0x5',
    parentRoot: '0x1', snapshotDigest: '0x9', desk: basis.desk, revision: '1', files: sources.map((s, i) => ({path: s.path,
      originalHash: remoteSourceHash(s.text), sourceHash: remoteSourceHash(texts[i]), source: texts[i]}))};
  return importInboxBundle(store, receipt, sources, {origin, owner: '~zod', project: 'demo', session: '0x1', basis, state: bundleState()});
}
function bundleCandidate(row: BundleDraftRecord, mutate: (output: JsonObject) => void = () => {}): CodingSnapshot {
  const reply = candidate(), request = '0x777', context = {session: '0x1', request, source: basis, project: 'demo'};
  const output: JsonObject = {kind: 'candidate', id: '0xcafe', previous: null, basis, context,
    edits: row.files.map(f => ({kind: 'modify', path: f.snapshot.path, before: f.snapshot.blob, after: '0x98',
      content: {mark: 'hoon', bytes: Buffer.byteLength(f.text), digest: remoteSourceHash(f.text), sourceOmitted: true}}))};
  mutate(output);
  reply.records = [{kind: 'tool', text: JSON.stringify({version: 'native-coding-tool-result-v1', call_id: request, context, output})}];
  return reply;
}

test('bundle submission persists one whole intent before one POST and correlates all contents', async t => {
  const directory = privateDirectory(t), store = new DraftStore(directory), row = bundleDraft(store); let posts = 0;
  const client = {origin, snapshot: bundleState(), codingTool: async (session: string, source: string, input: string) => {
    posts++; const held = new DraftStore(directory).getBundle(row.id);
    assert.equal(held.pending?.phase, 'issued'); assert.equal(held.pending?.input, input); assert.match(input, /^\/patches 2\n/);
    assert.match(input, /\/lib\/test\/hoon 0x99 /); assert.match(input, /\/lib\/second\/hoon 0x88 /);
    assert.deepEqual(held.pending?.files.map(f => f.text), row.files.map(f => f.text));
    assert.equal(session, '0x1'); assert.equal(source, basis.id);
    return bundleCandidate(row, output => (output.edits as unknown[]).reverse());
  }};
  const result = await store.prepareBundle(row.id, client, 'native-coding-patches-v1');
  assert.equal(result.pending?.phase, 'candidate'); assert.equal(result.pending?.candidate, '0xcafe'); assert.equal(posts, 1);
  store.saveBundle(row.id, row.files[1].snapshot.path, 'later local edit\n');
  const restored = new DraftStore(directory);
  assert.equal(restored.getBundle(row.id).pending?.files[1].text, row.files[1].text);
  await assert.rejects(restored.prepareBundle(row.id, client, 'native-coding-patches-v1'), /retained/); assert.equal(posts, 1);
  assert.deepEqual(restored.getBundle(row.id).receipt, row.receipt);
});

test('missing batch support, stale basis and oversized whole command refuse before any intent', async t => {
  const store = new DraftStore(privateDirectory(t)), row = bundleDraft(store); let posts = 0;
  const client = {origin, snapshot: bundleState(), codingTool: async () => {posts++; return bundleCandidate(row);}};
  await assert.rejects(store.prepareBundle(row.id, client), /unsupported/);
  client.snapshot.sessions[0].source = {...basis, commit: '0v9'};
  await assert.rejects(store.prepareBundle(row.id, client, 'native-coding-patches-v1'), /source/);
  client.snapshot = bundleState(); client.snapshot.sessions[0].project = 'other';
  await assert.rejects(store.prepareBundle(row.id, client, 'native-coding-patches-v1'), /project/);
  client.snapshot = bundleState();
  for (const f of row.files) store.saveBundle(row.id, f.snapshot.path, 'x'.repeat(32768));
  await assert.rejects(store.prepareBundle(row.id, client, 'native-coding-patches-v1'), /whole bundle exceeds/);
  assert.equal(store.getBundle(row.id).pending, undefined); assert.equal(posts, 0);
  assert.throws(() => bundleCandidateCommand([row.files[0], row.files[0]]), /duplicate/);
  assert.throws(() => bundleCandidateCommand([{snapshot: row.files[0].snapshot, text: row.files[0].snapshot.text}]), /change/);
});

test('lost whole-bundle delivery survives restart and cannot be guessed or automatically replayed', async t => {
  const directory = privateDirectory(t), store = new DraftStore(directory), row = bundleDraft(store); let posts = 0;
  const client = {origin, snapshot: bundleState(), codingTool: async () => {posts++; throw new Error('lost reply');}};
  await assert.rejects(store.prepareBundle(row.id, client, 'native-coding-patches-v1'), /lost reply/);
  const restored = new DraftStore(directory);
  assert.equal(restored.getBundle(row.id).pending?.phase, 'unknown');
  restored.observeBundle(row.id, bundleCandidate(row)); // No retained request identity: do not guess.
  assert.equal(restored.getBundle(row.id).pending?.phase, 'unknown');
  await assert.rejects(restored.prepareBundle(row.id, client, 'native-coding-patches-v1'), /retained/); assert.equal(posts, 1);
});

test('bundle result refuses partial, duplicate, foreign and substituted content; later exact read can recover', async t => {
  const corruptions: ((output: JsonObject) => void)[] = [
    output => {output.edits = (output.edits as unknown[]).slice(0, 1);},
    output => {const e = output.edits as JsonObject[]; e[1] = e[0];},
    output => {(output.edits as JsonObject[])[1].before = '0x55';},
    output => {(output.edits as JsonObject[])[1].path = '/lib/foreign/hoon';},
    output => {((output.edits as JsonObject[])[1].content as JsonObject).digest = remoteSourceHash('different');},
    output => {((output.edits as JsonObject[])[1].content as JsonObject).bytes = 1;},
    output => {output.context = {session: '0x1', request: '0x999', project: 'demo', source: basis};}
  ];
  for (const corrupt of corruptions) {
    const directory = privateDirectory(t), store = new DraftStore(directory), row = bundleDraft(store); let posts = 0;
    const client = {origin, snapshot: bundleState(), codingTool: async () => {posts++; return bundleCandidate(row, corrupt);}};
    await assert.rejects(store.prepareBundle(row.id, client, 'native-coding-patches-v1'));
    const restored = new DraftStore(directory); assert.equal(restored.getBundle(row.id).pending?.phase, 'unknown');
    assert.equal(restored.getBundle(row.id).pending?.request, '0x777');
    restored.observeBundle(row.id, bundleCandidate(row)); assert.equal(restored.getBundle(row.id).pending?.phase, 'candidate');
    assert.equal(posts, 1);
  }
});

test('native batch refusal retains one whole request and never falls back to per-file submissions', async t => {
  const store = new DraftStore(privateDirectory(t)), row = bundleDraft(store); let posts = 0;
  const client = {origin, snapshot: bundleState(), codingTool: async () => {posts++; return bundleCandidate(row, output => {output.kind = 'refused'; output.reason = 'batch-not-permitted';});}};
  const result = await store.prepareBundle(row.id, client, 'native-coding-patches-v1');
  assert.equal(result.pending?.phase, 'refused');
  store.observeBundle(row.id, bundleCandidate(row)); assert.equal(store.getBundle(row.id).pending?.phase, 'refused');
  await assert.rejects(store.prepareBundle(row.id, client, 'native-coding-patches-v1')); assert.equal(posts, 1);
});

test('two windows compete for one durable bundle submission and stale saves cannot overwrite it', async t => {
  const directory = privateDirectory(t), first = new DraftStore(directory), row = bundleDraft(first), second = new DraftStore(directory); let posts = 0;
  const client = {origin, snapshot: bundleState(), codingTool: async () => {posts++; await new Promise(resolve => setImmediate(resolve)); return bundleCandidate(row);}};
  const results = await Promise.allSettled([first.prepareBundle(row.id, client, 'native-coding-patches-v1'), second.prepareBundle(row.id, client, 'native-coding-patches-v1')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(posts, 1);
  assert.throws(() => second.saveBundle(row.id, row.files[0].snapshot.path, 'stale edit\n'), /outside this editor/);
  assert.equal(new DraftStore(directory).getBundle(row.id).pending?.phase, 'candidate');
});

test('corrupt bundle members, altered intents and held locks refuse without touching scalar records', async t => {
  const directory = privateDirectory(t), store = new DraftStore(directory), scalar = store.create(snapshotFrom({...snapshot(), uri: undefined, key: undefined, path: '/lib/unrelated/hoon'}));
  const scalarFile = path.join(directory, `${scalar.id}.json`), scalarBytes = fs.readFileSync(scalarFile), row = bundleDraft(store);
  const file = path.join(directory, `bundle-${row.id}.json`), bytes = fs.readFileSync(file);
  fs.writeFileSync(path.join(directory, '.drafts.lock'), '', {mode: 0o600});
  assert.throws(() => store.saveBundle(row.id, row.files[0].snapshot.path, 'not saved\n'), /EEXIST/);
  assert.deepEqual(fs.readFileSync(file), bytes); fs.unlinkSync(path.join(directory, '.drafts.lock'));
  await assert.rejects(store.prepareBundle(row.id, {origin, snapshot: bundleState(), codingTool: async () => {throw new Error('lost');}}, 'native-coding-patches-v1'), /lost/);
  const frozen = fs.readFileSync(file);
  for (const corrupt of ['member', 'input', 'text', 'phase']) {
    const altered = JSON.parse(frozen.toString());
    if (corrupt === 'member') altered.files.pop();
    if (corrupt === 'input') altered.pending.input += 'tampered';
    if (corrupt === 'text') altered.pending.files[1].text = 'different intent\n';
    if (corrupt === 'phase') altered.pending.phase = ['unknown'];
    fs.writeFileSync(file, JSON.stringify(altered)); assert.throws(() => new DraftStore(directory));
    assert.deepEqual(fs.readFileSync(scalarFile), scalarBytes); fs.writeFileSync(file, frozen);
  }
  assert.equal(new DraftStore(directory).getBundle(row.id).pending?.phase, 'unknown');
});
