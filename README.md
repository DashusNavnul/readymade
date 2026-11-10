# Readymade

A desktop coding workspace that brings your Urbit apps beside your code. Readymade builds on VSCodium / Code–OSS: real editor groups, local folders, search, Git, terminals and compatible extensions, with Lattice, Tlon Groups, Glurff, Noltbook calls and Landscape in retained browser editor tabs.

Use **Code · Lattice · Groups · Glurff · Calls · Landscape** to switch without replacing your open app pages. Type `groups` in a new Readymade integrated terminal to open Tlon Groups, `lattice` for Lattice's document workspace, or `landscape` for your ship's app launcher. These commands are scoped to Readymade's terminal environment; they do not change your global shell configuration. Inside these terminals, `groups` opens Tlon; use `/usr/bin/groups` for the operating system group-list command.

**Public alpha, built from source.** The packaged desktop currently supports **Apple Silicon macOS**. Opening the desktop does not install Urbit applications or modify your ship. The repository also supplies bounded native installation tools; full multiplayer coding parity and self-service backend installation acceptance are not established.

The [backend source recipes](backend/README.md) assemble the complete
coding backend candidate from included application source and pinned public
dependencies, with license notices. Use the [native installation guide](backend/install/README.md)
for owner-authorized receiver checks, staging and preservation. Noltbook has a
separate [source, activation and post-install recipe](backend/noltbook/README.md).
These paths require actual native access to the receiving ship and retained
verification receipts; a web login alone is insufficient. Independent-operator
acceptance and the release gates remain open.

The current ten-app backend candidate includes shared-file access, editing
activity and explicit owner-reviewed completion replies with summary and native
references. Its source assembly and offline checks pass; historical installation
receipts do not establish a fresh installation of this exact candidate. The current
desktop requests complete file/check reports for new result shares. That newer
native protocol is not yet qualified or included in the bundled backend, so new
shares remain unavailable with the bundled version. Previous summary-only share
attempts can still be checked without resending; see [parity](docs/PARITY.md).

## Build and open

You need Node.js 22 with npm, Python 3.9+, Git, Xcode command-line tools and an Apple Silicon Mac. Python is used by the backend preparation and offline verification tests. See [compatibility](docs/COMPATIBILITY.md) for platform and backend requirements.

```sh
git clone https://github.com/DashusNavnul/readymade.git
cd readymade
npm ci --ignore-scripts
npm run check
npm run lint
npm test
./package.sh
open "dist/Readymade Workspace.app"
```

An empty window opens **Readymade Home**. Choose **Open a project** for a local
folder, **Connect your Urbit** for your apps, or **Join a workspace** for an
invitation. Use **Home** in the sidebar or bottom bar to return at any time.

Choose **Connect your Urbit**, select a verified running planet on this computer
and sign in through the private login field if needed. Hosted ships can still
be added by web address. **Your Urbit** shows the connected identity, available
app pages and a separate coding status. No Settings edit is required.

**Need a planet? Get an Urbit** opens the new-planet page. The proposed service offers a free identity at signup, paid monthly
hosting and services, and a USD 10 ownership buyout with a path to self-hosting.
Until buyout, the star operator retains ownership. **Signup is not active:** no
provider allocation, subscription, buyout or provisioning integration is available.
Hosting prices and service terms are not yet published. See
[the service policy and implementation requirements](docs/STAR_SERVICES.md).

The separate direct-purchase section opens Orraah’s public catalog, checkout and
setup links. It is not the proposed free-signup service or USD 10 buyout.
Availability is not a reservation, and generic checkout does not select a listed
planet. Connect a running ship through Readymade’s private login; Readymade does
not automatically issue or boot one. **Readymade: Get an Urbit** also opens this
page from the command palette.

Packaging downloads a pinned VSCodium archive, verifies its SHA256, reruns checks and tests, then creates a locally ad-hoc signed app. It does not launch or install the app, and refuses to overwrite an existing output. This build is not notarized. Keep the entire app bundle together; use its outer launcher rather than launching the nested editor directly.

To prepare a source handoff from a working checkout, run `node platform/export-source.cjs /path/to/new-readymade-source`. This copies only the explicit inventory in `platform/source-files.json` and writes `SOURCE-MANIFEST.json` with file hashes, sizes and executable modes. It refuses existing output directories, missing inputs and linked files. Profiles, dependencies, build output and unlisted files are excluded. Review the included source before publishing: the exporter does not detect secrets inside source files. In the exported directory, use the same dependency, verification and packaging commands above. Exporting does not publish a release or install the ship backend.

## Connect your own ship

Choose **Home → Connect your Urbit** and pick your planet from the running list.
Readymade checks the actual local runtime, native ship identity, real/fake flag
and matching web listener. Stopped piers, test ships and duplicate identities
are excluded. The selected planet is checked again before private sign-in, and
its login identity must match the selection before a new code is saved.
Discovery is a bounded read-only check; it does not boot, mount or modify ships.

For a hosted planet or another computer, choose **Enter a ship’s web address**.
Enter an address such as `ship.example` or `localhost:8080`, then enter the access code in the private password field.
Remote addresses use HTTPS; HTTP is allowed only for loopback. An ordinary
`/apps/...` URL or ship login URL can be pasted too. Addresses with credentials,
queries, fragments or reverse-proxy prefixes are refused. Never put an access
code in a conversation, command line, source file or issue.

Readymade remembers the address and stores a newly entered code only after the
ship accepts it. If a saved code is rejected, the private field lets you replace
it. Missing app pages or coding services do not require another login. **Your
Urbit** checks existing pages without installing apps; found pages become
available before the optional coding checks finish. Returning app buttons reuse
the current or remembered connection.

Lattice opens `/apps/lattice/app` (its reader is `/apps/lattice`); Tlon Groups opens `/apps/groups/`; Landscape opens `/apps/landscape/`; Glurff opens `/apps/glurff/`; Calls opens `/apps/noltbook/`. Those apps must already be installed and available on your ship. Opening an app does not place a call or start capture. A second ship uses a separate window. In a new integrated terminal, type `landscape`, `groups`, `lattice`, `glurff` or `noltbook` to open the same retained app tab. These commands take no arguments and use the current Readymade profile.

**Connect to Ship** opens the same connection page. **Open coding workspace**
additionally requires matching Pataphor and native coding endpoints. A plain
Urbit can sign in and open its installed apps without that backend. Missing
coding endpoints are reported separately from authentication.

Lattice is a separate ship application, distributed from `~ricsul-bilwyt` on `%grubbery`. Follow its [upstream installation instructions](https://lattice.nisfeb.com/#install) and approve its requested permissions on your ship before opening the tile. Readymade does not install or grant agent access to Lattice automatically. Its reader and editor stay within the exact `/apps/lattice` route or its `/apps/lattice/` descendants on your ship; similarly named routes are not admitted.

Live local-ship verification passed for the `lattice` terminal command, rendered editor and page retention when switching to Code and back. A new installation still needs its own checks; installation acknowledgement alone is not readiness. Lattice uses the separate **PolyForm Noncommercial** license; Readymade's MIT license does not cover Lattice, and this repository does not vendor its source.

## Collaborate with DashusNavnul

Start with [Join a workspace](docs/JOIN_A_WORKSPACE.md): build Readymade, connect your own ship, and use the host's actual group invitation. The guide includes a copyable LLM prompt and the separate requirements for shared coding execution. Group membership does not automatically grant project access. The included [native installation tools](backend/install/README.md) require separate owner authorization, actual native access and verification; they do not provide automatic multiplayer onboarding.

## What is implemented

- Native Code–OSS editing and local development tools, with bundled Hoon syntax support. TypeScript language features and Node debugging have passed packaged-host checks on Apple Silicon macOS. Other language servers and debug adapters require separate qualification.
- Retained Urbit app tabs, exact-origin authentication and native media permission handling.
- With a compatible backend: project/session selection, retained shared request inspection, explicit permission review, submit-once handling and native outcome recovery.
- Project file browsing, paginated and complete-file reads, immutable ship snapshots, private drafts, source diffs, native checks, code review and answer acceptance, plus ship terminal observation/control.

Urbit owns canonical project state, permissions and execution. The desktop holds presentation state and local drafts; saving a draft does not change the ship. A recorded instruction or prepared candidate does not prove completed work or deployment.

Historical live runs reported file browsing, governed changes, native checks,
review and landing, plus two-ship messaging and physical-camera call continuity.
A later run reported direct cross-network browser media on an earlier HTML
build. Some original remote/cross-network reports were stored in temporary
directories and are no longer available for independent rechecking. See the
[current evidence audit](docs/PARITY.md#current-evidence-audit--november-8) for
retained proofs and remaining work. Physical screen/system-audio sharing,
current end-to-end qualification and supported release acceptance remain open.
Local fixtures do not establish compatibility with your ship.

## Set up with an LLM

Copy this prompt into your coding assistant:

> Help me build Readymade from https://github.com/DashusNavnul/readymade and connect it to my own Urbit. Read README.md, docs/LLM_SETUP.md and docs/JOIN_A_WORKSPACE.md first. Check my platform and prerequisites, build and verify the desktop, then guide me through private in-app authentication. Never ask me to paste my access code into chat. Do not boot, SSH into or modify my ship to connect the UI. Clearly distinguish desktop checks, installed app availability and the separate shared coding backend requirements.

Follow [LLM setup](docs/LLM_SETUP.md), [troubleshooting](docs/TROUBLESHOOTING.md) and [security](docs/SECURITY.md). Readymade source is [MIT licensed](LICENSE); bundled upstream components retain their own licenses and notices.
