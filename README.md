# Readymade

A desktop coding workspace that brings your Urbit apps beside your code. Readymade builds on VSCodium / Code–OSS: real editor groups, local folders, search, Git, terminals and compatible extensions, with Lattice, Tlon Groups, Glurff, Noltbook calls and Landscape in retained browser editor tabs.

Use **Code · Lattice · Groups · Glurff · Calls · Landscape** to switch without replacing your open app pages. Type `groups` in a new Readymade integrated terminal to open Tlon Groups, `lattice` for Lattice's document workspace, or `landscape` for your ship's app launcher. These commands are scoped to Readymade's terminal environment; they do not change your global shell configuration. Inside these terminals, `groups` opens Tlon; use `/usr/bin/groups` for the operating system group-list command.

**Public alpha for Apple Silicon macOS.** Download the current preview below, or build from source. Opening the desktop does not install Urbit applications or modify your ship. The repository also supplies bounded native installation tools; full multiplayer coding parity and self-service backend installation acceptance are not established.

The [backend source recipes](backend/README.md) assemble the complete
coding backend candidate from included application source and pinned public
dependencies, with license notices. Use the [native installation guide](backend/install/README.md)
for owner-authorized receiver checks, staging and preservation. Noltbook has a
separate [source, activation and post-install recipe](backend/noltbook/README.md).
These paths require actual native access to the receiving ship and retained
verification receipts; a web login alone is insufficient. Independent-operator
acceptance and the release gates remain open.

The current ten-app backend source includes shared-file access, editing activity
and explicit owner-reviewed replies with complete file/check reports. Its native
compilation, original proofs and a complete captured-state migration rehearsal
pass. Live installation and real result delivery remain unfinished; historical
installation receipts do not qualify this exact candidate. Older installed
backends may lack the full-report protocol and report new shares unavailable.
Previous summary-only attempts remain check-only, without resending; see
[parity](docs/PARITY.md).

## Download and install

On an **Apple Silicon Mac (M1 or newer)**, download the `.dmg` from the
[current preview release](https://github.com/DashusNavnul/readymade/releases/tag/v0.2.0-alpha.20261111).
Open it, drag **Readymade Workspace** to **Applications**, then open the app
from Applications and eject the disk image. Running the download needs no
Node.js, npm, Python, Xcode or source build. Intel, Windows and Linux packages
are not included.

This preview uses a persistent local signing certificate and is not notarized. If macOS blocks first launch
and you trust this official download, use **System Settings → Privacy & Security
→ Open Anyway**. Follow [Apple's instructions](https://support.apple.com/en-us/102445);
do not disable Gatekeeper globally. The release includes a checksum and build information.

If macOS asks to let **Readymade Workspace** use **Readymade Workspace Safe
Storage**, enter your Mac login password only in that macOS Keychain dialog
and choose **Always Allow** for this verified build. Rebuilds from the same
signing identity retain that approval. This is separate from your Urbit login
code; neither belongs in chat.

Choose **Home → Connect your Urbit** and sign in to your own ship privately.
Any real ship works: a ship running on this Mac is found and signed in for you;
for a hosted ship enter its web address.

## Work with someone else

**To join someone's project** you need only your own ship and their invitation
link. Use **Home → Join a workspace** and paste the link. If your ship does not
have the collaboration service yet, Readymade asks once, then has your ship's
own package manager install it from the inviting ship (falling back to
`~dashus-navnul`). That is one small agent; it needs no coding worker, model
or provider on your ship, and your ship keeps it updated by itself. Nothing is
installed without that one confirmation. **Leave Project** and **Remove
Collaboration Service** undo both steps.

**To host a project for others** your ship needs the full backend. On a planet
(or larger) running on this Mac, **Home → Install Pataphor** installs it from
inside the app after showing what it will do; the collaboration service alone is
offered instead when the ship is a moon or comet or was started with too little
memory. Then open **Project Invitations**: invite a ship, copy its join link,
see each member's role and what is shared with them, offer another role, read
the project's history, and remove a member together with every grant.

Shared file access uses a separate host-granted link through **Readymade: Open
Shared Project**. See [Join a workspace](docs/JOIN_A_WORKSPACE.md). If a ship is
slow or will not connect, run **Readymade: Ship Doctor**: it measures the ship
and the Mac and says what it found, and changes nothing.

What is and is not verified: joining, leaving, rejoining, role changes and the
automatic install were run between a planet and its moon on one computer. Two
unrelated operators on separate computers have not yet run this release; treat
a first session with a new collaborator as that test, and report what happens.
Ships must be on Kelvin 408. A successful login alone does not establish shared
coding readiness.

## Build and open from source

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

**Planet purchases through Readymade are paused:** payment-to-key delivery is
not verified. The checkout action is disabled, including messages from older
panels. **Recover my purchase** opens Orraah’s support page for an existing paid
order; use the transaction ID in the Paddle receipt and request private delivery
of the assigned planet name and master ticket/keyfile. Do not buy again to retry
missing delivery. Public availability and setup links remain available; a listing
or payment receipt does not prove that a planet was issued. Connect a running
ship through Readymade’s private login. **Readymade: Get an Urbit** opens this page
from the command palette.

Packaging downloads a pinned VSCodium archive, verifies its SHA256, reruns checks and tests, then signs the app with a persistent local certificate. Rebuilds reuse that identity so Keychain can retain approval; preserve `~/Library/Application Support/Readymade/Signing` on the build Mac. The private signing key is excluded from the app and source export. Packaging does not launch or install the app, and refuses to overwrite an existing output. This build is not notarized. Keep the entire app bundle together; use its outer launcher rather than launching the nested editor directly. See [Keychain approval](docs/TROUBLESHOOTING.md) for the transition from older builds and optional Apple-issued signing.

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
