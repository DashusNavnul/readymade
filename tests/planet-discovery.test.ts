import test from 'node:test';
import assert from 'node:assert/strict';
import type {Stats} from 'node:fs';
import * as http from 'node:http';
import type {AddressInfo} from 'node:net';
import {DISCOVERY_BUDGET_MS, localPlanetDiscovery, parsePlanetProcesses, parsePlanetLocks, planetListenerOrigin, validPlanetFiles, eyreHeaderFailure, eyreNetworkFailure, eyreTimeoutFailure, slowShipNotice, type DiscoveryResult, type DiscoveryStage} from '../src/planet-discovery';
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
  const state = {rows: [{pier: '/owned/not-the-ship-name', workerPid: 12}], ship: '~sampel-palnet', fake: false, atom: 123456n, live: 0n, port: 8080n, inode: '2', stale: false, calls: [] as string[], bindCalls: 0, changedIdentity: false, fail: '', eyreError: undefined as Error | undefined};
  let nativeError: Error | undefined;
  const fail = (stage: string) => {if (state.fail === stage) throw nativeError ?? Error('PRIVATE path/socket/error sentinel');};
  const api = localPlanetDiscovery({
    candidates: async () => state.rows,
    binding: async () => {fail('binding'); state.bindCalls++; return {device: '1', inode: state.stale && state.bindCalls % 2 === 0 ? 'changed' : state.inode, stamp: 'owner-process-lock'};},
    native: async (_socket, kind) => {
      state.calls.push(kind);
      fail(kind === 'http' ? 'port' : kind);
      if (kind === 'real') return {ship: state.ship, fake: state.fake};
      if (kind === 'identity') return state.changedIdentity && state.calls.filter(c => c === kind).length > 1 ? state.atom + 1n : state.atom;
      return kind === 'live' ? state.live : state.port;
    },
    listener: async (_candidate, port) => {fail('listener'); assert.equal(port, Number(state.port)); state.calls.push('listener'); return 'http://127.0.0.1:' + port;},
    eyre: async (origin, ship) => {fail('eyre'); if (state.eyreError) throw state.eyreError; assert.equal(origin, 'http://127.0.0.1:' + state.port); assert.equal(ship, state.ship); state.calls.push('eyre');},
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
test('fake, out-of-range identity, nonlive, stale socket, changed identity and invalid port never produce rows', async () => {
  for (const changes of [{fake: true}, {atom: -1n}, {atom: 1n << 128n}, {live: 1n}, {stale: true}, {changedIdentity: true}, {port: 0n}, {port: 65536n}]) {
    const {state, api} = fixture(); Object.assign(state, changes);
    const result = await api.discover(); assert.deepEqual(basic(result), {planets: [], unavailable: 1});
    const stage = 'fake' in changes ? 'fake' : 'atom' in changes ? 'identity-range' : 'live' in changes ? 'live' : 'port' in changes ? 'port' : 'stability';
    assert.deepEqual(result.diagnostics.failureCounts, {[stage]: 1});
    if ('fake' in changes || 'atom' in changes || 'live' in changes) assert.equal(state.calls.includes('eyre'), false);
  }
});
const shipRanks = [
  {atom: 0n, ship: '~zod'}, {atom: 255n, ship: '~fes'},
  {atom: 256n, ship: '~marzod'}, {atom: 65535n, ship: '~fipfes'},
  {atom: 65536n, ship: '~sampel-palnet'}, {atom: (1n << 32n) - 1n, ship: '~sampel-palnet'},
  {atom: 1n << 32n, ship: '~doznec-sampel-palnet'},
  {atom: (1n << 48n) - 1n, ship: '~doznec-sampel-palnet'},
  {atom: 1n << 48n, ship: '~bondyl-libpen-dashus-navnul'},
  {atom: (1n << 64n) - 1n, ship: '~bondyl-libpen-dashus-navnul'},
  ...[64n, 80n, 96n, 112n].flatMap(bits => {
    const ship = '~' + Array(Number((bits - 64n) / 16n) + 1).fill('doznec').join('-') + '--bondyl-libpen-dashus-navnul';
    return [{atom: 1n << bits, ship}, {atom: (1n << (bits + 16n)) - 1n, ship}];
  }),
];
test('all native ship ranks and name lengths retain verified discovery and selection binding', async () => {
  // These fixtures check rank/name shape; canonical spelling and atom encoding remain Jael's responsibility.
  for (const {atom, ship} of shipRanks) {
    const {state, api} = fixture(); Object.assign(state, {atom, ship});
    const result = await api.discover();
    assert.equal(result.unavailable, 0, ship); assert.equal(result.planets.length, 1, ship);
    assert.equal(result.planets[0].ship, ship); assert.equal(result.diagnostics.verified, 1);
    assert.deepEqual(state.calls, ['identity', 'live', 'real', 'http', 'listener', 'eyre', 'identity']);
    assert.equal((await api.recheck(result.planets[0])).ship, ship);
    state.inode = 'replacement'; await assert.rejects(api.recheck(result.planets[0]), /changed or is unavailable/);
  }
});
test('every rank rejects fake ships, identity drift and duplicate identities', async () => {
  for (const {atom, ship} of shipRanks) {
    for (const changes of [{fake: true}, {changedIdentity: true}]) {
      const {state, api} = fixture(); Object.assign(state, {atom, ship}, changes);
      const result = await api.discover(); assert.deepEqual(basic(result), {planets: [], unavailable: 1});
      assert.deepEqual(result.diagnostics.failureCounts, {['fake' in changes ? 'fake' : 'stability']: 1});
    }
    const {state, api} = fixture(); Object.assign(state, {atom, ship}); state.rows.push({pier: '/second', workerPid: 13});
    const result = await api.discover(); assert.deepEqual(basic(result), {planets: [], unavailable: 2}); assert.equal(result.diagnostics.duplicates, 2);
  }
});
test('native names must match their rank and fake must be an explicit false', async () => {
  const ranks = [shipRanks[0], shipRanks[2], shipRanks[4], shipRanks[6], shipRanks[10]];
  for (const owner of ranks) for (const other of ranks) {
    if (owner === other) continue;
    const {state, api} = fixture(); Object.assign(state, {atom: owner.atom, ship: other.ship});
    const result = await api.discover(); assert.deepEqual(result.diagnostics.failureCounts, {real: 1});
    assert.equal(result.planets.length, 0); assert.equal(state.calls.includes('http'), false);
  }
  for (const {atom, ship} of shipRanks) for (const changes of [
    {ship: ship + '\n'}, {ship: ship + '\r'}, {ship: ship + '\u2028'}, {ship: ship + ' '},
    {ship: ship.toUpperCase()}, {ship: ship.slice(1)}, {ship: ship + '--doznec'},
    {fake: undefined}, {fake: null}, {fake: 0}, {fake: 'false'},
  ]) {
    const {state, api} = fixture(); Object.assign(state, {atom, ship}, changes);
    const result = await api.discover(); assert.deepEqual(result.diagnostics.failureCounts, {real: 1});
    assert.equal(result.planets.length, 0); assert.equal(state.calls.includes('http'), false);
  }
  for (const ship of ['~doznec-bondyl-libpen-dashus-navnul', '~doznec--bondyl-libpen-dashus', '~doznec-bondyl--libpen-dashus-navnul', '~doznec--bondyl-libpen-dashus-navnul--doznec']) {
    const {state, api} = fixture(); Object.assign(state, {atom: 1n << 64n, ship});
    const result = await api.discover(); assert.deepEqual(result.diagnostics.failureCounts, {real: 1}); assert.equal(result.planets.length, 0);
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
test('picker names slow ships and stays silent about deliberate exclusions', () => {
  const report = (failureCounts: Partial<Record<DiscoveryStage, number>>, deadline = false) =>
    slowShipNotice({candidates: 3, verified: 1, duplicates: 0, deadline, failureCounts});
  assert.equal(report({}), undefined);
  assert.equal(report({fake: 2, 'identity-range': 1, 'eyre-server': 1, 'real-connection': 1}), undefined);
  assert.match(report({'real-timeout': 1})!, /^A running ship did not answer in time\./);
  assert.match(report({'real-timeout': 1, 'eyre-timeout': 1, fake: 1})!, /^2 running ships did not answer in time\./);
  assert.match(report({'real-timeout': 1}, true)!, /^A running ship did not answer/);
  assert.match(report({binding: 1}, true)!, /^Checking for running ships took too long\./);
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

test('a ship that is briefly quiet is found: the two reads its event loop answers are each retried once, on a timeout only', async () => {
  const quiet = (count: number, kind: 'identity' | 'live' | 'real' | 'http' | 'eyre', reason: 'timeout' | 'connection' = 'timeout') => {
    let left = count; const calls: string[] = [];
    const fail = (query: string) => {calls.push(query); if (query === kind && left > 0) {left--; return true;} return false;};
    const api = localPlanetDiscovery({
      candidates: async () => [{pier: '/owned/pier', workerPid: 12}],
      binding: async () => ({device: '1', inode: '2', stamp: 'owner-process-lock'}),
      native: async (_socket, query) => {
        if (fail(query)) throw new NativeObservationFailure(reason);
        if (query === 'real') return {ship: '~sampel-palnet', fake: false};
        return query === 'identity' ? 123456n : query === 'live' ? 0n : 8080n;
      },
      listener: async () => 'http://127.0.0.1:8080',
      eyre: async () => {if (fail('eyre')) throw reason === 'timeout' ? eyreTimeoutFailure() : eyreNetworkFailure('ECONNREFUSED');},
    });
    return {api, calls};
  };
  const count = (calls: string[], kind: string) => calls.filter(c => c === kind).length;
  for (const kind of ['real', 'eyre'] as const) {
    const once = quiet(1, kind), found = await once.api.discover();
    assert.equal(found.planets.length, 1); assert.equal(found.unavailable, 0); assert.deepEqual(found.diagnostics.failureCounts, {});
    assert.equal(count(once.calls, kind), 2);
    const twice = quiet(2, kind), lost = await twice.api.discover();
    assert.equal(lost.planets.length, 0); assert.deepEqual(lost.diagnostics.failureCounts, {[`${kind}-timeout`]: 1});
    assert.equal(count(twice.calls, kind), 2);
    assert.match(slowShipNotice(lost.diagnostics)!, /^A running ship did not answer in time\./);
    const refused = quiet(1, kind, 'connection'), down = await refused.api.discover();
    assert.equal(down.planets.length, 0); assert.equal(count(refused.calls, kind), 1);
  }
  // The runtime answers these itself, so a timeout there is not a busy ship and is not retried.
  for (const kind of ['identity', 'live', 'http'] as const) {
    const stuck = quiet(1, kind), result = await stuck.api.discover();
    assert.equal(result.planets.length, 0); assert.equal(count(stuck.calls, kind), 1);
  }
  assert.equal(DISCOVERY_BUDGET_MS, 16000);
  assert.throws(() => localPlanetDiscovery({} as never, DISCOVERY_BUDGET_MS + 1), /Invalid discovery budget/);
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
