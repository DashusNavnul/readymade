"""Reconstruct inherited sources from a pinned archive without changing a ship."""
import argparse
import hashlib
import json
import tarfile
from pathlib import Path, PurePosixPath


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(name):
    path = PurePosixPath(name)
    if not name or path.is_absolute() or ".." in path.parts or "\\" in name:
        raise ValueError("Unsafe output path")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    manifest = json.loads((here / "manifest.json").read_text())
    output = args.output.resolve()
    if output.exists():
        raise ValueError("Output must not already exist")
    if digest(args.archive.read_bytes()) != manifest["archiveSha256"]:
        raise ValueError("Archive hash mismatch")
    prepared = {}
    with tarfile.open(args.archive) as source:
        for name, pin in manifest["files"].items():
            safe_path(name)
            entry = source.getmember(pin["archivePath"])
            if not (entry.isfile() or entry.issym() or entry.islnk()):
                raise ValueError("Source must be a file or archive-internal link")
            data = source.extractfile(entry).read()
            if digest(data) != pin["upstreamSha256"]:
                raise ValueError("Source hash mismatch: " + name)
            if pin["transform"] == "remove-one-final-LF":
                if not data.endswith(b"\n"):
                    raise ValueError("Final LF absent")
                data = data[:-1]
            elif pin["transform"] == "exact-line-splices-v1":
                lines = data.decode("utf-8").splitlines(keepends=True)
                previous = len(lines) + 1
                for edit in reversed(pin["edits"]):
                    start, end = edit["start"], edit["end"]
                    if not 0 <= start <= end < previous or lines[start:end] != edit["old"]:
                        raise ValueError("Patch context mismatch: " + name)
                    lines[start:end] = edit["new"]
                    previous = start
                data = "".join(lines).encode("utf-8")
            elif pin["transform"] != "identity":
                raise ValueError("Unknown transformation")
            if digest(data) != pin["candidateSha256"]:
                raise ValueError("Reconstruction mismatch: " + name)
            prepared[name] = data
        for name, pin in manifest["licenses"].items():
            safe_path(name)
            if name in prepared:
                raise ValueError("License path collides with source")
            data = source.extractfile(pin["archivePath"]).read()
            if digest(data) != pin["sha256"] or (here / name).read_bytes() != data:
                raise ValueError("License hash mismatch")
            prepared[name] = data
    output.mkdir(parents=True)
    for name, data in prepared.items():
        path = output / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as stream:
            stream.write(data)
    print(f"Verified {len(manifest['files'])} files and both license notices.")


if __name__ == "__main__":
    main()
