# LLM-assisted setup

Use this guide to build the public desktop alpha and connect it to the receiving operator's own ship. Do not assume any development ship, host, account, path or port belongs to that operator.

## Establish the minimum facts

Inspect the local environment first. Ask only for facts that remain missing:

1. Is this an Apple Silicon Mac with Node.js 22 and Xcode command-line tools?
2. What is the operator's exact ship origin, and which apps are already installed?
3. Do they want existing Urbit app tabs, or do they also have the compatible Pataphor/shared coding backend?

The origin is not the access code. Never request an access code in chat or read credential stores to display their contents. Authentication belongs in the application's private password field. Do not collect peer identities or device permissions unless needed for a specific test the operator wants to perform.

Read [compatibility](COMPATIBILITY.md) and [security](SECURITY.md) before selecting commands. Existing app access does not authorize ship installation, source updates, restarts or deployment.

## Build locally

```sh
git clone https://github.com/DashusNavnul/readymade.git
cd readymade
node --version
npm --version
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

Before the first connection, set **Readymade: Origin** (`readymade.origin`) in editor Settings. Supply only the exact ship origin: HTTPS for remote ships, or HTTP for localhost. No app path, query string, URL credentials or redirect address. Then click **Landscape**, **Glurff** or **Calls**, and let the operator enter their access code privately when prompted. App buttons use the configured origin; they do not prompt for a new origin. An existing connection or remembered origin takes precedence, so use a separate fresh window/profile when connecting another ship.

This connection requires no SSH, boot, restart, Clay mount or ship modification. If a separately authorized task actually boots any Urbit instance, mount `%base` through native Clay `%mont` once `conn.sock` is ready, then verify nonempty exported `sys/hoon.hoon`, `sys/zuse.hoon`, `sys/lull.hoon` and `sys/vane/clay.hoon` before claiming readiness. That startup rule is not a reason to boot a ship for this desktop setup.

If an app is missing, report which page is unavailable. Do not guess an app publisher, install a desk or modify the ship. The main coding connection requires the backend endpoints described in [compatibility](COMPATIBILITY.md); this repository does not contain a complete self-service backend installation.

## Verify in layers

1. **Desktop:** the outer app starts, a local folder opens, editing and an integrated terminal work. In a newly opened terminal, `landscape` opens or reveals the Landscape tab.
2. **Authentication and pages:** the operator signs in privately; each installed app opens on the exact intended origin. A failed coding endpoint is reported separately from login failure.
3. **App continuity:** switch to Code and back; the same page remains. Move an app tab between supported editor groups and confirm its page remains usable. Do not equate tab movement with proven continuity of an active call.
4. **Optional coding backend:** observe project/session and retained request data. Read-only inspection must not submit work. Review the exact request and scope before an explicitly chosen submission; distinguish unknown, submitted, recorded and refused outcomes. Never automatically retry an unknown submission.
5. **Optional real media:** only with the operator's explicit participation, test actual camera/microphone permissions and capture, then a real call with a consenting peer. Verify media reaches both ends and stops when requested. A canvas stream or fixture page is not a real device or peer test.

For a local extension-host fixture against the packaged app:

```sh
READYMADE_CODE_BIN="$PWD/dist/Readymade Workspace.app/Contents/MacOS/ReadymadeCLI" ./test-host.sh
```

This launches an isolated test profile. It verifies the development extension against the packaged host, not an independent production install of the bundled extension. Do not present fixture results as live ship acceptance. See [troubleshooting](TROUBLESHOOTING.md) for backend and launch failures.

Conclude with what was actually verified, the exact app/build used and remaining gaps. Do not claim full multiplayer parity, ship deployment or completed coding work from a successful build, an HTTP response or an instruction receipt.
