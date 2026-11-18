import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {OutcomeUnknownError, ShipClient, ShipClientError} from '../src/ship-client';

const TASKS = '/apps/pataphor-native/coding/tasks', NOTICES = '/apps/readymade-collab/notices', RETRY = '/apps/readymade-collab/notice-retry';
type Answer = (req: http.IncomingMessage, res: http.ServerResponse) => void;
/** A ship that signs anyone in and answers each native page as the test says. Counts what reached it. */
async function ship(answer: Answer): Promise<{client: ShipClient; seen: string[]; close(): Promise<void>}> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/~/login') {req.resume(); res.setHeader('Set-Cookie', 'urbauth-~zod=fixture; Path=/'); res.end(); return;}
    seen.push(`${req.method} ${req.url}`); req.resume(); req.on('end', () => answer(req, res));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new ShipClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async () => 'fixture');
  await client.signIn();
  return {client, seen, close: async () => {client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}};
}
const json = (res: http.ServerResponse, status: number, value: unknown): void => {res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));};
const code = (expected: string, status?: number) => (error: unknown): boolean => error instanceof ShipClientError && error.code === expected && (status === undefined || error.status === status);

test('a native page answers with its status and words; a refusal is an answer, not an error', async () => {
  const s = await ship((req, res) => req.method === 'POST' ? json(res, 409, {error: 'question-answered'}) : json(res, 200, {schema: 'owner-tasks-v1', available: false}));
  try {
    assert.deepEqual(await s.client.nativePage(TASKS), {status: 200, value: {schema: 'owner-tasks-v1', available: false}});
    assert.deepEqual(await s.client.nativePage(TASKS, {method: 'POST', body: {action: 'answer', id: '0x1', text: 'x'}}), {status: 409, value: {error: 'question-answered'}});
    assert.deepEqual(s.seen, [`GET ${TASKS}`, `POST ${TASKS}`]);
  } finally {await s.close();}
});

test('a page or method that is not listed is never requested', async () => {
  const s = await ship((_req, res) => json(res, 200, {}));
  try {
    await assert.rejects(s.client.nativePage('/apps/pataphor-native/coding/state'), code('contextChanged'));
    await assert.rejects(s.client.nativePage(NOTICES, {method: 'POST', body: {}}), code('contextChanged'));
    await assert.rejects(s.client.nativePage(TASKS, {method: 'POST'}), code('contextChanged'), 'a command needs a body');
    await assert.rejects(s.client.nativePage(TASKS + '?x=1'), code('contextChanged'));
    assert.deepEqual(s.seen, []);
  } finally {await s.close();}
});

test('a command the ship took but answered unreadably has an unknown outcome; a read is only unreadable', async () => {
  let status = 500;
  const s = await ship((_req, res) => {res.statusCode = status; res.setHeader('Content-Type', 'text/html'); res.end('<h1>crash</h1>');});
  try {
    await assert.rejects(s.client.nativePage(RETRY, {method: 'POST', body: {id: '0x1'}}), OutcomeUnknownError);
    status = 200; await assert.rejects(s.client.nativePage(RETRY, {method: 'POST', body: {id: '0x1'}}), OutcomeUnknownError, 'even a 200 that cannot be read');
    await assert.rejects(s.client.nativePage(NOTICES), code('malformed', 200));
    // A ship with no such page did nothing, for a read and for a command alike.
    status = 404; await assert.rejects(s.client.nativePage(RETRY, {method: 'POST', body: {id: '0x1'}}), code('unavailable', 404));
    await assert.rejects(s.client.nativePage(NOTICES), code('unavailable', 404));
    assert.equal(s.seen.length, 5, 'each request went out exactly once');
  } finally {await s.close();}
});

test('a command whose connection is cut has an unknown outcome and is not sent again; a cut read is a transport failure', async () => {
  const s = await ship(req => {req.socket.destroy();});
  try {
    await assert.rejects(s.client.nativePage(RETRY, {method: 'POST', body: {id: '0x1'}}), OutcomeUnknownError);
    assert.deepEqual(s.seen, [`POST ${RETRY}`]);
    await assert.rejects(s.client.nativePage(NOTICES), code('transport'));
  } finally {await s.close();}
});

test('the owner console says a signed-out window in its own words; that is a sign-out, and a plain 403 refusal is not', async () => {
  let words = 'Owner authentication required.';
  const s = await ship((_req, res) => {res.statusCode = 403; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({error: words}));});
  try {
    await assert.rejects(s.client.nativePage(NOTICES), code('authenticationRequired', 403));
    await assert.rejects(s.client.nativePage(RETRY, {method: 'POST', body: {id: '0x1'}}), code('authenticationRequired', 403));
    words = 'notice-not-unknown';
    assert.deepEqual(await s.client.nativePage(RETRY, {method: 'POST', body: {id: '0x1'}}), {status: 403, value: {error: 'notice-not-unknown'}}, 'any other 403 is the ship\'s own refusal, kept as it is');
  } finally {await s.close();}
});

test('a ship that signed the window out refused before doing anything', async () => {
  let status = 401;
  const s = await ship((_req, res) => {res.statusCode = status; if (status === 307) res.setHeader('Location', '/~/login'); res.end();});
  try {
    await assert.rejects(s.client.nativePage(RETRY, {method: 'POST', body: {id: '0x1'}}), code('authenticationRequired', 401));
    status = 307; await assert.rejects(s.client.nativePage(NOTICES), code('authenticationRequired', 307));
    await assert.rejects(s.client.nativePage(RETRY, {method: 'POST', body: {id: '0x1'}}), code('authenticationRequired', 307));
    assert.equal(s.seen.filter(line => line.startsWith('POST')).length, 2, 'a redirect is never followed with the command\'s body');
  } finally {await s.close();}
});
