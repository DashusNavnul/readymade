import {remoteShip} from './remote-project-view';

/**
 * The collaboration service a guest's own ship needs before it can join a shared project: the
 * %readymade-collab agent, installed by the ship's own kiln from a published desk. Joining
 * needs nothing else (no local coding worker, no Viki). Kiln keeps the installed desk synced to
 * its source, so an owner's update reaches every guest without another step.
 */
export const GUEST_DESK = 'readymade-peer';
/** The published source. ~dashus-navnul serves it publicly readable, never running it there. */
export const GUEST_SOURCE: GuestSource = Object.freeze({ship: '~dashus-navnul', desk: 'readymade-peer'});
/** A collaboration route that answers a bare GET with a refusal when the agent is bound (measured: 400 JSON). */
export const GUEST_PROBE_PATH = '/apps/readymade-collab/project-invitation-requests';
export const GUEST_PIKES_PATH = '/~/scry/hood/kiln/pikes.json';
export interface GuestSource {readonly ship: string; readonly desk: string}
export type GuestServiceStatus = 'ready' | 'starting' | 'suspended' | 'missing';
export interface GuestServiceState {
  readonly status: GuestServiceStatus;
  /** Where the local desk syncs from, when the ship has one; another source is reported, not replaced. */
  readonly source: GuestSource | null;
}
type Row = Record<string, unknown>;
const record = (value: unknown): Row | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
const desk = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);

/**
 * `present`: the agent answered; `absent`: Eyre has no binding; `down`: a binding whose agent is not running
 * (measured: 503 after the desk was suspended); `unknown`: anything else, which proves nothing.
 */
export function guestServiceProbe(status: number, json: unknown): 'present' | 'absent' | 'down' | 'unknown' {
  if (status === 404) return 'absent';
  if (status === 503 && record(json) === undefined) return 'down';
  if ([200, 400, 409, 422].includes(status) && record(json) !== undefined) return 'present';
  return 'unknown';
}
/** The local guest desk as kiln reports it, or null when the ship has none. Malformed reports throw. */
export function guestServiceDesk(pikes: unknown): {zest: 'live' | 'held' | 'dead'; source: GuestSource | null} | null {
  const all = record(pikes); if (!all) throw Error('Kiln returned an unreadable desk list.');
  const entry = all[GUEST_DESK]; if (entry === undefined) return null;
  const row = record(entry); if (!row) throw Error('Kiln returned an unreadable desk list.');
  if (!['live', 'held', 'dead'].includes(String(row.zest))) throw Error('Kiln returned an unreadable desk list.');
  let source: GuestSource | null = null;
  if (row.sync !== null) {
    const sync = record(row.sync);
    if (!sync || !remoteShip(sync.ship) || !desk(sync.desk)) throw Error('Kiln returned an unreadable desk list.');
    source = Object.freeze({ship: sync.ship, desk: sync.desk});
  }
  return {zest: row.zest as 'live' | 'held' | 'dead', source};
}
/**
 * A bound agent is ready whatever desk serves it (a full Readymade backend runs it from its own desk).
 * A dead binding with no guest desk belongs to another installation: that is never installed over.
 */
export function guestServiceState(probe: 'present' | 'absent' | 'down', local: ReturnType<typeof guestServiceDesk>): GuestServiceState {
  if (probe === 'present') return Object.freeze({status: 'ready', source: local?.source ?? null});
  if (!local && probe === 'down') throw Error('Your ship has a collaboration route that is not answering, from another installation. Check that installation; nothing was installed.');
  if (!local) return Object.freeze({status: 'missing', source: null});
  return Object.freeze({status: local.zest === 'live' ? 'starting' : 'suspended', source: local.source});
}
/**
 * The Eyre channel actions that ask the ship's own kiln to install the guest desk and, for a desk that was
 * suspended, to revive it. Kiln marks a suspended desk it installs into as held, to wake on the next commit;
 * when the source is unchanged no commit comes (measured on a moon), so revive is sent after install.
 */
export function guestInstallActions(our: string, source: GuestSource = GUEST_SOURCE, revive = false): unknown[] {
  if (!remoteShip(our) || !remoteShip(source.ship) || !desk(source.desk)) throw Error('Invalid collaboration service source.');
  if (source.ship === our) throw Error('A ship cannot install the collaboration service from itself.');
  const install = {id: 1, action: 'poke', ship: our.slice(1), app: 'hood', mark: 'kiln-install', json: {local: GUEST_DESK, ship: source.ship, desk: source.desk}};
  return revive ? [install, {id: 2, action: 'poke', ship: our.slice(1), app: 'hood', mark: 'kiln-revive', json: GUEST_DESK}] : [install];
}
export function guestServiceMessage(state: GuestServiceState): string {
  if (state.status === 'ready') return 'This ship runs the collaboration service.';
  if (state.status === 'starting') return 'The collaboration service is installed and still starting.';
  if (state.status === 'suspended') return 'The collaboration service is installed but suspended on this ship.';
  return 'This ship does not have the collaboration service yet.';
}
