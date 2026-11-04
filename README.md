# Readymade

A desktop coding workspace that brings your Urbit apps beside your code. Readymade builds on VSCodium / Code–OSS: real editor groups, local folders, search, Git, terminals and compatible extensions, with Tlon Groups, Glurff, Noltbook calls and Landscape in retained browser editor tabs.

Use **Code · Groups · Glurff · Calls · Landscape** to switch without replacing your open app pages. Type `groups` in a new Readymade integrated terminal to open Tlon Groups, or `landscape` for your ship's app launcher. These commands are scoped to Readymade's terminal environment; they do not change your global shell configuration. Inside these terminals, `groups` opens Tlon; use `/usr/bin/groups` for the operating system group-list command.

**Public alpha, built from source.** The packaged desktop currently supports **Apple Silicon macOS**. This repository supplies the desktop application; it does not install the Urbit applications or the shared coding backend. Full multiplayer coding parity and a self-service installation of that backend are not established.

## Build and open

You need Node.js 22 with npm, Git, Xcode command-line tools and an Apple Silicon Mac. See [compatibility](docs/COMPATIBILITY.md) for platform and backend requirements.

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

Packaging downloads a pinned VSCodium archive, verifies its SHA256, reruns checks and tests, then creates a locally ad-hoc signed app. It does not launch or install the app, and refuses to overwrite an existing output. This build is not notarized. Keep the entire app bundle together; use its outer launcher rather than launching the nested editor directly.

## Connect your own ship

Before your first connection, open Settings, search for **Readymade: Origin** (`readymade.origin`) and set your own exact HTTPS ship origin, such as `https://ship.example`, or a localhost HTTP origin when the ship is local. Then click **Groups**, **Landscape**, **Glurff** or **Calls**. Enter the ship access code only in the application's private password field. Never put it in an LLM conversation, command line, source file or issue.

Tlon Groups opens `/apps/groups/`; Landscape opens `/apps/landscape/`; Glurff opens `/apps/glurff/`; Calls opens `/apps/noltbook/`. Those apps must already be installed and available on your ship. Opening an app does not place a call or start capture. A second ship uses a separate window.

The **Connect to Ship** coding command additionally requires compatible Pataphor and native coding endpoints. A plain Urbit ship can authenticate and open its installed app pages without providing that backend. A missing coding endpoint is not evidence that the access code is wrong.

## Collaborate with DashusNavnul

Start with [Join a workspace](docs/JOIN_A_WORKSPACE.md): build Readymade, connect your own ship, and use the host's actual group invitation. The guide includes a copyable LLM prompt and the separate requirements for shared coding execution. Group membership does not automatically grant project access, and the native coding backend installer is not included yet.

## What is implemented

- Native Code–OSS editing and local development tools. Language servers and debug adapters are separate extensions.
- Retained Urbit app tabs, exact-origin authentication and native media permission handling.
- With a compatible backend: project/session selection, retained shared request inspection, explicit permission review, submit-once handling and native outcome recovery.
- Read-only retained ship file snapshots, separate local drafts, explicit candidate preparation and ship terminal observation/control.

Urbit owns canonical project state, permissions and execution. The desktop holds presentation state and local drafts; saving a draft does not change the ship. A recorded instruction or prepared candidate does not prove completed work or deployment.

Whole-project file browsing, automatic complete-file reads and full end-to-end multiplayer coding remain incomplete. Local fixtures do not prove a real two-peer call, device capture or compatibility with your ship. Test those separately before relying on them.

## Set up with an LLM

Copy this prompt into your coding assistant:

> Help me build Readymade from https://github.com/DashusNavnul/readymade and connect it to my own Urbit. Read README.md, docs/LLM_SETUP.md and docs/JOIN_A_WORKSPACE.md first. Check my platform and prerequisites, build and verify the desktop, then guide me through private in-app authentication. Never ask me to paste my access code into chat. Do not boot, SSH into or modify my ship to connect the UI. Clearly distinguish desktop checks, installed app availability and the separate shared coding backend requirements.

Follow [LLM setup](docs/LLM_SETUP.md), [troubleshooting](docs/TROUBLESHOOTING.md) and [security](docs/SECURITY.md). Readymade source is [MIT licensed](LICENSE); bundled upstream components retain their own licenses and notices.
