import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {authenticateShip, normalizeShipAddress, type ShipAuthenticationOptions, switchTarget, connectionFailureMessage, automaticShip, lastShip} from '../src/ship-connection';
import {ShipClient, ShipClientError} from '../src/ship-client';

const hasCode = (code: string) => (error: unknown) => error instanceof ShipClientError && error.code === code;
const shipNames = ['~zod', '~marzod', '~sampel-palnet', '~doznec-sampel-palnet', '~bondyl-libpen-dashus-navnul',
  ...Array.from({length: 4}, (_, index) => '~' + Array(index + 1).fill('doznec').join('-') + '--bondyl-libpen-dashus-navnul')];
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
  for (const expectedShip of [...shipNames.map(ship => ship + '\n'), '~ZOD', '~foo-', '~doznec--sampel-palnet', '~doznec-bondyl-libpen-dashus-navnul', '', null, 123]) {
    let reads = 0, clients = 0;
    await assert.rejects(authenticateShip('http://127.0.0.1:8080', callbacks({expectedShip: expectedShip as string,
      readCode: async () => {reads++; return 'private';}, onClient: () => {clients++;}})), hasCode('identityUnavailable'));
    assert.equal(reads, 0); assert.equal(clients, 0);
  }
});
test('selected ship mismatch at every rank closes stored-code and replacement-code logins without saving or reprompting', async () => {
  await fixture(async (origin, requests, replies) => {
    for (const [index, expectedShip] of shipNames.entries()) for (const remembered of ['stored', undefined]) {
      const other = shipNames[(index + 1) % shipNames.length];
      replies.push(res => {res.writeHead(204, {'Set-Cookie': 'urbauth-' + other + '=session; Path=/; HttpOnly'}); res.end();});
      let asks = 0, saves = 0, client: ShipClient | undefined;
      await assert.rejects(authenticateShip(origin, callbacks({expectedShip, readCode: async () => remembered,
        askCode: async () => {asks++; return 'replacement';}, saveCode: async () => {saves++;}, onClient: value => {client = value;}})),
      error => hasCode('identityUnavailable')(error) && error instanceof Error && error.message.includes('selected ship') && !error.message.includes('replacement'));
      assert.equal(asks, remembered ? 0 : 1); assert.equal(saves, 0);
      assert.throws(() => client!.browserCookies(origin), hasCode('closed'));
    }
    assert.deepEqual(requests, shipNames.flatMap(() => ['stored', 'replacement']));
  });
});
test('selected identities of every rank are captured across awaits and matching replacements may be saved', async () => {
  await fixture(async (origin, requests, replies) => {
    for (const expectedShip of shipNames) {
      const acceptedOwner = (res: http.ServerResponse) => {res.writeHead(204, {'Set-Cookie': 'urbauth-' + expectedShip + '=session; Path=/; HttpOnly'}); res.end();};
      replies.push(acceptedOwner, acceptedOwner); const saved: string[] = [];
      const options = callbacks({expectedShip, askCode: async () => {options.expectedShip = '~nec'; return 'replacement';}, saveCode: async (_origin, code) => {saved.push(code);}});
      const client = await authenticateShip(origin, options);
      try {assert.deepEqual(saved, ['replacement']); assert.equal(client.browserCookies(origin)[0].name, 'urbauth-' + expectedShip);}
      finally {client.close();}
      const manual = await authenticateShip(origin, callbacks({readCode: async () => 'manual'}));
      try {assert.equal(manual.browserCookies(origin)[0].name, 'urbauth-' + expectedShip);}
      finally {manual.close();}
    }
    assert.deepEqual(requests, shipNames.flatMap(() => ['replacement', 'manual']));
  });
});

test('a remembered switch target is a normalized origin and at most one ship name', () => {
  assert.deepEqual(switchTarget({origin: 'http://localhost:8080'}), {origin: 'http://localhost:8080'});
  assert.deepEqual(switchTarget({origin: 'https://ship.example', ship: '~doznec-salfun-sampel-palnet'}), {origin: 'https://ship.example', ship: '~doznec-salfun-sampel-palnet'});
  for (const bad of [undefined, null, [], 'http://localhost:8080', {}, {origin: 'localhost:8080'}, {origin: 'http://localhost:8080/'}, {origin: 'http://ship.example'},
    {origin: 'http://localhost:8080', ship: 'zod'}, {origin: 'http://localhost:8080', ship: '~Zod'}, {origin: 'http://localhost:8080', code: 'x'}]) assert.throws(() => switchTarget(bad), /Invalid switch target|web address/);
});

test('a connection that got no answer is named by what was measured', () => {
  assert.match(connectionFailureMessage('http://localhost:8080', 'slow'), /localhost:8080 is running but did not answer in time/);
  assert.match(connectionFailureMessage('http://localhost:8080', 'down'), /Nothing is answering at localhost:8080.*stopped.*another port/);
  assert.match(connectionFailureMessage('https://ship.example', 'down'), /ship\.example refused the connection/);
  assert.match(connectionFailureMessage('https://shp.example', 'unknownHost'), /address shp\.example was not found/);
  assert.match(connectionFailureMessage('https://ship.example', 'dropped'), /dropped before your ship answered/);
  assert.match(connectionFailureMessage('http://localhost:8080', 'down', {ship: '~zod', origin: 'http://localhost:8081'}), /~zod no longer answers at localhost:8080.*localhost:8081 now/);
  assert.match(connectionFailureMessage('https://ship.example', undefined), /Could not reach your Urbit/);
});
test('the client reports why nothing answered: refused port, unknown name, or too slow', async () => {
  const refused = http.createServer(); refused.listen(0, '127.0.0.1'); await once(refused, 'listening');
  const port = (refused.address() as AddressInfo).port; refused.close(); await once(refused, 'close');
  const down = new ShipClient(`http://127.0.0.1:${port}`, async () => 'code');
  await assert.rejects(down.signIn(), (error: unknown) => error instanceof ShipClientError && error.code === 'transport' && error.detail === 'down'); down.close();
  const silent = http.createServer(() => { /* never answers */ }); silent.listen(0, '127.0.0.1'); await once(silent, 'listening');
  const slow = new ShipClient(`http://127.0.0.1:${(silent.address() as AddressInfo).port}`, async () => 'code');
  try {
    await assert.rejects(slow.requestJSON('/apps/pataphor/remote/state.json', {timeoutMs: 150}), (error: unknown) => error instanceof ShipClientError && error.code === 'transport' && error.detail === 'slow');
  } finally {slow.close(); silent.closeAllConnections(); silent.close();}
});

test('a session the ship dropped is recovered by signing in again on the same client, with no prompt', async () => {
  let current = 'first', logins = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/~/login') {
      let body = ''; req.on('data', chunk => {body += chunk;}); req.on('end', () => {
        if (body !== 'password=code') {res.writeHead(400); res.end(); return;}
        logins++; current = 'session' + logins; res.writeHead(204, {'set-cookie': [`urbauth-~zod=${current}; Path=/`]}); res.end();
      }); return;
    }
    const signedIn = req.headers.cookie === 'urbauth-~zod=' + current;
    res.writeHead(signedIn ? 200 : 403, {'content-type': 'application/json'}); res.end(JSON.stringify(signedIn ? {ship: '~zod'} : {}));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let asked = 0;
  const client = new ShipClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async () => {asked++; return 'code';});
  try {
    await client.signIn();
    assert.deepEqual(await client.requestJSON('/apps/pataphor/remote/state.json', {timeoutMs: 2000}), {ship: '~zod'});
    current = 'forgotten'; // the ship restored from a backup, or the session ended
    await assert.rejects(client.requestJSON('/apps/pataphor/remote/state.json', {timeoutMs: 2000}), hasCode('authenticationRequired'));
    await client.signIn();
    assert.deepEqual(await client.requestJSON('/apps/pataphor/remote/state.json', {timeoutMs: 2000}), {ship: '~zod'});
    assert.equal(logins, 2); assert.equal(asked, 2); assert.equal(client.browserCookies(client.origin)[0]!.value, 'session2');
  } finally {client.close(); server.closeAllConnections(); server.close();}
});

test('a ship on this computer is connected without asking only when the choice is clear', () => {
  const zod = {ship: '~zod'}, nec = {ship: '~nec'};
  assert.equal(automaticShip([zod]), zod);                       // the only one running
  assert.equal(automaticShip([zod, nec]), undefined);            // two and no history: ask
  assert.equal(automaticShip([zod, nec], undefined, '~nec'), nec); // the one last used
  assert.equal(automaticShip([zod], undefined, '~nec'), zod);    // last one is not running: the only one
  assert.equal(automaticShip([], undefined, '~nec'), undefined);
  // A link names its ship: exactly that ship, never another, even when another is the only one running.
  assert.equal(automaticShip([zod, nec], '~nec', '~zod'), nec);
  assert.equal(automaticShip([zod], '~nec'), undefined);
  assert.equal(automaticShip([nec, {ship: '~nec'}], '~nec'), undefined); // ambiguous: ask
});

test('the remembered last ship is read strictly; a damaged record means ask, never a wrong ship', () => {
  assert.deepEqual(lastShip({ship: '~sampel-palnet', origin: 'http://localhost:8080', local: true}), {ship: '~sampel-palnet', origin: 'http://localhost:8080', local: true});
  assert.deepEqual(lastShip({ship: '~zod', origin: 'https://ship.example', local: false}), {ship: '~zod', origin: 'https://ship.example', local: false});
  for (const bad of [undefined, null, [], 'x', {}, {ship: '~zod', origin: 'http://localhost:8080'}, {ship: 'zod', origin: 'http://localhost:8080', local: true},
    {ship: '~zod', origin: 'localhost:8080', local: true}, {ship: '~zod', origin: 'http://localhost:8080', local: 'yes'}, {ship: '~zod', origin: 'http://localhost:8080', local: true, code: 'x'},
    {origin: 'http://localhost:8080', local: true}]) assert.equal(lastShip(bad), undefined);
});
