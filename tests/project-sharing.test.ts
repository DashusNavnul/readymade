import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharingJournal, type SharingIntent } from '../src/project-sharing-journal';
import { sharingCommand, sharingResult, sharingView } from '../src/project-sharing';
import type { JsonObject } from '../src/protocol';
import type { ProjectSharingParameters } from '../src/ship-client';

function fixture(directory: string) {
  const intent: SharingIntent = {version: 1, origin: 'https://zod.example', command: {
    request: '01234567-89ab-4cde-8fab-0123456789ab', owner: '~zod', project: 'demo', peer: '~nec', expected: '0x123',
    operation: 'grant', desk: 'demo-work', paths: '/lib/example/hoon', permission: 'view'}};
  const view: JsonObject = {schema: 'readymade-project-sharing-view-v1', owner: '~zod', project: 'demo', peer: '~nec', expected: '0x123', member: true, baseDesk: 'demo-base', workingDesk: 'demo-work', grant: null};
  const result: JsonObject = {schema: 'readymade-project-sharing-result-v1', request: intent.command.request, owner: '~zod', project: 'demo', peer: '~nec', operation: 'grant', intent: '0x456', status: 'unconfirmed'};
  let posts = 0, lost = false, missing = false;
  const client = {origin: intent.origin, projectSharing: async (operation: keyof ProjectSharingParameters) => {
    if (operation === 'read') return {status: 200, body: view};
    if (operation === 'submit') {
      posts++; assert.equal(new SharingJournal(directory).entries().length, 1);
      if (lost) throw new Error('Lost response'); return {status: 202, body: result};
    }
    return missing ? {status: 404, body: {status: 'missing'}} : {status: 200, body: result};
  }};
  return {intent, view, result, client, posts: () => posts, lose: () => {lost = true;}, missing: () => {missing = true;}};
}
async function temporary(run: (directory: string) => Promise<void>) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'readymade-sharing-'));
  try {await run(directory);} finally {fs.rmSync(directory, {recursive: true, force: true});}
}
test('sharing request survives response loss and restart; missing observation never permits replay', () => temporary(async directory => {
  const f = fixture(directory); f.lose();
  await assert.rejects(new SharingJournal(directory).submit(f.client, f.intent, true), /Lost response/);
  const reopened = new SharingJournal(directory), retained = reopened.entries()[0];
  assert.deepEqual(retained, f.intent);
  assert.equal((await reopened.recover(f.client, retained)).status, 'unconfirmed');
  f.result.status = 'confirmed'; assert.equal((await reopened.recover(f.client, retained)).status, 'confirmed');
  f.missing(); assert.equal((await reopened.recover(f.client, retained)).status, 'unconfirmed');
  await assert.rejects(reopened.submit(f.client, retained, true), /not be sent again/);
  assert.equal(f.posts(), 1);
}));
test('two windows and distinct UUIDs compete for one durable peer-view slot', () => temporary(async directory => {
  const f = fixture(directory), twin = {...f.intent, command: {...f.intent.command, request: '11234567-89ab-4cde-8fab-0123456789ab'}};
  const outcomes = await Promise.allSettled([new SharingJournal(directory).submit(f.client, f.intent, true), new SharingJournal(directory).submit(f.client, twin, true)]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal(f.posts(), 1); assert.equal(new SharingJournal(directory).entries().length, 1);
}));
test('stale or foreign observation and missing consent refuse before retaining or sending', () => temporary(async directory => {
  const f = fixture(directory), journal = new SharingJournal(directory);
  await assert.rejects(journal.submit(f.client, f.intent, false), /Confirm sharing/);
  for (const [key, value] of [['owner', '~bud'], ['project', 'other'], ['peer', '~bud'], ['expected', '0x234']]) {
    const old = f.view[key]; f.view[key] = value;
    await assert.rejects(journal.submit(f.client, f.intent, true), /Sharing state changed/); f.view[key] = old;
  }
  assert.equal(journal.entries().length, 0); assert.equal(f.posts(), 0);
}));
test('changed request evidence, unsafe files and corrupt partial writes never send', () => temporary(async directory => {
  const f = fixture(directory), journal = new SharingJournal(directory);
  const submitted = await journal.submit(f.client, f.intent, true);
  assert.deepEqual(submitted.intent, f.intent);
  await assert.rejects(journal.recover({...f.client, origin: 'https://other.example'}, f.intent), /context changed/);
  f.result.request = '11234567-89ab-4cde-8fab-0123456789ab';
  await assert.rejects(journal.recover(f.client, f.intent), /does not match/);
  const file = join(directory, fs.readdirSync(directory)[0]);
  fs.chmodSync(file, 0o644); assert.throws(() => journal.entries(), /private and owned/);
  fs.chmodSync(file, 0o600); fs.writeFileSync(file, '{'); assert.throws(() => journal.entries());
  assert.equal(f.posts(), 1);
}));
test('sharing decoders reject malformed grants, unknown outcomes and foreign result fields', () => temporary(async directory => {
  const f = fixture(directory);
  assert.equal(sharingView(f.view).grant, null);
  assert.deepEqual(sharingCommand(f.intent.command), f.intent.command);
  for (const change of [{status: 'done'}, {peer: '~bud'}, {operation: 'revoke'}, {intent: '0x0'}, {extra: true}]) assert.throws(() => sharingResult({...f.result, ...change}, f.intent.command));
  assert.throws(() => sharingView({...f.view, grant: {generation: '1', desk: 'demo-work', paths: ['/lib/example/hoon', '/lib/example/hoon'], view: true, suggest: false, revoked: false}}));
  assert.throws(() => sharingCommand({...f.intent.command, paths: '/lib/../hoon'}));
}));
