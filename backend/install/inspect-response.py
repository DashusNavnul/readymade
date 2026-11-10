"""Inspect a retained native result offline; never contact a ship or release a lock."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat

spec = importlib.util.spec_from_file_location('native_frame', Path(__file__).with_name('compare-snapshots.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
MAX_BYTES = 256 * 1024 * 1024


def inspect(frame, max_nodes=16000000):
    native.require(6 <= len(frame) <= MAX_BYTES, 'Native frame exceeds byte limit')
    request, kind, payload = native.unpack(native.cue_frame(frame, max_nodes), 3)
    native.require(request == 0, 'Unexpected response identifier')
    failure = None
    if kind == native.atom('bail'):
        head, tail = native.unpack(payload, 2)
        codes = []
        if isinstance(head, int):
            # Connection-driver error: [error-code error-string].
            native.require(isinstance(tail, int), 'Malformed driver failure')
            codes.append(head)
        else:
            # Failed native event: a nonempty list of [code trace] goofs.
            remaining = payload
            while remaining != 0:
                entry, remaining = native.unpack(remaining, 2)
                code, _ = native.unpack(entry, 2)
                native.require(isinstance(code, int), 'Malformed runtime failure')
                codes.append(code)
        outcome = 1
        description = 'runtime-failure'
        failure = 'memory-exhaustion' if native.atom('meme') in codes else 'native-bail'
    else:
        native.require(kind == native.atom('avow'), 'Unexpected response kind')
        outcome, mark, _ = native.unpack(payload, 3)
        native.require((outcome, mark) in ((0, native.atom('noun')), (1, native.atom('thread-fail'))),
                       'Unrecognized native outcome')
        description = 'success' if outcome == 0 else 'thread-failure'
    result = {'schema': 'readymade-offline-native-response-v1',
            'responseSHA256': hashlib.sha256(frame).hexdigest(), 'responseBytes': len(frame),
            'nativeOutcome': description,
            'executionSuccess': outcome == 0, 'operationSemanticsVerified': False,
            'identityVerified': False, 'lockModified': False, 'replayAuthorized': False,
            'scope': 'Retained response only; verify receipt provenance and operation-specific checks separately'}
    if failure:
        result['failureReason'] = failure
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--response', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    # Refuse special files and links before reading, then recheck the opened file.
    before = args.response.lstat()
    native.require(stat.S_ISREG(before.st_mode), 'Response must be a regular non-symlink file')
    native.require(6 <= before.st_size <= MAX_BYTES, 'Native frame exceeds byte limit')
    fd = os.open(args.response, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        native.require((before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino), 'Response changed before reading')
        frame = stream.read(MAX_BYTES + 1)
        after = os.fstat(stream.fileno())
    native.require((opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) ==
                   (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'Response changed during reading')
    result = inspect(frame)
    output = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(output, 'w') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    print('Offline response inspected; operation semantics and lock remain unchanged.')


if __name__ == '__main__':
    main()
