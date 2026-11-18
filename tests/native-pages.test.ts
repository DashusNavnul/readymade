import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeRefusal, nativeRequestAllowed, projectName, refusalHelp, refusalSentence, shortHex, NATIVE_PAGES} from '../src/native-pages';

test('only listed native pages, with their own method, headers and query', () => {
  assert.ok(nativeRequestAllowed('/apps/pataphor-native/coding/overview'));
  assert.ok(!nativeRequestAllowed('/apps/pataphor-native/coding/overview', {method: 'POST', body: {}}));
  assert.ok(!nativeRequestAllowed('/apps/pataphor-native/coding/action', {method: 'POST', body: {}}));
  assert.ok(!nativeRequestAllowed('/apps/pataphor-native/coding/overview/../action'));
  assert.ok(nativeRequestAllowed('/apps/pataphor-native/coding/tasks', {method: 'POST', body: {action: 'release'}}));
  assert.ok(!nativeRequestAllowed('/apps/pataphor-native/coding/tasks', {method: 'POST'}), 'a command needs a body');
  assert.ok(!nativeRequestAllowed('/apps/pataphor-native/coding/tasks', {body: {}}), 'a read carries none');
  const project = {'x-readymade-project': 'demo'};
  assert.ok(nativeRequestAllowed('/apps/readymade-collab/suggestion-history', {headers: project}));
  assert.ok(!nativeRequestAllowed('/apps/readymade-collab/suggestion-history'), 'the project header is required');
  assert.ok(!nativeRequestAllowed('/apps/readymade-collab/suggestion-history', {headers: {...project, cookie: 'x'}}));
  assert.ok(!nativeRequestAllowed('/apps/readymade-collab/suggestion-history', {headers: {'x-readymade-project': 'a:b'}}));
  assert.ok(nativeRequestAllowed('/apps/readymade-collab/presence', {headers: {...project, 'x-readymade-project-owner': '~zod'}}));
  assert.ok(!nativeRequestAllowed('/apps/readymade-collab/presence', {headers: {...project, 'x-readymade-project-owner': 'zod'}}));
  assert.ok(nativeRequestAllowed('/apps/readymade-collab/presence', {method: 'POST', body: {}}), 'a command names its project in the body');
  assert.ok(!nativeRequestAllowed('/apps/readymade-collab/presence', {method: 'POST', body: {}, headers: project}));
  assert.ok(nativeRequestAllowed('/apps/pataphor-native/coding/memory?view=handoff&who=claude&bytes=12000&topic=readymade+notices'));
  assert.ok(nativeRequestAllowed('/apps/pataphor-native/coding/memory?view=since&since=~2026.11.17..08.00.00'));
  assert.ok(!nativeRequestAllowed('/apps/pataphor-native/coding/memory?view=handoff&view=packet'), 'no repeated key');
  assert.ok(!nativeRequestAllowed('/apps/pataphor-native/coding/memory?secret=1'));
  assert.ok(!nativeRequestAllowed('/apps/pataphor-native/coding/memory?view=a%2Fb'));
  assert.ok(!nativeRequestAllowed('/apps/pataphor-native/coding/overview?view=x'), 'a page without a query takes none');
  assert.ok(nativeRequestAllowed('/apps/readymade-collab/work-dismiss', {method: 'POST', body: {}})); assert.ok(!nativeRequestAllowed('/apps/readymade-collab/work-dismiss'));
  assert.ok(nativeRequestAllowed('/apps/readymade-collab/work-withdraw', {method: 'POST', body: {}}));
  assert.ok(Object.isFrozen(NATIVE_PAGES));
});

test('a refusal reads as the ship’s reason, then what it means when this app knows', () => {
  assert.equal(refusalSentence('work-peer-limit'), 'work peer limit. You already have two open requests in this project. Wait for one to finish.');
  assert.match(refusalSentence('watch-refused'), /^watch refused\. Your link to this shared project may be out of date\./);
  assert.equal(refusalSentence('some-future-reason'), 'some future reason.', 'an unknown reason is shown as the ship named it, with nothing invented');
  assert.match(refusalSentence('proposal-history-full'), /^proposal history full\. Your ship already holds as many open proposals as it keeps\./);
  assert.match(refusalSentence('standing-policy-history-full'), /4,096 versions/);
  assert.equal(refusalSentence('The ship answered 503.'), 'The ship answered 503.', 'a sentence is left as it is');
  assert.equal(refusalHelp('constructor'), undefined); assert.equal(refusalHelp('toString'), undefined);
  // Reasons a person can meet from these screens each say what to do, as one or more whole sentences.
  for (const reason of ['work-capacity', 'work-request-own-ship', 'work-request-invalid', 'stream-own-ship', 'stream-missing', 'stream-ended', 'presence-capacity', 'answer-invalid', 'owner-tasks-store-unavailable', 'memory-reason-required']) {
    assert.match(refusalHelp(reason) ?? '', /^[A-Z].+\.$/, reason); assert.match(refusalSentence(reason), new RegExp(`^${reason.replaceAll('-', ' ')}\\. [A-Z]`), reason);
  }
  for (const reason of ['claim-held', 'claim-blocked-by-question', 'question-answered', 'memory-version-changed', 'standing-policy-unchanged', 'notice-not-unknown', 'presence-path-not-shared', 'owner-pages-unavailable'])
    assert.ok((refusalHelp(reason) ?? '').endsWith('.'), reason);
});

test('a refusal keeps the ship’s own words', () => {
  assert.equal(nativeRefusal({status: 200, value: {}}), undefined);
  assert.equal(nativeRefusal({status: 409, value: {error: 'claim-held'}}), 'claim-held');
  assert.equal(nativeRefusal({status: 409, value: {status: 'refused', message: 'work-peer-limit'}}), 'work-peer-limit');
  assert.equal(nativeRefusal({status: 503, value: {}}), 'The ship answered 503.');
  assert.ok(projectName('pataphor-demo-mp')); assert.ok(!projectName('')); assert.ok(!projectName('x'.repeat(129)));
  assert.equal(shortHex('0xe1b1.e811.d50e.8229'), '0xe1b1.e811');
});
