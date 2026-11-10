import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchPlanetCatalog} from '../src/planet-catalog';
const planet = {patp: '~sampel-palnet', status: 'available'};
const response = (value: unknown) => new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json; charset=utf-8'}});
const serve = (value: unknown): typeof fetch => async () => response(value);

test('catalog is a single fixed cookie-free GET, preserves statuses, and timestamps a validated read', async () => {
  let calls = 0; const before = Date.now();
  const result = await fetchPlanetCatalog(async (url, options) => {
    calls++; assert.equal(url, 'https://updates.orraah.com/api/planets');
    assert.equal(options?.method, 'GET'); assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'error');
    assert.deepEqual(options?.headers, {Accept: 'application/json'}); assert.equal(options?.body, undefined);
    assert.equal(options?.signal?.aborted, false);
    return response({planets: [planet, {patp: '~abcdef-ghijkl', status: 'reserved'}]});
  });
  assert.equal(calls, 1); assert.equal(result.planets.length, 2); assert.equal(result.planets[1].status, 'reserved');
  assert.ok(Date.parse(result.observedAt) >= before && Date.parse(result.observedAt) <= Date.now());
  assert.deepEqual((await fetchPlanetCatalog(serve({planets: []}))).planets, []);
});

test('streamed JSON is decoded only after all chunks and a strict UTF-8 byte bound', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({planets: [planet]}));
  const chunks = [bytes.slice(0, 7), bytes.slice(7, 25), bytes.slice(25)];
  const result = await fetchPlanetCatalog(async () => new Response(new ReadableStream<Uint8Array>({pull(controller) {
    const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close();
  }}), {headers: {'content-type': 'application/json'}}));
  assert.deepEqual(result.planets, [planet]);
  const exact = JSON.stringify({planets: []}).padEnd(128 * 1024, ' ');
  assert.deepEqual((await fetchPlanetCatalog(async () => new Response(exact, {headers: {'content-type': 'application/json'}}))).planets, []);
  await assert.rejects(fetchPlanetCatalog(async () => new Response(exact + ' ', {headers: {'content-type': 'application/json'}})), /too large/);
  await assert.rejects(fetchPlanetCatalog(async () => new Response(new Uint8Array([0xff]), {headers: {'content-type': 'application/json'}})), /could not be read/);
});

test('malformed and ambiguous catalogs are errors, never empty success', async () => {
  for (const value of [null, [], {}, {planets: [], secret: 'private'}, {planets: [planet, planet]},
    {planets: [{...planet, id: 1}]}, {planets: [{patp: planet.patp}]}, {planets: [{...planet, status: 'Available'}]},
    {planets: [{...planet, status: 'x'.repeat(33)}]}, {planets: [{...planet, patp: '~sampél-palnet'}]},
    {planets: [{...planet, status: '\ud800'}]}, {planets: [{...planet, status: 'available\n'}]},
    {planets: [{...planet, patp: planet.patp + '\n'}]}, {planets: Array.from({length: 257}, () => planet)}]) {
    await assert.rejects(fetchPlanetCatalog(serve(value)), /invalid/);
  }
});

test('HTTP, redirect, content-type and network failures are bounded safe errors with no retry', async () => {
  for (const status of [201, 204, 301, 403, 500]) {
    let calls = 0;
    await assert.rejects(fetchPlanetCatalog(async () => {calls++; return new Response(null, {status});}), /unavailable/);
    assert.equal(calls, 1);
  }
  await assert.rejects(fetchPlanetCatalog(async () => new Response('{"planets":[]}', {headers: {'content-type': 'text/html'}})), /invalid/);
  await assert.rejects(fetchPlanetCatalog(async () => {throw Error('private server details');}), error => error instanceof Error && !error.message.includes('private'));
  const redirected = response({planets: []}); Object.defineProperty(redirected, 'redirected', {value: true});
  await assert.rejects(fetchPlanetCatalog(async () => redirected), /unavailable/);
});

test('the eight-second bound covers both uncooperative fetch and a stalled response body', async () => {
  const signals: AbortSignal[] = []; let canceled = false;
  const requests = [fetchPlanetCatalog(async (_url, options) => {
    signals.push(options!.signal!); return new Promise<Response>(() => undefined);
  }), fetchPlanetCatalog(async (_url, options) => {
    signals.push(options!.signal!);
    return new Response(new ReadableStream<Uint8Array>({cancel() {canceled = true;}}), {headers: {'content-type': 'application/json'}});
  })];
  await Promise.all(requests.map(request => assert.rejects(request, /timed out/)));
  assert.equal(signals.length, 2); assert.ok(signals.every(signal => signal.aborted)); assert.equal(canceled, true);
});


test('closing the caller cancels a pending body and already-canceled calls never fetch', async () => {
  const caller = new AbortController(); let canceled = false; let observed: AbortSignal | undefined;
  const request = fetchPlanetCatalog(async (_url, options) => {
    observed = options!.signal!;
    return new Response(new ReadableStream<Uint8Array>({cancel() {canceled = true;}}), {headers: {'content-type': 'application/json'}});
  }, caller.signal);
  await new Promise(resolve => setImmediate(resolve));
  caller.abort();
  await assert.rejects(request, /canceled/); assert.equal(observed?.aborted, true); assert.equal(canceled, true);
  let calls = 0;
  await assert.rejects(fetchPlanetCatalog(async () => {calls++; return response({planets: []});}, caller.signal), /canceled/);
  assert.equal(calls, 0);
});
