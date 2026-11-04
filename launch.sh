#!/usr/bin/env bash
set -euo pipefail
workspace_dir="$(cd "$(dirname "$0")" && pwd)"
code_bin="${READYMADE_CODE_BIN:-/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code}"
profile_dir="${READYMADE_PROFILE_DIR:-$HOME/.cache/readymade/codeoss-prototype}"
mkdir -p "$profile_dir/user" "$profile_dir/extensions"
chmod 700 "$profile_dir" "$profile_dir/user" "$profile_dir/extensions"
if [[ ! -f "$workspace_dir/dist/src/extension.js" ]]; then
  (cd "$workspace_dir" && npm run build)
fi
# Separate host profile: no changes to the operator's existing editor/app.
exec "$code_bin" --new-window --user-data-dir "$profile_dir/user" \
  --extensions-dir "$profile_dir/extensions" --extensionDevelopmentPath="$workspace_dir" \
  --enable-proposed-api pataphor.readymade-ship-workspace --skip-welcome --skip-release-notes "$@"
