'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {cord: nt} = require('../backend/install/inspect-spider.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const tup = (...v) => v.slice(0, -1).reduceRight((t, h) => [h, t], v.at(-1));
const lst = (...v) => v.reduceRight((t, h) => [h, t], 0n);
function frame(noun) {
  const bits = [];
  const put = (n, width) => {if (!width) return; const s = n.toString(2).padStart(width, '0'); for (let i = width - 1; i >= 0; i--) bits.push(Number(s[i]));};
  const mat = n => {
    if (n === 0n) {bits.push(1); return;}
    const size = n.toString(2).length, width = size.toString(2).length;
    bits.push(...Array(width).fill(0), 1); put(BigInt(size) & ((1n << BigInt(width - 1)) - 1n), width - 1); put(n, size);
  };
  const write = n => {if (Array.isArray(n)) {bits.push(1, 0); write(n[0]); write(n[1]);} else {bits.push(0); mat(n);}};
  write(noun); const data = Buffer.alloc(Math.ceil(bits.length / 8)); bits.forEach((b, i) => {data[i >> 3] |= b << (i % 8);});
  const header = Buffer.alloc(5); header.writeUInt32LE(data.length, 1); return Buffer.concat([header, data]);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'compile-evidence-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const install = path.join(root, 'backend/install'), source = path.join(root, 'bundle/desk');
  function write(file, value) {fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700}); fs.writeFileSync(file, value, {mode: 0o600});}
  const json = (file, value) => write(file, JSON.stringify(value));
  const scripts = ['prepare-activation.cjs', 'prepare-activation.py', 'snapshot.hoon', 'activate.hoon', 'post-install.hoon', 'verify-compilation.cjs', 'inspect-spider.cjs', 'install-local.cjs', 'install-state.cjs', 'verify-operation.py', 'compare-snapshots.py', 'stage-files.py', 'run-native.cjs', 'compile-app.hoon', 'receiver-check.hoon', 'stage.hoon', 'prepare-compilation.py', 'prepare-verification.py', 'prepare-operation.py'];
  for (const name of scripts) write(path.join(install, name), fs.readFileSync(path.join(__dirname, '../backend/install', name)));
  const apps = ['graf', 'cantrip', 'viki', 'cli-inference', 'multiplayer-runtime', 'readymade-collab', 'native-coding-source-import', 'pataphor-native-console', 'pataphor-page', 'readymade-editing'];
  const threads = ['ph-native-coding-candidate', 'ph-native-coding-deployment', 'ph-pataphor-project-preview', 'ph-native-coding-worker-export', 'ph-native-coding-worker-tool-export', 'ph-native-coding-worker-tool-export-v3'];
  const content = {'desk.bill': '~[' + apps.map(a => '%' + a).join(' ') + ']\n', 'sys.kelvin': '[%zuse 408]\n', 'mar/noun.hoon': '|=  a=*  a\n', 'mar/json.hoon': '|=  a=*  a\n', 'ted/ph/readymade-install-preflight.hoon': ':: fixture source, never executed\n'};
  content['mar/foo-bar.hoon'] = '|=  a=*  a\n'; content['mar/foo/bar.hoon'] = '|=  a=*  a\n';
  for (const app of apps) content['app/' + app + '.hoon'] = ':: fixture app, never compiled\n';
  for (const thread of threads) content['ted/ph/' + thread.slice(3) + '.hoon'] = ':: fixture thread\n';
  const manifest = {schema: 'readymade-backend-assembly-v1', files: Object.fromEntries(Object.entries(content).map(([name, value]) => [name, {sha256: sha(value), bytes: Buffer.byteLength(value)}]))};
  for (const [name, value] of Object.entries(content)) write(path.join(source, name), value);
  const manifestPath = path.join(install, '../assembly-manifest.json'); json(manifestPath, manifest);
  const api = require(path.join(install, 'verify-compilation.cjs'));
  const plan = {schema: 'readymade-local-install-v1', ship: '~zod', desk: 'readymade', bundle: path.join(root, 'bundle'), pier: path.join(root, 'pier'), vere: path.join(root, 'vere'), runtimeSHA256: sha('runtime'), bundleManifestSHA256: sha(fs.readFileSync(manifestPath)), toolchainSHA256: require(path.join(install, 'install-local.cjs')).toolchainDigest(), steps: ['receiver', 'create', 'mount', 'stage', 'commit', 'verify']};
  write(plan.vere, 'runtime'); write(path.join(root, 'node'), 'node'); write(path.join(root, 'python'), 'python');
  const host = {executable: plan.vere, executableSHA256: plan.runtimeSHA256, node: path.join(root, 'node'), nodeSHA256: sha('node'), python: path.join(root, 'python'), pythonSHA256: sha('python')}; plan.hostBindingSHA256 = sha(JSON.stringify(host));
  const generated = api.reconstruct(source, plan.ship, plan.desk, 2), compilation = path.join(root, 'checks'), receipts = {}, payloads = {};
  json(path.join(compilation, 'packet.json'), generated.packet);
  function receipt(directory, original, payload) {
    const guarded = `=/  readymade-transport  (strand ,vase)\n;<  readymade-bowl=bowl  bind:readymade-transport  get-bowl\n?>  &(=(~zod our.readymade-bowl) =(our.readymade-bowl src.readymade-bowl))\n${original}`;
    json(path.join(directory, 'plan.json'), {ship: plan.ship, pier: plan.pier, vere: plan.vere, vereSHA256: plan.runtimeSHA256, operation: 'strand', sourceSHA256: sha(original)});
    write(path.join(directory, 'source.hoon'), guarded);
    const request = frame(tup(0n, nt('fyrd'), nt('base'), nt('khan-eval'), nt('noun'), nt('ted-eval'), nt(guarded)));
    write(path.join(directory, 'request.newt'), request); json(path.join(directory, 'submitted.json'), {requestSHA256: sha(request)});
    response(directory, payload);
  }
  function response(directory, payload) {
    const raw = frame(tup(0n, nt('avow'), 0n, nt('noun'), payload)); write(path.join(directory, 'response.newt'), raw);
    json(path.join(directory, 'result.json'), {status: 'native-success', executionSuccess: true, lockRetained: false, responseSHA256: sha(raw)});
  }
  function operation(kind, payload) {
    const packet = path.join(root, kind, 'packet'), directory = path.join(root, kind, 'receipt'), template = kind === 'receiver' ? 'receiver-check.hoon' : 'stage.hoon', body = fs.readFileSync(path.join(install, template));
    const original = `=/  arg=vase  !>([~zod %readymade${kind === 'observe' ? ' %observe 0' : ''}])\n` + body;
    json(path.join(packet, 'packet.json'), {schema: 'readymade-prepared-operation-v1', ship: '~zod', desk: 'readymade', operation: kind, revision: null, mutating: false, executed: false, source: 'operation.hoon', sourceSHA256: sha(original), template, templateSHA256: sha(body), assemblyManifestSHA256: plan.bundleManifestSHA256});
    write(path.join(packet, 'operation.hoon'), original); receipt(directory, original, payload); return {packet, receipt: directory};
  }
  const receiver = operation('receiver', tup(nt('readymade-receiver-check-v2'), 0n, nt('readymade'), 0n, 0n, 0n, 1n, 1n, 0n, 0n));
  const observation = operation('observe', tup(nt('readymade-stage-observed-v1'), 0n, nt('readymade'), tup(0n, 2n, nt('dead'), 0n, [0n, 123n])));
  for (const [name, original] of Object.entries(generated.files)) {
    write(path.join(compilation, name), original); const directory = path.join(root, 'receipts', name); receipts[name] = directory;
    let payload;
    if (name === '00-source.hoon') payload = tup(nt('readymade-complete-source-verified-v1'), 0n, nt('readymade'), 2n, BigInt(generated.paths), BigInt(generated.pins));
    else if (name === '10-marks.hoon') payload = tup(nt('readymade-mark-graphs-v1'), 0n, nt('readymade'), 2n, BigInt(generated.marks.length), lst(...generated.marks.map(n => [nt(n), 1n])));
    else if (name === '11-runtime.hoon') payload = tup(nt('readymade-install-runtime-preflight-v1'), tup(0n, nt('readymade'), nt('ud'), 2n), 0n, 0n, lst(...threads.map(n => tup(nt(n), [0n, lst(nt('ted'), nt('ph'), nt(n.slice(3)), nt('hoon'))], 0n))));
    else payload = tup(nt('readymade-app-compiled-v1'), 0n, nt('readymade'), 2n, nt(name.slice(7, -5)));
    payloads[name] = payload; receipt(directory, original, payload);
  }
  return {api, options: {compilation, receipts, receiver, observation, source, plan, host}, generated, payloads, response, receipt, json, write, install, root};
}
test('qualifies all13 Newt-format fixtures, not source preparation alone or activation authority', t => {
  const f = fixture(t), q = f.api.qualify(f.options);
  assert.equal(q.apps.length, 10); assert.equal(q.runtimeThreads.length, 6); assert.equal(q.kernel, 408);
  assert.equal(q.activationAuthorized, false); assert.equal(q.currentReadinessVerified, false);
  assert.equal(q.root, '7b'.padStart(64, '0')); assert.equal(q.digest.length, 64);
  for (const directory of Object.values(f.options.receipts)) for (const name of ['plan.json', 'source.hoon', 'request.newt', 'submitted.json', 'response.newt', 'result.json']) assert.ok(q.artifactPins[path.join(directory, name)]);
});
test('successful native envelope with false runtime readiness or unresolved thread refuses', t => {
  const f = fixture(t), file = f.options.receipts['11-runtime.hoon'], p = f.payloads['11-runtime.hoon'];
  const original = fs.readFileSync(path.join(file, 'response.newt'));
  // Tail after tag/beak contains ready/bounded/rows; changing ready must not be accepted.
  const bad = structuredClone(p); bad[1][1][0] = 1n; f.response(file, bad);
  assert.throws(() => f.api.qualify(f.options), /Runtime not ready/);
  f.write(path.join(file, 'response.newt'), original); f.response(file, p);
  const unresolved = structuredClone(p); unresolved[1][1][1][1][0][1][0] = 0n;
  f.response(file, unresolved); assert.throws(() => f.api.qualify(f.options));
});
test('missing or duplicate app receipts and wrong app owner/revision are rejected', t => {
  const f = fixture(t), receipts = f.options.receipts, name = '01-app-graf.hoon';
  const missing = {...receipts}; delete missing[name];
  assert.throws(() => f.api.qualify({...f.options, receipts: missing}), /Missing or duplicate/);
  assert.throws(() => f.api.qualify({...f.options, receipts: {...receipts, [name]: receipts['02-app-cantrip.hoon']}}), /Missing or duplicate/);
  for (const [owner, revision, app] of [[1n, 2n, 'graf'], [0n, 3n, 'graf'], [0n, 2n, 'cantrip']]) {
    f.response(receipts[name], tup(nt('readymade-app-compiled-v1'), owner, nt('readymade'), revision, nt(app)));
    assert.throws(() => f.api.qualify(f.options), /App compilation/);
  }
});
test('source, runner binary, encoded request, response and submitted hashes cannot be substituted', t => {
  const f = fixture(t), dir = f.options.receipts['01-app-graf.hoon'];
  for (const name of ['source.hoon', 'request.newt', 'response.newt', 'submitted.json']) {
    const file = path.join(dir, name), saved = fs.readFileSync(file);
    f.write(file, name.endsWith('.json') ? '{"requestSHA256":"bad"}' : Buffer.concat([saved, Buffer.from('x')]));
    assert.throws(() => f.api.qualify(f.options)); f.write(file, saved);
  }
  const file = path.join(dir, 'plan.json'), saved = fs.readFileSync(file), run = JSON.parse(saved);
  f.json(file, {...run, vereSHA256: 'd'.repeat(64)}); assert.throws(() => f.api.qualify(f.options), /Runner plan/); f.write(file, saved);
  f.write(f.options.plan.vere, 'changed binary'); assert.throws(() => f.api.qualify(f.options), /Executable/);
});
test('self-consistent changed preparation, false receiver kernel and wrong observed root are refused', t => {
  const f = fixture(t), file = path.join(f.options.compilation, 'packet.json'), original = fs.readFileSync(file), packet = JSON.parse(original);
  const changed = f.generated.files['01-app-graf.hoon'] + ':: different\n';
  f.write(path.join(f.options.compilation, '01-app-graf.hoon'), changed); packet.files['01-app-graf.hoon'] = sha(changed); f.json(file, packet);
  assert.throws(() => f.api.qualify(f.options), /not current preparation/);
  f.write(file, original); f.write(path.join(f.options.compilation, '01-app-graf.hoon'), f.generated.files['01-app-graf.hoon']);
  f.response(f.options.receiver.receipt, tup(nt('readymade-receiver-check-v2'), 0n, nt('readymade'), 0n, 1n, 0n, 1n, 1n, 0n, 0n));
  assert.throws(() => f.api.qualify(f.options), /Receiver not eligible/);
  f.response(f.options.receiver.receipt, tup(nt('readymade-receiver-check-v2'), 0n, nt('readymade'), 0n, 0n, 0n, 1n, 1n, 0n, 0n));
  f.response(f.options.observation.receipt, tup(nt('readymade-stage-observed-v1'), 0n, nt('readymade'), tup(0n, 2n, nt('dead'), 0n, [0n, 0n])));
  assert.throws(() => f.api.qualify(f.options), /Inactive revision/);
});
test('duplicate marks, wrong source counts and a false bounded-evaluation flag cannot qualify', t => {
  const f = fixture(t), receipts = f.options.receipts;
  f.response(receipts['10-marks.hoon'], tup(nt('readymade-mark-graphs-v1'), 0n, nt('readymade'), 2n, BigInt(f.generated.marks.length), lst(...f.generated.marks.map(() => [nt('json'), 1n]))));
  assert.throws(() => f.api.qualify(f.options), /Mark names differ/);
  f.response(receipts['10-marks.hoon'], f.payloads['10-marks.hoon']);
  f.response(receipts['00-source.hoon'], tup(nt('readymade-complete-source-verified-v1'), 0n, nt('readymade'), 2n, 0n, BigInt(f.generated.pins)));
  assert.throws(() => f.api.qualify(f.options), /Source verification differs/);
  f.response(receipts['00-source.hoon'], f.payloads['00-source.hoon']);
  const runtime = structuredClone(f.payloads['11-runtime.hoon']); runtime[1][1][1][0] = 1n;
  f.response(receipts['11-runtime.hoon'], runtime);
  assert.throws(() => f.api.qualify(f.options), /Runtime not ready/);
});
test('changed staging toolchain, extra plan authority and public receipt permissions fail closed', t => {
  const f = fixture(t);
  assert.throws(() => f.api.qualify({...f.options, plan: {...f.options.plan, toolchainSHA256: 'a'.repeat(64)}}), /toolchain differs/);
  assert.throws(() => f.api.qualify({...f.options, plan: {...f.options.plan, activate: true}}), /plan schema/);
  const receipt = path.join(f.options.receipts['01-app-graf.hoon'], 'response.newt');
  fs.chmodSync(receipt, 0o644); assert.throws(() => f.api.qualify(f.options), /private and owned/);
  fs.chmodSync(receipt, 0o600);
  fs.appendFileSync(path.join(f.install, 'stage-files.py'), '\n# altered\n');
  assert.throws(() => f.api.qualify(f.options), /toolchain differs/);
});
async function activationFixture(t) {
  const f = fixture(t), {plan, host, receiver, observation, compilation, receipts} = f.options;
  host.python = fs.realpathSync(require('node:child_process').execFileSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], {encoding: 'utf8'}).trim());
  host.pythonSHA256 = sha(fs.readFileSync(host.python)); plan.hostBindingSHA256 = sha(JSON.stringify(host));
  const state = path.join(f.root, 'state'), j = require(path.join(f.install, 'install-state.cjs'));
  j.createState(state, plan); f.json(state + '-host.json', host);
  const ev = file => ({path: file, sha256: sha(fs.readFileSync(file))});
  const operationFiles = op => [path.join(op.packet, 'packet.json'), path.join(op.packet, 'operation.hoon'), ...['plan.json', 'source.hoon', 'request.newt', 'submitted.json', 'response.newt', 'result.json'].map(n => path.join(op.receipt, n))].map(ev);
  await j.withRunLock(state, async () => {
    for (const step of plan.steps) {
      j.startStep(state, step, {});
      j.finishStep(state, step, {status: 'success', evidence: step === 'receiver' ? operationFiles(receiver) : step === 'commit' ? operationFiles(observation) : [ev(path.join(compilation, 'packet.json'))]});
    }
  });
  const baseline = path.join(f.root, 'baseline'), snapshot = fs.readFileSync(path.join(f.install, 'snapshot.hoon'), 'utf8');
  const baselinePayload = tup(nt('readymade-observed-install-snapshot-v1'), nt('fixture-observer'), tup(nt('readymade-private-install-snapshot-v1'), 1n, 0n, nt('readymade'), 2n, nt('dead'), 123n, lst(tup(nt('hood'), 1n, nt('base'), 0n, [20n, 0n])), 0n, 0n));
  f.receipt(baseline, '=/  arg=vase  !>([~zod %readymade 2])\n' + snapshot, baselinePayload);
  return {...f, prepare: require(path.join(f.install, 'prepare-activation.cjs')).prepare, wrapper: {state, compilation, receipts, baseline, output: path.join(f.root, 'activation')}, baselinePayload};
}
test('activation wrapper uses completed journal and exact baseline app count with real offline preparer', async t => {
  const f = await activationFixture(t), result = f.prepare(f.wrapper);
  assert.equal(result.existingApps, 1); assert.equal(result.nativeDispatch, false); assert.equal(result.activationAuthorized, false);
  assert.equal(result.currentReadinessVerified, false);
  const packet = JSON.parse(fs.readFileSync(path.join(result.packet, 'packet.json')));
  assert.equal(packet.existingApps, 1); assert.equal(packet.root, '7b'.padStart(64, '0'));
  assert.match(fs.readFileSync(path.join(result.packet, '02-post-install.hoon'), 'utf8'), /~zod %readymade 2 0x7b 1/);
  for (const name of fs.readdirSync(result.packet)) assert.equal(fs.statSync(path.join(result.packet, name)).mode & 0o777, 0o600);
  assert.throws(() => f.prepare(f.wrapper), /Output already exists/);
});
test('activation refuses held journal, caller counts, wrong baseline owner and duplicate apps before output', async t => {
  const f = await activationFixture(t);
  assert.throws(() => f.prepare({...f.wrapper, existingApps: 999}), /Unexpected preparation/);
  f.write(path.join(f.wrapper.state, 'run.lock'), JSON.stringify({digest: 'bad', token: 'bad'}) + '\n');
  assert.throws(() => f.prepare(f.wrapper)); fs.unlinkSync(path.join(f.wrapper.state, 'run.lock'));
  const wrong = structuredClone(f.baselinePayload); wrong[1][1][1][1][0] = 7n;
  f.response(f.wrapper.baseline, wrong); assert.throws(() => f.prepare(f.wrapper), /Baseline identity/);
  const duplicate = structuredClone(f.baselinePayload), inner = duplicate[1][1];
  // Seventh tail reaches the apps field of the ten-field private snapshot.
  let tail = inner; for (let i = 0; i < 7; i++) tail = tail[1];
  tail[0] = lst(tup(nt('hood'), 1n, nt('base'), 0n, [20n, 0n]), tup(nt('hood'), 2n, nt('base'), 0n, [20n, 0n]));
  f.response(f.wrapper.baseline, duplicate); assert.throws(() => f.prepare(f.wrapper), /inventory collision/);
  assert.equal(fs.existsSync(f.wrapper.output), false);
});
