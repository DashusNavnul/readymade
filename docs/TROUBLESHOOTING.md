# Troubleshooting

Start with the exact failing action and error. Keep access codes, authentication cookies, private note contents and local credentials out of shared logs and screenshots.

## Paid for a planet but received no key

Do not purchase another planet to retry delivery. A Paddle/PayPal confirmation
proves payment, not an assigned identity or a running server. Check the purchase
email account, including spam, for a separate delivery message. A master ticket
or networking keyfile is different from the `+code` used to log into a running
ship; Readymade cannot derive either from an invoice.

Choose **Get an Urbit → Recover my purchase** to open
[Orraah support](https://www.orraah.com/support). Include the Paddle transaction
ID for each paid order and request its assigned planet name and private master
ticket/keyfile delivery. Never post tickets, keyfiles or login codes publicly.
Readymade does not send that request automatically, refund an order or access the
provider's private fulfillment queue. Its checkout button stays disabled until
actual payment-to-key delivery is verified. Keep original receipts; do not replay
a charge or a provider issuance request after an unknown outcome.

## Build or packaging fails

The package script supports Apple Silicon macOS. Node.js 22, npm, Python 3.9+, Xcode command-line tools, OpenSSL and zig 0.15.2 exactly are prerequisites (zig builds the Urbit runtime the first time `./package.sh` runs on a Mac). Run `node --version`, `npm --version`, `xcrun --find clang` and `zig version`; then run `npm ci --ignore-scripts`, `npm run check`, `npm run lint` and `npm test` from the repository root.

An upstream archive digest mismatch is a failed integrity check. Preserve the archive for inspection; do not edit the pinned digest to make it pass. Network access is needed for npm dependencies, the pinned VSCodium download and, the first time, the Urbit runtime source and boot pill.

“Preview app or receipt already exists” means packaging preserved an earlier build. Choose a new destination rather than deleting working output:

```sh
READYMADE_PACKAGE_OUTPUT_DIR="$PWD/dist/next-build" ./package.sh
```

Keep the destination on the same filesystem as the checkout's `dist` directory. The final publication uses an exclusive rename. Private cache/output checks also intentionally reject unsafe permissions or symlinks; inspect the reported path instead of broadly changing your home directory's permissions.

## The application will not open

Open the outer `Readymade Workspace.app`, not its nested VSCodium app. Keep the bundle intact. Local builds use a persistent local signing certificate and are not notarized; record the exact macOS message. Do not disable system security globally to bypass it.

For isolated development or host tests, `launch.sh` and `test-host.sh` accept `READYMADE_CODE_BIN`. Their default path targets an existing Visual Studio Code installation. The packaged `Contents/MacOS/ReadymadeCLI` is the supported host for the media bridge; launching the extension in an ordinary editor does not install that main-process bridge.

## The access code seems wrong

Choose **Home → Connect your Urbit** and check the address shown on **Your
Urbit**. Current source lists verified real galaxies, stars, planets, moons and
comets. **Refresh running ships** performs another bounded check. An empty list
means no local runtime passed those checks; old pier folders and saved addresses
are not evidence of running ships. Fake ships and duplicate identities are
excluded. Use **Enter a ship’s web address** for a hosted ship or a local runtime
that discovery cannot verify. No Settings edit is required. Bare remote
hostnames use HTTPS and loopback addresses use HTTP.
Ordinary app/login links are accepted, but query strings, fragments and URL
credentials are refused. Enter the access code only in the private password
field. Never paste it into chat or use it as a command-line argument.

The current preview lists every real ship running on the Mac. Automated tests do not prove live compatibility with every
class.

## My ship runs on this Mac but is not in the list

Readymade lists a running ship when its runtime file is named `urbit`, `vere`,
or `vere` followed by `-` or `.` and a version (the names the runtime ships
under), the ship is real (not a
fake), and it answers its own identity check within a few seconds. A runtime
copied under another name is not recognised (measured: a comet started from a
renamed copy was invisible until restarted as `urbit`). A busy ship shows as
"did not answer in time"; refresh the list. You can always connect by web
address instead, which asks for the login code once.

## The ship is slow, will not connect, or a build fails

Run **Readymade: Ship Doctor** from the command palette while connected. It
reads, once, how fast the ship answers, the runtime and `--loom` it was started
with, the snapshot against its memory arena, free disk, the Mac's swap, how busy
the ship is at rest, which timers are due and who set them, which connections
to other ships are paused (and whether any of those ships is online), how long
the ship's events take (any over 200 ms is named with where its time went;
**Watch events for 2 minutes** catches work that recurs every two minutes), and
the ship's Kelvin against this app's backend. It changes nothing. Connection errors now
say what was measured: the ship answered too slowly, nothing is listening at
that address, the address was not found, the connection dropped, the login code
was refused, or a ship on this Mac came back on another port (Readymade offers
to reconnect there). The Doctor also prints a recovery recipe for a local ship
with its real paths: how to back it up, restore it, and which runtime file it
must be started with.

If the selected ship changed or the login identifies another ship, refresh the
local list and check the intended runtime and address. The login is refused and
the new code is not saved. Do not bypass the identity comparison or repeatedly
replace a valid code to fix a mismatched endpoint.

The desktop may use an existing private saved-code store or editor secret
storage. If a saved code is rejected, enter the replacement privately; the new
code takes precedence and is saved only after the ship accepts it. Canceling or
entering an incorrect replacement leaves the previous store unchanged. Do not
dump or delete credential databases as a first step.

**Connect to Ship** opens the same connection page. Missing app pages and
optional coding services are listed separately from sign-in. A plain Urbit
without Pataphor can still use its installed app pages. **Open coding
workspace** requires the additional backend; changing a valid access code will
not install it. See [compatibility](COMPATIBILITY.md).

`secureTransportRequired` while downloading connector source means that the
CLI app requires HTTPS or an explicitly enabled owner-only loopback test mode.
It does not mean the login code is wrong. Use the receiving ship's supported
HTTPS origin; do not disable the transport check or change credentials to fix it.

## Joining is unavailable although login works

In current source, **Your Urbit** checks **Project invitations** separately from
the local coding backend. **Join a workspace** is enabled there only after the
read-only invitation catalog matches the authenticated ship and supported
protocol. A guest does not need a local Viki session or model/provider connection
to accept the owner's invitation.

HTTP 404 means the invitation service is missing. A refused, malformed,
foreign-owner or unavailable response leaves it unverified. Keep the working
login and app tabs; inspect the specific service failure. Changing the login
code does not install that service. Any first installation on your ship is a
separate owner-authorized task using the [native installation guide](../backend/install/README.md).
Source checks and earlier test receivers do not establish your ship's readiness.

Use the host's actual project invitation for your exact ship. A Tlon group
invitation does not grant project membership, and project membership does not
grant file access or execution. If a join was submitted but its outcome is
unknown, use **Check Result** on that retained attempt; do not submit the link
again to force an answer. See [Join a workspace](JOIN_A_WORKSPACE.md).

## HTTPS certificate errors

“The HTTPS certificate does not match this ship address” means the server's
certificate does not cover the configured origin. Check the address in
Readymade settings; if it is correct, the host must correct the certificate.

“The HTTPS certificate cannot be verified” means the presented certificate
chain is not trusted by the client. The host should provide a trusted
certificate and its complete chain. Changing the ship access code will not
repair either condition. Do not disable TLS verification to make login pass.

These login failures occur before the HTTP password is delivered. They do not
settle an earlier unknown submission; retain its journal and observe its exact
outcome before any further write. Other connection failures retain their
existing diagnostics.

## An app page is missing, or media will not start

Landscape, Glurff and Calls target `/apps/landscape/`, `/apps/glurff/` and `/apps/noltbook/`. Tlon Groups targets `/apps/groups/`. The relevant application must already be installed on that ship. This desktop repository does not install it automatically.

Use the app's own controls to join or start a call. Opening a page does not start capture. Check the selected origin and macOS camera/microphone permissions. A working local fixture does not establish real capture, screen/audio sharing or a two-peer call. Record those as separate tests.

In builds with system-permission diagnostics, **Check Media Tab** reports camera,
microphone and screen access separately from the website's own permission.
`not-determined` means the system has not recorded a decision for this app;
`denied` or `restricted` is not a successful capture test. `unavailable` means
that the status could not be read. A website can report denied while awaiting
its site permission prompt, so do not infer macOS state from that message alone.
Use the browser tab's site controls and the normal system permission flow.

When macOS reports screen recording access as denied, the native screen-sharing
confirmation offers **Open Screen Recording Settings**. That action opens the
system permission panel and cancels the current capture request; it does not
grant permission or select a screen. Complete any required authentication
locally in macOS, then explicitly start sharing again. The normal picker option
remains available because system status and a per-selection picker grant are
distinct. A successful Settings launch is not proof of screen capture.

For automated testing in an isolated profile, set `window.dialogStyle` to
`custom` if the test can inspect editor dialogs but cannot inspect native OS
dialogs. The packaged editor defaults to native dialogs; a pending microphone
request with no dialog in the editor DOM does not prove the permission request
was lost. The custom setting changes dialog presentation, not permission policy.
Reveal the intended native tab and approve only its visible, exact-origin
Microphone or Camera prompt. Do not disable permission checks or grant capture
through a debugging API. The two-peer fresh-install call test passed using this
normal dialog flow and ended every capture track afterward.
Checking status itself never grants access or starts recording.

Native bridge status also retains up to 16 permission events per bound media
page. `checked` records an existing-permission check; `requested` records a
request reaching the session handler; `delegated` records forwarding to the
editor; `answered` records its decision. A check returning false without a
request event is not evidence that a user rejected a prompt. These diagnostics
preserve permission decisions and exclude credentials and request details.

If a fresh packaged test stalls before opening its browser tab, inspect normal
macOS dialogs too. A Keychain prompt for “Readymade Workspace Safe Storage” can
block the main process and cause a browser-connection timeout. The owner must
handle that prompt locally; never put the login password in logs or chat.
Dismissing that prompt does not establish microphone or camera acceptance.

Repeated approval after each local rebuild usually means the builds were signed
ad hoc: macOS sees a new app identity each time. `./package.sh` now reuses a
private local signing certificate stored under
`~/Library/Application Support/Readymade/Signing`. Keep that directory when
clearing caches or moving the build setup. The private signing key stays on the
builder's Mac; it is never included in the application or source export.

When moving from an older ad-hoc build to this certificate, macOS may ask once
more for “Readymade Workspace Safe Storage”. Enter the Mac login password in
that macOS dialog and choose **Always Allow** for the verified new Readymade
build. Later builds from the same signer retain that identity. Existing older
builds can still have their own pending requests. Do not delete Safe Storage
items or turn off encrypted storage to dismiss them.

This local signature does not provide Apple notarization or remove Gatekeeper
checks for downloaded apps. An Apple-issued certificate can be selected with
`READYMADE_SIGNING_IDENTITY=<exact certificate SHA-1 fingerprint> ./package.sh`.
`READYMADE_ALLOW_ADHOC=1` is an explicit isolated-test option; using that build
with real saved credentials can bring the repeated prompts back.

Switching between Code and an open app should preserve its page. **Reconnect Media Tab** reloads a tab and can end an active call; it is an explicit action, not the first automatic response to uncertainty. Existing calls in another native application are not automatically transferred into this workspace.

## Shared requests or ship files are unavailable

Shared requests require the compatible Readymade collaboration backend. Coding sessions, canonical file reads, drafts and terminals require their respective backend surfaces. Their complete installation on an arbitrary receiving ship is not bundled or proven by this repository.

Selecting a project does not automatically fetch its complete file tree. **Read Ship File** explicitly requests a bounded native read; only complete retained reads become immutable source documents. Saving a local draft does not write canonical ship state. Preparing a candidate does not apply or deploy it.

If submission has an unknown outcome, use **Check submission outcome**. Do not submit again, clear the request journal or recreate the request to evade the replay block. Source refresh failures should leave retained request observation and recovery available. A recorded instruction confirms neither finished code nor deployment.

## The terminal cannot find `landscape`

Open a new integrated terminal in Readymade after activation. The command is installed in that editor's terminal environment, not in your global shell. Confirm you launched the outer packaged application; if the command still fails, retain the exact error and test **Landscape** from the persistent controls separately.

When asking for help, include the platform, Node version, action, sanitized error, build method and which verification layer passed. Do not include access codes or authentication headers. See [security](SECURITY.md).

## Groups stays on “Starting up…”

Tlon may need several minutes to synchronize its initial data and initialize
its local database in a fresh tab. Keep that tab open. An authenticated HTML
response alone does not mean synchronization finished. If it remains stuck,
check the app's own diagnostics; closing and recreating the tab starts fresh work.

Open a new Readymade terminal and type `groups`, or use the Groups sidebar
control. This opens the same retained app. Use `/usr/bin/groups` if you intended
the operating system's group-membership command instead.

## A call stays at requesting microphone

Separate native presentation from permission handling. The packaged media bridge's
read-only `status` response includes `presentation` for each retained binding:
its matched native view, visibility, bounds and owning window's focus/minimized
state. Unknown or retired native objects return `null` fields. These diagnostics
do not grant permissions, reveal unrelated window titles or include credentials.

A ready binding means the expected page loaded; it does not prove the native
pane is visible or microphone permission completed. A visible pane can still
have a pending permission request. Retain the page's call stages and the normal
permission-dialog state before retrying. Do not substitute a readiness check
for actual received audio/video, or bypass system permissions to obtain a pass.
