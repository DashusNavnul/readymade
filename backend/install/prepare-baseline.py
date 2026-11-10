"""Prepare owner-bound source-baseline strands without contacting a ship."""
import argparse
import hashlib
import json
import re
from pathlib import Path


def uv(value):
    digits = ''
    while value:
        digits = '0123456789abcdefghijklmnopqrstuv'[value % 32] + digits
        value //= 32
    digits = digits or '0'
    first = len(digits) % 5 or 5
    return '0v' + '.'.join([digits[:first]] + [digits[i:i+5] for i in range(first, len(digits), 5)])


def prepare(ship, desk, output, revision=None, root=None):
    if not isinstance(ship, str) or not re.fullmatch(r'~[a-z]+(?:-[a-z]+)*', ship):
        raise ValueError('Expected receiving ship; native owner guard validates identity')
    if (not isinstance(desk, str) or not re.fullmatch(r'[a-z]+(?:-[a-z0-9]+)*', desk)
            or desk in ('base', 'readymade', 'noltbook-data', 'host-law', 'host-viki', 'hot-viki', 'glass-desktop-build')):
        raise ValueError('Expected a fresh source desk, not a system or app desk')
    if (revision is None) != (root is None):
        raise ValueError('Supply both observed base revision and root, or neither')
    if revision is not None and (type(revision) is not int or not 1 <= revision <= 2**31
                                or not isinstance(root, str) or not re.fullmatch(r'[0-9a-f]{1,64}', root)):
        raise ValueError('Expected positive observed revision and hexadecimal native root')
    output = output.absolute()
    if any(p.is_symlink() for p in [output, *output.parents]):
        raise ValueError('Linked output refused')
    if output.exists() or not output.parent.is_dir():
        raise ValueError('Choose a new output directory with an existing parent')
    template = Path(__file__).with_name('source-baseline.hoon').read_text()
    files = {'00-basis.hoon': f'=/  arg=vase  !>([{ship} %{desk} %basis 0 0v0])\n' + template}
    if revision is not None:
        native_revision = format(revision, ',').replace(',', '.')
        for index, action in enumerate(('isolate', 'clone', 'verify'), 1):
            files[f'{index:02d}-{action}.hoon'] = (
                f'=/  arg=vase  !>([{ship} %{desk} %{action} {native_revision} {uv(int(root, 16))}])\n' + template)
    def digest(data):
        return hashlib.sha256(data).hexdigest()
    packet = {'schema': 'readymade-source-baseline-packet-v1', 'ship': ship, 'desk': desk,
              'baseRevision': revision, 'baseRoot': root,
              'scope': 'Prepared only; observe actual base pins and execute each authorized operation separately',
              'templateSHA256': digest(template.encode()),
              'files': {name: digest(text.encode()) for name, text in files.items()}}
    output.mkdir(mode=0o700)
    for name, text in files.items():
        with (output / name).open('x') as stream:
            stream.write(text)
    with (output / 'packet.json').open('x') as stream:
        json.dump(packet, stream, indent=2)
        stream.write('\n')
    return packet


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ship', required=True)
    parser.add_argument('--desk', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--base-revision', type=int)
    parser.add_argument('--base-root')
    args = parser.parse_args()
    prepare(args.ship, args.desk, args.output, args.base_revision, args.base_root)
    print('Prepared source-baseline artifacts; no native operation submitted.')


if __name__ == '__main__':
    main()
