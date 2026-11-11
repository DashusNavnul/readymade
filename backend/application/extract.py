"""Verify and unpack Readymade application source; never modify a ship."""

import argparse
import hashlib
import json
import tarfile
from pathlib import Path, PurePosixPath

ARCHIVE_SHA256 = "7aa6c89a690240398ddb13f426d4df7c7a44d2ea098fb2f888be43b1ee805699"
LICENSE_SHA256 = "150e19f883107e85b8d2748bf5c722076070f0fb98463cfc8c468eba8941a41e"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def extract(archive, manifest, output):
    if output.exists() or output.is_symlink():
        raise ValueError("Output must be a new directory")
    if digest(archive.read_bytes()) != ARCHIVE_SHA256:
        raise ValueError("Source archive hash mismatch")
    expected = {name: pin for name, pin in manifest["files"].items()
                if pin["component"] == "application"}
    if len(expected) != 942:
        raise ValueError("Unexpected application file set")
    prepared = {}
    with tarfile.open(archive) as source:
        for member in source:
            name = member.name
            path = PurePosixPath(name)
            if (not member.isfile() or path.is_absolute() or ".." in path.parts
                    or "\\" in name or str(path) != name or name in prepared):
                raise ValueError("Invalid archive member")
            if name == "LICENSE":
                if member.size > 4096:
                    raise ValueError("Unexpected license size")
                data = source.extractfile(member).read()
                if digest(data) != LICENSE_SHA256:
                    raise ValueError("License mismatch")
            else:
                if name not in expected or member.size != expected[name]["bytes"]:
                    raise ValueError("Unexpected source file or size: " + name)
                data = source.extractfile(member).read()
                if digest(data) != expected[name]["sha256"]:
                    raise ValueError("Source file hash mismatch: " + name)
            prepared[name] = data
    if prepared.keys() != expected.keys() | {"LICENSE"}:
        raise ValueError("Incomplete archive")
    output.mkdir()
    for name, data in prepared.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write(data)
    return len(expected)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    manifest = json.loads((here.parent / "assembly-manifest.json").read_text())
    count = extract(here / "source.tar.gz", manifest, args.output.absolute())
    print(f"Verified {count} application files and MIT license in {args.output}")


if __name__ == "__main__":
    main()
