/**
 * Which install to offer a ship that has no Pataphor yet. Measured, not guessed: building all of Pataphor
 * needs an 8 GiB address space (--loom 33; smaller ones ran out of memory compiling Viki) and takes a ship
 * that stays up, so moons and comets, and any ship started with less memory, are offered the collaboration
 * service alone. That is enough to join other people's projects; hosting your own needs the full install.
 */
export type ShipRank = 'galaxy' | 'star' | 'planet' | 'moon' | 'comet';
export type InstallKind = 'full' | 'guest';
export interface InstallChoice {
  /** What to offer first. */
  readonly recommended: InstallKind;
  /** Whether the full install can run on this ship as it was started. */
  readonly fullPossible: boolean;
  /** One plain sentence for the person, naming the measured reason. */
  readonly reason: string;
}
export const FULL_INSTALL_LOOM = 33;
const part = '[a-z]{6}';
/** The rank a ship's own name states. Names are checked against Jael before they get here. */
export function shipRank(ship: string): ShipRank | undefined {
  if (/^~[a-z]{3}$/.test(ship)) return 'galaxy';
  if (new RegExp(`^~${part}$`).test(ship)) return 'star';
  if (new RegExp(`^~${part}-${part}$`).test(ship)) return 'planet';
  if (new RegExp(`^~${part}-${part}-${part}-${part}$`).test(ship)) return 'moon';
  if (new RegExp(`^~${part}-${part}-${part}-${part}--${part}-${part}-${part}-${part}$`).test(ship)) return 'comet';
  return undefined;
}
/** The --loom exponent in a running ship's command line, or undefined when it names none (vere's default is 31). */
export function loomOf(commandLine: string): number | undefined {
  const match = /\s--loom\s+(\d{1,2})(?:\s|$)/.exec(commandLine);
  return match ? Number(match[1]) : undefined;
}
export function installChoice(ship: string, loom: number | undefined): InstallChoice {
  const rank = shipRank(ship);
  if (!rank) throw Error('Invalid ship.');
  const enough = loom !== undefined && loom >= FULL_INSTALL_LOOM;
  if (rank === 'moon' || rank === 'comet') return Object.freeze({recommended: 'guest', fullPossible: enough,
    reason: `${ship} is a ${rank}. It can join shared projects with the collaboration service alone; all of Pataphor is meant for a planet or larger.`});
  if (!enough) return Object.freeze({recommended: 'guest', fullPossible: false,
    reason: `${ship} was started with too little memory to build all of Pataphor (${loom === undefined ? 'no --loom given' : `--loom ${loom}`}; it needs --loom ${FULL_INSTALL_LOOM}). It can still join shared projects with the collaboration service alone.`});
  return Object.freeze({recommended: 'full', fullPossible: true,
    reason: `${ship} is a ${rank} with enough memory for all of Pataphor.`});
}
