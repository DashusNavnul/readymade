import {execFile} from 'node:child_process';
import {readdir, readFile, stat, statfs} from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import {NativeObservationFailure, queryDoctorReading, queryFlowsReading} from './planet-discovery-wire';
import type {LocalPlanet} from './planet-discovery';
import {parseFlowReading, parseProcess, parseReading, parseSwap, type DoctorFacts} from './ship-doctor';

/** The kelvin the bundled backend was built for when its packaged desk is not there to read. */
export const BUNDLED_KELVIN = 408;
const run = (file: string, args: string[]) => new Promise<string>((resolve, reject) =>
  execFile(file, args, {timeout: 5000, maxBuffer: 65536}, (error, stdout) => error ? reject(error) : resolve(String(stdout).trim())));
const attempt = async <T>(work: () => Promise<T>): Promise<T | undefined> => {try {return await work();} catch {return undefined;}};

/** One unauthenticated GET of the login page: milliseconds to the first response header, or null after 8 s. */
export function answerTime(origin: string, timeoutMs = 8000): Promise<number | null> {
  return new Promise(resolve => {
    const started = process.hrtime.bigint(); let done = false;
    const finish = (value: number | null) => {if (!done) {done = true; clearTimeout(timer); request.destroy(); resolve(value);}};
    const url = new URL('/~/login', origin);
    const request = (url.protocol === 'https:' ? https : http).request(url, {method: 'GET', agent: false}, response => {
      response.destroy(); finish(Number(process.hrtime.bigint() - started) / 1e6);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    request.on('error', () => finish(null)); request.end();
  });
}
export async function bundledKelvin(extensionPath: string): Promise<number> {
  const text = await attempt(() => readFile(path.join(extensionPath, 'backend/package/desk/sys.kelvin'), 'utf8'));
  const match = text ? /^\[%zuse (\d{3})\]\s*$/.exec(text) : null;
  return match ? Number(match[1]) : BUNDLED_KELVIN;
}
async function eventLogBytes(pier: string): Promise<number | undefined> {
  const root = path.join(pier, '.urb/log'); let total = 0, seen = false;
  for (const name of await readdir(root)) {
    const direct = name === 'data.mdb' ? path.join(root, name) : path.join(root, name, 'data.mdb');
    const size = await attempt(async () => (await stat(direct)).size);
    if (size !== undefined) {total += size; seen = true;}
  }
  return seen ? total : undefined;
}
/** Everything the doctor measures for a ship on this computer. Each reading is independent: one that fails is left out. */
export async function gatherFacts(planet: LocalPlanet, extensionPath: string): Promise<DoctorFacts> {
  const pid = String(planet.workerPid);
  const [httpMs, command, usage, snapshot, log, disk, swap, memory, kelvin] = await Promise.all([
    answerTime(planet.origin),
    attempt(() => run('/bin/ps', ['-p', pid, '-o', 'args='])),
    attempt(async () => parseProcess(await run('/bin/ps', ['-p', pid, '-o', '%cpu=,rss=']))),
    attempt(async () => (await stat(path.join(planet.pier, '.urb/chk/image.bin'))).size),
    attempt(() => eventLogBytes(planet.pier)),
    attempt(async () => {const s = await statfs(planet.pier); return Number(s.bavail) * Number(s.bsize);}),
    attempt(async () => parseSwap(await run('/usr/sbin/sysctl', ['-n', 'vm.swapusage']))),
    attempt(async () => Number(await run('/usr/sbin/sysctl', ['-n', 'hw.memsize']))),
    bundledKelvin(extensionPath),
  ]);
  const socket = path.join(planet.pier, '.urb/conn.sock');
  const failure = (error: unknown) => error instanceof NativeObservationFailure && error.reason === 'timeout' ? 'timeout' as const : 'unavailable' as const;
  const [readingResult, flowsResult] = await Promise.allSettled([
    queryDoctorReading(socket).then(parseReading), queryFlowsReading(socket).then(parseFlowReading)]);
  const reading = readingResult.status === 'fulfilled' ? readingResult.value : undefined, readingFailure = readingResult.status === 'rejected' ? failure(readingResult.reason) : undefined;
  const flows = flowsResult.status === 'fulfilled' ? flowsResult.value : undefined, flowsFailure = flowsResult.status === 'rejected' ? failure(flowsResult.reason) : undefined;
  return {ship: planet.ship, httpMs, bundledKelvin: kelvin,
    ...(command ? {command} : {}), ...(usage ? usage : {}),
    ...(snapshot !== undefined ? {snapshotBytes: snapshot} : {}), ...(log !== undefined ? {eventLogBytes: log} : {}), ...(disk !== undefined ? {freeDiskBytes: disk} : {}),
    ...(swap ? {swapUsedBytes: swap.usedBytes, swapTotalBytes: swap.totalBytes} : {}), ...(memory && Number.isSafeInteger(memory) ? {memoryBytes: memory} : {}),
    ...(reading ? {reading} : {}), ...(readingFailure ? {readingFailure} : {}), ...(flows ? {flows} : {}), ...(flowsFailure ? {flowsFailure} : {})};
}
