import * as http from 'node:http';
import * as https from 'node:https';
import { asRecord, codingSnapshot, isUx, type CodingSnapshot } from './protocol';
import { ShipClientError, type ShipClient } from './ship-client';
import { WorkspaceRequestStore } from './workspace-request-store';
import {invitationCatalog} from './project-invitations';
import {remoteShip} from './remote-project-view';

export interface SetupCheck { name: string; status: 'observed' | 'missing' | 'unverified'; detail: string }
export interface SetupReport { origin: string; owner?: string; checks: SetupCheck[] }
type Client = Pick<ShipClient, 'origin' | 'browserCookies' | 'requestJSON' | 'workspaceRequest' | 'projectInvitation'>;
const apps = {Lattice: '/apps/lattice/app', Landscape: '/apps/landscape/', Groups: '/apps/groups/', Glurff: '/apps/glurff/', Calls: '/apps/noltbook/'};
function failure(error: unknown): string {
  if (error instanceof ShipClientError) return `${error.code}${error.status ? ` (HTTP ${error.status})` : ''}. Login and backend compatibility are separate checks.`;
  return 'Response unavailable or incompatible. No installation or execution was attempted.';
}
/** One bounded GET; never follow redirects, execute a page, or retain its contents. */
async function page(client: Client, name: string, path: string): Promise<SetupCheck> {
  const cookies = client.browserCookies(client.origin).map(c => `${c.name}=${c.value}`).join('; ');
  return new Promise(resolve => {
    let done = false;
    const finish = (status: SetupCheck['status'], detail: string): void => {
      if (done) return; done = true; clearTimeout(timer); resolve({name, status, detail});
    };
    const url = new URL(path, client.origin);
    const request = (url.protocol === 'https:' ? https : http).request(url, {method: 'GET', headers: {Cookie: cookies, Accept: 'text/html'}, agent: false}, response => {
      const status = response.statusCode ?? 0;
      // Presence is header-level evidence only; do not download arbitrary app bodies.
      if (status === 200 && response.headers['content-type']?.split(';')[0].trim().toLowerCase() === 'text/html') finish('observed', `${path} returned HTML. Page execution and app functionality remain unverified.`);
      else if (status === 404) finish('missing', `${path} returned HTTP 404. Install or repair this app separately with its publisher's instructions.`);
      else finish('unverified', `${path} returned HTTP ${status}; redirects are not followed. Check authentication, routing and app availability separately.`);
      response.destroy(); request.destroy();
    });
    const timer = setTimeout(() => { finish('unverified', 'Page probe timed out; no retry was sent.'); request.destroy(); }, 8000);
    request.on('error', () => finish('unverified', 'Page probe failed; no retry was sent.'));
    request.end();
  });
}
export async function checkSetup(client: Client, onProgress?: (report: SetupReport) => void): Promise<SetupReport> {
  const report: SetupReport = {origin: client.origin, checks: []};
  // Presentation receives only detached, already-sanitized observations.
  const progress = (): void => {try {onProgress?.(structuredClone(report));} catch { /* Presentation cannot alter protocol checks. */ }};
  let actor: string;
  try {
    const cookies = client.browserCookies(client.origin);
    if (cookies.length !== 1 || !cookies[0]!.name.startsWith('urbauth-') || !remoteShip(cookies[0]!.name.slice(8))) throw Error('Invalid authenticated identity');
    actor = cookies[0]!.name.slice(8);
  }
  catch { report.checks.push({name: 'Authentication', status: 'missing', detail: 'No current authenticated client session. Sign in through the private application password field.'}); progress(); return report; }
  report.checks.push({name: 'Authentication', status: 'observed', detail: 'An exact-origin login session is retained. Each endpoint must still accept it; this does not establish backend compatibility.'});
  progress();
  // Peer collaboration does not depend on this ship running its own coding worker.
  // Finish this bounded read before another operation uses the client's command gate.
  const invitations = client.projectInvitation('requests', {}).then<SetupCheck>(reply => {
    if (reply.status !== 200) return {name: 'Project invitations', status: reply.status === 404 ? 'missing' : 'unverified', detail: `Invitation service returned HTTP ${reply.status}. No invitation was accepted or sent.`};
    invitationCatalog(reply.body, actor);
    return {name: 'Project invitations', status: 'observed', detail: 'This ship supports project invitations. An owner-supplied invitation and current project permissions are still required; no membership or execution access was granted.'};
  }).catch((error): SetupCheck => ({name: 'Project invitations', status: 'unverified', detail: failure(error)}));
  const pages = await Promise.allSettled(Object.entries(apps).map(([name, path]) => page(client, name, path)));
  pages.forEach((result, index) => report.checks.push(result.status === 'fulfilled' ? result.value : {name: Object.keys(apps)[index], status: 'unverified', detail: 'Page probe unavailable.'}));
  progress();
  report.checks.push(await invitations);
  progress();
  let workspaceOwner: string | undefined, coding: CodingSnapshot | undefined;
  try {
    const workspace = await client.requestJSON('/apps/pataphor/remote/state.json', {timeoutMs: 8000});
    if (workspace.ship !== actor) throw new Error('Invalid workspace identity');
    workspaceOwner = workspace.ship;
    report.checks.push({name: 'Pataphor workspace', status: 'observed', detail: `Workspace identity returned for ${workspaceOwner}; this is not full execution compatibility.`});
  } catch (error) { report.checks.push({name: 'Pataphor workspace', status: 'unverified', detail: failure(error)}); }
  progress();
  try {
    coding = codingSnapshot(await client.requestJSON('/apps/pataphor-native/coding/state?0x0&0&0x0', {timeoutMs: 8000}));
    if (coding.session !== '0x0' || coding.owner !== actor || !workspaceOwner || coding.owner !== workspaceOwner) throw new Error('Owner identity unavailable or inconsistent');
    if (!coding.projects.every(p => typeof p.id === 'string' && p.id.length > 0) || !coding.sessions.every(s => isUx(s.id) && s.id !== '0x0' && typeof s.project === 'string' && coding!.projects.some(p => p.id === s.project))) throw new Error('Invalid project/session metadata');
    report.owner = coding.owner;
    report.checks.push({name: 'Native coding protocol', status: coding.ready ? 'observed' : 'missing', detail: coding.ready ? 'Coding snapshot schema and workspace owner match. Worker execution has not been tested.' : 'Native coding snapshot reports ready=false.'});
    report.checks.push({name: 'Projects and sessions', status: coding.projects.length && coding.sessions.length ? 'observed' : 'missing', detail: `${coding.projects.length} registered projects; ${coding.sessions.length} retained sessions. A session alone does not prove a current worker, grant or source. Missing projects/sessions require native onboarding.`});
  } catch (error) { coding = undefined; report.checks.push({name: 'Native coding protocol', status: 'unverified', detail: failure(error)}); }
  progress();
  if (coding && report.owner) {
    const store = new WorkspaceRequestStore(report.owner, client);
    try { await store.load(); report.checks.push({name: 'Shared request catalog', status: 'observed', detail: `Owner-bound catalog protocol validated; ${store.catalog!.total} retained requests. No request submitted.`}); }
    catch (error) { report.checks.push({name: 'Shared request catalog', status: 'unverified', detail: failure(error)}); }
    finally { store.dispose(); }
    try {
      const options = await client.requestJSON('/apps/readymade-collab/workspace-import-options', {timeoutMs: 8000});
      if (Buffer.byteLength(JSON.stringify(options)) > 65536 || options.schema !== 'readymade-workspace-import-options-v1' || options.owner !== report.owner || options.session !== null || options.executionAuthorized !== false ||
          !Array.isArray(options.notes) || options.notes.length > 64 || !options.notes.every(v => {const n = asRecord(v); return typeof n.id === 'string' && !!n.id && Buffer.byteLength(n.id) <= 128 && typeof n.title === 'string' && Buffer.byteLength(n.title) <= 256;}) ||
          !Array.isArray(options.grants) || options.grants.length !== 0) throw new Error('Invalid detached import options');
      report.checks.push({name: 'Shared message import', status: options.notes.length ? 'observed' : 'missing', detail: `${options.notes.length} shared notes available. Session-specific grants, message selection and admission still require separate checks.`});
    } catch (error) { report.checks.push({name: 'Shared message import', status: 'unverified', detail: failure(error)}); }
  } else report.checks.push({name: 'Shared coding checks', status: 'unverified', detail: 'A matching workspace/coding owner is required before trusting catalogs and import choices.'});
  report.checks.push({name: 'Backend installation and joining', status: 'unverified', detail: 'These observations do not install apps or qualify a complete installation. Actual joining, current grants, available workers and multi-operator execution were not tested.'});
  progress();
  return report;
}
