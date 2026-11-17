import test from 'node:test';
import assert from 'node:assert/strict';
import {reportHtml, unreadable, REPORT_ACTION} from '../src/report';

const nonce = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
test('a report page escapes everything the ship said and runs only under its nonce', () => {
  const html = reportHtml({title: 'Overview <b>', status: 'Read at <now>', sections: [
    {title: 'Decisions', lines: [{text: '<script>alert(1)</script>', detail: 'a & b', mark: 'warning', action: {id: 'answer:0x12ab.34cd', label: 'Answer "it"'}}]},
    {title: 'Next', lines: [], empty: 'Nothing is queued.'}], actions: [{id: 'retry', label: 'Retry'}]}, nonce);
  assert.ok(!html.includes('<script>alert')); assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('a &amp; b')); assert.ok(html.includes('Overview &lt;b&gt;')); assert.ok(html.includes('Nothing is queued.'));
  assert.ok(html.includes('data-action="answer:0x12ab.34cd"')); assert.ok(html.includes('data-action="again"')); assert.ok(html.includes('data-action="retry"'));
  assert.equal(html.match(/<script/g)?.length, 1); assert.ok(html.includes(`script-src 'nonce-${nonce}'`)); assert.ok(html.includes("default-src 'none'"));
  assert.ok(reportHtml({title: 't', status: 's', sections: [], actions: [{id: 'retry', label: 'Retry'}]}, nonce, true).includes('data-action="retry" disabled'));
});
test('report actions and nonces are strict', () => {
  assert.throws(() => reportHtml({title: 't', status: 's', sections: [], actions: [{id: 'bad id"', label: 'x'}]}, nonce));
  assert.throws(() => reportHtml({title: 't', status: 's', sections: []}, '"><script>'));
  assert.ok(REPORT_ACTION.test('answer:0x12ab.34cd')); assert.ok(!REPORT_ACTION.test('Answer')); assert.ok(!REPORT_ACTION.test('a:b:c'));
  assert.deepEqual(unreadable('Overview', 'The ship did not answer.'), {title: 'Overview', status: 'The ship did not answer.', sections: []});
});
