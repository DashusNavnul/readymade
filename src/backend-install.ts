import {spawn, execFile} from 'node:child_process';
import {mkdir, realpath, readFile, writeFile, stat, statfs} from 'node:fs/promises';
import * as path from 'node:path';

/**
 * App-side handle on the bundled backend installer. It decides nothing about the ship: the bundled
 * tools (backend/install) make every native request under one plan the owner approved in the app.
 * This module only finds those tools, starts them with the app's own runtime, and validates what
 * they print before anything is shown.
 */
export type InstallRowStatus = 'waiting' | 'running' | 'done' | 'needs-attention';
export interface InstallRow {id: string; label: string; status: InstallRowStatus; reason?: string}
export type InstallPhase = 'not-started' | 'running' | 'paused' | 'needs-attention' | 'activation-prepared' | 'activated';
export interface InstallReport {phase: InstallPhase; items: InstallRow[]; stoppedAt?: string; reason?: string}
export interface InstallTarget {ship: string; pier: string; workerPid: number}
export interface InstallerFiles {tools: string; bundle: string}
export interface InstallPlan {ship: string; state: string; output: string; digest: string; files: number}
export class BackendInstallError extends Error {constructor(message: string) {super(message); this.name = 'BackendInstallError';}}

const phases = new Set<InstallPhase>(['not-started', 'running', 'paused', 'needs-attention', 'activation-prepared', 'activated']);
const rowStatuses = new Set<InstallRowStatus>(['waiting', 'running', 'done', 'needs-attention']);
const MIN_LOOM = 33;
const MIN_FREE_BYTES = 3 * 1024 ** 3;
const shipName = /^~(?:[a-z]{3}|[a-z]{6}(?:-[a-z]{6}){0,3})(?![\s\S])/;
const plain = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

export interface RowsReport<Phase extends string> {phase: Phase; items: InstallRow[]; stoppedAt?: string; reason?: string; url?: string}
/** One printed install report, or undefined. */
export function parseReport(line: string): InstallReport | undefined {
  const report = parseRowsReport(line, phases);
  if (!report) return undefined;
  const {url: _url, ...rest} = report; void _url; return rest;
}
/** One printed report with rows, or undefined. Tool output is untrusted presentation input: bounded and shape-checked. */
export function parseRowsReport<Phase extends string>(line: string, allowed: ReadonlySet<Phase>): RowsReport<Phase> | undefined {
  if (typeof line !== 'string' || line.length > 65536) return undefined;
  let value: unknown;
  try {value = JSON.parse(line);} catch {return undefined;}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (!allowed.has(row.phase as Phase) || !Array.isArray(row.items) || row.items.length > 64) return undefined;
  const items: InstallRow[] = [];
  for (const entry of row.items) {
    if (!entry || typeof entry !== 'object') return undefined;
    const item = entry as Record<string, unknown>;
    if (!plain(item.id, 96) || !plain(item.label, 160) || !rowStatuses.has(item.status as InstallRowStatus)) return undefined;
    if (item.reason !== undefined && !plain(item.reason, 240)) return undefined;
    items.push({id: item.id, label: item.label, status: item.status as InstallRowStatus, ...(item.reason !== undefined ? {reason: item.reason} : {})});
  }
  if (row.stoppedAt !== undefined && !plain(row.stoppedAt, 160) || row.reason !== undefined && !plain(row.reason, 240)) return undefined;
  if (row.url !== undefined && !(typeof row.url === 'string' && /^http:\/\/127\.0\.0\.1:[0-9]{2,5}(?![\s\S])/.test(row.url))) return undefined;
  return {phase: row.phase as Phase, items,
    ...(row.stoppedAt !== undefined ? {stoppedAt: row.stoppedAt as string} : {}), ...(row.reason !== undefined ? {reason: row.reason as string} : {}),
    ...(row.url !== undefined ? {url: row.url as string} : {})};
}

async function directory(file: string): Promise<boolean> {try {return (await stat(file)).isDirectory();} catch {return false;}}
/** The tools and bundle the package step placed inside the extension; undefined in a build without them. */
export async function locateInstaller(extensionPath: string): Promise<InstallerFiles | undefined> {
  const tools = path.join(extensionPath, 'backend/install'), bundle = path.join(extensionPath, 'backend/package');
  for (const needed of [path.join(tools, 'install-all.cjs'), path.join(tools, 'install-local.cjs'), path.join(bundle, 'assembly.json'), path.join(extensionPath, 'backend/assembly-manifest.json')])
    try {if (!(await stat(needed)).isFile()) return undefined;} catch {return undefined;}
  return await directory(path.join(bundle, 'desk')) ? {tools, bundle} : undefined;
}

export interface ToolResult {code: number; stdout: string}
export type ToolRunner = (script: string, args: readonly string[], onLine?: (line: string) => void) => Promise<ToolResult>;
/** Run one bundled tool with this app's own runtime; no shell, no inherited input, bounded output kept. */
export const runTool: ToolRunner = (script, args, onLine) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script, ...args], {env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, stdio: ['ignore', 'pipe', 'ignore']});
  let pending = '', kept = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk; if (kept.length < 262144) kept += chunk;
    for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {const line = pending.slice(0, at); pending = pending.slice(at + 1); try {onLine?.(line);} catch { /* presentation only */ }}
    if (pending.length > 262144) pending = '';
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => signal ? reject(new BackendInstallError('The installer was interrupted. Nothing was retried.')) : resolve({code: code ?? 1, stdout: kept}));
});

export interface HostProbes {
  /** The executable path of a process, as ps reports it. */
  executable(pid: number): Promise<string>;
  /** Resolves when `python3` runs; the bundled tools still need it. */
  python(): Promise<void>;
  /** The full command line of a process, as ps reports it. */
  command(pid: number): Promise<string>;
  /** Free bytes on the volume holding a path. */
  freeBytes(directory: string): Promise<number>;
}
const run = (file: string, args: string[]) => new Promise<string>((resolve, reject) =>
  execFile(file, args, {timeout: 5000, maxBuffer: 65536}, (error, stdout) => error ? reject(error) : resolve(String(stdout).trim())));
export const hostProbes: HostProbes = {
  executable: async pid => realpath(await run('/bin/ps', ['-p', String(pid), '-o', 'comm='])),
  python: async () => {await run('python3', ['-I', '-c', 'import sys; assert sys.version_info >= (3, 9)']);},
  command: pid => run('/bin/ps', ['-p', String(pid), '-o', 'args=']),
  freeBytes: async directory => {const s = await statfs(directory); return Number(s.bavail) * Number(s.bsize);},
};

export class BackendInstall {
  constructor(private readonly files: InstallerFiles, private readonly storage: string,
    private readonly tool: ToolRunner = runTool, private readonly probes: HostProbes = hostProbes) {}
  private record(ship: string): string {return path.join(this.storage, 'installs', ship.slice(1) + '.json');}

  /** The retained plan for this ship, if one was made here before. Lets a reopened window show where it stands. */
  async retained(ship: string): Promise<InstallPlan | undefined> {
    if (!shipName.test(ship)) return undefined;
    try {
      const value = JSON.parse(await readFile(this.record(ship), 'utf8')) as Record<string, unknown>;
      if (value.ship !== ship || !plain(value.state, 1024) || !plain(value.output, 1024) || typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest) ||
          !Number.isSafeInteger(value.files) || !path.isAbsolute(value.state) || !path.isAbsolute(value.output)) return undefined;
      return {ship, state: value.state, output: value.output, digest: value.digest, files: value.files as number};
    } catch {return undefined;}
  }

  /** Prepare a plan for a ship running on this computer. Sends nothing to the ship. */
  async plan(target: InstallTarget, now = Date.now()): Promise<InstallPlan> {
    if (!shipName.test(target.ship) || !path.isAbsolute(target.pier) || !Number.isSafeInteger(target.workerPid) || target.workerPid < 1)
      throw new BackendInstallError('This ship could not be identified. Choose it again from Connect.');
    try {await this.probes.python();}
    catch {throw new BackendInstallError('Installing still needs Python 3 on this Mac. Install Apple’s Command Line Tools (run “xcode-select --install” in Terminal), then try again.');}
    let vere: string;
    try {vere = await this.probes.executable(target.workerPid);}
    catch {throw new BackendInstallError('Your ship is no longer running. Start it, reconnect, and try again.');}
    // Building the backend needs an 8 GiB address space; smaller ones ran out of memory compiling Viki.
    let loom: number | undefined;
    try {const match = /\s--loom\s+(\d{1,2})(?:\s|$)/.exec(await this.probes.command(target.workerPid)); loom = match ? Number(match[1]) : undefined;}
    catch {throw new BackendInstallError('Your ship is no longer running. Start it, reconnect, and try again.');}
    if (loom === undefined || loom < MIN_LOOM)
      throw new BackendInstallError(`Your ship was started with too little memory to build Pataphor. Stop it and start it again with “--loom ${MIN_LOOM}”, then reconnect.`);
    const parent = path.join(this.storage, 'installs');
    await mkdir(parent, {recursive: true, mode: 0o700});
    // Measured: a switched-on test ship grew to 0.55 GB and its install records took 0.22 GB.
    let free = Infinity; try {free = Math.min(await this.probes.freeBytes(parent), await this.probes.freeBytes(target.pier));} catch { /* an unreadable figure is not a refusal */ }
    if (free < MIN_FREE_BYTES) throw new BackendInstallError('This Mac needs about 3 GB of free disk space to install Pataphor. Free some space, then try again.');
    const state = path.join(parent, `${target.ship.slice(1)}-${now}`), output = state + '-compile';
    const result = await this.tool(path.join(this.files.tools, 'install-local.cjs'),
      ['plan', '--state', state, '--ship', target.ship, '--desk', 'readymade', '--pier', target.pier, '--vere', vere, '--bundle', this.files.bundle]);
    let digest: unknown, files: unknown;
    try {
      const printed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as {digest?: unknown; plan?: {ship?: unknown; pier?: unknown}; files?: unknown};
      if (printed.plan?.ship !== target.ship || printed.plan?.pier !== target.pier) throw Error();
      digest = printed.digest; files = printed.files;
    } catch {digest = undefined;}
    if (result.code !== 0 || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest))
      throw new BackendInstallError('This ship cannot be prepared for installing right now. It may be busy, or an earlier install on it is unfinished.');
    const plan: InstallPlan = {ship: target.ship, state, output, digest, files: Number.isSafeInteger(files) ? files as number : 0};
    await writeFile(this.record(target.ship), JSON.stringify(plan), {mode: 0o600});
    return plan;
  }

  /** Where a planned or finished run stands, read from retained evidence only. */
  async status(plan: InstallPlan): Promise<InstallReport> {
    const result = await this.tool(path.join(this.files.tools, 'install-all.cjs'), ['status', '--state', plan.state, '--output', plan.output]);
    const report = parseReport(result.stdout.trim().split('\n').at(-1) ?? '');
    if (!report) throw new BackendInstallError('The install record could not be read.');
    return report;
  }

  /** Run the approved plan once. Reports every change; resolves with the last report. Never retries. */
  async run(plan: InstallPlan, onReport: (report: InstallReport) => void): Promise<InstallReport> {
    let last: InstallReport | undefined;
    await this.tool(path.join(this.files.tools, 'install-all.cjs'), ['run', '--state', plan.state, '--output', plan.output, '--approve', plan.digest], line => {
      const report = parseReport(line); if (report) {last = report; onReport(report);}
    });
    // The tool's final line is authoritative; if it printed none, read the retained evidence instead of guessing.
    return last ?? this.status(plan);
  }

  /**
   * Switch on an install that finished as activation-prepared. A second, separate approval of the same plan.
   * The bundled tool submits once, then checks that the new apps started and the existing ones are unchanged.
   */
  async activate(plan: InstallPlan, onReport: (report: InstallReport) => void): Promise<InstallReport> {
    let last: InstallReport | undefined;
    await this.tool(path.join(this.files.tools, 'install-all.cjs'), ['activate', '--state', plan.state, '--output', plan.output, '--approve', plan.digest], line => {
      const report = parseReport(line); if (report) {last = report; onReport(report);}
    });
    return last ?? this.status(plan);
  }
}
