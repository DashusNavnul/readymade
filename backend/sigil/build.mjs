import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
assert(process.argv.length === 3, 'Usage: node build.mjs NEW_OUTPUT_DIRECTORY');
const out = resolve(process.argv[2]);
const sha = data => createHash('sha256').update(data).digest('hex');
const result = await build({absWorkingDir: here, entryPoints: ['entry.js'],
  bundle: true, format: 'iife', minify: true, write: false, metafile: true,
  tsconfigRaw: {compilerOptions: {alwaysStrict: false}},
  banner: {js: "/* @urbit/sigil-js 2.2.0 (MIT), bundled locally with esbuild (iife, minified); exposes window.PataphorSigil. No CDN. */"}});
const bytes = result.outputFiles[0].contents;
const notices = await readFile(resolve(here, 'NOTICES.txt'));
assert.equal(sha(bytes), "0d073d64abacde12720a76e425d5a3ec7d25a5dd7f9407d851c863157972053d", 'Renderer output differs from qualified source');
assert.equal(sha(notices), "06f48d1fbb4364dbadd0a0ce7041e58b8cd0bf201a5742801995ea5d431b34b1", 'Third-party notices changed');
const inputs = Object.keys(result.metafile.inputs).sort();
assert.deepEqual(inputs, ['entry.js', 'node_modules/@urbit/sigil-js/dist/core.esm.js',
  'node_modules/@urbit/sigil-js/dist/index.esm.js', 'node_modules/invariant/browser.js',
  'node_modules/lodash.memoize/index.js']);
await mkdir(out); // Refuse any existing output; never overwrite it.
await writeFile(resolve(out, 'sigil.js'), bytes, {flag: 'wx'});
await writeFile(resolve(out, 'NOTICES.txt'), notices, {flag: 'wx'});
await writeFile(resolve(out, 'manifest.json'), JSON.stringify({
  protocol: 'readymade-sigil-source-v1', rendererSha256: sha(bytes),
  noticesSha256: sha(notices), inputs,
  lockSha256: sha(await readFile(resolve(here, 'package-lock.json')))
}, null, 2) + '\n', {flag: 'wx'});
console.log('Exact renderer and notices reconstructed in ' + out);
