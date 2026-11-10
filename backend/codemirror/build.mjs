import {build, version as esbuildVersion} from 'esbuild';
import {readFile, writeFile, mkdir, access} from 'node:fs/promises';
import {resolve, dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root = dirname(fileURLToPath(import.meta.url));
if (process.argv.length !== 3) throw new Error('Usage: node build.mjs NEW_OUTPUT_DIRECTORY');
const output = resolve(process.argv[2]);
try {await access(output); throw new Error('Output already exists; choose a fresh directory');}
catch (error) {if (error.code !== 'ENOENT') throw error;}
const sha = data => createHash('sha256').update(data).digest('hex');
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const result = await build({absWorkingDir: root, entryPoints: ['entry.js'], bundle: true,
  write: false, metafile: true, minify: true, format: 'iife', platform: 'browser',
  tsconfigRaw: {compilerOptions: {alwaysStrict: false}},
  target: ['es2022'], legalComments: 'none', sourcemap: false});
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.startsWith('node_modules/')) continue;
  let directory = dirname(resolve(root, input));
  while (directory !== root) {
    let raw;
    try {
      raw = await readFile(join(directory, 'package.json'), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(directory);
      if (parent === directory || parent === root) throw new Error(`Missing package or license for ${input}`);
      directory = parent;
      continue;
    }
    const pkg = JSON.parse(raw), key = relative(root, directory).split('\\').join('/');
    const pinned = lock.packages[key];
    if (!pinned || pinned.version !== pkg.version || !pinned.integrity) throw new Error(`Unpinned package: ${key}`);
    if (!packages.has(key)) {
      const notice = await readFile(join(directory, 'LICENSE'), 'utf8');
      if (!notice.trim()) throw new Error(`Empty license: ${key}`);
      packages.set(key, {name: pkg.name, version: pkg.version, license: pkg.license,
        resolved: pinned.resolved, integrity: pinned.integrity, notice, noticeSHA256: sha(notice)});
    }
    break;
  }
}
const dependencies = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
const notices = dependencies.map(p => `${p.name} ${p.version} (${p.license})\n${p.notice}`).join('\n\n');
if (notices.includes('*/')) throw new Error('Notice cannot be embedded safely');
const bundle = `/*! Readymade CodeMirror build. Dependency notices follow.\n${notices}\n*/\n` + result.outputFiles[0].text;
const inputs = {};
for (const file of Object.keys(result.metafile.inputs)) inputs[file] = sha(await readFile(join(root, file)));
const manifest = {schema: 'readymade-codemirror-build-v1', esbuildVersion,
  lockSHA256: sha(await readFile(join(root, 'package-lock.json'))), inputs,
  dependencies, bundleSHA256: sha(bundle), bundleBytes: Buffer.byteLength(bundle)};
if (manifest.bundleSHA256 !== 'd60c26457036a84644961ee290e07d4f6aab3734d50451ec50246c2f89d89b2a') throw new Error('Bundle differs from qualified editor');
if (dependencies.length !== 18) throw new Error('Unexpected dependency set');
await mkdir(output);
await writeFile(join(output, 'codemirror.js'), bundle, {flag: 'wx'});
await writeFile(join(output, 'NOTICES.txt'), notices, {flag: 'wx'});
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({bundleSHA256: manifest.bundleSHA256, dependencies: dependencies.map(p => `${p.name}@${p.version}`), output}));
