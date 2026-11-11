import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ShipClient } from '../src/ship-client';
import { checkSetup, type SetupReport } from '../src/setup-check';
import type { JsonObject } from '../src/protocol';

async function fixture(run: (client: ShipClient, state: {coding: JsonObject; options: JsonObject; catalog: JsonObject; workspace: JsonObject; invitations: JsonObject; invitationStatus: number; codingStatus: number; workspaceStatus: number; holdWorkspace?: (respond: () => void) => void; requests: {method: string; url: string; cookie?: string}[]}) => Promise<void>): Promise<void> {
  const state = {
    workspace: {ship: '~zod'} as JsonObject,
    invitations: {schema: 'readymade-project-invitation-catalog-v1', owner: '~zod', permissionGranted: false, catalog: '0x1', offset: 0, total: 0, next: null, requests: []} as JsonObject,
    invitationStatus: 200, codingStatus: 200,
    coding: {nonce: '0v1', cursor: '0x1', session: '0x0', owner: '~zod', ready: true, after: 0, projects: [{id: 'demo'}], sessions: [{id: '0x1', project: 'demo'}], records: []} as JsonObject,
    options: {schema: 'readymade-workspace-import-options-v1', owner: '~zod', session: null, executionAuthorized: false, notes: [{id: 'room', title: 'private fixture title'}], grants: []} as JsonObject,
    catalog: {schema: 'readymade-workspace-catalog-v1', owner: '~zod', catalog: '0x1', executionAuthorized: false, offset: 0, total: 0, requests: [], next: null} as JsonObject,
    workspaceStatus: 200, holdWorkspace: undefined as ((respond: () => void) => void) | undefined, requests: [] as {method: string; url: string; cookie?: string}[],
  };
  const server = http.createServer((request, response) => {
    state.requests.push({method: request.method!, url: request.url!, cookie: request.headers.cookie});
    if (request.url === '/~/login') { request.resume(); response.writeHead(200, {'Set-Cookie': 'urbauth-~zod=fixture-session; Path=/'}); response.end(); return; }
    if (request.url === '/apps/groups/') { response.writeHead(302, {Location: '/foreign-cookie-sink'}); response.end(); return; }
    if (request.url === '/apps/glurff/') { response.writeHead(404); response.end(); return; }
    const paths: Record<string, unknown> = {'/apps/pataphor/remote/state.json': state.workspace, '/apps/readymade-collab/project-invitation-requests': state.invitations, '/apps/pataphor-native/coding/state?0x0&0&0x0': state.coding,
      '/apps/readymade-collab/workspace-requests': state.catalog, '/apps/readymade-collab/workspace-import-options': state.options};
    if (request.url! in paths) {
      if (request.url === '/apps/readymade-collab/project-invitation-requests') assert.equal(request.headers['x-readymade-invitation-offset'], '0');
      const status = request.url === '/apps/pataphor/remote/state.json' ? state.workspaceStatus : request.url === '/apps/readymade-collab/project-invitation-requests' ? state.invitationStatus : request.url!.startsWith('/apps/pataphor-native/') ? state.codingStatus : 200;
      const respond = () => {response.writeHead(status, {'Content-Type': 'application/json'}); response.end(JSON.stringify(paths[request.url!]));};
      if (request.url === '/apps/pataphor/remote/state.json' && state.holdWorkspace) state.holdWorkspace(respond); else respond();
      return;
    }
    response.writeHead(200, {'Content-Type': 'text/html'}); response.end('<html>Private page text must not enter report.</html>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new ShipClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async () => 'fixture-login');
  try { await client.signIn(); await run(client, state); }
  finally { client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('setup reads real HTTP endpoints without writes or redirect leaks and separates observed protocol from execution', async () => {
  await fixture(async (client, state) => {
    const report = await checkSetup(client), row = (name: string) => report.checks.find(c => c.name === name)!;
    assert.equal(row('Landscape').status, 'observed'); assert.match(row('Landscape').detail, /remain unverified/);
    assert.equal(row('Groups').status, 'unverified'); assert.equal(row('Glurff').status, 'missing');
    assert.equal(row('Native coding protocol').status, 'observed'); assert.equal(row('Projects and sessions').status, 'observed');
    assert.equal(row('Project invitations').status, 'observed');
    assert.equal(row('Shared request catalog').status, 'observed'); assert.equal(row('Shared message import').status, 'observed');
    assert.equal(row('Backend installation and joining').status, 'unverified');
    assert.equal(client.snapshot, undefined, 'preflight must not change coding selection or nonce generation');
    assert.ok(state.requests.slice(1).every(r => r.method === 'GET' && r.cookie === 'urbauth-~zod=fixture-session'));
    assert.ok(!state.requests.some(r => r.url === '/foreign-cookie-sink'));
    for (const value of ['fixture-session', 'fixture-login', 'private fixture title', 'Private page text']) assert.ok(!JSON.stringify(report).includes(value));
  });
});

test('app availability arrives before held coding checks; progress mutation and exceptions cannot contaminate checks', async () => {
  await fixture(async (client, state) => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => {entered = resolve;});
    state.holdWorkspace = respond => {release = respond; entered();};
    const snapshots: SetupReport[] = [];
    const pending = checkSetup(client, report => {
      snapshots.push(structuredClone(report));
      report.origin = 'https://wrong.invalid'; report.owner = '~nec';
      report.checks[0].detail = 'contaminated'; report.checks.length = 0;
      throw Error('fixture-session must never become a diagnostic');
    });
    try {
      await held;
      assert.equal(snapshots.length, 3);
      assert.equal(snapshots[0].checks.length, 1);
      assert.equal(snapshots[1].checks.find(row => row.name === 'Landscape')?.status, 'observed');
      assert.equal(snapshots[1].checks.some(row => row.name === 'Native coding protocol'), false);
      assert.equal(state.requests.some(row => row.url.startsWith('/apps/pataphor-native/')), false);
    } finally {release();}
    const final = await pending;
    assert.equal(snapshots.length, 6);
    assert.deepEqual(snapshots[5], final);
    assert.equal(final.origin, client.origin); assert.equal(final.owner, '~zod');
    assert.equal(final.checks.find(row => row.name === 'Native coding protocol')?.status, 'observed');
    assert.equal(final.checks.find(row => row.name === 'Shared request catalog')?.status, 'observed');
    assert.equal(state.requests.length, 11, 'one login plus ten read-only setup GETs');
    assert.ok(state.requests.slice(1).every(row => row.method === 'GET'));
    for (const secret of ['fixture-session', 'fixture-login', 'private fixture title', 'Private page text', 'contaminated']) assert.equal(JSON.stringify(snapshots).includes(secret), false);
    snapshots[5].checks.length = 0; assert.ok(final.checks.length > 0);
  });
});

test('valid app login does not imply backend availability, matching owner or provisioned projects', async () => {
  await fixture(async (client, state) => {
    state.workspaceStatus = 404;
    let report = await checkSetup(client);
    assert.equal(report.checks.find(c => c.name === 'Authentication')?.status, 'observed');
    assert.equal(report.checks.find(c => c.name === 'Native coding protocol')?.status, 'unverified');
    assert.ok(!state.requests.some(r => r.url === '/apps/readymade-collab/workspace-requests'));
    state.workspaceStatus = 200; state.coding.owner = '~nec'; report = await checkSetup(client);
    assert.equal(report.owner, undefined);
    state.coding.owner = '~zod'; state.coding.projects = []; state.coding.sessions = []; state.options.notes = []; report = await checkSetup(client);
    assert.equal(report.checks.find(c => c.name === 'Projects and sessions')?.status, 'missing');
    assert.equal(report.checks.find(c => c.name === 'Shared message import')?.status, 'missing');
  });
});

test('setup rejects foreign catalog/import authority and unavailable authentication without sending writes', async () => {
  await fixture(async (client, state) => {
    state.catalog.owner = '~nec'; state.options.executionAuthorized = true;
    const report = await checkSetup(client);
    assert.equal(report.checks.find(c => c.name === 'Shared request catalog')?.status, 'unverified');
    assert.equal(report.checks.find(c => c.name === 'Shared message import')?.status, 'unverified');
    client.close(); const count = state.requests.length;
    const closed = await checkSetup(client); assert.equal(closed.checks[0].status, 'missing'); assert.equal(state.requests.length, count);
  });
});


test('a guest can discover invitation support without a local coding backend or any project grant', async () => {
  await fixture(async (client, state) => {
    state.workspaceStatus = 404; state.codingStatus = 404;
    const report = await checkSetup(client);
    assert.equal(report.owner, undefined);
    assert.equal(report.checks.find(c => c.name === 'Project invitations')?.status, 'observed');
    assert.equal(report.checks.find(c => c.name === 'Native coding protocol')?.status, 'unverified');
    assert.equal(client.snapshot, undefined);
    assert.ok(!state.requests.some(r => r.url === '/apps/readymade-collab/workspace-requests'));
    assert.ok(state.requests.slice(1).every(r => r.method === 'GET'));
  });
});

test('guest setup distinguishes missing or refused invitation services and rejects foreign or malformed catalogs', async () => {
  await fixture(async (client, state) => {
    const check = async () => (await checkSetup(client)).checks.find(c => c.name === 'Project invitations')?.status;
    state.invitationStatus = 404; assert.equal(await check(), 'missing');
    state.invitationStatus = 403; assert.equal(await check(), 'unverified');
    state.invitationStatus = 200;
    const original = structuredClone(state.invitations);
    for (const invalid of [{owner: '~nec'}, {permissionGranted: true}, {schema: 'future-v2'}, {total: 1}, {next: 64}]) {
      state.invitations = {...original, ...invalid}; assert.equal(await check(), 'unverified');
    }
    assert.ok(state.requests.slice(1).every(r => r.method === 'GET'));
  });
});

test('matching workspace and coding responses cannot substitute another owner for the authenticated ship', async () => {
  await fixture(async (client, state) => {
    state.workspace.ship = '~nec'; state.coding.owner = '~nec';
    const report = await checkSetup(client);
    assert.equal(report.owner, undefined);
    assert.equal(report.checks.find(c => c.name === 'Pataphor workspace')?.status, 'unverified');
    assert.equal(report.checks.find(c => c.name === 'Native coding protocol')?.status, 'unverified');
    assert.equal(report.checks.find(c => c.name === 'Project invitations')?.status, 'observed');
    assert.ok(!state.requests.some(r => r.url === '/apps/readymade-collab/workspace-requests'));
  });
});
