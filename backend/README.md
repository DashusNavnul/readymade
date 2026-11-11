# Backend source components

These recipes reconstruct the complete backend candidate from the included
application source and public, pinned upstream inputs. They do not install a ship.

| Component | Reconstructed output |
| --- | --- |
| [Application source](application/README.md) | Pinned application files and Readymade MIT notice |
| [Urbit sources](upstream/README.md) | 543 inherited or derived files and original MIT notices |
| [CodeMirror](codemirror/README.md) | Tested editor bundle and all 18 dependency notices |
| [xterm](xterm/README.md) | Exact terminal JavaScript/CSS with original MIT notice |
| [Sigils](sigil/README.md) | Exact sigil renderer and its three dependency notices |
| [Noltbook](noltbook/README.md) | 39 pinned upstream files; full notice coverage remains unqualified |

Run each recipe into a new directory outside your checkout. Keep generated
notices with the corresponding assets. Never activate a partial collection as
a replacement for a live desk.

The [native receiver check](install/README.md) reports identity, runtime and
installation conflicts without writing to a ship. The current candidate contains
ten apps, including editing activity, shared-file access, suggestion recovery,
the owner inbox and explicit full-report completion replies (943 application
files; 1,490 assembled desk files). The matching result and sharing code passes
native compilation, its original proofs and a read-only rehearsal against the
existing app's complete captured DATA. Previous summary-only attempts retain
their original check-only endpoints. Source extraction and offline installer
checks pass; live installation, historical endpoint reads, real result delivery
and fresh installation of this exact version remain open.
Historical installation evidence covers the earlier nine-app bundle: 49 total
live apps and all 18 declared preservation checks passed on an owned receiver.
That evidence does not qualify this updated candidate or an existing ship upgrade.

## Prepare the complete candidate with one command

From the public checkout, with Python 3.9+, Node 22+, npm and network access:

```sh
python3 backend/prepare.py --output /your/new/private-build-directory
```

The command downloads the pinned Urbit archive, extracts the included
application source, rebuilds CodeMirror and Sigils using locked dependencies,
reconstructs xterm, and verifies the complete assembled desk and notices.
Dependency installs use `npm ci --ignore-scripts` in new isolated build folders;
the source checkout's dependencies and any ship remain unchanged. To reuse an
exact downloaded Urbit archive, add `--urbit-archive /path/to/urbit-source.tar.gz`.
Its digest is still checked before the build directory is created.

The verified result is `package/desk` with its adjacent `package/notices` and
`package/assembly.json`. `prepared.json` is written last, after all eight steps
pass. Each step has a bounded runtime and a retained log in `logs/`; the command
stops at the first failure without retrying or reusing partial output. Keep a
failed directory for diagnosis and choose a new destination for a new run.
Existing output and output inside the checkout are refused.

This prepares source only. Noltbook is separate, and no runtime is installed,
ship connected, source staged, app activated or provider configured. Continue
with the [native receiver and installation procedure](install/README.md) only
for an owner-authorized receiving ship. Component recipes below remain useful
for inspecting or rebuilding an individual input.

## Assemble the candidate

`assemble.py` combines the pinned application source with the output of the
Urbit, CodeMirror, Sigil and xterm recipes. Python 3.9+ is sufficient. All input
files and notices must match `assembly-manifest.json` before output is created.

```sh
python3 backend/assemble.py \
  --application /your/path/application-source \
  --upstream /your/path/urbit-source \
  --codemirror /your/path/codemirror-output \
  --sigil /your/path/sigil-output \
  --xterm /your/path/xterm-output \
  --output /your/path/new-backend-package
```

The result contains `desk/` with the exact manifest files, `notices/` and a final
`assembly.json` receipt. Extra input files are never copied. Existing output is
refused; an interrupted output without its final receipt is incomplete. Keep
the notices alongside the desk when distributing it. This command sends no
ship commands and does not establish installation readiness. Noltbook is a
separate component and is not part of this ten-app desk.

The earlier nine-app bundle passed native installation, captured-state preservation
and HTTP delivery on an owned receiver using the public tools. Provider,
desktop, collaboration and media checks have their own scoped evidence; full
self-service release acceptance and packaging remain unfinished. See
[compatibility](../docs/COMPATIBILITY.md) for
the required APIs and remaining gates, and [parity](../docs/PARITY.md) for the
acceptance roadmap.
