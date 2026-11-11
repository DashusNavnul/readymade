import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {BackendInstall, BackendInstallError, locateInstaller, parseReport, runTool, type HostProbes, type ToolRunner} from '../src/backend-install';

const digest = 'a'.repeat(64);
const report = (phase = 'running', extra: Record<string, unknown> = {}) => JSON.stringify({phase, ready: false, items: [
  {id: 'stage:receiver', label: 'Checking your ship', status: 'done'}, {id: 'compile:03-app-viki', label: 'Building viki', status: 'running'}], ...extra});
function workspace(t: {after(fn: () => void): void}): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rm-backend-install-')); t.after(() => fs.rmSync(root, {recursive: true, force: true})); return root;
}
const probes = (overrides: Partial<HostProbes> = {}): HostProbes => ({executable: async () => '/verified/urbit', python: async () => undefined,
  command: async () => '/verified/urbit work --snap-dir /piers/sampel --runtime-config 128 --loom 33 --toss 0', ...overrides});
const target = {ship: '~sampel-palnet', pier: '/piers/sampel', workerPid: 4133};

test('a printed report is shown only when its whole shape is valid', () => {
  assert.deepEqual(parseReport(report())?.items.map(item => item.status), ['done', 'running']);
  assert.equal(parseReport(report('needs-attention', {stoppedAt: 'Building viki', reason: 'stopped before a result was recorded'}))?.stoppedAt, 'Building viki');
  for (const bad of ['', 'not json', '[]', 'null', report('finished'), JSON.stringify({phase: 'running', items: 'x'}),
    JSON.stringify({phase: 'running', items: [{id: 'a', label: 'b', status: 'ok'}]}),
    JSON.stringify({phase: 'running', items: [{id: 'a', label: 'line\nbreak', status: 'done'}]}),
    JSON.stringify({phase: 'running', items: [{id: 'a', label: 'b', status: 'done', reason: 7}]}),
    JSON.stringify({phase: 'running', items: Array(65).fill({id: 'a', label: 'b', status: 'done'})}),
    report('running', {stoppedAt: 9}), 'x'.repeat(65537)]) assert.equal(parseReport(bad), undefined, bad.slice(0, 40));
});

test('the installer is found only when the tools, manifest and bundle are all inside the extension', async t => {
  const root = workspace(t);
  assert.equal(await locateInstaller(root), undefined);
  fs.mkdirSync(path.join(root, 'backend/install'), {recursive: true}); fs.mkdirSync(path.join(root, 'backend/package/desk'), {recursive: true});
  for (const file of ['backend/install/install-all.cjs', 'backend/install/install-local.cjs', 'backend/package/assembly.json']) fs.writeFileSync(path.join(root, file), '');
  assert.equal(await locateInstaller(root), undefined, 'Missing manifest');
  fs.writeFileSync(path.join(root, 'backend/assembly-manifest.json'), '{}');
  assert.deepEqual(await locateInstaller(root), {tools: path.join(root, 'backend/install'), bundle: path.join(root, 'backend/package')});
});

test('planning asks the bundled tool once with the ship’s real runtime and retains the approved digest', async t => {
  const root = workspace(t), calls: {script: string; args: readonly string[]}[] = [];
  const tool: ToolRunner = async (script, args) => {calls.push({script, args}); return {code: 0, stdout: JSON.stringify({digest, plan: {ship: target.ship, pier: target.pier}}) + '\n'};};
  const install = new BackendInstall({tools: '/app/backend/install', bundle: '/app/backend/package'}, root, tool, probes());
  assert.equal(await install.retained(target.ship), undefined);
  const plan = await install.plan(target, 1700000000000);
  assert.equal(calls.length, 1); assert.equal(calls[0].script, '/app/backend/install/install-local.cjs');
  assert.deepEqual(calls[0].args, ['plan', '--state', path.join(root, 'installs/sampel-palnet-1700000000000'), '--ship', '~sampel-palnet', '--desk', 'readymade',
    '--pier', '/piers/sampel', '--vere', '/verified/urbit', '--bundle', '/app/backend/package']);
  assert.equal(plan.digest, digest); assert.equal(plan.output, plan.state + '-compile');
  assert.equal(fs.statSync(path.join(root, 'installs')).mode & 0o777, 0o700);
  assert.deepEqual(await install.retained(target.ship), plan);
  assert.equal(await install.retained('~other-planet'), undefined);
});

test('planning refuses in plain words before the ship is asked anything', async t => {
  const root = workspace(t); let calls = 0;
  const tool: ToolRunner = async () => {calls++; return {code: 1, stdout: ''};};
  const make = (overrides: Partial<HostProbes> = {}) => new BackendInstall({tools: '/t', bundle: '/b'}, root, tool, probes(overrides));
  await assert.rejects(make().plan({...target, ship: 'sampel-palnet'}), /could not be identified/);
  await assert.rejects(make({python: async () => {throw Error();}}).plan(target), /needs Python 3/);
  await assert.rejects(make({executable: async () => {throw Error();}}).plan(target), /no longer running/);
  await assert.rejects(make({command: async () => '/verified/urbit work --snap-dir /piers/sampel --loom 31'}).plan(target), /too little memory.*--loom 33/);
  await assert.rejects(make({command: async () => '/verified/urbit work --snap-dir /piers/sampel'}).plan(target), /too little memory/);
  await assert.rejects(make({command: async () => {throw Error();}}).plan(target), /no longer running/);
  assert.equal(calls, 0);
  await assert.rejects(make().plan(target), (error: unknown) => error instanceof BackendInstallError && /cannot be prepared/.test(error.message));
  assert.equal(calls, 1, 'A refused plan is not retried');
  // A plan printed for a different ship or pier is refused even with exit zero.
  const wrong: ToolRunner = async () => ({code: 0, stdout: JSON.stringify({digest, plan: {ship: '~other-planet', pier: target.pier}})});
  await assert.rejects(new BackendInstall({tools: '/t', bundle: '/b'}, root, wrong, probes()).plan(target), /cannot be prepared/);
  assert.equal(await make().retained(target.ship), undefined);
});

test('a run reports each valid line once, ignores noise, and ends on the tool’s last report', async t => {
  const root = workspace(t), seen: string[] = [], calls: (readonly string[])[] = [];
  const tool: ToolRunner = async (_script, args, onLine) => {
    calls.push(args);
    if (args[0] === 'status') return {code: 0, stdout: report('paused') + '\n'};
    for (const line of [report('running'), 'warning: noise', '{"phase":"bogus"}', report('activation-prepared')]) onLine?.(line);
    return {code: 0, stdout: ''};
  };
  const install = new BackendInstall({tools: '/t', bundle: '/b'}, root, tool, probes());
  const plan = {ship: target.ship, state: '/s', output: '/s-compile', digest, files: 0};
  const final = await install.run(plan, now => seen.push(now.phase));
  assert.deepEqual(seen, ['running', 'activation-prepared']); assert.equal(final.phase, 'activation-prepared');
  assert.deepEqual(calls[0], ['run', '--state', '/s', '--output', '/s-compile', '--approve', digest]);
  assert.equal((await install.status(plan)).phase, 'paused');
  // A run that printed nothing falls back to retained evidence rather than inventing a result.
  const silent: ToolRunner = async (_script, args) => ({code: 2, stdout: args[0] === 'status' ? report('needs-attention', {stoppedAt: 'Building viki', reason: 'r'}) : ''});
  assert.equal((await new BackendInstall({tools: '/t', bundle: '/b'}, root, silent, probes()).run(plan, () => undefined)).stoppedAt, 'Building viki');
});

test('the real tool runner starts a script with this runtime and delivers whole lines', async t => {
  const root = workspace(t), script = path.join(root, 'tool.cjs');
  fs.writeFileSync(script, 'process.stdout.write("one\\ntw"); setTimeout(() => {process.stdout.write("o\\n" + process.argv[2] + "\\n"); process.exitCode = 3;}, 20);');
  const lines: string[] = [];
  const result = await runTool(script, ['arg'], line => lines.push(line));
  assert.deepEqual(lines, ['one', 'two', 'arg']); assert.equal(result.code, 3);
});
