const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
const {projectProblemRows} = require('../dist/src/project-problems');
const original = Module._load;
let CandidateView, CheckView, ProjectInvitationsView, WorkspaceImportView, RemoteSourceView;
try {
  Module._load = function(name, ...args) {return name === 'vscode' ? {} : original.call(this, name, ...args);};
  ({CandidateView} = require('../dist/src/candidate-view'));
  ({CheckView} = require('../dist/src/check-view'));
  ({ProjectInvitationsView} = require('../dist/src/project-invitations-view'));
  ({WorkspaceImportView} = require('../dist/src/workspace-import-view'));
  ({RemoteSourceView} = require('../dist/src/remote-source-view'));
} finally {Module._load = original;}
// Exercise the real row producers from retained observations without constructing an editor or issuing commands.
const client = {origin: 'https://ship.example', snapshot: {owner: '~zod'}, browserCookies: () => [{name: 'urbauth-~zod'}]};
const scope = JSON.stringify([client.origin, '~zod', 'demo']);
const basis = {id: '0x1', owner: '~zod', desk: 'demo', number: 1, root: '0v1', commit: '0v2'};
const instance = (type, data) => Object.assign(Object.create(type.prototype), data);
const problems = view => projectProblemRows(view.rows())[0].children.filter(row => row.command);

test('join problems retain exact request, clear on accepted evidence and exclude another identity', () => {
  const intent = {origin: client.origin, actor: '~zod', command: {request: 'join-1', operation: 'join', project: 'demo'}};
  const foreign = {...intent, actor: '~nec', command: {...intent.command, request: 'foreign'}};
  const view = instance(ProjectInvitationsView, {current: () => client, project: () => 'demo', scope,
    journal: {entries: () => [intent, foreign], ordered: () => [intent, foreign]}, observed: new Map(), grants: new Map()});
  assert.equal(problems(view).length, 1);
  assert.equal(problems(view)[0].description, 'join · unknown');
  assert.deepEqual(problems(view)[0].command.arguments, ['join-1']);
  const key = JSON.stringify([client.origin, '~zod', 'join-1']);
  view.observed.set(key, {status: 'refused'}); assert.equal(problems(view)[0].description, 'join · blocked');
  view.observed.set(key, {status: 'accepted'}); assert.deepEqual(problems(view), []);
});

test('check problems separate historical failures from current failures and invalidate on project change', () => {
  let project = 'demo';
  const report = {key: 'receipt', source: basis, sequence: 1, session: '0x2', request: '0x3', configuration: 'fixture', values: [{passed: false}]};
  const view = instance(CheckView, {client, project: () => project, scope, observation: {origin: client.origin, source: basis, reports: [report]}});
  assert.equal(problems(view)[0].description, 'check · blocked');
  view.observation.source = {...basis, number: 2};
  assert.equal(problems(view)[0].description, 'check · historical');
  assert.deepEqual(problems(view)[0].command.arguments, ['receipt']);
  project = 'other';
  assert.equal(problems(view)[0].description, 'check · unknown');
  assert.equal(problems(view)[0].command.command, 'readymade.checks');
  assert.match(problems(view)[0].label, /^other:/);
});

test('review problems distinguish revoked, pending, unknown slot and applied observations', () => {
  const candidate = {id: '0x2', actor: '~zod', session: '0x3', request: '0x4', basis, stage: 'review', decision: 'pending', reason: '', edits: []};
  const review = {available: false, campaigns: [{candidate: '0x2', reason: 'local-review-scope-revoked', pending: null}]};
  const view = instance(CandidateView, {client, project: () => 'demo', scope, journal: {entries: () => []}, decisions: {entries: () => []},
    held: {project: 'demo', session: '0x3', candidates: [candidate], review, checkSlot: {status: 'unknown', notice: 'not observed'}}});
  assert.equal(problems(view)[0].description, 'review · blocked');
  assert.match(problems(view)[0].label, /local-review-scope-revoked/);
  assert.deepEqual(problems(view)[0].command.arguments, ['0x2']);
  review.campaigns = []; assert.equal(problems(view)[0].description, 'review · pending');
  candidate.stage = 'cloning'; candidate.reason = 'candidate-waiting-for-slot';
  assert.equal(problems(view)[0].description, 'check · unknown');
  candidate.stage = 'applied'; assert.deepEqual(problems(view), []);
});

test('unconfirmed message imports link to observation and clear only on an observed receipt', () => {
  const intent = {preview: {nonce: 'import-1', author: '~nec', text: 'change this'}, events: [{status: 'submitted'}]};
  const binding = {client, owner: '~zod', project: 'demo'};
  const view = instance(WorkspaceImportView, {binding: () => binding, store: () => ({list: () => [intent]})});
  assert.equal(problems(view)[0].description, 'import · unknown');
  assert.deepEqual(problems(view)[0].command, {command: 'readymade.checkSharedMessageImport', title: 'Check Import Result', arguments: ['import-1']});
  intent.events.push({status: 'observed'}); assert.deepEqual(problems(view), []);
});

test('delivery problems inspect existing receipts or drafts and never offer a resend', () => {
  const draft = {id: 'draft', path: '/lib/a/hoon', observation: {origin: client.origin, peer: '~zod', owner: '~nec', project: 'shared', generation: '1', revision: '1'}};
  const suggestion = {draftId: 'draft', request: 'send-1', phase: 'unknown', recoveries: []};
  const view = instance(RemoteSourceView, {current: () => client, reads: [], unread: new Map(), drafts: {list: () => [draft], continued: () => undefined}, suggestions: {list: () => [suggestion]}});
  assert.equal(problems(view)[0].description, 'delivery · unknown');
  assert.equal(problems(view)[0].command.command, 'readymade.checkSharedSuggestion');
  assert.deepEqual(problems(view)[0].command.arguments, ['send-1']);
  suggestion.phase = 'refused'; assert.equal(problems(view)[0].description, 'delivery · blocked');
  assert.equal(problems(view)[0].command.command, 'readymade.openSharedDraft');
  suggestion.phase = 'recorded'; assert.deepEqual(problems(view), []);
});
