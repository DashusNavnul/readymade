# Pinned Noltbook source download

This recipe verifies the original 39 Noltbook source and asset files from the
public upstream repository, then applies optional pinned Readymade overlays.
The document-receipt configuration shown below produces 40 files. It requires
no private repository credentials. The source archive remains hosted upstream;
this directory contains the downloader's manifest and reconstruction tool.

With Python 3.9+ and curl, choose an archive path and a new output directory
outside your checkout:

```sh
curl --fail --location --output /your/path/noltbook-source.tar.gz \
  https://codeload.github.com/GlueWear/noltbook/tar.gz/7124b6119c99d1d5f78ae922f66bfd83cf90d96d
python3 reconstruct.py /your/path/noltbook-source.tar.gz /your/path/noltbook-source --readymade-media --document-receipts
```

Run the reconstruction command from `backend/noltbook`, or use
`python3 backend/noltbook/reconstruct.py` from the repository root. For Readymade,
pass both `--readymade-media` and `--document-receipts` to reconstruction,
source staging and compilation preparation, as shown in this guide. Do not pass
these flags to `curl`. The media flag applies the separately pinned `media-overlay.json` after checking the untouched upstream
archive. The overlay carries the tested WebRTC offer-collision, camera-track and
screen-stop fixes and changes only `lib/noltbook/index.html`. It refuses input
drift, ambiguous contexts and an unexpected output hash. Omitting both flags
reconstructs the unmodified upstream component for comparison. The compilation
packet records the overlay hash and verifies the corrected native HTML bytes.


The optional `--document-receipts` reconstruction flag requires
`--readymade-media`. It applies the separately pinned
`document-receipts-overlay.json` after the original archive and media checks,
producing 40 files. Four existing Hoon files change and one library is added;
the media HTML and all other files stay unchanged. The overlay adds durable
per-request document save receipts and explicit read-only recovery. It does
not turn legacy unknown saves into receipts or resend them. Original upstream
identity, archive pins and notice limitations remain unchanged.

The receipt-enabled source passed native compilation, actual saved-state
migration and a supported live update on an owned receiver. Native readback
verified all 563 source files and preservation of all 50 running applications,
including the declared Noltbook state migration and unchanged calls data.
An actual installed editor created and edited a document, saved locally without
a native write, published once to revision 1, then recovered the exact original
receipt in a separate process using only a GET. This does not establish
cross-ship receipt recovery, lost-acknowledgement recovery or history restoration.
See the [acceptance limits](../../docs/PARITY.md#durable-document-receipts--november-9).

Source staging and compilation preparation require both `--readymade-media` and
`--document-receipts` for this 40-file output. Their effective manifest records
the additional overlay hash without changing the original upstream manifest.
These helpers stage only a fresh inactive base clone; updating an existing live
installation requires its own actual saved-state preservation checks.

The current overlay also includes unsent chat-composer storage, scoped to the
browser origin, ship and note. It retains reply/edit targets and their visible
composer mode, never sends a restored draft, and reports storage failures.
Composer tests and candidate HTML reload, note-isolation and pane close/reopen
checks pass with the matching desktop composer journal. Managed browser storage
is ephemeral; the journal is required for drafts to survive destroying a pane.
Fresh owned-ship activation now passes source, compilation and whole-state
preservation checks. The actual ship-served page passes packaged desktop reload,
pane close/reopen and full application restart with exact draft recovery;
clearing stays cleared after reload. This does not qualify migration of an
existing operator's installation. Earlier media receipts bind the older HTML
hash; media requalification and complete release acceptance remain separate.

The richer reply/edit test found that permission refresh overwrote the restored
edit prompt with the normal message prompt. The current overlay fixes that
presentation defect. Its revised `4eb0ce59` output now passes native single-file
update and preservation checks, actual rendered reply/edit recovery, conversation
isolation, and a new full application-restart test. The original failure remains
retained. The resumed test verified that restoring drafts did not send a message
or modify the existing target, then removed its two owned test notes.

The tool checks the archive hash, every expected regular-file path, every file
size and every file hash before creating output. Existing output is refused.
It does not connect to or modify a ship. This is a source component, not an
installer. See [compatibility](../../docs/COMPATIBILITY.md).

The pinned upstream `desk.docket-0` declares `license+'MIT'` and is preserved
exactly. The pinned tree contains no full copyright/license notice file; complete
notice coverage remains unqualified. Readymade does not substitute its own
license or invent an upstream copyright notice. The public source is
[GlueWear/noltbook](https://github.com/GlueWear/noltbook/tree/7124b6119c99d1d5f78ae922f66bfd83cf90d96d).

## Retain verified inherited-source notices

Thirteen pinned files are byte-identical to sources in the pinned Urbit archive
used by the [upstream recipe](../upstream/README.md). Two more, `lib/dbug.hoon`
and `mar/docket-0.hoon`, match its pinned line transformations exactly. Prepare
their original notices alongside the reconstructed Noltbook source, using
those same two verified downloads:

```sh
python3 backend/noltbook/prepare-notices.py \
  /your/path/noltbook-source.tar.gz \
  /your/path/pinned-urbit-source.tar.gz \
  /your/path/new-noltbook-notices
```

The tool verifies both complete archive hashes, all 39 Noltbook files, every
matched upstream file's exact bytes, and both original notice files before
creating output. Derived matches additionally require the original source hash,
every unchanged edit context and the final reconstructed bytes. The v2
`coverage.json` separates 13 exact matches from two derived matches, retains
the derivation pins and upstream manifest hash, and lists the 24 remaining
unresolved files. It writes both original notices unchanged. Unknown transforms,
changed contexts and unexpected outputs are refused before creating output.
Keep this directory beside the source when handing it off.
It is not part of the native desk and must not be overlaid into a running ship.

This supplies available provenance and notices for the exact inherited files;
it does not supply a missing project-wide upstream copyright notice or approve
the entire component for release. Full notice coverage remains unqualified.
The downloader, source pins, media overlay and native app state are unchanged.

## Verify an inactive native candidate

`prepare-compilation.py` prepares three read-only native checks. It requires the
exact reconstructed directory: 40 files with both flags, or the original
39-file configuration without document receipts. It does not stage files,
connect to a ship or activate applications.

For an owner-authorized test, first stage these files over a clone of a known
immutable `%base` revision in a new inactive desk. Retain all other base files.
Record the clone's base revision and the staged desk's actual revision; use the
[native staging tools](../install/README.md) to observe each operation. Never
overwrite an existing Noltbook installation or activate its bill for this check.
After observing the newly cloned desk at revision 1, inactive and idle, mount
it with the native staging tool. Overlay the reconstructed component with:

```sh
python3 backend/noltbook/stage-source.py \
  --source /your/path/noltbook-source \
  --mount /your/actual/pier/your-inactive-desk \
  --receipt /your/private/new-noltbook-stage --readymade-media --document-receipts
```

The helper checks the exact pinned component and media overlay, requires the
four base source exports, and preserves every inherited file outside the
component. It retains replaced originals before writing, verifies the complete
merged tree afterward, and refuses linked paths, overlapping directories,
existing receipts and a mount already containing Noltbook source. It sends no
native command. An interrupted stage retains its receipt and partial mount for
inspection; do not retry it automatically. Native ownership and inactive status
must be established before this filesystem operation.

Commit once using the public native staging tool, then observe the new inactive
revision before preparing the source and compilation checks below.
The following example numbers are placeholders for those observed revisions:

```sh
python3 backend/noltbook/prepare-compilation.py \
  --source /your/path/noltbook-source \
  --ship '~your-ship' --desk your-inactive-desk \
  --revision 2 --base-revision 1 \
  --output /your/path/new-noltbook-checks --readymade-media --document-receipts
```

The output contains `00-source.hoon`, `01-noltbook.hoon`,
`02-noltbook-calls.hoon` and a hash-bound `packet.json`. Execute them in that
order with the public `backend/install/run-native.cjs`, using the receiving
ship's actual pier and runtime and a new receipt directory for each operation.
Require a known success before starting the next check. An observation timeout
is an unknown outcome; observe the original operation rather than replay it.

The source check requires the exact native path set, every pinned source,
semantic bill/kernel/docket equality, and unchanged inherited base files.
It also requires the target revision to remain inactive, unsubscribed and idle.
Each app check builds the immutable source with native Ford and verifies the
result is a Gall agent; it never loads that agent.

On the owned fresh receiver, this path verified 562 native files, including all
39 Noltbook files and 523 unchanged base files, then compiled both apps. All
47 previously running apps remained live. This qualifies inactive compilation,
not activation, app-state migration, messaging, calls or public notice coverage.


A subsequent owned-receiver test qualified native activation, preservation of
existing apps and exact authenticated main/canvas HTTP assets. See the
[fresh activation evidence](../../docs/PARITY.md#fresh-noltbook-activation-and-http-passed).
The parameterized activation preparation below now carries that native guard.
Fresh calls and complete upstream notices remain separate acceptance gates.

## Prepare a fresh installation activation

After all three compilation checks have succeeded, observe the candidate's
current immutable root and the complete existing app inventory. Keep those
receipts. `--root` is the native Clay root printed as 64 lowercase hexadecimal
digits, without `0x` or dots; it is not a file's SHA-256. Use the actual app
count, including every desk. Do not use development ship names or counts as
installation defaults.

```sh
python3 backend/noltbook/prepare-activation.py \
  --checks /your/path/new-noltbook-checks \
  --root YOUR_OBSERVED_NATIVE_ROOT \
  --existing-apps YOUR_OBSERVED_APP_COUNT \
  --output /your/private/new-activation-packet
```

Preparation verifies the compilation artifact hashes and writes a bound packet,
`00-preflight.hoon`, `01-activate.hoon`, `02-post-install.hoon` and
`03-snapshot.hoon`. It does not connect to a ship or
interpret a preparation packet as proof that compilation succeeded. Run the
preflight with the public native runner and a new private output directory.
It retains the complete app carriers, desks and HTTP bindings for preservation
comparison. These receipts can contain private saved data; never publish them.
Preflight and post-install snapshots also retain the current native observer
thread ID in the same event as the captured state. The comparator reports it
under `observerThreads`; historical snapshots report `null`. This identity is
evidence for accounting for inspection activity, not permission to discard all
threads with similar names. Other thread records and result watches must still
be checked exactly.

The native guard requires the exact owner, inactive revision and root; idle,
unsubscribed target; exact two-app bill; no app ownership collisions across any
desk; no existing Noltbook data desk; no conflicting HTTP bindings; matching
kernel and bounded runtime; and the observed count with every existing app live.
It accepts auxiliary helper desks only when equal to the complete native default
dome. This path is for a fresh installation, not an upgrade or recovery.

With the receiving owner's authorization and successful retained compilation
and preflight receipts, execute `01-activate.hoon` once. It repeats the native
guards and sends one supported Clay `%zest` activation. A submission receipt is
not installation success. Observe the target and whole app inventory, compare
complete saved data and HTTP bindings against the preflight, and verify actual
authenticated main/canvas responses. Preserve and investigate every difference,
including Docket registration and the inspection thread's Spider records. Do
not overwrite an existing installation or retry an unknown submission.

Run `02-post-install.hoon` and then `03-snapshot.hoon` through the same native
runner, each with a new private receipt directory. The first requires the exact
live source revision/root, both new apps owned by the target desk, two additional
apps with every app live, and the fresh inactive `noltbook-data` desk containing
exactly six inherited seed files with empty read/write whitelists. Run this
before using the new app; later legitimate data-desk changes are not a fresh
installation baseline. The second retains complete saved carriers, desk state
and HTTP bindings in the same snapshot format as preflight. It does not declare
preservation: compare all fields and account for each declared installation
change before accepting the result. Neither check sends an activation or app
write. Continue with HTTP and messaging tests only after preservation is qualified.

Generate the private difference report from those two native receipts:

```sh
python3 backend/install/compare-snapshots.py --component noltbook \
  --before /your/private/preflight/response.newt \
  --after /your/private/snapshot/response.newt \
  --output /your/private/new-preservation-report.json
```

This mode expects exactly `noltbook` and `noltbook-calls` to be added under the
candidate desk. Missing apps, incorrect owners, unexpected additions and all
existing carrier, saved-state, desk and route differences remain visible. The
report is diagnostic, not automatic preservation approval. For the supported
Docket state version, `docketRegistrationOnly` requires an unchanged saved type,
exact preservation of every previous catalog entry and exactly one new entry
named for the candidate desk. The original strict saved-state mismatch remains
in the report. This accounts only for catalog registration; it does not approve
other carrier changes, validate the new catalog entry's contents, or qualify
Spider's inspection records. Those still need operation-specific checks. The default
mode remains the nine-app Readymade backend installation.

For snapshots carrying native observer identities, separately account for
Spider's inspection records:

```sh
python3 backend/install/compare-inspection.py \
  --before /your/private/preflight/response.newt \
  --after /your/private/snapshot/response.newt \
  --output /your/private/new-inspection-report.json
```

This supports Spider saved-state version 8. Each snapshot must bind its current
thread to an actual local result watch, the caller's outer Khan thread, and the
matching running and serving records. Both observer pairs must be distinct.
Every other thread, serving record, running record and result watch must match;
saved type, app identity and all carrier fields except statistics and the
declared inspection records must also match. Statistics are reported separately.
The original strict carrier and DATA equality results remain visible.

Exit 0 qualifies only this Spider inspection comparison. Exit 2 retains a
report with failing checks; malformed, legacy or unbound evidence is refused.
It never qualifies other apps, source, HTTP bindings or whole-installation
preservation. A similarly named thread is not sufficient evidence. Keep the
original native receipts and full comparison report; never replace them with
this scoped result or rerun an installation to obtain a passing report.

Combine the captured-state checks for a fresh activation with:

```sh
python3 backend/noltbook/verify-preservation.py \
  --before /your/private/preflight/response.newt \
  --after /your/private/snapshot/response.newt \
  --output /your/private/new-preservation-verdict.json
```

This decodes the original snapshots directly, including the inspection check;
it does not trust manually edited summary reports. It requires exactly the two
new apps, correct ownership, every app live, unchanged source root, the target
desk's inactive-to-live transition, no removed desks, exactly one fresh inactive
data desk, unchanged other desks, and preservation of complete old HTTP rows
with only the Noltbook route added. Every prior app retains its identity, saved
type, code and other protected carrier fields. Saved DATA must remain exact
except the candidate catalog entry and verified inspection records. Statistics
may differ only for Hood, Docket and Spider and remain separately reported.

Exit 0 qualifies captured-state preservation; exit 2 reports failed checks.
Snapshots of an already installed app are refused as installation evidence.
This tool still requires qualification against a complete real fresh activation;
its passing and adverse fixtures do not establish that acceptance. The native
post-install check remains mandatory for the six exact seed files and private
permissions. Source/compilation proofs, the new catalog entry's contents and
actual HTTP, messaging and call acceptance remain separate requirements.

The public preparer and its adverse-input tests do not independently qualify a
new activation. The retained successful native activation used this guard with
the existing-app count fixed to that receiver; a new operator must retain their
own source, compilation, preservation and execution evidence.

## Run the fresh messaging acceptance test

First verify HTTP asset delivery on the installed Readymade backend and
Noltbook. After `npm ci && npm run build`, use the private auth file described
below with a new evidence directory:

```sh
node tests/noltbook-http.cjs \
  --auth-file /your/private/auth.json \
  --ship '~your-ship' \
  --output /your/private/new-http-proof
```

This signs in through the public desktop client, verifies the native host and owner,
then checks exact sizes and hashes for the corrected Noltbook HTML and canvas
against the shipped source pins. It also requires unauthenticated access to
redirect to the same ship's exact login route. Requests never follow redirects;
asset reads are bounded by the pinned sizes and a 30-second request deadline.
Receipts contain hashes and statuses, never response bodies, cookies or access
codes. Failure retains the stage and makes no readiness claim. No app writes,
messages or media capture occur. Owner verification requires the login cookie,
Eyre's `/~/host` and its authenticated `/~/name` to match the explicit ship.
It works with standalone Noltbook and does not require the coding backend.
Passing it proves HTTP delivery, not rendered behavior or a working call.

After installing Noltbook on your own ship, build
the extension (`npm ci && npm run build`). Save the exact origin and access
code in a private, regular JSON file outside the repository, with mode `0600`:
`{"origin":"https://your-ship.example","code":"your-private-code"}`.

```sh
node tests/noltbook-live.cjs \
  --auth-file /your/private/auth.json \
  --ship '~your-ship' \
  --output /your/private/new-messaging-proof
```

Running this command authorizes a bounded test: it verifies Eyre's host and
authenticated owner before writing and after signing in again. It creates one uniquely named private note, sends
a Unicode message, edits it, signs in again and verifies exact retained content,
then deletes its message and note. The final note list must equal the initial
list. It closes its temporary Eyre channel using the supported delete action.
Use a quiet test ship; concurrent note changes correctly prevent an equality
claim. The command refuses existing output directories and exposed credential
files. It never writes credentials to receipts or retries a mutation.

If it fails, inspect the private submitted-action and canonical readback receipts
before further writes. A failed run can leave its uniquely identified test note
or channel; do not rerun it as a recovery operation. The test establishes local
frontend transport and persistence, not cross-ship delivery, rendered UI, or video.
