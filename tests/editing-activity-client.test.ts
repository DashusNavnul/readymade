import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type {AddressInfo} from 'node:net';
import {once} from 'node:events';
import {ShipClient, ShipClientError, OutcomeUnknownError} from '../src/ship-client';
import type {ActivityCommand, ActivitySelector} from '../src/editing-activity';

type Capture = {method: string; url: string; headers: http.IncomingHttpHeaders; body: string};
type Step = (capture: Capture, response: http.ServerResponse) => void;
const target = {owner: '~zod', project: 'demo'}, selector = {...target, request: '0v1'};
const command = {...target, operation: 'update' as const, epoch: '~2026.11.08', sequence: '1', desk: 'demo-work', path: '/lib/example/hoon'};
const pending = (request = '0v1') => ({schema: 'readymade-editing-activity-result-v1', ...target, request, status: 'pending', permissionGranted: false});
const ready = (request = '0v1', sequence = '1') => ({...pending(request), status: 'ready', reason: null, epoch: command.epoch,
  at: '~2026.11.08..00.00.01', selfSequence: sequence, rows: []});
const refused = () => ({...ready(), status: 'refused', reason: 'activity-permission-refused', epoch: null, at: null, selfSequence: null});
const blocked = (error: unknown) => error instanceof ShipClientError && error.code === 'commandBusy';
const json = (response: http.ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, {'content-type': 'application/json'}); response.end(JSON.stringify(value));
};
class Fixture {
  readonly captures: Capture[] = [];
  readonly steps: Step[] = [];
  readonly server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const captured = {method: request.method!, url: request.url!, headers: request.headers, body: Buffer.concat(chunks).toString('utf8')};
      this.captures.push(captured);
      const step = this.steps.shift();
      if (step) step(captured, response); else {response.writeHead(599); response.end();}
    });
  });
  reply(value: unknown, status = 200): void {this.steps.push((_capture, response) => json(response, value, status));}
  get posts(): number {return this.captures.filter(c => c.url === '/apps/readymade-editing/action').length;}
}
async function fixture(run: (f: Fixture, client: ShipClient) => Promise<void>, authenticated = true): Promise<void> {
  const f = new Fixture(); f.server.listen(0, '127.0.0.1'); await once(f.server, 'listening');
  const origin = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`;
  const client = new ShipClient(origin, async () => 'fixture-only-not-a-credential');
  try {
    if (authenticated) {
      f.steps.push((_capture, response) => {response.writeHead(200, {'set-cookie': 'urbauth-~zod=activity-fixture; Path=/'}); response.end();});
      await client.signIn();
    }
    await run(f, client); assert.equal(f.steps.length, 0);
  } finally {
    client.close(); f.server.closeAllConnections(); await new Promise<void>(resolve => f.server.close(() => resolve()));
  }
}

test('activity transport uses authenticated same-origin POST and exact-ID GET; refusal settles once', () => fixture(async (f, client) => {
  f.reply(pending(), 202); assert.equal((await client.activitySubmit(command)).status, 'pending');
  const sent = f.captures.at(-1)!;
  assert.equal(sent.method, 'POST'); assert.equal(sent.url, '/apps/readymade-editing/action');
  assert.equal(sent.headers.cookie, 'urbauth-~zod=activity-fixture'); assert.equal(sent.headers.origin, client.origin);
  assert.equal(sent.headers['content-type'], 'application/json'); assert.equal(sent.headers['x-readymade-editing-activity'], 'v1');
  assert.deepEqual(JSON.parse(sent.body), {schema: 'readymade-editing-activity-v1', ...command});
  await assert.rejects(client.activitySubmit(command), blocked); assert.equal(f.posts, 1);
  f.reply(pending(), 202); assert.equal((await client.activityResult(selector)).status, 'pending');
  const read = f.captures.at(-1)!;
  assert.equal(read.method, 'GET'); assert.equal(read.url, '/apps/readymade-editing/result'); assert.equal(read.body, '');
  assert.equal(read.headers['x-readymade-activity-owner'], target.owner); assert.equal(read.headers['x-readymade-project'], target.project);
  assert.equal(read.headers['x-readymade-activity-request'], selector.request); assert.equal(read.headers.cookie, sent.headers.cookie);
  await assert.rejects(client.activitySubmit(command), blocked);
  f.reply(refused()); assert.equal((await client.activityResult(selector)).status, 'refused');
  f.reply(pending('0v2'), 202); await client.activitySubmit(command); assert.equal(f.posts, 2);
}));

test('ready result is checked against retained command even when caller omits it', () => fixture(async (f, client) => {
  f.reply(pending(), 202); await client.activitySubmit(command);
  for (const altered of [{request: '0v2'}, {owner: '~nec'}, {epoch: '~2026.11.07'}, {selfSequence: '2'}]) {
    f.reply({...ready(), ...altered}); await assert.rejects(client.activityResult(selector));
    await assert.rejects(client.activitySubmit(command), blocked);
  }
  f.reply(ready()); assert.equal((await client.activityResult(selector)).status, 'ready');
  f.reply(pending('0v2'), 202); await client.activitySubmit({...command, sequence: '2'}); assert.equal(f.posts, 2);
}));

test('missing and expired results keep writes blocked while independent queries remain read-only', async () => {
  for (const [status, reason, result] of [[404, 'request-not-retained', 'missing'], [410, 'request-expired-outcome-unknown', 'expired']] as const) {
    await fixture(async (f, client) => {
      f.reply(pending(), 202); await client.activitySubmit(command);
      f.reply({status: 'unavailable', reason, permissionGranted: false}, status);
      assert.equal((await client.activityResult(selector)).status, result);
      await assert.rejects(client.activitySubmit(command), blocked);
      f.reply(pending('0v2'), 202); await client.activitySubmit({...target, operation: 'query'});
      assert.equal(JSON.parse(f.captures.at(-1)!.body).operation, 'query');
      f.reply(ready('0v2')); assert.equal((await client.activityResult({...selector, request: '0v2'})).status, 'ready');
      await assert.rejects(client.activitySubmit(command), blocked); assert.equal(f.posts, 2);
    });
  }
});

test('socket loss after publication keeps outcome unknown and never replays', () => fixture(async (f, client) => {
  f.steps.push((_capture, response) => response.socket!.destroy());
  await assert.rejects(client.activitySubmit(command), OutcomeUnknownError);
  await assert.rejects(client.activitySubmit(command), blocked); assert.equal(f.posts, 1);
  f.reply(pending('0v2'), 202); await client.activitySubmit({...target, operation: 'query'});
  f.reply(ready('0v2')); await client.activityResult({...selector, request: '0v2'});
  await assert.rejects(client.activitySubmit(command), blocked); assert.equal(f.posts, 2);
}));

test('unauthenticated and malformed operations issue no activity requests', async () => {
  await fixture(async (f, client) => {
    await assert.rejects(client.activitySubmit(command), error => error instanceof ShipClientError && error.code === 'authenticationRequired');
    await assert.rejects(client.activityResult(selector)); assert.equal(f.captures.length, 0);
  }, false);
  await fixture(async (f, client) => {
    for (const invalid of [{...command, sequence: '0'}, {...command, actor: '~nec'}, {...command, path: '/lib/../hoon'}]) {
      await assert.rejects(client.activitySubmit(invalid as ActivityCommand));
    }
    await assert.rejects(client.activityResult({...selector, request: '0v0'} as ActivitySelector));
    assert.equal(f.captures.length, 1); assert.equal(f.posts, 0);
  });
});

test('redirected or malformed POST replies never unlock or trigger automatic requests', async () => {
  for (const mode of ['redirect', 'malformed']) await fixture(async (f, client) => {
    f.steps.push((_capture, response) => {
      if (mode === 'redirect') {response.writeHead(307, {location: client.origin + '/redirect-target'}); response.end();}
      else json(response, {...pending(), owner: '~nec'}, 202);
    });
    await assert.rejects(client.activitySubmit(command), OutcomeUnknownError);
    await assert.rejects(client.activitySubmit(command), blocked);
    assert.equal(f.posts, 1); assert.equal(f.captures.length, 2);
  });
});

test('only exact native pre-dispatch refusal permits a new explicit attempt', async () => {
  for (const [status, reason] of [[400, 'same-origin-command-required'], [403, 'owner-login-required'], [409, 'activity-request-capacity']] as const) {
    await fixture(async (f, client) => {
      f.reply({status: 'unavailable', reason, permissionGranted: false}, status);
      await assert.rejects(client.activitySubmit(command), error => error instanceof ShipClientError && error.code === 'refused');
      f.reply(pending(), 202); await client.activitySubmit(command); assert.equal(f.posts, 2);
    });
  }
});

test('late duplicate result cannot clear a newer pending write', {timeout: 5000}, () => fixture(async (f, client) => {
  f.reply(pending(), 202); await client.activitySubmit(command);
  let release!: () => void, received!: () => void;
  const arrived = new Promise<void>(resolve => {received = resolve;});
  f.steps.push((_capture, response) => {release = () => json(response, ready()); received();});
  const delayed = client.activityResult(selector); await arrived;
  f.reply(ready()); await client.activityResult(selector);
  f.reply(pending('0v2'), 202); await client.activitySubmit({...command, sequence: '2'});
  release(); assert.equal((await delayed).status, 'ready');
  await assert.rejects(client.activitySubmit({...command, sequence: '3'}), blocked); assert.equal(f.posts, 2);
  f.reply(ready('0v2', '2')); await client.activityResult({...selector, request: '0v2'});
  f.reply(pending('0v3'), 202); await client.activitySubmit({...command, sequence: '3'});
}));

test('closing client cancels an in-flight publication without a retry', {timeout: 5000}, () => fixture(async (f, client) => {
  let received!: () => void;
  const arrived = new Promise<void>(resolve => {received = resolve;});
  f.steps.push(() => received());
  const result = client.activitySubmit(command).then(() => undefined, error => error);
  await arrived; client.close();
  assert.ok(await result instanceof OutcomeUnknownError);
  await assert.rejects(client.activitySubmit(command), error => error instanceof ShipClientError && error.code === 'closed');
  assert.equal(f.posts, 1);
}));
