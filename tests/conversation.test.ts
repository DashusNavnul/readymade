import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore, type RequestEntry } from '../src/conversation-store';
import { OutcomeUnknownError, ShipClient, ShipClientError } from '../src/ship-client';
const origin = 'http://localhost:8080';
const fresh = () => new ConversationStore(mkdtempSync(join(tmpdir(), 'readymade-request-')), origin);

test('unknown POST survives restart and is never replayed; receipt settles original ID', async () => {
  const journal = fresh(); let calls = 0;
  const client = { origin, requestJSON: async () => { calls++; throw new Error('timeout'); } };
  await assert.rejects(journal.submit(client, 'private', 'hello'), /unconfirmed/);
  const restored = new ConversationStore(journal.directory, origin), entry = restored.entries[0];
  assert.equal(entry.status, 'unknown'); assert.equal(restored.draft('private'), 'hello');
  await assert.rejects(restored.submit(client, 'private', 'hello again'), /pending/); assert.equal(calls, 1);
  await restored.checkReceipts({ origin, requestJSON: async path => { assert.match(path, /receipt.json/); return { known: true, id: entry.id, destination: 'private', outcome: 'accepted' }; } });
  assert.equal(restored.entries[0].status, 'accepted');
});
test('exact receipts, distinct origin and byte limits are enforced before network', async () => {
  const j = fresh(), e = j.issue('seat:bachelor', 'request');
  assert.throws(() => j.receipt(e.id, { known: true, id: e.id, destination: 'private', outcome: 'accepted' }), /Mismatched/);
  assert.throws(() => j.issue('private', 'λ'.repeat(2049)), /UTF-8/);
  await assert.rejects(j.checkReceipts({ origin: 'https://elsewhere.example', requestJSON: async () => ({}) }), /origin/);
  j.receipt(e.id, { known: true, id: e.id, destination: 'seat', outcome: 'refused' });
  assert.throws(() => j.receipt(e.id, { known: true, id: e.id, destination: 'seat', outcome: 'accepted' }), /Contradictory/);
});
test('journal is private and refuses competing writers without losing evidence', () => {
  const j = fresh(); j.saveDraft('private', 'one'); const other = new ConversationStore(j.directory, origin);
  assert.equal(statSync(j.file).mode & 0o777, 0o600);
  j.saveDraft('private', 'two'); assert.throws(() => other.saveDraft('private', 'three'), /another window/);
  assert.equal(JSON.parse(readFileSync(j.file, 'utf8')).drafts.private, 'two');
  writeFileSync(j.file, '{}'); assert.throws(() => new ConversationStore(j.directory, origin), /Invalid/);
});

test('only proven preflight errors settle as not-sent; explicit next submit gets a fresh ID', async () => {
  for (const reason of ['commandBusy', 'closed', 'contextChanged', 'malformed', 'tooLarge', 'cancelledBeforeSend']) {
    const j = fresh(); let calls = 0;
    await assert.rejects(j.submit({ origin, requestJSON: async () => { calls++; throw new ShipClientError(reason); } }, 'private', 'keep this draft'), /not sent/);
    const old = j.entries[0]; assert.equal(old.status, 'not-sent'); assert.equal(j.draft('private'), 'keep this draft');
    const restored = new ConversationStore(j.directory, origin);
    await restored.checkReceipts({ origin, requestJSON: async () => { throw new Error('A not-sent ID must never be checked or replayed'); } });
    const sent = await restored.submit({ origin, requestJSON: async (_path, options) => {
      calls++; assert.notEqual(options?.body?.id, old.id);
      assert.equal(restored.entries.at(-1)!.status, 'unknown');
      return { known: true, id: options?.body?.id, destination: 'private', outcome: 'accepted' };
    } }, 'private', 'deliberate next request');
    assert.equal(calls, 2); assert.equal(sent.status, 'accepted'); assert.notEqual(sent.id, old.id);
    assert.throws(() => restored.receipt(old.id, { known: true, id: old.id, destination: 'private', outcome: 'accepted' }), /Contradictory/);
  }
  for (const failure of [new OutcomeUnknownError(), new ShipClientError('transport'), new ShipClientError('refused', 409),
    new ShipClientError('authenticationRequired', 401), new ShipClientError('tooLarge', 200), new Error('unclassified')]) {
    const j = fresh(); await assert.rejects(j.submit({ origin, requestJSON: async () => { throw failure; } }, 'private', 'retained'), /unconfirmed/);
    assert.equal(j.entries[0].status, 'unknown'); assert.throws(() => j.issue('private', 'again'), /pending/);
  }
});

test('actual busy ShipClient performs no request and releases destination only for a deliberate new send', async () => {
  let release: (() => void) | undefined, count = 0;
  const server = createServer((request, response) => {
    count++; const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk)); request.on('end', () => {
      const finish = (value: unknown) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (request.url === '/apps/hold') release = () => finish({});
      else { const body = JSON.parse(Buffer.concat(chunks).toString()); finish({ known: true, id: body.id, destination: 'private', outcome: 'accepted' }); }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, client = new ShipClient(local);
  const j = new ConversationStore(mkdtempSync(join(tmpdir(), 'readymade-request-http-')), local);
  try {
    const held = client.requestJSON('/apps/hold', { method: 'POST', body: {} });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(j.submit(client, 'private', 'not transmitted'), /not sent/);
    assert.equal(count, 1); assert.equal(j.entries[0].status, 'not-sent'); const old = j.entries[0].id;
    release(); await held;
    const next = await j.submit(client, 'private', 'explicit next send');
    assert.equal(next.status, 'accepted'); assert.notEqual(next.id, old); assert.equal(count, 2);
  } finally { client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('late seat submission acknowledgment cannot downgrade a concurrent settled ship receipt or clear a newer draft', async () => {
  for (const outcome of ['accepted', 'refused'] as const) {
    const j = fresh(); let acknowledge: ((value: { submitted: boolean; id: string; seat: string }) => void) | undefined;
    const pending = j.submit({ origin, requestJSON: async () => await new Promise(resolve => { acknowledge = resolve; }) }, 'seat:bachelor', 'original');
    const id = j.entries[0].id;
    j.saveDraft('seat:bachelor', 'newer draft');
    j.receipt(id, { known: true, id, destination: 'seat', outcome });
    assert.equal(j.entries[0].status, outcome);
    acknowledge!({ submitted: true, id, seat: 'bachelor' });
    assert.equal((await pending).status, outcome); assert.equal(j.draft('seat:bachelor'), 'newer draft');
    assert.equal(new ConversationStore(j.directory, origin).entries[0].status, outcome);
  }
});

function archives(j: ConversationStore): RequestEntry[] {
  return readdirSync(j.directory).filter(name => name.includes('.archive-') && name.endsWith('.json')).flatMap(name => {
    const file = join(j.directory, name), bytes = readFileSync(file), parsed = JSON.parse(bytes.toString());
    assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(parsed.origin, origin); assert.deepEqual(parsed.drafts, {});
    assert.ok(name.endsWith(createHash('sha256').update(bytes).digest('hex') + '.json'));
    assert.ok(parsed.entries.every((e: RequestEntry) => ['accepted', 'refused', 'not-sent'].includes(e.status)));
    return parsed.entries as RequestEntry[];
  });
}
test('130 requests preserve every ID across durable archives while unresolved intent and drafts remain active', async () => {
  const j = fresh(), ids = new Set<string>(), pending = j.issue('seat:bachelor', 'uncertain original'); ids.add(pending.id);
  j.saveDraft('private', 'newer private draft');
  for (let i = 0; i < 130; i++) {
    const e = j.issue('private', 'request ' + i); ids.add(e.id);
    j.receipt(e.id, { known: true, id: e.id, destination: 'private', outcome: i % 2 ? 'accepted' : 'refused' });
    assert.ok(j.entries.length <= 64);
  }
  const archived = archives(j); assert.ok(archived.length >= 64);
  assert.deepEqual(new Set([...archived, ...j.entries].map(e => e.id)), ids);
  assert.equal(j.entries.find(e => e.id === pending.id)!.status, 'unknown'); assert.equal(j.draft('private'), 'newer private draft');
  const restored = new ConversationStore(j.directory, origin); assert.deepEqual(restored.entries, j.entries);
  let checks = 0; await restored.checkReceipts({ origin, requestJSON: async () => { checks++; return { known: false, id: pending.id }; } });
  assert.equal(checks, 1); assert.throws(() => restored.issue('seat:bachelor', 'again'), /pending/);
  while (restored.entries.length < 64) {
    const e = restored.issue('private', 'fill before explicit submit');
    restored.receipt(e.id, { known: true, id: e.id, destination: 'private', outcome: 'accepted' });
  }
  const before = archives(restored).length;
  await restored.submit({ origin, requestJSON: async (_path, options) => {
    assert.ok(archives(restored).length > before);
    assert.ok(JSON.parse(readFileSync(restored.file, 'utf8')).entries.some((e: RequestEntry) => e.id === options?.body?.id && e.status === 'unknown'));
    return { known: true, id: options?.body?.id, destination: 'private', outcome: 'accepted' };
  } }, 'private', 'deliberate after archival');
});

test('archive conflict or unsafe permissions prevent the next POST and preserve original evidence', async () => {
  for (const unsafe of [false, true]) {
    const j = fresh(), pending = j.issue('seat:bachelor', 'uncertain original');
    for (let i = 0; i < 63; i++) { const e = j.issue('private', 'old ' + i); j.receipt(e.id, { known: true, id: e.id, destination: 'private', outcome: 'accepted' }); }
    const original = j.entries, bytes = JSON.stringify({ version: 1, origin, entries: original.filter(e => e.status === 'accepted').slice(0, 32), drafts: {} });
    const archive = j.file.replace(/\.json$/, '') + '.archive-' + createHash('sha256').update(bytes).digest('hex') + '.json';
    writeFileSync(archive, unsafe ? bytes : 'conflict', { mode: 0o600 }); if (unsafe) chmodSync(archive, 0o644);
    let posts = 0; await assert.rejects(j.submit({ origin, requestJSON: async () => { posts++; return {}; } }, 'private', 'new draft'), /archive|Unsafe/);
    assert.equal(posts, 0); assert.deepEqual(j.entries, original); assert.equal(j.draft('private'), 'new draft');
    assert.equal(j.entries.find(e => e.id === pending.id)!.status, 'unknown'); assert.equal(readFileSync(archive, 'utf8'), unsafe ? bytes : 'conflict');
  }
});

test('encoded byte capacity archives settled evidence below 64 entries; unresolved saturation never prunes', () => {
  const j = fresh(), ids = new Set<string>(); let peak = 0;
  for (let i = 0; i < 50; i++) {
    const e = j.issue('private', 'request ' + i); ids.add(e.id);
    j.receipt(e.id, { known: true, id: e.id, destination: 'private', outcome: 'accepted', reason: '\0'.repeat(8192) });
    peak = Math.max(peak, j.entries.length); assert.ok(statSync(j.file).size <= 1024 * 1024);
  }
  assert.ok(peak < 64 && archives(j).length > 0); assert.deepEqual(new Set([...archives(j), ...j.entries].map(e => e.id)), ids);
  const saturated = fresh();
  for (let i = 0; i < 64; i++) saturated.issue('seat:agent-' + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + i % 26), 'unresolved');
  const baseline = readFileSync(saturated.file);
  assert.throws(() => saturated.issue('private', 'blocked'), /full/);
  assert.deepEqual(readFileSync(saturated.file), baseline); assert.equal(archives(saturated).length, 0);
});

const archiveFile = (j: ConversationStore, value: unknown) => {
  const bytes = JSON.stringify(value), hash = createHash('sha256').update(bytes).digest('hex');
  const file = j.file.replace(/\.json$/, '') + '.archive-' + hash + '.json';
  writeFileSync(file, bytes, {mode: 0o600}); return file;
};
const historical = (i = 1) => ({id: '0v' + i.toString(32), destination: 'private', text: 'historical ' + i,
  at: new Date(0).toISOString(), status: 'accepted' as const});
const archived = (entries: unknown[], extra = {}) => ({version: 1, origin, entries, drafts: {}, ...extra});

test('archive pages expose every settled receipt without reading another origin or changing unknown intent', async () => {
  const j = fresh(), pending = j.issue('seat:bachelor', 'unknown');
  j.saveDraft('private', 'retained draft');
  for (let i = 0; i < 130; i++) {const e = j.issue('private', String(i)); j.receipt(e.id, {known: true, id: e.id, destination: 'private', outcome: 'accepted'});}
  const before = readFileSync(j.file), expected = archives(j), actual: RequestEntry[] = [];
  const foreign = new ConversationStore(j.directory, 'https://foreign.example');
  writeFileSync(foreign.file.replace(/\.json$/, '') + '.archive-' + 'f'.repeat(64) + '.json', 'not JSON', {mode: 0o600});
  for await (const page of j.archivePages()) {
    assert.ok(page.examined <= 256); assert.ok(page.rows.length <= 256);
    actual.push(...page.rows.map(row => row.entry));
  }
  assert.deepEqual(new Set(actual.map(e => e.id)), new Set(expected.map(e => e.id)));
  assert.ok(!actual.some(e => e.id === pending.id)); assert.deepEqual(readFileSync(j.file), before);
  assert.equal(j.draft('private'), 'retained draft');
});

test('archive browser advances bounded pages including empty unrelated pages', async () => {
  const j = fresh();
  for (let i = 0; i < 300; i++) writeFileSync(join(j.directory, 'unrelated-' + i), '', {mode: 0o600});
  const empty = j.archivePages(), first = await empty.next();
  assert.equal(first.value!.examined, 256); assert.equal(first.value!.complete, false); assert.deepEqual(first.value!.rows, []);
  await empty.return(undefined);
  for (let i = 1; i <= 17; i++) archiveFile(j, archived([historical(i)]));
  let count = 0, pages = 0;
  for await (const page of j.archivePages()) {pages++; count += page.rows.length; assert.ok(new Set(page.rows.map(r => r.archive)).size <= 8);}
  assert.equal(count, 17); assert.ok(pages >= 3);
});

test('archive browser rejects malformed, foreign, unresolved, altered or unsafe published evidence', async () => {
  for (const kind of ['hash', 'origin', 'unknown', 'draft', 'malformed', 'permissions', 'symlink', 'hardlink', 'name']) {
    const j = fresh();
    const value = kind === 'malformed' ? null : archived([{...historical(), ...(kind === 'unknown' ? {status: 'unknown'} : {})}],
      kind === 'origin' ? {origin: 'https://foreign.example'} : kind === 'draft' ? {drafts: {private: 'retained'}} : {});
    const file = archiveFile(j, value);
    if (kind === 'hash') writeFileSync(file, '{}');
    if (kind === 'permissions') chmodSync(file, 0o644);
    if (kind === 'hardlink') linkSync(file, join(j.directory, 'linked'));
    if (kind === 'symlink') {
      const target = j.file.replace(/\.json$/, '') + '.archive-' + 'a'.repeat(64) + '.json'; symlinkSync(file, target);
    }
    if (kind === 'name') writeFileSync(j.file.replace(/\.json$/, '') + '.archive-invalid.json', '{}', {mode: 0o600});
    await assert.rejects(async () => {for await (const _page of j.archivePages()) { /* consume only fixtures */ }});
    assert.equal(readFileSync(file, 'utf8'), kind === 'hash' ? '{}' : JSON.stringify(value));
  }
});
