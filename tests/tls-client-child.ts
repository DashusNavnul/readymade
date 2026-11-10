import assert from 'node:assert/strict';

async function run(): Promise<void> {
  const {ShipClient, ShipClientError, OutcomeUnknownError}: typeof import('../src/ship-client') =
    await import(process.env.READYMADE_TLS_CLIENT_MODULE ?? '../src/ship-client');
  const [origin, mode] = process.argv.slice(2);
  const client = new ShipClient(origin, async () => 'tls-fixture-only');
  const code = (wanted: string) => (error: unknown) => error instanceof ShipClientError && error.code === wanted;
  try {
    if (mode === 'untrusted' || mode === 'hostname') {
      await assert.rejects(client.signIn(), error => {
        assert.ok(error instanceof ShipClientError);
        assert.equal(error.code, mode === 'hostname' ? 'certificateHostname' : 'certificateUntrusted');
        assert.match(error.message, mode === 'hostname' ? /Check the configured origin/ : /complete certificate chain/);
        for (const privateValue of ['tls-fixture-only', 'Readymade TLS fixture', origin]) assert.equal(error.message.includes(privateValue), false);
        return true;
      });
    } else {
      await client.signIn();
      if (mode === 'redirect') await assert.rejects(client.workspaceState(), code('redirectRefused'));
      else if (mode === 'unknown-write') {
        await assert.rejects(client.requestJSON('/apps/pataphor/remote/submit', {method: 'POST', body: {id: 'tls-fixture'}}), OutcomeUnknownError);
        await assert.rejects(client.requestJSON('/apps/pataphor/remote/submit', {method: 'POST', body: {id: 'tls-fixture'}}), code('commandBusy'));
      } else {
        assert.equal(mode, 'trusted');
        assert.deepEqual(await client.workspaceState(), {ship: '~zod', encrypted: true});
      }
    }
    process.stdout.write(JSON.stringify({passed: true, mode}));
  } finally {client.close();}
}
void run().catch(error => {process.stderr.write(String(error)); process.exitCode = 1;});
