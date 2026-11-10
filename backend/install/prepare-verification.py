"""Generate an owner-bound, read-only native proof of the complete candidate."""

import argparse
import hashlib
import json
import re
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--ship", required=True)
    parser.add_argument("--desk", required=True)
    parser.add_argument("--revision", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"~[a-z]+(?:-[a-z]+)*", args.ship):
        raise ValueError("Expected a ship name; native Hoon also validates its spelling")
    if not re.fullmatch(r"[a-z]+(?:-[a-z0-9]+)*", args.desk) or args.revision < 1:
        raise ValueError("Expected a desk and positive immutable revision")
    here = Path(__file__).resolve().parent
    manifest = json.loads((here.parent / "assembly-manifest.json").read_text())
    root = args.source.resolve(strict=True)
    actual = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("Linked source refused")
        if path.is_file():
            actual.add(path.relative_to(root).as_posix())
    if actual != manifest["files"].keys():
        raise ValueError("Source tree differs from the manifest")
    paths, pins, wains, content = [], [], [], {}
    for name, pin in sorted(manifest["files"].items()):
        if (not re.fullmatch(r"[a-z0-9.-]+(?:/[a-z0-9.-]+)*\.[a-z0-9-]+", name)
                or any(part in (".", "..") for part in name.split("/"))):
            raise ValueError("Unsupported source path")
        data = (root / name).read_bytes()
        if len(data) != pin["bytes"] or hashlib.sha256(data).hexdigest() != pin["sha256"]:
            raise ValueError("Source hash mismatch: " + name)
        content[name] = data
        stem, mark = name.rsplit(".", 1)
        parts = stem.split("/") + [mark]
        path = "/" + "/".join(part if re.fullmatch(r"[a-z0-9-]+", part)
                               else '(crip "' + part + '")' for part in parts)
        paths.append(path)
        raw = hashlib.sha256(data).digest()[::-1].hex().lstrip("0") or "0"
        # Hoon hex groups must be at most four digits.
        groups = [raw[max(0, end - 4):end] for end in range(len(raw), 0, -4)]
        digest = "0x" + ".".join(reversed(groups))
        if mark in ("hoon", "js", "css", "html"):
            pins.append("[" + path + " " + digest + "]")
        elif mark == "txt":
            wains.append((path, digest))
        elif name not in ("desk.bill", "sys.kelvin"):
            raise ValueError("Unsupported native mark: " + name)
    bill = content["desk.bill"].decode().strip()
    if not re.fullmatch(r"~\[%[a-z-]+(?: %[a-z-]+)*\]", bill):
        raise ValueError("Unsupported bill")
    if content["sys.kelvin"].decode().strip() != "[%zuse 408]":
        raise ValueError("Unsupported kernel")
    revision = format(args.revision, ",").replace(",", ".")
    address = f"/{args.ship}/{args.desk}/{revision}"
    lines = ["=/  m  (strand ,vase)", ";<  b=bowl  bind:m  get-bowl",
             f"?>  &(=({args.ship} our.b) =(our.b src.b))",
             f"=/  ds=cone:clay  .^(cone:clay %cx /{args.ship}//(scot %da now.b)/domes)",
             f"=/  d=dome:clay  (~(got by ds) [our.b %{args.desk}])",
             f"?>  &(=({revision} let.d) =(%dead liv.d) =(~ wic.d))",
             "=/  expected=(list path)  ~[" + " ".join(paths) + "]",
             f"?>  =((silt expected) (silt .^((list path) %ct {address})))",
             "=/  pins=(list [p=path hash=@ux])  ~[" + " ".join(pins) + "]",
             f"?>  (levy pins |=([p=path hash=@ux] =(hash (shax .^(@t %cx (weld {address} p))))))"]
    lines += [f"?>  =({digest} (shax (of-wain:format .^(wain %cx {address}{path}))))"
              for path, digest in wains]
    lines += [f"?>  =((cord-to-waft:clay '[%zuse 408]') .^(waft:clay %cx {address}/sys/kelvin))",
              f"?>  =({bill} .^((list @tas) %cx {address}/desk/bill))",
              f"(pure:m !>([%readymade-complete-source-verified-v1 our.b %{args.desk} {revision} (lent expected) (lent pins)]))"]
    with args.output.open("x") as output:
        output.write("\n".join(lines) + "\n")
    print(f"Prepared read-only verification of {len(paths)} source paths in {args.output}")


if __name__ == "__main__":
    main()
