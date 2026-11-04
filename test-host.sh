#!/usr/bin/env bash
set -euo pipefail
workspace_dir="$(cd "$(dirname "$0")" && pwd)"
code_bin="${READYMADE_CODE_BIN:-/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code}"
test_dir="$(mktemp -d /tmp/readymade-host.XXXXXX)"
chmod 700 "$test_dir"
if [[ "${1:-}" == '--host-only' ]]; then shift; else
  (cd "$workspace_dir" && npm run check && npm run lint && npm test)
fi
test_module="${READYMADE_TEST_MODULE:-extension-host}"
case "$test_module" in extension-host|media-host) ;; *) printf 'Unknown host test module\n' >&2; exit 1 ;; esac
printf 'Isolated extension-host evidence: %s\n' "$test_dir"
export READYMADE_HOST_EVIDENCE="$test_dir/result.json"
export READYMADE_MEDIA_EVIDENCE="$test_dir/result.json"
development_args=("--extensionDevelopmentPath=$workspace_dir")
if [[ -n "${READYMADE_BUILTIN_EXTENSION:-}" ]]; then
  # A different, inert driver enables the host test runner without shadowing
  # the bundled Readymade extension. The test asserts its exact installed path.
  mkdir "$test_dir/driver"
  printf '%s\n' '{"name":"host-driver","publisher":"readymade-test","version":"0.0.1","engines":{"vscode":"^1.143.0"},"main":"index.js","activationEvents":[]}' > "$test_dir/driver/package.json"
  printf '%s\n' 'exports.activate = function () {};' > "$test_dir/driver/index.js"
  development_args=("--extensionDevelopmentPath=$test_dir/driver")
fi
"$code_bin" --wait --new-window --user-data-dir "$test_dir/user" --extensions-dir "$test_dir/extensions" \
  "${development_args[@]}" --enable-proposed-api pataphor.readymade-ship-workspace --extensionTestsPath="$workspace_dir/dist/tests/$test_module.js" \
  --skip-welcome --skip-release-notes --disable-workspace-trust --disable-telemetry --use-inmemory-secretstorage "$@"
node -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); console.log(JSON.stringify(r,null,2)); if(r.passed!==true)process.exit(1)' "$READYMADE_HOST_EVIDENCE"
