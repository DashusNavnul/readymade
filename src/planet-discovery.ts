import {execFile} from 'node:child_process';
import {lstat, realpath} from 'node:fs/promises';
import type {Stats} from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import {queryNative, NativeObservationFailure, LOCAL_OBSERVATION_TIMEOUT_MS, type NativeObservationReason} from './planet-discovery-wire';
export interface LocalPlanet {ship: string; origin: string; pier: string; workerPid: number; observedAt: number; socketDevice: string; socketInode: string}
const networkCodes = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR'] as const;
type EyreReason = 'timeout' | 'server' | 'status' | 'cookie' | 'network-other' | `network-${typeof networkCodes[number]}`;
type NativeStage = 'identity' | 'live' | 'real' | 'port' | 'stability';
export type DiscoveryStage = 'enumeration' | 'binding' | 'identity' | 'nonplanet' | 'live' | 'real' | 'fake' | 'port' | 'listener' | 'eyre' | 'stability' | `eyre-${EyreReason}` | `${NativeStage}-${NativeObservationReason}`;
class EyreFailure extends Error {constructor(readonly reason: EyreReason) {super('Local Eyre observation unavailable.');}}
export function eyreNetworkFailure(code: unknown): Error {
  return new EyreFailure(typeof code === 'string' && networkCodes.some(value => value === code) ? `network-${code as typeof networkCodes[number]}` : 'network-other');
}
export function eyreHeaderFailure(server: unknown, status: number | undefined, cookieNames: readonly string[], ship: string): Error | undefined {
  if (typeof server !== 'string' || !/^urbit(?:\/|$)/i.test(server)) return new EyreFailure('server');
  if (!status || status >= 500) return new EyreFailure('status');
  if (!cookieNames.every(name => name === 'urbauth-' + ship)) return new EyreFailure('cookie');
  return undefined;
}
export interface DiscoveryDiagnostics {readonly candidates: number; readonly verified: number; readonly duplicates: number; readonly deadline: boolean; readonly failureCounts: Readonly<Partial<Record<DiscoveryStage, number>>>}
export interface DiscoveryResult {planets: LocalPlanet[]; unavailable: number; diagnostics: DiscoveryDiagnostics}
interface Process {pid: number; parent: number; uid: number; command: string}
interface Candidate {pier: string; workerPid: number}
interface Binding {device: string; inode: string; stamp: string}
export function validPlanetFiles(stats: readonly Stats[], owner: number): boolean {
  return stats.length === 4 && stats.every(s => s.uid === owner && !s.isSymbolicLink()) && stats[0].isDirectory() && stats[1].isDirectory() && stats[2].isFile() && stats[3].isSocket();
}
const runtime = (command: string) => /^(?:urbit|vere(?:[-.][a-zA-Z0-9_.-]+)?)$/.test(path.basename(command));
export function parsePlanetProcesses(text: string, uid: number): Process[] {
  const rows: Process[] = [], seen = new Set<number>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([^\r\n]+)$/.exec(line);
    if (!m) continue;
    const [pid, parent, owner] = m.slice(1, 4).map(Number), command = m[4].trim();
    if (![pid, parent, owner].every(Number.isSafeInteger) || pid < 1 || owner !== uid || !runtime(command) || seen.has(pid)) continue;
    seen.add(pid); rows.push({pid, parent, uid: owner, command});
  }
  return rows;
}
export function parsePlanetLocks(text: string, processes: readonly Process[]): Candidate[] {
  const allowed = new Set(processes.map(p => p.pid)), rows: Candidate[] = [], seen = new Set<string>();
  let pid = 0;
  for (const line of text.split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (line.startsWith('n/') && allowed.has(pid)) {
      const file = line.slice(1);
      if (path.basename(file) !== '.vere.lock' || /[\u0000-\u001f\u007f]/.test(file)) continue;
      const pier = path.dirname(file), key = pid + ':' + pier;
      if (!seen.has(key)) {seen.add(key); rows.push({pier, workerPid: pid});}
    }
  }
  return rows;
}
interface Probes {
  candidates(signal: AbortSignal): Promise<Candidate[]>;
  binding(candidate: Candidate, signal: AbortSignal): Promise<Binding>;
  native(socket: string, kind: 'identity' | 'live' | 'http' | 'real', signal: AbortSignal): Promise<bigint | {ship: string; fake: boolean}>;
  listener(candidate: Candidate, port: number, signal: AbortSignal): Promise<string>;
  eyre(origin: string, ship: string, signal: AbortSignal): Promise<void>;
}
/** Injectable finite probe boundary; fixture dependencies never replace production discovery. */
export function localPlanetDiscovery(probes: Probes, budgetMs = 8000) {
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 8000) throw Error('Invalid discovery budget.');
  async function inspect(candidate: Candidate, signal: AbortSignal, stage: (value: DiscoveryStage) => void): Promise<LocalPlanet> {
    const read = async <T>(op: () => Promise<T>): Promise<T> => {signal.throwIfAborted(); const value = await op(); signal.throwIfAborted(); return value;};
    const before = await read(() => probes.binding(candidate, signal)), socket = path.join(candidate.pier, '.urb/conn.sock');
    stage('identity'); const identity = await read(() => probes.native(socket, 'identity', signal));
    if (typeof identity !== 'bigint' || identity < 65536n || identity >= 4294967296n) {stage('nonplanet'); throw Error('Not a planet.');}
    stage('live');
    if (await read(() => probes.native(socket, 'live', signal)) !== 0n) throw Error('Ship is not live.');
    stage('real'); const real = await read(() => probes.native(socket, 'real', signal));
    if (typeof real === 'object' && real.fake) {stage('fake'); throw Error('Not a real planet.');}
    if (typeof real !== 'object' || real.fake || !/^~[a-z]{6}-[a-z]{6}$/.test(real.ship)) throw Error('Not a real planet.');
    stage('port'); const port = await read(() => probes.native(socket, 'http', signal));
    if (typeof port !== 'bigint' || port < 1n || port > 65535n) throw Error('HTTP unavailable.');
    stage('listener'); const origin = await read(() => probes.listener(candidate, Number(port), signal));
    stage('eyre'); await read(() => probes.eyre(origin, real.ship, signal));
    stage('stability');
    if (await read(() => probes.native(socket, 'identity', signal)) !== identity) throw Error('Local identity changed.');
    const after = await read(() => probes.binding(candidate, signal));
    signal.throwIfAborted();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('Local ship changed.');
    return {ship: real.ship, origin, ...candidate, observedAt: Date.now(), socketDevice: before.device, socketInode: before.inode};
  }
  async function discover(): Promise<DiscoveryResult> {
    const controller = new AbortController(), found: LocalPlanet[] = [];
    let unavailable = 0, candidateCount = 0, enumerated = false, timer: NodeJS.Timeout | undefined;
    const failures: Partial<Record<DiscoveryStage, number>> = {}, active = new Map<number, DiscoveryStage>();
    const failed = (stage: DiscoveryStage) => {failures[stage] = (failures[stage] ?? 0) + 1;};
    const deadline = new Promise<void>(resolve => {timer = setTimeout(() => {controller.abort(); resolve();}, budgetMs);});
    const work = async () => {
      const candidates = await probes.candidates(controller.signal); controller.signal.throwIfAborted();
      candidateCount = candidates.length; enumerated = true;
      unavailable = Math.max(0, candidates.length - 24); let next = 0;
      await Promise.all(Array.from({length: Math.min(4, candidates.length)}, async () => {
        while (!controller.signal.aborted && next < Math.min(candidates.length, 24)) {
          const index = next++, candidate = candidates[index]; active.set(index, 'binding');
          try {found.push(await inspect(candidate, controller.signal, stage => active.set(index, stage)));}
          catch (error) {
            unavailable++; const stage = active.get(index)!;
            if (error instanceof NativeObservationFailure && ['identity', 'live', 'real', 'port', 'stability'].includes(stage)) failed(`${stage as NativeStage}-${error.reason}`);
            else failed(stage === 'eyre' && error instanceof EyreFailure ? `eyre-${error.reason}` : stage);
          }
          finally {active.delete(index);}
        }
      }));
    };
    try {
      await Promise.race([work().catch(() => {unavailable = Math.max(1, unavailable); failed('enumeration');}), deadline]);
      if (controller.signal.aborted) unavailable = Math.max(1, unavailable);
      const counts = new Map<string, number>(); found.forEach(p => counts.set(p.ship, (counts.get(p.ship) ?? 0) + 1));
      const planets = found.filter(p => counts.get(p.ship) === 1); unavailable += found.length - planets.length;
      const failureCounts = {...failures};
      if (controller.signal.aborted) {
        if (!enumerated && !failureCounts.enumeration) failureCounts.enumeration = 1;
        active.forEach(stage => {failureCounts[stage] = (failureCounts[stage] ?? 0) + 1;});
      }
      const diagnostics = Object.freeze({candidates: candidateCount, verified: found.length, duplicates: found.length - planets.length, deadline: controller.signal.aborted, failureCounts: Object.freeze(failureCounts)});
      return {planets: planets.sort((a, b) => a.ship.localeCompare(b.ship)), unavailable, diagnostics};
    } finally {clearTimeout(timer);}
  }
  return {discover, async recheck(candidate: LocalPlanet): Promise<LocalPlanet> {
    const result = await discover();
    const fresh = result.planets.find(p => p.ship === candidate.ship && p.pier === candidate.pier && p.workerPid === candidate.workerPid && p.origin === candidate.origin && p.socketDevice === candidate.socketDevice && p.socketInode === candidate.socketInode);
    if (!fresh) throw Error('This local planet changed or is unavailable. Refresh the list or use its address.');
    return fresh;
  }};
}
function command(file: string, args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => execFile(file, args, {encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024, signal}, (error, stdout) => error ? reject(Error('Local process information unavailable.')) : resolve(stdout)));
}
const uid = () => {if (process.platform !== 'darwin' || !process.getuid) throw Error('Local discovery is unavailable.'); return process.getuid();};
async function processes(signal: AbortSignal): Promise<Process[]> {const owner = uid(); return parsePlanetProcesses(await command('/bin/ps', ['-axo', 'pid=,ppid=,uid=,comm='], signal), owner);}
async function candidates(signal: AbortSignal): Promise<Candidate[]> {
  const rows = await processes(signal); if (!rows.length) return [];
  return parsePlanetLocks(await command('/usr/sbin/lsof', ['-nP', '-a', '-p', rows.map(r => r.pid).join(','), '-Fpn'], signal), rows);
}
async function binding(candidate: Candidate, signal: AbortSignal): Promise<Binding> {
  const rows = await processes(signal), row = rows.find(r => r.pid === candidate.workerPid);
  signal.throwIfAborted();
  if (!row || !path.isAbsolute(candidate.pier) || await realpath(candidate.pier) !== candidate.pier) throw Error('Local owner changed.');
  signal.throwIfAborted();
  const names = [candidate.pier, path.join(candidate.pier, '.urb'), path.join(candidate.pier, '.vere.lock'), path.join(candidate.pier, '.urb/conn.sock')];
  const stats = await Promise.all(names.map(name => lstat(name)));
  signal.throwIfAborted();
  if (!validPlanetFiles(stats, uid())) throw Error('Local ship paths unavailable.');
  const held = parsePlanetLocks(await command('/usr/sbin/lsof', ['-nP', '-a', '-p', String(row.pid), '-Fpn', '--', names[2]], signal), [row]);
  if (held.length !== 1 || held[0].pier !== candidate.pier) throw Error('Local lock holder changed.');
  return {device: String(stats[3].dev), inode: String(stats[3].ino), stamp: JSON.stringify([row, rows.find(p => p.pid === row.parent), stats.map(s => [s.dev, s.ino, s.uid])])};
}
export function planetListenerOrigin(output: string, allowed: readonly number[], port: number): string {
  let pid = 0, family = '';
  const origins = new Set<string>();
  for (const line of output.split('\n')) {
    if (/^p\d+$/.test(line)) {pid = Number(line.slice(1)); family = '';}
    else if (line.startsWith('f')) family = '';
    else if (line.startsWith('t')) family = line === 'tIPv4' || line === 'tIPv6' ? line.slice(1) : '';
    else if (allowed.includes(pid)) {
      if (family === 'IPv4' && (line === `n*:${port}` || line === `n127.0.0.1:${port}`)) origins.add(`http://127.0.0.1:${port}`);
      if (family === 'IPv6' && (line === `n*:${port}` || line === `n[::1]:${port}`)) origins.add(`http://[::1]:${port}`);
    }
  }
  const origin = origins.has(`http://127.0.0.1:${port}`) ? `http://127.0.0.1:${port}` : origins.values().next().value;
  if (!origin) throw Error('Local listener unavailable.');
  return origin;
}
async function listener(candidate: Candidate, port: number, signal: AbortSignal): Promise<string> {
  const rows = await processes(signal), worker = rows.find(p => p.pid === candidate.workerPid);
  signal.throwIfAborted();
  if (!worker) throw Error('Local runtime changed.');
  const allowed = [worker.pid], parent = rows.find(p => p.pid === worker.parent);
  if (parent && path.isAbsolute(parent.command) && path.isAbsolute(worker.command)) {
    const [parentPath, workerPath] = await Promise.all([realpath(parent.command), realpath(worker.command)]);
    signal.throwIfAborted(); if (parentPath === workerPath) allowed.push(parent.pid);
  }
  const output = await command('/usr/sbin/lsof', ['-nP', '-a', '-p', allowed.join(','), '-iTCP:' + port, '-sTCP:LISTEN', '-Fpnt'], signal);
  return planetListenerOrigin(output, allowed, port);
}
async function eyre(origin: string, ship: string, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = http.get(new URL('/~/login', origin), {signal, agent: false, timeout: LOCAL_OBSERVATION_TIMEOUT_MS, maxHeaderSize: 16384}, response => {
      const names = (response.headers['set-cookie'] ?? []).map(value => value.split('=', 1)[0]).filter(name => name.startsWith('urbauth-'));
      const failure = eyreHeaderFailure(response.headers.server, response.statusCode, names, ship);
      response.destroy(); request.destroy(); if (failure) reject(failure); else resolve();
    });
    request.on('timeout', () => {reject(new EyreFailure('timeout')); request.destroy();});
    request.on('error', error => reject(eyreNetworkFailure((error as NodeJS.ErrnoException).code)));
  });
}
const production = localPlanetDiscovery({candidates, binding, native: queryNative, listener, eyre});
export const discoverLocalPlanets = production.discover;
export const recheckLocalPlanet = production.recheck;
