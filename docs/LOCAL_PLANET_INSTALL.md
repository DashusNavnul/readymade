# Local planet installation: engineering controller

The local adapters cover three separate steps: prepare and boot a new planet,
stage the pinned backend source, and compile the apps and prepare activation.
Each result keeps `ready: false`; none claims a working Pataphor session merely
because a process started or a desk was created. The staging controller has
passed its complete native sequence on a fresh owned fake ship, including all
1,463 source files. A purchased real planet and the complete first-task path
remain release gates.

## Purchase and private delivery

The [official Urbit getting-started guide](https://docs.urbit.org/get-on-urbit)
lists [Pocwet](https://store.pocwet.com) as a third-party L2 planet vendor that
accepts credit cards. Availability, price, payment and delivery must be checked
with the vendor at purchase time. This is not a Readymade checkout integration
or a promise of immediate delivery.

Follow the vendor's private claim instructions and the official
[Bridge guide](https://docs.urbit.org/user-manual/id/using-bridge) to establish
control and obtain the networking keyfile. A key that can boot a planet and
confirmed ownership are separate facts; retain the actual claim/ownership
evidence, including applicable [L2 settlement](https://docs.urbit.org/urbit-id/l2).
Never put a claim link, master ticket, private key, keyfile or login code in chat,
source control, command-line URLs or public logs. Source staging does not read
keys; the separate boot adapter accepts only a private local keyfile path.

Orraah's [direct checkout](https://www.orraah.com/store/checkout/planet-identity)
is another provider flow. Its public [welcome page](https://www.orraah.com/welcome?product=planet-identity)
describes follow-up provisioning details; reaching that page is not payment or
delivery proof. No authenticated claim/download API is integrated here.
Automatic purchase-to-delivery requires a provider agreement and a verified
transaction-to-planet-to-recipient handoff, not an invented endpoint. The
[proposed star-services plan](STAR_SERVICES.md) is separate from direct purchase.

## Prerequisites

The receiving owner must authorize the native writes below. Discover their
actual ship, pier and runtime; development ships and paths are not defaults.
Purchase/claim and binary delivery remain separate steps. Never boot a second
pier for a running identity.

## Prepare and boot a new local planet

`backend/install/boot-local.cjs` exposes `prepare(options)` and
`launch(output, approvedDigest)` for macOS arm64. This is a finite adapter, not
a billing provider or background service. Supply a verified Vere build and
bootstrap; downloading a production runtime package is not automated here.
Use these exact option fields:

```js
{
  ship: '~your-planet',
  pier: '/your/private/new-pier',
  vere: '/your/verified/urbit',
  pill: '/your/verified/brass.pill',
  keyfile: '/your/private/download.key',
  output: '/your/private/new-boot-receipts',
  httpPort: 18801,
  amesPort: 31339,
  runtimeSHA256: 'YOUR_VERIFIED_EXECUTABLE_SHA256',
  pillSHA256: 'YOUR_VERIFIED_BOOTSTRAP_SHA256',
  singleInstanceConfirmed: true
}
```

The final field is the receiving owner's confirmation that the planet is
stopped on every other host. Local process checks cannot establish that fact
on another machine. Pier and receipt parents must already be private owned
directories, and both destinations must be new. The keyfile must be an owned,
unlinked mode-0600 file. Keep options and receipts private; never paste a
keyfile's contents into a command, conversation or issue.

`prepare` parses only the public planet name through the pinned executable,
validates the keyfile's format and exact planet identity, and retains an exact
private copy. It supports legacy, v1 and current v2 multi-key feeds without
removing rift or extra keys. Its resource limits are 64 KiB, 64 keys, 8,192 jam
nodes and depth 128; these are adapter limits, not native atom-width limits.
Validation does not establish ownership or current network-key validity.

Use the existing owner authorization for the reviewed plan; its returned digest
binds the exact inputs. `launch` reserves the identity once in a private
per-user registry shared across pier folders, checks ports and input hashes,
and records durable intent before spawning Vere. It passes the key by file
path, binds HTTP to loopback and never uses fake/local-only or inline-key
flags for a real planet. Raw boot output is private because Vere can print
malformed private-key input in an error. Only sanitized status is returned.

As soon as the native socket is ready, its first native operation mounts
`%base` and verifies the four exports below. It then checks the actual native
identity and worker binding. Successful boot returns
`ship-booted-not-installed`, not application readiness. A failed or uncertain
attempt retains the reservation and receipts; it never signals the ship or
starts a second copy automatically. The adapter and key admission have offline
tests; a real purchased-planet key boot remains unqualified.

After **every boot**, mount `%base` through native Clay `%mont` before other
ship work and verify nonempty `base/sys/{hoon,zuse,lull}.hoon` and
`base/sys/vane/clay.hoon`. See the
[mount command and runtime requirements](../backend/install/README.md).
The controller repeats this mount/readback at the start of its receiver step;
that does not excuse work before the mandatory post-boot mount.

The controller currently requires macOS, Node 22, Python 3, the running Vere
executable with the supported native evaluator, and access to the pier's native
socket. It binds the actual worker PID, start time and executable through
`.vere.lock`, `ps` and `lsof`. It also pins the Node/Python executable paths and
hashes, the Vere hash and the shipped adapter files. Python runs in isolated
mode. These host checks do not establish native readiness or resolve an older
unknown operation.

Supply a complete assembled bundle root containing `desk/`, `notices/` and
`assembly.json`, matching the shipped `backend/assembly-manifest.json`. Do not
pass only the `desk/` directory. Paths must be absolute, unlinked and separate:
the state directory must be new and must not contain, or be inside, the pier or
bundle. Choose a new dedicated desk; protected desks and existing target desks
are refused.

## Plan, inspect, approve once

Run from the Readymade repository. Replace every placeholder with the receiving
owner's actual values:

```sh
node backend/install/install-local.cjs plan \
  --state /your/private/new-install-state \
  --ship '~your-ship' --desk readymade \
  --pier /your/actual/pier --vere /your/actual/urbit \
  --bundle /your/assembled-root

node backend/install/install-local.cjs inspect \
  --state /your/private/new-install-state
```

`plan` hashes inputs and probes the local host without submitting a native
request. It writes private local plan/host records and prints the plan and its
digest. Review the identity, target desk, paths, runtime and source pins before
approving. An unresolved native-operation lock prevents admission.

Only after the owner approves that exact plan, copy its digest into:

```sh
node backend/install/install-local.cjs execute \
  --state /your/private/new-install-state \
  --approve EXACT_PLAN_DIGEST
```

`execute` performs native writes. It rechecks bindings and records intent before
each step:

| Step | Effect and check |
| --- | --- |
| `receiver` | Mount/read back `%base`; check native identity, receiver eligibility, target absence and app/route collisions. |
| `create` | Create the dedicated desk from the current base; observe its revision/root and DEAD state with no pending Clay work. |
| `mount` | Mount that exact desk/revision and observe it again. |
| `stage` | Copy pinned source to the mount, retain backups and verify the filesystem result. No native commit occurs in this step. |
| `commit` | Submit one guarded Clay `%dirk`; observe exactly the next revision, still DEAD. |
| `verify` | Check the complete native path set and contents against the pinned source, including the bill and kernel. |

Completion proves source staging only. It does not prove that the apps compile,
are active, preserve saved state on load, or can execute a task.

## Compile and prepare activation

`backend/install/compile-local.cjs` exposes
`compile({state, output, approvedDigest})`. `state` is the completed staging
journal, `output` is a new private directory, and `approvedDigest` is that
journal's exact plan digest under the owner's existing installation authority.
It does not resume a partial attempt or bypass an unresolved operation lock.

The driver reconstructs the current 13 checks from the pinned bundle, then runs
source verification, ten app builds, mark graphs and runtime thread checks
serially. It retains full native requests and responses, rechecks the actual
worker and toolchain, and takes a complete native baseline before preparing
activation. Its overall operation budget is one hour, with at most 20 minutes
per native exchange and time reserved for local encoding and decoding. A
timeout leaves an unknown outcome; it does not cancel native compilation.

`verify-compilation.cjs` checks the actual payload of every result, including
the exact six resolved runtime threads and both readiness flags. It regenerates
the prepared checks and verifies their bytes, target, revision, source,
executables, transport requests and responses. A successful envelope alone is
insufficient. Its result is retained evidence, not fresh readiness or permission
to activate.

`prepare-activation.cjs` also requires the actual six successful staging steps
and their exact receiver/commit observations. It derives the prior app count
from a correlated complete native snapshot, prepares the unchanged native
preflight/activation/post-install strands, and rechecks their exact bytes and
all input pins. It never dispatches activation. Baseline decoding is currently
limited to 32 MiB and one million decoded nodes; large snapshots fail closed
and must not be reduced to selected apps or saved fields. The transport also
retains frames over 1 MiB for separate inspection instead of claiming success.

Successful preparation is `activation-prepared`, with `ready: false`.
Supported activation still requires a fresh native preflight, one submission,
whole-system preservation and actual post-install execution checks. These
adapters do not send a raw or partial Gall load.

## Inspect failures without replay

Keep the state directory, its `-host.json` sidecar and `-receipts` directory
together and private. The append-only journal retains plan-bound intents,
outcomes and evidence hashes. Native receipts retain the prepared source,
encoded request, submission record, raw response and result, alongside operation
packets and verification results. `inspect` checks retained evidence hashes;
missing or changed evidence is a failure, not permission to start over.

The controller holds a whole-pier installation lock in addition to its journal
lock and the existing native-operation lock. An unknown outcome retains locks
and blocks further execution. A partial or refused run is not automatically
resumed. Do not delete locks, create a new state directory to bypass them, or
resubmit after a timeout. Establish the exact native outcome and current state
through supported observation first. External tools are not serialized merely
because this controller has a lock.

## Remaining rollout gate

The acceptance target is one newly owned real planet: private claim and boot,
mandatory base mount, this complete source-staging sequence, native compilation,
supported activation with complete app/state preservation, then a real
owner-authorized Pataphor task with correlated output in Readymade. No second
user is needed. Existing inventory, owner permissions, load guards and
unknown-outcome rules remain requirements throughout; source verification is
not a substitute for them.

Boot and compilation have bounded adapters, but real keyboot, supported
activation, packaged desktop onboarding and first-task orchestration are not
yet qualified as one path. Until those gates pass, there is no qualified
card-purchase-to-working-Pataphor customer flow.
