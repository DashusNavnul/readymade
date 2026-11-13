import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile, execFileSync} from 'node:child_process';
import {closeSync, mkdtempSync, openSync, rmSync, writeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {doctorFindings, parseEventWatch, parseFlowReading, parseProcess, parseReading, parseSwap, recoveryRecipe, runtimeOf, type DoctorFacts} from '../src/ship-doctor';
import {decodeDoctorReading, decodeFlowsReading, encodeDoctorRequest, encodeFlowsRequest} from '../src/planet-discovery-wire';

const GB = 1024 ** 3;
const healthy: DoctorFacts = {ship: '~sampel-palnet', httpMs: 24, bundledKelvin: 408,
  command: '/Users/x/vere-v4.6 work --snap-dir /piers/sampel --loom 34 --toss 0', cpuPercent: 5, residentBytes: 500 * 1024 ** 2,
  snapshotBytes: 4 * GB, eventLogBytes: 9 * GB, freeDiskBytes: 46 * GB, swapUsedBytes: 1.8 * GB, swapTotalBytes: 3 * GB, memoryBytes: 8 * GB,
  reading: {kelvin: 408, timers: 60, soon: [{seconds: 4, owner: 'ames'}, {seconds: 30, owner: 'behn'}]}};
const level = (facts: DoctorFacts, id: string) => doctorFindings(facts).find(f => f.id === id)?.level;

test('host readings parse strictly', () => {
  assert.deepEqual(parseSwap('total = 3072.00M  used = 1828.06M  free = 1243.94M  (encrypted)'), {usedBytes: Math.round(1828.06 * 1024 ** 2), totalBytes: 3072 * 1024 ** 2});
  assert.equal(parseSwap('nonsense'), undefined);
  assert.deepEqual(parseProcess('  5.2 478880'), {cpuPercent: 5.2, residentBytes: 478880 * 1024}); assert.deepEqual(parseProcess('98,9 1024')?.cpuPercent, 98.9);
  assert.equal(parseProcess('x y'), undefined);
  assert.deepEqual(runtimeOf('/a/b/vere-v4.6-x work --snap-dir /p --loom 33 --toss 0'), {binary: 'vere-v4.6-x', loom: 33, toss: 0});
  assert.deepEqual(runtimeOf('/a/urbit /p'), {binary: 'urbit', loom: undefined, toss: undefined});
});
test('the ship reading is refused whole unless every word is exact', () => {
  assert.deepEqual(parseReading('408 1.234 5:viki 61:portal 0:ames'), {kelvin: 408, timers: 1234, soon: [{seconds: 5, owner: 'viki'}, {seconds: 61, owner: 'portal'}, {seconds: 0, owner: 'ames'}]});
  assert.deepEqual(parseReading('408 0'), {kelvin: 408, timers: 0, soon: []});
  for (const bad of ['', '408', 'x 1', '408 1 5:Viki', '408 1 :viki', '408 1 5viki', '408 0 5:viki', '40 1', '408 1,234', '408 1 5:viki;rm']) assert.throws(() => parseReading(bad), /Unreadable/, bad);
});
test('the reading request is one read-only thread, and only a matching, well-formed reply decodes', () => {
  const request = encodeDoctorRequest(7); assert.ok(request.length > 100 && request.length < 4096);
  assert.throws(() => decodeDoctorReading(7, Buffer.from([0, 1, 0, 0, 0, 0])));
});
test('a healthy ship has no warnings; each measured fault raises exactly its own', () => {
  assert.deepEqual(doctorFindings(healthy).filter(f => f.level === 'warning' || f.level === 'problem'), []);
  assert.equal(level({...healthy, httpMs: null}, 'http'), 'problem'); assert.equal(level({...healthy, httpMs: 2400}, 'http'), 'warning');
  assert.equal(doctorFindings({...healthy, httpMs: null})[0].id, 'http');
  // 2026-11-11: a 4.5 GB snapshot in an 8 GB arena ran out of loom compiling; the same snapshot in 16 GB did not.
  assert.equal(level({...healthy, command: healthy.command!.replace('--loom 34', '--loom 33'), snapshotBytes: 4.5 * GB}, 'snapshot'), 'warning');
  assert.equal(level({...healthy, snapshotBytes: 4.5 * GB}, 'snapshot'), 'ok');
  assert.equal(level({...healthy, command: '/x/vere work --snap-dir /p --loom 31'}, 'loom'), 'warning');
  assert.equal(level({...healthy, ship: '~doznec-salfun-sampel-palnet', command: '/x/vere work --snap-dir /p --loom 31'}, 'loom'), 'note');
  assert.equal(level({...healthy, freeDiskBytes: 10 * GB}, 'disk'), 'warning');
  assert.equal(level({...healthy, swapUsedBytes: 6.5 * GB, swapTotalBytes: 7 * GB}, 'swap'), 'warning');
  assert.equal(level({...healthy, eventLogBytes: 20 * GB}, 'log'), 'note');
  const busy = doctorFindings({...healthy, cpuPercent: 75, reading: {kelvin: 408, timers: 900, soon: [...Array(40).fill({seconds: 10, owner: 'viki'}), ...Array(6).fill({seconds: 50, owner: 'portal'}), {seconds: 200, owner: 'late'}]}});
  assert.equal(busy.find(f => f.id === 'busy')?.level, 'warning'); assert.match(busy.find(f => f.id === 'busy')!.detail, /75%.*viki ×40, portal ×6/);
  assert.equal(busy.find(f => f.id === 'timers')?.level, 'warning'); assert.match(busy.find(f => f.id === 'timers')!.detail, /^46 timers are due in the next minute \(900 pending/);
  assert.equal(level({...healthy, reading: {...healthy.reading!, kelvin: 409}}, 'kelvin'), 'warning');
});
test('the paused-connection count is refused whole unless it is consistent', () => {
  assert.deepEqual(parseFlowReading('3.518 3.117 3.465 0'), {known: 3518, pausedShips: 3117, pausedFlows: 3465, heardCount: 0, heard: []});
  assert.deepEqual(parseFlowReading('40 2 6 2 ~sampel-palnet ~zod'), {known: 40, pausedShips: 2, pausedFlows: 6, heardCount: 2, heard: ['~sampel-palnet', '~zod']});
  assert.equal(parseFlowReading('9 0 0 0').pausedFlows, 0);
  const comet = '~dasres-ragnep-lislel-nidbyr--bonzod-sitmul-livlet-rosnet';
  assert.deepEqual(parseFlowReading(`9 1 1 1 ${comet}`).heard, [comet]);
  const many = Array.from({length: 16}, () => '~zod').join(' ');
  assert.equal(parseFlowReading(`900 30 40 20 ${many}`).heard.length, 16);
  for (const bad of ['', '3 1 1', '3 1 1 1', '3 1 1 0 ~zod', '3 2 1 0', '3 0 1 0', '3 4 9 0', '3 1 1 2 ~zod ~nec', '3 1 1 1 zod', '3 1 1 1 ~Zod',
    '3 1 1 1 ~zod;rm', '3,1 1 1 0', `900 30 40 20 ${many} ~nec`]) assert.throws(() => parseFlowReading(bad), /Unreadable/, bad);
});
test('the flows request is one read-only thread that rests between batches', () => {
  const request = encodeFlowsRequest(9); assert.ok(request.length > 100 && request.length < 8192);
  assert.throws(() => decodeFlowsReading(9, Buffer.from([0, 1, 0, 0, 0, 0])));
});
test('paused connections: counted when quiet, named when online, a warning only with a busy worker', () => {
  // A planet measured 2026-11-13: 3,117 of 3,518 peers paused by the nightly dead-peer job, none heard within a day.
  const quiet = doctorFindings({...healthy, flows: parseFlowReading('3.518 3.117 3.465 0')}).find(f => f.id === 'paused')!;
  assert.equal(quiet.level, 'ok'); assert.match(quiet.detail, /^3,465 connections to 3,117 of 3,518 known ships are paused; none/);
  assert.match(doctorFindings({...healthy, flows: parseFlowReading('12 0 0 0')}).find(f => f.id === 'paused')!.detail, /^No connection to any of 12/);
  // 2026-11-12: one online ship with paused flows, kept the worker 57% busy.
  const online = parseFlowReading('3.518 2 4 1 ~sampel-palnet');
  const calm = doctorFindings({...healthy, flows: online}).find(f => f.id === 'paused')!;
  assert.equal(calm.level, 'note'); assert.match(calm.detail, /^1 ship heard from in the last day has a paused connection: ~sampel-palnet\./); assert.doesNotMatch(calm.detail, /57%/);
  const busy = doctorFindings({...healthy, cpuPercent: 57, flows: online}).find(f => f.id === 'paused')!;
  assert.equal(busy.level, 'warning'); assert.match(busy.detail, /57% busy/);
  const more = doctorFindings({...healthy, flows: parseFlowReading(`900 30 40 20 ${Array(16).fill('~zod').join(' ')}`)}).find(f => f.id === 'paused')!;
  assert.match(more.detail, /^20 ships .* have a paused connection: .* and 4 more\./);
  assert.equal(level({...healthy, flowsFailure: 'timeout'}, 'paused'), 'note'); assert.equal(level({...healthy, flowsFailure: 'unavailable'}, 'paused'), 'note');
  assert.equal(level(healthy, 'paused'), undefined);
});
// A planet measured 2026-11-13, 130 s: the watcher and an independent sampler found the same six events over 100 ms.
const watched = 'watched 130000000 events 5816 busy 19030527 longest 277706 over 1 unreadable 3\nslow 82442 277706 poke/arvo>call/gall>on-poke/%noltbook\n';
test('the event watch is refused whole unless it is consistent', () => {
  assert.deepEqual(parseEventWatch(watched), {watchedMs: 130000, events: 5816, busyMs: 19030.527, longestMs: 277.706, over: 1,
    slow: [{startMs: 82442, lengthMs: 277.706, labels: ['poke/arvo', 'call/gall', 'on-poke/%noltbook']}]});
  assert.equal(parseEventWatch('watched 10000000 events 0 busy 0 longest 0 over 0 unreadable 0').events, 0);
  const lines = Array.from({length: 32}, (_, i) => `slow ${i} 300000 poke/arvo`).join('\n');
  assert.equal(parseEventWatch(`watched 10000000 events 50 busy 9000000 longest 300000 over 40 unreadable 0\n${lines}`).slow.length, 32);
  for (const bad of ['', 'unavailable 2', 'watched 10 events 1 busy 1 longest 1 over 1 unreadable 0', 'watched 10000000 events 1 busy 1 longest 1 over 0 unreadable 0\nslow 1 1 x',
    'watched 10000000 events 1 busy 1 longest 1000 over 2 unreadable 0\nslow 1 300 a\nslow 2 300 b', 'watched 10000000 events 1 busy 1 longest 100 over 1 unreadable 0\nslow 1 300 a',
    'watched 10000000 events 1 busy 1 longest 300 over 1 unreadable 0\nslow 1 300 a b', 'watched 10 events 1 busy 1 longest 300 over 1 unreadable 0\nslow 1 300 a'])
    assert.throws(() => parseEventWatch(bad), /Unreadable/, bad);
});
test('events over 200 ms are a warning that names where the time went', () => {
  const slow = doctorFindings({...healthy, events: parseEventWatch(watched)}).find(f => f.id === 'events')!;
  assert.equal(slow.level, 'warning'); assert.match(slow.detail, /^In 130 s watched, 1 of 5816 events ran longer than 200 ms/); assert.match(slow.detail, /278 ms in poke\/arvo › call\/gall › on-poke\/%noltbook/);
  assert.doesNotMatch(slow.detail, /two-minute watch/);
  const quiet = doctorFindings({...healthy, events: parseEventWatch('watched 10000000 events 900 busy 400000 longest 38896 over 0 unreadable 4')}).find(f => f.id === 'events')!;
  assert.equal(quiet.level, 'ok'); assert.match(quiet.detail, /^In 10 s watched: 900 events, the longest 39 ms, none over 200 ms\. .*two-minute watch/);
  assert.equal(level({...healthy, eventsFailure: 'missing'}, 'events'), 'note'); assert.equal(level({...healthy, eventsFailure: 'unavailable'}, 'events'), 'note');
  assert.equal(level(healthy, 'events'), undefined);
});
/** The runtime's label page (vere trace.c): write offset, overflow count, then each label followed by its 4-byte length. */
function labelPage(labels: string[]): Buffer {
  const page = Buffer.alloc(16384); let off = 0;
  for (const label of ['root', ...labels]) {const bytes = Buffer.from(label); bytes.copy(page, 8 + off); page.writeUInt32LE(bytes.length, 8 + off + bytes.length); off += bytes.length + 4;}
  page.writeUInt32LE(off, 0); return page;
}
test('the packaged event watcher times a real label page the way the runtime writes it', {skip: process.platform !== 'darwin'}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-watch-')), binary = join(dir, 'event-watch'), file = join(dir, 'page');
  try {
    execFileSync('/usr/bin/xcrun', ['clang', '-O2', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=12.0', join(__dirname, '../../packaging/event-watch.c'), '-o', binary]);
    // A missing page is said, not guessed; this first run also pays macOS's one-time check of a new binary,
    // which otherwise delays the timed run past the start of the event below.
    assert.throws(() => execFileSync(binary, ['--file', join(dir, 'absent'), '1', '200'], {encoding: 'utf8'}),
      (error: {status?: number; stdout?: string}) => error.status === 3 && /^unavailable 2\n$/.test(error.stdout ?? ''));
    const fd = openSync(file, 'w+'), put = (labels: string[]) => writeSync(fd, labelPage(labels), 0, 16384, 0);
    put([]);
    const report = new Promise<string>((resolve, reject) => execFile(binary, ['--file', file, '2', '200'], (error, stdout) => error ? reject(error) : resolve(stdout)));
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    await sleep(300); put(['poke/arvo', 'call/gall', 'on-poke/%noltbook']); await sleep(260); put([]);
    await sleep(100); put(['poke/arvo']); await sleep(30); put([]);
    const result = parseEventWatch(await report); closeSync(fd);
    assert.equal(result.events, 2); assert.equal(result.over, 1);
    assert.deepEqual(result.slow[0].labels, ['poke/arvo', 'call/gall', 'on-poke/%noltbook']);
    assert.ok(result.slow[0].lengthMs > 230 && result.slow[0].lengthMs < 400 && result.slow[0].startMs > 100, JSON.stringify(result.slow[0]));
  } finally {rmSync(dir, {recursive: true, force: true});}
});
test('missing readings are said, never guessed', () => {
  const remote = doctorFindings({ship: '~sampel-palnet', httpMs: 80, bundledKelvin: 408});
  assert.deepEqual(remote.map(f => f.id).sort(), ['http', 'reading', 'runtime']); assert.ok(remote.every(f => f.level === 'ok' || f.level === 'note'));
  assert.equal(level({...healthy, reading: undefined, readingFailure: 'timeout'}, 'reading'), 'warning');
});
test('the recovery recipe names the real pier and runtime and the two rules that lose ships', () => {
  const recipe = recoveryRecipe('~sampel-palnet', '/piers/sampel', healthy.command);
  assert.match(recipe, /Pier \(the whole ship\): \/piers\/sampel/); assert.match(recipe, /\/Users\/x\/vere-v4\.6 --loom 34 \/piers\/sampel/);
  assert.match(recipe, /Never copy a running pier/); assert.match(recipe, /Never run a backup and the original at the same time/); assert.match(recipe, /stale snapshot/);
  assert.match(recoveryRecipe('~zod', '/p', undefined), /not read \(the ship is not running\)/);
});
