// Live check, run by hand against an already running owner ship: what the ship says about the guest desk it publishes
// for collaborators, through the built client. Read-only unless READYMADE_LIVE_PUBLISH=1, which asks the ship ONCE to
// publish (one Clay commit that makes the guest desk equal its manifest) and then reads the status again until the
// revision moves. A publish whose answer is lost is reported as unknown and never sent again. Usage:
//   READYMADE_LIVE_ORIGIN=http://localhost:8080 READYMADE_LIVE_CODE_FILE=/path/to/0600-file [READYMADE_LIVE_PUBLISH=1] node tests/live-guest-desk.cjs
// The code file is read once and never printed.
'use strict';
const fs = require('node:fs');
const {ShipClient} = require('../dist/src/ship-client');
const {guestDeskServing} = require('../dist/src/guest-service');

async function main() {
  const origin = process.env.READYMADE_LIVE_ORIGIN, file = process.env.READYMADE_LIVE_CODE_FILE;
  if (!origin || !file) throw new Error('Set READYMADE_LIVE_ORIGIN and READYMADE_LIVE_CODE_FILE.');
  if ((fs.statSync(file).mode & 0o077) !== 0) throw new Error('The code file must be readable by you alone (0600).');
  const client = new ShipClient(origin, async () => fs.readFileSync(file, 'utf8').trim());
  await client.signIn();
  const show = s => `published ${s.published}, public ${s.public}, revision ${s.revision}, from %${s.source}, ${s.files} files listed, ${s.missing.length} missing${s.missing.length ? ' (' + s.missing.slice(0, 5).join(' ') + ')' : ''}, protocol ${s.protocol}, serving ${guestDeskServing(s)}`;
  const before = await client.guestDeskRead();
  console.log('before: ' + show(before));
  if (process.env.READYMADE_LIVE_PUBLISH !== '1') return;
  if (before.missing.length) throw new Error('The ship lacks files its manifest lists; nothing was sent.');
  let receipt;
  try {receipt = await client.guestDeskPublish();}
  catch (error) {console.log(`publish: OUTCOME UNKNOWN (${error?.name ?? 'error'}: ${error?.code ?? error?.message}). Not sent again; read the status.`); process.exitCode = 2; return;}
  console.log(`publish: ${receipt.status}, ${receipt.changed} files changed`);
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    let now; try {now = await client.guestDeskRead();} catch {continue;}
    if (receipt.status === 'unchanged' || now.revision > before.revision) {console.log('after:  ' + show(now)); return;}
  }
  console.log('after:  the revision did not move in 60 seconds'); process.exitCode = 1;
}
main().catch(error => {console.error(String(error?.message ?? error)); process.exit(1);});
