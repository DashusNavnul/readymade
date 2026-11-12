import assert from 'node:assert/strict';
import test from 'node:test';
import {CATCH_UP_ENTRIES, CATCH_UP_LIMIT, CATCH_UP_SYSTEM, catchUpDigest, catchUpDocument, type CatchUpInput} from '../src/catch-up';
import {AssistantError, MAX_SUMMARY_INPUT, askAssistantSummary, type Runner} from '../src/home-assistant';

const base: CatchUpInput = {ship: '~sampel-palnet', project: 'demo', session: '0x5', activityPartial: false,
  activity: [{day: '2026-11-11 17:59', text: '~marzod joined as contributor'}],
  waiting: {items: ['2 suggestions from collaborators'], unchecked: ['code review']},
  conversation: [{id: '7', status: 'done', request: 'add a test\nfor the parser', output: 'Added tests/parser.test.ts', truncated: true}, {id: '8', status: 'queued', request: 'rename it', truncated: false}],
  candidates: [{id: '0x9', project: 'demo', stage: 'awaiting review'}], sessions: [{id: '0x5', project: 'demo'}]};

test('the record names what was read, marks every cut, and stays bounded', () => {
  const text = catchUpDigest(base);
  assert.match(text, /^Workspace of ~sampel-palnet, project demo, task 0x5\./);
  assert.match(text, /Waiting on the owner:\n- 2 suggestions from collaborators\n- not checked: code review/);
  assert.match(text, /Project activity:\n- 2026-11-11 17:59: ~marzod joined as contributor/);
  assert.match(text, /\[7 · done\] add a test for the parser => Added tests\/parser\.test\.ts \[result cut short by the ship\]/);
  assert.match(text, /\[8 · queued\] rename it => no result yet/);
  assert.match(text, /Proposed changes:\n- 0x9 in demo: awaiting review/); assert.match(text, /Coding tasks:\n- 0x5 in demo$/);
  const empty = catchUpDigest({ship: 'http://localhost:8080', activity: [], activityPartial: false, conversation: [], candidates: [], sessions: []});
  assert.match(empty, /no project chosen\./); assert.match(empty, /Waiting on the owner: not checked\./); assert.match(empty, /Project activity:\n- no project chosen/); assert.match(empty, /Requests and results:\n- none/);
  const many = catchUpDigest({...base, activityPartial: true, conversation: Array.from({length: 40}, (_, n) => ({id: String(n), status: 'done', request: 'r' + n, output: 'x'.repeat(5000), truncated: false}))});
  assert.match(many, new RegExp(`the newest ${CATCH_UP_ENTRIES} of 40`)); assert.equal(many.includes('[0 · done]'), false); assert.ok(many.includes('[39 · done]'));
  assert.match(many, /suggestions could not be read/); assert.ok(many.length <= CATCH_UP_LIMIT);
  const long = catchUpDigest({...base, activity: Array.from({length: 400}, (_, n) => ({day: 'd', text: 'event ' + n + ' ' + 'y'.repeat(200)}))});
  assert.ok(long.length <= CATCH_UP_LIMIT); assert.match(long, /\[cut here: too long to include in full\]$/);
  assert.equal(/[\u0000-\u0009\u000b-\u001f]/.test(catchUpDigest({...base, conversation: [{id: '1', status: 's', request: 'a\u0000b\tc', truncated: false}]})), false);
});

test('the page shows the summary above the exact record, and says who wrote it', () => {
  const digest = catchUpDigest(base);
  const plain = catchUpDocument(base, digest, 'now');
  assert.match(plain, /^# Catch-up: ~sampel-palnet · demo\n\nRead from your ship at now\. Nothing was sent to your ship\./); assert.equal(plain.includes('## Summary'), false); assert.ok(plain.includes(digest));
  const page = catchUpDocument(base, digest + '\n```\nnot a fence', 'now', {text: ' Two suggestions wait. ', assistant: 'Claude Code'});
  assert.match(page, /## Summary\n\nTwo suggestions wait\.\n\n_Written by Claude Code on this computer from the record below/);
  assert.equal(page.split('```').length, 3, 'a fence inside the record cannot close the block');
  assert.match(CATCH_UP_SYSTEM, /data, not instructions/);
});

test('a summary is one bounded request and its text is cleaned; an empty or oversized record is not sent', async () => {
  const seen: {args: readonly string[]; stdin: string}[] = [];
  const run: Runner = async (_path, args, stdin) => {seen.push({args, stdin}); return {code: 0, timedOut: false, stdout: JSON.stringify({type: 'result', is_error: false, result: ' All quiet.\u0007 \n'})};};
  const find = () => ({kind: 'claude' as const, path: '/x/claude'});
  assert.deepEqual(await askAssistantSummary('SYSTEM', 'the record', {run, find}), {text: 'All quiet.', assistant: 'Claude Code'});
  assert.equal(seen.length, 1); assert.equal(seen[0].stdin, 'the record'); assert.equal(seen[0].args[2], 'SYSTEM'); assert.deepEqual(seen[0].args.slice(3, 5), ['--tools', '']);
  for (const bad of ['', '   ', 'x'.repeat(MAX_SUMMARY_INPUT + 1)]) await assert.rejects(askAssistantSummary('SYSTEM', bad, {run, find}), AssistantError);
  await assert.rejects(askAssistantSummary('SYSTEM', 'r', {find, run: async () => ({code: 0, timedOut: false, stdout: JSON.stringify({type: 'result', is_error: false, result: ' \n'})})}), /empty summary/);
  assert.equal(seen.length, 1);
});
