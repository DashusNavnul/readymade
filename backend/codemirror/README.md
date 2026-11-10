# Reproducible backend editor

This builds the tested CodeMirror editor bundle with the complete license
notices for all 18 included runtime packages. Package versions and archive
integrities are locked. No private source repository is required.

From this directory, with Node 22 and npm:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node build.mjs /absolute/path/to/new-output-directory
```

Choose a new output directory outside your checkout. The build refuses existing
output and a result that differs from the qualified editor. It writes
`codemirror.js`, `NOTICES.txt` and a manifest with dependency identities,
integrities, notice hashes and every bundled input hash. Preserve the notices
when redistributing the generated editor.

The expected SHA-256 is
`d60c26457036a84644961ee290e07d4f6aab3734d50451ec50246c2f89d89b2a`.
Those bytes passed the packaged Chromium editor checks, including editing,
undo, selection, read-only state, language changes and destruction/remount.
They were also fetched and tested through the owned ship's native HTTP route.

The Hoon language/DOM adapter is a separate backend asset. This component does
not install or modify a ship and is not the complete backend installer.
See [compatibility](../../docs/COMPATIBILITY.md).
