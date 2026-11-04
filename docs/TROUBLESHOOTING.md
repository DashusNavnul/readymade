# Troubleshooting

Start with the exact failing action and error. Keep access codes, authentication cookies, private note contents and local credentials out of shared logs and screenshots.

## Build or packaging fails

The package script supports Apple Silicon macOS. Node.js 22, npm and Xcode command-line tools are prerequisites. Run `node --version`, `npm --version` and `xcrun --find clang`; then run `npm ci --ignore-scripts`, `npm run check`, `npm run lint` and `npm test` from the repository root.

An upstream archive digest mismatch is a failed integrity check. Preserve the archive for inspection; do not edit the pinned digest to make it pass. Network access is needed for npm dependencies and the pinned VSCodium download.

“Preview app or receipt already exists” means packaging preserved an earlier build. Choose a new destination rather than deleting working output:

```sh
READYMADE_PACKAGE_OUTPUT_DIR="$PWD/dist/next-build" ./package.sh
```

Keep the destination on the same filesystem as the checkout's `dist` directory. The final publication uses an exclusive rename. Private cache/output checks also intentionally reject unsafe permissions or symlinks; inspect the reported path instead of broadly changing your home directory's permissions.

## The application will not open

Open the outer `Readymade Workspace.app`, not its nested VSCodium app. Keep the bundle intact. The build is ad-hoc signed and not notarized; record the exact macOS message. Do not disable system security globally to bypass it.

For isolated development or host tests, `launch.sh` and `test-host.sh` accept `READYMADE_CODE_BIN`. Their default path targets an existing Visual Studio Code installation. The packaged `Contents/MacOS/ReadymadeCLI` is the supported host for the media bridge; launching the extension in an ordinary editor does not install that main-process bridge.

## The access code seems wrong

First verify the exact origin. Before the first connection, set **Readymade: Origin** (`readymade.origin`) in Settings. App buttons use that value without an origin prompt; an existing connection or remembered origin takes precedence. Use your own HTTPS ship origin or localhost HTTP, without `/apps/...`, query parameters or credentials embedded in the URL. Authenticate only through the private password prompt. Never paste the code into chat or use it as a command-line argument.

The desktop may use an existing private saved-code store or editor secret storage. A stale saved credential can require a different diagnosis from a missing app. Do not dump or delete credential databases as a first step; report whether the failure was authentication, an unavailable page or a coding endpoint.

Clicking **Landscape**, **Glurff** or **Calls** authenticates for app access. The coding **Connect to Ship** action also requests Pataphor workspace and native coding state. A plain Urbit ship without those endpoints can fail that step even with valid credentials. See [compatibility](COMPATIBILITY.md).

## An app page is missing, or media will not start

Landscape, Glurff and Calls target `/apps/landscape/`, `/apps/glurff/` and `/apps/noltbook/`. The relevant application must already be installed on that ship. This desktop repository does not install it automatically.

Use the app's own controls to join or start a call. Opening a page does not start capture. Check the selected origin and macOS camera/microphone permissions. A working local fixture does not establish real capture, screen/audio sharing or a two-peer call. Record those as separate tests.

Switching between Code and an open app should preserve its page. **Reconnect Media Tab** reloads a tab and can end an active call; it is an explicit action, not the first automatic response to uncertainty. Existing calls in another native application are not automatically transferred into this workspace.

## Shared requests or ship files are unavailable

Shared requests require the compatible Readymade collaboration backend. Coding sessions, canonical file reads, drafts and terminals require their respective backend surfaces. Their complete installation on an arbitrary receiving ship is not bundled or proven by this repository.

Selecting a project does not automatically fetch its complete file tree. **Read Ship File** explicitly requests a bounded native read; only complete retained reads become immutable source documents. Saving a local draft does not write canonical ship state. Preparing a candidate does not apply or deploy it.

If submission has an unknown outcome, use **Check submission outcome**. Do not submit again, clear the request journal or recreate the request to evade the replay block. Source refresh failures should leave retained request observation and recovery available. A recorded instruction confirms neither finished code nor deployment.

## The terminal cannot find `landscape`

Open a new integrated terminal in Readymade after activation. The command is installed in that editor's terminal environment, not in your global shell. Confirm you launched the outer packaged application; if the command still fails, retain the exact error and test **Landscape** from the persistent controls separately.

When asking for help, include the platform, Node version, action, sanitized error, build method and which verification layer passed. Do not include access codes or authentication headers. See [security](SECURITY.md).
