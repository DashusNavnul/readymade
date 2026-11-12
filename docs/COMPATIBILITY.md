# Compatibility

Readymade is a desktop workbench that connects to your existing Urbit. This
repository contains the desktop adapter, packaging tools and bounded
[native backend installation tools](../backend/install/README.md). The native
path requires owner authorization, actual native access and verification on the
receiving ship. Full self-service backend release acceptance remains open.

## Proposed star services and existing direct purchase

**Home → Need a planet? Get an Urbit** presents the operator’s proposed
free identity at signup, paid monthly services and USD 10 ownership buyout.
The issuing star’s operator retains ownership until transfer; sponsorship alone
does not establish ownership. Signup is disabled. No provider agreement,
subscription price, allocation, provisioning or buyout API is implemented or
verified. Compute, arbitration and QPC/corpus workspace guidance are proposed
service scopes, not a claim of live hosted functionality. See
[STAR_SERVICES.md](STAR_SERVICES.md) for the required contract and acceptance gates.

Planet checkout through Readymade is disabled until payment-to-key delivery is
verified. Stale `checkout` messages are refused too. **Recover my purchase** opens
[Orraah support](https://www.orraah.com/support); it does not send a message or
retrieve a key. The provider must trace paid orders using their Paddle transaction
IDs and privately deliver the assigned identity and necessary credentials.

The public `https://updates.orraah.com/api/planets` catalog remains available on
explicit opening or refresh. Requests omit credentials, refuse redirects, and
have an eight-second timeout and a 128 KiB response limit. Restoring the tab does
not repeat a request. The fixed support and download links open externally only
on explicit action. Listings are not reservations or evidence of paid-order
fulfillment. No Orraah free-identity or subscription agreement is asserted.

Never enter a master ticket in Readymade or chat. Use the provider’s own secure
identity flow and return with the running ship’s web address. App authentication
uses Readymade’s private password field. A new identity does not include a
verified shared coding backend. Existing native parity and independent backend
release gates remain unchanged.

## Existing apps

App tabs use ordinary owner authentication through Eyre. They do not require the
Pataphor workspace or coding APIs. Each app must already be installed and serving
its expected route on your ship:

| Control | Required route |
| --- | --- |
| Lattice | `/apps/lattice/app` (default editor); `/apps/lattice` (reader) |
| Groups (Tlon) | `/apps/groups/` |
| Landscape | `/apps/landscape/` |
| Glurff | `/apps/glurff/` |
| Calls, using Noltbook | `/apps/noltbook/` |
| Legacy Call Board | `/apps/call` |

The controls open these existing pages and retain their tabs. They do not install
the apps. A missing route remains a missing app; successful authentication does
not establish that the app is present.

In current source, **Home → Connect your Urbit** lists verified real galaxies,
stars, planets, moons and comets running on this computer. The selected process,
native identity, socket and web listener are checked again before sign-in. The
authenticated identity must match that selection before a new code is saved.
Stopped piers, fake ships and duplicate identities are excluded. This bounded
macOS discovery reads owned process/socket metadata and native identity; it does
not boot ships or install anything. Choose **Enter a ship’s web address** for
hosted ships or a local runtime that discovery cannot verify. No
Settings edit is required. Bare remote hostnames use HTTPS, and bare loopback
addresses use HTTP. A normal `/apps/...` or `/~/login` link is reduced to its
origin. Query strings, fragments, credentials and path-prefixed reverse proxies
are refused. The low-level transport still requires an exact origin. HTTP is
accepted only for `localhost`, `127.0.0.1`, or `[::1]`. Another ship uses another
window. The `landscape` command in new integrated local terminals opens the same
retained Landscape tab. `groups` opens Tlon Groups; `lattice` opens Lattice's
document workspace; `glurff` and `noltbook` open those apps. Each command
accepts no arguments.

The [current preview](https://github.com/DashusNavnul/readymade/releases/tag/v0.2.0-alpha.20261111.5) discovers every
real ship class running on the Mac. A planet, a moon and comets have been
connected live with the packaged app; the other classes have automated discovery
and authentication coverage only. Ship class does not establish installed app
availability.

Lattice, Groups, Glurff, Noltbook and Landscape links can hand off between their managed tabs.
Arbitrary apps launched from Landscape are not part of this route allowlist.
Media capture, call signaling and peer connectivity still depend on the app,
operating-system permissions and the receiver's network configuration.

Lattice navigation admits only the exact `/apps/lattice` path and descendants
beginning `/apps/lattice/` on the selected origin. Reader/editor navigation stays
within that app; this does not admit similarly named paths or a different ship.
Install Lattice separately using its [official instructions](https://lattice.nisfeb.com/#install),
from `~ricsul-bilwyt` on `%grubbery`. An installation still downloading is not ready;
the local-ship editor, terminal command and retention across Code/app switches have passed a live check. This does not establish cross-ship sharing or filesystem mounts. Lattice is separately
licensed under PolyForm Noncommercial. No Lattice source is bundled in this MIT
Readymade repository.

## Guest invitation readiness in current source

**Your Urbit → Join a workspace** becomes available when a bounded, read-only
`GET /apps/readymade-collab/project-invitation-requests` returns the supported
catalog for the authenticated ship. HTTP 404 is reported as missing; refused,
malformed, foreign-owner or unavailable responses remain unverified. The probe
does not accept an invitation or grant membership, source access or execution.

A guest needs this collaboration service and the owner's actual invitation,
but does not need a local Viki coding session or model/provider connection to
join. The host's coding setup and subsequent project grants are separate. The
existing **Home → Join a workspace** flow still checks the invitation's exact
recipient and current authenticated connection before submitting.

| Current-source change | Verified scope | Still required |
| --- | --- | --- |
| Local discovery and selected-identity login for every real ship class | Automated identity/rank, stale-selection and authentication checks | Exact-package and live receiving-ship acceptance for every class |
| Guest invitation readiness without a local coding backend | Read-only HTTP fixtures, schema and authenticated-owner checks | Run live with the packaged app between a planet, its moon and two unrelated comets on one Mac; two people on separate computers still required |

These additions are included in the current preview. They do not
qualify a first installation on the receiving operator's ship or a twelve-person
workspace. Follow the separate [native installation guide](../backend/install/README.md)
when owner-authorized installation is needed, and retain receiver-specific proof.

## Ship coding features

**Connect to Ship** opens **Your Urbit**, separating successful authentication
and available app pages from the optional coding checks. App availability is
reported before those coding checks finish. **Open coding workspace** requires
both the remote workspace state and native coding state APIs below with matching
identity for the authenticated ship. A missing local coding backend leaves the
existing app connection and separately verified guest invitation flow usable.

| Feature | Required backend endpoints |
| --- | --- |
| Workspace discovery | `GET /apps/pataphor/remote/state.json` |
| Coding projects, sessions, source and results | `GET /apps/pataphor-native/coding/state` |
| Source-bound coding requests and candidate preparation | `POST /apps/pataphor-native/coding/action` |
| General Pataphor requests | `POST /apps/pataphor/remote/submit` |
| General request receipts | `GET /apps/pataphor/remote/receipt.json` |
| Shared retained request catalog | `GET /apps/readymade-collab/workspace-requests` |
| Shared request details and admission preview | `GET /apps/readymade-collab/workspace-request`, `GET /apps/readymade-collab/workspace-preview` |
| Explicit shared submission and recovery observation | `POST /apps/readymade-collab/workspace-submit`, `POST /apps/readymade-collab/workspace-recover` |
| Complete file/check result preview and explicit sharing (included source; live acceptance pending) | `POST /apps/readymade-collab/workspace-return-rich-preview`, `POST /apps/readymade-collab/workspace-return-rich-confirm` |
| Observe an original full-report sharing attempt (included source; live acceptance pending) | `GET /apps/readymade-collab/workspace-return-rich-result` |
| Observe a previous summary-only sharing attempt | `GET /apps/readymade-collab/workspace-return-result` |
| Inspect a request's changed files and check reports (included source; live acceptance pending) | `GET /apps/readymade-collab/workspace-result` |
| Ship terminal observation and control | `GET /apps/<terminal>/state`, `GET /apps/<terminal>/events`, `POST /apps/<terminal>/action` |

New result shares use the full-report v2 protocol. The desktop validates the
report's request, source revisions, changed files and check diagnostics before
offering confirmation. The corresponding source is now bundled and passes native
compilation, original proofs and a complete captured-DATA migration rehearsal.
Live installation and real delivery remain pending. New shares report unavailable on
older installations; there is no automatic fallback to a summary-only message.
Previous v1 claims are observed through their original GET endpoint and cannot
be upgraded into another send. Both versions use the same local exclusion key.

The desktop's **Inspect Files and Checks** command needs the included result
endpoint, whose live historical reads remain unverified. Neither feature is
established by an older backend installation receipt. Full-report sharing is bounded to
128 KiB of outgoing message text and a 512 KiB encoded reply; oversized or
incomplete evidence is refused rather than truncated. These are application
bounds, not verified Noltbook transport limits.

Supported ship terminal names are `pataphor-terminal`, `pataphor-terminal-b`,
`pataphor-terminal-c`, and `pataphor-terminal-d`. They are separate from the
editor's ordinary local integrated terminals.

These are versioned protocols, not interchangeable JSON endpoints. The adapter
checks identifiers, source bindings, response shapes and request correlation.
The coding state request carries session and cursor parameters; shared request
reads use specific protocol headers. See [the HTTP adapter](../src/ship-client.ts),
[coding snapshot validation](../src/protocol.ts), and
[shared request validation](../src/workspace-request-store.ts).

An older backend may expose coding state while lacking the shared request
protocol. Endpoint presence alone does not prove compatibility. This public
repository does not qualify an existing backend bundle as compatible with all
of these features.

Before using coding features, the receiving owner needs a compatible backend,
a registered private project, a suitable coding session, the required grants,
and a working model/provider connection. The desktop does not supply those
permissions or turn ordinary shared chat into an execution request. Reviewing
or submitting work, accepting changes, and deploying an application are distinct
operations governed by the ship.

### Backend distribution gates

The [complete source assembly](../backend/README.md) reconstructs the current
1,492-file backend from included application source and pinned public inputs:
943 application files, 543 inherited or derived Urbit files, four browser assets,
and six accompanying notice files. The ten-app installation bill is distinct
from historical development/staging bills. Use the shipped receiver tools and
the receiving ship's actual inventory; never copy a development bill.

Current source extraction and offline installer checks pass. Activity,
shared-source, suggestion recovery and owner inbox code have native compilation
and bounded proof evidence. The full-report result and sharing code also passes
native compilation, original proofs and the actual captured-DATA rehearsal;
fresh installation of this exact ten-app bundle remains unqualified.

The earlier nine-app installation path passed on a fresh owned receiver. All nine
apps, 194 mark graphs and six runtime threads compiled; bounded evaluation
passed. One supported native activation produced 49 live apps. The public
preservation verifier passed all 18 declared checks: 40 prior app identities,
saved types and protected fields preserved; 39 saved-DATA values exact; only
bound inspection activity changed Spider's saved data. Existing HTTP bindings
and unrelated desks remained exact. Strict whole-carrier equality is not claimed.
Authenticated HTTP checks passed for the owner and all four pinned editor assets;
anonymous and wrong-owner controls were refused. The underlying receipts and
historical failures are retained in [the parity record](PARITY.md).

Subsequent packaged-desktop tests on that receiver passed connection, source
import, project creation and private workspace preparation. Native readback
verified source bytes, private desks and app liveness. The public
[onboarding checks](NATIVE_ONBOARDING.md) reproduce completed import validation
and ready-workspace recovery without creating new work. A separate fresh owned
receiver also completed provider pairing and real source-read/check/answer
execution. These are scoped acceptance runs, not proof that every receiver or
provider configuration works.

Remaining distribution gates include complete Noltbook notice coverage, remote
HTTPS/provider configuration, supported distributable desktop releases and
additional platform/network coverage. A compatible receiver still needs its own
identity, collision, source, runtime and preservation checks. Hosted operators
need their host's supported native access; a web login alone cannot run this
installation path. The full multiplayer parity goal remains open.

The [current evidence audit](PARITY.md#current-evidence-audit--november-8)
distinguishes retained results from historical reports whose temporary original
receipts are no longer available. In particular, remote installation/pairing and
cross-network media narratives are not presently sufficient for an independent
release audit. Preserve original source, result and cleanup bindings outside
temporary directories when repeating acceptance.

Do not copy the development desk or replace identity guards as a setup shortcut.

The [pinned Noltbook source recipe](../backend/noltbook/README.md) reconstructs
all 39 tested Noltbook files from their public upstream commit without private
repository access. It validates every file before creating output and does not
install or modify a ship. The pinned upstream declares MIT in its docket but
has no full notice file; that notice-coverage gate remains explicit. This recipe
does not establish a complete backend or media installation.

## Native evaluation capability

Coding checks need bounded evaluation on the ship that executes them. The
backend's `bounded-runtime:native-coding-tools` probe must confirm soft timeout
recovery before a coding session is qualified. In a negotiated worker setup,
the current worker receipt must advertise `%bounded-evaluation-v1`.

An old executable may compile candidates successfully while refusing every
behavioral check with `evaluation-runtime-unavailable`. This is a runtime
incompatibility, not a failing source test. Do not bypass the guard, increase
the allowance, or report a compiled candidate as checked. A runtime replacement
requires the receiving owner's authorization, state preservation and fresh live
capability verification. This repository does not supply a qualified backend
runtime installer; no development binary path is an installation default.

A [reproducible evaluator source package](../runtime/README.md) is included for
macOS arm64 qualification. It reconstructs the tested source from a pinned
public Urbit commit and retains the upstream license. A fresh public checkout
passed source verification, six runtime regression targets and the Hoon
bounded-evaluation proof. This does not install the ship-side backend or prove
live state migration. Runtime activation remains an owner-authorized operation.

The clean public export also passed runtime reconstruction, all six native
regression targets, a Linux x86_64 musl build and the standalone Hoon proof on
a remote machine. Backend assembly matched the Mac package byte-for-byte, and
type checking, lint and 305 tests passed there. This is Linux build/tooling
evidence; no Linux ship boot, native installation or Linux desktop UI was tested.

The native installation preflight diagnostic has also passed on the installed
owned test backend: all six required runtime threads compile and the finite
bounded-evaluation probe passes. The same diagnostic's earlier old-runtime
refusal is retained. This validates the diagnostic on a supported live runtime;
it does not establish another ship's readiness. Use the separate
[native installation tools](../backend/install/README.md) for receiver checks.

## Desktop support and acceptance

The package builder targets macOS on Apple Silicon and pins its VSCodium
download. It assembles a locally signed application; public notarization is not
provided. Other operating systems, CPU architectures and arbitrary upstream
editor versions are not qualified by this repository.

The workbench supplies local editing, search, Git integration and integrated
terminals through VSCodium. The packaged TypeScript language service and
JavaScript debug adapter passed real host tests on macOS Apple Silicon:
completion, hover, definition lookup, cross-file rename, formatting, type-error
reporting and clearing, and Node breakpoint/stack/watch/step/output/normal exit.
The tested editor is 1.143.1 with js-debug 1.140.0 and external Node 22.23.4.
The packaged HTML, CSS and JSON services also pass a real host test: HTML tag
completion, hover, local stylesheet link resolution and formatting; CSS property
diagnostics, completion, hover, correction and formatting; JSON local-schema
validation, enum completion, outline, correction and formatting. These checks
use the built-in services in editor 1.143.1 on macOS arm64, with isolated project
files and a local JSON schema. They do not qualify additional debug adapters.
Installed Open VSX Python 2026.4.0 (Jedi) and Python Debugger 2026.6.0 also
pass cross-file definition/rename and real launch-debug breakpoint, stack,
watch, step-over, output and normal termination checks in editor 1.143.1 on
macOS arm64 with Python 3.11.17. They were installed into an isolated extension
directory using the shipped CLI; they are not bundled. Optional Ruff 2026.94.0
also passed unused-import diagnostics, the actual remove-import quick fix,
whole-document formatting, execution of the formatted program, and undefined-name
diagnostics that cleared after repair. See `tests/python-tools-host.ts` and the
[Python tools acceptance](PARITY.md#python-formatting-and-live-diagnostics-verified).
Loopback attachment to an independently launched Python process also passed
breakpoint, stack, watch, step-over, output and normal termination checks in
the packaged editor; see `tests/python-attach-host.ts`.
Optional Basedpyright 1.40.2 passed cross-file argument and assignment type
diagnostics, typed hover and repeated live error correction in the packaged
editor. See [Python type analysis acceptance](PARITY.md#python-type-analysis-verified).
Cross-machine attachment also passed from the packaged macOS editor to Python
3.14.4/debugpy 1.8.22 on a separate Linux VM through an authenticated TLS tunnel.
Source mapping, the remote process identity, breakpoint, watch, stepping and
normal remote exit were verified. See `tests/python-remote-host.ts`. PID injection
remains unqualified. Debug ports must stay private; the test tunnel is not a
bundled remote-access service.
Other language servers and debug adapters require separate qualification.
A Hoon debugger is not supplied.

The November 5 CLI candidate fixes the nested upstream `codium` shell launcher's
app-path lookup. Direct invocation, a relative symlink and the separate native
`ReadymadeCLI` return the pinned VSCodium version. The real language/debugger
host test also passes through the repaired shell launcher. Packaging refuses an
unexpected upstream script instead of applying an unchecked replacement.
This candidate is locally signed and tested, not installed or notarized.

Automated tests exercise protocol handling and simulated media ownership. They
do not prove your ship's installation, public network reachability, microphone
capture, screen/audio sharing, or a successful two-person coding session. Verify
those capabilities on the actual receiving machines before relying on them.

Start with [LLM setup](LLM_SETUP.md). Use [troubleshooting](TROUBLESHOOTING.md)
when an app or backend route is missing; do not resolve it by copying an
unverified ship installation recipe.
