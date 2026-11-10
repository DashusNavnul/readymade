"""Stage pinned Noltbook files over a fresh inactive base clone; never commit."""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import tempfile

spec = importlib.util.spec_from_file_location(
    'mount_stage', Path(__file__).parent.parent / 'install/stage-files.py')
staging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(staging)


receipt_spec = importlib.util.spec_from_file_location(
    "noltbook_reconstruction", Path(__file__).with_name("reconstruct.py"))
reconstruction = importlib.util.module_from_spec(receipt_spec)
receipt_spec.loader.exec_module(reconstruction)

def stage_source(source, mount, receipt, readymade_media=False, manifest=None, overlay=None, document_receipts=False):
    if document_receipts and not readymade_media:
        raise ValueError('Document receipts require readymade media')
    here = Path(__file__).parent
    manifest = copy.deepcopy(manifest or json.loads((here / 'manifest.json').read_text()))
    if readymade_media:
        overlay = overlay or json.loads((here / 'media-overlay.json').read_text())
        name = 'lib/noltbook/index.html'
        if (overlay['schema'] != 'readymade-noltbook-media-overlay-v1'
                or overlay['path'] != name or overlay['upstreamCommit'] != manifest['commit']
                or overlay['inputSha256'] != manifest['files'][name]['sha256']):
            raise ValueError('Media overlay does not bind the pinned source')
        manifest['files'][name].update(bytes=overlay['outputBytes'], sha256=overlay['outputSha256'])
    if document_receipts:
        manifest = reconstruction.document_receipts_manifest(manifest)
    paths = [path.absolute() for path in (source, mount, receipt)]
    for path in paths:
        if any(part.is_symlink() for part in [path, *path.parents]):
            raise ValueError('Linked staging path refused')
    for i, left in enumerate(paths):
        if any(left == right or left in right.parents or right in left.parents for right in paths[i + 1:]):
            raise ValueError('Source, mount and receipt must be disjoint')
    source, mount, receipt = paths
    if receipt.exists() or not receipt.parent.is_dir():
        raise ValueError('Choose a new receipt with an existing parent')
    incoming, incoming_dirs = staging.inventory(source)
    pins = manifest['files']
    expected_dirs = {str(parent) for name in pins for parent in Path(name).parents if str(parent) != '.'}
    if incoming.keys() != pins.keys() or incoming_dirs != expected_dirs:
        raise ValueError('Source paths differ from the pinned component')
    for name, data in incoming.items():
        if len(data) != pins[name]['bytes'] or staging.digest(data) != pins[name]['sha256']:
            raise ValueError('Source bytes differ from the pinned component: ' + name)
    previous, previous_dirs = staging.inventory(mount)
    for name in ('sys/hoon.hoon', 'sys/zuse.hoon', 'sys/lull.hoon', 'sys/vane/clay.hoon'):
        if not previous.get(name):
            raise ValueError('Fresh base clone exports required: ' + name)
    if any(name in previous for name in ('app/noltbook.hoon', 'app/noltbook-calls.hoon')):
        raise ValueError('Noltbook source already present; inspect the prior attempt')
    merged = {**previous, **incoming}
    plan = {'schema': 'readymade-backend-assembly-v1',
            'files': {name: {'bytes': len(data), 'sha256': staging.digest(data)}
                      for name, data in merged.items()}}
    with tempfile.TemporaryDirectory(prefix='readymade-noltbook-stage-') as temporary:
        prepared = Path(temporary).resolve()
        for name, data in merged.items():
            target = prepared / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        if staging.inventory(mount) != (previous, previous_dirs):
            raise ValueError('Mount changed during preparation; no staging submitted')
        return staging.stage(plan, prepared, mount, receipt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'mount', 'receipt'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--readymade-media', action='store_true')
    parser.add_argument('--document-receipts', action='store_true')
    args = parser.parse_args()
    count = stage_source(args.source, args.mount, args.receipt, args.readymade_media, document_receipts=args.document_receipts)
    print(f'Verified {count} staged files; native ownership, commit and compilation remain separate.')


if __name__ == '__main__':
    main()
