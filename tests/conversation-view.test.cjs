const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
let picks = [], lines = [], errors = [], calls = 0;
const original = Module._load;
let ConversationView;
try {
  Module._load = function(name, ...args) {
    return name === 'vscode' ? {window: {
      createOutputChannel: () => ({clear: () => {lines = [];}, appendLine: value => lines.push(value), show() {}, dispose() {}}),
      showQuickPick: async (rows, options) => {calls++; const select = picks.shift(); return select?.(rows, options);},
      showErrorMessage: async message => {errors.push(message);}, showInformationMessage: async () => {}
    }} : original.call(this, name, ...args);
  };
  ({ConversationView} = require('../dist/src/conversation-view'));
} finally {Module._load = original;}
const entry = {id: '0v1', destination: 'private', text: 'Exact original request', at: '2026-01-01T00:00:00Z', status: 'accepted'};
const reset = () => {picks = []; lines = []; errors = []; calls = 0;};

test('cancel and active unknown inspection never read archives or send requests', async () => {
  reset(); const view = new ConversationView();
  const journal = {origin: 'https://owner.example', entries: [{...entry, status: 'unknown'}], archivePages: () => {throw new Error('Must not read');}};
  await view.browse(journal, 0); assert.deepEqual(errors, []);
  picks = [rows => rows.find(row => row.entry)];
  await view.browse(journal, 0);
  assert.match(lines.join('\n'), /unknown/); assert.match(lines.join('\n'), /Exact original request/);
  assert.match(lines.join('\n'), /Acceptance does not prove execution or deployment/);
  view.dispose();
});

test('archive page advancement is explicit and detail preserves exact receipt and archive identity', async () => {
  reset(); const view = new ConversationView(); let reads = 0, closed = false;
  const journal = {origin: 'https://owner.example', entries: [], async *archivePages() {
    try {
      reads++; yield {rows: [], examined: 256, complete: false};
      reads++; yield {rows: [{archive: 'a'.repeat(64), entry}], examined: 1, complete: true};
    } finally {closed = true;}
  }};
  picks = [rows => {assert.equal(reads, 0); return rows[0];},
    rows => {assert.equal(reads, 1); return rows.find(row => row.next);},
    rows => {assert.equal(reads, 2); return rows[0];},
    () => {assert.equal(reads, 2); return undefined;}];
  await view.browse(journal, 0);
  assert.equal(closed, true); assert.equal(calls, 4);
  assert.match(lines.join('\n'), /Archived receipt · https:\/\/owner.example/);
  assert.match(lines.join('\n'), new RegExp('Archive SHA256: ' + 'a'.repeat(64)));
  assert.match(lines.join('\n'), /Acceptance does not prove execution/);
  assert.match(lines.join('\n'), /Exact original request/);
  view.dispose();
});

test('dispose during picker prevents later archive reads and stale display', async () => {
  reset(); const view = new ConversationView(); let reads = 0;
  picks = [rows => {view.dispose(); return rows[0];}];
  await view.browse({origin: 'old', entries: [], archivePages: () => {reads++; throw new Error('Stale read');}}, 0);
  assert.equal(reads, 0); assert.deepEqual(lines, []);
});

test('invalid archive surfaces a read error without claiming empty history', async () => {
  reset(); const view = new ConversationView();
  picks = [rows => rows[0]];
  view.render({}, {origin: 'https://owner.example', entries: [], async *archivePages() {throw new Error('Archive hash mismatch');}});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ['Receipt history unavailable: Archive hash mismatch']);
  view.dispose();
});

const nativePage = (offset = 0, ids = ['0x1'], next = null) => ({schema: 'native-coding-session-archive-page-v1',
  owner: '~zod', available: true, head: {revision: 3, commit: '0v1'}, offset, next, sessionIds: ids});
const nativeDetail = (sequence, more = false) => ({schema: 'native-coding-session-archive-detail-v1', owner: '~zod', available: true,
  session: '0x1', project: 'native-project', objective: 'Complete native objective\nSecond line', summary: 'Exact native summary', phase: 'paused',
  records: [{id: '0x' + (sequence + 1).toString(16), sequence, kind: 'operator', text: `Retained record ${sequence}`,
    file: {text: 'Exact file evidence'}, context: {request: '0xa'}}], after: sequence + 1, more});
const localJournal = {origin: 'https://zod.example', entries: [], archivePages() {throw new Error('Local archive must not be read');}};
function nativeConnection(values, current = () => true) {
  const reads = [];
  return {reads, owner: '~zod', current, client: {origin: 'https://zod.example', async requestJSON(path, options) {
    assert.deepEqual(options, {method: 'GET'}); reads.push(path); assert.ok(values.length, 'Unexpected native read'); return values.shift();
  }}};
}

test('native picker reopens full native objective and records, with explicit detail and catalog Next', async () => {
  reset(); const view = new ConversationView();
  const native = nativeConnection([nativePage(0, ['0x1'], 1), nativeDetail(0, true), nativeDetail(1), nativePage(1, ['0x2'])]);
  picks = [rows => {assert.equal(native.reads.length, 0); assert.match(rows[0].description, /local/); return rows.find(r => r.native);},
    rows => {assert.equal(native.reads.length, 1); return rows.find(r => r.session);},
    rows => {assert.equal(native.reads.length, 2); assert.match(lines.join('\n'), /Retained record 0/); return rows.find(r => r.next);},
    rows => {assert.equal(native.reads.length, 3); return rows.find(r => r.next);},
    () => {assert.equal(native.reads.length, 4); return undefined;}];
  await view.browse(localJournal, 0, native);
  const text = lines.join('\n');
  for (const value of ['Native archived session · ~zod · 0x1', 'native-project', 'Complete native objective\nSecond line',
    'Exact native summary', 'Retained record 0', 'Retained record 1', 'Exact file evidence', 'Retained request context', 'End of retained native history']) assert.ok(text.includes(value), value);
  assert.ok(!text.includes('Local historical evidence')); assert.equal(native.reads.length, 4); view.dispose();
});

test('native cancellation and back do not prefetch additional history', async () => {
  for (const chooseSession of [false, true]) {
    reset(); const view = new ConversationView(), native = nativeConnection([nativePage(), nativeDetail(0, true)]);
    picks = [rows => rows.find(r => r.native), rows => chooseSession ? rows[0] : undefined,
      rows => rows.find(r => !r.next), () => undefined];
    await view.browse(localJournal, 0, native);
    assert.equal(native.reads.length, chooseSession ? 2 : 1); view.dispose();
  }
});

test('native context changes and disposal block subsequent reads and stale display', async () => {
  for (const dispose of [false, true]) {
    reset(); const view = new ConversationView(); let current = true;
    const native = nativeConnection([nativePage(), nativeDetail(0)], () => current);
    picks = [rows => rows.find(r => r.native), rows => {if (dispose) view.dispose(); else current = false; return rows[0];}];
    await view.browse(localJournal, 0, native); assert.equal(native.reads.length, 1); assert.deepEqual(lines, []);
    view.dispose();
  }
  reset(); const view = new ConversationView(); let current = true;
  const native = nativeConnection([], () => current);
  native.client.requestJSON = async () => {current = false; return nativePage();};
  picks = [rows => rows.find(r => r.native)];
  await assert.rejects(view.browse(localJournal, 0, native), /connection changed/); assert.deepEqual(lines, []); view.dispose();
});

test('native missing history reports the actual refusal and sends nothing again', async () => {
  reset(); const view = new ConversationView();
  const native = nativeConnection([{schema: 'native-coding-session-archive-page-v1', owner: '~zod', available: false, error: 'archive-history-unavailable'}]);
  picks = [rows => rows.find(r => r.native)];
  view.render({ship: '~zod'}, localJournal, native);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(native.reads.length, 1); assert.match(errors[0], /archive-history-unavailable/);
  assert.ok(!lines.join('\n').includes('End of retained native history')); view.dispose();
});
