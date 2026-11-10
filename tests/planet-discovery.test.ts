import test from 'node:test';
import assert from 'node:assert/strict';
import type {Stats} from 'node:fs';
import * as http from 'node:http';
import type {AddressInfo} from 'node:net';
import {localPlanetDiscovery, parsePlanetProcesses, parsePlanetLocks, planetListenerOrigin, validPlanetFiles, eyreHeaderFailure, eyreNetworkFailure, type DiscoveryResult, type DiscoveryStage} from '../src/planet-discovery';
import {NativeObservationFailure} from '../src/planet-discovery-wire';
const basic = ({planets, unavailable}: DiscoveryResult) => ({planets, unavailable});

test('process and lock parsing requires same-owner runtime and actual held lock path', () => {
  const rows = parsePlanetProcesses('12 1 501 /runtime/urbit\n13 12 501 /runtime/vere-v4.6\n14 1 502 /runtime/urbit\n15 1 501 /bin/python\n16 1 501 /tmp/not-urbit\ninvalid\n', 501);
  assert.deepEqual(rows.map(p => p.pid), [12, 13]);
  assert.deepEqual(parsePlanetLocks('p14\nn/foreign/.vere.lock\np13\nn/pier/.vere.lock\nn/pier/.vere.lock\nn/pier/.urb/conn.sock\np15\nn/other/.vere.lock\n', rows), [{pier: '/pier', workerPid: 13}]);
  assert.equal(parsePlanetLocks('p13\nn/retired/.vere.lock (deleted)\n', rows).length, 0);
});

test('path admission refuses wrong owners, symlinks, missing sockets and nonregular locks', () => {
  const stat = (kind: string, uid = 501): Stats => ({uid, isSymbolicLink: () => kind === 'link', isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSocket: () => kind === 'socket'} as Stats);
  const good = [stat('dir'), stat('dir'), stat('file'), stat('socket')];
  assert.equal(validPlanetFiles(good, 501), true);
  for (const [index, wrong] of [[0, stat('dir', 502)], [1, stat('link')], [2, stat('dir')], [3, stat('file')]] as const) {
    const changed = [...good]; changed[index] = wrong; assert.equal(validPlanetFiles(changed, 501), false);
  }
  assert.equal(validPlanetFiles(good.slice(1), 501), false);
});
function fixture() {
  const state = {rows: [{pier: '/owned/not-the-ship-name', workerPid: 12}], fake: false, atom: 123456n, live: 0n, port: 8080n, inode: '2', stale: false, calls: [] as string[], bindCalls: 0, changedIdentity: false, fail: '', eyreError: undefined as Error | undefined};
  let nativeError: Error | undefined;
  const fail = (stage: string) => {if (state.fail === stage) throw nativeError ?? Error('PRIVATE path/socket/error sentinel');};
  const api = localPlanetDiscovery({
    candidates: async () => state.rows,
    binding: async () => {fail('binding'); state.bindCalls++; return {device: '1', inode: state.stale && state.bindCalls % 2 === 0 ? 'changed' : state.inode, stamp: 'owner-process-lock'};},
    native: async (_socket, kind) => {
      state.calls.push(kind);
      fail(kind === 'http' ? 'port' : kind);
      if (kind === 'real') return {ship: '~sampel-palnet', fake: state.fake};
      if (kind === 'identity') return state.changedIdentity && state.calls.filter(c => c === kind).length > 1 ? state.atom + 1n : state.atom;
      return kind === 'live' ? state.live : state.port;
    },
    listener: async (_candidate, port) => {fail('listener'); assert.equal(port, Number(state.port)); state.calls.push('listener'); return 'http://127.0.0.1:' + port;},
    eyre: async (origin, ship) => {fail('eyre'); if (state.eyreError) throw state.eyreError; assert.equal(origin, 'http://127.0.0.1:' + state.port); assert.equal(ship, '~sampel-palnet'); state.calls.push('eyre');},
  });
  return {state, api, setNativeError: (error: Error) => {nativeError = error;}};
}
test('real native planet is admitted by observations, never the pier name; selection rechecks', async () => {
  const {state, api} = fixture(), result = await api.discover();
  assert.equal(result.unavailable, 0); assert.equal(result.planets.length, 1);
  assert.deepEqual(result.diagnostics, {candidates: 1, verified: 1, duplicates: 0, deadline: false, failureCounts: {}});
  assert.equal(result.planets[0].ship, '~sampel-palnet'); assert.equal(result.planets[0].origin, 'http://127.0.0.1:8080');
  assert.deepEqual(state.calls, ['identity', 'live', 'real', 'http', 'listener', 'eyre', 'identity']);
  assert.equal((await api.recheck(result.planets[0])).workerPid, 12);
  state.inode = 'replacement'; await assert.rejects(api.recheck(result.planets[0]), /changed or is unavailable/);
});
test('fake, wrong rank, nonlive, stale socket, changed identity and invalid port never produce rows', async () => {
  for (const changes of [{fake: true}, {atom: 65535n}, {atom: 4294967296n}, {live: 1n}, {stale: true}, {changedIdentity: true}, {port: 0n}, {port: 65536n}]) {
    const {state, api} = fixture(); Object.assign(state, changes);
    const result = await api.discover(); assert.deepEqual(basic(result), {planets: [], unavailable: 1});
    const stage = 'fake' in changes ? 'fake' : 'atom' in changes ? 'nonplanet' : 'live' in changes ? 'live' : 'port' in changes ? 'port' : 'stability';
    assert.deepEqual(result.diagnostics.failureCounts, {[stage]: 1});
    if ('fake' in changes || 'atom' in changes || 'live' in changes) assert.equal(state.calls.includes('eyre'), false);
  }
});
test('duplicate real identities are excluded together and capacity never invents rows', async () => {
  const {state, api} = fixture();
  state.rows.push({pier: '/second', workerPid: 13});
  const duplicate = await api.discover(); assert.deepEqual(basic(duplicate), {planets: [], unavailable: 2}); assert.equal(duplicate.diagnostics.duplicates, 2);
  state.rows = Array.from({length: 25}, (_, i) => ({pier: '/pier-' + i, workerPid: i + 1}));
  assert.deepEqual(basic(await api.discover()), {planets: [], unavailable: 25});
  assert.equal(state.calls.filter(c => c === 'eyre').length, 26);
});
test('unavailable enumeration yields no synthetic fallback planet', async () => {
  const api = localPlanetDiscovery({candidates: async () => {throw Error('unsupported');}, binding: async () => {throw Error();}, native: async () => {throw Error();}, listener: async () => {throw Error();}, eyre: async () => {throw Error();}});
  const result = await api.discover(); assert.deepEqual(basic(result), {planets: [], unavailable: 1}); assert.deepEqual(result.diagnostics.failureCounts, {enumeration: 1});
});
test('overall deadline bounds stalled enumeration and file probes and prevents late continuation', async () => {
  for (const stage of ['enumeration', 'binding']) {
    let release!: () => void, nativeCalls = 0, bindings = 0;
    const blocked = new Promise<void>(resolve => {release = resolve;});
    const api = localPlanetDiscovery({
      candidates: async () => {if (stage === 'enumeration') await blocked; return [{pier: '/one', workerPid: 1}, {pier: '/two', workerPid: 2}];},
      binding: async () => {bindings++; await blocked; return {device: '1', inode: '2', stamp: 'same'};},
      native: async () => {nativeCalls++; return 123456n;}, listener: async () => 'http://127.0.0.1:8080', eyre: async () => {},
    }, 10);
    const result = await api.discover();
    assert.deepEqual(basic(result), {planets: [], unavailable: 1});
    assert.equal(result.diagnostics.deadline, true); assert.equal(result.diagnostics.failureCounts[stage as DiscoveryStage], stage === 'binding' ? 2 : 1);
    const snapshot = structuredClone(result);
    const priorBindings = bindings; release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(nativeCalls, 0); assert.equal(bindings, priorBindings);
    assert.deepEqual(result, snapshot, 'published snapshot never changes after return');
  }
});
test('controlled failure stages contain counts only and cannot disclose paths or error text', async () => {
  for (const stage of ['binding', 'identity', 'live', 'real', 'port', 'listener', 'eyre']) {
    const {state, api} = fixture(); state.fail = stage;
    const result = await api.discover(); assert.deepEqual(result.diagnostics, {candidates: 1, verified: 0, duplicates: 0, deadline: false, failureCounts: {[stage]: 1}});
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.equal(JSON.stringify(result.diagnostics).includes('/owned'), false);
    assert.equal(Object.isFrozen(result.diagnostics), true); assert.equal(Object.isFrozen(result.diagnostics.failureCounts), true);
  }
});
test('Eyre rejection reasons are controlled and preserve header admission without retaining private values', async () => {
  const owner = '~sampel-palnet';
  assert.equal(eyreHeaderFailure('urbit/vere-4.6', 200, [], owner), undefined);
  assert.equal(eyreHeaderFailure('urbit/vere-4.6', 302, ['urbauth-' + owner], owner), undefined);
  const cases: [string, Error | undefined][] = [
    ['server', eyreHeaderFailure('PRIVATE_SERVER', 200, [], owner)],
    ['server', eyreHeaderFailure(undefined, 200, [], owner)],
    ['status', eyreHeaderFailure('urbit', 500, [], owner)],
    ['status', eyreHeaderFailure('urbit', undefined, [], owner)],
    ['cookie', eyreHeaderFailure('urbit', 200, ['urbauth-PRIVATE_SHIP'], owner)],
    ...['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR'].map(code => ['network-' + code, eyreNetworkFailure(code)] as [string, Error]),
    ['network-other', eyreNetworkFailure('PRIVATE_ERROR_CODE')],
    ['network-other', eyreNetworkFailure(undefined)],
  ];
  for (const [reason, error] of cases) {
    assert.ok(error); const {state, api} = fixture(); state.eyreError = error;
    const result = await api.discover(); assert.deepEqual(result.diagnostics.failureCounts, {['eyre-' + reason]: 1});
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal(result.planets.length, 0);
  }
});
test('native query failure classes propagate controlled stage reasons without raw evidence', async () => {
  for (const stage of ['identity', 'live', 'real', 'port']) for (const reason of ['timeout', 'connection', 'frame-or-decode', 'envelope'] as const) {
    const {state, api, setNativeError} = fixture(); state.fail = stage; setNativeError(new NativeObservationFailure(reason));
    const result = await api.discover();
    assert.deepEqual(result.diagnostics.failureCounts, {[stage + '-' + reason]: 1});
    assert.equal(result.planets.length, 0); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }
});

test('listener origin binds the owned address family and literal loopback endpoint', () => {
  for (const [family, address, origin] of [
    ['IPv4', '127.0.0.1', 'http://127.0.0.1:8080'], ['IPv4', '*', 'http://127.0.0.1:8080'],
    ['IPv6', '[::1]', 'http://[::1]:8080'], ['IPv6', '*', 'http://[::1]:8080'],
  ]) assert.equal(planetListenerOrigin(`p12\nf1\nt${family}\nn${address}:8080\n`, [12], 8080), origin);
  for (const output of [
    'p13\nf1\ntIPv4\nn127.0.0.1:8080\n', 'p12\nf1\ntIPv4\nn127.0.0.1:8081\n',
    'p12\nf1\ntIPv4\nn192.0.2.1:8080\n', 'p12\nf1\ntIPv6\nn[2001:db8::1]:8080\n',
    'p12\nf1\ntIPv4\nnlocalhost:8080\n', 'p12\nf1\ntIPv4\nn[::1]:8080\n',
    'p12\nf1\ntIPv6\nn127.0.0.1:8080\n', 'p12\nf1\nn*:8080\n',
    'p13\nf1\ntIPv4\np12\nf2\nn*:8080\n', 'p12\nf1\ntIPv4\nf2\nn*:8080\n',
    'p12\nf1\ntIPv4\ntUNKNOWN\nn*:8080\n',
  ]) assert.throws(() => planetListenerOrigin(output, [12], 8080), /Local listener unavailable/);
  assert.equal(planetListenerOrigin('p13\nf1\ntIPv6\nn[::1]:8080\np12\nf2\ntIPv4\nn127.0.0.1:8080\n', [12], 8080), 'http://127.0.0.1:8080');
  assert.equal(planetListenerOrigin('p12\nf1\ntIPv6\nn*:8080\nf2\ntIPv4\nn*:8080\n', [12], 8080), 'http://127.0.0.1:8080');
});

test('same-port IPv4 and IPv6 HTTP fixtures cannot redirect a selected listener through localhost', async t => {
  const received: string[] = [];
  const ipv4 = http.createServer((_request, response) => {received.push('IPv4'); response.end('IPv4');});
  const ipv6 = http.createServer((_request, response) => {received.push('IPv6'); response.end('IPv6');});
  t.after(async () => {await Promise.all([ipv4, ipv6].map(server => new Promise<void>(resolve => server.close(() => resolve()))));});
  const listen = (server: http.Server, host: string, port: number) => new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen({host, port, ipv6Only: true}, () => {server.removeListener('error', reject); resolve();});
  });
  await listen(ipv4, '127.0.0.1', 0);
  const port = (ipv4.address() as AddressInfo).port;
  await listen(ipv6, '::1', port);
  const records = `p12\nf1\ntIPv4\nn127.0.0.1:${port}\np13\nf2\ntIPv6\nn[::1]:${port}\n`;
  for (const [owner, family] of [[12, 'IPv4'], [13, 'IPv6']] as const) {
    const origin = planetListenerOrigin(records, [owner], port);
    assert.equal(new URL(origin).hostname.includes('localhost'), false);
    const body = await new Promise<string>((resolve, reject) => {
      const request = http.get(origin + '/~/login', {agent: false, timeout: 2000}, response => {
        let text = ''; response.setEncoding('utf8'); response.on('data', chunk => {text += chunk;});
        response.on('end', () => resolve(text)); response.on('error', reject);
      });
      request.on('error', reject); request.on('timeout', () => request.destroy(Error('Fixture HTTP timeout')));
    });
    assert.equal(body, family); assert.deepEqual(received, owner === 12 ? ['IPv4'] : ['IPv4', 'IPv6']);
  }
});
