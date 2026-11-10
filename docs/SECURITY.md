# Security and credentials

Connect only to a ship you own or are authorized to operate. Choose its verified
local identity, or check its web address before supplying the ship login code.
The login code belongs in Readymade's password prompt—not an LLM conversation, repository, issue,
terminal command, screenshot, or log.

## Credential handling

The desktop sends the code to that origin's `/~/login` endpoint. HTTPS is
required except for loopback HTTP. The HTTP adapter does not follow redirects
to another origin. Scheme, hostname and port are part of the connection boundary.

The public transport test exercises actual TLS with newly generated local
certificates and synthetic credentials. Untrusted and wrong-host certificates
are rejected before any HTTP login reaches the server. A trusted connection
retains the secure session cookie; a redirect to another port is not followed.
A socket loss after a write leaves the outcome unknown and blocks a duplicate
submission. The test trusts its temporary certificate only in the isolated
child process; it never disables certificate verification or changes system
trust. Run `npm run build && node --test dist/tests/tls-transport.test.js`
with OpenSSL on PATH. This is local TLS protocol evidence, not acceptance of
a remote ship, public certificate chain or browser login.

Codes entered in the password prompt are stored through the editor's
`SecretStorage`, keyed by exact origin. Protection depends on the editor's
operating-system credential integration. The adapter also supports an existing
local Readymade saved-code file as a compatibility source; that file must be
owned by the current user, have mode `0600`, and not be a symlink. It is checked
after editor secret storage. The prompt does not write codes to that file.
Replacement codes take precedence over remembered values and are stored only
after successful sign-in with a single validated ship identity.

## Local planet discovery

The macOS picker inspects same-user runtime processes, their held pier locks,
owned native sockets and matching TCP listeners. It sends only fixed read
queries for identity, liveness, HTTP port and Jael's fake-ship flag, followed by
an unauthenticated loopback Eyre header check. It never executes a discovered
binary, reads runtime command arguments or keyfiles, boots a pier, starts a
thread, mounts a desk or changes a ship lock. Each scan has an eight-second
deadline, a candidate cap and bounded query frames.

Discovered connections use the verified listener's literal IPv4 or IPv6 loopback
address, rather than resolving `localhost`. A process listening on the other
address family at the same port cannot receive that connection's login code.
Saved codes remain bound to their exact origin; changing to a literal address
may require signing in privately again.

Only unique, live, non-fake planet identities enter the list. The selected row
is verified again before authentication, and the returned login cookie must
identify that planet before any replacement code is stored. Discovery records
are transient observations, not ship authority or proof of ownership. Hosted
ships remain available through explicit address entry.

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

The composer backup retains only validated `nb-composer-v1` draft records for
the connected origin and ship in private files under the extension's
`composer-drafts` directory. These files contain unsent message text and
reply/edit references; they are not encrypted secret-store entries. Cookies and
other browser storage are excluded. Restoring a draft does not submit it or
grant permissions. Clearing a draft removes its backup when the storage event
is received. A backup failure warns you to copy the text before closing the pane.
The browser session itself remains ephemeral.

## App and execution boundaries

Managed tabs admit the selected ship's Lattice, Groups, Landscape, Glurff, Noltbook and legacy
call routes. A tab is bound to its origin and app kind. Cross-app handoffs use
the supported route allowlist; arbitrary foreign navigation is refused. The
browser contents require sandboxing and context isolation to be enabled, with
Node integration disabled for the page.

Lattice opens at `/apps/lattice/app`. Its reader and editor are admitted only
at `/apps/lattice` or within `/apps/lattice/` on that same origin. This app
boundary does not permit similarly named routes, foreign origins or additional
ship permissions. Installing Lattice and approving its permissions are separate
owner actions governed by its upstream instructions and license.

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

Shared-request submissions in the updated desktop also acquire an immutable,
private file claim before sending. Windows and workspaces using the same editor
profile compete for that one claim, keyed by exact origin, owner, requester and
nonce. A lost response, partial claim or changed request digest cannot free it.
Explicit native outcome recovery remains available. This does not coordinate
separate profiles, machines or older clients; native admission and request
identity remain authoritative across participants. Existing per-workspace
attempt records are retained, not reset or treated as permission to replay.

The integrated local terminal runs with your local account's privileges. The
generated `landscape`, `groups` and `lattice` commands only ask the packaged editor CLI to open the
registered app URI with the selected local profile. They accept no
arguments and do not modify global shell configuration. None is a remote
shell or a ship installer. The package trusts its own bundled URI handler so
these local app commands need no repeated permission dialog. The handler admits
only its exact Groups, Landscape and Lattice URIs; other extensions retain upstream policy.

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

The source release pins its build tools. A scoped npm override selects
`minimatch` 11.0.1 for `@typescript-eslint/typescript-estree`, addressing
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
The linter's other dependency branches remain unchanged. Remove the override
when the upstream parser adopts a fixed version and reverify the toolchain.

On 2026-11-05, clean `npm ci --ignore-scripts` installs in the checkout and
exported source both reported zero known vulnerabilities through `npm audit`.
This is a dated registry result, not a guarantee against undiscovered issues.
These development tools are not copied into the desktop application.
