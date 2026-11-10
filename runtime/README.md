# Readymade evaluator runtime source

This source package combines soft evaluation timeouts with the allocation and
equality-table guards used by the Readymade test ship. It is **not a ship-backend
installer or permission to restart an existing ship**. Existing-pier runtime
migration remains unqualified. Fresh owned ships booted
with the public rebuilt runtime have passed native backend installation and
bounded coding execution; that evidence does not qualify upgrading a live pier.
Full desktop/multiplayer parity remains open.

The patch starts at the public Urbit commit
[`8ddc4b786979574dbfcb655e3db1b634f658d0de`](https://github.com/urbit/vere/commit/8ddc4b786979574dbfcb655e3db1b634f658d0de).
It includes the intervening connection, memory and equality changes needed to
reconstruct the qualified source; no private repository or development path is
required. Preserve [Urbit's MIT license](LICENSE.vere.txt).

## Reproduce the source

For automatic source preparation, use Python 3.9+ and Git from the public
Readymade checkout:

```sh
python3 runtime/prepare.py --output /your/new/runtime-build
export READYMADE_RUNTIME_SOURCE="$PWD/runtime"
cd /your/new/runtime-build/source
```

This verifies the included patch and proof before fetching the exact public
revision, applies the patch, and verifies all 1,098 pinned source files. Each
Git step is bounded to ten minutes and retains a log. Existing destinations and
destinations inside the checkout are refused. A failed directory is retained
for diagnosis; there is no retry or partial-output reuse. `prepared.json` is
written only after verification. Continue with **Build and verify** below;
source preparation does not build, install, boot or modify any ship.

For manual reconstruction, follow the equivalent recipe below.

Use a new empty directory, Git, Python 3 and Zig **0.15.2**. Source reconstruction,
native regression tests, executable build and standalone evaluation have passed
on macOS arm64 and Linux x86_64. Live installation evidence remains separately
scoped to the owned Mac-hosted test ships. From the Readymade repository root:

```sh
export READYMADE_RUNTIME_SOURCE="$PWD/runtime"
mkdir vere-readymade
cd vere-readymade
git init
git fetch --depth=1 https://github.com/urbit/vere.git 8ddc4b786979574dbfcb655e3db1b634f658d0de
git checkout --detach FETCH_HEAD
git apply --check "$READYMADE_RUNTIME_SOURCE/readymade-vere.patch"
git apply "$READYMADE_RUNTIME_SOURCE/readymade-vere.patch"
python3 - <<'VERIFY'
import hashlib, json, os
from pathlib import Path
package = Path(os.environ["READYMADE_RUNTIME_SOURCE"])
manifest = json.loads((package / "source-manifest.json").read_text())
assert hashlib.sha256((package / "readymade-vere.patch").read_bytes()).hexdigest() == manifest["patchSHA256"]
assert hashlib.sha256((package / "bounded-evaluation-proof.hoon").read_bytes()).hexdigest() == manifest["proofSHA256"]
for name, expected in manifest["files"].items():
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == expected, name
print("All runtime source files match the qualified source.")
VERIFY
```

## Build and verify

```sh
zig version
zig fmt --check build.zig
git diff --check
zig build -j2 -Doptimize=ReleaseFast nock-test equality-test oom-test retrieve-test palloc-test hashtable-test
zig build -j2 -Doptimize=ReleaseFast
zig-out/aarch64-macos-none/urbit eval < "$READYMADE_RUNTIME_SOURCE/bounded-evaluation-proof.hoon"
```

On Linux x86_64, the tested build produces `zig-out/x86_64-linux-musl/urbit`;
use that path for the final evaluation command. A clean remote Linux build
with Zig 0.15.2 passed the six targets and the same proof. This does not qualify
booting or upgrading a Linux-hosted pier.

The last command must exit zero and return
`[%native-coding-bounded-evaluation-proof-v1 %.y]`. It tests successful evaluation,
refusal, bounded timeout recovery and caller continuation. The C tests cover
nested/outer timers, repeated recovery, equality and allocation failures. The
out-of-memory tests deliberately print bail messages; use their final result
and the build command's exit status. No standalone C linter is configured.

Do not use `-Drelease`: its version stamp differs from the tested development
build. A build's commit/version string and executable digest may differ between
checkouts even when all source hashes match. Record the resulting executable's
SHA256 and actual tests; do not substitute the maintainer's binary digest.

## Activation remains separate

Before any authorized runtime replacement, verify the receiving identity,
active jobs, supported checkpoint format and complete app inventory/state.
Preserve the stopped pier, use a controlled single boot, mount `%base` through
native Clay and verify its required source exports. Recheck saved state and the
live bounded-evaluation capability afterward. Never boot a second copy of the
same identity or replay a job whose outcome is unknown. Standalone tests do not
prove live preservation, source landing, a compatible backend or public release
readiness. See [compatibility](../docs/COMPATIBILITY.md) and
[parity acceptance](../docs/PARITY.md).
