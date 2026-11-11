import assert from 'node:assert/strict';
import test from 'node:test';
import {doctorFindings, parseProcess, parseReading, parseSwap, recoveryRecipe, runtimeOf, type DoctorFacts} from '../src/ship-doctor';
import {decodeDoctorReading, encodeDoctorRequest} from '../src/planet-discovery-wire';

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
