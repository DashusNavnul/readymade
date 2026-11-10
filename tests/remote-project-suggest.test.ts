import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {ShipClient, ShipClientError, OutcomeUnknownError} from '../src/ship-client';
import {remoteSourceHash, type RemoteSourceObservation} from '../src/remote-project-view';
import {newRemoteSuggestionRequest, remoteSuggestionIntent, remoteSuggestionBody, remoteSuggestionReply, remoteSuggestionRecoveryBody, remoteSuggestionRecoveryReply, type RemoteSuggestionIntent} from '../src/remote-project-suggest';

function intent(origin = 'http://localhost:8080'): RemoteSuggestionIntent {
  const observation: RemoteSourceObservation = {origin, owner: '~zod', peer: '~nec', project: 'café-共同', generation: '1', request: '0x1',
    grant: '0x2', root: '0x3', snapshotDigest: '0x4', desk: 'shared', revision: '1', observedAt: '~2026.11.09',
    files: [{path: '/lib/shared/hoon', text: 'old', hash: remoteSourceHash('old')}]};
  return {observation, path: '/lib/shared/hoon', source: 'new: "source"\n', request: '0x5'};
}
function reply(i = intent(), recorded = false) {
  const o = i.observation;
  return {schema: 'readymade-project-suggest-result-v1', owner: o.owner, peer: o.peer, project: o.project, generation: o.generation,
    request: i.request, viewRequest: o.request, grant: o.grant, root: o.root, snapshotDigest: o.snapshotDigest, path: i.path,
    sourceHash: remoteSourceHash(i.source), status: recorded ? 'recorded' : 'watching', reason: recorded ? 'suggestion-recorded' : 'awaiting-owner',
    deadline: '~2026.11.09..00.00.30', retainedUntil: '~2026.11.09..00.05.30', permissionGranted: false, committed: false,
    receiptHash: recorded ? '0x6' : null};
}
test('suggestions retain exact remote provenance and native nonce without local session authority', () => {
  const i = remoteSuggestionIntent(intent());
  assert.ok(Object.isFrozen(i) && Object.isFrozen(i.observation.files[0]));
  const body = remoteSuggestionBody(i);
  assert.equal(Object.keys(body).length, 8); assert.equal(body.request, i.request); assert.equal(body.viewRequest, i.observation.request);
  assert.equal('session' in body, false); assert.equal('commit' in body, false);
  for (let n = 0; n < 10; n++) assert.doesNotThrow(() => remoteSuggestionIntent({...i, request: newRemoteSuggestionRequest()}));
  for (const patch of [{request: '0x0'}, {request: '0x01'}, {request: '0x1.0000.0000.0000.0000.0000.0000.0000.0000'},
    {source: 'é'}, {source: 'a'.repeat(32769)}, {path: '/lib/foreign/hoon'}, {session: 'invented'}]) assert.throws(() => remoteSuggestionIntent({...i, ...patch}));
  const bad = intent(); (bad.observation.files[0] as {hash: string}).hash = '0x1'; assert.throws(() => remoteSuggestionIntent(bad));
});
test('only exact native receipts are accepted and a recorded suggestion is not a commit', () => {
  const r = remoteSuggestionReply(200, reply(intent(), true), intent());
  assert.equal(r.status, 'recorded'); assert.equal(r.committed, false); assert.equal(r.permissionGranted, false);
  for (const patch of [{owner: '~wes'}, {peer: '~wes'}, {project: 'other'}, {generation: '2'}, {request: '0x6'}, {viewRequest: '0x7'},
    {grant: '0x7'}, {root: '0x7'}, {snapshotDigest: '0x7'}, {path: '/lib/other/hoon'}, {sourceHash: '0x7'}, {permissionGranted: true},
    {committed: true}, {receiptHash: null}, {retainedUntil: '~2026.11.09..00.05.31'}, {reason: 'accepted'}, {extra: 1}]) {
    assert.throws(() => remoteSuggestionReply(200, {...reply(intent(), true), ...patch}, intent()));
  }
  assert.throws(() => remoteSuggestionReply(200, reply(), intent()));
  assert.equal(remoteSuggestionReply(404, {status: 'unknown', message: 'Suggestion not retained; do not resend an unknown outcome.'}, intent()).status, 'missing');
});
type Seen = {method: string; url: string; body: string; project?: string; request?: string; origin?: string};
async function fixture(run: (client: ShipClient, i: RemoteSuggestionIntent, seen: Seen[], mode: {value: string}) => Promise<void>) {
  const seen: Seen[] = [], mode = {value: 'ready'};
  const send = (res: ServerResponse, value: unknown, status = 200) => {res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(value));};
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => {body += String(chunk);}); req.on('end', () => {
      seen.push({method: req.method!, url: req.url!, body, project: req.headers['x-readymade-project'] as string,
        request: req.headers['x-readymade-project-suggest-request'] as string, origin: req.headers.origin});
      if (req.url === '/~/login') {res.setHeader('set-cookie', 'urbauth-~nec=fixture; Path=/'); res.end('{}'); return;}
      if (req.url?.includes('project-suggest-recover')) {
        if (mode.value === 'lost') {req.socket.destroy(); return;}
        if (mode.value === 'missing') {send(res, {status: 'unknown', message: 'Recovery observation not retained; original outcome stays unknown.'}, 404); return;}
        if (mode.value === 'recovery-close') client.close();
        const recorded = req.method === 'GET';
        send(res, {...reply(i, recorded), schema: 'readymade-project-suggest-recovery-result-v1', recovery: true,
          reason: recorded ? 'suggestion-recorded' : 'recovering-receipt', ...(mode.value === 'foreign' ? {root: '0x9'} : {})}, recorded ? 200 : 202); return;
      }
      if (req.method === 'POST') {
        if (mode.value === 'lost') {req.socket.destroy(); return;}
        if (mode.value === 'refused') {send(res, {status: 'refused', message: 'Exact retained source observation required.'}, 409); return;}
        send(res, mode.value === 'foreign' ? {...reply(i), root: '0x9'} : reply(i), 202); return;
      }
      if (mode.value === 'missing') {send(res, {status: 'unknown', message: 'Suggestion not retained; do not resend an unknown outcome.'}, 404); return;}
      send(res, reply(i, true));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ShipClient(`http://127.0.0.1:${address.port}`, async () => 'fixture'), i = intent(client.origin);
  try {await client.signIn(); await run(client, i, seen, mode);}
  finally {client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
}
test('accepted HTTP submission exposes pending status followed by its exact receipt', () => fixture(async (client, i) => {
  assert.equal((await client.projectSuggestionSubmit(i, true)).status, 'watching');
  assert.equal((await client.projectSuggestionResult(i)).status, 'recorded');
  await assert.rejects(client.projectSuggestionSubmit(i, true));
}));
test('HTTP submission is explicit, peer-bound and once; exact GET retains request after lost POST', () => fixture(async (client, i, seen, mode) => {
  await assert.rejects(client.projectSuggestionSubmit(i, false), e => e instanceof ShipClientError && e.code === 'consentRequired');
  await assert.rejects(client.projectSuggestionSubmit({...i, observation: {...i.observation, peer: '~wes'}}, true)); assert.equal(seen.length, 1);
  mode.value = 'lost'; await assert.rejects(client.projectSuggestionSubmit(i, true), OutcomeUnknownError);
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), remoteSuggestionBody(i)); assert.equal(seen.at(-1)!.origin, client.origin);
  await assert.rejects(client.projectSuggestionSubmit(i, true), e => e instanceof ShipClientError && e.code === 'commandBusy');
  mode.value = 'ready'; assert.equal((await client.projectSuggestionResult(i)).status, 'recorded');
  const get = seen.at(-1)!; assert.equal(get.method, 'GET'); assert.equal(get.url, '/apps/readymade-collab/project-suggest-result');
  assert.equal(get.body, ''); assert.equal(get.request, i.request);
  assert.equal(Buffer.from(get.project!, 'latin1').toString('utf8'), i.observation.project); assert.equal(client.snapshot, undefined);
  assert.equal(seen.filter(r => r.url === '/apps/readymade-collab/project-suggest').length, 1);
}));
test('refusal, missing observation and malformed correlation never replay a suggestion', async () => {
  for (const value of ['refused', 'foreign']) await fixture(async (client, i, seen, mode) => {
    mode.value = value; await assert.rejects(client.projectSuggestionSubmit(i, true), e => e instanceof ShipClientError && e.code === (value === 'refused' ? 'refused' : 'outcomeUnknown'));
    mode.value = 'missing'; assert.equal((await client.projectSuggestionResult(i)).status, 'missing');
    await assert.rejects(client.projectSuggestionSubmit(i, true)); assert.equal(seen.filter(r => r.url.endsWith('/project-suggest')).length, 1);
  });
});

test('recovery codec requires exact persisted intent and cannot treat ready as a send acknowledgement', () => {
  const i = intent(), body = remoteSuggestionRecoveryBody(i);
  assert.equal(Object.keys(body).length, 11); assert.equal(body.request, i.request); assert.equal(body.root, i.observation.root);
  const valid = {...reply(i, true), schema: 'readymade-project-suggest-recovery-result-v1', recovery: true};
  assert.equal(remoteSuggestionRecoveryReply(200, valid, i).recovery, true);
  for (const patch of [{root: '0x9'}, {grant: '0x9'}, {snapshotDigest: '0x9'}, {request: '0x9'}, {viewRequest: '0x9'},
    {sourceHash: '0x9'}, {path: '/lib/other/hoon'}, {recovery: false}, {schema: 'readymade-project-suggest-result-v1'},
    {status: 'sent', reason: 'awaiting-receipt'}, {status: 'refused', reason: 'watch-refused'}, {extra: true}]) {
    assert.throws(() => remoteSuggestionRecoveryReply(200, {...valid, ...patch}, i));
  }
  assert.throws(() => remoteSuggestionRecoveryReply(200, {...valid, reason: 'recovering-receipt'}, i));
});
test('explicit recovery uses separate POST and GET; never resubmits the original suggestion', () => fixture(async (client, i, seen, mode) => {
  await assert.rejects(client.projectSuggestionRecover(i, false));
  await assert.rejects(client.projectSuggestionRecover({...i, observation: {...i.observation, peer: '~wes'}}, true));
  assert.equal(seen.length, 1);
  mode.value = 'lost'; await assert.rejects(client.projectSuggestionSubmit(i, true));
  mode.value = 'ready'; assert.equal((await client.projectSuggestionRecover(i, true)).status, 'watching');
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), remoteSuggestionRecoveryBody(i));
  const result = await client.projectSuggestionRecoveryResult(i);
  assert.equal(result.status, 'recorded'); assert.equal(result.recovery, true); assert.equal(result.committed, false);
  assert.equal(seen.at(-1)!.url, '/apps/readymade-collab/project-suggest-recovery-result');
  assert.equal(seen.at(-1)!.request, i.request); assert.equal(seen.at(-1)!.body, '');
  await assert.rejects(client.projectSuggestionSubmit(i, true));
  assert.equal(seen.filter(r => r.url.endsWith('/project-suggest')).length, 1);
  mode.value = 'foreign'; await assert.rejects(client.projectSuggestionRecover(i, true));
  mode.value = 'recovery-close'; await assert.rejects(client.projectSuggestionRecover(i, true));
}));
