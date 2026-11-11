# Readymade application source

`source.tar.gz` contains 943 application files and the Readymade MIT license.
It is source code, including Hoon apps and libraries, browser presentation code,
the native connector source carrier, marks, threads and the ten-app desk bill.
It includes the explicit owner Apply command for approved candidates; Cantrip
rechecks the native decision, grant and source before landing.
It also includes explicit owner-reviewed completion replies to the originating group, with retained one-attempt outcomes and no automatic execution.
The source includes complete request-attributed file changes and native check reports
for owner-reviewed replies. The full app and original proofs compile natively; a
read-only rehearsal also preserves the existing app's complete captured v9 DATA
and reload behavior. Live installation, endpoint checks and a real result reply
remain required before release acceptance.
It contains no saved ship state. The archive is about 2 MB; extract it to inspect,
search or modify the individual files.

## Rebuilding it for a release

Every release rebuilds the archive from the Pataphor repository's HEAD commit:

```sh
npm run bundle:backend -- --pataphor /path/to/pataphor          # rebuild; prints what changed
npm run bundle:backend -- --pataphor /path/to/pataphor --check  # exit 1 if the archive is stale
```

`rebuild.py` reads committed bytes only, keeps every application file, adds any file those now
import and the files the guest-desk manifest names, and stops if the collaboration agent imports
a file that manifest does not list. It writes the archive, the pins in `../assembly-manifest.json`,
the hash in `extract.py`, the count above, and `source.json`: the Pataphor commit and the archive
hash this package carries. A test checks those four agree.

From the repository root, with Python 3.9+:

```sh
python3 backend/application/extract.py /your/path/application-source
```

The extractor checks the complete archive hash, each file's size and hash,
the exact file set and the MIT notice before creating output. Existing output
is refused. File pins are in `../assembly-manifest.json`. The archive uses sorted
paths, USTAR records, mode 0644, zero timestamps and numeric owner/group zero;
gzip has an empty filename and zero timestamp.

The remaining 543 inherited/derived Urbit files and four browser assets come
from the other [source recipes](../README.md). Use the assembly command there
to produce the complete desk and notices. This source package is not a verified
fresh installer. Noltbook remains a separate component.
