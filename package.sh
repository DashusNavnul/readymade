#!/usr/bin/env bash
# Bounded local packaging adapter; never installs or launches the resulting app.
set -euo pipefail
umask 077
workspace_dir="$(cd "$(dirname "$0")" && pwd)"
version='1.143.17232'
archive_name="VSCodium-darwin-arm64-$version.zip"
upstream_url="https://github.com/VSCodium/vscodium/releases/download/$version/$archive_name"
upstream_sha='ade8f5e0ebf47e5ea9e2478844f150c68e43def192b6f8be05d0329d25ec0917'
cache_dir="$HOME/.cache/readymade/codeoss-package"
dist_dir="$workspace_dir/dist"
app_name='Readymade Workspace.app'
publish_dir="${READYMADE_PACKAGE_OUTPUT_DIR:-$dist_dir}"
app_path="$publish_dir/$app_name"
receipt_path="$publish_dir/readymade-workspace-package-receipt.json"
stage=''; downloaded=''; local_signing_active=''; backend_stage=''
fail() { printf 'Packaging refused: %s\n' "$1" >&2; exit 1; }
source_fingerprint() {
  node - "$workspace_dir" <<'FINGERPRINT'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = process.argv[2], digest = crypto.createHash('sha256');
function add(file, relative) {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Source symlink refused');
  digest.update(relative + '\0'); digest.update(fs.readFileSync(file)); digest.update('\0');
}
function scan(directory, prefix) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name), relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) scan(file, relative); else add(file, relative);
  }
}
for (const file of ['package.json', 'package.sh', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) add(path.join(root, file), file); scan(path.join(root, 'src'), 'src'); scan(path.join(root, 'platform'), 'platform'); scan(path.join(root, 'packaging'), 'packaging'); scan(path.join(root, 'backend/install'), 'backend/install'); for (const file of ['backend/assembly-manifest.json', 'backend/prepare.py', 'backend/application/source.tar.gz']) add(path.join(root, file), file); scan(path.join(root, 'runtime'), 'runtime'); console.log(digest.digest('hex'));
FINGERPRINT
}
cleanup() {
  local result=$?
  if [[ -n "$local_signing_active" ]]; then
    node "$workspace_dir/packaging/macos-local-signing.cjs" deactivate || result=1
  fi
  if [[ "$result" != 0 && -n "$stage" && -f "$stage/signing.log" ]]; then tail -n 12 "$stage/signing.log" >&2; fi
  if [[ -n "$downloaded" && -f "$downloaded" && ! -L "$downloaded" ]]; then rm -- "$downloaded"; fi
  if [[ -n "$stage" && "$stage" == "$dist_dir"/.package.* && -d "$stage" && ! -L "$stage" ]]; then rm -r -- "$stage"; fi
  if [[ -n "$backend_stage" && "$backend_stage" == */readymade-backend.* && -d "$backend_stage" && ! -L "$backend_stage" ]]; then rm -r -- "$backend_stage"; fi
  return "$result"
}
trap cleanup EXIT
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || fail 'This package is for Apple Silicon macOS.'
for tool in node npm python3 git xcrun curl shasum ditto codesign openssl; do command -v "$tool" >/dev/null || fail "Missing tool: $tool"; done
# The prepared Urbit runtime is reused while runtime/ is unchanged. When this Mac has none for this source, zig
# 0.15.2 builds it: say so now, not after the tests.
runtime_key="$(cd "$workspace_dir/runtime" && cat source-manifest.json readymade-vere.patch bounded-evaluation-proof.hoon | shasum -a 256 | awk '{print $1}')"
runtime_cache="$HOME/.cache/readymade/runtime/$runtime_key"
if [[ ! -f "$runtime_cache/urbit" || ! -f "$runtime_cache/proved" ]]; then
  command -v zig >/dev/null || fail 'Missing tool: zig 0.15.2 (needed once to build the Urbit runtime).'
  [[ "$(zig version)" == 0.15.2 ]] || fail 'The Urbit runtime is qualified with zig 0.15.2; this Mac has another version.'
fi
[[ ! -e "$app_path" && ! -L "$app_path" && ! -e "$receipt_path" && ! -L "$receipt_path" ]] || fail 'The preview app or receipt already exists; it will not be replaced.'
for cache_parent in "$HOME/.cache" "$HOME/.cache/readymade" "$cache_dir"; do
  [[ ! -L "$cache_parent" ]] || fail 'A package-cache parent is a symlink.'
  if [[ ! -e "$cache_parent" ]]; then mkdir -- "$cache_parent"; fi
  [[ -d "$cache_parent" && -O "$cache_parent" ]] || fail 'A package-cache parent is not an owned directory.'
  cache_mode="$(stat -f '%Lp' "$cache_parent")"
  (( (8#$cache_mode & 022) == 0 )) || fail 'A package-cache parent permits writes by another user.'
done
mkdir -p "$dist_dir" "$publish_dir"
[[ -d "$publish_dir" && ! -L "$publish_dir" && -O "$publish_dir" ]] || fail 'The publication directory is unsafe.'
[[ -d "$cache_dir" && ! -L "$cache_dir" && -O "$cache_dir" && "$(stat -f '%Lp' "$cache_dir")" == 700 ]] || fail 'Package cache must be an owned, private directory.'
[[ -d "$dist_dir" && ! -L "$dist_dir" && -O "$dist_dir" ]] || fail 'The build output directory is unsafe.'
stage="$(mktemp -d "$dist_dir/.package.XXXXXX")"
signing_json="$(node "$workspace_dir/packaging/macos-signing.cjs")"
signing_identity="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).identity)' "$signing_json")"
signing_keychain="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).keychain || "")' "$signing_json")"
signing_args=(--sign "$signing_identity" --timestamp=none)
sign_target() {
  local identifier="$1" target="$2"; shift 2
  [[ "$identifier" =~ ^[A-Za-z0-9.-]+$ ]] || fail 'Unexpected signing identifier.'
  if [[ "$signing_identity" == - ]]; then
    codesign --force "${signing_args[@]}" --identifier "$identifier" "$@" "$target"
  else
    codesign --force "${signing_args[@]}" --identifier "$identifier" \
      --requirements "=designated => certificate leaf = H\"$signing_identity\" and identifier \"$identifier\"" "$@" "$target"
  fi
  node "$workspace_dir/packaging/macos-signing.cjs" verify "$target" "$signing_json" >/dev/null
}
xcrun clang -O2 -Wall -Wextra -Werror -x c - -o "$stage/exclusive-move" <<'PUBLISH'
#include <stdio.h>
#include <sys/stdio.h>
int main(int argc, char **argv) {
  if (argc != 3) return 1;
  if (renamex_np(argv[1], argv[2], RENAME_EXCL) != 0) { perror("Exclusive package publication"); return 1; }
  return 0;
}
PUBLISH
archive="$cache_dir/$archive_name"
if [[ ! -e "$archive" && ! -L "$archive" ]]; then
  downloaded="$(mktemp "$cache_dir/.download.XXXXXX")"
  curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 600 --output "$downloaded" "$upstream_url"
  read -r actual_sha _ < <(shasum -a 256 "$downloaded")
  [[ "$actual_sha" == "$upstream_sha" ]] || fail 'The upstream archive hash does not match the pinned release.'
  "$stage/exclusive-move" "$downloaded" "$archive"
  downloaded=''
fi
[[ -f "$archive" && ! -L "$archive" && -O "$archive" && "$(stat -f '%Lp' "$archive")" == 600 ]] || fail 'Cached archive must be an owned, private regular file.'
read -r actual_sha _ < <(shasum -a 256 "$archive")
[[ "$actual_sha" == "$upstream_sha" ]] || fail 'The cached archive does not match the pinned release; it was preserved for inspection.'
source_sha="$(source_fingerprint)"
(cd "$workspace_dir" && npm run check && npm run lint && npm test)
[[ "$source_sha" == "$(source_fingerprint)" ]] || fail 'Extension source changed during verification; no bundle was published.'
ditto -x -k "$archive" "$stage/unpacked"
source_app="$stage/unpacked/VSCodium.app"
[[ -d "$source_app" && ! -L "$source_app" ]] || fail 'The verified archive did not contain VSCodium.app.'
staged_app="$stage/$app_name"
mkdir -p "$staged_app/Contents/MacOS" "$staged_app/Contents/Resources"
inner_app="$staged_app/Contents/Resources/VSCodium.app"
mv -- "$source_app" "$inner_app"
plist="$staged_app/Contents/Info.plist"
original_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$inner_app/Contents/Info.plist")"
[[ "$original_name" =~ ^[A-Za-z0-9._\ -]+$ && "$original_name" != . && "$original_name" != .. ]] || fail 'Unexpected upstream executable name.'
original_binary="$inner_app/Contents/MacOS/$original_name"
[[ -f "$original_binary" && ! -L "$original_binary" && -x "$original_binary" ]] || fail 'The upstream executable is missing.'
extension="$inner_app/Contents/Resources/app/extensions/pataphor.readymade-ship-workspace"
[[ ! -e "$extension" && ! -L "$extension" ]] || fail 'The upstream app already contains this extension.'
mkdir -p "$extension/dist"
cp "$workspace_dir/package.json" "$extension/package.json"
cp "$workspace_dir/LICENSE" "$workspace_dir/THIRD_PARTY_NOTICES.md" "$extension/"
mkdir "$extension/platform"
cp "$workspace_dir/platform/urbit.svg" "$workspace_dir/platform/hoon-language.json" "$workspace_dir/platform/hoon.tmLanguage" "$extension/platform/"
ditto "$dist_dir/src" "$extension/dist/src"
# The doctor's event watcher reads the runtime's shared label page (read-only) to time each event.
mkdir "$extension/bin"
xcrun clang -O2 -Wall -Wextra -Werror -mmacosx-version-min=12.0 "$workspace_dir/packaging/event-watch.c" -o "$extension/bin/event-watch"
# The backend installer and its verified bundle travel inside the app, so installing Pataphor on a
# ship builds and downloads nothing on the user's machine. Same relative layout as the checkout:
# backend/install (tools), backend/assembly-manifest.json (pins), backend/package (prepared bundle).
mkdir -p "$extension/backend/install"
for tool_file in "$workspace_dir"/backend/install/*.cjs "$workspace_dir"/backend/install/*.py "$workspace_dir"/backend/install/*.hoon; do
  [[ -f "$tool_file" && ! -L "$tool_file" ]] || fail 'Unexpected backend installer file.'
  cp "$tool_file" "$extension/backend/install/"
done
cp "$workspace_dir/backend/assembly-manifest.json" "$extension/backend/assembly-manifest.json"
backend_stage="$(mktemp -d "${TMPDIR:-/tmp}/readymade-backend.XXXXXX")"
# prepare.py verifies every input pin and the assembled desk; it refuses output inside the checkout.
python3 "$workspace_dir/backend/prepare.py" --output "$backend_stage/prepared" > "$stage/backend-prepare.log" 2>&1 || { tail -n 12 "$stage/backend-prepare.log" >&2; fail 'Backend bundle preparation failed.'; }
[[ -f "$backend_stage/prepared/prepared.json" && -d "$backend_stage/prepared/package/desk" && -f "$backend_stage/prepared/package/assembly.json" ]] || fail 'Prepared backend bundle is incomplete.'
ditto "$backend_stage/prepared/package" "$extension/backend/package"
# The Urbit runtime the backend needs (bounded evaluation) and the pinned Kelvin-408 boot pill travel
# inside the app too, so starting a planet downloads and builds nothing on the user's machine.
# The runtime is built from the pinned public source plus runtime/readymade-vere.patch and must pass
# the bounded-evaluation proof; a finished build is reused while runtime/ is unchanged.
runtime_proof='[%native-coding-bounded-evaluation-proof-v1 %.y]'
# The proof prints its result inside terminal colour codes, so look for the line rather than compare it
# whole; require a clean exit; and on failure show what the runtime actually printed.
prove_runtime() {
  local binary="$1" label="$2" log="$stage/runtime-proof-$2.log"
  if "$binary" eval < "$workspace_dir/runtime/bounded-evaluation-proof.hoon" > "$log" 2>&1 && grep -qF -- "$runtime_proof" "$log"; then return 0; fi
  printf 'Runtime proof output (%s):\n' "$label" >&2; tail -n 8 "$log" | LC_ALL=C tr -cd '\11\12\40-\176' >&2
  return 1
}
if [[ ! -f "$runtime_cache/urbit" || ! -f "$runtime_cache/proved" ]]; then
  command -v zig >/dev/null || fail 'Missing tool: zig 0.15.2 (needed once to build the Urbit runtime).'
  [[ "$(zig version)" == 0.15.2 ]] || fail 'The Urbit runtime is qualified with zig 0.15.2.'
  python3 "$workspace_dir/runtime/prepare.py" --output "$backend_stage/runtime" > "$stage/runtime-prepare.log" 2>&1 || { tail -n 12 "$stage/runtime-prepare.log" >&2; fail 'Runtime source preparation failed.'; }
  (cd "$backend_stage/runtime/source" && zig build -j2 -Doptimize=ReleaseFast) > "$stage/runtime-build.log" 2>&1 || { tail -n 20 "$stage/runtime-build.log" >&2; fail 'Runtime build failed.'; }
  built="$backend_stage/runtime/source/zig-out/aarch64-macos-none/urbit"
  [[ -f "$built" && -x "$built" ]] || fail 'The built runtime is missing.'
  prove_runtime "$built" built || fail 'The built runtime failed the bounded-evaluation proof.'
  mkdir -p "$runtime_cache"; chmod 700 "$HOME/.cache/readymade/runtime" "$runtime_cache"
  cp "$built" "$runtime_cache/urbit.partial" && mv "$runtime_cache/urbit.partial" "$runtime_cache/urbit" && : > "$runtime_cache/proved"
fi
pill_sha='b4babd14e9f1acbdb421b3c31c215ee637ad6691b7e382b99c6fd8991e623708'
pill_url='https://media.githubusercontent.com/media/urbit/urbit/0a9a312e133891937de9c4df1ebecad5cf669c7c/bin/brass.pill'
pill_cache="$HOME/.cache/readymade/pills/$pill_sha.pill"
if [[ ! -f "$pill_cache" || "$(shasum -a 256 "$pill_cache" | awk '{print $1}')" != "$pill_sha" ]]; then
  mkdir -p "$(dirname "$pill_cache")"
  curl --fail --location --silent --show-error --max-time 600 --output "$pill_cache.partial" "$pill_url" || fail 'The boot pill could not be downloaded.'
  [[ "$(shasum -a 256 "$pill_cache.partial" | awk '{print $1}')" == "$pill_sha" ]] || { rm -f -- "$pill_cache.partial"; fail 'The downloaded boot pill does not match its pinned hash.'; }
  mv "$pill_cache.partial" "$pill_cache"
fi
mkdir "$extension/backend/runtime"
cp "$runtime_cache/urbit" "$extension/backend/runtime/urbit"; chmod 755 "$extension/backend/runtime/urbit"
cp "$pill_cache" "$extension/backend/runtime/brass.pill"; chmod 644 "$extension/backend/runtime/brass.pill"
kernel_app="$inner_app/Contents/Resources/app"
node "$workspace_dir/platform/browser-reveal.cjs" "$kernel_app"
node "$workspace_dir/platform/task-terminal.cjs" "$kernel_app"
node "$workspace_dir/platform/nested-cli.cjs" "$kernel_app/bin/codium"
mkdir "$kernel_app/out/readymade-media"
cp "$workspace_dir/platform/"*.cjs "$kernel_app/out/readymade-media/"
cp "$kernel_app/package.json" "$kernel_app/out/readymade-media/upstream-package.json"
node - "$kernel_app/package.json" "$kernel_app/product.json" <<'ENTRY'
const fs = require('node:fs'), file = process.argv[2], p = JSON.parse(fs.readFileSync(file, 'utf8'));
if (p.main !== './out/main.js') throw new Error('Unexpected upstream entry point');
p.main = './out/readymade-main.mjs'; p.name = p.productName = 'Readymade Workspace'; fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n');
const productFile = process.argv[3], product = JSON.parse(fs.readFileSync(productFile, 'utf8'));
product.trustedExtensionProtocolHandlers = [...new Set([...(product.trustedExtensionProtocolHandlers || []), 'pataphor.readymade-ship-workspace'])];
fs.writeFileSync(productFile, JSON.stringify(product, null, 2) + '\n');
ENTRY
cat > "$kernel_app/out/readymade-main.mjs" <<'BOOTSTRAP'
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
require('./readymade-media/media-main.cjs').install(electron);
// Electron defers ready for ESM top-level await: https://www.electronjs.org/docs/latest/tutorial/esm
try { await import('./main.js'); } catch { process.stderr.write('Readymade editor startup failed.\n'); electron.app.exit(1); }
BOOTSTRAP
[[ "$source_sha" == "$(source_fingerprint)" ]] || fail 'Extension source changed before the package snapshot.'
[[ -f "$extension/dist/src/extension.js" ]] || fail 'The built extension entry point is missing.'
codesign --display --entitlements :- "$inner_app" > "$stage/electron-entitlements.plist" 2> "$stage/signing.log"
/usr/libexec/PlistBuddy -c 'Print' "$stage/electron-entitlements.plist" >/dev/null
for field in CFBundleName CFBundleDisplayName; do
  /usr/libexec/PlistBuddy -c "Set :$field Readymade Workspace" "$inner_app/Contents/Info.plist"
done
set_media_descriptions() {
  local target="$1"
  for kind in Camera Microphone; do
    /usr/libexec/PlistBuddy -c "Delete :NS${kind}UsageDescription" "$target" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c "Add :NS${kind}UsageDescription string Readymade uses your $kind for calls you start or join." "$target"
  done
}
set_media_descriptions "$inner_app/Contents/Info.plist"
if [[ -n "$signing_keychain" ]]; then
  local_signing_active=1
  node "$workspace_dir/packaging/macos-local-signing.cjs" activate
  signing_args+=(--keychain "$signing_keychain")
fi
helper_index=0
for suffix in '' ' (GPU)' ' (Plugin)' ' (Renderer)'; do
  helper_index=$((helper_index + 1)); old_helper="VSCodium Helper$suffix"; new_helper="Readymade Workspace Helper$suffix"
  helper="$inner_app/Contents/Frameworks/$old_helper.app"; helper_plist="$helper/Contents/Info.plist"
  [[ -d "$helper" && ! -L "$helper" && -x "$helper/Contents/MacOS/$old_helper" ]] || fail 'Unexpected upstream helper layout.'
  codesign --display --entitlements :- "$helper" > "$stage/helper-$helper_index-entitlements.plist" 2>> "$stage/signing.log"
  /usr/libexec/PlistBuddy -c 'Print' "$stage/helper-$helper_index-entitlements.plist" >/dev/null
  for field in CFBundleName CFBundleExecutable CFBundleDisplayName; do
    /usr/libexec/PlistBuddy -c "Set :$field $new_helper" "$helper_plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$field string $new_helper" "$helper_plist"
  done
  set_media_descriptions "$helper_plist"
  mv -- "$helper/Contents/MacOS/$old_helper" "$helper/Contents/MacOS/$new_helper"
  mv -- "$helper" "$inner_app/Contents/Frameworks/$new_helper.app"
  helper_identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$inner_app/Contents/Frameworks/$new_helper.app/Contents/Info.plist")"
  sign_target "$helper_identifier" "$inner_app/Contents/Frameworks/$new_helper.app" --entitlements "$stage/helper-$helper_index-entitlements.plist" 2>> "$stage/signing.log"
  codesign --verify --strict "$inner_app/Contents/Frameworks/$new_helper.app" 2>> "$stage/signing.log"
done
cat > "$stage/ReadymadeLauncher.c" <<'C'
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
static void refuse(void) { fputs("Readymade preview could not establish its private launch paths.\n", stderr); exit(1); }
static void directory(const char *path, int private) {
  struct stat info;
  if (mkdir(path, 0700) < 0 && errno != EEXIST) refuse();
  if (lstat(path, &info) < 0 || !S_ISDIR(info.st_mode) || info.st_uid != getuid() ||
      (info.st_mode & 0022) || (private && (info.st_mode & 0777) != 0700)) refuse();
}
static void append(char *out, size_t size, const char *base, const char *suffix) {
  int count = snprintf(out, size, "%s/%s", base, suffix);
  if (count < 0 || (size_t)count >= size) refuse();
}
#ifdef CLI_MODE
static const char *override(int argc, char **argv, const char *key, const char *fallback) {
  const char *result = fallback; size_t length = strlen(key);
  for (int i = 1; i < argc; i++) {
    if (!strncmp(argv[i], key, length) && argv[i][length] == '=') result = argv[i] + length + 1;
    else if (!strcmp(argv[i], key)) { if (++i >= argc) refuse(); result = argv[i]; }
    else continue;
    if (result[0] != '/' || strlen(result) >= PATH_MAX) refuse();
    char parent[PATH_MAX], actual[PATH_MAX]; strcpy(parent, result);
    char *slash = strrchr(parent, '/'); if (!slash || !slash[1] || !strcmp(slash + 1, ".") || !strcmp(slash + 1, "..")) refuse();
    *slash = '\0'; if (!realpath(parent, actual)) refuse(); directory(actual, 1); directory(result, 1);
  }
  return result;
}
#endif
int main(int argc, char **argv) {
  umask(0077);
  char own[PATH_MAX], resolved[PATH_MAX], candidate[PATH_MAX], binary[PATH_MAX];
  uint32_t length = sizeof(own);
  if (_NSGetExecutablePath(own, &length) != 0 || !realpath(own, resolved)) refuse();
  char *slash = strrchr(resolved, '/'); if (!slash) refuse(); *slash = '\0';
  append(candidate, sizeof(candidate), resolved, "../Resources/VSCodium.app/Contents/MacOS/" ORIGINAL_NAME);
  if (!realpath(candidate, binary)) refuse();
  struct stat executable;
  if (lstat(binary, &executable) < 0 || !S_ISREG(executable.st_mode) || executable.st_uid != getuid()) refuse();
  struct passwd *user = getpwuid(getuid()); if (!user || !user->pw_dir || user->pw_dir[0] != '/') refuse();
  char cache[PATH_MAX], readymade[PATH_MAX], profile[PATH_MAX], data[PATH_MAX], extensions[PATH_MAX], shared[PATH_MAX];
  append(cache, sizeof(cache), user->pw_dir, ".cache"); directory(cache, 0);
  append(readymade, sizeof(readymade), cache, "readymade"); directory(readymade, 0);
  append(profile, sizeof(profile), readymade, "workspace-v02"); directory(profile, 1);
  append(data, sizeof(data), profile, "user"); directory(data, 1);
  append(extensions, sizeof(extensions), profile, "extensions"); directory(extensions, 1);
  append(shared, sizeof(shared), profile, "shared-data"); directory(shared, 1);
  char settings_dir[PATH_MAX], settings[PATH_MAX];
  append(settings_dir, sizeof(settings_dir), data, "User"); directory(settings_dir, 1);
  append(settings, sizeof(settings), settings_dir, "settings.json");
  int fd = open(settings, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600);
  if (fd >= 0) {
    const char initial[] = "{\"update.mode\":\"none\",\"workbench.browser.dataStorage\":\"ephemeral\",\"window.openFoldersInNewWindow\":\"on\"}\n";
    if (write(fd, initial, sizeof(initial) - 1) != sizeof(initial) - 1 || fsync(fd) < 0 || close(fd) < 0) refuse();
  } else {
    struct stat existing;
    if (errno != EEXIST || lstat(settings, &existing) < 0 || !S_ISREG(existing.st_mode) ||
        existing.st_uid != getuid() || (existing.st_mode & 0777) != 0600) refuse();
  }
#ifdef CLI_MODE
  const char *selected_data = override(argc, argv, "--user-data-dir", data);
  const char *selected_extensions = override(argc, argv, "--extensions-dir", extensions);
  const char *selected_shared = override(argc, argv, "--shared-data-dir", shared);
  char cli[PATH_MAX]; append(candidate, sizeof(candidate), resolved, "../Resources/VSCodium.app/Contents/Resources/app/out/cli.js");
  if (!realpath(candidate, cli)) refuse();
  char **args = calloc((size_t)argc + 10, sizeof(char *)); if (!args) refuse();
  args[0] = binary; args[1] = cli; args[2] = "--user-data-dir"; args[3] = (char *)selected_data;
  args[4] = "--extensions-dir"; args[5] = (char *)selected_extensions;
  args[6] = "--shared-data-dir"; args[7] = (char *)selected_shared;
  args[8] = "--enable-proposed-api"; args[9] = "pataphor.readymade-ship-workspace";
  for (int i = 1, next = 10; i < argc; i++) {
    if (!strncmp(argv[i], "--user-data-dir=", 16) || !strncmp(argv[i], "--extensions-dir=", 17) || !strncmp(argv[i], "--shared-data-dir=", 18)) continue;
    if (!strcmp(argv[i], "--user-data-dir") || !strcmp(argv[i], "--extensions-dir") || !strcmp(argv[i], "--shared-data-dir")) { i++; continue; }
    args[next++] = argv[i];
  }
  unsetenv("VSCODE_PORTABLE"); unsetenv("VSCODE_EXTENSIONS"); unsetenv("VSCODE_DEV");
  unsetenv("NODE_OPTIONS"); unsetenv("NODE_REPL_EXTERNAL_MODULE"); setenv("ELECTRON_RUN_AS_NODE", "1", 1);
#else
  const char *reserved[] = { "--user-data-dir", "--extensions-dir", "--shared-data-dir", "--logsPath", "--crash-reporter-directory" };
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--")) refuse();
    for (size_t j = 0; j < sizeof(reserved) / sizeof(reserved[0]); j++) {
      size_t n = strlen(reserved[j]);
      if (!strncmp(argv[i], reserved[j], n) && (argv[i][n] == '\0' || argv[i][n] == '=')) refuse();
    }
  }
  unsetenv("VSCODE_PORTABLE"); unsetenv("VSCODE_EXTENSIONS"); unsetenv("VSCODE_DEV"); unsetenv("ELECTRON_RUN_AS_NODE");
  char **args = calloc((size_t)argc + 9, sizeof(char *)); if (!args) refuse();
  args[0] = binary; for (int i = 1; i < argc; i++) args[i] = argv[i];
  args[argc] = "--user-data-dir"; args[argc + 1] = data;
  args[argc + 2] = "--extensions-dir"; args[argc + 3] = extensions;
  args[argc + 4] = "--shared-data-dir"; args[argc + 5] = shared;
  args[argc + 6] = "--enable-proposed-api"; args[argc + 7] = "pataphor.readymade-ship-workspace";
#endif
  execv(binary, args); refuse(); return 1;
}
C
xcrun clang -O2 -Wall -Wextra -Werror -mmacosx-version-min=12.0 "-DORIGINAL_NAME=\"$original_name\"" "$stage/ReadymadeLauncher.c" -o "$staged_app/Contents/MacOS/ReadymadeLauncher"
xcrun clang -O2 -Wall -Wextra -Werror -mmacosx-version-min=12.0 -DCLI_MODE "-DORIGINAL_NAME=\"$original_name\"" "$stage/ReadymadeLauncher.c" -o "$staged_app/Contents/MacOS/ReadymadeCLI"
for launcher in ReadymadeLauncher ReadymadeCLI; do
  launcher_minimum="$(xcrun vtool -show-build "$staged_app/Contents/MacOS/$launcher" | awk '$1 == "minos" {print $2}')"
  [[ "$launcher_minimum" == 12.0 ]] || fail 'A launcher does not match the declared macOS 12 minimum.'
done
cat > "$plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Readymade Workspace</string>
<key>CFBundleDisplayName</key><string>Readymade Workspace</string>
<key>CFBundleIdentifier</key><string>org.pataphor.codeoss.workspace</string>
<key>CFBundleExecutable</key><string>ReadymadeLauncher</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>0.2.0</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>CFBundleIconFile</key><string>VSCodium.icns</string>
</dict></plist>
PLIST
set_media_descriptions "$plist"
cp "$inner_app/Contents/Resources/VSCodium.icns" "$staged_app/Contents/Resources/VSCodium.icns"
# CFBundleName, package productName and helper lookup names agree; framework/main executable stay upstream.
{
  # Sign the nested runtime first, prove the signed file still works, and record the hash that ships.
  sign_target org.pataphor.codeoss.workspace.urbit "$extension/backend/runtime/urbit"
  prove_runtime "$extension/backend/runtime/urbit" signed || fail 'The signed runtime failed the bounded-evaluation proof.'
  printf '{"runtimeSHA256":"%s","pillSHA256":"%s","runtimeSource":"%s","proof":"bounded-evaluation-proof.hoon passed after signing"}\n' \
    "$(shasum -a 256 "$extension/backend/runtime/urbit" | awk '{print $1}')" "$pill_sha" "$runtime_key" > "$extension/backend/runtime/runtime.json"
  sign_target org.pataphor.codeoss.workspace.eventwatch "$extension/bin/event-watch"
  sign_target com.vscodium "$inner_app" --entitlements "$stage/electron-entitlements.plist"
  codesign --verify --deep --strict "$inner_app"
  sign_target org.pataphor.codeoss.workspace.cli "$staged_app/Contents/MacOS/ReadymadeCLI"
  sign_target org.pataphor.codeoss.workspace "$staged_app"
  codesign --verify --deep --strict "$staged_app"
} 2>> "$stage/signing.log"
node "$workspace_dir/packaging/macos-signing.cjs" verify "$staged_app/Contents/MacOS/ReadymadeCLI" "$signing_json" >/dev/null
node "$workspace_dir/packaging/macos-signing.cjs" verify "$inner_app" "$signing_json" > "$stage/inner-requirement.json"
node "$workspace_dir/packaging/macos-signing.cjs" verify "$staged_app" "$signing_json" > "$stage/outer-requirement.json"
node - "$staged_app" "$upstream_url" "$upstream_sha" "$original_name" "$stage/receipt.json" "$source_sha" "$signing_json" "$stage" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [app, url, sha256, originalExecutable, receipt, sourceFingerprint, signingJSON, stage] = process.argv.slice(2);
const signer = JSON.parse(signingJSON);
const extension = path.join(app, 'Contents/Resources/VSCodium.app/Contents/Resources/app/extensions/pataphor.readymade-ship-workspace');
const hashes = {};
function scan(directory, prefix = '') {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name), file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Extension contains a symlink');
    if (entry.isDirectory()) scan(file, relative);
    else if (entry.isFile()) hashes[relative] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    else throw new Error('Unexpected extension file type');
  }
}
scan(extension);
const kernel = path.join(app, 'Contents/Resources/VSCodium.app/Contents/Resources/app');
const platform = {};
for (const name of ['media-main.cjs', 'media-session.cjs', 'media-policy.cjs']) platform[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(kernel, 'out/readymade-media', name))).digest('hex');
platform.bootstrap = crypto.createHash('sha256').update(fs.readFileSync(path.join(kernel, 'out/readymade-main.mjs'))).digest('hex');
platform.product = crypto.createHash('sha256').update(fs.readFileSync(path.join(kernel, 'product.json'))).digest('hex');
platform.entry = crypto.createHash('sha256').update(fs.readFileSync(path.join(kernel, 'package.json'))).digest('hex');
platform.upstreamCLI = crypto.createHash('sha256').update(fs.readFileSync(path.join(kernel, 'bin/codium'))).digest('hex');
fs.writeFileSync(receipt, JSON.stringify({ created: new Date().toISOString(), upstream: { version: '1.143.17232', codeOSS: '1.143.1', url, sha256 },
  bundleIdentifier: 'org.pataphor.codeoss.workspace', innerBundle: 'Contents/Resources/VSCodium.app', nativeCLI: 'Contents/MacOS/ReadymadeCLI', originalExecutable, minimumMacOS: '12.0', launcherDeploymentTargetsVerified: true, platform,
  extension: { id: 'pataphor.readymade-ship-workspace', sourceFingerprint, hashes },
  signing: { identity: signer.identity, kind: signer.kind, team: signer.team,
    verified: signer.identity === '-' ? 'codesign --verify --deep --strict passed; test-only ad-hoc identity' : 'codesign --verify --deep --strict and exact certificate requirement passed',
    innerRequirement: JSON.parse(fs.readFileSync(path.join(stage, 'inner-requirement.json'), 'utf8')),
    outerRequirement: JSON.parse(fs.readFileSync(path.join(stage, 'outer-requirement.json'), 'utf8')) },
  isolation: 'Native Finder/CLI launchers default to private ~/.cache/readymade/workspace-v02/{user,extensions,shared-data}; CLI overrides require owned private directories; fresh settings disable updates and use ephemeral browser storage; previous preview profiles and encrypted secret databases are never changed.',
  nativeIdentity: { name: 'Readymade Workspace', credentialNamespace: 'Readymade Workspace Safe Storage', helpers: 'Readymade Workspace Helper{, (GPU), (Plugin), (Renderer)}', preservedInnerBundleIdentifier: 'com.vscodium' },
  limitations: ['Native/Electron name and helper names are Readymade Workspace; Code OSS product UI, icon, bundle identifiers and upstream notices remain VSCodium.', 'Two browser-reveal JavaScript patches have matching integrity checksums; a bounded media bootstrap runs before the original main entry.',
    'Not notarized or approved for public distribution; upstream update/default internal product settings remain.',
    'Packaging does not establish Finder launch, extension-host acceptance, feature parity or live ship behavior.'] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
NODE
[[ ! -e "$app_path" && ! -L "$app_path" && ! -e "$receipt_path" && ! -L "$receipt_path" ]] || fail 'Preview output appeared during packaging.'
"$stage/exclusive-move" "$staged_app" "$app_path"
"$stage/exclusive-move" "$stage/receipt.json" "$receipt_path"
printf 'Preview app: %s\nReceipt: %s\nHost-test CLI: %s\n' "$app_path" "$receipt_path" "$app_path/Contents/MacOS/ReadymadeCLI"
