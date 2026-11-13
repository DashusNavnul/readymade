import {FULL_INSTALL_LOOM, loomOf, shipRank} from './install-choice';
import {FLOWS_TIMEOUT_MS} from './planet-discovery-wire';

/**
 * The ship doctor: what a ship on this computer and the Mac under it measure right now, and what those
 * numbers mean. Reads only. Every rule here comes from a stall that was measured (2026-11-11 on a planet
 * with 87 agents): a worker 75% busy at rest from recurring timers, swap filled by browsers, a compile that
 * ran out of loom with a snapshot over half of it, and a pack refused for lack of free disk.
 */
export type FindingLevel = 'ok' | 'note' | 'warning' | 'problem';
export interface Finding {readonly id: string; readonly level: FindingLevel; readonly title: string; readonly detail: string}
export interface TimerRow {readonly seconds: number; readonly owner: string}
export interface ShipReading {readonly kelvin: number; readonly timers: number; readonly soon: readonly TimerRow[]}
/** The ship's paused connections: known peers, peers with a paused flow, paused flows, and paused peers heard within a day. */
export interface FlowReading {readonly known: number; readonly pausedShips: number; readonly pausedFlows: number; readonly heardCount: number; readonly heard: readonly string[]}
export interface DoctorFacts {
  readonly ship: string;
  /** Milliseconds the ship took to answer one small web request, or null when it did not answer in time. */
  readonly httpMs: number | null;
  /** The worker's command line as ps prints it, its CPU share over the sample, and resident bytes. */
  readonly command?: string; readonly cpuPercent?: number; readonly residentBytes?: number;
  readonly snapshotBytes?: number; readonly eventLogBytes?: number; readonly freeDiskBytes?: number;
  readonly swapUsedBytes?: number; readonly swapTotalBytes?: number; readonly memoryBytes?: number;
  /** What the ship itself reported over its owner-only socket, or the reason it could not. */
  readonly reading?: ShipReading; readonly readingFailure?: 'timeout' | 'unavailable';
  readonly flows?: FlowReading; readonly flowsFailure?: 'timeout' | 'unavailable';
  /** The kelvin the bundled backend was built for. */
  readonly bundledKelvin: number;
}
const GB = 1024 ** 3;
const gb = (bytes: number) => (bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1) + ' GB';

/** `sysctl -n vm.swapusage`: "total = 3072.00M  used = 1828.06M  free = 1243.94M  (encrypted)". */
export function parseSwap(text: string): {usedBytes: number; totalBytes: number} | undefined {
  const size = (name: string): number | undefined => {
    const match = new RegExp(`${name} = ([0-9]+(?:\\.[0-9]+)?)([KMG])`).exec(text);
    return match ? Math.round(Number(match[1]) * {K: 1024, M: 1024 ** 2, G: GB}[match[2] as 'K' | 'M' | 'G']) : undefined;
  };
  const usedBytes = size('used'), totalBytes = size('total');
  return usedBytes === undefined || totalBytes === undefined ? undefined : {usedBytes, totalBytes};
}
/** `ps -o %cpu=,rss= -p PID`: "  5.2 478880" (rss in KiB). */
export function parseProcess(text: string): {cpuPercent: number; residentBytes: number} | undefined {
  const match = /^\s*([0-9]+(?:[.,][0-9]+)?)\s+([0-9]+)\s*$/.exec(text);
  return match ? {cpuPercent: Number(match[1].replace(',', '.')), residentBytes: Number(match[2]) * 1024} : undefined;
}
/**
 * The ship's own reading, as the doctor strand prints it: "408 123 5:viki 9:portal ...". The first number is
 * the kelvin, the second the count of all pending timers, then up to 128 timers due within five minutes as
 * seconds-from-now and the agent or vane that set them. Anything else is refused whole.
 */
export function parseReading(text: string): ShipReading {
  if (typeof text !== 'string' || text.length > 16384) throw Error('Unreadable ship reading.');
  const words = text.split(' ');
  const number = (word: string | undefined): number => {
    if (!word || !/^[0-9]{1,3}(?:\.[0-9]{3})*$/.test(word)) throw Error('Unreadable ship reading.');
    return Number(word.replaceAll('.', ''));
  };
  const kelvin = number(words[0]), timers = number(words[1]);
  if (kelvin < 300 || kelvin > 500 || words.length > 130) throw Error('Unreadable ship reading.');
  const soon = words.slice(2).filter(word => word !== '').map(word => {
    const at = word.indexOf(':'), owner = word.slice(at + 1);
    if (at < 1 || !/^[a-z][a-z0-9-]{0,63}$/.test(owner)) throw Error('Unreadable ship reading.');
    return Object.freeze({seconds: number(word.slice(0, at)), owner});
  });
  if (soon.length > timers) throw Error('Unreadable ship reading.');
  return Object.freeze({kelvin, timers, soon: Object.freeze(soon)});
}
const dotted = (word: string | undefined): number => {
  if (!word || !/^[0-9]{1,3}(?:\.[0-9]{3})*$/.test(word)) throw Error('Unreadable flow reading.');
  return Number(word.replaceAll('.', ''));
};
/**
 * The paused-connection count as its strand prints it: "3.518 3.117 3.465 2 ~sampel-palnet ~zod".
 * Four counts, then at most 16 ship names, all of them paused ships heard within a day. Anything else is refused whole.
 */
export function parseFlowReading(text: string): FlowReading {
  if (typeof text !== 'string' || text.length > 4096) throw Error('Unreadable flow reading.');
  const words = text.split(' ');
  const [known, pausedShips, pausedFlows, heardCount] = words.slice(0, 4).map(dotted), heard = words.slice(4);
  const consistent = heard.length === Math.min(16, heardCount) && heardCount <= pausedShips && pausedShips <= known &&
    (pausedShips === 0 ? pausedFlows === 0 : pausedFlows >= pausedShips);
  if (!consistent || !heard.every(name => /^~(?:[a-z]{3}|[a-z]{6}(?:--?[a-z]{6}){0,7})$/.test(name))) throw Error('Unreadable flow reading.');
  return Object.freeze({known, pausedShips, pausedFlows, heardCount, heard: Object.freeze(heard)});
}
/** The runtime file name and flags a worker was started with. */
export function runtimeOf(command: string): {binary: string; loom: number | undefined; toss: number | undefined} {
  const binary = (command.trim().split(/\s+/)[0] ?? '').split('/').at(-1) ?? '';
  const toss = /\s--toss\s+(\d{1,4})(?:\s|$)/.exec(command);
  return {binary, loom: loomOf(command), toss: toss ? Number(toss[1]) : undefined};
}
function busiest(soon: readonly TimerRow[], within: number): [string, number][] {
  const counts = new Map<string, number>();
  for (const row of soon) if (row.seconds <= within) counts.set(row.owner, (counts.get(row.owner) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Every finding the facts support, most serious first. Missing facts produce a note, never a guess. */
export function doctorFindings(facts: DoctorFacts): Finding[] {
  const out: Finding[] = [];
  const add = (id: string, level: FindingLevel, title: string, detail: string) => out.push(Object.freeze({id, level, title, detail}));
  const rank = shipRank(facts.ship);
  // Answering.
  if (facts.httpMs === null) add('http', 'problem', 'The ship is not answering', 'One small web request got no answer in 8 seconds. The ship is stopped, or one long event is running; ships answer nothing while an event runs.');
  else if (facts.httpMs > 1000) add('http', 'warning', 'The ship answers slowly', `One small web request took ${(facts.httpMs / 1000).toFixed(1)} s. A healthy ship answers in well under a tenth of a second.`);
  else add('http', 'ok', 'The ship answers', `One small web request took ${Math.round(facts.httpMs)} ms.`);
  // Runtime and memory arena.
  const runtime = facts.command ? runtimeOf(facts.command) : undefined, loom = runtime?.loom ?? (facts.command ? 31 : undefined);
  if (runtime) {
    add('runtime', 'ok', 'Runtime', `${runtime.binary}, --loom ${runtime.loom ?? '31 (the default)'}${runtime.toss !== undefined ? `, --toss ${runtime.toss}` : ''}. Always start this ship with this same runtime file: a different one refuses its snapshot.`);
    if ((loom ?? 0) < FULL_INSTALL_LOOM) add('loom', rank === 'moon' || rank === 'comet' ? 'note' : 'warning', 'Too little memory for all of Pataphor',
      `The ship was started with --loom ${loom}. Building all of Pataphor needs --loom ${FULL_INSTALL_LOOM}; the collaboration service alone runs fine.`);
  } else add('runtime', 'note', 'Runtime not read', 'The ship\'s process was not found on this computer, so its runtime, memory and snapshot were not measured.');
  if (facts.snapshotBytes !== undefined && loom !== undefined) {
    const arena = 2 ** loom, share = facts.snapshotBytes / arena;
    if (share >= 0.5) add('snapshot', 'warning', 'The snapshot fills over half the ship\'s memory arena',
      `Snapshot ${gb(facts.snapshotBytes)} of a ${gb(arena)} arena (--loom ${loom}). A large compile needs about 3 GB of working room and fails with “bail: meme” when it is not there. Restart the ship with the next larger --loom, or pack it while stopped.`);
    else add('snapshot', 'ok', 'Snapshot size', `${gb(facts.snapshotBytes)} of a ${gb(arena)} arena.`);
  }
  if (facts.snapshotBytes !== undefined && facts.freeDiskBytes !== undefined) {
    if (facts.freeDiskBytes < 3 * facts.snapshotBytes) add('disk', 'warning', 'Too little free disk to pack or upgrade safely',
      `${gb(facts.freeDiskBytes)} free; packing or a runtime upgrade writes about three snapshots (${gb(3 * facts.snapshotBytes)}).`);
    else add('disk', 'ok', 'Free disk', `${gb(facts.freeDiskBytes)} free; the snapshot is ${gb(facts.snapshotBytes)}.`);
  }
  if (facts.eventLogBytes !== undefined && facts.snapshotBytes !== undefined && facts.eventLogBytes > 2 * facts.snapshotBytes + 2 * GB)
    add('log', 'note', 'The event log can be shortened', `Event log ${gb(facts.eventLogBytes)}. With the ship stopped, “roll” then “chop” keeps the newest two epochs.`);
  // The Mac.
  if (facts.swapUsedBytes !== undefined && facts.swapTotalBytes !== undefined) {
    const heavy = facts.swapUsedBytes >= 4 * GB || facts.memoryBytes !== undefined && facts.swapUsedBytes >= facts.memoryBytes / 2;
    if (heavy) add('swap', 'warning', 'The Mac is short of memory',
      `${gb(facts.swapUsedBytes)} of swap in use${facts.memoryBytes ? ` on a ${gb(facts.memoryBytes)} Mac` : ''}. Ships stall when their pages are swapped out. Quit the largest other apps first (browsers were the cause when this was measured), then check again.`);
    else add('swap', 'ok', 'Mac memory', `${gb(facts.swapUsedBytes)} of swap in use.`);
  }
  // Work at rest.
  const soon = facts.reading?.soon ?? [], minute = busiest(soon, 60);
  const perMinute = minute.reduce((sum, row) => sum + row[1], 0);
  if (facts.cpuPercent !== undefined) {
    if (facts.cpuPercent >= 50) add('busy', 'warning', 'The ship is busy while nothing is being asked of it',
      `Its worker used ${Math.round(facts.cpuPercent)}% of a processor over the sample. A ship does one thing at a time, so everything else waits behind recurring work.` +
      (minute.length ? ` Timers due in the next minute: ${minute.slice(0, 5).map(([owner, count]) => `${owner} ×${count}`).join(', ')}.` : ''));
    else add('busy', 'ok', 'Work at rest', `The worker used ${Math.round(facts.cpuPercent)}% of a processor over the sample.`);
  }
  if (facts.reading) {
    if (perMinute >= 30) add('timers', 'warning', 'Many timers fire every minute', `${perMinute} timers are due in the next minute (${facts.reading.timers} pending in all): ` +
      `${minute.slice(0, 6).map(([owner, count]) => `${owner} ×${count}`).join(', ')}. Each one is an event the ship must finish before it answers anything else.`);
    else add('timers', 'ok', 'Timers', `${perMinute} due in the next minute, ${facts.reading.timers} pending in all.`);
    if (facts.reading.kelvin !== facts.bundledKelvin) add('kelvin', 'warning', 'The ship\'s system version differs from this app\'s backend',
      `The ship is at kelvin ${facts.reading.kelvin}; the bundled backend is built for ${facts.bundledKelvin}. Kelvin counts down: a lower number is newer. Update the ship or the app until they match before installing.`);
    else add('kelvin', 'ok', 'System version', `Kelvin ${facts.reading.kelvin}, the one the bundled backend is built for.`);
  } else if (facts.readingFailure === 'timeout') add('reading', 'warning', 'The ship did not report on itself in time', 'Its own socket took over 5 seconds for a small read. It is busy; check again when it is quiet.');
  else add('reading', 'note', 'Timers and system version not read', 'Only a ship running on this computer can be asked for these.');
  // Paused connections. Ames pauses a flow by itself when a peer asks for an app that is not running here, and
  // an operator (or a dead-peer job) can pause one by hand; the two look the same from here, so a paused ship that
  // is online is a warning only together with a busy worker, the signature measured on 2026-11-12.
  const count = (n: number) => n.toLocaleString('en-US');
  if (facts.flows) {
    const f = facts.flows;
    if (f.heardCount) {
      const busy = facts.cpuPercent !== undefined && facts.cpuPercent >= 50;
      const names = f.heard.join(', ') + (f.heardCount > f.heard.length ? ` and ${count(f.heardCount - f.heard.length)} more` : '');
      add('paused', busy ? 'warning' : 'note', 'Paused connections to ships that are online',
        `${count(f.heardCount)} ship${f.heardCount === 1 ? '' : 's'} heard from in the last day ${f.heardCount === 1 ? 'has' : 'have'} a paused connection: ${names}. ` +
        'A paused connection throws away everything that ship sends, and the ship keeps sending it again. ' +
        'The ship pauses one by itself when a peer asks for an app that is not running here, and resumes it when that app starts; a pause set by hand stays until it is resumed by hand.' +
        (busy ? ' The worker is also busy at rest: one online ship with paused connections kept a planet\'s worker 57% busy until they were resumed (measured 2026-11-12).' : ''));
    } else add('paused', 'ok', 'Paused connections', f.pausedFlows
      ? `${count(f.pausedFlows)} connection${f.pausedFlows === 1 ? '' : 's'} to ${count(f.pausedShips)} of ${count(f.known)} known ships ${f.pausedFlows === 1 ? 'is' : 'are'} paused; none of those ships was heard from in the last day.`
      : `No connection to any of ${count(f.known)} known ships is paused.`);
  } else if (facts.flowsFailure === 'timeout') add('paused', 'note', 'Paused connections not counted', `The count did not finish in ${FLOWS_TIMEOUT_MS / 1000} seconds. The ship may be busy, or know a very large number of other ships.`);
  else if (facts.flowsFailure) add('paused', 'note', 'Paused connections not counted', 'This ship\'s networking state could not be read; its system may be older than this check.');
  const order: Record<FindingLevel, number> = {problem: 0, warning: 1, note: 2, ok: 3};
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

/** The recovery recipe for one ship on this computer, with its real paths. Plain text, meant to be saved outside the app. */
export function recoveryRecipe(ship: string, pier: string, command: string | undefined): string {
  const runtime = command ? runtimeOf(command) : undefined, binary = command?.trim().split(/\s+/)[0];
  const start = binary ? `${binary} --loom ${runtime?.loom ?? 31} ${pier}` : `<the runtime that last ran it> ${pier}`;
  return [
    `Recovery recipe for ${ship}`,
    '',
    `Pier (the whole ship): ${pier}`,
    `Runtime it must be started with: ${binary ?? 'not read (the ship is not running)'}`,
    'A ship only opens with the runtime that wrote its snapshot. Keep that file; do not replace it in place.',
    '',
    'Back up (about a minute):',
    '  1. Stop the ship: press Ctrl-D in its terminal, or quit it from the app. Never copy a running pier.',
    `  2. Copy the pier folder:  cp -Rc "${pier}" "${pier}.backup-$(date +%Y%m%d)"`,
    '     (-c makes an instant copy on a Mac disk and takes no extra space until the ship changes.)',
    `  3. Start it again:  ${start}`,
    '',
    'Restore:',
    '  1. Stop the ship if it runs.',
    `  2. Move the broken pier aside:  mv "${pier}" "${pier}.broken"`,
    `  3. Copy the backup back:  cp -Rc "${pier}.backup-YYYYMMDD" "${pier}"`,
    `  4. Start it with the same runtime:  ${start}`,
    '',
    'Never run a backup and the original at the same time: two copies of one ship on the network break its',
    'connections to every other ship. A restored backup that is older than the ship\'s last networking will need',
    'a breach (a factory reset of its network identity) before others hear it again.',
    '',
    'If it says “stale snapshot”: that is the wrong runtime for this pier, not damage. Use the runtime named above.',
    'If it stops with “bail: meme”: it ran out of memory arena. Start it once with the next larger --loom.',
  ].join('\n');
}
