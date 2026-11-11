#!/usr/bin/env bash
set -euo pipefail
umask 077
workspace_dir="$(cd "$(dirname "$0")" && pwd)"
code_bin="${READYMADE_CODE_BIN:-/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code}"
if [[ -n "${READYMADE_TEST_EVIDENCE_ROOT:-}" ]]; then
  test_dir="$(node "$workspace_dir/platform/host-evidence.cjs" create "$READYMADE_TEST_EVIDENCE_ROOT")"
else
  test_dir="$(node "$workspace_dir/platform/host-evidence.cjs" create)"
fi
finish() {
  local outcome=$?
  trap - EXIT
  node "$workspace_dir/platform/host-evidence.cjs" finish "$test_dir" "$outcome" || { if [[ "$outcome" == 0 ]]; then outcome=1; fi; }
  exit "$outcome"
}
trap finish EXIT
printf 'Isolated extension-host evidence: %s\n' "$test_dir"
if [[ "${1:-}" == '--host-only' ]]; then shift; else
  (cd "$workspace_dir" && npm run check && npm run lint && npm test) > "$test_dir/verification.log" 2>&1
fi
test_module="${READYMADE_TEST_MODULE:-extension-host}"
case "$test_module" in extension-host|welcome-host|planet-setup-host|urbit-hookup-host|existing-connection-host|tasks-host|clangd-host|lldb-host|python-types-host|python-attach-host|python-remote-host|python-tools-host|python-language-host|fresh-install-host|onboarding-host|source-import-host|media-host|completion-host|candidate-host|review-policy-host|project-sharing-host|navigation-host|pagination-host|large-navigation-host|large-edit-host|draft-reconcile-host|language-host|web-language-host|codemirror-host|hoon-host|editor-core-host|shared-claim-host|noltbook-documents-host|live-owner-host|live-peer-host|local-connect-host|live-newcomer-host) ;; *) printf 'Unknown host test module\n' >&2; exit 1 ;; esac
extensions_dir="${READYMADE_TEST_EXTENSIONS_DIR:-$test_dir/extensions}"
if [[ -n "${READYMADE_TEST_EXTENSIONS_DIR:-}" ]]; then
  [[ -d "$extensions_dir" && ! -L "$extensions_dir" && -O "$extensions_dir" && "$(stat -f '%Lp' "$extensions_dir")" == 700 ]] || { printf 'Test extensions must be an owned private directory\n' >&2; exit 1; }
fi
export READYMADE_HOST_EVIDENCE="$test_dir/result.json"
# Window tests start from nothing connected, whatever ships run on this Mac; a test of connecting on open sets 0.
export READYMADE_NO_AUTO_CONNECT="${READYMADE_NO_AUTO_CONNECT-1}"
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
# The CLI's verbose mode waits for the application process (including macOS
# open --wait-apps). --wait instead depends on a file-close marker which an
# extension test can leave behind after its window and process have exited.
# Process exit alone is insufficient: require the test's result.json below.
# A test that spans two launches (connect once, then reopen) names one owned private profile for both.
user_dir="${READYMADE_TEST_USER_DIR:-$test_dir/user}"
if [[ -n "${READYMADE_TEST_USER_DIR:-}" ]]; then
  [[ -d "$user_dir" && ! -L "$user_dir" && -O "$user_dir" && "$(stat -f '%Lp' "$user_dir")" == 700 ]] || { printf 'Test profile must be an owned private directory\n' >&2; exit 1; }
fi
"$code_bin" --verbose --new-window --user-data-dir "$user_dir" --extensions-dir "$extensions_dir" \
  "${development_args[@]}" --enable-proposed-api pataphor.readymade-ship-workspace --extensionTestsPath="$workspace_dir/dist/tests/$test_module.js" \
  --skip-welcome --skip-release-notes --disable-workspace-trust --disable-telemetry --use-inmemory-secretstorage "$@" > "$test_dir/host.log" 2>&1
node -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); console.log(JSON.stringify(r,null,2)); if(r.passed!==true)process.exit(1)' "$READYMADE_HOST_EVIDENCE"
