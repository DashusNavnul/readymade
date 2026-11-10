"""Reconstruct pinned runtime source in a new directory; never build or boot it."""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path


def sha(data):
    return hashlib.sha256(data).hexdigest()


def prepare(output):
    package = Path(__file__).resolve().parent
    output = output.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("Output already exists; choose a new directory")
    if package.parent in output.resolve().parents:
        raise ValueError("Choose output outside the source checkout")
    manifest_bytes = (package / "source-manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest["upstream"] != "https://github.com/urbit/vere.git" or not re.fullmatch(r"[0-9a-f]{40}", manifest["baseCommit"]):
        raise ValueError("Invalid upstream pin")
    for name, field in [("readymade-vere.patch", "patchSHA256"), ("bounded-evaluation-proof.hoon", "proofSHA256")]:
        if sha((package / name).read_bytes()) != manifest[field]:
            raise ValueError("Package hash mismatch: " + name)
    for name in manifest["files"]:
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or ".git" in path.parts:
            raise ValueError("Invalid source path: " + name)
    git = shutil.which("git")
    if not git:
        raise ValueError("Git is required")
    output.mkdir(mode=0o700)
    source = output / "source"
    source.mkdir(mode=0o700)
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT="0")
    steps = []

    def run(name, args):
        print("Preparing runtime: " + name, flush=True)
        with (output / (name + ".log")).open("xb") as log:
            result = subprocess.run([git, "-c", "core.hooksPath=" + os.devnull, *args],
                                    cwd=source, env=env, stdout=log,
                                    stderr=subprocess.STDOUT, timeout=600, check=False)
        steps.append({"step": name, "exit": result.returncode})
        if result.returncode:
            raise RuntimeError("Stopped at " + name + "; inspect retained log in " + str(output))

    run("init", ["init", "--template="])
    run("fetch", ["fetch", "--depth=1", manifest["upstream"], manifest["baseCommit"]])
    run("checkout", ["checkout", "--detach", manifest["baseCommit"]])
    run("patch-check", ["apply", "--check", str(package / "readymade-vere.patch")])
    run("patch", ["apply", str(package / "readymade-vere.patch")])
    for name, expected in manifest["files"].items():
        path = source / name
        if not path.is_file() or sha(path.read_bytes()) != expected:
            raise ValueError("Reconstructed source mismatch: " + name)
    receipt = {"schema": "readymade-runtime-source-v1", "manifestSHA256": sha(manifest_bytes),
               "baseCommit": manifest["baseCommit"], "verifiedFiles": len(manifest["files"]),
               "steps": steps, "source": "source", "built": False, "shipModified": False}
    with (output / "prepared.json").open("x") as stream:
        json.dump(receipt, stream, indent=2)
        stream.write("\n")
    print("Verified runtime source: " + str(source))
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    prepare(parser.parse_args().output)
