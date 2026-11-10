# C++ language acceptance

Readymade supports the official `llvm-vs-code-extensions.vscode-clangd`
extension as an optional language provider. Install it from Open VSX through
Extensions, then set `clangd.path` to your installed clangd executable. Projects
should provide `compile_commands.json` with their actual compiler arguments.
See [clangd's setup instructions](https://clangd.llvm.org/installation).
This provider is not bundled with Readymade. Language services and debugging
are qualified separately below; other compiler/platform combinations remain
unverified.

## Repeatable installed-editor test

Use a new private project and isolated extension directory. Install the provider
into that directory with the packaged editor CLI before running the test. The
qualified input is Open VSX `llvm-vs-code-extensions.vscode-clangd` version 0.6.0,
VSIX SHA-256 `32030694fa6c0ef438f4e4219f84677cd32f603c7faa4c71a283efc1f5b51751`.
Verify the downloaded VSIX against the registry's version-specific SHA-256 file.
Keep its license in the installed extension; do not repackage it as Readymade code.

```sh
proof_root="$(mktemp -d /tmp/readymade-cpp.XXXXXX)"
mkdir -m 700 "$proof_root/project" "$proof_root/extensions" "$proof_root/user"
printf 'isolated clangd acceptance\n' > "$proof_root/project/.readymade-clangd-acceptance"
# Set these to your installed package, downloaded verified VSIX and compiler.
export READYMADE_CODE_BIN='/path/to/Readymade Workspace.app/Contents/Resources/VSCodium.app/Contents/Resources/app/bin/codium'
export READYMADE_BUILTIN_EXTENSION='/path/to/Readymade Workspace.app/Contents/Resources/VSCodium.app/Contents/Resources/app/extensions/pataphor.readymade-ship-workspace'
"$READYMADE_CODE_BIN" --user-data-dir "$proof_root/user" \
  --extensions-dir "$proof_root/extensions" --install-extension /path/to/clangd.vsix
READYMADE_TEST_EXTENSIONS_DIR="$proof_root/extensions" \
READYMADE_CLANGD_ROOT="$proof_root/project" \
READYMADE_CLANGD_BIN=/usr/bin/clangd READYMADE_CLANG_BIN=/usr/bin/clang \
READYMADE_TEST_MODULE=clangd-host ./test-host.sh "$proof_root/project"
```

The test refuses an unmarked or nonprivate project and refuses to overwrite its
source files. It opens a real C++ source/header pair in the installed workbench,
resolves a cross-file definition, renames both declaration and use, introduces
an invalid argument, waits for the corresponding language diagnostic, repairs
it, and requires the diagnostic to clear. Finally the actual compiler builds
the renamed project and its executable must exit zero. The result records the
editor, provider and language-server versions. No ship or model task is used.
Use a fresh project directory for each run; retain failures separately.


## Native C++ debugging

Install optional `vadimcn.vscode-lldb` (CodeLLDB) from Open VSX, compile your
program with debug information (`-g -O0`), then add a launch configuration:

```json
{
  "version": "0.2.0",
  "configurations": [{
    "name": "Debug C++",
    "type": "lldb",
    "request": "launch",
    "program": "${workspaceFolder}/your-built-program",
    "cwd": "${workspaceFolder}",
    "terminal": "console"
  }]
}
```

The installed macOS arm64 workbench passed with CodeLLDB 1.12.3. Its universal
Open VSX VSIX has SHA-256
`460ac959094344ebb29b3d01bad94f6093b374d6fff44896ca456ac5b2047cd1`;
the extension fetched its matching `codelldb-darwin-arm64.vsix` from the
author's GitHub release on first use. Preserve the extension and platform
package notices. See the [CodeLLDB manual](https://github.com/vadimcn/codelldb/blob/master/MANUAL.md).

To repeat the test, create new private project/user/extension directories as
above, install the verified CodeLLDB VSIX with the same CLI, and use:

```sh
printf 'isolated lldb acceptance\n' > "$proof_root/project/.readymade-lldb-acceptance"
READYMADE_TEST_EXTENSIONS_DIR="$proof_root/extensions" \
READYMADE_LLDB_ROOT="$proof_root/project" READYMADE_CLANG_BIN=/usr/bin/clang \
READYMADE_TEST_MODULE=lldb-host ./test-host.sh "$proof_root/project"
```

The test builds a real executable, stops at a source breakpoint, checks the
stack's file and line, inspects watch expressions and local variables, steps
over an assignment, and requires normal program termination with exit code
zero. Debug-adapter events are retained beside the result. It launches only
its own disposable executable. Attach, remote debugging and other platforms
are not qualified by this launch test.
