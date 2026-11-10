"""Account only for snapshot-owned Spider inspection records; never approve an install."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'snapshot_comparison', Path(__file__).with_name('compare-snapshots.py'))
n = importlib.util.module_from_spec(spec)
spec.loader.exec_module(n)


def mapping(noun):
    result = {}
    for key, value in n.tree(noun):
        n.require(key not in result, 'Duplicate native map key')
        result[key] = value
    return result


def exact_maps(left, right):
    return left.keys() == right.keys() and all(n.equal(left[k], right[k]) for k in left)


def exact_sequence(left, right):
    return len(left) == len(right) and all(n.equal(a, b) for a, b in zip(left, right))


def observer(snapshot):
    meta, apps, _, _ = snapshot
    n.require(meta[10] is not None, 'Snapshot has no bound observer identity')
    identity = n.atom(meta[10])
    n.require('spider' in apps, 'Snapshot has no Spider carrier')
    app = apps['spider']
    n.require(app[2] == 0 and isinstance(app[3], tuple) and app[3][0] == 20,
              'Unsupported or stopped Spider carrier')
    fields = n.unpack(app[3][1], 16)
    n.require(fields[0] == n.atom('live'), 'Spider carrier is not live')
    saved = fields[9]
    n.require(isinstance(saved, tuple) and saved[0] == 1 and isinstance(saved[1], tuple),
              'Unsupported Spider saved vase')
    state = n.unpack(saved[1][1], 6)
    n.require(state[0] == 8, 'Unsupported Spider saved-state version')
    tids, serving, watches = mapping(state[3]), mapping(state[4]), mapping(fields[5])

    def watch(thread):
        found = []
        for duct, binding in watches.items():
            owner, path = n.unpack(binding, 2)
            if list(n.rows(path)) == [n.atom('thread-result'), thread]:
                n.require(owner == meta[2], 'Foreign observer result watch')
                found.append(duct)
        n.require(len(found) == 1, 'Missing or ambiguous observer result watch')
        return found[0]

    inner_watch = watch(identity)
    duct = list(n.rows(inner_watch))
    n.require(len(duct) >= 2, 'Malformed observer duct')
    link = list(n.rows(duct[1]))
    n.require(len(link) == 9 and link[:3] == [n.atom(x) for x in ('gall', 'use', 'spider')]
              and link[5] == n.atom('thread')
              and link[7:] == [n.atom('test'), n.atom('wire')], 'Unrecognized observer caller')
    outer = link[6]
    n.require(outer != identity, 'Observer cannot call itself')
    outer_watch = watch(outer)
    parent_duct = list(n.rows(outer_watch))
    n.require(len(parent_duct) >= 2 and n.equal(parent_duct[0], duct[0]),
              'Observer Khan routes differ')
    parent = list(n.rows(parent_duct[1]))
    n.require(len(parent) == 6 and parent[:2] == [n.atom('khan'), n.atom('fyrd')]
              and parent[2] == link[4] and parent[3] == n.atom('base')
              and parent[5] == n.atom('noun'), 'Unrecognized outer observer request')
    running = list(n.rows(state[2]))
    ids = {identity, outer}
    for thread in ids:
        yarn = (thread, 0)
        n.require(thread in tids and n.equal(tids[thread], yarn), 'Observer thread record mismatch')
        n.require(thread in serving and n.equal(serving[thread], (0, (n.atom('noun'), n.atom('base')))),
                  'Observer serving record mismatch')
        n.require(sum(n.equal(row, yarn) for row in running) == 1, 'Observer running record mismatch')
    return {'app': app, 'fields': fields, 'state': state, 'ids': ids,
            'tids': {k: v for k, v in tids.items() if k not in ids},
            'serving': {k: v for k, v in serving.items() if k not in ids},
            'running': [row for row in running if not any(n.equal(row, (i, 0)) for i in ids)],
            'watches': {k: v for k, v in watches.items() if k not in (inner_watch, outer_watch)}}


def compare(before, after):
    return compare_decoded(n.snapshot(before), n.snapshot(after))


def compare_decoded(a, b):
    n.require(a[0][2:5] == b[0][2:5], 'Snapshot identity, desk or revision differs')
    n.require(b[0][1] >= a[0][1], 'Snapshot time moved backwards')
    x, y = observer(a), observer(b)
    checks = {
        'distinctObserverPairs': not (x['ids'] & y['ids']),
        'appIdentityExact': exact_sequence(x['app'][:3], y['app'][:3]),
        'savedTypeExact': n.equal(x['fields'][9][1][0], y['fields'][9][1][0]),
        'protectedCarrierFieldsExact': all(n.equal(x['fields'][i], y['fields'][i])
                                           for i in range(16) if i not in (4, 5, 9)),
        'versionStartingScryingExact': all(n.equal(x['state'][i], y['state'][i]) for i in (0, 1, 5)),
        'otherThreadRecordsExact': exact_maps(x['tids'], y['tids']),
        'otherServingRecordsExact': exact_maps(x['serving'], y['serving']),
        'otherRunningRecordsExact': exact_sequence(x['running'], y['running']),
        'otherResultWatchesExact': exact_maps(x['watches'], y['watches']),
    }
    return {'schema': 'readymade-inspection-comparison-v1',
            'scope': 'Spider inspection records only; not whole-installation preservation',
            'qualifiedInspectionOnly': all(checks.values()), 'checks': checks,
            'beforeObservers': sorted(n.text(i) for i in x['ids']),
            'afterObservers': sorted(n.text(i) for i in y['ids']),
            'strictSpiderCarrierEqual': exact_sequence(x['app'], y['app']),
            'strictSavedDataEqual': n.equal(x['fields'][9][1][1], y['fields'][9][1][1]),
            'statisticsEqual': n.equal(x['fields'][4], y['fields'][4])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', type=Path, required=True)
    parser.add_argument('--after', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    n.require(not args.output.exists() and not args.output.is_symlink(), 'Output already exists')
    before, after = n.read_frame(args.before), n.read_frame(args.after)
    result = compare(before, after)
    result.update(beforeSHA256=hashlib.sha256(before).hexdigest(),
                  afterSHA256=hashlib.sha256(after).hexdigest())
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    print('Private Spider comparison retained; whole-installation preservation remains separate.')
    return 0 if result['qualifiedInspectionOnly'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
