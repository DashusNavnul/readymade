"""Verify retained receiver/observation evidence offline; never authorize a write."""
import argparse
import hashlib
import importlib.util
import json
import os
import re
import stat
from pathlib import Path

spec = importlib.util.spec_from_file_location("native_frame", Path(__file__).with_name("compare-snapshots.py"))
n = importlib.util.module_from_spec(spec)
spec.loader.exec_module(n)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path, limit=2 * 1024 * 1024):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        info = os.fstat(stream.fileno())
        n.require(stat.S_ISREG(info.st_mode) and info.st_size <= limit, "Invalid or oversized receipt file")
        data = stream.read(limit + 1)
    n.require(len(data) <= limit, "Receipt exceeded limit")
    return data


def boolean(value):
    n.require(type(value) is int and value in (0, 1), "Invalid native boolean")
    return value == 0


def interpret(payload, operation, desk, receiver_version=2):
    if operation == "receiver":
        tag, owner, target, eligible, kernel, bounded, present, override, apps, routes = n.unpack(payload, 10)
        n.require(receiver_version in (1, 2) and tag == n.atom(f"readymade-receiver-check-v{receiver_version}"), "Wrong receiver result")
        checks = {"kernel408": boolean(kernel), "boundedEvaluation": boolean(bounded),
                  "deskPresent": boolean(present), "overridePresent": boolean(override),
                  "appConflicts": len(list(n.rows(apps))), "routeConflicts": len(list(n.rows(routes)))}
        calculated = (checks["kernel408"] and checks["boundedEvaluation"] and
                      not any(checks[k] for k in ("deskPresent", "overridePresent", "appConflicts", "routeConflicts")))
        n.require(boolean(eligible) == calculated, "Eligibility contradicts native checks")
        result = {"eligible": calculated, "checks": checks,
                  "appSet": n.CURRENT_APP_SET if receiver_version == 2 else n.LEGACY_APP_SET}
    else:
        n.require(operation == "observe", "Only read-only observations are supported")
        tag, owner, target, value = n.unpack(payload, 4)
        n.require(tag == n.atom("readymade-stage-observed-v1"), "Wrong observation result")
        result = {"present": value != 0}
        if value != 0:
            n.require(isinstance(value, tuple) and value[0] == 0, "Malformed desk unit")
            revision, life, idle, root = n.unpack(value[1], 4)
            n.require(type(revision) is int and revision > 0, "Invalid desk revision")
            n.require(life in (n.atom("live"), n.atom("dead")), "Unknown desk state")
            n.require(isinstance(root, tuple) and root[0] == 0 and type(root[1]) is int and 0 <= root[1] < 2**256,
                      "Missing or invalid immutable root")
            result.update(revision=revision, state=n.text(life), pendingClayWork=not boolean(idle), root=f"{root[1]:064x}")
    n.require(type(owner) is int and owner >= 0 and target == n.atom(desk), "Wrong result identity/desk shape")
    return {"observedShipAtom": str(owner), **result}


def verify(packet_dir, receipt_dir):
    packet = json.loads(read(packet_dir / "packet.json"))
    n.require(packet.get("schema") == "readymade-prepared-operation-v1" and
              packet.get("operation") in ("receiver", "observe") and packet.get("revision") is None and
              packet.get("mutating") is False and packet.get("executed") is False, "Expected a read-only preparation packet")
    ship, desk, operation = packet["ship"], packet["desk"], packet["operation"]
    n.require(re.fullmatch(r"~[a-z]+(?:-[a-z]+)*", ship) and re.fullmatch(r"[a-z]+(?:-[a-z0-9]+)*", desk), "Invalid target")
    here = Path(__file__).resolve().parent
    template = "receiver-check.hoon" if operation == "receiver" else "stage.hoon"
    body = read(here / template)
    arguments = f"{ship} %{desk}" + (" %observe 0" if operation == "observe" else "")
    source = f"=/  arg=vase  !>([{arguments}])\n".encode() + body
    n.require(packet.get("source") == "operation.hoon" and packet.get("template") == template and
              packet.get("templateSHA256") == sha(body) and packet.get("sourceSHA256") == sha(source) and
              packet.get("assemblyManifestSHA256") == sha(read(here.parent / "assembly-manifest.json", 4 * 1024 * 1024)) and
              read(packet_dir / "operation.hoon") == source, "Prepared source binding differs")
    plan = json.loads(read(receipt_dir / "plan.json"))
    n.require(plan.get("ship") == ship and plan.get("operation") == "strand" and plan.get("sourceSHA256") == sha(source), "Runner plan differs")
    guarded = ("=/  readymade-transport  (strand ,vase)\n;<  readymade-bowl=bowl  bind:readymade-transport  get-bowl\n"
               f"?>  &(=({ship} our.readymade-bowl) =(our.readymade-bowl src.readymade-bowl))\n").encode() + source
    n.require(read(receipt_dir / "source.hoon") == guarded, "Runner owner guard differs")
    request = read(receipt_dir / "request.newt")
    fields = n.unpack(n.cue_frame(request), 7)
    n.require(fields == [0, n.atom("fyrd"), n.atom("base"), n.atom("khan-eval"), n.atom("noun"), n.atom("ted-eval"), int.from_bytes(guarded, "little")], "Encoded request differs")
    n.require(json.loads(read(receipt_dir / "submitted.json")).get("requestSHA256") == sha(request), "Submitted request digest differs")
    frame = read(receipt_dir / "response.newt", 256 * 1024 * 1024)
    result = json.loads(read(receipt_dir / "result.json"))
    n.require(result.get("status") == "native-success" and result.get("executionSuccess") is True and result.get("responseSHA256") == sha(frame), "Successful response binding missing")
    identity, kind, outcome, mark, payload = n.unpack(n.cue_frame(frame), 5)
    n.require((identity, kind, outcome, mark) == (0, n.atom("avow"), 0, n.atom("noun")), "Native execution did not succeed")
    return {"schema": "readymade-verified-observation-v1", "ship": ship, "desk": desk, "operation": operation,
            "responseSHA256": sha(frame), "sourceSHA256": sha(source), "executionSuccess": True,
            "observation": interpret(payload, operation, desk, receiver_version=2), "currentReadinessVerified": False,
            "writeAuthorized": False, "lockModified": False,
            "scope": "Consistent retained local evidence, not a fresh observation or signed remote attestation"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packet", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    result = verify(args.packet, args.receipt)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
    print("Retained observation verified. Inspect its eligibility/state; no write or lock change authorized.")
