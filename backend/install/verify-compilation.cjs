'use strict';
// Offline evidence qualification only: no native connection, dispatch or lock changes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {isDeepStrictEqual: equal} = require('node:util');
const {cue, tuple, list, text, cord} = require('./inspect-spider.cjs');
const APPS = ['graf', 'cantrip', 'viki', 'cli-inference', 'multiplayer-runtime', 'readymade-collab', 'native-coding-source-import', 'pataphor-native-console', 'pataphor-page', 'readymade-editing'];
const THREADS = ['ph-native-coding-candidate', 'ph-native-coding-deployment', 'ph-pataphor-project-preview', 'ph-native-coding-worker-export', 'ph-native-coding-worker-tool-export', 'ph-native-coding-worker-tool-export-v3'];
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const need = (ok, message) => {if (!ok) throw Error(message);};
const hex = s => typeof s === 'string' && s.length === 64 && /^[a-f0-9]+$/.test(s);
const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v);
const ud = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const ux = b => '0x' + (Buffer.from(b).reverse().toString('hex').replace(/^0+/, '') || '0').replace(/\B(?=(.{4})+(?!.))/g, '.');
function safe(file) {
  need(typeof file === 'string' && path.isAbsolute(file) && path.normalize(file) === file && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(file), 'Unsafe path');
  for (let p = file;; p = path.dirname(p)) {need(!fs.lstatSync(p).isSymbolicLink(), 'Symlink refused'); if (p === path.dirname(p)) break;}
}
function reader(pins) {
  return (file, limit = 32 * 1024 * 1024) => {
    safe(file); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const s = fs.fstatSync(fd); need(s.isFile() && s.nlink === 1 && [0, process.getuid()].includes(s.uid) && s.size <= limit, 'Invalid evidence file');
      const b = fs.readFileSync(fd), after = fs.fstatSync(fd);
      need(s.size === b.length && s.mtimeMs === after.mtimeMs && s.ctimeMs === after.ctimeMs, 'Evidence changed during read');
      const digest = sha(b); need(!pins[file] || pins[file] === digest, 'Evidence changed between reads'); pins[file] = digest; return b;
    } finally {fs.closeSync(fd);}
  };
}
function fileNames(directory, prefix = '') {
  safe(directory); need(fs.statSync(directory).isDirectory(), 'Expected directory');
  return fs.readdirSync(directory).sort().flatMap(name => {
    const file = path.join(directory, name); safe(file);
    return fs.statSync(file).isDirectory() ? fileNames(file, prefix + name + '/') : [prefix + name];
  });
}
function reconstruct(source, ship, desk, revision, read = reader({})) {
  need(typeof ship === 'string' && /^~[a-z]+(?:-[a-z]+)*(?![\s\S])/.test(ship) && typeof desk === 'string' && /^[a-z]+(?:-[a-z0-9]+)*(?![\s\S])/.test(desk), 'Invalid target');
  need(Number.isSafeInteger(revision) && revision >= 2 && revision <= 2 ** 31, 'Invalid immutable revision');
  const manifestBytes = read(path.join(__dirname, '../assembly-manifest.json')), manifest = JSON.parse(manifestBytes);
  need(manifest.schema === 'readymade-backend-assembly-v1' && equal(fileNames(source).sort(), Object.keys(manifest.files).sort()), 'Source inventory differs');
  const paths = [], pins = [], wains = [], content = {}, marks = {};
  for (const name of Object.keys(manifest.files).sort()) {
    need(/^[a-z0-9.-]+(?:\/[a-z0-9.-]+)*\.[a-z0-9-]+(?![\s\S])/.test(name) && !name.split('/').some(p => p === '.' || p === '..'), 'Invalid source name');
    const pin = manifest.files[name], b = read(path.join(source, name));
    need(hex(pin.sha256) && sha(b) === pin.sha256 && b.length === pin.bytes, 'Source pin differs'); content[name] = b;
    const dot = name.lastIndexOf('.'), mark = name.slice(dot + 1);
    const p = '/' + [...name.slice(0, dot).split('/'), mark].map(v => /^[a-z0-9-]+$/.test(v) ? v : '(crip "' + v + '")').join('/');
    paths.push(p); const digest = ux(crypto.createHash('sha256').update(b).digest());
    if (['hoon', 'js', 'css', 'html'].includes(mark)) pins.push('[' + p + ' ' + digest + ']');
    else if (mark === 'txt') wains.push([p, digest]);
    else need(['desk.bill', 'sys.kelvin'].includes(name), 'Unsupported source mark');
    if (name.startsWith('mar/') && name.endsWith('.hoon')) {const markName = name.slice(4, -5).replaceAll('/', '-'); (marks[markName] ??= []).push(name);}
  }
  const bill = content['desk.bill'].toString().trim();
  need(bill === '~[' + APPS.map(a => '%' + a).join(' ') + ']' && content['sys.kelvin'].toString().trim() === '[%zuse 408]', 'Wrong bill/kernel');
  const rev = ud(revision), address = `/${ship}/${desk}/${rev}`;
  const lines = ['=/  m  (strand ,vase)', ';<  b=bowl  bind:m  get-bowl', `?>  &(=(${ship} our.b) =(our.b src.b))`,
    `=/  ds=cone:clay  .^(cone:clay %cx /${ship}//(scot %da now.b)/domes)`, `=/  d=dome:clay  (~(got by ds) [our.b %${desk}])`,
    `?>  &(=(${rev} let.d) =(%dead liv.d) =(~ wic.d))`, '=/  expected=(list path)  ~[' + paths.join(' ') + ']',
    `?>  =((silt expected) (silt .^((list path) %ct ${address})))`, '=/  pins=(list [p=path hash=@ux])  ~[' + pins.join(' ') + ']',
    `?>  (levy pins |=([p=path hash=@ux] =(hash (shax .^(@t %cx (weld ${address} p))))))`,
    ...wains.map(([p, h]) => `?>  =(${h} (shax (of-wain:format .^(wain %cx ${address}${p}))))`),
    `?>  =((cord-to-waft:clay '[%zuse 408]') .^(waft:clay %cx ${address}/sys/kelvin))`,
    `?>  =(${bill} .^((list @tas) %cx ${address}/desk/bill))`,
    `(pure:m !>([%readymade-complete-source-verified-v1 our.b %${desk} ${rev} (lent expected) (lent pins)]))`];
  const files = {'00-source.hoon': lines.join('\n') + '\n'}, appTemplate = read(path.join(__dirname, 'compile-app.hoon')).toString();
  APPS.forEach((app, i) => {files[`${String(i + 1).padStart(2, '0')}-app-${app}.hoon`] = `=/  arg=vase  !>([${ship} %${desk} ${rev} %${app}])\n` + appTemplate;});
  const prefix = lines.slice(0, 6).join('\n') + '\n', names = Object.keys(marks).sort();
  files['10-marks.hoon'] = prefix + ['=/  rows', '  %+  turn  `(list @tas)`~[' + names.map(n => '%' + n).join(' ') + ']',
    '  |=  name=@tas', `  =/  built=*  .^(* %cb ${address}/[name])`, '  [name (shax (jam built))]',
    `(pure:m !>([%readymade-mark-graphs-v1 our.b %${desk} ${rev} (lent rows) rows]))`, ''].join('\n');
  const diagnostic = 'ted/ph/readymade-install-preflight.hoon';
  files['11-runtime.hoon'] = prefix + [`?>  =(${ux(Buffer.from(manifest.files[diagnostic].sha256, 'hex'))} (shax .^(@t %cx ${address}/ted/ph/readymade-install-preflight/hoon)))`,
    ';<  built=vase  bind:m', `  (build-file-hard [[our.b %${desk} ud+${rev}] /ted/ph/readymade-install-preflight/hoon])`,
    ';<  actual=vase  bind:m', `  !<(form:m (slam built !>(!>([%${desk} ${rev}]))))`, '(pure:m actual)', ''].join('\n');
  const packet = {schema: 'readymade-native-compilation-packet-v1', scope: 'prepared checks, not execution or activation evidence', ship, desk, revision,
    assemblyManifestSHA256: sha(manifestBytes), apps: APPS, markNames: names.length,
    markAliases: Object.fromEntries(Object.entries(marks).filter(([, v]) => v.length > 1)), files: Object.fromEntries(Object.entries(files).map(([n, v]) => [n, sha(v)]))};
  return {files, packet, paths: paths.length, pins: pins.length, marks: names, markSources: marks};
}
function qualify(options) {
  const {compilation, receipts, receiver, observation, source, plan, host} = options;
  const artifactPins = {}, read = reader(artifactPins), json = f => JSON.parse(read(f, 4 * 1024 * 1024));
  need(plan?.schema === 'readymade-local-install-v1' && hex(plan.runtimeSHA256) && hex(plan.hostBindingSHA256) && hex(plan.toolchainSHA256), 'Invalid plan binding');
  need(equal(Object.keys(plan).sort(), ['schema', 'ship', 'desk', 'pier', 'vere', 'runtimeSHA256', 'bundle', 'bundleManifestSHA256', 'toolchainSHA256', 'hostBindingSHA256', 'steps'].sort()) && equal(plan.steps, ['receiver', 'create', 'mount', 'stage', 'commit', 'verify']) && hex(plan.bundleManifestSHA256), 'Invalid installation plan schema');
  need(!['base', 'noltbook-data', 'host-law', 'host-viki', 'hot-viki', 'glass-desktop-build'].includes(plan.desk), 'Protected installation desk');
  need(plan.toolchainSHA256 === require('./install-local.cjs').toolchainDigest(), 'Staging toolchain differs');
  need(typeof plan.bundle === 'string' && source === path.join(plan.bundle, 'desk'), 'Source is not approved bundle desk');
  need(host && sha(JSON.stringify(host)) === plan.hostBindingSHA256 && host.executable === plan.vere && host.executableSHA256 === plan.runtimeSHA256, 'Host binding differs');
  for (const [file, digest] of [[plan.vere, plan.runtimeSHA256], [host.node, host.nodeSHA256], [host.python, host.pythonSHA256]]) need(hex(digest) && sha(read(file, 256 * 1024 * 1024)) === digest, 'Executable binding differs');
  for (const name of ['verify-compilation.cjs', 'inspect-spider.cjs', 'install-local.cjs', 'install-state.cjs', 'verify-operation.py', 'compare-snapshots.py', 'stage-files.py', 'run-native.cjs', 'prepare-compilation.py', 'prepare-verification.py', 'prepare-operation.py']) read(path.join(__dirname, name));
  const packetBytes = read(path.join(compilation, 'packet.json')), packet = JSON.parse(packetBytes);
  need(packet.ship === plan.ship && packet.desk === plan.desk && packet.assemblyManifestSHA256 === plan.bundleManifestSHA256, 'Compilation target differs');
  const expected = reconstruct(source, plan.ship, plan.desk, packet.revision, read);
  need(equal(packet, expected.packet), 'Compilation packet is not current preparation');
  need(equal(Object.keys(receipts).sort(), Object.keys(expected.files).sort()) && new Set(Object.values(receipts)).size === Object.keys(expected.files).length, 'Missing or duplicate compilation receipts');
  const readResult = (directory, original) => {
    for (const name of ['', 'plan.json', 'source.hoon', 'request.newt', 'submitted.json', 'response.newt', 'result.json']) {
      const file = path.join(directory, name); safe(file); const stat = fs.lstatSync(file);
      need(stat.uid === process.getuid() && (stat.mode & 0o777) === (name ? 0o600 : 0o700) && (name ? stat.isFile() : stat.isDirectory()), 'Native receipt must be private and owned');
    }
    const run = json(path.join(directory, 'plan.json'));
    need(run.ship === plan.ship && run.pier === plan.pier && run.vere === plan.vere && run.vereSHA256 === plan.runtimeSHA256 && run.operation === 'strand' && run.sourceSHA256 === sha(original), 'Runner plan differs');
    const guarded = `=/  readymade-transport  (strand ,vase)\n;<  readymade-bowl=bowl  bind:readymade-transport  get-bowl\n?>  &(=(${plan.ship} our.readymade-bowl) =(our.readymade-bowl src.readymade-bowl))\n${original}`;
    need(read(path.join(directory, 'source.hoon')).equals(Buffer.from(guarded)), 'Guarded source differs');
    const request = read(path.join(directory, 'request.newt'));
    need(equal(tuple(cue(request), 7), [0n, cord('fyrd'), cord('base'), cord('khan-eval'), cord('noun'), cord('ted-eval'), cord(guarded)]), 'Encoded request differs');
    need(json(path.join(directory, 'submitted.json')).requestSHA256 === sha(request), 'Submitted request differs');
    const frame = read(path.join(directory, 'response.newt')), result = json(path.join(directory, 'result.json'));
    need(result.status === 'native-success' && result.executionSuccess === true && result.lockRetained === false && result.responseSHA256 === sha(frame), 'Successful response binding missing');
    const [id, kind, outcome, mark, payload] = tuple(cue(frame), 5);
    need(id === 0n && kind === cord('avow') && outcome === 0n && mark === cord('noun'), 'Native execution did not succeed'); return payload;
  };
  const operation = (entry, kind) => {
    const template = kind === 'receiver' ? 'receiver-check.hoon' : 'stage.hoon', body = read(path.join(__dirname, template));
    const original = `=/  arg=vase  !>([${plan.ship} %${plan.desk}${kind === 'observe' ? ' %observe 0' : ''}])\n` + body;
    const p = json(path.join(entry.packet, 'packet.json'));
    need(equal(p, {schema: 'readymade-prepared-operation-v1', ship: plan.ship, desk: plan.desk, operation: kind, revision: null, mutating: false, executed: false,
      source: 'operation.hoon', sourceSHA256: sha(original), template, templateSHA256: sha(body), assemblyManifestSHA256: plan.bundleManifestSHA256}), 'Observation preparation differs');
    need(read(path.join(entry.packet, 'operation.hoon')).equals(Buffer.from(original)), 'Observation source differs');
    return readResult(entry.receipt, original);
  };
  const [rt, owner, desk, eligible, kernel, bounded, present, override, appConflicts, routeConflicts] = tuple(operation(receiver, 'receiver'), 10);
  need(rt === cord('readymade-receiver-check-v2') && typeof owner === 'bigint' && owner >= 0n && desk === cord(plan.desk) && eligible === 0n && kernel === 0n && bounded === 0n && present === 1n && override === 1n && appConflicts === 0n && routeConflicts === 0n, 'Receiver not eligible');
  const [ot, oo, od, unit] = tuple(operation(observation, 'observe'), 4), [some, rev, life, idle, rootUnit] = tuple(unit, 5), [rootSome, root] = tuple(rootUnit, 2);
  need(ot === cord('readymade-stage-observed-v1') && oo === owner && od === desk && some === 0n && rev === BigInt(packet.revision) && life === cord('dead') && idle === 0n && rootSome === 0n && typeof root === 'bigint' && root > 0n && root < 2n ** 256n, 'Inactive revision/root differs');
  for (const [name, original] of Object.entries(expected.files)) {
    need(read(path.join(compilation, name)).equals(Buffer.from(original)), 'Prepared compilation source differs');
    const payload = readResult(receipts[name], original);
    if (name === '11-runtime.hoon') {
      const [tag, beak, ready, bounded, rows] = tuple(payload, 5), [ro, rd, mode, rn] = tuple(beak, 4);
      need(tag === cord('readymade-install-runtime-preflight-v1') && ro === owner && rd === desk && mode === cord('ud') && rn === rev && ready === 0n && bounded === 0n, 'Runtime not ready/bounded at revision');
      const actual = list(rows, 6).map(row => {
        const [name, resolved, compiled] = tuple(row, 3), [some, p] = tuple(resolved, 2);
        need(some === 0n && compiled === 0n, 'Runtime thread unresolved or not compiled');
        const parts = list(p, 32).map(v => text(v)); need(parts.length > 2 && parts[0] === 'ted' && parts.at(-1) === 'hoon', 'Invalid resolved thread');
        const filename = parts.slice(0, -1).join('/') + '.hoon';
        need(artifactPins[path.join(source, filename)] && filename.slice(4, -5).replaceAll('/', '-') === text(name), 'Wrong runtime resolution'); return text(name);
      });
      need(equal(actual, THREADS), 'Runtime thread set differs');
    } else if (name === '10-marks.hoon') {
      const [tag, ro, rd, rn, count, rows] = tuple(payload, 6);
      need(tag === cord('readymade-mark-graphs-v1') && ro === owner && rd === desk && rn === rev && count === BigInt(expected.marks.length), 'Mark compilation binding differs');
      const names = list(rows, expected.marks.length).map(row => {const [n, h] = tuple(row, 2); need(typeof h === 'bigint' && h >= 0n && h < 2n ** 256n, 'Invalid compiled mark hash'); return text(n);});
      need(equal(names, expected.marks), 'Mark names differ');
    } else if (name === '00-source.hoon') need(equal(tuple(payload, 6), [cord('readymade-complete-source-verified-v1'), owner, desk, rev, BigInt(expected.paths), BigInt(expected.pins)]), 'Source verification differs');
    else need(equal(tuple(payload, 5), [cord('readymade-app-compiled-v1'), owner, desk, rev, cord(name.slice(7, -5))]), 'App compilation binding differs');
  }
  const result = {schema: 'readymade-qualified-compilation-v1', ship: plan.ship, desk: plan.desk, revision: packet.revision, root: root.toString(16).padStart(64, '0'), ownerAtom: String(owner), kernel: 408,
    apps: APPS, markNames: expected.marks.length, runtimeThreads: THREADS, planDigest: sha(stable(plan)), compilationPacketSHA256: sha(packetBytes),
    artifactPins, activationAuthorized: false, currentReadinessVerified: false, scope: 'Consistent retained evidence; requires fresh guarded preflight before one activation'};
  return {...result, digest: sha(stable(result))};
}
module.exports = {qualify, reconstruct};
