// Live check, run by hand against an already running ship: sign in through the built client and read every native
// page with the same decoders the screens use. Read-only. Usage:
//   READYMADE_LIVE_ORIGIN=http://localhost:8080 READYMADE_LIVE_CODE_FILE=/path/to/0600-file \
//   READYMADE_LIVE_PROJECT=name [READYMADE_LIVE_OWNER=~ship] node tests/live-native-pages.cjs
// The code file is read once and never printed. Prints one line per page; exits 1 if any page fails.
'use strict';
const fs = require('node:fs');
const {ShipClient} = require('../dist/src/ship-client');
const {nativeRefusal} = require('../dist/src/native-pages');
const owner = require('../dist/src/owner-pages'), collab = require('../dist/src/collab-pages');

async function main() {
  const origin = process.env.READYMADE_LIVE_ORIGIN, file = process.env.READYMADE_LIVE_CODE_FILE, project = process.env.READYMADE_LIVE_PROJECT;
  if (!origin || !file || !project) throw new Error('Set READYMADE_LIVE_ORIGIN, READYMADE_LIVE_CODE_FILE and READYMADE_LIVE_PROJECT.');
  if ((fs.statSync(file).mode & 0o077) !== 0) throw new Error('The code file must be readable by you alone (0600).');
  const client = new ShipClient(origin, async () => fs.readFileSync(file, 'utf8').trim());
  await client.signIn();
  const cookie = client.browserCookies(client.origin).find(c => c.name.startsWith('urbauth-'));
  const me = cookie.name.slice('urbauth-'.length), authority = process.env.READYMADE_LIVE_OWNER || me;
  const CODING = '/apps/pataphor-native/coding/', COLLAB = '/apps/readymade-collab/', P = {'x-readymade-project': project};
  const pages = [
    ['overview', CODING + 'overview', undefined, v => {const o = owner.ownerOverview(v); return `${o.decisions.length} decisions, ${o.blockers.length} blockers, ${o.unavailable.length} unavailable`;}],
    ['tasks', CODING + 'tasks', undefined, v => {const t = owner.ownerTasks(v); return t ? `${t.tasks.length} tasks, ${t.questions.filter(q => q.open).length} open questions, ${t.proposals.length} proposals` : 'no task store';}],
    ['policy', CODING + 'policy.json', undefined, v => {const p = owner.standingPolicy(v); return p ? `chain ${p.chain}, ${p.versions.length} versions, ${p.inForce ? 'in force for ' + p.inForce.project : 'none in force'}` : 'no policy store';}],
    ['memory handoff', CODING + 'memory?view=handoff&bytes=4000', undefined, v => {const m = owner.memoryView(v); return `${m.packet.items.length} memories in ${m.packet.bytes} of ${m.packet.budget} bytes, ${m.agents.length} turn authors, document ${owner.handoffDocument(m, me).length} chars`;}],
    ['notices', COLLAB + 'notices', undefined, v => {const n = collab.collabNotices(v, me); return n ? `${n.outbox.length} sent, ${n.inbox.length} received` : 'no notice store';}],
    ['suggestion history', COLLAB + 'suggestion-history', P, v => {const h = collab.suggestionHistory(v, me, project); return `${h.suggestions} suggestions, ${h.rows.filter(s => s.landed).length} of the shown ${h.rows.length} landed`;}],
    ['presence', COLLAB + 'presence', {...P, 'x-readymade-project-owner': authority}, v => {const b = collab.presenceBoard(v, authority, project); return `${b.entries.length} present, ${b.refused.length} refused`;}],
    ['session streams', COLLAB + 'session-stream', undefined, v => `${collab.sessionStreams(v, me).length} streams`],
    ['work queue', COLLAB + 'work-queue', undefined, v => {const q = collab.workQueue(v, me); return `${q.requests.length} requests, ${q.asked.length} asked`;}],
    ['session roles', COLLAB + 'session-roles', P, v => `${collab.sessionRoles(v, me, project).length} sessions`]
  ];
  let failed = 0;
  // A guest ship has no owner console: READYMADE_LIVE_GUEST=1 reads only the collaboration pages.
  const wanted = process.env.READYMADE_LIVE_GUEST === '1' ? pages.filter(p => p[1].startsWith(COLLAB)) : pages;
  for (const [name, path, headers, read] of wanted) {
    try {
      const reply = await client.nativePage(path, headers ? {headers} : undefined), why = nativeRefusal(reply);
      console.log(`${why ? 'refused' : 'ok     '} ${name}: ${why ?? read(reply.value)}`);
    } catch (error) {failed++; console.log(`FAILED  ${name}: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`);}
  }
  client.close();
  console.log(`${me}: ${wanted.length - failed} of ${wanted.length} pages read`);
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => {console.log('FAILED  ' + (error instanceof Error ? error.message.slice(0, 200) : 'unknown error')); process.exitCode = 1;});
