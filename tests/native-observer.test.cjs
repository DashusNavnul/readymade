const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {QUERIES, options, observe} = require('../backend/install/observe-native.cjs');
const {inspectSpider} = require('../backend/install/inspect-spider.cjs');

async function fixture(reply, check, decoded = '[0 %peek 0]') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-observe-'));
  const pier = path.join(root, 'pier'), vere = path.join(root, 'codec');
  fs.mkdirSync(path.join(pier, '.urb/readymade-operation.lock'), {recursive: true});
  const lock = path.join(pier, '.urb/readymade-operation.lock/owner.json');
  const retained = '{"priorOutcome":"unknown","doNotReplay":true}\n'; fs.writeFileSync(lock, retained);
  for (const name of ['sys/hoon.hoon', 'sys/zuse.hoon', 'sys/lull.hoon', 'sys/vane/clay.hoon']) {
    const file = path.join(pier, 'base', name); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, 'fixture');
  }
  fs.writeFileSync(vere, `#!/usr/bin/env node
const chunks=[];process.stdin.on('data',b=>chunks.push(b));process.stdin.on('end',()=>{
 if(process.argv.includes('-jn')){const b=Buffer.concat(chunks),h=Buffer.alloc(5);h.writeUInt32LE(b.length,1);process.stdout.write(Buffer.concat([h,b]));}
 else process.stdout.write(${JSON.stringify(decoded)});
});\n`, {mode: 0o700});
  const sockets = new Set(), requests = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('data', bytes => {requests.push(bytes.subarray(5).toString()); reply(socket);});
  });
  await new Promise(resolve => server.listen(path.join(pier, '.urb/conn.sock'), resolve));
  try {
    await check({pier, vere, output: path.join(root, 'receipt'), timeout: 1}, requests);
    assert.equal(fs.readFileSync(lock, 'utf8'), retained, 'Observation must preserve the prior lock byte for byte');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve)); fs.rmSync(root, {recursive: true, force: true});
  }
}
const frame = Buffer.from([0, 1, 0, 0, 0, 42]);
for (const query of ['identity', 'threads']) test(`fixed ${query} observation works with a retained lock without qualifying the prior operation`, async () => {
  await fixture(socket => socket.end(frame), async (config, requests) => {
    assert.equal(await observe({...config, query}), 0);
    assert.deepEqual(requests, [QUERIES[query]]);
    const result = JSON.parse(fs.readFileSync(path.join(config.output, 'result.json')));
    assert.equal(result.status, 'observation-retained'); assert.equal(result.previousOperationOutcome, 'unknown');
    assert.equal(result.identityVerified, false); assert.equal(result.operationLockUntouched, true);
    assert.equal(fs.statSync(config.output).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(config.output, 'response.hoon')).mode & 0o777, 0o600);
    await assert.rejects(observe({...config, query}), /EEXIST/);
    assert.equal(requests.length, 1);
  }, query === 'identity' ? '[0 0 161]' : '[0 %peek 0]');
});
for (const decoded of ['[0 %peek 0]', '[0 0]', '[1 0 161]']) test(`identity refuses an empty or unrelated runtime reply: ${decoded}`, async () => {
  await fixture(socket => socket.end(frame), async config => {
    assert.equal(await observe({...config, query: 'identity'}), 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(config.output, 'result.json'))).decoded, false);
  }, decoded);
});
test('observation timeout never retries or releases the prior operation lock', async () => {
  await fixture(() => {}, async (config, requests) => {
    await assert.rejects(observe({...config, query: 'identity'}), /prior outcome remains unknown/);
    assert.equal(requests.length, 1);
    const failure = JSON.parse(fs.readFileSync(path.join(config.output, 'unavailable.json')));
    assert.equal(failure.automaticRetry, false); assert.equal(failure.previousOperationOutcome, 'unknown');
  });
});
test('an unrelated complete response is retained without being called an observation', async () => {
  await fixture(socket => socket.end(frame), async config => {
    assert.equal(await observe({...config, query: 'identity'}), 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(config.output, 'result.json'))).decoded, false);
  }, '[0 %avow 0 %noun 42]');
});
test('observer refuses arbitrary source, prototype keys and unbounded waits before submission', () => {
  const args = ['--pier', __dirname, '--vere', __filename, '--query', 'identity', '--output', path.join(os.tmpdir(), 'unused-observation')];
  assert.equal(options(args).timeout, 10);
  for (const query of ['constructor', '__proto__', 'mount-base', '[%poke ~]']) assert.throws(() => options(args.map(v => v === 'identity' ? query : v)), /Query/);
  assert.throws(() => options([...args, '--source', 'anything.hoon']), /Invalid/);
  assert.throws(() => options([...args, '--query', 'threads']), /repeated/);
  for (const timeout of ['0', '61', 'Infinity']) assert.throws(() => options([...args, '--timeout', timeout]), /Timeout/);
});

// Synthetic noun encoded by actual offline Vere eval -jn (including jam references).
// It is a codec fixture, not evidence about a live ship or a successful operation.
const codecSpider = Buffer.from('AI0AAAAZ8OHKytYZ8N/aytwF/swe8P3E6sgBvjm4NLIyeQBa/WRgZGxcYmJcYHJcXGBoXGBkXGZoXFxwzGrmNOC7vdW5g9GAz5ZmV86AJ1fnznKY55mZxQ1zPQhmBeBjDS3MrYUtTI6spcUsDY+uTq6s1VDEDiXsMM+HeV4GfLGwuXLgycJmAR+O7Y0+zPOh0gQ=', 'base64');
const nt = value => value ? BigInt('0x' + Buffer.from(value).reverse().toString('hex')) : 0n;
const tup = (...values) => values.slice(0, -1).reduceRight((tail, head) => [head, tail], values.at(-1));
const lst = (...values) => values.reduceRight((tail, head) => [head, tail], 0n);
const map = (key, value, left = 0n, right = 0n) => tup([key, value], left, right);
function jamFixture(noun) {
  const bits = [];
  const put = (value, width) => {for (let i = 0; i < width; i++) bits.push(Number(value >> BigInt(i) & 1n));};
  const mat = value => {
    if (!value) {bits.push(1); return;}
    const size = value.toString(2).length, width = size.toString(2).length;
    bits.push(...Array(width).fill(0), 1); put(BigInt(size), width - 1); put(value, size);
  };
  const write = value => {if (Array.isArray(value)) {bits.push(1, 0); write(value[0]); write(value[1]);} else {bits.push(0); mat(value);}};
  write(noun); const data = Buffer.alloc(Math.ceil(bits.length / 8)); bits.forEach((bit, i) => {data[i >> 3] |= bit << (i % 8);});
  const header = Buffer.alloc(5); header.writeUInt32LE(data.length, 1); return Buffer.concat([header, data]);
}
function spiderNoun(options = {}) {
  const id = nt('khan-lard--0v1.abcd1'), yarn = lst(id);
  const state = options.state ?? tup(8n, map(yarn, [nt('none'), [nt('noun'), nt('PRIVATE-START-BODY')]]), lst(yarn), map(id, yarn), 0n, 0n);
  const fields = [nt('live'), 0n, nt('run'), 0n, tup(0n, 0n, 0n), 0n, 0n, 0n, 0n, [1n, [nt('noun'), state]],
    tup(0n, nt('base'), [nt('da'), 0n]), 0n, tup(nt('plot'), 0n, 0n), 0n, 0n, 0n];
  if (options.field) fields[options.field[0]] = options.field[1];
  return tup(options.request ?? 0n, nt(options.kind ?? 'peek'), options.unit ?? 0n, nt(options.omen ?? 'omen'),
    lst(nt(options.view ?? 'gv'), nt(options.ship ?? '~bud'), nt(options.app ?? 'spider'), nt(options.date ?? '~2026.11.09..04.02.34..8f53'), nt(options.path ?? '')),
    nt(options.mark ?? 'noun'), [options.version ?? 20n, tup(...fields)]);
}
test('offline Spider inspector accepts actual codec references without qualifying unknown work', () => {
  const result = inspectSpider(codecSpider, '~bud');
  assert.equal(result.ship, '~bud'); assert.equal(result.counts.running, 1); assert.equal(result.counts.starting, 0);
  assert.deepEqual(result.threads.running, [['khan-lard--fixture']]);
  assert.equal(result.responseSHA256, require('node:crypto').createHash('sha256').update(codecSpider).digest('hex'));
  assert.equal(result.previousOperationOutcome, 'unknown'); assert.equal(result.replayAuthorized, false); assert.equal(result.operationLockUntouched, true);
});
test('Spider summary includes pending starts and dotted IDs but no source or executable forms', () => {
  const result = inspectSpider(jamFixture(spiderNoun()), '~bud');
  assert.equal(result.counts.starting, 1); assert.equal(result.counts.running, 1); assert.equal(result.counts.tid, 1);
  assert.deepEqual(result.threads.starting, [['khan-lard--0v1.abcd1']]);
  assert.equal(JSON.stringify(result).includes('PRIVATE-START-BODY'), false);
  for (const key of ['responseSHA256', 'stateSHA256', 'carrierSHA256']) assert.match(result[key], /^[a-f0-9]{64}$/);
  assert.equal(result.stateSHA256, inspectSpider(jamFixture(spiderNoun({date: '~2026.11.10'})), '~bud').stateSHA256);
});
test('Spider inspector rejects unrelated envelope, ship, address, date, carrier and saved versions', () => {
  for (const option of [{request: 1n}, {kind: 'avow'}, {unit: 1n}, {omen: 'other'}, {view: 'gx'}, {ship: '~nec'}, {app: 'hood'}, {path: 'tree'}, {path: '$'}, {mark: 'json'},
    {date: '~2026.02.30'}, {date: '~2026.11.09..24.00.00'}, {date: '~2026.11.09..00.00.00'}, {date: '~2026.11.09..01.00.00..0000'},
    {version: 16n}, {field: [0, nt('nuke')]}, {field: [8, 1n]}, {field: [9, [0n, [nt('noun'), 0n]]]}, {state: tup(7n, 0n, 0n, 0n, 0n, 0n)}]) {
    assert.throws(() => inspectSpider(jamFixture(spiderNoun(option)), '~bud'), undefined, JSON.stringify(option, (_, value) => typeof value === 'bigint' ? String(value) : value));
  }
  assert.throws(() => inspectSpider(codecSpider));
});
test('Spider inspector rejects incomplete frames, trailing bytes, invalid references and wrong collection shapes', () => {
  for (const bytes of [codecSpider.subarray(0, -1), Buffer.concat([codecSpider, Buffer.from([0])]), Buffer.from([0, 1, 0, 0, 0, 7]), Buffer.from([1, 1, 0, 0, 0, 0])]) assert.throws(() => inspectSpider(bytes, '~bud'));
  const trailing = Buffer.concat([codecSpider, Buffer.from([0])]); trailing.writeUInt32LE(trailing.length - 5, 1);
  assert.throws(() => inspectSpider(trailing, '~bud'), /Trailing/);
  for (let index = 1; index < 6; index++) {
    const state = [8n, 0n, 0n, 0n, 0n, 0n]; state[index] = 1n;
    assert.throws(() => inspectSpider(jamFixture(spiderNoun({state: tup(...state)})), '~bud'));
  }
});
test('Spider inspector refuses duplicate thread maps and excessive complete summaries', () => {
  const id = nt('thread'), yarn = lst(id), entry = map(id, yarn);
  assert.throws(() => inspectSpider(jamFixture(spiderNoun({state: tup(8n, 0n, 0n, map(id, yarn, entry), 0n, 0n)})), '~bud'), /Duplicate/);
  const many = Array.from({length: 1025}, (_, i) => lst(nt('thread-' + i)));
  assert.throws(() => inspectSpider(jamFixture(spiderNoun({state: tup(8n, 0n, lst(...many), 0n, 0n, 0n)})), '~bud'), /limit/);
});
test('spider-state options require exact expected ship and never accept it for other queries', () => {
  const args = ['--pier', __dirname, '--vere', __filename, '--query', 'spider-state', '--output', path.join(os.tmpdir(), 'unused-spider-observation')];
  assert.throws(() => options(args), /ship/i);
  assert.equal(options([...args, '--ship', '~bud']).ship, '~bud');
  assert.throws(() => options([...args.map(v => v === 'spider-state' ? 'threads' : v), '--ship', '~bud']), /ship/i);
});
test('fixed Spider snapshot observation retains a private bounded summary and the unknown operation lock', async () => {
  await fixture(socket => socket.end(codecSpider), async (config, requests) => {
    assert.equal(await observe({...config, query: 'spider-state', ship: '~bud'}), 0);
    assert.deepEqual(requests, ['[0 %peek [%| %once %gv %spider /$]]']);
    const resultFile = path.join(config.output, 'result.json'), result = JSON.parse(fs.readFileSync(resultFile));
    assert.equal(result.spiderState.ship, '~bud'); assert.equal(result.spiderState.counts.running, 1);
    assert.equal(result.spiderState.replayAuthorized, false); assert.equal(result.previousOperationOutcome, 'unknown');
    assert.equal(fs.statSync(resultFile).mode & 0o777, 0o600);
  });
});
test('Spider observation rejects mismatched raw identity even when the text codec claims a peek', async () => {
  await fixture(socket => socket.end(codecSpider), async config => {
    assert.equal(await observe({...config, query: 'spider-state', ship: '~nec'}), 2);
    const result = JSON.parse(fs.readFileSync(path.join(config.output, 'result.json')));
    assert.equal(result.decoded, false); assert.equal(result.spiderState, undefined);
    assert.equal(result.previousOperationOutcome, 'unknown');
  });
});
test('Spider routing counts validate nonempty incoming, outgoing and nonce maps without exposing ducts', () => {
  const wire = lst(nt('thread'), nt('private-route')), route = tup(wire, 2n, nt('spider'));
  const fixtures = [[5, map(lst(wire), [2n, lst(nt('thread-result'), nt('private-id'))])],
    [6, map(route, [0n, lst(nt('private-path'))])], [7, map(route, 1n)]];
  for (const [index, value] of fixtures) {
    const result = inspectSpider(jamFixture(spiderNoun({field: [index, value]})), '~bud');
    assert.equal(result.counts[{5: 'incomingSubscriptions', 6: 'outgoingSubscriptions', 7: 'subscriptionNonces'}[index]], 1);
    assert.equal(JSON.stringify(result).includes('private-'), false);
  }
});

const rawQueries = {
  'current-domes': '[0 %peek [%| %once %cx %$ /domes]]',
  'app-inventory': '[0 %peek [%| %once %gf %$ /$]]',
  'activity-agent': '[0 %peek [%| %once %gv %readymade-editing /$]]',
  'eyre-bindings': '[0 %peek [%| %once %e %bindings ~]]'
};
for (const [query, request] of Object.entries(rawQueries)) test(`${query} sends only its fixed query and retains an unverified private frame with lock unchanged`, async () => {
  // Deliberately unrelated Spider payload: even a complete frame is not claimed
  // to match the query or expected identity without the separate offline parser.
  await fixture(socket => socket.end(codecSpider), async (config, requests) => {
    assert.equal(await observe({...config, query, ship: '~nec'}), 2);
    assert.deepEqual(requests, [request]);
    const result = JSON.parse(fs.readFileSync(path.join(config.output, 'result.json')));
    assert.equal(result.status, 'frame-retained'); assert.equal(result.expectedShip, '~nec');
    for (const key of ['decoded', 'textDecoded', 'identityVerified', 'envelopeVerified', 'replayAuthorized']) assert.equal(result[key], false);
    assert.equal(result.operationLockUntouched, true); assert.equal(result.previousOperationOutcome, 'unknown');
    assert.equal(result.responseBytes, codecSpider.length);
    assert.equal(fs.readFileSync(path.join(config.output, 'response.newt')).equals(codecSpider), true);
    assert.equal(fs.statSync(path.join(config.output, 'response.newt')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(config.output, 'result.json')).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(config.output, 'response.hoon')), false);
    assert.equal(fs.existsSync(path.join(config.output, 'decode.stderr')), false);
  }, 'DECODE MUST NOT RUN');
});
test('fixed state queries reject missing, malformed or injected identities and arbitrary source/path/app options', () => {
  for (const query of Object.keys(rawQueries)) {
    const args = ['--pier', __dirname, '--vere', __filename, '--query', query, '--output', path.join(os.tmpdir(), 'unused-fixed-state')];
    assert.equal(options([...args, '--ship', '~nec']).ship, '~nec');
    assert.throws(() => options(args), /ship/);
    for (const ship of ['nec', '~nec /$', '~nec\n', '~nec\n%poke', '~NEC', '~abc-def', '~' + 'a'.repeat(129)]) assert.throws(() => options([...args, '--ship', ship]), /ship/);
    for (const flag of ['--path', '--app', '--source', '--desk']) assert.throws(() => options([...args, '--ship', '~nec', flag, 'arbitrary']), flag === '--app' ? /--app/ : /Invalid/);
    assert.throws(() => options([...args, '--ship', '~nec', '--ship', '~bud']), /repeated/);
    for (const other of ['authentication-state', 'app-inventory /hood', '__proto__', 'constructor']) assert.throws(() => options(args.map(value => value === query ? other : value)), /Query/);
  }
});
test('raw state observer retains a large frame without text decoding or a verification claim', async () => {
  const large = Buffer.alloc(1024 * 1024 + 32); large.writeUInt32LE(large.length - 5, 1);
  await fixture(socket => socket.end(large), async (config, requests) => {
    assert.equal(await observe({...config, query: 'current-domes', ship: '~nec'}), 2);
    const result = JSON.parse(fs.readFileSync(path.join(config.output, 'result.json')));
    assert.equal(result.responseBytes, large.length); assert.equal(result.envelopeVerified, false);
    assert.equal(fs.existsSync(path.join(config.output, 'response.hoon')), false); assert.equal(requests.length, 1);
  });
});
test('raw state observer rejects malformed framing without retrying or qualifying its payload', async () => {
  await fixture(socket => socket.end(Buffer.from([1, 1, 0, 0, 0, 42])), async (config, requests) => {
    await assert.rejects(observe({...config, query: 'activity-agent', ship: '~nec'}), /prior outcome remains unknown/);
    assert.equal(requests.length, 1); assert.equal(fs.existsSync(path.join(config.output, 'result.json')), false);
  });
});
for (const query of ['app-carrier', 'app-liveness']) test(`${query} requires a bounded literal app name and rejects syntax, paths and duplicate options`, () => {
  const args = ['--pier', __dirname, '--vere', __filename, '--query', query, '--ship', '~nec', '--output', path.join(os.tmpdir(), 'unused-app-carrier')];
  assert.throws(() => options(args), /app/);
  for (const app of ['a', 'readymade-editing', 'hood', 'app-2', 'a'.repeat(64)]) assert.equal(options([...args, '--app', app]).app, app);
  for (const app of ['2app', '-app', 'App', 'a/b', 'a b', 'a\n', 'a\n%poke', '%hood', '../hood', 'hood]', 'hood\u0000', 'a'.repeat(65)]) assert.throws(() => options([...args, '--app', app]), /app/);
  assert.throws(() => options([...args, '--app', 'hood', '--app', 'spider']), /repeated/);
  assert.throws(() => options(args.filter((_, index) => index !== 6 && index !== 7).concat('--app', 'hood')), /ship/);
  for (const query of Object.keys(QUERIES).filter(query => !['app-carrier', 'app-liveness'].includes(query))) {
    const other = ['--pier', __dirname, '--vere', __filename, '--query', query, '--output', path.join(os.tmpdir(), 'unused-app-carrier')];
    if (!['identity', 'threads'].includes(query)) other.push('--ship', '~nec');
    assert.throws(() => options([...other, '--app', 'hood']), /app/);
  }
});
test('app-liveness sends only native gu, never interprets a carrier as running, and keeps lock unchanged', async () => {
  await fixture(socket => socket.end(codecSpider), async (config, requests) => {
    assert.equal(await observe({...config, query: 'app-liveness', ship: '~nec', app: 'readymade-editing'}), 2);
    assert.deepEqual(requests, ['[0 %peek [%| %once %gu %readymade-editing /$]]']);
    const result = JSON.parse(fs.readFileSync(path.join(config.output, 'result.json')));
    assert.equal(result.app, 'readymade-editing'); assert.equal(result.query, 'app-liveness');
    assert.equal(result.envelopeVerified, false); assert.equal(result.identityVerified, false); assert.equal(result.decoded, false);
    assert.equal(result.replayAuthorized, false); assert.equal(result.previousOperationOutcome, 'unknown');
    assert.equal(Object.hasOwn(result, 'live'), false); assert.equal(fs.existsSync(path.join(config.output, 'response.hoon')), false);
  });
});
test('app-carrier selects only the named Gall carrier, keeps foreign payload unverified and preserves the lock', async () => {
  await fixture(socket => socket.end(codecSpider), async (config, requests) => {
    assert.equal(await observe({...config, query: 'app-carrier', ship: '~nec', app: 'readymade-editing'}), 2);
    assert.deepEqual(requests, ['[0 %peek [%| %once %gv %readymade-editing /$]]']);
    const result = JSON.parse(fs.readFileSync(path.join(config.output, 'result.json')));
    const plan = JSON.parse(fs.readFileSync(path.join(config.output, 'plan.json')));
    assert.equal(plan.app, 'readymade-editing'); assert.equal(plan.request, requests[0]);
    assert.equal(result.app, 'readymade-editing'); assert.equal(result.expectedShip, '~nec');
    assert.equal(result.status, 'frame-retained'); assert.equal(result.envelopeVerified, false); assert.equal(result.identityVerified, false);
    assert.equal(result.replayAuthorized, false); assert.equal(result.previousOperationOutcome, 'unknown');
    assert.equal(result.operationLockUntouched, true); assert.equal(fs.existsSync(path.join(config.output, 'response.hoon')), false);
  });
});
test('app-carrier direct API rejects invalid selectors before connecting or creating a receipt', async () => {
  await fixture(socket => socket.end(codecSpider), async (config, requests) => {
    for (const app of [undefined, 'hood /$', 'hood\n', 'constructor/path']) await assert.rejects(observe({...config, query: 'app-carrier', ship: '~nec', app}), /app/);
    await assert.rejects(observe({...config, query: 'activity-agent', ship: '~nec', app: 'hood'}), /app/);
    assert.deepEqual(requests, []); assert.equal(fs.existsSync(config.output), false);
  });
});
