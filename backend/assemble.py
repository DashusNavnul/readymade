"""Assemble the pinned backend source and notices without contacting a ship."""

import argparse
import hashlib
import json
import os
import stat
from pathlib import Path, PurePosixPath


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_parts(name):
    path = PurePosixPath(name)
    if (not name or path.is_absolute() or str(path) != name
            or ".." in path.parts or "\\" in name):
        raise ValueError("Invalid manifest path")
    return path.parts


def read_pinned(root, pin):
    path = root
    for part in safe_parts(pin["source"]):
        path = path / part
        if path.is_symlink():
            raise ValueError("Linked source refused: " + pin["source"])
    with path.open("rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("Source is not a regular file")
        data = stream.read(pin["bytes"] + 1)
    if len(data) != pin["bytes"] or digest(data) != pin["sha256"]:
        raise ValueError("Source differs from pinned candidate: " + pin["source"])
    return data


def assemble(manifest, roots, output):
    if output.exists() or output.is_symlink():
        raise ValueError("Output already exists; choose a new directory")
    if manifest["schema"] != "readymade-backend-assembly-v1":
        raise ValueError("Unknown assembly schema")
    prepared = {}
    for category, prefix in [("files", "desk"), ("notices", "notices")]:
        for name, pin in manifest[category].items():
            safe_parts(name)
            prepared[prefix + "/" + name] = read_pinned(roots[pin["component"]], pin)
    # Validate every input before reserving the output directory. Exclusive mkdir
    # prevents concurrent assemblers from merging candidates or replacing output.
    output.mkdir()
    for name, data in prepared.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write(data)
        if digest(target.read_bytes()) != digest(data):
            raise ValueError("Output readback mismatch: " + name)
    receipt = {"schema": "readymade-backend-assembly-receipt-v1",
               "scope": "source assembly only; no ship installation or release approval",
               "files": {name: digest(data) for name, data in prepared.items()}}
    # Written last. An interrupted output without this receipt is incomplete.
    with (output / "assembly.json").open("x") as stream:
        json.dump(receipt, stream, indent=2)
        stream.write("\n")
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    components = ["application", "upstream", "codemirror", "sigil", "xterm"]
    for component in components:
        parser.add_argument("--" + component, type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    roots = {component: getattr(args, component).resolve(strict=True)
             for component in components}
    roots["repository"] = here
    manifest = json.loads((here / "assembly-manifest.json").read_text())
    receipt = assemble(manifest, roots, args.output.absolute())
    print(f"Verified {len(manifest['files'])} desk files and "
          f"{len(manifest['notices'])} notice files in {args.output}")
    return receipt


if __name__ == "__main__":
    main()
