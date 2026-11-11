import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {AssistantError, COMMANDS, MAX_STEPS, askAssistant, assistantAnswer, assistantCall, assistantKind, findAssistant, instructionText, parsePlan, searchDirs, systemPrompt, type Runner} from '../src/home-assistant';

const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {contributes: {commands: {command: string}[]; configuration: {properties: Record<string, unknown>}}};
const plan = (value: unknown) => JSON.stringify(value);

test('every listed command exists in the app, once, with a title and a description', () => {
  const contributed = new Set(manifest.contributes.commands.map(row => row.command));
  for (const row of COMMANDS) {
    assert.ok(row.command.startsWith('workbench.') || contributed.has(row.command), row.command);
    assert.ok(row.title && row.about && !/[\n"]/.test(row.title + row.about), row.command);
  }
  assert.equal(new Set(COMMANDS.map(row => row.command)).size, COMMANDS.length);
  assert.ok(Object.hasOwn(manifest.contributes.configuration.properties, 'readymade.assistantPath'));
});

test('the assistant is told the commands, the two yes/no facts, and nothing else about the person', () => {
  const text = systemPrompt({connected: true, project: false});
  assert.match(text, /connected to a ship: yes; project chosen: no/);
  for (const row of COMMANDS) assert.ok(text.includes(row.command + (row.args?.length ? ' [' : ' :')), row.command);
  assert.match(text, /readymade\.inviteAndCopyLink \[ship\] \[role\] :/);
  assert.equal(/~[a-z]{6}-[a-z]{6}/.test(text), false, 'no ship name');
});

test('an instruction is one printable line of bounded length', () => {
  assert.equal(instructionText('  open the doctor  '), 'open the doctor');
  for (const bad of ['', '   ', 'a\nb', 'a\u0000b', 'x'.repeat(501), 7, undefined]) assert.throws(() => instructionText(bad), AssistantError);
});

test('a plan is accepted only in the exact form, with listed commands', () => {
  const said = 'invite ~sampel-palnet as a contributor and copy the link';
  assert.deepEqual(parsePlan(plan({say: 'Inviting.', steps: [{command: 'readymade.inviteAndCopyLink', args: ['~sampel-palnet', 'contributor']}]}), said),
    {say: 'Inviting.', steps: [{command: 'readymade.inviteAndCopyLink', title: 'Invite and Copy Join Link', args: ['~sampel-palnet', 'contributor']}]});
  assert.deepEqual(parsePlan('```json\n' + plan({say: 'Opening.', steps: [{command: 'readymade.doctor'}]}) + '\n```', 'doctor').steps, [{command: 'readymade.doctor', title: 'Ship Doctor', args: []}]);
  assert.deepEqual(parsePlan(plan({say: 'Readymade cannot do that from here.', steps: []}), 'make tea'), {say: 'Readymade cannot do that from here.', steps: []});
  assert.equal(parsePlan(plan({say: 'a\n\u0007b', steps: []}), 'x').say, 'a b');
  const refused: [unknown, RegExp][] = [
    ['not json at all', /expected form/], ['{broken', /expected form/], [plan([1]), /expected form/],
    [plan({say: 'x', steps: [], extra: 1}), /expected form/], [plan({say: 7, steps: []}), /expected form/], [plan({say: 'x'}), /expected form/],
    [plan({say: '', steps: []}), /empty/],
    [plan({say: 'x', steps: [{command: 'workbench.action.terminal.sendSequence', args: []}]}), /does not offer/],
    [plan({say: 'x', steps: [{command: 'readymade.applyCandidate'}]}), /does not offer/],
    [plan({say: 'x', steps: [{command: 'readymade.doctor', args: ['x']}]}), /does not take/],
    [plan({say: 'x', steps: [{command: 'readymade.doctor', run: true}]}), /step was not/],
    [plan({say: 'x', steps: ['readymade.doctor']}), /step was not/],
    [plan({say: 'x', steps: Array(MAX_STEPS + 1).fill({command: 'readymade.doctor'})}), /more than 4 steps/],
  ];
  for (const [answer, why] of refused) assert.throws(() => parsePlan(String(answer), said), why, String(answer));
});

test('an argument must be valid and must be text the person typed', () => {
  const step = (command: string, ...args: unknown[]) => plan({say: 'x', steps: [{command, args}]});
  assert.throws(() => parsePlan(step('readymade.inviteAndCopyLink', '~sampel-palnet'), 'invite sampel palnet'), /a ship you did not type/);
  assert.throws(() => parsePlan(step('readymade.inviteAndCopyLink', '~sampel-palnet', 'observer'), 'invite ~sampel-palnet'), /a role you did not type/);
  assert.throws(() => parsePlan(step('readymade.inviteAndCopyLink', '~doznec-salfun'), 'invite ~doznec-salfun-sampel-palnet'), /a ship you did not type/, 'part of a longer name is not what was typed');
  assert.throws(() => parsePlan(step('readymade.inviteAndCopyLink', '~sampel-palnet', 'observer'), 'invite ~sampel-palnet, not as observers'), /a role you did not type/);
  assert.deepEqual(parsePlan(step('readymade.inviteAndCopyLink', '~sampel-palnet', 'observer'), 'Invite (~sampel-palnet) as "observer".').steps[0].args, ['~sampel-palnet', 'observer']);
  assert.throws(() => parsePlan(step('readymade.inviteAndCopyLink', 'sampel-palnet'), 'invite sampel-palnet'), /a ship that is not valid/);
  assert.throws(() => parsePlan(step('readymade.inviteAndCopyLink', '~sampel-palnet', 'owner'), 'make ~sampel-palnet owner'), /a role that is not valid/);
  assert.throws(() => parsePlan(step('readymade.inviteAndCopyLink', 7), 'invite 7'), /not valid/);
  assert.equal(parsePlan(step('readymade.connect', 'http://localhost:8080'), 'connect to http://localhost:8080').steps[0].args[0], 'http://localhost:8080');
  for (const bad of ['http://localhost:8080/apps/x', 'file:///etc/passwd', 'http://a:b@localhost', 'localhost:8080'])
    assert.throws(() => parsePlan(step('readymade.connect', bad), `connect to ${bad}`), /an address that is not valid/, bad);
  const link = 'vscodium://pataphor.readymade-ship-workspace/join-project?authority=~zod&project=demo';
  assert.equal(parsePlan(step('readymade.joinProject', link), `join ${link}`).steps[0].args[0], link);
  assert.throws(() => parsePlan(step('readymade.joinProject', 'not a link'), 'join not a link'), /a link that is not valid/);
  assert.equal(parsePlan(step('readymade.selectProject', 'demo'), 'work in demo').steps[0].args[0], 'demo');
  assert.throws(() => parsePlan(step('readymade.selectProject', 'a/b'), 'work in a/b'), /a name that is not valid/);
});

test('Claude Code is preferred, then Codex; a chosen path must be one of the two and runnable', () => {
  assert.equal(assistantKind('/x/claude'), 'claude'); assert.equal(assistantKind('/x/codex'), 'codex'); assert.equal(assistantKind('/x/zsh'), undefined);
  const has = (...paths: string[]) => (path: string) => paths.includes(path);
  assert.deepEqual(findAssistant(undefined, ['/a', '/b'], has('/b/claude', '/a/codex')), {kind: 'claude', path: '/b/claude'});
  assert.deepEqual(findAssistant(undefined, ['/a', '/b'], has('/a/codex')), {kind: 'codex', path: '/a/codex'});
  assert.equal(findAssistant(undefined, ['/a'], has()), undefined);
  assert.deepEqual(findAssistant('/opt/codex', ['/a'], has('/a/claude', '/opt/codex')), {kind: 'codex', path: '/opt/codex'});
  for (const bad of ['claude', '/bin/zsh', '/gone/claude']) assert.throws(() => findAssistant(bad, [], has('/bin/zsh')), /readymade\.assistantPath/, bad);
  assert.deepEqual(searchDirs({PATH: '/usr/bin:relative::/usr/bin'}, '/Users/x', () => ['/Users/x/.nvm/versions/node/v22/bin']),
    ['/usr/bin', '/Users/x/.local/bin', '/Users/x/.claude/local', '/opt/homebrew/bin', '/usr/local/bin', '/Users/x/.bun/bin', '/Users/x/.npm-global/bin', '/Users/x/.nvm/versions/node/v22/bin']);
});

test('Claude Code gets no tools, Codex its read-only sandbox, and the instruction is never a program argument', () => {
  const claude = assistantCall('claude', 'SYSTEM', '--dangerous text', '/t/answer.txt');
  assert.deepEqual(claude.args, ['-p', '--system-prompt', 'SYSTEM', '--tools', '', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}', '--output-format', 'json', '--no-session-persistence']);
  assert.equal(claude.stdin, '--dangerous text');
  const codex = assistantCall('codex', 'SYSTEM', '--dangerous text', '/t/answer.txt');
  assert.deepEqual(codex.args, ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--output-last-message', '/t/answer.txt', '-']);
  assert.equal(codex.stdin, 'SYSTEM\n\nThe instruction:\n--dangerous text');
});

test('a failed or signed-out assistant is reported plainly', () => {
  assert.equal(assistantAnswer('claude', 0, plan({type: 'result', is_error: false, result: 'ANSWER'}), undefined), 'ANSWER');
  assert.throws(() => assistantAnswer('claude', 1, plan({type: 'result', is_error: true, result: 'Invalid API key\n· Please run /login'}), undefined), /^Error: Claude Code did not answer\. It said: Invalid API key · Please run \/login\.$/);
  assert.throws(() => assistantAnswer('claude', 0, 'not json', undefined), /Claude Code did not answer\. Open a terminal/);
  assert.equal(assistantAnswer('codex', 0, 'noise', 'ANSWER'), 'ANSWER');
  assert.throws(() => assistantAnswer('codex', 0, '', undefined), /^Error: Codex did not answer\. Open a terminal, run "codex" once and sign in, then try again\.$/);
  assert.throws(() => assistantAnswer('codex', 1, '', 'ANSWER', 'hook: x\nERROR: old\nERROR: You\u2019ve hit your usage limit. Try again at Nov 16th.\n'), /^Error: Codex did not answer\. It said: You\u2019ve hit your usage limit\. Try again at Nov 16th\.$/);
});

test('one question: an empty folder made for the call and removed after it, the plan checked against what was typed', async () => {
  const calls: {path: string; args: readonly string[]; stdin: string; cwd: string}[] = [];
  const run: Runner = async (path, args, stdin, options) => {
    calls.push({path, args, stdin, cwd: options.cwd}); assert.ok(existsSync(options.cwd));
    return {code: 0, timedOut: false, stdout: plan({type: 'result', is_error: false, result: plan({say: 'Opening Ship Doctor.', steps: [{command: 'readymade.doctor', args: []}]})})};
  };
  const find = () => ({kind: 'claude' as const, path: '/x/claude'});
  const answer = await askAssistant(' why is my ship slow ', {connected: true, project: true}, {run, find});
  assert.deepEqual(answer, {say: 'Opening Ship Doctor.', steps: [{command: 'readymade.doctor', title: 'Ship Doctor', args: []}], assistant: 'Claude Code'});
  assert.equal(calls.length, 1); assert.equal(calls[0].path, '/x/claude'); assert.equal(calls[0].stdin, 'why is my ship slow'); assert.equal(existsSync(calls[0].cwd), false);
  await assert.rejects(askAssistant('x', {connected: false, project: false}, {run, find: () => undefined}), /No coding assistant was found/);
  await assert.rejects(askAssistant('x', {connected: false, project: false}, {find, run: async () => ({code: null, stdout: '', timedOut: true})}), /did not answer in time\. Nothing was run/);
  await assert.rejects(askAssistant('x', {connected: false, project: false}, {find, run: async () => {throw Error('ENOENT');}}), /could not be started from \/x\/claude/);
  await assert.rejects(askAssistant('', {connected: false, project: false}, {run, find}), /Type one line/);
  assert.equal(calls.length, 1, 'nothing is started for an empty instruction or a missing assistant');
});
