# Compatibility

Readymade is a desktop workbench that connects to your existing Urbit. This
repository contains the desktop adapter and packaging tools. It does not include
an installer or a qualified release of the ship-side coding backend.

## Existing apps

App tabs use ordinary owner authentication through Eyre. They do not require the
Pataphor workspace or coding APIs. Each app must already be installed and serving
its expected route on your ship:

| Control | Required route |
| --- | --- |
| Groups (Tlon) | `/apps/groups/` |
| Landscape | `/apps/landscape/` |
| Glurff | `/apps/glurff/` |
| Calls, using Noltbook | `/apps/noltbook/` |
| Legacy Call Board | `/apps/call` |

The controls open these existing pages and retain their tabs. They do not install
the apps. A missing route remains a missing app; successful authentication does
not establish that the app is present.

Use an exact HTTPS origin, including a port when needed. HTTP is accepted only
for `localhost`, `127.0.0.1`, or `[::1]`. A path-prefixed reverse proxy is not
supported: enter the origin, not an `/apps/...` URL. Another ship uses another
window. The `landscape` command in new integrated local terminals opens the same
retained Landscape tab.

Groups, Glurff, Noltbook and Landscape links can hand off between their managed tabs.
Arbitrary apps launched from Landscape are not part of this route allowlist.
Media capture, call signaling and peer connectivity still depend on the app,
operating-system permissions and the receiver's network configuration.

## Ship coding features

The **Connect to Ship** workspace command initializes more than app
authentication. It requires both the remote workspace state and native coding
state APIs below, with matching ship identity. On a ship without that backend,
workspace initialization can fail while the existing app tabs remain usable.

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
| Ship terminal observation and control | `GET /apps/<terminal>/state`, `GET /apps/<terminal>/events`, `POST /apps/<terminal>/action` |

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

## Desktop support and acceptance

The package builder targets macOS on Apple Silicon and pins its VSCodium
download. It assembles a locally signed application; public notarization is not
provided. Other operating systems, CPU architectures and arbitrary upstream
editor versions are not qualified by this repository.

The workbench supplies local editing, search, Git integration and integrated
terminals through VSCodium. Language servers, debug adapters and additional
extensions are separate dependencies. A Hoon debugger is not supplied.

Automated tests exercise protocol handling and simulated media ownership. They
do not prove your ship's installation, public network reachability, microphone
capture, screen/audio sharing, or a successful two-person coding session. Verify
those capabilities on the actual receiving machines before relying on them.

Start with [LLM setup](LLM_SETUP.md). Use [troubleshooting](TROUBLESHOOTING.md)
when an app or backend route is missing; do not resolve it by copying an
unverified ship installation recipe.
