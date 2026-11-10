# Build task acceptance

This check runs the real TypeScript compiler through the packaged editor's task
service. It checks failure exit 2, compiler diagnostic 2322 at the expected file
and line, then success exit 0 and removal of the old diagnostic after repair.
The diagnostic source must be `readymade-build`, separating task output from
language-server diagnostics. It does not contact an Urbit ship.

From the repository root, prepare a new private workspace:

```sh
npm run build
export READYMADE_TASK_ROOT="$(node <<'JS'
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readymade-tasks-'));
fs.chmodSync(root, 0o700);
fs.mkdirSync(path.join(root, '.vscode'));
fs.writeFileSync(path.join(root, '.readymade-test-root'), 'isolated task acceptance\n');
fs.writeFileSync(path.join(root, 'example.ts'), 'const answer: number = "wrong";\n');
fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({compilerOptions: {
  strict: true, noEmit: true, types: []}, files: ['example.ts']}));
fs.writeFileSync(path.join(root, '.vscode/tasks.json'), JSON.stringify({version: '2.0.0', tasks: [{
  label: 'Readymade task acceptance', type: 'process', command: process.execPath,
  args: [require.resolve('typescript/lib/tsc.js'), '--project', root, '--pretty', 'false'],
  options: {cwd: root}, group: {kind: 'build', isDefault: true},
  problemMatcher: [{base: '$tsc', owner: 'readymade-task-acceptance', source: 'readymade-build'}],
  presentation: {reveal: 'never', close: false}
}]}));
console.log(root);
JS
)"
```

Set `READYMADE_CODE_BIN` to the packaged `codium` launcher and
`READYMADE_BUILTIN_EXTENSION` to that package's built-in
`pataphor.readymade-ship-workspace` extension directory. Then run:

```sh
READYMADE_TEST_MODULE=tasks-host bash test-host.sh --host-only "$READYMADE_TASK_ROOT"
```

The runner prints its private evidence directory. A failed result is retained.
Prepare a new workspace for each repeat: the successful check repairs its source
file. This is local macOS task-service acceptance, not remote task execution.

The original macOS arm64 preview passed with `close: false` but failed with
`close: true`: the second task started and never reported completion before the
45-second limit. Its diagnostic remained. The corrected package excludes
closing terminals from both completion paths' shared/dedicated reuse caches.
The same real-compiler auto-close case now passes in the corrected preview.
Change `close` to true to exercise that regression. Earlier failed receipts
remain retained. The background watcher procedure below separately qualifies watch tasks.


## Background compiler watcher

Prepare a fresh workspace with the first snippet above. Before launching the
host, replace its task configuration using this command from the repository:

```sh
node <<'JS'
const fs = require('node:fs'), path = require('node:path');
const root = process.env.READYMADE_TASK_ROOT;
const file = path.join(root, '.vscode/tasks.json');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const task = config.tasks[0];
task.isBackground = true;
task.args = [path.resolve('tests/task-watch.cjs'), root];
task.problemMatcher = [{base: '$tsc-watch', owner: 'readymade-task-acceptance', source: 'readymade-build'}];
task.presentation = {reveal: 'never', close: true, panel: 'shared'};
fs.writeFileSync(file, JSON.stringify(config, null, 2));
JS
READYMADE_TASK_BACKGROUND=1 READYMADE_TEST_MODULE=tasks-host \
  bash test-host.sh --host-only "$READYMADE_TASK_ROOT"
```

`task-watch.cjs` uses TypeScript's actual compiler and file watcher. It closes
its own watcher after the initial error and repaired compilation, or after a
35-second deadline. It sends no process signal and creates no persistent
service. The host runs it twice, checks task-originated diagnostics, verifies
both real compiler results `[1, 0]`, and requires two distinct processes with
normal exit and diagnostic clearance. Use `panel: 'dedicated'` for the other
terminal reuse mode. This qualifies bounded watch-task execution; it does not
establish remote or indefinitely running service behavior.
