import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {PlanetBoot, PlanetBootError, parseBootReport, planetFromKeyfile} from '../src/planet-boot';
import type {ToolRunner} from '../src/backend-install';

const digest = 'c'.repeat(64);
const report = (phase: string, extra: Record<string, unknown> = {}) => JSON.stringify({phase, items: [{id: 'boot:start', label: 'Starting your planet', status: 'done'}], ...extra});
function workspace(t: {after(fn: () => void): void}): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rm-planet-boot-')); t.after(() => fs.rmSync(root, {recursive: true, force: true})); return root;
}

test('boot reports accept only known phases and a loopback address', () => {
  assert.equal(parseBootReport(report('booted', {url: 'http://127.0.0.1:8080'}))?.url, 'http://127.0.0.1:8080');
  assert.equal(parseBootReport(report('running'))?.phase, 'running');
  for (const bad of [report('activated'), report('booted', {url: 'http://example.com:8080'}), report('booted', {url: 'https://127.0.0.1:8080'}), report('booted', {url: 'http://127.0.0.1:8080/x'}), 'noise'])
    assert.equal(parseBootReport(bad), undefined, bad.slice(0, 60));
  assert.equal(planetFromKeyfile('/tmp/sampel-palnet-2.key'), '~sampel-palnet');
  assert.equal(planetFromKeyfile('/tmp/notes.key'), undefined);
});

test('preparing hands the tool a private copy of the keyfile and removes it afterwards', async t => {
  const root = workspace(t), ships = path.join(root, 'ships'), keyfile = path.join(root, 'sampel-palnet-1.key');
  fs.writeFileSync(keyfile, 'key material'); fs.chmodSync(keyfile, 0o644); // explicit: creation mode depends on the umask
  let seen: {args: readonly string[]; mode: number; content: string} | undefined;
  const tool: ToolRunner = async (_script, args) => {
    const copy = args[args.indexOf('--keyfile') + 1];
    seen = {args, mode: fs.statSync(copy).mode & 0o777, content: fs.readFileSync(copy, 'utf8')};
    return {code: 0, stdout: JSON.stringify({ship: '~sampel-palnet', digest, pier: path.join(ships, 'sampel-palnet'), output: path.join(ships, 'sampel-palnet-boot'), httpPort: 8081}) + '\n'};
  };
  const plan = await new PlanetBoot('/app/backend/install', ships, tool).prepare('~sampel-palnet', keyfile);
  assert.equal(plan.httpPort, 8081); assert.equal(plan.digest, digest);
  assert.equal(seen?.mode, 0o600); assert.equal(seen?.content, 'key material');
  assert.deepEqual(seen?.args.slice(0, 3), ['prepare', '--ship', '~sampel-palnet']);
  assert.ok(seen?.args.includes('--confirm-not-running-elsewhere'));
  assert.deepEqual(fs.readdirSync(ships), [], 'The private copy is removed');
  assert.equal(fs.statSync(keyfile).mode & 0o777, 0o644, 'The chosen file is left as it was');
});

test('preparing refuses in plain words and never leaves a key copy behind', async t => {
  const root = workspace(t), ships = path.join(root, 'ships'), keyfile = path.join(root, 'sampel-palnet-1.key');
  fs.writeFileSync(keyfile, 'k'); let calls = 0;
  const refuse: ToolRunner = async () => {calls++; return {code: 1, stdout: ''};};
  const boot = new PlanetBoot('/t', ships, refuse);
  await assert.rejects(boot.prepare('~zod', keyfile), /planet’s name/);
  await assert.rejects(boot.prepare('~sampel-palnet', path.join(root, 'absent.key')), /could not be read/);
  assert.equal(calls, 0);
  await assert.rejects(boot.prepare('~sampel-palnet', keyfile), (error: unknown) => error instanceof PlanetBootError && /could not be used for ~sampel-palnet/.test(error.message));
  const wrong: ToolRunner = async () => ({code: 0, stdout: JSON.stringify({ship: '~other-planet', digest, pier: '/p', output: '/o', httpPort: 8080})});
  await assert.rejects(new PlanetBoot('/t', ships, wrong).prepare('~sampel-palnet', keyfile), /could not be used/);
  assert.deepEqual(fs.readdirSync(ships), []);
});

test('launching reports valid lines and falls back to the retained record, never a second start', async () => {
  const calls: string[] = [], plan = {ship: '~sampel-palnet', digest, pier: '/p', output: '/o', httpPort: 8080};
  const tool: ToolRunner = async (_script, args, onLine) => {
    calls.push(args[0]);
    if (args[0] === 'launch') {for (const line of [report('running'), 'noise', report('booted', {url: 'http://127.0.0.1:8080'})]) onLine?.(line); return {code: 0, stdout: ''};}
    return {code: 0, stdout: report('needs-attention', {stoppedAt: 'Preparing it', reason: 'r'})};
  };
  const seen: string[] = [];
  const final = await new PlanetBoot('/t', '/r', tool).launch(plan, now => seen.push(now.phase));
  assert.deepEqual(seen, ['running', 'booted']); assert.equal(final.url, 'http://127.0.0.1:8080'); assert.deepEqual(calls, ['launch']);
  const silent: ToolRunner = async (_script, args) => {calls.push(args[0]); return {code: 2, stdout: args[0] === 'status' ? report('needs-attention', {stoppedAt: 'Preparing it', reason: 'r'}) : ''};};
  assert.equal((await new PlanetBoot('/t', '/r', silent).launch(plan, () => undefined)).stoppedAt, 'Preparing it');
  assert.deepEqual(calls.slice(1), ['launch', 'status'], 'One launch, then a read of the record');
});

test('known planets are listed only from well-formed rows, and a restart reports the tool’s lines', async () => {
  const calls: (readonly string[])[] = [];
  const tool: ToolRunner = async (_script, args, onLine) => {
    calls.push(args);
    if (args[0] === 'ships') return {code: 0, stdout: JSON.stringify([{ship: '~sampel-palnet', httpPort: 8081, running: false, pier: '/secret/path'}, {ship: 'bad', httpPort: 1, running: true}, {ship: '~other-planet', httpPort: '8082', running: false}, null])};
    for (const line of [report('running'), report('booted', {url: 'http://127.0.0.1:8081'})]) onLine?.(line);
    return {code: 0, stdout: ''};
  };
  const boot = new PlanetBoot('/t', '/r', tool);
  assert.deepEqual(await boot.ships(), [{ship: '~sampel-palnet', httpPort: 8081, running: false}], 'Only validated fields of valid rows');
  const seen: string[] = [];
  assert.equal((await boot.restart('~sampel-palnet', now => seen.push(now.phase))).url, 'http://127.0.0.1:8081');
  assert.deepEqual(seen, ['running', 'booted']); assert.deepEqual(calls.at(-1), ['restart', '--ship', '~sampel-palnet', '--root', '/r']);
  await assert.rejects(boot.restart('not a ship', () => undefined), /not one Readymade set up/);
  const silent: ToolRunner = async () => ({code: 2, stdout: ''});
  await assert.rejects(new PlanetBoot('/t', '/r', silent).restart('~sampel-palnet', () => undefined), /not started a second time/);
  assert.deepEqual(await new PlanetBoot('/t', '/r', async () => ({code: 0, stdout: 'not json'})).ships(), []);
});
