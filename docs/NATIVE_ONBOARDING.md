# Set up a coding project on an installed backend

This workflow uses the owner-authenticated native coding page at
`/apps/pataphor-native/coding` on your own ship. Project registration, private
workspace creation, session grants and model requests remain on Urbit. It does
not require a private development checkout or manually constructed grant nouns.

Prerequisites are a compatible installed backend, an existing private accepted
source desk, and a configured model connection. See the [installation stages](../backend/install/README.md)
and [compatibility requirements](COMPATIBILITY.md). Installing the backend,
importing a local project, and pairing a provider are separate operations; this
page does not silently perform them. Never reuse another operator's login,
project identifiers, desk names or provider key.

## Import local source

Open `/apps/pataphor-native/source-import` on your authenticated ship. Its
**Eligible native baseline** list admits only private, inactive, unreserved
desks. If none exists, prepare a fresh destination with the public
[baseline strand](../backend/install/README.md#prepare-a-destination-for-local-source-import).
Do not select an existing project's accepted or working desk.

Select local files or a directory, explicitly remove its local prefix, and map
into the intended Clay directory. For example, `lib/example.hoon` mapped beneath
`/` becomes `/lib/example/hoon`. Review the displayed paths, sizes and hashes;
then **Add selected files with this mapping**. Preparation and **Download source
JSON** are local only. That downloaded archive can be reopened later to recover
the exact package.

The current importer admits Hoon under app/lib/sur/mar/ted/gen, presentation
HTML/CSS/JavaScript under ui, and specified Gallowglass source directories.
It is not an arbitrary npm/Python/Rust repository uploader. Files must be valid
nonempty UTF-8 without NULs, at most 1 MiB each; a package is limited to 1,024
files and 32 MiB. Package only the intended source, never credentials.

Choose the eligible desk and **Begin import** once. Select that retained import,
then **Send next part**. Each explicit part contains at most five files and
2 MiB. **Observe / reattach** reads and reconciles the actual native result;
wait for `confirmed` before sending the next part. After reconnecting, reopen
the same package and observe the same retained import. Unknown delivery stays
held; do not restart under a new ID or resend a part to hide uncertainty.

Require `complete`, the full confirmed file count and the expected final revision.
Source delivery does not activate applications. Use the imported desk as the
accepted baseline in project setup below. An automated real-HTTP test delivered
six Hoon files in two separately confirmed batches, independently verified their
exact native bytes and preserved all 540 original files. It also compiled imported
source and verified all 47 existing apps live. A separate live Chrome test
selected six local files through the browser file input, prepared and downloaded
their archive, reloaded, reopened that archive and matched the completed retained
import with resend disabled and zero POST requests. This automates the browser
file input; it does not exercise the operating system’s file-picker dialog.
Arbitrary project/language import remains separate acceptance work.

## Create the project

Open **Set up a native project** on the coding page. Enter a unique project ID
and title, the existing private accepted desk, and an unused working desk name.
The accepted desk is the baseline; setup clones it rather than modifying it.
Supply the project's instructions and source conventions.

Specify readable, writable and protected Clay paths separately. A Clay path
such as `/lib/example/hoon` denotes `lib/example.hoon`; it is not a host filesystem
path. Protect checks and infrastructure that the model must not change. Select
the permitted operations explicitly; project setup requires `read`, `compile`
and `check`. Set file/candidate limits and the actual text marks used by the
project. These project permissions do not by themselves start a coding session.

Name a Hoon build target, its entry path, its complete dependency paths and a
real functional check. Checks evaluate with the compiled gate as their subject.
For example, `=(60 (. [3 20]))` checks that calling that gate with `[3 20]`
returns 60; use this only when it is the actual expected behavior of your source.
Do not insert an unconditional passing check to make setup appear successful.
The page also lists Gallowglass, but currently labels verified compilation
unavailable; it is not a qualified substitute for the Hoon path.

Confirm the project scope and choose **Request project setup** once. Inspect the
retained setup record. **Observe setup** advances that same recorded operation
through catalog creation, private cloning and registration. A `bootstrap` phase
can remain after registration until another observation records `ready`.
Do not submit the creation form again while its outcome is uncertain. A refusal
or unknown result needs investigation, not a second project ID to hide it.

## Prepare the session's private workspace

Select the newly registered project and the intended worker. Under **Private
workspace for a new session**, choose **Clone accepted source into a new desk**,
enter another unused working desk name, and choose **Prepare private workspace**.
This per-session copy is distinct from the project's initial working desk.

Select the retained workspace and choose **Observe workspace**. Require its
`ready` state, matching project, worker, accepted revision and private working
desk before continuing. Keep its native session ID; do not invent a new one.
Adopting an existing workspace requires its native claim and is a different path.

## Extract the ship-delivered connector

While signed in as the owner on your actual ship, download the JSON from
`/apps/pataphor-cli/source` to a private local file. From the Readymade checkout:

```sh
node backend/install/extract-connector.cjs /your/downloaded-source.json /your/new-connector-directory
cd /your/new-connector-directory
cargo build --locked --release --bin pataphor-connect
target/release/pataphor-connect --help
```

The extractor needs Node 22 and no npm dependencies. It verifies the native
manifest, every file hash and byte count, required files and safe paths before
creating output. The output directory must not exist; its parent must exist
without symlink components (on macOS use `/private/tmp`, not `/tmp`). It refuses
symlink input files and does not overwrite files. Extraction never builds or
executes the package. Hashes establish package consistency, not publisher trust;
download only from your intended authenticated ship and review its source.

Building requires Rust/Cargo and downloads locked dependencies. Use your existing
Codex or Claude Code subscription login. Follow the connector's `--help` and the
ship's **Connect subscription** instructions to pair with your actual HTTPS
origin and a private `--login-code-file`. Keep credentials and connector state
outside the proposal workspace. Pairing and running a finite coding request
remain separate explicit operations.

## Pair the subscription connector

Use a connector label and key that are not already bound on the ship's
`/apps/pataphor-cli/control` page. They identify this connection; they are not
passwords. Pairing does not verify that a model can answer. Check the existing
provider subscription separately: `codex login status` must report a ChatGPT
login for Codex. API-key authentication is not this connector's subscription path.

Create two new, separate directories: a private connector-state directory with
mode `0700`, and an empty proposal workspace. Neither may contain the other.
Put the ship access code in a `login-code` file **inside the state directory**,
with mode `0600`, using a trusted local editor or secret manager. Never put its
contents in a command argument or chat. The model sandbox denies access to this
state directory. The workspace contains no project checkout; native tools on
Urbit read and change the actual source.

From the extracted and built connector directory, substitute your actual values:

```sh
target/release/pataphor-connect \
  --url https://your-ship.example \
  --backend codex --connector your-connector --key your-provider-key \
  --state /your/private-state --workspace /your/empty-workspace \
  --pair --login-code-file /your/private-state/login-code
```

For Claude Code use `--backend claude` and its managed subscription login; the
live public-binary pairing proof below covers Codex. Do not add service flags
such as `--turns`, `--idle-wait` or `--budget` to the pairing command. It pairs
and exits without claiming or executing a job. Keep `pair.json`, cookies and the
login file private. Verify the exact active label/key/backend on the ship's
control page; a local success message alone is not the whole check. Existing
pairing/state must not be overwritten. On an uncertain result, inspect the native
binding before any further action; do not rerun with a new directory to hide it.

For repeatable HTTPS acceptance, the public test command performs that one
pairing and verifies its result. Run it instead of the manual pair command,
with the reviewed binary built from your ship's validated source:

```sh
node tests/backend-provider-pair.cjs \
  --auth-file /your/private-auth.json --ship '~your-ship' \
  --binary /your/connector/target/release/pataphor-connect \
  --backend codex --connector your-new-label --key your-new-key \
  --output /your/new-private-pair-proof
```

The auth file contains `origin` and `code` and must have mode `0600`.
The output directory must be new, with an existing real parent directory.
This command creates private `state` and empty `workspace` directories inside
the output, verifies ownership and unused labels, invokes pairing once, and
requires exactly one new active native binding with every prior binding
unchanged. It checks the local pairing identity, file permissions and absence
of a worker journal. Credentials and the control nonce are excluded from
summary receipts. It does not start a worker, spend model turns or prove model
execution. If it fails after invoking pairing, retain the output and inspect
native state before taking another action; it never automatically retries.

Only after opening an authorized native coding session with that provider key,
run a separately bounded worker command, using the same origin, labels and paths:

```sh
target/release/pataphor-connect \
  --url https://your-ship.example \
  --backend codex --connector your-connector --key your-provider-key \
  --state /your/private-state --workspace /your/empty-workspace \
  --turns 8 --budget 300 --timeout 120 --idle-wait 0
```

This example allows up to eight model turns within 300 seconds, with each CLI
invocation bounded by 120 seconds and remaining budget. It is not a persistent
service. A journal with an uncertain claim or model invocation requires native
observation; never delete it, its lock or state to force a replay. Native session
grants remain active until revoked; this worker budget does not expire a grant.

The public extractor's clean-built binary paired on an owned local test ship,
with the exact new binding read back and all prior bindings preserved. Private
permissions, empty workspace, normal pairing exit and absence of a worker journal
were verified. That test explicitly used loopback HTTP, which is a local test
exception; it does not qualify remote HTTPS pairing or independent-provider login.

A later fresh remote Linux receiver passed the public HTTPS pairing command
above from a separate Mac. The connector was downloaded from the authenticated
receiver, validated, freshly built and paired once with normal TLS verification.
Independent native readback confirmed the exact active binding, zero model jobs
and all 47 apps live. The local Codex subscription login was already present.
This qualifies remote pairing; remote model execution and new-provider login
remain separate acceptance gates.

## Choose the provider and open the session

Under **New session and provider settings**, choose the actual model connection
and its configured key. For a subscription connector, use the connector already
paired to this ship; the **Connect subscription** link exposes that separate
connection surface. A provider name alone is not a working connection. Remote
connector transport requires HTTPS; explicit loopback test mode is not a remote
installation setting. Keep credentials in private fields or owner-only files.

Enter the objective and explicitly select the tools delegated to this session.
For initial verification, request source reading and the declared check without
editing or deployment, and delegate only the operations needed for that task.
The maximum evaluation work bounds an individual native evaluation, not the
lifetime of the grant. Grants remain active until revoked.

Choose **New session** once. Observe the retained opening and session. An
`opened` record proves native admission; it does not prove model execution.
Run the paired connector with finite turn and time limits, then verify the
session's correlated source-read, check and answer records. Never replay a
request because a client disconnected or an observation timed out.

## Review the result

Use Readymade's **Checks** and **Answer Review** for the same project/session.
Verify the source revision and actual native check results before confirming
answer completion. Recover the exact retained receipt after reconnecting.
Answer completion does not accept a code change or deploy an application.
Edits require their separate candidate checks and governed review; source landing
and deployment are also distinct outcomes.

## Qualification

On an owned test ship, the real HTTP form protocol created a project, cloned and
registered it, prepared a separate session workspace, and opened a session with
a native standing grant. No manual project-registration or grant poke was used.
The paired connector read the source and passed native compilation and the
declared functional check. Independent native readback verified all 542 source
files unchanged and all 47 apps live. This was an automated protocol test,
not a human click-through of the forms. Fresh installation, provider pairing,
additional languages/platforms and release packaging retain their own gates.

The subsequent fresh public installation also passed packaged-desktop login,
identity, readiness and refresh. Its source importer confirmed six files in two
batches; independent native readback checked every imported byte and preserved
all 540 original files. Project setup reached `ready`, and its private inactive
working desk matched the complete 546-file accepted baseline. All 49 apps stayed
live. This second run tested the real HTTP protocol without starting a model
job; provider pairing and session execution on that receiver remain unqualified.

## Repeat the rendered workspace check

After a project and its separate workspace are already `ready`, the public
`onboarding-host` check can verify their presentation in the packaged desktop.
It selects the existing record, checks the accepted revision and worker, measures
controls at three pane widths, reloads, and compares the retained native record.
It checks the served workspace script against this checkout's assembly manifest.
A stale backend script fails that comparison instead of qualifying a different
version. The check blocks every page request except GET/HEAD and fails if a page
write is attempted. It never creates a project, opens a session or starts a model.

Use an owner-only JSON authentication file containing `origin` and `code`, created
privately by the ship's owner with a trusted editor or secret manager. An
assistant must not create, read or print this file. It must be a regular file owned
by the current user, mode `0600`. Keep it outside the checkout and never paste its
contents into chat, arguments, logs or a repository. Substitute the actual app
path, receiving identity, project ID and prepared working desk below:

```sh
npm run build
READYMADE_CODE_BIN="/your/Readymade Workspace.app/Contents/Resources/VSCodium.app/Contents/Resources/app/bin/codium" \
READYMADE_BUILTIN_EXTENSION="/your/Readymade Workspace.app/Contents/Resources/VSCodium.app/Contents/Resources/app/extensions/pataphor.readymade-ship-workspace" \
READYMADE_TEST_MODULE=onboarding-host \
READYMADE_LIVE_AUTH=/your/private/auth.json \
READYMADE_EXPECTED_SHIP='~your-ship' \
READYMADE_LIVE_PROJECT=your-project \
READYMADE_WORKING_DESK=your-prepared-working-desk \
./test-host.sh
```

This test deliberately uses the nested editor CLI to launch an isolated test
profile and the installed extension; ordinary desktop use still starts the outer
Readymade app. The command prints its private evidence directory. It retains the
result and three screenshots, which can contain private project details. A pass
qualifies existing-record recovery and layout, not form submission, provider
pairing, new model execution or the full multiplayer workflow.

The project form itself has also passed a separate live acceptance run: four
invalid submissions sent no request, one valid submission created a retained
setup, and two explicit observations reached `ready`. A fresh profile recovered
that record without another POST. Native readback verified the complete private
546-file working copy and all 49 apps live. This creation test used actual DOM
form handlers; it is not performed by the read-only command above.

A separate live workspace-form acceptance run also passed: empty and blank desk
names produced no POST, one Prepare and one Observe produced a ready private
workspace, and a fresh app profile restored it without a write. Native readback
verified its complete 546-file clone and all 49 apps live. An initial test-driver
selection timeout was recovered by reading and selecting the existing record;
Prepare was never repeated. The public check above remains read-only.

New import submission has now also passed through the packaged interface: one
Hoon file was prepared locally, then Begin import, Send next part and Observe
each ran once against a new public-tool-prepared destination. Native verification
proved exact bytes, unchanged baseline files, private inactive status and a
successful functional compilation check. Browser File input was automated with
DataTransfer; the operating-system file dialog was not exercised.

## Repeat the completed-import check

Keep the source JSON downloaded from the importer. After that import is complete,
run the following against the installed packaged app, using your own private
authentication file, ship identity, imported desk and saved archive:

```sh
npm run build
READYMADE_CODE_BIN="/your/Readymade Workspace.app/Contents/Resources/VSCodium.app/Contents/Resources/app/bin/codium" \
READYMADE_BUILTIN_EXTENSION="/your/Readymade Workspace.app/Contents/Resources/VSCodium.app/Contents/Resources/app/extensions/pataphor.readymade-ship-workspace" \
READYMADE_TEST_MODULE=source-import-host \
READYMADE_LIVE_AUTH=/your/private/auth.json \
READYMADE_EXPECTED_SHIP='~your-ship' \
READYMADE_IMPORT_DESK=your-imported-desk \
READYMADE_SOURCE_ARCHIVE=/your/private/source-package.json \
./test-host.sh
```

This check uses real installed services and refuses every page write. It verifies
that the archive matches the completed native record, the shipped importer
validates its bytes and hashes, a damaged archive preserves the valid package,
and reload recovers that package with resend disabled. It also checks the served
script against the assembly manifest and requires unchanged native import rows.
The check supports archive files up to 16 MiB; this test limit does not change
the importer's package limits. Browser File input is automated, not the OS file
picker. No new import, provider or model job is created. Evidence is private and
contains identifiers and hashes, without source contents or login credentials.
