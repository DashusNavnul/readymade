# Third-party notices

Readymade includes a minimal adaptation of Microsoft VS Code proposed browser
API declarations in `src/browser.d.ts`, from microsoft/vscode commit
`2c33b50b16c472efe58357d1d2a8a5414bc23fbf`.

MIT License

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The packaging script downloads VSCodium 1.143.17232. VSCodium, Code–OSS,
Electron and their dependencies retain their respective licenses and notices
inside the complete upstream application bundle. Readymade preserves those
files; its MIT license does not replace them.

Upstream: https://github.com/VSCodium/vscodium and
https://github.com/microsoft/vscode.
Development dependency versions and licenses are recorded in package-lock.json.

The optional [backend sigil reconstruction](backend/sigil/README.md) retains
complete sigil-js, invariant and lodash.memoize notices in
[backend/sigil/NOTICES.txt](backend/sigil/NOTICES.txt). Its generated renderer must
be redistributed with those notices. Its locked build dependencies retain their
own notices in the installed packages.

The [CodeMirror recipe](backend/codemirror/README.md) embeds complete notices
for all 18 bundled runtime packages in its output and emits `NOTICES.txt`.
The [xterm recipe](backend/xterm/README.md) retains the original MIT notice in
both generated assets and [LICENSE.txt](backend/xterm/LICENSE.txt).

## Hoon syntax grammar

`platform/hoon.tmLanguage` is copied unchanged from
`urbit/urbit`, commit `bebc7b37add965057dadc6d6cb338c6b7f6f15a6`,
`extras/hoonSublime/hoon.tmLanguage`.

The MIT License (MIT)

Copyright (c) 2015 Urbit

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
