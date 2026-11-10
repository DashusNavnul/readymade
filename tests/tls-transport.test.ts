import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import type {TLSSocket} from 'node:tls';

const execute = promisify(execFile);
test('real TLS enforces trust and hostname before credentials, preserves secure cookies and refuses redirect/replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'readymade-tls-'));
  const rows: {path: string; cookie?: string; encrypted: boolean; body: string}[] = [];
  let mode = 'trusted', foreignRequests = 0;
  function certificate(name: string, ip: string): {key: Buffer; cert: Buffer; path: string} {
    const config = join(root, `${name}.cnf`), key = join(root, `${name}.key`), path = join(root, `${name}.crt`);
    writeFileSync(config, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=Readymade TLS fixture\n[ext]\nsubjectAltName=IP:${ip}\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n`, {mode: 0o600});
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', key, '-out', path], {stdio: 'pipe', timeout: 10000});
    return {key: readFileSync(key), cert: readFileSync(path), path};
  }
  const valid = certificate('valid', '127.0.0.1'), wrong = certificate('wrong', '127.0.0.2');
  const foreign = createServer(valid, (_request, response) => {foreignRequests++; response.end('{}');});
  const server = createServer(valid, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      rows.push({path: request.url!, cookie: request.headers.cookie, encrypted: (request.socket as TLSSocket).encrypted,
        body: Buffer.concat(chunks).toString()});
      if (request.url === '/~/login') {
        response.writeHead(204, {'Set-Cookie': 'urbauth-~zod=tls-fixture-cookie; Secure; HttpOnly; Path=/'}); response.end();
      } else if (mode === 'redirect') {
        response.writeHead(302, {Location: `https://127.0.0.1:${(foreign.address() as AddressInfo).port}/capture`}); response.end();
      } else if (mode === 'unknown-write') request.socket.destroy();
      else {response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ship: '~zod', encrypted: true}));}
    });
  });
  try {
    foreign.listen(0, '127.0.0.1'); await once(foreign, 'listening');
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const selected of ['untrusted', 'hostname', 'trusted', 'redirect', 'unknown-write']) {
      mode = selected; rows.length = 0;
      server.setSecureContext(selected === 'hostname' ? wrong : valid);
      const env = {...process.env};
      delete env.NODE_TLS_REJECT_UNAUTHORIZED; delete env.NODE_EXTRA_CA_CERTS; delete env.NODE_OPTIONS;
      if (selected !== 'untrusted') env.NODE_EXTRA_CA_CERTS = selected === 'hostname' ? wrong.path : valid.path;
      const result = await execute(process.execPath, [join(__dirname, 'tls-client-child.js'), origin, selected], {env, timeout: 20000});
      assert.deepEqual(JSON.parse(result.stdout), {passed: true, mode: selected});
      assert.equal(result.stderr.includes('tls-fixture-only'), false);
      if (selected === 'untrusted' || selected === 'hostname') assert.equal(rows.length, 0, 'TLS refusal must precede credential delivery');
      else {
        assert.equal(rows.length, 2); assert.ok(rows.every(row => row.encrypted));
        assert.equal(rows[0].path, '/~/login'); assert.equal(rows[0].cookie, undefined);
        assert.equal(rows[0].body, 'password=tls-fixture-only');
        assert.equal(rows[1].cookie, 'urbauth-~zod=tls-fixture-cookie');
        assert.equal(rows[1].path, selected === 'unknown-write' ? '/apps/pataphor/remote/submit' : '/apps/pataphor/remote/state.json');
      }
      assert.equal(foreignRequests, 0, 'Redirect must not forward credentials');
    }
  } finally {
    server.closeAllConnections(); foreign.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => foreign.close(() => resolve()))]);
    rmSync(root, {recursive: true, force: true});
  }
});
