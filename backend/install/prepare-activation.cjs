'use strict';
// Prepare an activation packet from verified retained evidence. Never dispatch.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {isDeepStrictEqual: equal} = require('node:util');
const journal = require('./install-state.cjs');
const {qualify} = require('./verify-compilation.cjs');
const {cue, tuple, list, text, cord} = require('./inspect-spider.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const need = (ok, message) => {if (!ok) throw Error(message);};
const ud = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
function safe(file) {
  need(typeof file === 'string' && path.isAbsolute(file) && path.normalize(file) === file && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(file), 'Unsafe path');
  for (let p = file;; p = path.dirname(p)) {need(!fs.lstatSync(p).isSymbolicLink(), 'Linked input'); if (p === path.dirname(p)) break;}
}
function privatePath(file, directory = false) {
  safe(file); const s = fs.lstatSync(file);
  need(s.uid === process.getuid() && (s.mode & 0o777) === (directory ? 0o700 : 0o600) && (directory ? s.isDirectory() : s.isFile() && s.nlink === 1), 'Private owned input required');
}
function prepare(options) {
  need(equal(Object.keys(options).sort(), ['state', 'compilation', 'receipts', 'baseline', 'output'].sort()), 'Unexpected preparation options');
  const {state, compilation, receipts, baseline, output} = options;
  for (const dir of [state, compilation, baseline, ...Object.values(receipts)]) privatePath(dir, true);
  need(typeof output === 'string' && path.isAbsolute(output) && path.normalize(output) === output && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(output), 'Invalid output path');
  privatePath(path.dirname(output), true);
  need(!fs.existsSync(output) && !fs.lstatSync(path.dirname(output)).isSymbolicLink(), 'Output already exists');
  const pins = {}, read = (file, privacy = false) => {
    safe(file); if (privacy) privatePath(file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const s = fs.fstatSync(fd); need(s.isFile() && s.nlink === 1 && [0, process.getuid()].includes(s.uid) && s.size <= 256 * 1024 * 1024, 'Invalid input file');
      const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
      need(s.size === bytes.length && s.mtimeMs === after.mtimeMs && s.ctimeMs === after.ctimeMs, 'Input changed during read');
      const digest = sha(bytes); need(!pins[file] || pins[file] === digest, 'Input changed'); pins[file] = digest; return bytes;
    } finally {fs.closeSync(fd);}
  }, json = file => JSON.parse(read(file, true));
  const staged = journal.inspectState(state), plan = staged.plan;
  need(!staged.blocked && !staged.inFlight && !staged.nextStep && staged.steps.length === 6 && staged.steps.every(row => row.outcome?.status === 'success') && !fs.existsSync(path.join(state, 'run.lock')), 'Staging is incomplete or held');
  for (const name of fs.readdirSync(state)) read(path.join(state, name), true);
  const host = json(state + '-host.json');
  need(sha(JSON.stringify(host)) === plan.hostBindingSHA256, 'Host sidecar differs');
  const derive = (step, kind) => {
    const evidence = staged.steps.find(row => row.step === step).outcome.evidence;
    const files = new Set(evidence.map(row => row.path)), packets = evidence.filter(row => path.basename(row.path) === 'packet.json').map(row => ({file: row.path, value: json(row.path)})).filter(row => row.value.schema === 'readymade-prepared-operation-v1' && row.value.operation === kind);
    need(packets.length === 1, 'Missing or ambiguous staged observation');
    const packet = path.dirname(packets[0].file); privatePath(packet, true);
    need(files.has(path.join(packet, 'operation.hoon')), 'Staged source evidence missing');
    const runs = evidence.filter(row => path.basename(row.path) === 'plan.json').map(row => ({dir: path.dirname(row.path), value: json(row.path)})).filter(row => row.value.operation === 'strand' && row.value.sourceSHA256 === packets[0].value.sourceSHA256);
    need(runs.length === 1, 'Missing or ambiguous staged runner');
    for (const name of ['plan.json', 'source.hoon', 'request.newt', 'submitted.json', 'response.newt', 'result.json']) need(files.has(path.join(runs[0].dir, name)), 'Incomplete staged raw evidence');
    return {packet, receipt: runs[0].dir};
  };
  const args = {compilation, receipts, receiver: derive('receiver', 'receiver'), observation: derive('commit', 'observe'), source: path.join(plan.bundle, 'desk'), plan, host};
  const qualified = qualify(args); need(qualified.planDigest === staged.digest, 'Staged plan differs');
  const snapshot = read(path.join(__dirname, 'snapshot.hoon')).toString();
  const original = `=/  arg=vase  !>([${plan.ship} %${plan.desk} ${ud(qualified.revision)}])\n` + snapshot;
  const run = json(path.join(baseline, 'plan.json'));
  need(run.ship === plan.ship && run.pier === plan.pier && run.vere === plan.vere && run.vereSHA256 === plan.runtimeSHA256 && run.operation === 'strand' && run.sourceSHA256 === sha(original), 'Baseline runner differs');
  const guarded = `=/  readymade-transport  (strand ,vase)\n;<  readymade-bowl=bowl  bind:readymade-transport  get-bowl\n?>  &(=(${plan.ship} our.readymade-bowl) =(our.readymade-bowl src.readymade-bowl))\n${original}`;
  need(read(path.join(baseline, 'source.hoon'), true).equals(Buffer.from(guarded)), 'Baseline source differs');
  const request = read(path.join(baseline, 'request.newt'), true);
  need(equal(tuple(cue(request), 7), [0n, cord('fyrd'), cord('base'), cord('khan-eval'), cord('noun'), cord('ted-eval'), cord(guarded)]), 'Baseline request differs');
  need(json(path.join(baseline, 'submitted.json')).requestSHA256 === sha(request), 'Baseline submission differs');
  const frame = read(path.join(baseline, 'response.newt'), true), result = json(path.join(baseline, 'result.json'));
  need(result.status === 'native-success' && result.executionSuccess === true && result.lockRetained === false && result.responseSHA256 === sha(frame), 'Baseline success missing');
  const [id, kind, outcome, mark, payload] = tuple(cue(frame), 5);
  need(id === 0n && kind === cord('avow') && outcome === 0n && mark === cord('noun'), 'Baseline execution failed');
  const [tag, tid, body] = tuple(payload, 3), [inner, now, owner, desk, revision, life, root, apps, domes, bindings] = tuple(body, 10);
  need(tag === cord('readymade-observed-install-snapshot-v1') && text(tid).length > 0 && inner === cord('readymade-private-install-snapshot-v1') && typeof now === 'bigint' && now > 0n && owner === BigInt(qualified.ownerAtom) && desk === cord(plan.desk) && revision === BigInt(qualified.revision) && life === cord('dead') && root === BigInt('0x' + qualified.root), 'Baseline identity/source differs');
  need(domes === 0n || Array.isArray(domes), 'Invalid baseline domes'); list(bindings, 100000);
  const names = list(apps, 10000).map(row => {
    const [name, nonce, owningDesk, live, egg] = tuple(row, 5);
    need(/^[a-z][a-z0-9-]*(?![\s\S])/.test(text(name)) && typeof nonce === 'bigint' && nonce >= 0n && text(owningDesk).length > 0 && live === 0n && Array.isArray(egg), 'Malformed or stopped baseline app'); return text(name);
  });
  need(names.length > 0 && new Set(names).size === names.length && !names.some(name => qualified.apps.includes(name)), 'Baseline app inventory collision');
  const helper = path.join(__dirname, 'prepare-activation.py'), helperBytes = read(helper), activation = read(path.join(__dirname, 'activate.hoon')).toString(), post = read(path.join(__dirname, 'post-install.hoon')).toString();
  read(__filename); read(host.python);
  const nativeRoot = '0x' + (qualified.root.replace(/^0+/, '') || '0').replace(/\B(?=(.{4})+(?!.))/g, '.');
  const expectedFiles = {
    '00-preflight.hoon': `=/  arg=vase  !>([${plan.ship} %${plan.desk} ${ud(qualified.revision)} ${nativeRoot} %.n])\n` + activation,
    '01-activate.hoon': `=/  arg=vase  !>([${plan.ship} %${plan.desk} ${ud(qualified.revision)} ${nativeRoot} %.y])\n` + activation,
    '02-post-install.hoon': `=/  arg=vase  !>([${plan.ship} %${plan.desk} ${ud(qualified.revision)} ${nativeRoot} ${ud(names.length)}])\n` + post,
    '03-snapshot.hoon': original,
  };
  fs.mkdirSync(output, {mode: 0o700});
  const save = (name, value) => {const fd = fs.openSync(path.join(output, name), 'wx', 0o600); try {fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}};
  save('compilation-qualified.json', qualified);
  save('preparation-intent.json', {schema: 'readymade-activation-preparation-intent-v1', planDigest: staged.digest, compilationDigest: qualified.digest, baselineSHA256: sha(frame), helperSHA256: sha(helperBytes), artifactPins: pins, nativeDispatch: false});
  const packetDir = path.join(output, 'packet'), log = fs.openSync(path.join(output, 'prepare.log'), 'wx', 0o600);
  let child;
  try {child = spawnSync(host.python, ['-I', '-B', helper, '--checks', compilation, '--root', qualified.root, '--existing-apps', String(names.length), '--output', packetDir], {stdio: ['ignore', log, log], env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}, timeout: 120000});}
  finally {fs.fsyncSync(log); fs.closeSync(log);}
  need(child.status === 0 && !child.error && !child.signal, 'Offline preparation failed; inspect private log');
  privatePath(packetDir, true);
  need(equal(fs.readdirSync(packetDir).sort(), [...Object.keys(expectedFiles), 'packet.json'].sort()), 'Prepared output inventory differs');
  const expectedPacket = {schema: 'readymade-backend-activation-packet-v2', appSet: 'readymade-backend-ten-apps-v2', apps: qualified.apps,
    routes: ['/graf', '/apps/qpc-ark', '/apps/pataphor-cli', '/apps/readymade-collab', '/apps/pataphor-native', '/apps/pataphor', '/apps/readymade-editing'],
    scope: 'Prepared only; compilation success and owner authorization required before execution', ship: plan.ship, desk: plan.desk, revision: qualified.revision, root: qualified.root, existingApps: names.length,
    compilationPacketSHA256: qualified.compilationPacketSHA256, templateSHA256: sha(activation), postInstallTemplateSHA256: sha(post), snapshotTemplateSHA256: sha(snapshot), files: Object.fromEntries(Object.entries(expectedFiles).map(([name, value]) => [name, sha(value)]))};
  for (const name of fs.readdirSync(packetDir)) {
    const file = path.join(packetDir, name); safe(file); need(fs.lstatSync(file).isFile() && fs.lstatSync(file).nlink === 1, 'Unsafe prepared output'); fs.chmodSync(file, 0o600);
    if (name !== 'packet.json') need(read(file, true).equals(Buffer.from(expectedFiles[name])), 'Prepared source differs');
  }
  need(equal(json(path.join(packetDir, 'packet.json')), expectedPacket), 'Prepared activation packet differs');
  need(equal(journal.inspectState(state), staged) && !fs.existsSync(path.join(state, 'run.lock')) && equal(qualify(args), qualified), 'Evidence changed during preparation');
  for (const [file, digest] of Object.entries(pins)) need(sha(read(file)) === digest, 'Bound artifact changed');
  const prepared = {schema: 'readymade-qualified-activation-preparation-v1', packet: packetDir, planDigest: staged.digest, compilationDigest: qualified.digest, baselineSHA256: sha(frame), existingApps: names.length, observer: text(tid), artifactPins: {...qualified.artifactPins, ...pins}, activationAuthorized: false, currentReadinessVerified: false, nativeDispatch: false};
  save('prepared.json', prepared);
  const fd = fs.openSync(output, 'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  return prepared;
}
module.exports = {prepare};
