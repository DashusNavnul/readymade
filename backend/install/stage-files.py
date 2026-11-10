"""Copy a pinned candidate into an owner-selected fresh inactive Clay mount.

Filesystem preparation only. The caller must establish native ownership and
inactive state first, exclude concurrent writers, and commit separately.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tempfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inventory(root):
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Expected an existing unlinked directory")
    files, directories = {}, set()
    for path in root.rglob("*"):
        info = path.lstat()
        name = path.relative_to(root).as_posix()
        if stat.S_ISDIR(info.st_mode):
            directories.add(name)
        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            files[name] = path.read_bytes()
        else:
            raise ValueError("Linked or nonregular entry refused: " + name)
    return files, directories


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def stage(manifest, source, mount, receipt):
    if manifest.get("schema") != "readymade-backend-assembly-v1":
        raise ValueError("Unknown manifest")
    pins = manifest["files"]
    if not pins:
        raise ValueError("Empty candidate")
    directories = set()
    for name in pins:
        path = PurePosixPath(name)
        if (not name or str(path) != name or path.is_absolute()
                or ".." in path.parts or "\\" in name):
            raise ValueError("Invalid manifest path")
        directories.update(str(p) for p in path.parents if str(p) != ".")
    # Inventory before resolving so a linked root is never silently accepted.
    incoming, incoming_dirs = inventory(source)
    previous, previous_dirs = inventory(mount)
    source, mount = source.resolve(), mount.resolve()
    receipt = receipt.absolute()
    resolved_receipt = receipt.resolve()
    for left, right in [(source, mount), (source, resolved_receipt), (mount, resolved_receipt)]:
        if left == right or left in right.parents or right in left.parents:
            raise ValueError("Source, mount and receipt must be disjoint")
    if receipt.exists() or receipt.is_symlink():
        raise ValueError("Receipt already exists; inspect the retained attempt")
    if incoming.keys() != pins.keys() or incoming_dirs != directories:
        raise ValueError("Source path set differs from manifest")
    for name, data in incoming.items():
        if len(data) != pins[name]["bytes"] or digest(data) != pins[name]["sha256"]:
            raise ValueError("Source hash mismatch: " + name)
    if not previous.keys() <= pins.keys() or not previous_dirs <= directories:
        raise ValueError("Unexpected mount paths; no files changed")
    if any(name in previous for name in directories):
        raise ValueError("Mount file obstructs candidate directory")
    if any(name in previous_dirs for name in pins):
        raise ValueError("Mount directory obstructs candidate file")
    receipt.mkdir(mode=0o700)
    plan = {"schema": "readymade-mount-stage-v1", "source": str(source),
            "mount": str(mount), "scope": "filesystem only; native commit not submitted",
            "expected": {n: digest(d) for n, d in incoming.items()},
            "previous": {n: digest(d) for n, d in previous.items()}}
    # Preserve every replaced original before the first destination write.
    for name, data in previous.items():
        if data != incoming[name]:
            save(receipt / "originals" / name, data)
    save(receipt / "plan.json", (json.dumps(plan, indent=2) + "\n").encode())
    if inventory(mount) != (previous, previous_dirs):
        raise ValueError("Mount changed after preflight; inspect retained attempt")
    for name, data in sorted(incoming.items()):
        if previous.get(name) == data:
            continue
        target = mount / name
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".readymade-stage-", dir=target.parent)
        # An interrupted attempt retains its temporary file and receipt.
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    actual, actual_dirs = inventory(mount)
    if actual != incoming or actual_dirs != directories:
        raise ValueError("Mount readback differs; do not commit")
    save(receipt / "complete.json", (json.dumps({"verifiedFiles": len(actual),
         "nativeCommitSubmitted": False, "mount": str(mount)}) + "\n").encode())
    return len(actual)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["source", "mount", "receipt"]:
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads((Path(__file__).resolve().parent.parent / "assembly-manifest.json").read_text())
    count = stage(manifest, args.source, args.mount, args.receipt)
    print(f"Verified {count} filesystem source files; no native commit submitted")


if __name__ == "__main__":
    main()
