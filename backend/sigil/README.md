# Reproducible sigil renderer

This component reconstructs the tested backend's `ui/sigil.js` exactly from
`@urbit/sigil-js` 2.2.0 and locked npm dependencies. It preserves the full notices
for all three packages included in the browser bundle: sigil-js, invariant and
lodash.memoize. The sigil-js notice comes from its release commit
[`e86b674a4a3539ddc634351f335ac31d63bf64bd`](https://github.com/urbit/sigil-js/blob/e86b674a4a3539ddc634351f335ac31d63bf64bd/LICENSE.txt);
the npm package omits that file.

With Node 22 and npm, from this directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node build.mjs /absolute/path/to/new-output-directory
```

Choose a new output directory outside your checkout. The build refuses an existing
directory, changed renderer bytes, changed notices or an unexpected bundle input.
It writes `sigil.js`, `NOTICES.txt` and a manifest. Keep the notices with any
redistribution of the renderer. No ship connection or deployment occurs.

The expected renderer SHA-256 is
`0d073d64abacde12720a76e425d5a3ec7d25a5dd7f9407d851c863157972053d`.
Both a repository build and a clean reconstruction produced that exact result;
changed-source, changed-notice and existing-output controls were refused.

This is one backend source component, not the complete backend installer.
See [compatibility](../../docs/COMPATIBILITY.md) for remaining installation gates.
