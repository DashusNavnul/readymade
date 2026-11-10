"""Prepare guarded Noltbook activation artifacts; never execute them."""

import argparse
import hashlib
import json
import re
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def no_links(path):
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise ValueError("Linked path refused")


def prepare(checks, root, existing_apps, output):
    checks, output = checks.absolute(), output.absolute()
    no_links(checks)
    no_links(output)
    if output.exists() or not output.parent.is_dir():
        raise ValueError("Choose new output with an existing parent")
    if not re.fullmatch(r"[0-9a-f]{64}", root):
        raise ValueError("Expected native immutable root as 64 lowercase hexadecimal digits")
    if type(existing_apps) is not int or not 1 <= existing_apps <= 10000:
        raise ValueError("Expected observed existing app count")
    packet_path = checks / "packet.json"
    no_links(packet_path)
    raw = packet_path.read_bytes()
    packet = json.loads(raw)
    if packet.get("schema") != "readymade-noltbook-compilation-packet-v1":
        raise ValueError("Expected Noltbook compilation preparation packet")
    ship, desk, revision = packet["ship"], packet["desk"], packet["revision"]
    if (not isinstance(ship, str) or not re.fullmatch(r"~[a-z]+(?:-[a-z]+)*", ship)
            or not isinstance(desk, str) or not re.fullmatch(r"[a-z]+(?:-[a-z0-9]+)*", desk)
            or desk in ("base", "noltbook-data")
            or type(revision) is not int or not 2 <= revision <= 2**31):
        raise ValueError("Invalid compilation target")
    expected = {"00-source.hoon", "01-noltbook.hoon", "02-noltbook-calls.hoon"}
    if set(packet["files"]) != expected:
        raise ValueError("Incomplete compilation checks")
    for name in sorted(expected):
        path = checks / name
        no_links(path)
        if digest(path.read_bytes()) != packet["files"][name]:
            raise ValueError("Compilation artifact changed: " + name)
    template = Path(__file__).with_name("activate.hoon").read_text()
    digits = root.lstrip("0") or "0"
    first = len(digits) % 4 or 4
    native_root = "0x" + ".".join([digits[:first]] + [
        digits[i:i+4] for i in range(first, len(digits), 4)])
    native_revision = format(revision, ",").replace(",", ".")
    native_count = format(existing_apps, ",").replace(",", ".")
    files = {}
    for name, submit in (("00-preflight.hoon", "n"), ("01-activate.hoon", "y")):
        header = (f"=/  arg=vase  !>([{ship} %{desk} {native_revision} "
                  f"{native_root} {native_count} %.{submit}])\n")
        files[name] = header + template
    post = Path(__file__).with_name("post-install.hoon").read_text()
    snapshot = (Path(__file__).parent.parent / "install/snapshot.hoon").read_text()
    files["02-post-install.hoon"] = (
        f"=/  arg=vase  !>([{ship} %{desk} {native_revision} "
        f"{native_root} {native_count}])\n" + post)
    files["03-snapshot.hoon"] = (
        f"=/  arg=vase  !>([{ship} %{desk} {native_revision}])\n" + snapshot)
    result = {"schema": "readymade-noltbook-activation-packet-v1",
              "scope": "Prepared only; compilation success and owner authorization required before execution",
              "ship": ship, "desk": desk, "revision": revision, "root": root,
              "existingApps": existing_apps, "compilationPacketSHA256": digest(raw),
              "templateSHA256": digest(template.encode()),
              "postInstallTemplateSHA256": digest(post.encode()),
              "snapshotTemplateSHA256": digest(snapshot.encode()),
              "files": {name: digest(text.encode()) for name, text in files.items()}}
    output.mkdir(mode=0o700)
    for name, text in files.items():
        with (output / name).open("x") as stream:
            stream.write(text)
    with (output / "packet.json").open("x") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checks", type=Path, required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--existing-apps", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.checks, args.root, args.existing_apps, args.output)
    print("Prepared preflight, single-submit and post-install artifacts; nothing executed.")


if __name__ == "__main__":
    main()
