"""Prepare one receiver/staging strand; no native operation is executed."""

import argparse
import hashlib
import json
import re
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def prepare(ship, desk, operation, revision, output):
    if not re.fullmatch(r"~[a-z]+(?:-[a-z]+)*", ship):
        raise ValueError("Expected a literal ship identity")
    if (not re.fullmatch(r"[a-z]+(?:-[a-z0-9]+)*", desk)
            or desk in {"base", "noltbook-data", "host-law", "host-viki",
                        "hot-viki", "glass-desktop-build"}):
        raise ValueError("Expected a dedicated installation desk")
    if operation not in {"receiver", "observe", "create", "mount", "commit"}:
        raise ValueError("Unknown operation")
    if operation in {"mount", "commit"}:
        if type(revision) is not int or not 1 <= revision <= 2**31:
            raise ValueError("Mount/commit requires the actual observed positive revision")
    elif revision is not None:
        raise ValueError("Receiver/observe/create accepts no assumed revision")
    output = output.absolute()
    if output.exists() or output.is_symlink() or not output.parent.is_dir():
        raise ValueError("Choose a new output directory with an existing parent")
    here = Path(__file__).resolve().parent
    template = here / ("receiver-check.hoon" if operation == "receiver" else "stage.hoon")
    body = template.read_bytes()
    target = f"{ship} %{desk}"
    if operation != "receiver":
        number = format(revision or 0, ",").replace(",", ".")
        target += f" %{operation} {number}"
    source = f"=/  arg=vase  !>([{target}])\n".encode() + body
    receipt = {"schema": "readymade-prepared-operation-v1", "ship": ship,
               "desk": desk, "operation": operation, "revision": revision,
               "mutating": operation in {"create", "mount", "commit"},
               "executed": False, "source": "operation.hoon",
               "sourceSHA256": digest(source), "template": template.name,
               "templateSHA256": digest(body),
               "assemblyManifestSHA256": digest((here.parent / "assembly-manifest.json").read_bytes())}
    output.mkdir(mode=0o700)
    with (output / "operation.hoon").open("xb") as stream:
        stream.write(source)
    (output / "operation.hoon").chmod(0o600)
    with (output / "packet.json").open("x") as stream:
        json.dump(receipt, stream, indent=2)
        stream.write("\n")
    (output / "packet.json").chmod(0o600)
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ship", required=True)
    parser.add_argument("--desk", required=True)
    parser.add_argument("--operation", required=True, choices=["receiver", "observe", "create", "mount", "commit"])
    parser.add_argument("--revision", type=int)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    result = prepare(args.ship, args.desk, args.operation, args.revision, args.output)
    print("Prepared " + result["operation"] + "; nothing executed. Review operation.hoon before native submission.")
