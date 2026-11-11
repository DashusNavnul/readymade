import test from 'node:test';
import assert from 'node:assert/strict';
import {restoredSession, sessionSelection, sessionSelectionKey, projectSessionSelectionKey, sourceSessionChoice} from '../src/session-selection';
import type {CodingSnapshot} from '../src/protocol';
function catalog(): CodingSnapshot {
  return {owner: '~zod', ready: true, nonce: '0v1', cursor: '0x1', session: '0x0', after: 0,
    projects: [{id: 'demo'}, {id: 'other'}], sessions: [{id: '0x1', project: 'demo'}], records: []};
}
test('saved session is presentation state bound to current owner and selected project', () => {
  const c = catalog(), saved = sessionSelection(c, 'demo', '0x1');
  assert.deepEqual(saved, {project: 'demo', session: '0x1'});
  assert.equal(restoredSession(JSON.parse(JSON.stringify(saved)), c, '~zod', 'demo'), '0x1');
  assert.equal(restoredSession(saved, c, '~nec', 'demo'), '0x0');
  assert.equal(restoredSession(saved, c, '~zod', 'other'), '0x0');
  assert.notEqual(sessionSelectionKey('https://zod.example', '~zod'), sessionSelectionKey('https://zod.example', '~nec'));
  assert.notEqual(sessionSelectionKey('https://zod.example', '~zod'), sessionSelectionKey('https://other.example', '~zod'));
});
test('missing, ambiguous, moved, unready and malformed selections do not restore', () => {
  const saved = {project: 'demo', session: '0x1'};
  for (const change of ['missing', 'duplicate', 'moved', 'project', 'unready']) {
    const c = catalog();
    if (change === 'missing') c.sessions = [];
    if (change === 'duplicate') c.sessions.push({...c.sessions[0]});
    if (change === 'moved') c.sessions[0].project = 'other';
    if (change === 'project') c.projects = [];
    if (change === 'unready') c.ready = false;
    assert.equal(restoredSession(saved, c, '~zod', 'demo'), '0x0', change);
  }
  for (const value of [null, [], '0x1', {project: 'demo', session: 'oops'}, {project: 'demo', session: '0x0'}]) {
    assert.equal(restoredSession(value, catalog(), '~zod', 'demo'), '0x0');
  }
  assert.equal(sessionSelection(catalog(), 'demo', '0x0'), undefined);
});

test('per-project preferences isolate switching and survive serialization without granting a session', () => {
  const c = catalog(); c.sessions.push({id: '0x2', project: 'other'});
  const key = (project: string) => projectSessionSelectionKey('https://zod.example', '~zod', project);
  const stored = JSON.parse(JSON.stringify({[key('demo')]: sessionSelection(c, 'demo', '0x1'), [key('other')]: sessionSelection(c, 'other', '0x2')}));
  assert.equal(restoredSession(stored[key('demo')], c, '~zod', 'demo'), '0x1');
  assert.equal(restoredSession(stored[key('other')], c, '~zod', 'other'), '0x2');
  assert.notEqual(key('demo'), projectSessionSelectionKey('https://other.example', '~zod', 'demo'));
  assert.notEqual(key('demo'), projectSessionSelectionKey('https://zod.example', '~nec', 'demo'));
  c.sessions[0].project = 'other'; assert.equal(restoredSession(stored[key('demo')], c, '~zod', 'demo'), '0x0');
});

test('source task choices distinguish identical objectives without using the label as identity', () => {
  const rows = ['0x1', '0x2'].map(id => ({id, objective: '  Review\n the shared gate.  ', project: 'demo', phase: 'paused',
    source: {desk: 'work', number: 3}}));
  const before = structuredClone(rows), choices = rows.map(sourceSessionChoice);
  assert.equal(choices[0].label, 'Review the shared gate.');
  assert.equal(choices[0].label, choices[1].label);
  assert.equal(choices[0].description, 'Paused · demo · work · revision 3');
  assert.notEqual(choices[0].detail, choices[1].detail);
  assert.equal(choices[0].session, rows[0]); assert.equal(choices[1].session.id, '0x2');
  assert.deepEqual(rows, before);
});

test('source task choices display work status and bounded names without implying readiness', () => {
  for (const [phase, description] of [['inference', 'AI working'], ['tools', 'Tool running'], ['judgment', 'Awaiting review'],
    ['unknown', 'Outcome unknown'], ['__proto__', 'Status unavailable']]) {
    const choice = sourceSessionChoice({id: '0x1', phase, objective: '😀'.repeat(121)});
    assert.equal(Array.from(choice.label).length, 120); assert.equal(choice.description, description);
  }
  assert.equal(sourceSessionChoice({id: '0x1'}).label, 'Untitled task');
});
