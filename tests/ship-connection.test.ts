import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {authenticateShip, normalizeShipAddress, type ShipAuthenticationOptions} from '../src/ship-connection';
import {ShipClient, ShipClientError} from '../src/ship-client';

const hasCode = (code: string) => (error: unknown) => error instanceof ShipClientError && error.code === code;
async function fixture(run: (origin: string, requests: string[], replies: Array<(res: http.ServerResponse) => void>) => Promise<void>) {
  const requests: string[] = [], replies: Array<(res: http.ServerResponse) => void> = [];
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/~/login');
    const chunks: Buffer[] = []; req.on('data', (b: Buffer) => chunks.push(b));
    req.on('end', () => {requests.push(new URLSearchParams(Buffer.concat(chunks).toString()).get('password')!); const reply = replies.shift(); if (reply) reply(res); else res.destroy();});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, replies);}
  finally {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
}
const accepted = (res: http.ServerResponse) => {res.writeHead(204, {'Set-Cookie': 'urbauth-~zod=session; Path=/; HttpOnly'}); res.end();};
const refused = (res: http.ServerResponse) => {res.writeHead(403); res.end();};
function callbacks(changes: Partial<ShipAuthenticationOptions> = {}): ShipAuthenticationOptions {
  return {readCode: async () => undefined, askCode: async () => undefined, saveCode: async () => {}, ensureOpen: () => {}, ...changes};
}
test('friendly addresses normalize only known Urbit paths and explicit loopback HTTP', () => {
  for (const [input, expected] of [['ship.example', 'https://ship.example'], [' localhost:8080/apps/groups ', 'http://localhost:8080'],
    ['127.0.0.1:8080/~/login', 'http://127.0.0.1:8080'], ['[::1]:8080/apps/noltbook/note-one', 'http://[::1]:8080'],
    ['https://SHIP.example/apps/groups/', 'https://ship.example'], ['https://ship.example/', 'https://ship.example']]) assert.equal(normalizeShipAddress(input!), expected);
  for (const input of ['https://user:secret@ship.example', 'ship.example/apps/x?code=secret', 'ship.example/#x', 'http://ship.example',
    'ship.example/proxy', 'ship.example/apps/x/../y', 'ship.example/apps/%2e%2e/x', 'ship.example\\apps', 'ship.example\n',
    '127.1:8080', 'http://2130706433', 'http://localhost.evil', '//ship.example', 'ship.example/apps//x', 'localhost:0', 'ship.example/%7e/login']) {
    assert.throws(() => normalizeShipAddress(input), error => hasCode('invalidOrigin')(error) &&
      error instanceof Error && error.message.includes('web address') && !error.message.includes(input) && !error.message.includes('secret'));
  }
  assert.throws(() => new ShipClient('ship.example'), hasCode('invalidOrigin'));
});
test('rejected stored code is replaced explicitly and only successful replacement is saved', async () => {
  await fixture(async (origin, requests, replies) => {
    replies.push(refused, refused, accepted, accepted); const saved: string[] = [], prompts: boolean[] = []; let reads = 0;
    const client = await authenticateShip(origin, callbacks({readCode: async () => {reads++; return 'old';},
      askCode: async (_origin, rejected) => {assert.equal(_origin, origin); prompts.push(rejected); return prompts.length === 1 ? 'bad-new' : 'correct+&';},
      saveCode: async (_origin, code) => {assert.equal(_origin, origin); saved.push(code);}}));
    try {
      assert.deepEqual(requests, ['old', 'bad-new', 'correct+&']); assert.deepEqual(saved, ['correct+&']); assert.deepEqual(prompts, [true, true]);
      await client.signIn(); assert.equal(requests.at(-1), 'correct+&'); assert.equal(reads, 1);
    } finally {client.close();}
  });
});
test('cancellation preserves storage and closes the constructed client', async () => {
  await fixture(async (origin, requests, replies) => {
    replies.push(refused); let client: ShipClient | undefined, saves = 0;
    await assert.rejects(authenticateShip(origin, callbacks({readCode: async () => 'old', onClient: value => {client = value;}, saveCode: async () => {saves++;}})), hasCode('cancelled'));
    assert.equal(saves, 0); assert.deepEqual(requests, ['old']); await assert.rejects(client!.signIn(), hasCode('closed'));
  });
});
test('missing code prompts without rejection; storage failure fails closed after actual login', async () => {
  await fixture(async (origin, requests, replies) => {
    replies.push(accepted); let client: ShipClient | undefined;
    await assert.rejects(authenticateShip(origin, callbacks({onClient: value => {client = value;}, askCode: async (_origin, rejected) => {assert.equal(rejected, false); return 'new';},
      saveCode: async () => {assert.equal(requests.length, 1); throw Error('private-storage-detail');}})), hasCode('credentialStorage'));
    assert.throws(() => client!.browserCookies(origin), hasCode('closed'));
  });
});
test('network, server and foreign redirect failures never prompt or persist credentials', async () => {
  await fixture(async (origin, requests, replies) => {
    for (const reply of [(res: http.ServerResponse) => res.destroy(), (res: http.ServerResponse) => {res.writeHead(503); res.end();},
      (res: http.ServerResponse) => {res.writeHead(302, {Location: 'https://elsewhere.example/', 'Set-Cookie': 'urbauth-~zod=x; Path=/'}); res.end();}]) {
      replies.push(reply); let asks = 0, saves = 0;
      await assert.rejects(authenticateShip(origin, callbacks({readCode: async () => 'stored', askCode: async () => {asks++; return 'new';}, saveCode: async () => {saves++;}})));
      assert.equal(asks, 0); assert.equal(saves, 0);
    }
    assert.equal(requests.length, 3);
  });
});
test('foreign cookie cannot authenticate or save; cancellation after refusal remains private', async () => {
  await fixture(async (origin, requests, replies) => {
    replies.push(res => {res.writeHead(200, {'Set-Cookie': 'urbauth-~zod=x; Path=/; Domain=elsewhere.example'}); res.end();});
    let asks = 0, saves = 0;
    await assert.rejects(authenticateShip(origin, callbacks({readCode: async () => 'stored', askCode: async (_origin, rejected) => {asks++; assert.equal(rejected, true); return undefined;}, saveCode: async () => {saves++;}})), hasCode('cancelled'));
    assert.equal(requests.length, 1); assert.equal(asks, 1); assert.equal(saves, 0);
  });
});
test('disposal during delayed credential read wins over storage error and never dispatches', async () => {
  await fixture(async (origin, requests) => {
    let open = true, release!: () => void, client: ShipClient | undefined;
    const wait = new Promise<void>(resolve => {release = resolve;});
    const pending = authenticateShip(origin, callbacks({onClient: value => {client = value;}, ensureOpen: () => {if (!open) throw new ShipClientError('closed');},
      readCode: async () => {await wait; throw Error('private');}, askCode: async () => {throw Error('must not ask');}}));
    open = false; client!.close(); release(); await assert.rejects(pending, hasCode('closed')); assert.equal(requests.length, 0);
  });
});
test('ambiguous or malformed authenticated identity fails before saving without another code prompt', async () => {
  await fixture(async (origin, requests, replies) => {
    for (const cookies of [['urbauth-~zod=x; Path=/', 'urbauth-~nec=y; Path=/'], ['urbauth-ZOD=x; Path=/']]) {
      replies.push(res => {res.writeHead(200, {'Set-Cookie': cookies}); res.end();});
      let prompts = 0, saves = 0;
      await assert.rejects(authenticateShip(origin, callbacks({askCode: async () => {prompts++; return 'new';}, saveCode: async () => {saves++;}})), hasCode('identityUnavailable'));
      assert.equal(prompts, 1); assert.equal(saves, 0);
    }
    assert.equal(requests.length, 2);
  });
});
test('invalid selected identity is refused before reading credentials or constructing a client', async () => {
  for (const expectedShip of ['~zod\n', '~ZOD', '~foo-', '', null, 123]) {
    let reads = 0, clients = 0;
    await assert.rejects(authenticateShip('http://127.0.0.1:8080', callbacks({expectedShip: expectedShip as string,
      readCode: async () => {reads++; return 'private';}, onClient: () => {clients++;}})), hasCode('identityUnavailable'));
    assert.equal(reads, 0); assert.equal(clients, 0);
  }
});
test('selected planet mismatch closes stored-code and replacement-code logins without saving or reprompting', async () => {
  await fixture(async (origin, requests, replies) => {
    for (const remembered of ['stored', undefined]) {
      replies.push(accepted); let asks = 0, saves = 0, client: ShipClient | undefined;
      await assert.rejects(authenticateShip(origin, callbacks({expectedShip: '~sampel-palnet', readCode: async () => remembered,
        askCode: async () => {asks++; return 'replacement';}, saveCode: async () => {saves++;}, onClient: value => {client = value;}})),
      error => hasCode('identityUnavailable')(error) && error instanceof Error && error.message.includes('selected planet') && !error.message.includes('replacement'));
      assert.equal(asks, remembered ? 0 : 1); assert.equal(saves, 0);
      assert.throws(() => client!.browserCookies(origin), hasCode('closed'));
    }
    assert.deepEqual(requests, ['stored', 'replacement']);
  });
});
test('selected identity is captured across awaits and matching replacement may be saved', async () => {
  await fixture(async (origin, requests, replies) => {
    replies.push(accepted, accepted); const saved: string[] = [];
    const options = callbacks({expectedShip: '~zod', askCode: async () => {options.expectedShip = '~nec'; return 'replacement';}, saveCode: async (_origin, code) => {saved.push(code);}});
    const client = await authenticateShip(origin, options);
    try {assert.deepEqual(saved, ['replacement']); assert.equal(client.browserCookies(origin)[0].name, 'urbauth-~zod');}
    finally {client.close();}
    const manual = await authenticateShip(origin, callbacks({readCode: async () => 'manual'})); manual.close();
    assert.deepEqual(requests, ['replacement', 'manual']);
  });
});
