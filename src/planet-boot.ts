import {copyFile, chmod, mkdir, stat, unlink} from 'node:fs/promises';
import * as path from 'node:path';
import {parseRowsReport, runTool, type RowsReport, type ToolRunner} from './backend-install';

/**
 * App-side handle on the bundled planet boot. The bundled tools validate the key, reserve the identity,
 * start the planet once with the shipped runtime, and make the first native checks. This module only
 * hands them a private copy of the chosen keyfile and validates what they print.
 */
export type BootPhase = 'not-started' | 'running' | 'needs-attention' | 'booted';
export type BootReport = RowsReport<BootPhase>;
export interface BootPlan {ship: string; digest: string; pier: string; output: string; httpPort: number}
export class PlanetBootError extends Error {constructor(message: string) {super(message); this.name = 'PlanetBootError';}}
const bootPhases = new Set<BootPhase>(['not-started', 'running', 'needs-attention', 'booted']);
const planet = /^~[a-z]{6}-[a-z]{6}(?![\s\S])/;

/** A planet name from a keyfile's name, such as sampel-palnet-1.key. The key's content is checked against it by the tools. */
export function planetFromKeyfile(file: string): string | undefined {
  const match = /^([a-z]{6}-[a-z]{6})(?:-\d+)?\.key$/.exec(path.basename(file));
  return match ? '~' + match[1] : undefined;
}
export function parseBootReport(line: string): BootReport | undefined {return parseRowsReport(line, bootPhases);}

export class PlanetBoot {
  /** `tools` is the bundled backend/install folder; `root` is the private folder that will hold ships. */
  constructor(private readonly tools: string, private readonly root: string, private readonly tool: ToolRunner = runTool) {}

  /** True when this build carries the runtime and boot pill. */
  async available(): Promise<boolean> {
    for (const name of ['urbit', 'brass.pill', 'runtime.json']) try {if (!(await stat(path.join(this.tools, '../runtime', name))).isFile()) return false;} catch {return false;}
    try {return (await stat(path.join(this.tools, 'boot-run.cjs'))).isFile();} catch {return false;}
  }

  /** Validate the key and choose folder and ports. Starts nothing. The chosen file is copied privately and the copy removed. */
  async prepare(ship: string, keyfile: string): Promise<BootPlan> {
    if (!planet.test(ship)) throw new PlanetBootError('Enter the planet’s name, such as ~sampel-palnet.');
    await mkdir(this.root, {recursive: true, mode: 0o700});
    // Bridge saves keyfiles world-readable; the tools accept only a private file, so hand them a private copy.
    const copy = path.join(this.root, `.incoming-${ship.slice(1)}.key`);
    try {
      try {await copyFile(keyfile, copy); await chmod(copy, 0o600);}
      catch {throw new PlanetBootError('That keyfile could not be read.');}
      const result = await this.tool(path.join(this.tools, 'boot-run.cjs'), ['prepare', '--ship', ship, '--keyfile', copy, '--root', this.root, '--confirm-not-running-elsewhere', 'yes']);
      let value: Record<string, unknown> = {};
      try {value = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>;} catch { /* refused below */ }
      if (result.code !== 0 || value.ship !== ship || typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest) ||
          typeof value.pier !== 'string' || typeof value.output !== 'string' || !path.isAbsolute(value.pier) || !path.isAbsolute(value.output) ||
          !Number.isInteger(value.httpPort) || (value.httpPort as number) < 1024 || (value.httpPort as number) > 65535)
        throw new PlanetBootError(`This keyfile could not be used for ${ship}. Check that it is the keyfile for this planet, and that the planet was not already set up on this Mac.`);
      return {ship, digest: value.digest, pier: value.pier, output: value.output, httpPort: value.httpPort as number};
    } finally {await unlink(copy).catch(() => undefined);}
  }

  /** Start the prepared planet once. Reports every change; resolves with the last report. Never starts a second copy. */
  async launch(plan: BootPlan, onReport: (report: BootReport) => void): Promise<BootReport> {
    let last: BootReport | undefined;
    await this.tool(path.join(this.tools, 'boot-run.cjs'), ['launch', '--output', plan.output, '--approve', plan.digest], line => {
      const report = parseBootReport(line); if (report) {last = report; onReport(report);}
    });
    if (last) return last;
    const retained = parseBootReport((await this.tool(path.join(this.tools, 'boot-run.cjs'), ['status', '--output', plan.output])).stdout.trim().split('\n').at(-1) ?? '');
    if (!retained) throw new PlanetBootError('The start record could not be read. Your planet was not started a second time.');
    return retained;
  }
}
