import {spawn} from 'node:child_process';
import {accessSync, constants, mkdtempSync, readdirSync, readFileSync, rmSync, statSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {basename, delimiter, isAbsolute, join} from 'node:path';
import {shipRank} from './install-choice';

/**
 * The command line on Home. The person types an instruction; the coding assistant already installed on this
 * computer (Claude Code, else Codex), signed in with the person's own account, answers with Readymade commands;
 * Readymade runs them through their normal screens. The assistant gets the instruction, the command list and two
 * yes/no facts. Claude Code is given no tools; Codex runs in its own read-only sandbox. Either way the answer can
 * only name commands from the list below, and an argument only when the person typed that exact word.
 */
export type ArgKind = 'ship' | 'role' | 'address' | 'link' | 'name';
export interface CommandSpec {readonly command: string; readonly title: string; readonly about: string; readonly args?: readonly ArgKind[]}
export interface PlanStep {readonly command: string; readonly title: string; readonly args: readonly string[]}
export interface Plan {readonly say: string; readonly steps: readonly PlanStep[]}
export interface AskState {readonly connected: boolean; readonly project: boolean}
export type AssistantKind = 'claude' | 'codex';
export interface Assistant {readonly kind: AssistantKind; readonly path: string}

export const MAX_INSTRUCTION = 500, MAX_STEPS = 4;
const spec = (command: string, title: string, about: string, ...args: ArgKind[]): CommandSpec => ({command, title, about, args});
/** Every command the Home command line may run. Arguments are optional, in order, and only ever values the person typed. */
export const COMMANDS: readonly CommandSpec[] = [
  spec('readymade.connect', 'Connect to Ship', 'Connect Readymade to an Urbit ship. Without an address it finds the ships running on this computer and signs in by itself.', 'address'),
  spec('readymade.switchShip', 'Switch Ship', 'Disconnect and connect to a different ship.'),
  spec('readymade.checkSetup', 'Check Setup', 'Show what is installed and working on the connected ship.'),
  spec('readymade.doctor', 'Ship Doctor', 'Check the ship\'s health: why it is slow, stuck, or not answering.'),
  spec('readymade.getUrbit', 'Get an Urbit', 'Get a planet (an Urbit identity) for someone who has none.'),
  spec('readymade.startPlanet', 'Start a Planet from a Keyfile', 'Boot a planet on this computer from its keyfile.'),
  spec('readymade.installBackend', 'Install Pataphor on This Ship', 'Install the full coding backend, or the small collaboration service, on the connected ship.'),
  spec('readymade.followBackendUpdates', 'Follow Pataphor Updates', 'Keep the ship\'s installed backend updated from its publisher.'),
  spec('workbench.action.files.openFolder', 'Open a Project Folder', 'Open a folder on this computer as the project to work in.'),
  spec('readymade.selectProject', 'Choose Project', 'Choose which project on the ship to work in.', 'name'),
  spec('readymade.inviteAndCopyLink', 'Invite and Copy Join Link', 'Invite another ship to the chosen project and copy its join link to the clipboard, ready to send. Use this when asked to invite someone.', 'ship', 'role'),
  spec('readymade.inviteCollaborator', 'Invite Collaborator', 'Invite another ship to the chosen project without copying a link. Also offers an existing member a different role.', 'ship', 'role'),
  spec('readymade.joinProject', 'Join Project', 'Join someone else\'s project from the join link they sent.', 'link'),
  spec('readymade.projectMembers', 'Project Members', 'List who is in the chosen project, with roles and what each can read.'),
  spec('readymade.projectInvitations', 'Pending Project Invitations', 'List invitations that are still open; a link can be copied or an invitation withdrawn from there.'),
  spec('readymade.projectHistory', 'Project History', 'Show who joined, left, or changed role, and when.'),
  spec('readymade.projectActivity', 'Project Activity', 'Show recent activity in the chosen project.'),
  spec('readymade.ownerInbox', 'Check What Is Waiting on Me', 'Show everything waiting for the owner\'s decision.'),
  spec('readymade.leaveProject', 'Leave Project', 'Leave a project this ship joined. Asks which one when there are several, and asks to confirm.'),
  spec('readymade.removeCollaborator', 'Remove Collaborator from Project', 'Remove a member from the chosen project. Asks who and asks to confirm.'),
  spec('readymade.removeCollaborationService', 'Remove Collaboration Service', 'Uninstall the small collaboration service from this ship. Asks to confirm.'),
  spec('readymade.projectSharing', 'Project Sharing', 'Show which files and sessions each collaborator can read.'),
  spec('readymade.grantProjectAccess', 'Share Project Files', 'Let a collaborator read project files.'),
  spec('readymade.revokeProjectAccess', 'Revoke Project Access', 'Stop a collaborator reading project files.'),
  spec('readymade.shareSession', 'Share Agent Session', 'Let collaborators watch a coding session.'),
  spec('readymade.unshareSession', 'Stop Sharing Agent Session', 'Stop sharing a coding session.'),
  spec('readymade.projectSessionSharing', 'Turn Session Sharing On or Off', 'Turn session sharing on or off for the whole project.'),
  spec('readymade.shareActivity', 'Share Activity', 'Show collaborators which file you have open.'),
  spec('readymade.stopActivity', 'Stop Sharing Activity', 'Stop showing collaborators which file you have open.'),
  spec('readymade.openSharedProject', 'Open Shared Project', 'Open a project another ship shared, from its link.', 'link'),
  spec('readymade.refreshSharedProject', 'Refresh Shared Project', 'Read the shared project again from its owner.'),
  spec('readymade.conversation', 'Show Pataphor Workspace', 'Open the coding conversation with the ship\'s agents.'),
  spec('readymade.request', 'Send Pataphor Request', 'Write a coding request for the ship\'s agents.'),
  spec('readymade.receipts', 'Check Request Receipts', 'See whether sent requests arrived.'),
  spec('readymade.terminal', 'Ship Terminal', 'Open the ship\'s terminal.'),
  spec('readymade.browseFiles', 'Browse Ship Files', 'Browse the project files held on the ship.'),
  spec('readymade.changes', 'Show Ship Changes', 'Show what changed on the ship.'),
  spec('readymade.checks', 'Observe Native Checks', 'Show the checks the ship ran on the code.'),
  spec('readymade.reviewCode', 'Observe Code Candidates', 'Show proposed code changes waiting for review.'),
  spec('readymade.openDocument', 'Open Shared Document', 'Open a shared document.'),
  spec('readymade.noltbook', 'Calls and Notes (Noltbook)', 'Open Noltbook: messages, notes and calls.'),
  spec('readymade.glurff', 'Glurff', 'Open Glurff, the shared world.'),
  spec('readymade.lattice', 'Lattice', 'Open Lattice: notes and reading.'),
  spec('readymade.groups', 'Tlon Groups', 'Open Groups: communities and chat.'),
  spec('readymade.landscape', 'Landscape', 'Open Landscape: every app installed on the ship.'),
  spec('readymade.returnCode', 'Return to Code', 'Go back from an app to the code.'),
  spec('readymade.refresh', 'Refresh Ship Workspace', 'Read the workspace again from the ship.'),
  spec('readymade.home', 'Home', 'Show this Home page.'),
];
const byCommand = new Map(COMMANDS.map(row => [row.command, row]));
const ROLES = ['contributor', 'observer', 'maintainer'];
const noun: Record<ArgKind, string> = {ship: 'ship', role: 'role', address: 'address', link: 'link', name: 'name'};
const aNoun = (kind: ArgKind) => `${kind === 'address' ? 'an' : 'a'} ${noun[kind]}`;

export class AssistantError extends Error {}

export function instructionText(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new AssistantError('Type one line saying what Readymade should do.');
  const text = value.trim();
  if (!text || text.length > MAX_INSTRUCTION) throw new AssistantError(`Type one line, at most ${MAX_INSTRUCTION} characters, saying what Readymade should do.`);
  return text;
}

export function systemPrompt(state: AskState): string {
  return [
    'You are the command line on the Home page of Readymade, a desktop app for working with other people through Urbit ships.',
    'Turn the person\'s one instruction into the Readymade commands that carry it out. You can do nothing except choose commands from the list. Readymade runs them in order; each opens its normal screen and asks the person for anything not given.',
    '',
    'Reply with ONLY one JSON object: no code fence, no other text.',
    '{"say":"<one short plain sentence: what will happen, or why nothing in the list fits>","steps":[{"command":"<id from the list>","args":[]}]}',
    '',
    'Rules:',
    `- Use only command ids from the list, at most ${MAX_STEPS} steps, in the order they should run. Prefer one command that does the whole job.`,
    '- If nothing in the list fits, or the instruction is a question, use "steps":[] and answer briefly in "say".',
    '- Arguments are optional and in the order shown in brackets. Give one only when the person stated its exact value, and copy it character for character from the instruction. Never invent or correct a ship name, role, link, address or name. Leave out every argument that was not stated.',
    '- A ship name starts with ~. A role is contributor, observer or maintainer. An address looks like http://localhost:8080.',
    '',
    `Now: connected to a ship: ${state.connected ? 'yes' : 'no'}; project chosen: ${state.project ? 'yes' : 'no'}.`,
    '',
    'Commands:',
    ...COMMANDS.map(row => `${row.command}${(row.args ?? []).map(kind => ` [${noun[kind]}]`).join('')} : ${row.about}`),
  ].join('\n');
}

function validArg(kind: ArgKind, value: string): boolean {
  if (kind === 'ship') return shipRank(value) !== undefined;
  if (kind === 'role') return ROLES.includes(value);
  if (kind === 'name') return /^[^\s/\\]{1,64}$/.test(value);
  if (value.length > 2048 || /\s/.test(value)) return false;
  let url: URL; try {url = new URL(value);} catch {return false;}
  if (kind === 'link') return url.protocol.length > 1 && value.includes('://');
  return (url.protocol === 'http:' || url.protocol === 'https:') && (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash && !url.username && !url.password;
}
/** What the person typed, word by word, with and without the punctuation around a word. An argument must be one of these, whole: part of a longer name does not count. */
const typedWords = (instruction: string) => new Set(instruction.split(/\s+/).flatMap(word => [word, word.replace(/^[("'<[]+|[)"'>\],.;:!?]+$/g, '')]));
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const unusable = (why: string) => new AssistantError(`The assistant's answer could not be used (${why}). Nothing was run.`);

/** Accepts exactly {say, steps}; every command must be listed and every argument must be text the person typed. */
export function parsePlan(answer: string, instruction: string): Plan {
  const start = answer.indexOf('{'), end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) throw unusable('it was not the expected form');
  let value: unknown; try {value = JSON.parse(answer.slice(start, end + 1));} catch {throw unusable('it was not the expected form');}
  if (!plain(value) || Object.keys(value).some(key => key !== 'say' && key !== 'steps') || typeof value.say !== 'string' || !Array.isArray(value.steps)) throw unusable('it was not the expected form');
  if (value.steps.length > MAX_STEPS) throw unusable(`more than ${MAX_STEPS} steps`);
  const typed = typedWords(instruction);
  const steps = value.steps.map((row: unknown): PlanStep => {
    if (!plain(row) || Object.keys(row).some(key => key !== 'command' && key !== 'args') || typeof row.command !== 'string') throw unusable('a step was not the expected form');
    const known = byCommand.get(row.command);
    if (!known) throw unusable('it named a command Readymade does not offer here');
    const args = row.args ?? [], kinds = known.args ?? [];
    if (!Array.isArray(args) || args.length > kinds.length) throw unusable(`${known.title} was given arguments it does not take`);
    args.forEach((arg: unknown, index) => {
      if (typeof arg !== 'string' || !validArg(kinds[index], arg)) throw unusable(`${known.title} was given ${aNoun(kinds[index])} that is not valid`);
      if (!typed.has(arg)) throw unusable(`${known.title} was given ${aNoun(kinds[index])} you did not type`);
    });
    return {command: known.command, title: known.title, args: args as string[]};
  });
  const say = value.say.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 400);
  if (!say && !steps.length) throw unusable('it was empty');
  return {say, steps};
}

export function assistantKind(path: string): AssistantKind | undefined {
  const name = basename(path).toLowerCase();
  return name === 'claude' || name.startsWith('claude-') ? 'claude' : name === 'codex' || name.startsWith('codex-') ? 'codex' : undefined;
}
function executable(path: string): boolean {
  try {accessSync(path, constants.X_OK); return statSync(path).isFile();} catch {return false;}
}
function newestNode(home: string): string[] {
  const root = join(home, '.nvm', 'versions', 'node');
  try {return readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, {numeric: true})).map(row => join(root, row, 'bin'));} catch {return [];}
}
/** Where an assistant is looked for: the app's own PATH, then the usual per-user install places (an app opened from Finder may not have them on PATH). */
export function searchDirs(env: NodeJS.ProcessEnv = process.env, home = homedir(), nodeDirs: (home: string) => string[] = newestNode): string[] {
  const dirs = [...(env.PATH ?? '').split(delimiter), join(home, '.local', 'bin'), join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin',
    join(home, '.bun', 'bin'), join(home, '.npm-global', 'bin'), ...nodeDirs(home)];
  return [...new Set(dirs.filter(dir => isAbsolute(dir)))];
}
/** Claude Code first, then Codex. A chosen path wins and must be one of the two. */
export function findAssistant(chosen?: string, dirs: readonly string[] = searchDirs(), isExecutable: (path: string) => boolean = executable): Assistant | undefined {
  if (chosen) {
    const kind = assistantKind(chosen);
    if (!isAbsolute(chosen) || !kind || !isExecutable(chosen)) throw new AssistantError('The setting readymade.assistantPath must be the full path of a claude or codex program that can be run.');
    return {kind, path: chosen};
  }
  for (const kind of ['claude', 'codex'] as const) for (const dir of dirs) if (isExecutable(join(dir, kind))) return {kind, path: join(dir, kind)};
  return undefined;
}

/** The exact program arguments and standard input. The instruction never appears as an argument. */
export function assistantCall(kind: AssistantKind, system: string, instruction: string, answerFile: string): {args: string[]; stdin: string} {
  if (kind === 'claude') return {args: ['-p', '--system-prompt', system, '--tools', '', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}',
    '--output-format', 'json', '--no-session-persistence'], stdin: instruction};
  return {args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--output-last-message', answerFile, '-'],
    stdin: `${system}\n\nThe instruction:\n${instruction}`};
}
const label: Record<AssistantKind, string> = {claude: 'Claude Code', codex: 'Codex'};
const signIn = (kind: AssistantKind) => `Open a terminal, run "${kind}" once and sign in, then try again.`;
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
/** The assistant's final text from what the program printed (Claude Code) or wrote (Codex). A failure repeats the program's own reason when it gave one. */
export function assistantAnswer(kind: AssistantKind, code: number | null, stdout: string, answer: string | undefined, stderr = ''): string {
  const failed = (reason: string) => new AssistantError(`${label[kind]} did not answer. ${reason ? `It said: ${reason.replace(/\.$/, '')}.` : signIn(kind)}`);
  if (kind === 'codex') {
    if (code !== 0 || !answer?.trim()) throw failed(oneLine(stderr.split('\n').reverse().find(line => line.startsWith('ERROR:'))?.slice(6) ?? ''));
    return answer;
  }
  let value: unknown; try {value = JSON.parse(stdout);} catch {value = undefined;}
  if (!plain(value) || typeof value.result !== 'string' || value.is_error === true || code !== 0) throw failed(plain(value) && typeof value.result === 'string' ? oneLine(value.result) : '');
  return value.result;
}

export interface RunResult {readonly code: number | null; readonly stdout: string; readonly stderr?: string; readonly timedOut: boolean}
export type Runner = (path: string, args: readonly string[], stdin: string, options: {cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number}) => Promise<RunResult>;
const runProgram: Runner = (path, args, stdin, options) => new Promise((resolve, reject) => {
  const child = spawn(path, [...args], {cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe']});
  let stdout = '', stderr = '', timedOut = false;
  const timer = setTimeout(() => {timedOut = true; child.kill('SIGKILL');}, options.timeoutMs);
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => {if (stdout.length < 1_000_000) stdout += chunk;});
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => {stderr = (stderr + chunk).slice(-4000);});
  child.on('error', error => {clearTimeout(timer); reject(error);});
  child.on('close', code => {clearTimeout(timer); resolve({code, stdout, stderr, timedOut});});
  child.stdin.on('error', () => undefined); child.stdin.end(stdin);
});

export interface AskOptions {readonly chosen?: string; readonly timeoutMs?: number; readonly run?: Runner; readonly find?: (chosen?: string) => Assistant | undefined}
/** One question, one answer. Runs in an empty folder made for the call and removed after it. */
export async function askAssistant(typed: unknown, state: AskState, options: AskOptions = {}): Promise<Plan & {assistant: string}> {
  const instruction = instructionText(typed);
  const assistant = (options.find ?? findAssistant)(options.chosen);
  if (!assistant) throw new AssistantError('No coding assistant was found on this computer. Install Claude Code or Codex and sign in, or set readymade.assistantPath to its full path.');
  const cwd = mkdtempSync(join(tmpdir(), 'readymade-ask-')), answerFile = join(cwd, 'answer.txt');
  try {
    const call = assistantCall(assistant.kind, systemPrompt(state), instruction, answerFile);
    const env = {...process.env, PATH: searchDirs().join(delimiter)};
    let result: RunResult;
    try {result = await (options.run ?? runProgram)(assistant.path, call.args, call.stdin, {cwd, env, timeoutMs: options.timeoutMs ?? 90_000});}
    catch {throw new AssistantError(`${label[assistant.kind]} could not be started from ${assistant.path}.`);}
    if (result.timedOut) throw new AssistantError(`${label[assistant.kind]} did not answer in time. Nothing was run.`);
    let answer: string | undefined; try {answer = readFileSync(answerFile, 'utf8');} catch {answer = undefined;}
    return {...parsePlan(assistantAnswer(assistant.kind, result.code, result.stdout, answer, result.stderr), instruction), assistant: label[assistant.kind]};
  } finally {rmSync(cwd, {recursive: true, force: true});}
}
