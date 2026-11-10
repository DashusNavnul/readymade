"""One-shot reconstruction verifier; never installs or executes package code."""

import argparse
import base64
import hashlib
import io
import json
import tarfile
import urllib.request
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def reconstruct(archive, manifest, license_bytes):
    require(digest(archive) == manifest['tarballSHA256'], 'Archive SHA256 mismatch')
    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(archive).digest()).decode()
    require(integrity == manifest['integrity'], 'Archive integrity mismatch')
    result = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
        def read(name):
            member = package.getmember(name)
            require(member.isfile() and member.size < 5_000_000, 'Invalid package member')
            return package.extractfile(member).read()

        license_data = read('package/LICENSE')
        require(license_data == license_bytes and digest(license_data) == manifest['licenseSHA256'], 'License mismatch')
        metadata = json.loads(read('package/package.json'))
        require(metadata['name'] == manifest['name'] and metadata['version'] == manifest['version'], 'Package identity mismatch')
        require(metadata.get('dependencies', {}) == manifest['runtimeDependencies'], 'Runtime dependencies changed')
        header = ('/*! Vendored {name} {version}; commit {gitHead}\n'.format(**manifest)).encode() + license_data + b'\n*/\n'
        for path, entry in manifest['files'].items():
            require(path in ('ui/xterm.js', 'ui/xterm.css'), 'Unexpected output path')
            original = read(entry['archivePath'])
            require(digest(original) == entry['upstreamSHA256'], 'Upstream file mismatch')
            suffix = entry['removedSuffix'].encode()
            require(not suffix or original.endswith(suffix), 'Source-map suffix mismatch')
            output = header + (original[:-len(suffix)] if suffix else original)
            require(len(output) == entry['bytes'] and digest(output) == entry['sha256'], 'Reconstructed file mismatch')
            result[path] = output
    require(set(result) == {'ui/xterm.js', 'ui/xterm.css'}, 'Incomplete file set')
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    require(not args.output.exists(), 'Output already exists; preserve prior results')
    root = Path(__file__).resolve().parent
    manifest = json.loads((root / 'manifest.json').read_text())
    if args.archive:
        archive = args.archive.read_bytes()
    else:
        require(manifest['tarball'].startswith('https://registry.npmjs.org/@xterm/xterm/-/'), 'Unexpected registry URL')
        with urllib.request.urlopen(manifest['tarball'], timeout=30) as response:
            archive = response.read(10_000_001)
        require(len(archive) <= 10_000_000, 'Archive too large')
    files = reconstruct(archive, manifest, (root / 'LICENSE.txt').read_bytes())
    args.output.mkdir()
    (args.output / 'ui').mkdir()
    for name, data in files.items():
        with (args.output / name).open('xb') as target:
            target.write(data)
    print(json.dumps({'passed': True, 'files': {name: digest(data) for name, data in files.items()}}, indent=2))


if __name__ == '__main__':
    main()
