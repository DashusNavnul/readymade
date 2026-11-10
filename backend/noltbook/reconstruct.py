"""Reconstruct pinned Noltbook source; never install or modify a ship."""
import argparse
import copy
import hashlib
import json
import tarfile
from pathlib import Path, PurePosixPath


def digest(data):
    return hashlib.sha256(data).hexdigest()


def apply_media_overlay(data, recipe=None):
    if recipe is None:
        recipe = json.loads(Path(__file__).with_name("media-overlay.json").read_text())
    if recipe["schema"] != "readymade-noltbook-media-overlay-v1" or recipe["path"] != "lib/noltbook/index.html":
        raise ValueError("Unsupported media overlay")
    if digest(data) != recipe["inputSha256"]:
        raise ValueError("Media overlay input hash mismatch")
    text = data.decode("utf-8")
    for edit in recipe["edits"]:
        if not edit["before"] or text.count(edit["before"]) != 1:
            raise ValueError("Media overlay context must match exactly once")
        text = text.replace(edit["before"], edit["after"], 1)
    result = text.encode("utf-8")
    if digest(result) != recipe["outputSha256"] or len(result) != recipe["outputBytes"]:
        raise ValueError("Media overlay output mismatch")
    return result


NAMES={'app/noltbook.hoon','sur/noltbook.hoon','lib/noltbook-document-receipts.hoon','mar/noltbook/action.hoon','mar/noltbook/update.hoon'}
def apply_document_receipts(prepared, recipe=None):
 if recipe is None:
  recipe = json.loads(Path(__file__).with_name("document-receipts-overlay.json").read_text())
 media_hash = digest(Path(__file__).with_name("media-overlay.json").read_bytes())
 if recipe['schema']!='readymade-noltbook-document-receipts-overlay-v1' or recipe['upstreamCommit']!='7124b6119c99d1d5f78ae922f66bfd83cf90d96d' or recipe['baseMediaOverlaySHA256']!=media_hash or set(recipe['changes'])!=NAMES or len(prepared)!=39:raise ValueError('Wrong overlay baseline')
 result=dict(prepared)
 for name,pin in recipe['changes'].items():
  path=PurePosixPath(name)
  if path.is_absolute() or '..' in path.parts or path.as_posix()!=name:raise ValueError('Unsafe path')
  before=prepared.get(name)
  if pin['inputSha256'] is None:
   if before is not None or name!='lib/noltbook-document-receipts.hoon' or 'edits' in pin:raise ValueError('New file collision')
   after=pin['create'].encode()
  else:
   if before is None or digest(before)!=pin['inputSha256'] or 'create' in pin:raise ValueError('Input hash mismatch')
   lines=before.decode().splitlines(keepends=True);previous=len(lines)+1
   for edit in reversed(pin['edits']):
    start,end=edit['start'],edit['end']
    if not 0<=start<=end<previous or lines[start:end]!=edit['old']:raise ValueError('Splice mismatch')
    lines[start:end]=edit['new'];previous=start
   after=''.join(lines).encode()
  if len(after)!=pin['outputBytes'] or digest(after)!=pin['outputSha256']:raise ValueError('Output hash mismatch')
  result[name]=after
 if len(result)!=recipe['sourceFileCount'] or len(result)!=40:raise ValueError('Wrong output file set')
 return result


def document_receipts_manifest(manifest):
    """Return effective pins only after the caller applied the pinned media manifest."""
    recipe_bytes = Path(__file__).with_name("document-receipts-overlay.json").read_bytes()
    recipe = json.loads(recipe_bytes)
    media_bytes = Path(__file__).with_name("media-overlay.json").read_bytes()
    media = json.loads(media_bytes)
    if (recipe["schema"] != "readymade-noltbook-document-receipts-overlay-v1"
            or recipe["upstreamCommit"] != manifest["commit"]
            or recipe["baseMediaOverlaySHA256"] != digest(media_bytes)
            or set(recipe["changes"]) != NAMES or len(manifest["files"]) != 39
            or manifest["files"][media["path"]]["sha256"] != media["outputSha256"]):
        raise ValueError("Receipt overlay requires the exact media-enabled upstream manifest")
    result = copy.deepcopy(manifest)
    for name, pin in recipe["changes"].items():
        old = result["files"].get(name)
        if pin["inputSha256"] is None:
            if old is not None or name != "lib/noltbook-document-receipts.hoon":
                raise ValueError("Receipt library collision")
        elif old is None or old["sha256"] != pin["inputSha256"]:
            raise ValueError("Receipt source input pin mismatch")
        result["files"][name] = {"bytes": pin["outputBytes"], "sha256": pin["outputSha256"]}
    if len(result["files"]) != 40 or recipe["sourceFileCount"] != 40:
        raise ValueError("Receipt source count mismatch")
    result["documentReceiptsOverlaySHA256"] = digest(recipe_bytes)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--readymade-media", action="store_true",
                        help="Apply pinned Readymade WebRTC fixes after verifying upstream source")
    parser.add_argument("--document-receipts", action="store_true",
                        help="Apply the pinned durable document receipt overlay; requires --readymade-media")
    args = parser.parse_args()
    if args.document_receipts and not args.readymade_media:
        parser.error("--document-receipts requires --readymade-media")
    manifest = json.loads(Path(__file__).with_name("manifest.json").read_text())
    output = args.output.resolve()
    if output.exists():
        raise ValueError("Output must not already exist")
    if digest(args.archive.read_bytes()) != manifest["archiveSha256"]:
        raise ValueError("Archive hash mismatch")
    prepared = {}
    with tarfile.open(args.archive) as source:
        for name, pin in manifest["files"].items():
            path = PurePosixPath(name)
            if not name or path.is_absolute() or ".." in path.parts or "\\" in name or path.as_posix() != name:
                raise ValueError("Unsafe output path")
            expected = "noltbook-" + manifest["commit"] + "/" + name
            if pin["archivePath"] != expected:
                raise ValueError("Unexpected archive member path")
            entry = source.getmember(expected)
            if not entry.isfile():
                raise ValueError("Expected a regular archive file")
            data = source.extractfile(entry).read()
            if digest(data) != pin["sha256"] or len(data) != pin["bytes"]:
                raise ValueError("Source hash or size mismatch: " + name)
            prepared[name] = data
    if args.readymade_media:
        name = "lib/noltbook/index.html"
        prepared[name] = apply_media_overlay(prepared[name])
    if args.document_receipts:
        prepared = apply_document_receipts(prepared)
    output.mkdir(parents=True)
    for name, data in prepared.items():
        path = output / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as stream:
            stream.write(data)
    print(f"Verified {len(prepared)} source files. Full notice coverage remains unqualified.")


if __name__ == "__main__":
    main()
