"""Finite public source preparation; never connects to or installs a ship."""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

LIMIT = 128 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def prepare(output, archive=None):
    here = Path(__file__).resolve().parent
    output = output.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("Output already exists; choose a new directory")
    if here.parent in output.resolve().parents:
        raise ValueError("Choose output outside the source checkout")
    if sys.version_info < (3, 9):
        raise ValueError("Python 3.9+ required")
    node, npm = shutil.which("node"), shutil.which("npm")
    if not node or not npm:
        raise ValueError("Node 22+ and npm required")
    version = subprocess.check_output([node, "--version"], text=True, timeout=10).strip()
    if int(version.lstrip("v").split(".")[0]) < 22:
        raise ValueError("Node 22+ required")
    pin = json.loads((here / "upstream/manifest.json").read_text())
    if archive:
        if archive.is_symlink() or not archive.is_file() or archive.stat().st_size > LIMIT:
            raise ValueError("Upstream archive must be a bounded regular file")
        data = archive.read_bytes()
    else:
        with urllib.request.urlopen(pin["archiveUrl"], timeout=30) as response:
            data = response.read(LIMIT + 1)
    if len(data) > LIMIT or digest(data) != pin["archiveSha256"]:
        raise ValueError("Upstream archive hash or size mismatch")
    output.mkdir(mode=0o700)
    archive_path = output / "urbit-source.tar.gz"
    archive_path.write_bytes(data)
    archive_path.chmod(0o600)
    logs = output / "logs"
    logs.mkdir(mode=0o700)
    steps = []

    def run(name, command, cwd=here):
        print("Preparing " + name, flush=True)
        log = logs / (name + ".log")
        with log.open("xb") as stream:
            log.chmod(0o600)
            try:
                result = subprocess.run([str(arg) for arg in command], cwd=cwd,
                                        stdout=stream, stderr=subprocess.STDOUT,
                                        timeout=600, check=False)
                code = result.returncode
            except subprocess.TimeoutExpired:
                code = "timeout"
        steps.append({"step": name, "exit": code, "log": log.name})
        (output / "progress.json").write_text(json.dumps(steps, indent=2) + "\n")
        if code != 0:
            raise RuntimeError("Preparation stopped at " + name + "; inspect " + str(log))

    run("application", [sys.executable, here / "application/extract.py", output / "application"])
    run("upstream", [sys.executable, here / "upstream/reconstruct.py", archive_path, output / "upstream"])
    for component in ["codemirror", "sigil"]:
        build = output / (component + "-build")
        build.mkdir(mode=0o700)
        names = ["package.json", "package-lock.json", "entry.js", "build.mjs"]
        if component == "sigil":
            names.append("NOTICES.txt")
        for name in names:
            shutil.copyfile(here / component / name, build / name)
        run(component + "-dependencies", [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], build)
        run(component, [node, build / "build.mjs", output / component], build)
    run("xterm", [sys.executable, here / "xterm/reconstruct.py", "--output", output / "xterm"])
    command = [sys.executable, here / "assemble.py"]
    for component in ["application", "upstream", "codemirror", "sigil", "xterm"]:
        command.extend(["--" + component, output / component])
    command.extend(["--output", output / "package"])
    run("assembly", command)
    assembled = (output / "package/assembly.json").read_bytes()
    receipt = {"schema": "readymade-source-preparation-v1", "node": version,
               "upstreamArchiveSHA256": pin["archiveSha256"],
               "assemblySHA256": digest(assembled), "steps": steps,
               "package": "package", "shipModified": False, "releaseApproved": False}
    with (output / "prepared.json").open("x") as stream:
        json.dump(receipt, stream, indent=2)
        stream.write("\n")
    print("Verified source package: " + str(output / "package"))
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--urbit-archive", type=Path, help="Use the exact pinned archive already downloaded")
    args = parser.parse_args()
    prepare(args.output, args.urbit_archive)
