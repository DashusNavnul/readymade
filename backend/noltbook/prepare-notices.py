"""Verify exact and derived inherited Noltbook source and prepare its available upstream notices."""
import argparse
import hashlib
import json
import tarfile
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def derived_bytes(data, pin):
    if pin["transform"] != "exact-line-splices-v1":
        raise ValueError("Unsupported notice derivation")
    lines = data.decode("utf-8").splitlines(keepends=True)
    previous = len(lines) + 1
    for edit in reversed(pin["edits"]):
        start, end = edit["start"], edit["end"]
        if not 0 <= start <= end < previous or lines[start:end] != edit["old"]:
            raise ValueError("Notice derivation context mismatch")
        lines[start:end] = edit["new"]
        previous = start
    result = "".join(lines).encode("utf-8")
    if digest(result) != pin["candidateSha256"]:
        raise ValueError("Notice derivation output mismatch")
    return result


def prepare(noltbook_archive, urbit_archive, output, here=None):
    here = here or Path(__file__).resolve().parent
    noltbook = json.loads((here / "manifest.json").read_text())
    upstream_dir = here.parent / "upstream"
    upstream = json.loads((upstream_dir / "manifest.json").read_text())
    if output.exists() or output.is_symlink():
        raise ValueError("Output must be a new directory")
    for archive, manifest in [(noltbook_archive, noltbook), (urbit_archive, upstream)]:
        if digest(archive.read_bytes()) != manifest["archiveSha256"]:
            raise ValueError("Archive hash mismatch")
    matches = {}
    derived = {}
    notices = {}
    with tarfile.open(noltbook_archive) as source, tarfile.open(urbit_archive) as stock:
        for name, pin in noltbook["files"].items():
            member = source.getmember(pin["archivePath"])
            if not member.isfile():
                raise ValueError("Noltbook source must be a regular file")
            data = source.extractfile(member).read()
            if len(data) != pin["bytes"] or digest(data) != pin["sha256"]:
                raise ValueError("Noltbook source mismatch")
            candidates = [row for row in upstream["files"].values()
                          if pin["sha256"] in {row["upstreamSha256"], row.get("candidateSha256")}]
            paths, derivations = [], []
            for row in candidates:
                original = stock.extractfile(row["archivePath"]).read()
                if digest(original) != row["upstreamSha256"]:
                    raise ValueError("Inherited source hash differs")
                if original == data:
                    paths.append(row["archivePath"])
                else:
                    if derived_bytes(original, row) != data:
                        raise ValueError("Derived inherited source differs")
                    derivations.append(row)
            if paths:
                matches[name] = {"sha256": pin["sha256"], "upstreamPaths": sorted(paths)}
            elif derivations:
                derived[name] = {"sha256": pin["sha256"], "derivations": derivations}
        for name, pin in upstream["licenses"].items():
            if Path(name).name != name or name in {".", ".."}:
                raise ValueError("Unsafe notice name")
            data = stock.extractfile(pin["archivePath"]).read()
            if digest(data) != pin["sha256"] or data != (upstream_dir / name).read_bytes():
                raise ValueError("Upstream notice mismatch")
            notices[name] = data
    report = {
        "schema": "readymade-noltbook-inherited-notices-v2",
        "noltbookCommit": noltbook["commit"], "noltbookArchiveSHA256": noltbook["archiveSha256"],
        "upstreamCommit": upstream["commit"], "upstreamArchiveSHA256": upstream["archiveSha256"],
        "upstreamManifestSHA256": digest((upstream_dir / "manifest.json").read_bytes()),
        "exactInheritedFiles": matches, "derivedInheritedFiles": derived,
        "unresolvedFiles": sorted(set(noltbook["files"]) - set(matches) - set(derived)),
        "noticeSHA256": {name: digest(data) for name, data in notices.items()},
        "fullNoticeCoverage": False, "releaseApproved": False,
        "scope": "Exact and verified derived-file provenance and retained upstream notices; not whole-project licensing approval",
    }
    output.mkdir(parents=True)
    for name, data in notices.items():
        with (output / name).open("xb") as stream:
            stream.write(data)
    with (output / "coverage.json").open("x") as stream:
        stream.write(json.dumps(report, indent=2) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("noltbook_archive", type=Path)
    parser.add_argument("urbit_archive", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    report = prepare(args.noltbook_archive, args.urbit_archive, args.output)
    print(f"Verified {len(report['exactInheritedFiles'])} exact and "
          f"{len(report['derivedInheritedFiles'])} derived inherited files; "
          f"{len(report['unresolvedFiles'])} files remain unresolved. Full release is not qualified.")


if __name__ == "__main__":
    main()
