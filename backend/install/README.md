# Native receiver checks

`receiver-check.hoon` is a read-only Khan strand for the ten-app candidate in
the backend assembly manifest. It is not an installer or an activation command.
Use the receiving owner's supported native connection. Discover that ship's
identity, pier and executable; development paths and ships are not defaults.

The current candidate adds `%readymade-editing` and its HTTP route, plus shared
project-file access, suggestions and an owner inbox. Its first owned local
installation passed complete source verification (1,457 files), all ten app
builds, 194 mark checks and six runtime thread checks. The supported activation
left all 40 prior apps live alongside the ten additions; all declared saved-state
preservation checks passed. Authenticated source-import and coding HTTP reads
also passed. This qualifies that local installation; live two-ship coding and
release acceptance remain open. Remote successes described below belong to the
historical nine-app bundle and retain their separate receipts.

After every boot, mount `%base` through native Clay `%mont` and verify nonempty
`base/sys/{hoon,zuse,lull}.hoon` and `base/sys/vane/clay.hoon` before using this
check. Selecting `%base` as an execution desk does not mount it.

Once the receiving ship's native socket is ready after boot, the shipped runner
can perform that mandatory mount without any existing filesystem exports:

```sh
node backend/install/run-native.cjs \
  --pier /your/actual/pier --vere /your/actual/urbit \
  --ship '~your-ship' --operation mount-base \
  --output /your/new-private-base-mount-receipt
```

This mode accepts no supplied source. After the native owner/identity guard it
sends exactly one Clay `%mont %base` card, then checks the four nonempty exported
files for up to ten seconds. `base-exports.json` retains their sizes and hashes.
A mount acknowledgement without those files does not pass. If readback fails,
inspect the native result and ship state before any further operation; the tool
does not resend the mount, create the base directory, copy source or reboot.

This command passed both on an already mounted test ship and after a fresh
owned fake-ship boot using the publicly rebuilt runtime. The fresh run used
the shipped command as its first native operation and verified all four exports.
A separate adverse transport test returns a successful mount acknowledgement
without exporting files and confirms that the runner reports incomplete readback.

For isolated engineering acceptance, the tested Kelvin-408 boot input is the
[brass pill at Urbit commit 0a9a312e](https://github.com/urbit/urbit/blob/0a9a312e133891937de9c4df1ebecad5cf669c7c/bin/brass.pill).
Its Git LFS payload is available at
`https://media.githubusercontent.com/media/urbit/urbit/0a9a312e133891937de9c4df1ebecad5cf669c7c/bin/brass.pill`.
Verify 23,389,629 bytes and SHA-256
`b4babd14e9f1acbdb421b3c31c215ee637ad6691b7e382b99c6fd8991e623708`
before boot. This is a test prerequisite, not an instruction to replace an
operator's existing pier. Build the [public runtime](../../runtime/README.md),
select an unused fake identity, fresh pier and unoccupied ports, bind HTTP to
loopback, boot once, then perform the mandatory native mount above. Never boot
a second pier for an identity already running. Fresh fake-ship acceptance does
not establish migration of a real operator's saved state or remote networking.

The successful local full-backend acceptance used `--loom 33` (8 GiB of
Urbit address space). Fresh remote Linux runs with `--loom 31` and `--loom 32`
(2 and 4 GiB) passed source, Graf and Cantrip checks but failed Viki compilation
with native `%meme` memory exhaustion before activation. Their hosts had 4 and
8 GiB RAM respectively and reported no host OOM kills. Host RAM and Urbit's
loom allocation are separate limits; neither smaller allocation is qualified
for this backend. A subsequent fresh remote Linux receiver with `--loom 33`
on an 8 GiB host passed all nine app builds, 194 mark checks, six runtime
thread checks, guarded activation and all 18 preservation checks. Its 38 prior
apps remained live alongside the nine additions. Real public HTTPS asset checks
and the installed macOS desktop's fresh connection and refresh also passed.
This qualifies that tested configuration, not an 8 GiB peak-memory guarantee
for other ships or workloads. Remote coding execution and media remain separate.
Retain
failed receipts and inspect native state before any owner-approved restart;
do not retry a failed compilation automatically or change caches to force it.

## Local source-staging controller

`install-local.cjs` provides finite `plan`, `inspect` and explicitly approved
`execute` commands for an already running owner-controlled macOS pier. It pins
the actual worker/runtime, Node/Python executables and complete assembled source,
then performs receiver checks, desk creation/mounting, staging, one commit and
complete native source verification. Plans submit no native requests; execution
does. Private journals retain raw evidence and block replay after unknown outcomes.

See [Local planet installation](../../docs/LOCAL_PLANET_INSTALL.md) for exact
arguments, approval-digest handling and purchase/private-delivery boundaries.
Success is `source-staged-not-activated` with `ready: false`: this controller's
complete native run passed on a fresh owned fake ship with the earlier 1,463-file
bundle. Fresh installation of the current 1,490-file bundle through this controller remains unqualified;
purchased-planet installation work remains paused. This controller does not itself
perform purchase, boot, app activation or a first Pataphor task.

`boot-local.cjs` separately prepares and launches one new macOS arm64 planet
using a private keyfile, pinned runtime/bootstrap and a per-user identity
reservation. It mounts and reads back `%base` before other native work and
checks actual identity; its result is `ship-booted-not-installed`. Key admission
supports legacy and both multi-key feed formats. Real purchased-planet boot
is still a release gate; offline format and launch-admission tests do not
establish current network-key validity.

`compile-local.cjs` continues a completed staging journal with 13 serial native
checks and a complete snapshot. `verify-compilation.cjs` qualifies the actual
raw payloads, not only successful transport envelopes or prepared checks.
`prepare-activation.cjs` binds the completed journal, compiler receipts and
baseline-derived app count, and validates every prepared activation artifact.
These helpers do not dispatch activation; `activation-prepared` keeps
`ready: false`. Snapshots over the bounded decoder limit fail closed. Fresh
preflight, one supported activation, whole-system preservation, desktop
onboarding and an actual first task remain separate acceptance requirements.

## Execute a prepared native strand

`run-native.cjs` is a finite local transport for these strands. It needs Node 22,
the receiving ship's actual Vere executable with `eval -jn/-cn`, and access to
that pier's native socket. It needs no private Pataphor checkout, npm dependencies,
login code or network service. It does not provide remote access to hosted ships;
their owner must supply a supported native connection.

Prepare the strand with its required argument binding, then execute once:

```sh
node backend/install/run-native.cjs \
  --pier /your/actual/pier --vere /your/actual/urbit \
  --ship '~your-ship' --source /your/prepared-check.hoon \
  --output /your/new-private-receipt-directory --timeout 1200
```

Use actual discovered paths and identity. The runner adds an owner/ship guard,
requires the four nonempty `%base` exports, refuses existing output and serializes
its operations using `.urb/readymade-operation.lock`. Do not run another native
tool concurrently: the lock cannot serialize tools that do not use it.
Review the complete source before execution; the runner can execute writes and
does not infer authorization or make arbitrary Hoon read-only.

Receipts are private (directory 0700, files 0600). They include source and binary
hashes, the guarded source, encoded request, a pre-send marker and native response.
Local request encoding has a separate 120-second bound; `encode.json` records
its exit/error and whether this phase submitted anything (always false). An
encoding failure occurs before the native lock or send. Preserve the receipt
and diagnose it; it is distinct from an unknown submitted native outcome.
Exit zero means a decoded successful native result, not that its eligibility
boolean passed or that installation is complete. Inspect `response.hoon` and the
operation's declared checks. Exit two retains a response needing inspection;
responses larger than 1 MiB remain in `response.newt` for separate native decoding.
The lock remains held for undecoded large frames, decoder failures and responses
with an unexpected kind or request identifier, even when a complete frame arrived.
`result.json` records `lockRetained`. Only a successfully decoded, matching native
success or `%thread-fail` response releases the lock automatically. A reported
thread failure records `executionSuccess: false`; it is not installation success
or permission to replay the operation. An inspection exception also retains the
lock and records that fact in `inspection-error.json`.
Never paste these receipts into a public issue or include them in a release.

Inspect a complete retained frame offline, including one too large for the
runner's automatic text decoding:

```sh
python3 backend/install/inspect-response.py \
  --response /your/private/operation/response.newt \
  --output /your/private/new-response-inspection.json
```

This command uses the bounded native frame decoder already used by the
preservation tools: at most 256 MiB and 64 million decoded nodes. It
validates the entire frame and matching result envelope, retains its digest,
and writes a new mode-0600 summary without printing the saved payload. It
refuses malformed frames, unexpected identifiers/marks, input symlinks and
existing output. Exit zero means inspection succeeded; read `executionSuccess`
to distinguish a native success from a reported thread or runtime failure.
Native `%bail` responses report `executionSuccess: false`; a `%meme` entry
reports `failureReason: memory-exhaustion` without exposing the trace. Both
connection-driver errors and native event failure lists are recognized. This
inspection passed against the retained remote Viki memory-failure response.
Malformed envelopes still fail inspection. It does not
contact a ship, change a lock, verify receipt provenance, interpret the result's
application-specific meaning or authorize replay. Bind the inspected frame to
the original private receipt and verify the operation's declared checks before
continuing. A timeout with no complete frame still requires native observation.

A timeout does not cancel native work. Truncation, connection loss or timeout
retains the lock and an unknown-outcome record; there is no automatic retry or
stale-lock removal. Observe the actual ship through its native console before
resolving an unknown outcome. Only after establishing the operation's result and
that no operation remains active may the owner archive the retained lock. Never
remove it merely because the local process exited. An existing receipt directory
is always refused, including after a known failure.

For read-only observation while that lock remains, use the fixed-query observer:

```sh
node backend/install/observe-native.cjs \
  --pier /your/actual/pier --vere /your/verified/urbit \
  --query identity --output /your/private/new-identity-observation
```

Identity uses the runtime's fixed `%peel /who` query. Its reply is
`[0 0 ship-number]`; verify that number against the intended ship before continuing.
This runtime identity lookup alone does not establish that native work is idle
or that apps are healthy. A separate invocation
with `--query threads` reads Spider's current thread tree. The third fixed query,
`--query spider-state --ship '~your-ship'`, reads Spider's saved state through
native Gall `%gv`. It includes pending starts and routing state omitted by the
thread tree. The observer accepts no supplied source and starts no thread.
It leaves the operation lock untouched, uses private receipts, and waits at most
10 seconds by default (`--timeout` accepts 1–60 seconds). An unresponsive ship
can time out here too; that does not establish that its work stopped.

Additional scoped queries retain current-state frames for separate offline
inspection while the operation lock stays in place:

| Query | Native read | Contents |
| --- | --- | --- |
| `current-domes` | Clay `%cx`, empty desk, `/domes` | Current desk records, history and MIME cache |
| `app-inventory` | Gall `%gf`, empty app, `/$` | App names and subscription nonces; not liveness or saved DATA |
| `activity-agent` | Gall `%gv`, `%readymade-editing`, `/$` | Activity app's saved carrier |
| `app-carrier --app APP` | Gall `%gv`, the literal named app, `/$` | One app's saved carrier |
| `app-liveness --app APP` | Gall `%gu`, the literal named app, `/$` | Native running flag; requires separate envelope and boolean validation |
| `eyre-bindings` | Eyre `%e`, `%bindings`, empty path | Current HTTP bindings and their routing metadata |

Each requires `--ship '~expected-ship'`, which records an expectation rather
than verifying identity. The requests select the receiving ship's current
namespace through native `%once`; they accept no supplied source, desk or path.
Only `app-carrier` and `app-liveness` accept `--app`: 1–64 lowercase letters, digits or hyphens,
starting with a letter. Other queries reject that option. The app selector changes
only the app name in the fixed Gall `%gv` or `%gu` `/$` read; it cannot add a path or code.
Choose names from a separately validated canonical app inventory when checking
preservation. These modes always exit **2** with `status: frame-retained`,
`envelopeVerified: false`, `identityVerified: false`, and `replayAuthorized: false`.
They retain the complete bounded frame and its SHA256 privately, without making
a text dump or decoding its payload. Exit 2 here calls for inspection, not a
repeat query. Even a well-framed unrelated response remains unverified.

The separate offline inspection must validate the request-zero `%peek`/`%omen`
envelope, expected ship, exact native address, timestamp and result mark before
interpreting the payload. Domes return `%domes`, inventory returns `%nonces`, and
carrier/liveness/binding reads return `%noun`. A `%live` saved carrier or inventory
entry does not prove the app is running; use a separately validated `%gu` boolean
for that claim. Bind observations to the actual process and receipt. Multiple
queries are separate observations, not one atomic whole-ship snapshot. These
reads neither establish an earlier operation's result nor authorize lock removal.

Exit zero means a decoded response of the expected shape was retained. Identity
requires a numeric runtime reply; the thread query can return an empty `%peek`.
It does not verify identity automatically or settle any previous
operation. A missing thread is not proof of success: Spider removes completed
threads. Retain the original outcome as unknown unless its actual result can
be established. Desk/source/state checks still require the appropriate native
observation surfaces; this tool does not authorize replay or lock removal.

For `spider-state`, a bounded offline decoder validates the complete frame,
expected owner, native observation path, Gall carrier and Spider state version.
Its private summary retains thread identities and collection counts, without
printing the saved payload. This is a current-state observation. Spider's saved
state omits running executable forms, so a thread cannot be assigned to an old
source hash from this snapshot alone. Completed results are not replayed by this
query; absence from the current state does not establish a prior result.
The inspector accepts at most 32 MiB, one million decoded nodes and 1,024
emitted thread identities; exceeding a bound leaves the frame unqualified.
Responses above 1 MiB are inspected directly without creating a text dump.
The fixed query and binary inspection passed against a real 1,373,695-byte
saved carrier on an owned test ship while its earlier unknown-operation lock
remained byte-for-byte unchanged. That observation found three remaining child
threads and did not settle the earlier test's outcome.

The exported runner passed real identity and receiver checks against the owned
test ship, including use of the independently rebuilt public Vere executable.
A wrong expected identity failed natively before the supplied strand ran. A
90,081-byte source also completed through the exported runner, verifying file-backed
encoding beyond the runtime's piped-output truncation boundary. Socket tests
cover fragmented/truncated responses, invalid frames, deadline expiry and
retained-lock refusal without a second submission. These qualify the transport;
each installation operation still needs its own native result and post-checks.

## Prepare the receiver check

Prepare the receiver check without editing Hoon:

```sh
python3 backend/install/prepare-operation.py \
  --ship '~your-ship' --desk readymade --operation receiver \
  --output /your/new-private-receiver-packet
```

Use the receiving identity and an intended fresh desk. Inspect the generated
`operation.hoon` and its `packet.json`, then pass that source to `run-native.cjs`
with the actual receiving connection and a separate fresh receipt directory.
Preparation contacts no ship. The packet records the selected operation,
identity, desk, mutation flag and complete source/template hashes. Existing
output and reserved system/override desks are refused.

The equivalent native argument binding is:

```hoon
=/  arg=vase  !>([~your-ship %readymade])
```

Replace `~your-ship` with the real identity; it is illustrative, not executable.
Evaluate the resulting strand in `%base`. The check requires the expected ship
to equal the native bowl identity and requires owner-origin execution. A failed
native evaluation is not an empty conflict list or a passed check.

The result is:

```text
[%readymade-receiver-check-v2 ship desk eligible kernel408 bounded
 desk-present override-present app-conflicts route-conflicts]
```

For a generated `receiver` or `observe` packet, interpret and bind its retained
result offline:

```sh
python3 backend/install/verify-operation.py \
  --packet /your/private-prepared-packet \
  --receipt /your/private-native-run-receipt \
  --output /your/new-private-verified-observation.json
```

The verifier checks the current full template, prepared source, runner owner
guard, encoded request, submission digest, response digest and native result
shape. It independently recomputes receiver eligibility from the returned
checks; for desk observations it reports presence, revision, live/dead state,
pending Clay work and immutable root. `executionSuccess: true` does not imply
`observation.eligible: true`. A live desk observation is not permission to mount
or commit it. Existing output, altered evidence and unsupported operations are
refused. Keep all input receipts; this tool neither changes a lock nor contacts
a ship.

This establishes consistency of retained local evidence, not a signed remote
attestation or fresh readiness. The result keeps `currentReadinessVerified` and
`writeAuthorized` false. Before a next write, establish current native state
and the receiving owner's authorization; do not reuse an old eligible result.

Hoon `%.y` is atom 0 and `%.n` is atom 1. `eligible` requires Kelvin 408,
the actual bounded-evaluation probe, an absent target desk, no existing
`glass-desktop-build`, `host-law`, `host-viki` or `hot-viki` desk, no billed-app
collision across desk rosters (including stopped entries),
and no overlapping HTTP route. Both broader and narrower routes are conflicts;
only the stock Docket dispatch bindings at `/` and `/apps` are exempt. Site-bound
routes are checked conservatively too. Keep the detailed binding results private.

`override-present` covers both asset and hot-module configuration. Viki can read
the hot-module desk selected by `host-law`; accepting it would admit code outside
the pinned installation. Activation repeats this exclusion immediately before
its other checks. Do not delete existing configuration to force installation.
On a fresh receiver, Viki's startup subscriptions can create empty `host-viki`
and `hot-viki` desks; inspect those additions in the preservation result.

Conflict reports passed on two owned ships that already have the backend;
wrong expected identity was refused. A fresh owned fake receiver also returned
eligible, with the required kernel/runtime and no desk, app or route conflicts.
Eligibility alone does not prove source
staging, native compilation, saved-state preservation, activation, HTTP delivery
or real coding. See the qualified stages below, including fresh-receiver coding and
governed review. Public release qualification remains unfinished. Do not delete
conflicting apps, desks or routes to force a pass.

## Inactive staging

After a fresh eligible result, `stage.hoon` performs one explicitly selected
operation. The same preparer supports `create`, `observe`, `mount` and `commit`:

```sh
python3 backend/install/prepare-operation.py \
  --ship '~your-ship' --desk readymade --operation observe \
  --output /your/new-private-observation-packet
```

Use `create` only after eligibility is established. `receiver`, `observe` and
`create` accept no revision option. `mount` and `commit` require
`--revision "$observed_revision"`, taken from the actual native observation.
The preparer formats Hoon numbers correctly and preserves the complete native
guards; it does not establish eligibility, execute an operation or infer
authorization. Submit each reviewed operation once, retain its result, and
observe before continuing. Never reuse a guessed or stale revision.

For reference, a native creation binding is:

```hoon
=/  arg=vase  !>([~your-ship %readymade %create 0])
```

`%create` requires an absent desk and revision argument zero. It forks the
receiver's current `%base` using native Clay `%merg %init`; it does not activate
the resulting desk. Observe the created desk's revision and dead state before
continuing. `%mount` and `%commit` require the exact observed revision, dead
state and no pending Clay work. Their argument shape is the same, replacing
`%create` and `0` with the chosen operation and observed revision.

For that observation, prepare a separate copy of `stage.hoon` with:

```hoon
=/  arg=vase  !>([~your-ship %readymade %observe 0])
```

Execute it through `run-native.cjs` with a fresh receipt directory. `%observe`
sends no cards and requires argument revision zero; zero here means observe
current state, not assume a desk revision. Its result is:

```text
[%readymade-stage-observed-v1 ship desk ~]
[%readymade-stage-observed-v1 ship desk [~ revision live-state idle root]]
```

The first shape means the desk is absent. In the second, `idle` is `%.y` only
when Clay has no pending work for that desk. `root` is a unit: `~` if no commit
exists at the current revision, or `[~ commit]`. Native decoding prints `~` and
`%.y` as 0, so retain the structure rather than interpreting a zero as failure.
Before mounting or committing, require a present desk, `%dead`, `idle=%.y` and
a present source root; bind the next operation to that observed revision.
Observation never substitutes for complete source verification or receiver
eligibility. After an unknown write, it supplies canonical desk evidence but
does not automatically clear the transport lock or authorize resubmission.
If an unknown operation retained that lock, the fixed-query observer above can
read identity and current threads. Use the owner's supported native console for
desk observation; the strand runner deliberately refuses new operations while
the lock remains. Do not remove the lock to run this check.

This observation passed against live, inactive and absent desks on an owned
test receiver using the shipped transport and independently rebuilt public
Vere. Wrong-owner and nonzero observation-revision requests failed natively.

Mount only that newly created desk. Verify that its exported paths are a subset
of the assembled `desk/` paths and that it contains no symbolic links. If any
unexpected path exists, stop and inspect it. Copy the complete assembled source
into this fresh inactive mount, then verify the exact path set and every hash
against `assembly-manifest.json`. Keep package notices outside the mounted desk.
Do not apply this procedure to a pre-existing live desk.

Use the shipped filesystem staging tool after native observation confirms that
this is the newly created, inactive target and its mount is ready:

```sh
python3 backend/install/stage-files.py \
  --source /your/path/assembled-backend/desk \
  --mount /your/actual/pier/readymade \
  --receipt /your/new-private-staging-receipt
```

It validates the complete source against the shipped assembly manifest, refuses
unexpected destination files/directories, symlinks and hardlinks, and requires
disjoint source, mount and receipt paths. Before changing any destination file,
it retains replaced originals and a hash plan in a private receipt directory.
Each file replacement is atomic; the whole copy is not. `complete.json` is
written only after exact full-tree readback. No native command is sent.
Keep other writers out of the source and mount during this bounded operation;
filesystem checks do not establish native desk ownership or inactive status.
On interruption, retain the receipt and partial mount, inspect the difference
and do not commit. Existing receipt paths are refused, not resumed. The tool
does not delete unexpected files or infer a rollback. Re-observe the native
revision before the separate commit and verify native source afterward.

Submit `%commit` once to import the mounted source. A submission result proves
only that the card was sent. Read the resulting revision before generating the
complete native verifier, using the actual immutable revision:

```sh
python3 backend/install/prepare-verification.py \
  --source /your/path/assembled-backend/desk \
  --ship '~your-ship' --desk readymade --revision 2 \
  --output /your/path/new-source-verification.hoon
```

The example revision `2` is not a default: replace it with the observed revision.
The generator checks all local source first and refuses existing output. Execute
its generated read-only strand through the native connection. It requires that
same immutable revision to remain inactive, compares the entire native path set,
hashes every code/text file, and compares the typed app bill and kernel. A timeout
or lost response is unknown; observe canonical state before any further write,
and never automatically repeat the submission.

Staging does not activate apps. Native app/mark/thread compilation, complete
prior-state capture, supported activation and post-install acceptance must pass
before this can become an installation procedure.

The staging path has now created, mounted and imported the complete exported
candidate on a fresh owned receiver. Native readback verified all 1,436 paths,
all code/text hashes, the nine-app bill and Kelvin 408 at an inactive revision.
Duplicate creation and a stale mount revision were refused; subsequent complete
source readback stayed exact. These are staging results, not activation proof.

## Compile before activation

`compile-app.hoon` compiles one app from the exact verified inactive revision.
Bind `arg` to `[expected-ship target-desk observed-revision app-name]` and run
serially for every app in the selected bill. It rejects an unbilled app or a
revision/state mismatch, builds through native Ford, and checks that the result
is an actual Gall agent value. Retain each native result. Do not mix results
from different revisions or run overlapping native builds. App compilation
does not replace mark/thread checks, preservation evidence or activation.

Prepare the full ordered set from the same assembled source:

```sh
python3 backend/install/prepare-compilation.py \
  --source /your/path/assembled-backend/desk \
  --ship '~your-ship' --desk readymade --revision 2 \
  --output /your/path/new-compilation-checks
```

Use the actual identity and observed revision. The tool first validates every
source file, then emits the source verifier, one check per billed app, one mark-graph
check and the six-thread runtime diagnostic. `packet.json` binds every emitted
file by SHA-256. Run them serially through the owner-authorized native connection
and retain actual native results; the packet itself is not execution evidence.
The 195 mark source paths resolve to 194 names because two paths share the
`ted-eval` name; that alias is retained in the packet instead of counted twice.
Runtime readiness requires all six thread rows compiled and the bounded-runtime
probe to pass, not merely a successful diagnostic invocation.

The fresh receiver passed all nine app compilations, 194 distinct mark graphs,
all six runtime thread compilations and the bounded-evaluation probe against
the verified inactive revision. These are compilation results, not evidence
that initialization, HTTP delivery or a coding task succeeded after activation.

## Private preservation snapshots

`snapshot.hoon` passed native execution on the fresh receiver, retaining all
38 existing live apps and 24 HTTP bindings before activation.
Its argument is `[expected-ship target-desk observed-revision]`. It retains
every inventoried app's complete native carrier, ownership and live
flag, the complete Clay dome map, the target's immutable source root and all
HTTP bindings. It does not reconstruct or load executable cores. Keep responses
private: they can contain complete application data and operational metadata.

A snapshot is evidence, not a preservation verdict. Compare actual before/after
state and explain every difference before accepting an activation. Retain raw
responses, distinguish exact equality from qualified changes, and never relabel
an unknown outcome as successful installation.

## Compare retained snapshots offline

The public comparator requires only Python 3 and the private native response
frames retained by `run-native.cjs`. It accepts a plain snapshot or the snapshot
wrapped in an activation-prepared/submitted result:

```sh
python3 backend/install/compare-snapshots.py \
  --before /your/private-before/response.newt \
  --after /your/private-after/response.newt \
  --output /your/new-private-comparison.json
```

The command never connects to a ship. It validates the native frame and success
result, requires matching owner/target/revision and nondecreasing snapshot time,
then compares all existing app carriers, recognized saved-state containers,
desk maps and HTTP bindings. It records both input hashes and refuses an existing
output; the report is created mode 0600. Keep it and the raw snapshots private.
Inputs are bounded to 256 MiB each, 64 million decoded nodes, and 100,000
entries per collection. Malformed frames, invalid references and unsupported
snapshot shapes fail rather than producing a passing comparison.

A normal exit means a comparison report was produced, not that preservation
passed. Inspect removed/stopped apps, changed ownership/carriers, saved-state
mismatches, unrecognized carriers, desk changes and route differences. The ten
expected new apps, correct owning desk and unchanged source commit are separate
reported checks. Exact retained route equality includes their native ducts;
added route count alone does not prove the routes are correct. Observer-state
changes require their own detailed explanation; this tool does not automatically
waive Spider differences, approve a migration or authorize another activation.

`carrierDetails` separates changed carrier fields, saved-type equality and
saved-data equality for the recognized native live-carrier shape. Changed Spider
state also reports exact-field checks, added/removed/changed shared `tid` and
`serving` entries, and both running-thread lists. An unsupported saved-state
shape is explicitly unrecognized. `deskDetails` names changed native dome fields,
so a live-flag change can be distinguished from revision or source-map changes.
The saved-state recognizer uses Gall's `[%| vase]` container; a unit-like
`[0 vase]` is rejected. Incoming subscription changes include map delta counts.
`addedDeskDetails` records revision, live state and nonempty fields, while
`addedRouteDetails` records recognized app paths/owners or an explicit unknown.
These details retain strict failures and never qualify inspection-looking
records automatically. They are private diagnostics, not a migration policy.

For a fresh ten-app activation with snapshot-bound observer identities, use
the separate aggregate verifier. After the structural post-install check,
run the prepared `03-snapshot.hoon` to capture the complete post-install state;
the `02-post-install.hoon` response contains no saved-state snapshot.

```sh
python3 backend/install/verify-preservation.py \
  --before /your/private-preflight/response.newt \
  --after /your/private-post-snapshot/response.newt \
  --output /your/new-private-preservation.json
```

This requires exactly the ten new apps, unchanged prior saved types and DATA
(including Docket), and the independently checked Spider inspection transition.
Only Hood, Docket and Spider statistics may differ. It preserves every prior
HTTP row, permits only the seven specified new route/owner pairs, and requires all
other desks exact. The target may change only from inactive to live. The only
new desks allowed are `host-viki` and `hot-viki`, each equal to the supported
Kelvin-408 native default dome; pre-existing override desks are refused.
Strict carrier differences remain in the private report. Exit zero means these
captured-state checks passed; exit two means they failed. Source compilation,
initialization, HTTP delivery and actual coding acceptance remain separate.

Both comparison commands default to `readymade-backend-ten-apps-v2`. To inspect
historical nine-app receipts, explicitly add
`--app-set readymade-backend-nine-apps-v1`. The legacy policy still requires
exactly nine additions and six routes; it cannot qualify a ten-app installation.

Fixture tests exercise the positive transition and adverse changes to old DATA,
types, code, statistics, owners, desks, routes and source roots. The public
verifier also passed all 18 checks against complete snapshots from the fresh
receiver: 40 prior apps preserved, 39 exact saved-DATA values, and only the bound
Spider inspection transition. The nine additions produced 49 live apps.
This is a separate real proof from the two-app Noltbook installation.

## Guarded activation

Generate the owner-bound artifacts from the prepared compilation packet:

```sh
python3 backend/install/prepare-activation.py \
  --checks /your/prepared-compilation \
  --root YOUR_OBSERVED_64_DIGIT_LOWERCASE_CLAY_ROOT \
  --existing-apps YOUR_OBSERVED_APP_COUNT \
  --output /your/new-private-activation-artifacts
```

Preparation validates the current assembly-manifest binding, the expected ten
apps and every source/app/mark/runtime check hash. It produces preflight,
single-submit, post-install and complete-snapshot strands plus their hash
packet. It executes nothing and does not interpret prepared checks as successful
compilation. Use the observed native root and app count, not example values.
The post-install strand checks the exact live revision/root, ten app owners,
all-app liveness, expected total count and native-default auxiliary desks.
These structural checks do not prove saved-state preservation or coding behavior.
Preparation and adverse-input tests pass. The historical nine-app post-install
strand passed natively on the fresh receiver with all 49 apps live.

The historical nine-app `activate.hoon` passed activation on the fresh owned receiver. Its coding and governed-review proof is described below. Bind `arg` to `[expected-ship target-desk revision root
submit]`, where `root` is the actual immutable Clay root from the snapshot.
First use `%.n` for `submit`. This checks owner identity, exact inactive revision
and root, no pending work, the expected bill, all desk app rosters, route
conflicts, kernel and bounded evaluation. It returns a private complete snapshot.
All source, app, mark and thread proofs must already pass for that revision;
the command does not independently establish those external proof results.

Current outer receipt tags are `readymade-activation-prepared-v2` and
`readymade-activation-submitted-v2`. Their complete snapshot retains the existing
`readymade-observed-install-snapshot-v1` shape and current native `tid.b`.
This binds inspection accounting to the actual invocation; older unwrapped
snapshots remain readable but have no inferred observer identity. Parser tests
cover both outer versions and unchanged saved DATA. The historical nine-app
preflight and activation ran on the fresh receiver; the complete preflight and
post-install snapshots passed the aggregate preservation verifier. The earlier
activation proof below predates this receipt change.

Only after those gates pass, `%.y` submits one supported Clay `%zest %live`
operation and returns the prior snapshot captured in that same invocation.
A submitted result is not proof of initialization or preservation. Observe
canonical state before any further write, including after a timeout. Verify
all prior apps and saved data, other desks and routes, then the ten new apps,
HTTP delivery and actual coding behavior before accepting the installation.

The qualified run retained all 38 existing apps and enabled the nine expected
apps, all live and owned by the target desk. All original HTTP bindings remained;
the six added routes matched the expected apps. Every other Clay desk was exact,
and only the target desk's live flag changed. All 37 non-Spider saved states
were identical. Spider's two inspection threads and subscriptions changed, with
all shared records and other state preserved; Hood and Docket changed only event
statistics. This is qualified observer-state preservation, not strict equality
of every native carrier. Raw private snapshots and detailed comparisons remain
retained. Authenticated editor assets matched the assembled source byte-for-byte.

## Fresh desktop connection test

Before desktop testing, verify delivery using the public HTTP check:

```sh
npm ci
npm run build
node tests/backend-http.cjs \
  --auth-file /your/private-auth.json \
  --ship '~your-ship' \
  --output /your/new-private-http-proof
```

The mode-0600 authentication file contains `origin` and `code`. The command
checks the authenticated coding-state owner before fetching the four editor
JavaScript assets. Each response must match the current assembly's exact size
and SHA-256, have a JavaScript content type, and avoid redirects. Anonymous
coding-page access must return the native owner's `403` denial or redirect to
the same ship's login. Server errors do not qualify as denial. Receipts exclude
credentials and cookies, and existing output is refused. No app writes or
model requests are sent. Fixture and adverse-response tests pass. The public
command and a clean-export build passed on the fresh receiver: all four pinned
assets matched and anonymous access returned the native `403`. A wrong expected
ship was rejected at identity before asset verification. The original
redirect-only failure is retained alongside the corrected result. Asset delivery
alone does not prove rendered editing, source operations or preservation.

After activation, `READYMADE_TEST_MODULE=fresh-install-host ./test-host.sh`
tests the packaged editor against the real fresh ship. Set `READYMADE_CODE_BIN`
to that package's native CLI and `READYMADE_BUILTIN_EXTENSION` to its bundled
Readymade extension. Set `READYMADE_EXPECTED_SHIP` to the receiving identity and
`READYMADE_LIVE_AUTH` to an owner-only mode-0600 JSON file containing `origin`
and `code`. Keep that file outside the repository; use the login code as shown
by Urbit, without a leading tilde. Never put the credential in command arguments.

The test verifies the installed extension path, authenticated workspace and
coding identity, readiness, an empty fresh session list, workspace focus and
refresh. It does not create a project or execute a coding request. A successful
connection is one installation gate, not full workflow acceptance.

For an owned loopback test ship whose CLI still requires secure transport, set
`READYMADE_EXPECT_SECURE_TRANSPORT=1` to verify that this refusal is reported
accurately while ordinary authenticated workspace refresh continues to work.
This option changes only the test expectation, not the ship's transport policy.

This test passed against the fresh receiver using the packaged editor on macOS
arm64 (editor 1.143.1, Readymade extension 0.2.0): real login, workspace focus,
empty session list and refresh. Type checking, linting and 245 tests also pass.


## Fresh coding and governed review

Before pairing a connector on a remote installation, check its separate
HTTPS transport gate:

```sh
node tests/backend-connector-http.cjs \
  --auth-file /your/private-auth.json \
  --ship '~your-ship' \
  --output /your/new-private-connector-http-proof
```

This uses the same private authentication format as the asset check, requires
an HTTPS origin, verifies coding-state ownership, validates the ship-delivered
connector source package, and requires anonymous source access to return
`owner-required`. It submits no pairing or model request and does not qualify
provider execution. The editor asset test alone does not cover this gate.

For TLS termination at a reverse proxy, Kelvin-408 Eyre recognizes the standard
`Forwarded: proto=https` header only from IPv4 loopback (`127.0.0.1`).
`X-Forwarded-Proto` alone does not set Eyre's secure-request flag. The proxy must
overwrite client-supplied forwarding headers from its actual trusted TLS
connection, and Eyre's plaintext listener must remain private. Do not enable
the connector's local-HTTP exception for a public proxy or let callers declare
their own secure status. A live read-only check on an owned receiver returned
`secure-transport-required` without `Forwarded`, then `owner-required` with it;
this establishes header handling, not remote authenticated connector acceptance.

The assembled backend completed a real coding task on the fresh owned receiver,
using its ship-delivered connector source, a newly built connector, a fresh
pairing and an owner-authorized project. The model read the source and proposed
a one-file correction. Native Ford compilation and three functional checks
passed. A separately scoped challenge/resolution review accepted the candidate,
and the native workflow applied it to the private working desk.

An independent native readback rebuilt the landed file and verified results
75, 0 and 10 for the three declared inputs. The complete 542-file path set
remained unchanged; all 541 other files were identical, and the accepted baseline
remained intact. Both project desks remained private and inactive. All 47 apps
remained live. Both bounded connector runs exited normally with an idle journal
and no outstanding claim. The coding session is paused after landing; this does
not claim a final completion judgment or deployment of the test project.

This proves the fresh installation can perform real coding, native checks,
governed review and source landing without a second human tester. It does not
close the independent runtime-distribution, release-notice, cross-network media
or additional-platform gates. The local test explicitly enabled owner-only
loopback connector transport; remote installations still require HTTPS.

After installing a compatible backend, use the shipped [native onboarding
forms](../../docs/NATIVE_ONBOARDING.md) to register an existing private project,
prepare a session workspace and open a session. The form protocol has been
tested separately from the earlier manual preparation harness.

## Prepare a destination for local source import

`source-baseline.hoon` prepares a new private, inactive desk from the receiving
ship's pinned `%base`. It does not install or activate applications. Choose an
unused desk name. Prepare the first read-only basis check without hand-editing
Hoon:

```sh
python3 backend/install/prepare-baseline.py \
  --ship '~your-ship' --desk your-source \
  --output /your/new-basis-check
```

Run `00-basis.hoon` through `run-native.cjs` with the actual pier, executable,
identity and a fresh receipt directory, as described above. `%basis` is read-only
and returns the current base revision and commit. Retain them, then run the
preparer again into a different new directory with `--base-revision` set to the
observed positive revision and `--base-root` set to its hexadecimal commit
(without `0x` or separators). The helper formats the native `@uv` literal and
produces separately bound isolate, clone and verify strands plus a hash packet.
It refuses unsafe targets, incomplete pins, linked paths and existing output.
Preparation never contacts the ship or executes a write. Its generated strands
match the already qualified receiver operations; use current observed pins,
not another installation's examples.

1. `%isolate`: refuses an existing target, then submits private root permissions
   for a new empty desk. It pins the unchanged base revision and commit.
2. `%clone`: verifies private root rules, inactive status, no app bindings or
   tracking, and an empty target before submitting the pinned base clone once.
3. `%verify`: read-only; requires target revision 1, the exact cloned commit and
   complete matching native source tree, with private/inactive status preserved.

Use separate prepared files and receipt directories. An acknowledgement is not
readiness. If a write's outcome is unknown, inspect canonical state before doing
anything further; never automatically rerun `%isolate` or `%clone`. Changed base
pins or a changed target require investigation. Run `%verify` before importing;
it deliberately refuses the later modified desk. This path needs native socket
access; a hosted operator needs their host's supported native connection.

The owner source-import page then determines whether the verified desk is
eligible: existing project/tool reservations remain authoritative. Follow the
[source import instructions](../../docs/NATIVE_ONBOARDING.md#import-local-source)
to deliver files through that native app.
