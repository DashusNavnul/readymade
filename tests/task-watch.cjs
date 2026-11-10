// Finite real compiler watcher used only by isolated editor acceptance.
const ts = require('typescript'), fs = require('node:fs'), path = require('node:path');
const root = fs.realpathSync(process.argv[2]);
const info = fs.lstatSync(root);
if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 ||
    fs.readFileSync(path.join(root, '.readymade-test-root'), 'utf8') !== 'isolated task acceptance\n') throw Error('Expected private test workspace');
const format = {getCanonicalFileName: x => x, getCurrentDirectory: () => root, getNewLine: () => '\n'};
const rounds = [];
let watcher, timer;
function finish(code) {
  clearTimeout(timer); watcher.close();
  fs.writeFileSync(path.join(root, 'watch-result.json'), JSON.stringify({pid: process.pid, rounds, code}), {mode: 0o600});
  process.exitCode = code;
}
const host = ts.createWatchCompilerHost(path.join(root, 'tsconfig.json'), {noEmit: true}, ts.sys,
  ts.createSemanticDiagnosticsBuilderProgram,
  diagnostic => process.stdout.write(ts.formatDiagnostic(diagnostic, format)),
  diagnostic => process.stdout.write(ts.formatDiagnostic(diagnostic, format)));
const original = host.afterProgramCreate;
host.afterProgramCreate = program => {
  original(program);
  rounds.push(ts.getPreEmitDiagnostics(program.getProgram()).filter(d => d.category === ts.DiagnosticCategory.Error).length);
  if (rounds.length === 2) setImmediate(() => finish(rounds[0] === 1 && rounds[1] === 0 ? 0 : 3));
};
watcher = ts.createWatchProgram(host);
timer = setTimeout(() => finish(4), 35000);
