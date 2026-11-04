# Security and credentials

Connect only to a ship you own or are authorized to operate. Enter its exact
origin and check it before supplying the ship login code. The login code belongs
in Readymade's password prompt—not an LLM conversation, repository, issue,
terminal command, screenshot, or log.

## Credential handling

The desktop sends the code to that origin's `/~/login` endpoint. HTTPS is
required except for loopback HTTP. The HTTP adapter does not follow redirects
to another origin. Scheme, hostname and port are part of the connection boundary.

Codes entered in the password prompt are stored through the editor's
`SecretStorage`, keyed by exact origin. Protection depends on the editor's
operating-system credential integration. The adapter also supports an existing
local Readymade saved-code file as a compatibility source; that file must be
owned by the current user, have mode `0600`, and not be a symlink. It is checked
before editor secret storage. The prompt does not write codes to that file.

Browser tabs receive session cookies rather than the login code. Managed
cookies are HttpOnly, host-only, and Secure for HTTPS. The browser adapter strips
managed authentication cookies from requests to other origins, including other
ports. Managed tabs use ephemeral browser storage. Disconnecting media releases
the owned browser bindings; it does not delete a saved login code, erase local
request history, or revoke permission on the ship.

Local source drafts, request text, receipts and retry-prevention records can
remain in the editor profile. These are not all secret-store entries or an
encrypted archive. Treat the profile and any backups as private. Do not upload
them as a support bundle.

## App and execution boundaries

Managed tabs admit the selected ship's Groups, Landscape, Glurff, Noltbook and legacy
call routes. A tab is bound to its origin and app kind. Cross-app handoffs use
the supported route allowlist; arbitrary foreign navigation is refused. The
browser contents require sandboxing and context isolation to be enabled, with
Node integration disabled for the page.

Media setup authenticates and opens existing pages. It does not install ship
agents, change their source, create coding grants, or activate a deployment.
The opened app remains responsible for its own behavior and actions. Use its
normal controls to start or join calls. Operating-system capture permissions
still apply; screen capture uses an explicit selection flow.

Coding and terminal commands can have real effects when deliberately submitted.
The desktop binds coding actions to observed source and session identities.
Ship-side permissions and review remain authoritative. A submitted receipt is
not proof of execution, successful checks, acceptance, or deployment.

When a write's result is unknown, the adapter retains that uncertainty and
prevents automatic replay. Observe the original request before deciding what to
do next. Do not clear journals or create replacement identities merely to force
a retry. A local draft save does not change canonical ship source.

The integrated local terminal runs with your local account's privileges. The
generated `landscape` and `groups` commands only ask the packaged editor CLI to open the
registered app URI with the selected local profile. They accept no
arguments and do not modify global shell configuration. Neither is a remote
shell or a ship installer. The package trusts its own bundled URI handler so
these local app commands need no repeated permission dialog. The handler admits
only its exact Groups and Landscape URIs; other extensions retain upstream policy.

## Local trust and reporting

The native browser bridge uses a private local socket. The adapter checks its
ownership and permissions before connecting. These checks do not protect
against a compromised local account, operating system, or untrusted editor
extension. Install extensions and run project code with that trust boundary in
mind.

Never include credentials, cookies, private source, request transcripts or raw
profile files in a public report. For a suspected vulnerability involving those
materials, arrange a private reporting channel with the repository maintainer
before sharing details. If a credential was exposed, revoke or replace it
through the owning service; deleting a public message alone is insufficient.

See [compatibility](COMPATIBILITY.md) for what the desktop does and does not
install, and [troubleshooting](TROUBLESHOOTING.md) for bounded diagnostics.

## Development dependency audit

The initial source release pins its verified build tools. `npm audit` on
2026-11-04 reports seven moderate findings in the development-only
`typescript-eslint` dependency chain, originating in the transitive `minimatch`
glob-parts amplification advisory (GHSA-g3hv-75wg-m249). These tools are not
copied into the desktop application. Run linting only on trusted source;
updating the toolchain requires rerunning checks. This is a known outstanding
build-tool issue, not a claim that all dependencies are vulnerability-free.
