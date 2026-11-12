import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ShipClient, OutcomeUnknownError } from '../src/ship-client';

const context = {owner: '~zod', project: 'demo', session: '0x1'};
async function run(dropped: boolean): Promise<void> {
  const bodies: unknown[] = [];
  const state = {nonce: '0v1', cursor: '0x1', owner: '~zod', session: '0x1', ready: true, after: 0,
    projects: [], sessions: [{id: '0x1', project: 'demo'}], records: []};
  const server = createServer((req, res) => {
    const parts: Buffer[] = []; req.on('data', b => parts.push(b)); req.on('end', () => {
      if (req.url === '/~/login') {res.writeHead(200, {'Set-Cookie': 'urbauth-~zod=fixture; Path=/'}); res.end(); return;}
      if (req.method === 'POST') {
        bodies.push(JSON.parse(Buffer.concat(parts).toString()));
        if (dropped) {req.socket.destroy(); return;}
      }
      res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(state));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new ShipClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async () => 'fixture');
  try {
    await client.signIn(); await client.codingState('0x1');
    for (const bad of [{...context, project: 'private'}, {...context, owner: '~nec'}]) {
      await assert.rejects(client.acceptCompletion(bad, '0x2', 'Reviewed', true));
    }
    await assert.rejects(client.acceptCompletion(context, '0x2', 'Reviewed', false));
    await assert.rejects(client.acceptCompletion(context, '0x02', 'Reviewed', true));
    assert.equal(bodies.length, 0);
    if (dropped) await assert.rejects(client.acceptCompletion(context, '0x2', 'Reviewed', true), OutcomeUnknownError);
    else await client.acceptCompletion(context, '0x2', 'Reviewed', true);
    assert.deepEqual(bodies, [{kind: 'completion-accept', session: '0x1', proposal: '0x2', consent: true, reason: 'Reviewed', nonce: '0v1'}]);
    await client.codingState('0x1');
    await assert.rejects(client.acceptCompletion(context, '0x2', 'Reviewed', true), /still finishing another request to your ship\. Try again in a moment; nothing was sent\./);
    assert.equal(bodies.length, 1);
  } finally {client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
}
test('answer acceptance sends exact consent and proposal once; delivery is not a judgment', () => run(false));
test('lost answer-acceptance response stays blocked after fresh observation', () => run(true));
