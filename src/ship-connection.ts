import {ShipClient, ShipClientError, type TransportDetail} from './ship-client';

/** One plain sentence for a connection that got no answer, naming what was measured: slow, down, unknown address or dropped. */
export function connectionFailureMessage(origin: string, detail: TransportDetail | undefined, moved?: {ship: string; origin: string}): string {
  let host = origin, local = false;
  try {const url = new URL(origin); host = url.host; local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);} catch { /* shown as given */ }
  if (moved) return `${moved.ship} no longer answers at ${host}. It is running at ${new URL(moved.origin).host} now (its port changed when it restarted).`;
  if (detail === 'slow') return `Your ship at ${host} is running but did not answer in time. It may be busy; wait a moment and connect again.`;
  if (detail === 'down') return local ? `Nothing is answering at ${host}. Your ship is stopped, or it restarted on another port: choose it again from Connect.` :
    `${host} refused the connection. The ship may be stopped; check with whoever hosts it.`;
  if (detail === 'unknownHost') return `The address ${host} was not found. Check the spelling of your ship’s web address.`;
  if (detail === 'dropped') return `The connection to ${host} dropped before your ship answered. It may be restarting; connect again in a moment.`;
  return 'Could not reach your Urbit. Check that its web address opens in your browser.';
}

/** Friendly address admission; ShipClient's strict transport boundary stays intact. */
export function normalizeShipAddress(raw: string): string {
  try {
    if (typeof raw !== 'string' || raw.length > 2048 || /[\\\x00-\x1f\x7f-\x9f?#%@]/u.test(raw)) throw Error();
    const input = raw.trim();
    if (!input || /\s/u.test(input)) throw Error();
    const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/i.test(input);
    const address = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `${local ? 'http' : 'https'}://${input}`;
    const url = new URL(address), authority = address.split('/')[2]!, host = url.hostname.toLowerCase();
    const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(host);
    const literalHost = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0]!;
    if (literalHost.toLowerCase() !== host || url.username || url.password || url.port === '0' ||
        !(url.protocol === 'https:' || url.protocol === 'http:' && isLocal)) throw Error();
    if (!isLocal && (!host.includes('.') || host.length > 253 || !host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)))) throw Error();
    const rawPath = address.slice(address.indexOf('/', address.indexOf('://') + 3));
    const path = address.indexOf('/', address.indexOf('://') + 3) < 0 ? '/' : rawPath;
    if (path.split('/').some(part => part === '.' || part === '..') || path.includes('//') ||
        !(path === '/' || /^\/~\/login\/?$/.test(path) || /^\/apps\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.~-]+)*\/?$/.test(path))) throw Error();
    // Let the unchanged low-level constructor make the final origin decision.
    const client = new ShipClient(url.origin); client.close(); return client.origin;
  } catch {
    const error = new ShipClientError('invalidOrigin');
    error.message = 'Enter your ship’s web address, such as ship.example or localhost:8080.';
    throw error;
  }
}

export interface SwitchTarget {readonly origin: string; readonly ship?: string}
/** The remembered switch target, strictly: a normalized origin and, for a ship on this computer, its name. */
export function switchTarget(value: unknown): SwitchTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid switch target.');
  const row = value as Record<string, unknown>, keys = Object.keys(row);
  if (typeof row.origin !== 'string' || normalizeShipAddress(row.origin) !== row.origin || keys.some(k => k !== 'origin' && k !== 'ship') ||
      row.ship !== undefined && (typeof row.ship !== 'string' || !/^~(?:[a-z]{3}|[a-z]{6}(?:-[a-z]{6}){0,3}(?:--[a-z]{6}(?:-[a-z]{6}){3})?)$/.test(row.ship))) throw Error('Invalid switch target.');
  return Object.freeze({origin: row.origin, ...(row.ship !== undefined ? {ship: row.ship} : {})});
}

export interface ShipAuthenticationOptions {
  expectedShip?: string;
  readCode(origin: string): Promise<string | undefined>;
  askCode(origin: string, rejected: boolean): Promise<string | undefined>;
  saveCode(origin: string, code: string): Promise<void>;
  ensureOpen(): void;
  onClient?(client: ShipClient): void;
}
export async function authenticateShip(origin: string, options: ShipAuthenticationOptions): Promise<ShipClient> {
  const expectedShip = options.expectedShip;
  if (expectedShip !== undefined && (typeof expectedShip !== 'string' || expectedShip.length > 128 ||
      !/^~(?:[a-z]{3}|[a-z]{6}(?:-[a-z]{6}){0,3}(?:--[a-z]{6}(?:-[a-z]{6}){3})?)(?![\s\S])/.test(expectedShip))) {
    const error = new ShipClientError('identityUnavailable');
    error.message = 'The selected ship could not be identified. Choose it again from Connect.';
    throw error;
  }
  let replacement: string | undefined;
  const client = new ShipClient(origin, async address => {
    options.ensureOpen();
    if (replacement !== undefined) return replacement;
    const remembered = await options.readCode(address); options.ensureOpen(); return remembered;
  });
  try {
    options.onClient?.(client); options.ensureOpen();
    let rejected = false;
    for (;;) {
      try {
        options.ensureOpen(); await client.signIn(); options.ensureOpen();
        const cookies = client.browserCookies(origin);
        if (cookies.length !== 1 || !/^urbauth-~[a-z-]{3,128}(?![\s\S])/.test(cookies[0]!.name)) throw new ShipClientError('identityUnavailable');
        if (expectedShip !== undefined && cookies[0]!.name !== 'urbauth-' + expectedShip) throw new ShipClientError('identityUnavailable');
        if (replacement !== undefined) {
          try {options.ensureOpen(); await options.saveCode(origin, replacement); options.ensureOpen();}
          catch {options.ensureOpen(); throw new ShipClientError('credentialStorage');}
        }
        return client;
      } catch (error) {
        options.ensureOpen();
        const credentials = error instanceof ShipClientError && (error.code === 'noSavedCode' ||
          error.code === 'authenticationRequired' && (error.status === undefined || [400, 401, 403].includes(error.status)));
        if (!credentials) throw error;
        rejected = rejected || error.code === 'authenticationRequired' || replacement !== undefined;
      }
      options.ensureOpen(); replacement = await options.askCode(origin, rejected); options.ensureOpen();
      if (!replacement) throw new ShipClientError('cancelled');
    }
  } catch (error) {
    client.close(); options.ensureOpen();
    if (error instanceof ShipClientError) {
      if (error.code === 'credentialStorage') error.message = 'Your login could not be saved securely. Check this computer’s credential storage and reconnect.';
      else if (error.code === 'identityUnavailable') error.message = expectedShip !== undefined ?
        'The selected ship’s connection changed. Choose your ship again from Connect; your login code has not been saved.' :
        'The server did not identify one Urbit. Check that this is your ship’s web address.';
      else if (error.code === 'authenticationRequired') error.message = [400, 401, 403].includes(error.status ?? 0) ?
        'Your ship did not accept the login code. Type +code in the ship’s terminal for the current one, then connect again.' :
        'Your ship could not complete sign-in. Check that it opens normally in your browser.';
      else if (['transport', 'timeout'].includes(error.code)) error.message = connectionFailureMessage(origin, error.detail);
      throw error;
    }
    const failure = new ShipClientError('connectionFailed');
    failure.message = 'Could not connect to your Urbit. Check that its web address opens in your browser.';
    throw failure;
  }
}
