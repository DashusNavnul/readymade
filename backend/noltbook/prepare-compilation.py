"""Prepare source verification and two inactive app builds; never contact a ship."""

import argparse
import importlib.util
import copy
import hashlib
import json
import re
from pathlib import Path


receipt_spec = importlib.util.spec_from_file_location(
    "noltbook_reconstruction", Path(__file__).with_name("reconstruct.py"))
reconstruction = importlib.util.module_from_spec(receipt_spec)
receipt_spec.loader.exec_module(reconstruction)

def digest(data):
    return hashlib.sha256(data).hexdigest()


def atom(data):
    value = data[::-1].hex().lstrip("0") or "0"
    return "0x" + ".".join(reversed([
        value[max(0, end - 4):end] for end in range(len(value), 0, -4)]))


def clay_path(name):
    if not re.fullmatch(r"[a-z0-9.-]+(?:/[a-z0-9.-]+)*\.[a-z0-9-]+", name):
        raise ValueError("Unsupported source path")
    if any(part in (".", "..") for part in name.split("/")):
        raise ValueError("Unsafe source path")
    stem, mark = name.rsplit(".", 1)
    return "/" + "/".join(
        '(crip "' + part + '")' if "." in part else part
        for part in stem.split("/") + [mark])


def no_links(path):
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise ValueError("Linked path refused")


def prepare(source, ship, desk, revision, base_revision, output, manifest=None, readymade_media=False, document_receipts=False):
    if document_receipts and not readymade_media:
        raise ValueError("Document receipts require readymade media")
    here = Path(__file__).resolve().parent
    if manifest is None:
        manifest = json.loads((here / "manifest.json").read_text())
    overlay_hash = None
    if readymade_media:
        overlay_bytes = (here / "media-overlay.json").read_bytes()
        overlay = json.loads(overlay_bytes)
        name = "lib/noltbook/index.html"
        if (overlay["schema"] != "readymade-noltbook-media-overlay-v1"
                or overlay["path"] != name or overlay["upstreamCommit"] != manifest["commit"]
                or overlay["inputSha256"] != manifest["files"][name]["sha256"]):
            raise ValueError("Media overlay does not bind this upstream source")
        manifest = copy.deepcopy(manifest)
        manifest["files"][name].update(sha256=overlay["outputSha256"], bytes=overlay["outputBytes"])
        overlay_hash = digest(overlay_bytes)
    if document_receipts:
        manifest = reconstruction.document_receipts_manifest(manifest)
    if not re.fullmatch(r"~[a-z]+(?:-[a-z]+)*", ship):
        raise ValueError("Expected literal ship identity")
    if not re.fullmatch(r"[a-z]+(?:-[a-z0-9]+)*", desk) or desk == "base":
        raise ValueError("Expected a separate inactive desk")
    if not 1 <= base_revision <= 2**31 or not 2 <= revision <= 2**31:
        raise ValueError("Expected positive immutable base and staged revisions")
    source, output = source.absolute(), output.absolute()
    no_links(source)
    no_links(output)
    if output.exists() or not output.parent.is_dir():
        raise ValueError("Choose new output with an existing parent")
    actual = set()
    for path in source.rglob("*"):
        if path.is_symlink():
            raise ValueError("Linked source refused")
        if path.is_file():
            actual.add(path.relative_to(source).as_posix())
    if actual != manifest["files"].keys():
        raise ValueError("Source file set differs from manifest")
    contents, pins, paths = {}, [], []
    for name, pin in sorted(manifest["files"].items()):
        native = clay_path(name)
        data = (source / name).read_bytes()
        if len(data) != pin["bytes"] or digest(data) != pin["sha256"]:
            raise ValueError("Source hash or size mismatch: " + name)
        contents[name] = data
        paths.append(native)
        if name in ("desk.bill", "sys.kelvin", "desk.docket-0"):
            continue
        if name.rsplit(".", 1)[1] not in ("hoon", "html", "svg"):
            raise ValueError("Unsupported native source mark")
        pins.append("[" + native + " " + atom(hashlib.sha256(data).digest()) + "]")
    for required in ("desk.bill", "sys.kelvin", "desk.docket-0", "lib/docket.hoon",
                     "app/noltbook.hoon", "app/noltbook-calls.hoon"):
        if required not in contents:
            raise ValueError("Required Noltbook source missing")
    rev = format(revision, ",").replace(",", ".")
    base_rev = format(base_revision, ",").replace(",", ".")
    address, baseline = f"/{ship}/{desk}/{rev}", f"/{ship}/base/{base_rev}"
    lines = [
        "=/  m  (strand ,vase)", ";<  b=bowl  bind:m  get-bowl",
        f"?>  &(=({ship} our.b) =(our.b src.b))",
        f"=/  ds=cone:clay  .^(cone:clay %cx /{ship}//(scot %da now.b)/domes)",
        f"=/  d=dome:clay  (~(got by ds) [our.b %{desk}])",
        f"?>  &(=({rev} let.d) =(%dead liv.d) =(~ ren.d) =(~ wic.d))",
        "=/  additions=(list path)  ~[" + " ".join(paths) + "]",
        f"=/  original=(list path)  .^((list path) %ct {baseline})",
        "=/  expected=(set path)  (silt (weld original additions))",
        f"?>  =(expected (silt .^((list path) %ct {address})))",
        "=/  pins=(list [p=path hash=@ux])  ~[" + " ".join(pins) + "]",
        f"?>  (levy pins |=([p=path hash=@ux] =(hash (shax .^(@t %cx (weld {address} p))))))",
        "=/  preserved=(list path)  (skim original |=(p=path !(~(has in (silt additions)) p)))",
        f"?>  (levy preserved |=(p=path =(.^(* %cx (weld {address} p)) .^(* %cx (weld {baseline} p)))))",
        f"?>  =((cord-to-waft:clay `@t`{atom(contents['sys.kelvin'])}) .^(waft:clay %cx {address}/sys/kelvin))",
        f"=/  expected-bill=vase  (slap !>(~) (ream {atom(contents['desk.bill'])}))",
        f"?>  =(!<((list @tas) expected-bill) .^((list @tas) %cx {address}/desk/bill))",
        ";<  docket-lib=vase  bind:m",
        f"  (build-file-hard [[our.b %{desk} ud+{rev}] /lib/docket/hoon])",
        "=/  parser=vase  (slap docket-lib (ream 'from-clauses:mime'))",
        f"=/  clauses=vase  (slap !>(~) (ream {atom(contents['desk.docket-0'])}))",
        "=/  parsed=vase  (slam parser clauses)",
        "=/  expected-docket=(unit *)  !<((unit *) parsed)",
        "?>  ?=(^ expected-docket)",
        f"?>  =(u.expected-docket .^(* %cx {address}/desk/docket-0))",
        f"(pure:m !>([%readymade-noltbook-source-verified-v1 our.b %{desk} {rev} ~(wyt in expected) (lent pins) (lent preserved)]))", ""]
    helper = (here.parent / "install/compile-app.hoon").read_text()
    files = {"00-source.hoon": "\n".join(lines)}
    for number, app in enumerate(("noltbook", "noltbook-calls"), 1):
        files[f"0{number}-{app}.hoon"] = (
            f"=/  arg=vase  !>([{ship} %{desk} {rev} %{app}])\n" + helper)
    packet = {"schema": "readymade-noltbook-compilation-packet-v1",
              "scope": "Prepared checks only; no execution or activation",
              "ship": ship, "desk": desk, "revision": revision,
              "baseRevision": base_revision, "upstreamCommit": manifest["commit"],
              "fullNoticeQualified": False, "mediaOverlaySHA256": overlay_hash,
              "sourceFiles": {name: digest(data) for name, data in contents.items()},
              "files": {name: digest(text.encode()) for name, text in files.items()}}
    if document_receipts:
        packet["documentReceiptsOverlaySHA256"] = manifest["documentReceiptsOverlaySHA256"]
    output.mkdir(mode=0o700)
    for name, text in files.items():
        with (output / name).open("x") as stream:
            stream.write(text)
    with (output / "packet.json").open("x") as stream:
        json.dump(packet, stream, indent=2)
        stream.write("\n")
    return packet


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--ship", required=True)
    parser.add_argument("--desk", required=True)
    parser.add_argument("--revision", type=int, required=True)
    parser.add_argument("--base-revision", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--readymade-media", action="store_true")
    parser.add_argument("--document-receipts", action="store_true")
    args = parser.parse_args()
    packet = prepare(args.source, args.ship, args.desk, args.revision,
                     args.base_revision, args.output, readymade_media=args.readymade_media,
                     document_receipts=args.document_receipts)
    print(f"Prepared {len(packet['files'])} read-only native checks; not executed.")


if __name__ == "__main__":
    main()
