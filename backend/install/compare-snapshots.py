"""Bounded offline snapshot comparison. Reports differences; never approves a load."""
import argparse
import hashlib
import json
import os
from pathlib import Path


LEGACY_APP_SET = 'readymade-backend-nine-apps-v1'
CURRENT_APP_SET = 'readymade-backend-ten-apps-v2'
LEGACY_APPS = frozenset({'graf', 'cantrip', 'viki', 'cli-inference', 'multiplayer-runtime',
                       'readymade-collab', 'native-coding-source-import',
                       'pataphor-native-console', 'pataphor-page'})
BACKEND_APP_SETS = {LEGACY_APP_SET: LEGACY_APPS,
                    CURRENT_APP_SET: LEGACY_APPS | {'readymade-editing'}}


def require(value, message):
    if not value:
        raise ValueError(message)


def atom(text):
    return int.from_bytes(text.encode(), 'little')


def unpack(noun, size):
    result = []
    for _ in range(size - 1):
        require(isinstance(noun, tuple), 'Malformed native tuple')
        result.append(noun[0])
        noun = noun[1]
    return result + [noun]


def equal(left, right):
    pending, seen = [(left, right)], set()
    while pending:
        a, b = pending.pop()
        if a is b:
            continue
        if isinstance(a, tuple) != isinstance(b, tuple):
            return False
        if isinstance(a, tuple):
            key = (id(a), id(b))
            if key not in seen:
                seen.add(key)
                pending.extend(zip(a, b))
        elif a != b:
            return False
    return True


# 64 million: a fresh ship measured 4.27M nodes before activation and 16.29M after the ten apps
# started (67 MB). The earlier 16M bound refused that real after-snapshot by 1.8%.
def cue_frame(frame, max_nodes=64000000):
    require(len(frame) >= 6 and frame[0] == 0 and
            int.from_bytes(frame[1:5], 'little') == len(frame) - 5, 'Invalid native frame')
    data, cursor, memo, stack = frame[5:], 0, {}, []

    def bits(count):
        nonlocal cursor
        require(0 <= count and cursor + count <= len(data) * 8, 'Truncated jam')
        start, offset = divmod(cursor, 8)
        value = int.from_bytes(data[start:(cursor + count + 7) // 8], 'little') >> offset
        cursor += count
        return value & ((1 << count) - 1)

    def mat():
        width = 0
        while bits(1) == 0:
            width += 1
            require(width < 32, 'Atom width exceeds input bound')
        if not width:
            return 0
        return bits((1 << (width - 1)) + bits(width - 1))

    while True:
        require(len(memo) + len(stack) <= max_nodes, 'Noun node limit exceeded')
        position = cursor
        if bits(1) == 0:
            noun = mat()
            memo[position] = noun
        elif bits(1) == 0:
            stack.append([position, None])
            continue
        else:
            reference = mat()
            require(reference in memo, 'Invalid jam reference')
            noun = memo[reference]
        while stack and stack[-1][1] is not None:
            position, first = stack.pop()
            noun = (first, noun)
            memo[position] = noun
        if not stack:
            remaining = len(data) * 8 - cursor
            require(remaining < 8 and bits(remaining) == 0, 'Trailing jam data')
            return noun
        stack[-1][1] = noun


def rows(noun):
    count = 0
    while isinstance(noun, tuple):
        count += 1
        require(count <= 100000, 'Collection limit exceeded')
        yield noun[0]
        noun = noun[1]
    require(noun == 0, 'Malformed native list')


def tree(noun):
    pending, count = [noun], 0
    while pending:
        item = pending.pop()
        if item == 0:
            continue
        count += 1
        require(count <= 100000, 'Map limit exceeded')
        value, left, right = unpack(item, 3)
        yield value
        pending.extend([left, right])


def text(value):
    require(isinstance(value, int) and value.bit_length() <= 2048, 'Invalid native name')
    return value.to_bytes((value.bit_length() + 7) // 8, 'little').decode('utf-8')


def snapshot(frame):
    outer = unpack(cue_frame(frame), 5)
    require(outer[:4] == [0, atom('avow'), 0, atom('noun')], 'Native result did not succeed')
    value = outer[4]
    if isinstance(value, tuple) and value[0] in (
            atom('readymade-activation-submitted-v1'), atom('readymade-activation-prepared-v1'),
            atom('readymade-activation-submitted-v2'), atom('readymade-activation-prepared-v2')):
        value = value[1]
    observer = None
    if isinstance(value, tuple) and value[0] == atom('readymade-observed-install-snapshot-v1'):
        _, identity, value = unpack(value, 3)
        observer = text(identity)
        require(bool(observer), 'Empty snapshot observer identity')
    s = unpack(value, 10)
    require(s[0] == atom('readymade-private-install-snapshot-v1'), 'Wrong snapshot schema')
    apps = {}
    for row in rows(s[7]):
        name, nonce, owner, live, carrier = unpack(row, 5)
        name = text(name)
        require(name not in apps and live in (0, 1), 'Invalid or duplicate app')
        apps[name] = [nonce, owner, live, carrier]
    desks = {}
    for entry in tree(s[8]):
        key, value = unpack(entry, 2)
        owner, desk = unpack(key, 2)
        key = (owner, text(desk))
        require(key not in desks, 'Duplicate native desk')
        desks[key] = value
    return s + [observer], apps, desks, list(rows(s[9]))


def named_map_delta(left, right):
    def entries(noun):
        result = {}
        for row in tree(noun):
            key, value = unpack(row, 2)
            name = text(key)
            require(name not in result, 'Duplicate named map key')
            result[name] = value
        return result
    a, b = entries(left), entries(right)
    return {'removed': sorted(a.keys() - b.keys()), 'added': sorted(b.keys() - a.keys()),
            'changedShared': sorted(k for k in a.keys() & b.keys() if not equal(a[k], b[k]))}


def carrier_detail(name, old, new):
    fields = ['tag', 'control-duct', 'run-nonce', 'sub-nonce', 'stats', 'bitt',
              'boat', 'boar', 'code', 'old-state', 'beak', 'marks', 'sky', 'ken', 'pen', 'gem']
    result = {'changedFields': [f for f, x, y in zip(fields, old, new) if not equal(x, y)]}
    if 'bitt' in result['changedFields']:
        left, right = dict(tree(old[5])), dict(tree(new[5]))
        result['bitt'] = {'removed': len(left.keys() - right.keys()),
                          'added': len(right.keys() - left.keys()),
                          'changedShared': sum(not equal(left[k], right[k])
                                               for k in left.keys() & right.keys())}
    a, b = old[9], new[9]
    # Kelvin-408 Gall egg.old-state is [%| vase], not (unit vase).
    if not (isinstance(a, tuple) and isinstance(b, tuple) and a[0] == b[0] == 1
            and isinstance(a[1], tuple) and isinstance(b[1], tuple)):
        result['savedVaseRecognized'] = False
        return result
    result.update(savedVaseRecognized=True, savedTypeEqual=equal(a[1][0], b[1][0]),
                  savedDataEqual=equal(a[1][1], b[1][1]))
    if name == 'docket':
        try:
            x, y = unpack(a[1][1], 2), unpack(b[1][1], 2)
            require(x[0] == y[0] == 6, 'Unsupported Docket saved-state version')
            result['docket'] = named_map_delta(x[1], y[1])
        except (ValueError, UnicodeDecodeError) as error:
            result['docket'] = {'unrecognized': str(error)}
    if name == 'spider' and not equal(a, b):
        # Diagnostic only: neither inspection-looking names nor unchanged
        # shared records authorize discarding these actual state differences.
        try:
            x, y = unpack(a[1][1], 6), unpack(b[1][1], 6)
            def running(noun):
                return sorted(tuple(text(n) for n in rows(row)) for row in rows(noun))
            result['spider'] = {
                'exactFields': {key: equal(x[i], y[i]) for key, i in
                                [('version', 0), ('starting', 1), ('scrying', 5)]},
                'tid': named_map_delta(x[3], y[3]),
                'serving': named_map_delta(x[4], y[4]),
                'runningBefore': running(x[2]), 'runningAfter': running(y[2])}
        except (ValueError, UnicodeDecodeError) as error:
            result['spider'] = {'unrecognized': str(error)}
    return result


def compare(before, after, component='readymade', app_set=CURRENT_APP_SET):
    require(app_set in BACKEND_APP_SETS, 'Unknown Readymade app set')
    require(component in ('readymade', 'noltbook'), 'Unknown installation component')
    a, aa, ad, ar = snapshot(before)
    b, ba, bd, br = snapshot(after)
    require(a[2:5] == b[2:5], 'Snapshot owner, target or revision mismatch')
    require(b[1] >= a[1], 'Snapshot time moved backwards')
    backend_apps = BACKEND_APP_SETS[app_set]
    wanted = backend_apps if component == 'readymade' else {'noltbook', 'noltbook-calls'}
    changes, saved, details = {}, {}, {}
    for name in sorted(aa.keys() & ba.keys()):
        old, new = aa[name], ba[name]
        fields = [k for k, x, y in zip(['nonce', 'owner', 'live', 'carrier'], old, new) if not equal(x, y)]
        if fields:
            changes[name] = fields
        # Only this known native carrier layout admits old-state extraction.
        if (isinstance(old[3], tuple) and isinstance(new[3], tuple)
                and old[3][0] == new[3][0] == 20):
            oe, ne = unpack(old[3][1], 16), unpack(new[3][1], 16)
            if oe[0] == ne[0] == atom('live'):
                saved[name] = equal(oe[9], ne[9])
                details[name] = carrier_detail(name, oe, ne)
    changed_desks = [{'ownerNumber': str(key[0]), 'desk': key[1]}
                     for key in sorted(ad.keys() & bd.keys()) if not equal(ad[key], bd[key])]
    added_routes = [r for r in br if not any(equal(r, old) for old in ar)]
    desk_fields = ['let', 'hit', 'lab', 'tom', 'nor', 'mim', 'wic', 'liv', 'ren']
    desk_details = [{'ownerNumber': str(key[0]), 'desk': key[1],
                     'changedFields': [f for f, x, y in zip(desk_fields, unpack(ad[key], 9),
                                                          unpack(bd[key], 9)) if not equal(x, y)]}
                    for key in sorted(ad.keys() & bd.keys()) if not equal(ad[key], bd[key])]
    added_desk_details = []
    for key in sorted(bd.keys() - ad.keys()):
        values = unpack(bd[key], 9)
        added_desk_details.append({'ownerNumber': str(key[0]), 'desk': key[1],
                                  'revision': values[0], 'live': text(values[7]),
                                  'nonemptyFields': [f for f, v in zip(desk_fields, values) if v != 0]})
    route_details = []
    for route in added_routes:
        binding, _, action = unpack(route, 3)
        if isinstance(binding, tuple) and binding[0] == 0 and isinstance(action, tuple) and action[0] == atom('app'):
            route_details.append({'path': '/' + '/'.join(text(p) for p in rows(binding[1])),
                                  'app': text(action[1])})
        else:
            route_details.append({'unrecognized': True})
    return {'schema': 'readymade-install-comparison-v2',
            'appSet': app_set if component == 'readymade' else 'noltbook-two-apps-v1', 'ownerNumber': str(a[2]),
            'desk': text(a[3]), 'revision': a[4], 'beforeApps': len(aa), 'afterApps': len(ba),
            'addedApps': sorted(ba.keys() - aa.keys()), 'removedApps': sorted(aa.keys() - ba.keys()),
            'component': component, 'expectedApps': sorted(wanted),
            'observerThreads': {'before': a[10], 'after': b[10]},
            'expectedAppsAdded': ba.keys() - aa.keys() == wanted,
            'expectedNineAppsAdded': ba.keys() - aa.keys() == LEGACY_APPS,
            'newOwnersCorrect': wanted <= ba.keys() and all(ba[n][1] == a[3] for n in wanted),
            'allAfterAppsLive': all(v[2] == 0 for v in ba.values()),
            'sourceCommitEqual': a[6] == b[6], 'targetLive': b[5] == atom('live'),
            'changedExistingApps': changes, 'savedStateEquality': saved,
            'carrierDetails': details, 'deskDetails': desk_details,
            'docketRegistrationOnly': (
                details.get('docket', {}).get('savedTypeEqual', False) and
                details.get('docket', {}).get('docket') ==
                {'removed': [], 'added': [text(a[3])], 'changedShared': []}),
            'addedDeskDetails': added_desk_details, 'addedRouteDetails': route_details,
            'unrecognizedSavedStateApps': sorted(aa.keys() & ba.keys() - saved.keys()),
            'strictWholeCarrierEquality': not changes and not (aa.keys() - ba.keys()),
            'changedDesks': changed_desks,
            'removedDesks': [{'ownerNumber': str(k[0]), 'desk': k[1]} for k in sorted(ad.keys() - bd.keys())],
            'addedDesks': [{'ownerNumber': str(k[0]), 'desk': k[1]} for k in sorted(bd.keys() - ad.keys())],
            'allOriginalRoutesRetained': all(any(equal(r, new) for new in br) for r in ar),
            'addedRouteCount': len(added_routes),
            'verdict': 'comparison-only; inspect every difference and required installation gate'}


def read_frame(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        import stat
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_size <= 256 * 1024 * 1024,
                'Snapshot must be a bounded regular file')
        with os.fdopen(fd, 'rb', closefd=False) as source:
            return source.read(256 * 1024 * 1024 + 1)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', type=Path, required=True)
    parser.add_argument('--after', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--component', choices=('readymade', 'noltbook'), default='readymade')
    parser.add_argument('--app-set', choices=tuple(BACKEND_APP_SETS), default=CURRENT_APP_SET)
    args = parser.parse_args()
    require(not args.output.exists() and not args.output.is_symlink(), 'Output already exists')
    before, after = read_frame(args.before), read_frame(args.after)
    result = compare(before, after, args.component, args.app_set)
    result['beforeSHA256'] = hashlib.sha256(before).hexdigest()
    result['afterSHA256'] = hashlib.sha256(after).hexdigest()
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(result, output, indent=2)
        output.write('\n')
    print('Comparison retained privately; this is not an installation or preservation approval.')


if __name__ == '__main__':
    main()
