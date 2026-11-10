"""Verify captured-state preservation for one explicitly versioned fresh Readymade activation, offline."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'inspection_comparison', Path(__file__).with_name('compare-inspection.py'))
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)
n = inspection.n


def carrier(app):
    n.require(app[2] == 0 and isinstance(app[3], tuple) and app[3][0] == 20,
              'Unsupported or stopped app carrier')
    fields = n.unpack(app[3][1], 16)
    n.require(fields[0] == n.atom('live'), 'App carrier is not live')
    saved = fields[9]
    n.require(isinstance(saved, tuple) and saved[0] == 1 and isinstance(saved[1], tuple),
              'Unsupported saved vase')
    return fields


def verify(before, after, app_set=n.CURRENT_APP_SET):
    n.require(app_set in n.BACKEND_APP_SETS, "Unknown Readymade app set")
    schema = "readymade-backend-preservation-v2" if app_set == n.CURRENT_APP_SET else "readymade-backend-preservation-v1"
    addition = "freshTenAppAddition" if app_set == n.CURRENT_APP_SET else "freshNineAppAddition"
    a, b = n.snapshot(before), n.snapshot(after)
    am, aa, ad, ar = a
    bm, ba, bd, br = b
    n.require(am[2:5] == bm[2:5] and bm[1] >= am[1], 'Snapshot identity, revision or time mismatch')
    wanted = n.BACKEND_APP_SETS[app_set]
    target = (am[2], n.text(am[3]))
    auxiliaries = {(am[2], name) for name in ('host-viki', 'hot-viki')}
    checks = {
        addition: ba.keys() - aa.keys() == wanted and not (wanted & aa.keys()),
        'noAppsRemoved': aa.keys() <= ba.keys(),
        'allAppsLive': all(app[2] == 0 for app in [*aa.values(), *ba.values()]),
        'newAppOwnersCorrect': wanted <= ba.keys() and all(ba[k][1] == am[3] for k in wanted),
        'sourceCommitExact': am[6] == bm[6],
        'targetActivated': am[5] == n.atom('dead') and bm[5] == n.atom('live'),
        'requiredPriorAppsPresent': {'docket', 'spider', 'hood'} <= aa.keys(),
        'onlyAuxiliaryDesksAdded': bd.keys() - ad.keys() == auxiliaries,
        'noDesksRemoved': ad.keys() <= bd.keys(),
        'otherDesksExact': all(n.equal(ad[k], bd[k]) for k in ad.keys() & bd.keys() if k != target),
    }
    if not checks[addition] or not checks['targetActivated']:
        return {'schema': schema, 'appSet': app_set,
                'scope': 'Refused: snapshots do not describe the selected fresh app set',
                'preservationQualified': False, 'checks': checks, 'remainingChecksRun': False}
    spider = inspection.compare_decoded(a, b)
    checks['spiderInspectionOnly'] = spider['qualifiedInspectionOnly']
    app_checks = {}
    strict = True
    for name in sorted(aa.keys() & ba.keys()):
        old, new = aa[name], ba[name]
        x, y = carrier(old), carrier(new)
        strict = strict and inspection.exact_sequence(old, new)
        identity = inspection.exact_sequence(old[:3], new[:3])
        saved_type = n.equal(x[9][1][0], y[9][1][0])
        saved_data = n.equal(x[9][1][1], y[9][1][1])
        allowed = {4} if name in ('hood', 'docket') else set()
        qualified_data = saved_data
        if name == 'spider':
            qualified_data = spider['qualifiedInspectionOnly']
            allowed = {4, 5, 9}
        protected = all(n.equal(x[i], y[i]) for i in range(16) if i not in allowed)
        app_checks[name] = {'identityExact': identity, 'savedTypeExact': saved_type,
                           'strictSavedDataEqual': saved_data, 'declaredDataChangeOnly': qualified_data,
                           'protectedCarrierFieldsExact': protected,
                           'statisticsEqual': n.equal(x[4], y[4])}
    checks['allPriorAppsPreserved'] = all(
        all(row[k] for k in ('identityExact', 'savedTypeExact', 'declaredDataChangeOnly',
                            'protectedCarrierFieldsExact')) for row in app_checks.values())
    checks['newCarriersRecognized'] = wanted <= ba.keys() and all(carrier(ba[k]) is not None for k in wanted)
    checks['targetDeskOnlyLiveChanged'] = False
    if target in ad and target in bd:
        old, new = n.unpack(ad[target], 9), n.unpack(bd[target], 9)
        checks['targetDeskOnlyLiveChanged'] = (
            old[0] == new[0] == am[4] and old[7] == n.atom('dead') and new[7] == n.atom('live')
            and all(n.equal(old[i], new[i]) for i in range(9) if i != 7)
            and inspection.mapping(old[1]).get(am[4]) == am[6])
    # Native *dome:clay from the supported Kelvin-408 receiver. Do not accept
    # arbitrary empty-looking desks or pre-existing override authority.
    empty_dome = (0, (0, (0, (0, ((0, 0), (0, (0, (n.atom('dead'), 0))))))))
    checks['auxiliaryDesksNativeDefault'] = all(
        key not in ad and key in bd and n.equal(bd[key], empty_dome) for key in auxiliaries)
    checks['noPreexistingOverrides'] = not any(
        (am[2], name) in ad for name in ('glass-desktop-build', 'host-law', 'host-viki', 'hot-viki'))
    # Match complete route rows, including ducts; no normalization of old bindings.
    unmatched = list(br)
    for old in ar:
        for index, new in enumerate(unmatched):
            if n.equal(old, new):
                unmatched.pop(index)
                break
        else:
            break
    else:
        checks['originalHTTPBindingsExact'] = True
    checks.setdefault('originalHTTPBindingsExact', False)
    routes = {'/graf': 'graf', '/apps/qpc-ark': 'viki',
              '/apps/pataphor-cli': 'cli-inference',
              '/apps/readymade-collab': 'readymade-collab',
              '/apps/pataphor-native': 'pataphor-native-console',
              '/apps/pataphor': 'pataphor-page'}
    if app_set == n.CURRENT_APP_SET:
        routes["/apps/readymade-editing"] = "readymade-editing"
    expected = []
    for path, app in routes.items():
        parts = 0
        for part in reversed(path.strip('/').split('/')):
            parts = (n.atom(part), parts)
        expected.append(((0, parts), (n.atom('app'), n.atom(app))))
    for row in unmatched:
        binding, _, action = n.unpack(row, 3)
        for index, candidate in enumerate(expected):
            if n.equal((binding, action), candidate):
                expected.pop(index)
                break
        else:
            break
    else:
        checks['onlyExpectedRoutesAdded'] = not expected
    checks.setdefault('onlyExpectedRoutesAdded', False)
    return {'schema': schema, 'appSet': app_set,
            'scope': 'Captured-state preservation only; compilation, native initialization and HTTP/coding acceptance required',
            'preservationQualified': all(checks.values()), 'checks': checks,
            'priorApps': app_checks, 'inspection': spider,
            'strictPriorCarrierEquality': strict and checks['noAppsRemoved']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', type=Path, required=True)
    parser.add_argument('--after', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--app-set', choices=tuple(n.BACKEND_APP_SETS), default=n.CURRENT_APP_SET)
    args = parser.parse_args()
    n.require(not args.output.exists() and not args.output.is_symlink(), 'Output already exists')
    before, after = n.read_frame(args.before), n.read_frame(args.after)
    result = verify(before, after, args.app_set)
    result.update(beforeSHA256=hashlib.sha256(before).hexdigest(), afterSHA256=hashlib.sha256(after).hexdigest())
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    print('Preservation report retained privately; remaining installation checks still apply.')
    return 0 if result['preservationQualified'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
