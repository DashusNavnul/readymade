import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LegacyMedia } from '../src/legacy-media';

test('legacy detection reads only explicit private owner; Show never loads, evaluates, or transfers calls', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rm-legacy-')), socketPath = join(directory, 'owner.sock'), requests: unknown[] = [];
  let reveals = 0;
  const server = createServer(socket => socket.once('data', bytes => {
    requests.push(JSON.parse(bytes.toString())); socket.end(JSON.stringify({ ok: true, value: { origin: 'https://own.example', title: 'Existing call', secret: 'not returned' } }) + '\n');
  }));
  await new Promise<void>(resolve => server.listen(socketPath, resolve)); chmodSync(socketPath, 0o600);
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });
  const media = new LegacyMedia({ socketPath, revealExisting: async owner => { assert.equal(owner.socketPath, socketPath); reveals++; } });
  const state = await media.inspect(); assert.equal(state?.title, 'Existing call'); assert.equal(reveals, 0);
  assert.equal(Reflect.has(state!, 'secret'), false);
  await media.show(); assert.equal(reveals, 1);
  assert.deepEqual(requests, [{ native: 'state' }, { native: 'state' }]);
  chmodSync(directory, 0o755); await assert.rejects(media.inspect()); assert.equal(reveals, 1); chmodSync(directory, 0o700);
});

test('missing/stale/untrusted legacy owners cannot start an app or reveal another owner', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rm-legacy-')), socketPath = join(directory, 'owner.sock');
  t.after(() => rmSync(directory, { recursive: true, force: true })); let reveals = 0;
  const media = new LegacyMedia({ socketPath, revealExisting: async () => { reveals++; } });
  assert.equal(await media.inspect(), undefined); await assert.rejects(media.show());
  writeFileSync(socketPath, 'valuable private file', { mode: 0o600 }); await assert.rejects(media.inspect());
  assert.equal(reveals, 0);
  await assert.rejects(new LegacyMedia({ socketPath: 'relative.sock', revealExisting: async () => {} }).inspect());
});
