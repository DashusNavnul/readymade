import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type ServerResponse} from 'node:http';
import {documentJSON, documentBody, documentHistory, documentNoteId, documentNotes, documentSnapshot, documentSaveIntent, documentSaveResult, documentReceiptSelector, documentReceipt, documentCapability, type DocumentUpdate} from '../src/noltbook-documents';
import {NoltbookDocumentClient, DocumentOutcomeUnknown} from '../src/noltbook-document-client';
import {NoltbookDocumentStore} from '../src/noltbook-document-store';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const native = {noteId: 'doc-one', body: 'Original 😀', revision: 1, updatedBy: '~zod', updatedAt: '~2026.11.09..12.01.01', versions: 0, bytes: 0, host: '~zod', canEdit: true};
const reply = (requestId: number, result = 'saved', revision: number | null = 2) => ({noteId: 'doc-one', requestId, result, revision, limit: null});
test('durable receipt binds every immutable request field and cannot upgrade a legacy intent', () => {
  const snapshot = documentSnapshot(native, 'https://zod.example', '~zod'), intent = documentSaveIntent(snapshot, 'shared 🌙', 44, 'receipted-v1');
  const value = {schema: 'noltbook-document-receipt-v1', ...documentReceiptSelector(intent), status: 'recorded',
    receipt: {result: 'saved', revision: 2, limit: null, recordedAt: native.updatedAt}};
  assert.equal(documentReceipt(value, intent).receipt?.revision, 2);
  for (const patch of [{host: '~nec'}, {requester: '~nec'}, {requestId: 45}, {expected: 2}, {bodyHash: '0x0'}, {noteId: 'other'}, {receipt: null}, {extra: true}])
    assert.throws(() => documentReceipt({...value, ...patch}, intent));
  assert.throws(() => documentReceipt({...value, receipt: {...value.receipt, revision: 3}}, intent));
  assert.throws(() => documentReceipt(value, documentSaveIntent(snapshot, intent.body, intent.requestId)));
  assert.throws(() => documentCapability({schema: 'noltbook-document-receipts-capability-v1', ship: '~nec', version: 1, capacity: 256, retained: 0}, '~zod'));
});
test('strict document codecs retain Unicode, exact identities, bounded history and typed conflicts', () => {
  assert.equal(documentBody('😀 café'), '😀 café');
  assert.throws(() => documentJSON('{"revision":1,"revision":2}'));
  assert.throws(() => documentJSON('{"nested":{"a":1,"a":2}}'));
  for (const body of ['\ud800', '\0', 'a'.repeat(1_048_577)]) assert.throws(() => documentBody(body));
  for (const id of ['../x', 'x/y', 'x?y', '.', '']) assert.throws(() => documentNoteId(id));
  assert.throws(() => documentSnapshot({...native, revision: Number.MAX_SAFE_INTEGER + 1}, 'https://example.org', '~zod'));
  assert.equal(documentSaveResult(reply(12, 'conflict', 4)).result, 'conflict');
  assert.throws(() => documentSaveResult({...reply(12), unexpected: true}));
  assert.throws(() => documentSaveResult(reply(12, 'denied', 4)));
  const version = {revision: 1, body: 'prior', savedBy: '~zod', savedAt: native.updatedAt};
  assert.throws(() => documentHistory({noteId: 'doc-one', versions: 2, bytes: 10, entries: [version, version], isHost: true}));
  const note = {id: 'doc-one', name: 'Shared plan', type: 'document', creator: '~zod', visibility: 'private', iconUrl: null, headline: null, userCount: 2, lastPreview: null, app: null, active: null};
  assert.deepEqual(documentNotes({notes: [note]}), [{id: 'doc-one', name: 'Shared plan', host: '~zod'}]);
  assert.throws(() => documentNotes({notes: [note, note]}));
});
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {if (Date.now() > deadline) throw new Error('Missing native fixture event'); await new Promise(r => setTimeout(r, 5));}
}
test('native save requires durable intent, exact typed result and matching revision; reconnect never resends', async t => {
  const streams: ServerResponse[] = [], actions: Record<string, unknown>[] = [], updates: DocumentUpdate[] = [];
  let persisted = false, event = 0, failures = 0;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.cookie, 'urbauth-~zod=private-fixture');
    if (request.url?.startsWith('/~/scry/')) {response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(native)); return;}
    if (request.method === 'GET') {streams.push(response); response.writeHead(200, {'content-type': 'text/event-stream'}); response.flushHeaders(); return;}
    let body = ''; for await (const b of request) body += b;
    for (const action of JSON.parse(body)) {if (action.action === 'poke') assert.equal(persisted, true); actions.push(action);}
    response.writeHead(204).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const connection = {origin, browserCookies: () => [{name: 'urbauth-~zod', value: 'private-fixture'}]};
  const client = new NoltbookDocumentClient(connection, u => updates.push(u), () => failures++);
  const emit = (json: object, id = ++event): void => {streams.at(-1)!.write(`id: ${id}\ndata: ${JSON.stringify({id: 1, response: 'diff', json})}\n\n`);};
  let reopened: NoltbookDocumentClient | undefined;
  try {
    await client.start(); await until(() => streams.length === 1);
    await assert.rejects(client.save(documentSaveIntent(documentSnapshot(native, origin, '~zod'), 'changed', 111), async () => undefined), /Read this exact/);
    const snapshot = await client.read('doc-one'), intent = documentSaveIntent(snapshot, 'Changed 😀', 1234);
    let settled = false;
    const saving = client.save(intent, async () => {persisted = true;}).then(r => {settled = true; return r;});
    await until(() => actions.some(a => a.action === 'poke'));
    assert.equal(settled, false, 'HTTP poke acknowledgement is not save completion');
    emit({'document-save-result': reply(9999)});
    emit({'document-save-result': reply(intent.requestId)});
    await new Promise(r => setTimeout(r, 20)); assert.equal(settled, false, 'Typed result alone cannot discard the draft');
    const {host: _host, canEdit: _canEdit, ...update} = native; void _host; void _canEdit;
    emit({'document-updated': {...update, body: intent.body, revision: 2}});
    assert.equal((await saving).result, 'saved');
    emit({'document-updated': update}); emit({'document-updated': {...update, body: intent.body, revision: 2}});
    await new Promise(r => setTimeout(r, 20)); assert.equal(updates.length, 1);
    await assert.rejects(client.save(intent, async () => undefined), /cannot be resent/);
    const other = documentSaveIntent(snapshot, 'another', 1235), pending = client.save(other, async () => undefined);
    await until(() => actions.filter(a => a.action === 'poke').length === 2);
    emit({'document-save-result': reply(1235, 'conflict', 2)});
    assert.equal((await pending).result, 'conflict');
    await client.close();
    reopened = new NoltbookDocumentClient(connection, () => undefined, () => failures++);
    await reopened.start(); await until(() => streams.length === 2); await reopened.read('doc-one');
    t.mock.timers.enable({apis: ['setTimeout']});
    const timed = reopened.check(intent); void timed.catch(() => undefined);
    t.mock.timers.tick(30001); await assert.rejects(timed, DocumentOutcomeUnknown); t.mock.timers.reset();
    const observed = reopened.check(intent); void observed.catch(() => undefined);
    await reopened.close(); await assert.rejects(observed, DocumentOutcomeUnknown);
    assert.equal(actions.filter(a => a.action === 'poke').length, 2, 'Reconnect observation sends no edit');
    assert.equal(failures, 0);
  } finally {await client.close(); await reopened?.close(); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});

test('durable save recovers after reconnect and later edits without resending or inventing a snapshot', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'readymade-receipted-document-')), streams: ServerResponse[] = [];
  let current = {...native}, retained: Record<string, unknown> | undefined, mode = 'recorded', edits = 0, queries = 0, event = 0, revoked = false;
  const emit = (json: unknown) => streams.at(-1)!.write(`id: ${++event}\ndata: ${JSON.stringify({id: 1, response: 'diff', json})}\n\n`);
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.cookie, 'urbauth-~zod=fixture');
    if (req.url?.startsWith('/~/scry/')) {
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/api/document-receipts.json')) {res.end(JSON.stringify({schema: 'noltbook-document-receipts-capability-v1', ship: '~zod', version: 1, capacity: 256, retained: edits})); return;}
      if (req.url.includes('/api/document-receipts/')) {
        assert.ok(req.url.endsWith('/~zod/doc-one/12.345.json'));
        if (mode === 'missing') {res.writeHead(404).end('{}'); return;}
        res.end(JSON.stringify(mode === 'pending' ? {...retained, status: 'pending', receipt: null} : retained)); return;
      }
      if (revoked) {res.writeHead(403).end('{}'); return;}
      res.end(JSON.stringify(current)); return;
    }
    if (req.method === 'GET') {streams.push(res); res.writeHead(200, {'content-type': 'text/event-stream'}); res.flushHeaders(); return;}
    let body = ''; for await (const part of req) body += part;
    for (const packet of JSON.parse(body || '[]')) {
      if (packet.action !== 'poke') continue;
      const action = packet.json;
      if (action.action === 'save-document-receipted') {
        edits++; assert.equal(new NoltbookDocumentStore(directory).list()[0].pending?.protocol, 'receipted-v1');
        const intent = new NoltbookDocumentStore(directory).list()[0].pending!;
        assert.equal(action.data.host, '~zod');
        retained = {schema: 'noltbook-document-receipt-v1', ...documentReceiptSelector(intent), status: 'recorded', receipt: {result: 'saved', revision: 2, limit: null, recordedAt: native.updatedAt}};
        current = {...current, revision: 3, body: 'A later writer'};
        streams.at(-1)!.end();
      } else {
        assert.equal(action.action, 'request-document-save-receipt'); queries++;
        assert.deepEqual(action.data, documentReceiptSelector(new NoltbookDocumentStore(directory).list()[0].pending!));
        emit({'document-save-receipt': retained});
      }
    }
    res.writeHead(204).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`, connection = {origin, browserCookies: () => [{name: 'urbauth-~zod', value: 'fixture'}]};
  let client = new NoltbookDocumentClient(connection, () => {}, () => {});
  try {
    await client.start(); await until(() => streams.length === 1);
    const snapshot = await client.read('doc-one'), intent = documentSaveIntent(snapshot, 'My original edit', 12345, 'receipted-v1');
    const store = new NoltbookDocumentStore(directory), draft = store.open(snapshot); store.save(draft.id, intent.body);
    await assert.rejects(client.save(intent, async () => store.begin(draft.id, intent)), /Discover/); assert.equal(edits, 0);
    await client.capabilities();
    await assert.rejects(client.save(intent, async () => store.begin(draft.id, intent)), DocumentOutcomeUnknown); assert.equal(edits, 1);
    await client.close(); client = new NoltbookDocumentClient(connection, () => {}, () => {});
    await client.start(); await until(() => streams.length === 2); const latest = await client.read('doc-one');
    const restored = new NoltbookDocumentStore(directory), held = restored.get(draft.id).pending!;
    mode = 'missing'; await assert.rejects(client.check(held), DocumentOutcomeUnknown); assert.equal(queries, 0);
    mode = 'pending'; const result = await client.check(held); assert.equal(queries, 1); assert.equal(result.revision, 2); assert.equal(edits, 1);
    restored.settle(draft.id, result, latest, client.receipt(held));
    const finished = restored.get(draft.id); assert.equal(finished.pending, undefined); assert.equal(finished.body, intent.body);
    assert.equal(finished.snapshot.revision, 1); assert.equal(finished.remote.revision, 3); assert.equal(finished.history[0].receipt?.status, 'recorded');
    mode = 'recorded'; assert.equal((await client.check(held)).revision, 2); assert.equal(queries, 1); assert.equal(edits, 1);
    const legacy = documentSaveIntent(snapshot, 'legacy', 987);
    t.mock.timers.enable({apis: ['setTimeout']}); const waiting = client.check(legacy); void waiting.catch(() => {});
    t.mock.timers.tick(30001); await assert.rejects(waiting, DocumentOutcomeUnknown); t.mock.timers.reset();
    assert.equal(queries, 1); assert.equal(edits, 1, 'Legacy check cannot be upgraded into any write');
    // A new connection has never admitted the note. Revocation cannot hide this
    // actor's exact historical receipt or turn its recovery into another save.
    revoked = true; await client.close(); client = new NoltbookDocumentClient(connection, () => {}, () => {});
    await client.start(); await until(() => streams.length === 3);
    await assert.rejects(client.read('doc-one'), /Native document read unavailable/);
    const recovered = await client.check(held);
    assert.equal(recovered.revision, 2); assert.equal(recovered.requestId, held.requestId);
    assert.deepEqual(client.receipt(held), finished.history[0].receipt);
    assert.equal(queries, 1, 'Recorded receipt needs no recovery poke');
    assert.equal(edits, 1, 'Revoked-access recovery never sends another save');

  } finally {await client.close(); streams.forEach(s => s.end()); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, {recursive: true, force: true});}
});


test('missing native document has actionable feedback while absent receipt capability remains optional', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET'); assert.equal(req.headers.cookie, 'urbauth-~zod=fixture');
    requests.push(req.url!); res.writeHead(404, {'content-type': 'application/json'}).end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const client = new NoltbookDocumentClient({origin, browserCookies: () => [{name: 'urbauth-~zod', value: 'fixture'}]}, () => {}, () => {});
  try {
    await assert.rejects(client.read('doc-one'), /Native document read unavailable.*missing or no longer shared/);
    assert.equal(await client.capabilities(), undefined);
    assert.deepEqual(requests, ['/~/scry/noltbook/api/notes/doc-one/document.json', '/~/scry/noltbook/api/document-receipts.json']);
  } finally {await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});

for (const mode of ['hydrated', 'denied', 'wrong-note', 'lost', 'catalog-changed', 'revoked-after-pull', 'queued-timeout', 'queued-cancel'] as const) {
  test(`explicit peer Open hydrates once without saving: ${mode}`, async t => {
    const streams: ServerResponse[] = [], pokes: unknown[] = [];
    let hydrated = false, event = 0, documentReads = 0, active = true;
    let heldAck: ServerResponse | undefined;
    const note = {id: 'doc-one', name: 'Shared plan', type: 'document', creator: '~zod', visibility: 'private', iconUrl: null, headline: null, userCount: 2, lastPreview: null, app: null, active: null};
    const server = createServer(async (req, res) => {
      assert.equal(req.headers.cookie, 'urbauth-~per=fixture');
      if (req.url === '/~/scry/noltbook/api/notes.json') {res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({notes: [note]})); return;}
      if (req.url?.endsWith('/document.json')) {
        documentReads++;
        if (mode === 'denied' || hydrated && mode === 'revoked-after-pull') {res.writeHead(403).end(); return;}
        if (!hydrated) {res.writeHead(500, {'content-type': 'text/html'}).end('<code>failed scry</code>'); return;}
        res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({...native, noteId: mode === 'wrong-note' ? 'other-note' : 'doc-one'})); return;
      }
      if (req.method === 'GET') {streams.push(res); res.writeHead(200, {'content-type': 'text/event-stream'}); res.flushHeaders(); return;}
      let body = ''; for await (const chunk of req) body += chunk;
      if (mode.startsWith('queued-') && JSON.parse(body).some((packet: {action: string}) => packet.action === 'ack') && !heldAck) {heldAck = res; return;}
      for (const packet of JSON.parse(body)) if (packet.action === 'poke') {
        pokes.push(packet.json); assert.deepEqual(packet.json, {action: 'request-document', data: {noteId: 'doc-one'}});
        if (mode !== 'lost') hydrated = true;
        const {host: _host, canEdit: _edit, ...update} = native; void _host; void _edit;
        streams.at(-1)!.write(`id: ${++event}\ndata: ${JSON.stringify({id: 1, response: 'diff', json: {'document-updated': {...update, noteId: mode === 'lost' ? 'unrelated-note' : 'doc-one'}}})}\n\n`);
      }
      res.writeHead(204).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
    const client = new NoltbookDocumentClient({origin, browserCookies: () => [{name: 'urbauth-~per', value: 'fixture'}]}, () => {}, () => {});
    const actualTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => actualTimeout(callback, ms === 30000 ? 100 : ms, ...args));
    try {
      await client.start(); await until(() => streams.length === 1);
      await assert.rejects(client.read('doc-one')); assert.equal(pokes.length, 0, 'Plain read never hydrates');
      if (mode.startsWith('queued-')) {streams[0].write(`id: ${++event}\ndata: ${JSON.stringify({id: 1, response: 'diff', json: {}})}\n\n`); await until(() => !!heldAck);}
      const opening = client.open('doc-one', mode === 'catalog-changed' ? '~nec' : '~zod', () => active);
      void opening.catch(() => undefined);
      if (mode.startsWith('queued-')) {await until(() => documentReads === 2); await new Promise(r => actualTimeout(r, mode === 'queued-timeout' ? 150 : 20)); if (mode === 'queued-cancel') active = false; heldAck!.writeHead(204).end();}
      if (mode === 'hydrated') {const snapshot = await opening; assert.equal(snapshot.body, native.body); assert.equal(snapshot.host, '~zod'); assert.equal(snapshot.peer, '~per'); assert.equal(snapshot.canEdit, true);}
      else await assert.rejects(opening);
      assert.equal(pokes.length, ['denied', 'catalog-changed', 'queued-timeout', 'queued-cancel'].includes(mode) ? 0 : 1);
      assert.ok(documentReads <= 3, 'No polling or automatic request replay');
      if (mode === 'lost') await assert.rejects(client.save(documentSaveIntent(documentSnapshot(native, origin, '~per'), 'never save', 98), async () => {}), /Read this exact/);
    } finally {await client.close(); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
  });
}
