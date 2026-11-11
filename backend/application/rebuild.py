#!/usr/bin/env python3
"""Rebuild source.tar.gz from the Pataphor repository's HEAD commit, and record what it was built from.

    python3 backend/application/rebuild.py --pataphor /path/to/pataphor          # rebuild and write
    python3 backend/application/rebuild.py --pataphor /path/to/pataphor --check  # exit 1 if the archive is stale

Run it for every release. It reads committed bytes only (git HEAD, never the working tree):
every application file already in the archive (except desk.bill, which this package owns), plus
every file those now import, plus the files the guest-desk manifest names. It writes the archive (same deterministic format as before), the
file pins in ../assembly-manifest.json, the archive hash in extract.py, the count in README.md,
and source.json: the Pataphor commit and the archive hash, so a package can always be traced to
the exact source it carries. A file that left the Pataphor repo stops the run until it is
dropped on purpose with --drop PATH.
"""
import argparse, gzip, hashlib, io, json, re, subprocess, sys, tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ARCHIVE, MANIFEST, EXTRACT, README, RECORD = HERE / "source.tar.gz", HERE.parent / "assembly-manifest.json", HERE / "extract.py", HERE / "README.md", HERE / "source.json"
DESK = "desk/pataphor"
GUEST_MANIFEST = "data/readymade-guest-manifest.txt"
# Files this package owns: the same path exists in Pataphor with other contents. Pataphor's desk.bill starts all
# of its agents; this package starts its own qualified app set, and the installer pins that set by name.
BUNDLE_OWNED = {"desk.bill"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pack(files):
    """Sorted names, USTAR, 0644, zero times and ids; gzip without name or time."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name in sorted(files):
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime, info.uid, info.gid, info.uname, info.gname = len(files[name]), 0o644, 0, 0, 0, "", ""
            tar.addfile(info, io.BytesIO(files[name]))
    out = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=out, mtime=0, compresslevel=9) as zipped:
        zipped.write(raw.getvalue())
    return out.getvalue()


def imports(text):
    """Desk-relative files one Hoon file imports with /-, /+, /= and /*."""
    out, block, kind = [], False, "lib"
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("::"):
            continue
        if line.startswith("/-") or line.startswith("/+"):
            kind, block, body = ("sur" if line.startswith("/-") else "lib"), True, line[2:]
        elif line.startswith("/*") or line.startswith("/="):
            block = False
            for token in line.split():
                if token.startswith("/") and len(token) > 1 and token not in ("/*", "/="):
                    parts = token.strip("/").split("/")
                    if parts[-1] == "hoon":
                        out.append("/".join(parts[:-1]) + ".hoon")
            continue
        elif block and line[:1] == " " and stripped:
            body = line
        else:
            if stripped and not line.startswith("/"):
                block = False
            continue
        for token in re.split(r"[,\s]+", body):
            token = token.strip()
            if not token:
                continue
            if token.startswith("::"):
                break
            name = token.split("=")[-1].lstrip("*")
            if re.fullmatch(r"[a-z][a-z0-9-]*", name):
                out.append(f"{kind}/{name}.hoon")
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pataphor", required=True, type=Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--drop", action="append", default=[])
    args = parser.parse_args()
    repo = args.pataphor.resolve()

    def git(*command):
        return subprocess.run(["git", "-C", str(repo), *command], check=True, capture_output=True).stdout

    commit = git("rev-parse", "HEAD").decode().strip()
    at_head = set(git("ls-tree", "-r", "--name-only", "HEAD", DESK).decode().splitlines())

    def committed(name):
        return git("show", f"HEAD:{DESK}/{name}") if f"{DESK}/{name}" in at_head else None

    manifest = json.loads(MANIFEST.read_text())
    with tarfile.open(ARCHIVE) as tar:
        current = {member.name: tar.extractfile(member).read() for member in tar}
    application = {name for name, row in manifest["files"].items() if row["component"] == "application"}
    other = {name for name in manifest["files"] if name not in application}
    kept = {name: data for name, data in current.items() if name not in application}  # the licence notice
    files, missing, todo = {}, [], sorted(application - set(args.drop))
    while todo:
        name = todo.pop()
        if name in files or name in other:
            continue
        data = current.get(name) if name in BUNDLE_OWNED else committed(name)
        if data is None:
            missing.append(name)
            continue
        files[name] = data
        if name.endswith(".hoon"):
            todo += [dep for dep in imports(data.decode("utf-8", "replace")) if dep not in files and dep not in other and f"{DESK}/{dep}" in at_head]
        if name == "lib/readymade-guest-desk.hoon":
            todo.append(GUEST_MANIFEST)
        if name == GUEST_MANIFEST:
            for line in data.decode().splitlines():
                if line.startswith("self /"):
                    parts = line[6:].split("/")
                    todo.append("/".join(parts[:-1]) + "." + parts[-1])
    # The guest desk a ship publishes is exactly what its manifest names. If the collaboration agent imports a
    # file the manifest does not list, every guest's build of it fails: stop the release here, with the names.
    if GUEST_MANIFEST in files:
        listed = {line.split(" ", 1)[1] for line in files[GUEST_MANIFEST].decode().splitlines() if line.startswith(("self /", "base /"))}
        seen, walk = set(), ["app/readymade-collab.hoon"]
        while walk:
            name = walk.pop()
            if name in seen or f"{DESK}/{name}" not in at_head:
                continue
            seen.add(name)
            walk += imports(committed(name).decode("utf-8", "replace"))
        unlisted = sorted(name for name in seen if "/" + name[:-5] + "/hoon" not in listed)
        if unlisted:
            sys.exit("The guest manifest (desk/pataphor/data/readymade-guest-manifest.txt) does not list files the collaboration agent imports:\n  " + "\n  ".join(unlisted))
    if missing:
        sys.exit("These application files are no longer in Pataphor's HEAD; pass --drop PATH for each to remove it on purpose:\n  " + "\n  ".join(sorted(missing)))
    archive = pack({**kept, **files})
    rows = {name: {"component": "application", "source": name, "sha256": sha(data), "bytes": len(data)} for name, data in files.items()}
    changed = sorted(name for name in files if name in application and manifest["files"][name]["sha256"] != rows[name]["sha256"])
    added, dropped = sorted(set(files) - application), sorted(application - set(files))
    record = {"schema": "readymade-application-source-v1", "pataphorCommit": commit, "archiveSha256": sha(archive), "applicationFiles": len(files)}
    summary = {**record, "changed": len(changed), "added": added, "dropped": dropped}
    if args.check:
        stale = sha(ARCHIVE.read_bytes()) != record["archiveSha256"] or not RECORD.exists() or json.loads(RECORD.read_text()) != record
        print(json.dumps({**summary, "stale": stale, "changedFiles": changed[:40]}, indent=1))
        sys.exit(1 if stale else 0)
    manifest["files"] = dict(sorted({**{name: row for name, row in manifest["files"].items() if name in other}, **rows}.items()))
    ARCHIVE.write_bytes(archive)
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    RECORD.write_text(json.dumps(record, indent=2) + "\n")
    text, count = re.subn(r'ARCHIVE_SHA256 = "[0-9a-f]{64}"', f'ARCHIVE_SHA256 = "{record["archiveSha256"]}"', EXTRACT.read_text())
    assert count == 1, "extract.py pin not found"
    text, count = re.subn(r"if len\(expected\) != \d+:", f"if len(expected) != {len(files)}:", text)
    assert count == 1, "extract.py file count not found"
    EXTRACT.write_text(text)
    overview = HERE.parent / "README.md"
    total = len(manifest["files"])
    text, count = re.subn(r"\(\d+ application\nfiles; [\d,]+ assembled desk files\)", f"({len(files)} application\nfiles; {total:,} assembled desk files)", overview.read_text())
    assert count == 1, "backend/README.md counts not found"
    overview.write_text(text)
    text, count = re.subn(r"contains \d+ application files", f"contains {len(files)} application files", README.read_text())
    assert count == 1, "README count not found"
    README.write_text(text)
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
