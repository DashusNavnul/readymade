# Reproducible upstream backend sources

This component reconstructs 543 inherited or derived backend files from public
Urbit commit `0f94550b941dfe046d9dff4a541330bd084e8cd1`: 532 exact files, two help
files with exactly one final newline removed, and nine files with pinned line
edits. Both upstream MIT notices are retained.
The manifest pins every archive path, transformation and output hash.

The nine edited files are `lib/{dbug,shoe,strandio}.hoon`, `sur/sole.hoon`, and
`mar/{css,html,js,txt,docket-0}.hoon`. The manifest retains each original and
replacement line span. Reconstruction requires the exact upstream file hash,
each original span, and the final candidate hash; it never applies fuzzy patches.

From this directory, with Python 3.9+ and curl:

```sh
curl --fail --location --output urbit-source.tar.gz \
  https://codeload.github.com/urbit/urbit/tar.gz/0f94550b941dfe046d9dff4a541330bd084e8cd1
python3 reconstruct.py urbit-source.tar.gz reconstructed
```

The archive SHA-256 is
`1dae5d1a60be31ff41e7764e89f3bada74ee47349a97246291561e83440c85e9`.
The script verifies it, all source and output hashes, and both complete license
notices before creating output. Existing output is refused. Download and output
locations are operator choices; keep generated files outside your source commits.

This is a source component, **not an installer or a complete backend desk**.
It contains no credentials, ship state, operator configuration, or deployment
commands. It does not contact or modify a ship. Do not commit this partial tree
to a live desk: it lacks the application-specific sources and installation bill.
The rest of the backend must pass its own source, notice, runtime and receiver
acceptance checks before independent installation can be claimed. See
[compatibility](../../docs/COMPATIBILITY.md).
