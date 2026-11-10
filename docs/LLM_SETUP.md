# LLM-assisted setup

Use this guide to install the public desktop alpha and connect it to the receiving operator's own ship. Do not assume any development ship, host, account, path or port belongs to that operator.

## Establish the minimum facts

Inspect the local environment first. Ask only for facts that remain missing:

1. Is this an Apple Silicon Mac? The prebuilt download needs no development tools.
   Building from source separately requires Node.js 22, Python 3.9+ and Xcode command-line tools.
2. Let the operator choose their real running planet from Readymade's list, or
   enter a hosted ship's address through **Enter a ship’s web address**.
3. Use **Your Urbit** to discover installed app pages and coding compatibility;
   do not make the operator inventory apps or backend endpoints first.

The origin is not the access code. Never request an access code in chat or read credential stores to display their contents. Authentication belongs in the application's private password field. Do not collect peer identities or device permissions unless needed for a specific test the operator wants to perform.

Read [compatibility](COMPATIBILITY.md) and [security](SECURITY.md) before selecting commands. Existing app access does not authorize ship installation, source updates, restarts or deployment.

## Install the download

Prefer the [Apple Silicon meeting preview](https://github.com/DashusNavnul/readymade/releases/tag/v0.2.0-alpha.20261110)
for a tester who wants to run the app. Open the `.dmg`, drag Readymade Workspace
to Applications, open it there and eject the disk image. The download is ad-hoc
signed and not notarized; a trusted official download may need macOS
**System Settings → Privacy & Security → Open Anyway** on first launch.
[Apple's instructions](https://support.apple.com/en-us/102445) explain the prompt.
Do not disable Gatekeeper globally or remove quarantine recursively.

Continue with **Home → Connect your Urbit** and the private authentication flow
below. Backend installation and collaboration grants are separate requirements.
Use the source-build steps only when the operator wants to build the application.

## Build locally (optional)

```sh
git clone https://github.com/DashusNavnul/readymade.git
cd readymade
node --version
npm --version
python3 --version
xcrun --find clang
npm ci --ignore-scripts
npm run check
npm run lint
npm test
./package.sh
```

Use an existing checkout if one is already present; do not overwrite local work. Missing prerequisites should be identified before building. Do not use an unreviewed curl-to-shell installer.

`npm test` compiles TypeScript and runs local tests. It uses local fixtures, not the operator's ship or real peers. `package.sh` repeats verification, downloads the pinned upstream archive, checks its digest and produces the app and a package receipt. It does not prove startup or ship compatibility.

Packaging refuses existing app/receipt output. Preserve earlier builds and use a fresh output directory for another build, preferably under `dist` on the same filesystem:

```sh
READYMADE_PACKAGE_OUTPUT_DIR="$PWD/dist/second-build" ./package.sh
```

The launcher is locally ad-hoc signed, not notarized. Do not disable Gatekeeper globally or remove quarantine recursively as a setup shortcut. Report the exact macOS error if launch is blocked.

## Open and authenticate

```sh
open "dist/Readymade Workspace.app"
```

For an alternate output directory, adjust that path. Launch the outer app; its native launcher selects the private Readymade profile and enables the required browser API. Do not substitute the nested VSCodium launcher.

Choose **Home → Connect your Urbit**. The local list contains only live,
verified real planets; select the intended identity. The selected process,
socket and listener are checked again, and sign-in must identify that same
planet before a replacement code can be saved. Discovery never reads keyfiles,
boots a ship or changes an app. If the ship is hosted elsewhere or cannot be
verified locally, choose **Enter a ship’s web address**.

Let the operator enter their access code in the application's private password field. No Settings
edit is needed. Bare hostnames use HTTPS; loopback addresses such as
`localhost:8080` use HTTP. Ordinary ship app/login URLs are reduced to their
origin; credentials, query strings, fragments and reverse-proxy prefixes are
refused. Do not put a code in the address field or chat.

**Your Urbit** shows the authenticated identity and checks installed app pages
separately from coding compatibility. App buttons become available as the page
checks finish. An absent coding backend does not invalidate the login or prompt
for another code. Successful credentials and the address are remembered; a
rejected saved code can be replaced privately. Existing connections and explicit
configured addresses remain supported. Use **Connect another Urbit in a new
window** for another identity; existing app tabs retain their original ship.

This connection requires no SSH, boot, restart, Clay mount or ship modification. If a separately authorized task actually boots any Urbit instance, mount `%base` through native Clay `%mont` once `conn.sock` is ready, then verify nonempty exported `sys/hoon.hoon`, `sys/zuse.hoon`, `sys/lull.hoon` and `sys/vane/clay.hoon` before claiming readiness. That startup rule is not a reason to boot a ship for this desktop setup.

If an app is missing, report which page is unavailable. Do not guess an app publisher, install a desk or modify the ship. The main coding connection requires the backend endpoints described in [compatibility](COMPATIBILITY.md); the included native installation tools require separate owner authorization and verification; full self-service release acceptance remains open.

For a separately owner-authorized backend installation, follow the
[native installation guide](../backend/install/README.md) using the receiving
ship's discovered native connection. Its runner, staging tools and checks are
included in the public source export. For Noltbook, follow the separate
[reconstruction, compilation, activation and post-install recipe](../backend/noltbook/README.md),
including both `--readymade-media` and `--document-receipts` for reconstruction,
source staging and compilation preparation. This selects the 40-file component
with durable document save receipts while retaining the original upstream pins.
The activation preparer consumes that compilation packet and outputs a preflight,
single-submit activation, structural post-check and complete private snapshot.
Verify preservation and actual HTTP behavior before messaging or media tests.
No prepared packet, successful login or submitted activation substitutes for
those results. Hosted ships with only web access need their owner's supported
native installation path; do not invent SSH access or reuse development paths.

For an already installed Lattice, click **Lattice** or type `lattice` in a new Readymade terminal. It opens `/apps/lattice/app`; the reader and editor may navigate within the exact `/apps/lattice` route and `/apps/lattice/` descendants on that origin. If the operator separately authorizes installation, use Lattice's [official instructions](https://lattice.nisfeb.com/#install) for `~ricsul-bilwyt` `%grubbery`, then observe installation completion and the actual app. A download in progress is not readiness. The local-ship editor and retained terminal-command path have passed a live check; independently verify the receiving ship. If the app registry is empty, the permission page refresh populates it. Grubbery’s Stock view can sync Lattice alone. Confirm a real version and its exact app permission request before approving local editor capabilities. Lattice's PolyForm Noncommercial license is separate from Readymade's MIT license; no Lattice source is vendored here.

## Join the intended collaboration

If the compatible backend is already installed, follow [native project and
session setup](NATIVE_ONBOARDING.md) to register existing private source and open
a scoped coding session through the shipped native forms. This does not replace
backend installation, source import or provider pairing.

Follow [Join a workspace](JOIN_A_WORKSPACE.md) after local app access works. Use
the host's actual group invitation and project details. Never use another
participant's ship login. Group communication and shared coding execution have
separate acceptance checks; the included native installation tools do not make end-to-end multiplayer
onboarding automatic. Complete backend verification, project setup and provider
pairing before claiming coding readiness.

## Verify in layers

1. **Desktop:** the outer app starts, a local folder opens, editing and an integrated terminal work. In a newly opened terminal, `landscape` opens or reveals the Landscape tab; `groups` does the same for Tlon Groups and `lattice` for Lattice. These checks require each app to be installed; they do not install it.
2. **Authentication and pages:** the operator signs in privately; each installed app opens on the exact intended origin. A failed coding endpoint is reported separately from login failure.
3. **App continuity:** switch to Code and back; the same page remains. Move an app tab between supported editor groups and confirm its page remains usable. Do not equate tab movement with proven continuity of an active call.
4. **Optional coding backend:** observe project/session and retained request data. Read-only inspection must not submit work. Review the exact request and scope before an explicitly chosen submission; distinguish unknown, submitted, recorded and refused outcomes. Never automatically retry an unknown submission.
5. **Optional real media:** only with the operator's explicit participation, test actual camera/microphone permissions and capture, then a real call with a consenting peer. Verify media reaches both ends and stops when requested. A canvas stream or fixture page is not a real device or peer test.

For a local extension-host fixture against the packaged app:

```sh
READYMADE_CODE_BIN="$PWD/dist/Readymade Workspace.app/Contents/MacOS/ReadymadeCLI" ./test-host.sh
```

This launches an isolated test profile. It verifies the development extension against the packaged host, not an independent production install of the bundled extension. Do not present fixture results as live ship acceptance. See [troubleshooting](TROUBLESHOOTING.md) for backend and launch failures.

Test evidence defaults to a new private directory under
`~/.readymade-test-evidence`, outside temporary storage. The runner prints its
location and retains the profile, `host.log`, `result.json` when produced, and
`exit.json` on normal runner termination, including failures. Full verification
also writes `verification.log`. A missing exit record means the runner did not
record termination; it is not permission to restart an unknown operation.
An exit code alone is not acceptance: inspect the test result and its scope.

Use `READYMADE_TEST_EVIDENCE_ROOT=/absolute/persistent/path` to select another
location. Its parent must already exist and be owned and not writable by others;
the root must be private and not a symlink. Output is never automatically removed.
Keep these directories private and outside the repository: profiles and logs can
contain test data. Retaining these files does not replace source/package binding
or native preservation receipts for a real ship test.

To verify the extension actually bundled in your build, run these isolated
host tests after packaging. They do not connect to a ship or use a camera:

```sh
READYMADE_TEST_MODULE=hoon-host \
READYMADE_CODE_BIN="$PWD/dist/Readymade Workspace.app/Contents/MacOS/ReadymadeCLI" \
READYMADE_BUILTIN_EXTENSION="$PWD/dist/Readymade Workspace.app/Contents/Resources/VSCodium.app/Contents/Resources/app/extensions/pataphor.readymade-ship-workspace" \
./test-host.sh --host-only

READYMADE_TEST_MODULE=language-host \
READYMADE_TEST_NODE_BIN="$(command -v node)" \
READYMADE_CODE_BIN="$PWD/dist/Readymade Workspace.app/Contents/MacOS/ReadymadeCLI" \
READYMADE_BUILTIN_EXTENSION="$PWD/dist/Readymade Workspace.app/Contents/Resources/VSCodium.app/Contents/Resources/app/extensions/pataphor.readymade-ship-workspace" \
./test-host.sh --host-only
```

The first checks Hoon recognition, private draft saves, comment toggling and
bracket pairing. The second checks TypeScript language features and real Node
debugging. Both assert the exact bundled extension path and write a result in
the isolated evidence directory printed by the runner. These are desktop tests;
they do not prove independent ship installation or multiplayer acceptance.

Conclude with what was actually verified, the exact app/build used and remaining gaps. Do not claim full multiplayer parity, ship deployment or completed coding work from a successful build, an HTTP response or an instruction receipt.
