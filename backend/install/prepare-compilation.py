"""Prepare finite native checks; does not connect, compile or activate a ship."""

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--ship", required=True)
    parser.add_argument("--desk", required=True)
    parser.add_argument("--revision", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() or args.output.is_symlink():
        raise ValueError("Choose a new output directory")
    here = Path(__file__).resolve().parent
    # Reuse the full tree, hash and argument validation, before creating output.
    with tempfile.TemporaryDirectory(prefix="readymade-proof-") as temporary:
        proof = Path(temporary) / "source.hoon"
        subprocess.run([sys.executable, str(here / "prepare-verification.py"),
                        "--source", str(args.source), "--ship", args.ship,
                        "--desk", args.desk, "--revision", str(args.revision),
                        "--output", str(proof)], check=True, capture_output=True)
        source_check = proof.read_text()
    manifest_bytes = (here.parent / "assembly-manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    apps = re.findall(r"%([a-z-]+)", (args.source / "desk.bill").read_text())
    marks = {}
    for name in manifest["files"]:
        if name.startswith("mar/") and name.endswith(".hoon"):
            mark = name[4:-5].replace("/", "-")
            if not re.fullmatch(r"[a-z][a-z0-9-]*", mark):
                raise ValueError("Unsupported mark name")
            marks.setdefault(mark, []).append(name)
    revision = format(args.revision, ",").replace(",", ".")
    address = f"/{args.ship}/{args.desk}/{revision}"
    files = {"00-source.hoon": source_check}
    compile_app = (here / "compile-app.hoon").read_text()
    for index, app in enumerate(apps, 1):
        files[f"{index:02d}-app-{app}.hoon"] = (
            f"=/  arg=vase  !>([{args.ship} %{args.desk} {revision} %{app}])\n" + compile_app)
    prefix = "\n".join(source_check.splitlines()[:6]) + "\n"
    files["10-marks.hoon"] = prefix + "\n".join([
        "=/  rows",
        "  %+  turn  `(list @tas)`~[" + " ".join("%" + mark for mark in sorted(marks)) + "]",
        "  |=  name=@tas",
        f"  =/  built=*  .^(* %cb {address}/[name])",
        "  [name (shax (jam built))]",
        f"(pure:m !>([%readymade-mark-graphs-v1 our.b %{args.desk} {revision} (lent rows) rows]))", ""])
    diagnostic = "ted/ph/readymade-install-preflight.hoon"
    native_hash = bytes.fromhex(manifest["files"][diagnostic]["sha256"])[::-1].hex().lstrip("0") or "0"
    groups = [native_hash[max(0, end - 4):end] for end in range(len(native_hash), 0, -4)]
    digest = "0x" + ".".join(reversed(groups))
    files["11-runtime.hoon"] = prefix + "\n".join([
        f"?>  =({digest} (shax .^(@t %cx {address}/ted/ph/readymade-install-preflight/hoon)))",
        ";<  built=vase  bind:m",
        f"  (build-file-hard [[our.b %{args.desk} ud+{revision}] /ted/ph/readymade-install-preflight/hoon])",
        ";<  actual=vase  bind:m",
        f"  !<(form:m (slam built !>(!>([%{args.desk} {revision}]))))",
        "(pure:m actual)", ""])
    packet = {"schema": "readymade-native-compilation-packet-v1",
              "scope": "prepared checks, not execution or activation evidence",
              "ship": args.ship, "desk": args.desk, "revision": args.revision,
              "assemblyManifestSHA256": hashlib.sha256(manifest_bytes).hexdigest(),
              "apps": apps, "markNames": len(marks),
              "markAliases": {name: paths for name, paths in marks.items() if len(paths) > 1},
              "files": {name: hashlib.sha256(text.encode()).hexdigest() for name, text in files.items()}}
    args.output.mkdir()
    for name, text in files.items():
        with (args.output / name).open("x") as target:
            target.write(text)
    with (args.output / "packet.json").open("x") as target:
        json.dump(packet, target, indent=2)
        target.write("\n")
    print(f"Prepared {len(apps)} app checks, {len(marks)} mark names and runtime diagnostics")


if __name__ == "__main__":
    main()
