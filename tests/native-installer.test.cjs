const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {exchange, options, run, baseExports} = require('../backend/install/run-native.cjs');

async function serverRun(reply, check, expectedSubmissions = [1]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-native-'));
  const socketPath = path.join(root, 'conn.sock');
  let submissions = 0;
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', bytes => {submissions++; reply(socket, bytes);});
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  try {await check(root, socketPath); assert.ok(expectedSubmissions.includes(submissions), `Unexpected submission count: ${submissions}`);}
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, {recursive: true, force: true});
  }
}

test('native runner retains an exact fragmented frame privately after one submission', async () => {
  const response = Buffer.from([0, 3, 0, 0, 0, 11, 22, 33]);
  await serverRun(socket => {
    socket.write(response.subarray(0, 2));
    setImmediate(() => {socket.write(response.subarray(2, 6)); setImmediate(() => socket.end(response.subarray(6)));});
  }, async (root, socketPath) => {
    assert.equal(await exchange(socketPath, Buffer.from('one request'), root, 2), response.length);
    assert.deepEqual(fs.readFileSync(path.join(root, 'response.newt')), response);
    assert.equal(fs.statSync(path.join(root, 'response.newt')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(root, 'submitted.json')).mode & 0o777, 0o600);
  });
});

for (const [name, response] of [
  ['truncated body', [0, 3, 0, 0, 0, 11]],
  ['truncated header', [0, 3]],
  ['wrong protocol', [1, 1, 0, 0, 0, 11]],
  ['oversized frame', [0, 1, 0, 0, 17]],
  ['trailing bytes', [0, 1, 0, 0, 0, 11, 22]],
]) {
  test(`native runner refuses ${name} without retry`, async () => {
    await serverRun(socket => socket.end(Buffer.from(response)), async (root, socketPath) => {
      await assert.rejects(exchange(socketPath, Buffer.from('one request'), root, 2));
      assert.ok(fs.existsSync(path.join(root, 'submitted.json')));
    });
  });
}

test('native runner bounds total waiting time without replay', async () => {
  await serverRun(() => {}, async (root, socketPath) => {
    await assert.rejects(exchange(socketPath, Buffer.from('one request'), root, 0.02), /deadline/);
  // The total deadline may expire before connect under load; zero sends is
  // valid too. Other cases require one send; no case permits a replay.
  }, [0, 1]);
});

test('native runner requires explicit paths, literal identity and finite time', () => {
  assert.throws(() => options([]), /Missing/);
  assert.throws(() => options(['--unknown', 'yes']), /Invalid/);
  const args = ['--pier', __dirname, '--vere', __filename, '--source', __filename, '--output', path.join(os.tmpdir(), 'unused-output'), '--ship', '~sut'];
  assert.equal(options(args).ship, '~sut');
  assert.throws(() => options([...args, '--ship', '~zod']), /repeated/);
  assert.throws(() => options([...args, '--timeout', '0']), /Timeout/);
  assert.throws(() => options([...args, '--timeout', 'Infinity']), /Timeout/);
  assert.throws(() => options(args.map(value => value === '~sut' ? '~sut ] bad' : value)), /literal/);
});

test('base bootstrap selects only the built-in mount and rejects supplied source', () => {
  const args = ['--pier', __dirname, '--vere', __filename, '--output', path.join(os.tmpdir(), 'unused-output'), '--ship', '~sut'];
  const mount = options([...args, '--operation', 'mount-base']);
  assert.equal(mount.operation, 'mount-base');
  assert.equal(mount.source, undefined);
  assert.throws(() => options([...args, '--operation', 'mount-base', '--source', __filename]), /no supplied source/);
  assert.throws(() => options([...args, '--operation', 'skip-base']), /Operation/);
  assert.throws(() => options(args), /Missing --source/);
});

test('base readback requires all four nonempty exported files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-base-'));
  try {
    assert.equal(baseExports(root).some(file => file.ready), false);
    const names = ['sys/hoon.hoon', 'sys/zuse.hoon', 'sys/lull.hoon', 'sys/vane/clay.hoon'];
    for (const name of names) {
      const file = path.join(root, 'base', name);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, 'native export fixture');
    }
    assert.equal(baseExports(root).every(file => file.ready), true);
    fs.writeFileSync(path.join(root, 'base', names[3]), '');
    assert.equal(baseExports(root).every(file => file.ready), false);
    assert.equal(baseExports(root)[3].bytes, 0);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('unknown native outcome keeps the exclusive lock and prevents another submission', async () => {
  await serverRun(socket => socket.end(Buffer.from([0, 3, 0, 0, 0, 11])), async (root, socketPath) => {
    const pier = path.join(root, 'pier');
    fs.mkdirSync(path.join(pier, '.urb'), {recursive: true});
    fs.symlinkSync(socketPath, path.join(pier, '.urb/conn.sock'));
    for (const name of ['sys/hoon.hoon', 'sys/zuse.hoon', 'sys/lull.hoon', 'sys/vane/clay.hoon']) {
      const file = path.join(pier, 'base', name);
      fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, 'fixture');
    }
    const vere = path.join(root, 'fixture-encoder');
    fs.writeFileSync(vere, '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>process.stdout.write(Buffer.from([0,1,0,0,0,2])));\n', {mode: 0o700});
    const source = path.join(root, 'fixture.hoon'); fs.writeFileSync(source, '(pure:m !>(42))\n');
    const config = {pier, vere, source, ship: '~sut', timeout: 1, output: path.join(root, 'first')};
    await assert.rejects(run(config), /outcome unknown/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(config.output, 'unknown.json'))).lockRetained, true);
    assert.ok(fs.existsSync(path.join(pier, '.urb/readymade-operation.lock/owner.json')));
    await assert.rejects(run({...config, output: path.join(root, 'second')}), /EEXIST/);
    assert.equal(fs.existsSync(path.join(root, 'second/submitted.json')), false);
    await assert.rejects(run(config), /EEXIST/);
  });
});

test('a mount acknowledgement without native filesystem exports never reports readiness', async () => {
  await serverRun(socket => socket.end(Buffer.from([0, 1, 0, 0, 0, 2])), async (root, socketPath) => {
    const pier = path.join(root, 'pier');
    fs.mkdirSync(path.join(pier, '.urb'), {recursive: true});
    fs.symlinkSync(socketPath, path.join(pier, '.urb/conn.sock'));
    const vere = path.join(root, 'fixture-encoder');
    fs.writeFileSync(vere, '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>process.stdout.write(process.argv.includes("-cn")?"[0 %avow 0 %noun %readymade-base-mount-submitted]":Buffer.from([0,1,0,0,0,2])));\n', {mode: 0o700});
    const output = path.join(root, 'receipt');
    assert.equal(await run({pier, vere, ship: '~sut', operation: 'mount-base', timeout: 1, output}), 2);
    const result = JSON.parse(fs.readFileSync(path.join(output, 'result.json')));
    assert.equal(result.executionSuccess, true);
    assert.equal(result.baseExportsVerified, false);
    assert.equal(result.status, 'base-readback-incomplete');
    assert.equal(fs.existsSync(path.join(pier, 'base')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'base-exports.json'))).ready, false);
    assert.match(fs.readFileSync(path.join(output, 'source.hoon'), 'utf8'), /%mont %base/);
  });
});

for (const [name, decoded, decodeStatus, large, expectedLock] of [
  ['successful operation', '[0 %avow 0 %noun 42]', 0, false, false],
  ['reported thread failure', '[0 %avow 1 %thread-fail ~]', 0, false, false],
  ['unrelated response kind', '[0 %peek 0]', 0, false, true],
  ['wrong response identifier', '[1 %avow 0 %noun 42]', 0, false, true],
  ['failed decoder with success-looking output', '[0 %avow 0 %noun 42]', 1, false, true],
  ['large undecoded response', '', 0, true, true],
]) {
  test(`native operation lock tracks decoded outcome: ${name}`, async () => {
    const response = Buffer.alloc(large ? 1024 * 1024 + 6 : 6);
    response.writeUInt32LE(response.length - 5, 1); response[5] = 2;
    await serverRun(socket => socket.end(response), async (root, socketPath) => {
      const pier = path.join(root, 'pier');
      fs.mkdirSync(path.join(pier, '.urb'), {recursive: true});
      fs.symlinkSync(socketPath, path.join(pier, '.urb/conn.sock'));
      for (const name of ['sys/hoon.hoon', 'sys/zuse.hoon', 'sys/lull.hoon', 'sys/vane/clay.hoon']) {
        const file = path.join(pier, 'base', name);
        fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, 'fixture');
      }
      const vere = path.join(root, 'fixture-codec');
      fs.writeFileSync(vere, `#!/usr/bin/env node
process.stdin.resume(); process.stdin.on('end', () => {
  if (process.argv.includes('-cn')) {process.stdout.write(${JSON.stringify(decoded)}); process.exitCode = ${decodeStatus};}
  else process.stdout.write(Buffer.from([0,1,0,0,0,2]));
});
`, {mode: 0o700});
      const source = path.join(root, 'fixture.hoon'); fs.writeFileSync(source, '(pure:m !>(42))\n');
      const config = {pier, vere, source, ship: '~sut', timeout: 2, output: path.join(root, 'receipt')};
      assert.equal(await run(config), name === 'successful operation' ? 0 : 2);
      const result = JSON.parse(fs.readFileSync(path.join(config.output, 'result.json')));
      const lock = path.join(pier, '.urb/readymade-operation.lock/owner.json');
      assert.equal(fs.existsSync(lock), expectedLock, 'An unverified frame must not release the operation gate');
      assert.equal(result.lockRetained, expectedLock);
      assert.equal(result.executionSuccess, name === 'successful operation' ? true : name === 'reported thread failure' ? false : 'unverified');
      assert.deepEqual(fs.readFileSync(path.join(config.output, 'response.newt')), response);
      if (expectedLock) {
        const owner = fs.readFileSync(lock);
        await assert.rejects(run({...config, output: path.join(root, 'second')}), /EEXIST/);
        assert.deepEqual(fs.readFileSync(lock), owner);
        assert.equal(fs.existsSync(path.join(root, 'second/submitted.json')), false);
        assert.notEqual(result.executionSuccess, true);
      }
    });
  });
}
