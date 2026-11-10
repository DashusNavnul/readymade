import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, normalize, parse } from 'node:path';

function refuse(): never { throw new Error('Landscape command requires private owned paths and its generated executable.'); }
function absolute(value: string): void {
  if (!value || !isAbsolute(value) || normalize(value) !== value || /[\r\n\0]/.test(value)) refuse();
}
async function directories(path: string, create: boolean): Promise<void> {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    if (create) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) refuse();
  }
}
async function privateDirectory(path: string, create: boolean): Promise<void> {
  absolute(path); await directories(path, create);
  const info = await lstat(path);
  if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) refuse();
}
const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";

/** Installs one local presentation command; never starts a service or changes a shell profile. */
export async function installLandscapeCommand(directory: string, cli: string, userData: string, uri: string): Promise<string> {
  return installAppCommand('landscape', directory, cli, userData, uri);
}
export async function installAppCommand(app: 'landscape' | 'groups' | 'lattice' | 'glurff' | 'noltbook', directory: string, cli: string, userData: string, uri: string): Promise<string> {
  if (!['landscape', 'groups', 'lattice', 'glurff', 'noltbook'].includes(app)) refuse();
  const header = `#!/bin/sh\n# readymade-${app}-command-v1\n`;
  absolute(directory); absolute(cli); absolute(userData);
  if (!uri || uri.length > 8192 || /[\r\n\0]/.test(uri)) refuse();
  let target: URL;
  try { target = new URL(uri); } catch { return refuse(); }
  if (!/^[a-z][a-z0-9+.-]*:$/.test(target.protocol) || ['http:', 'https:', 'file:'].includes(target.protocol) ||
      target.host !== 'pataphor.readymade-ship-workspace' || target.username || target.password || target.pathname !== '/' + app || target.search || target.hash) refuse();
  await directories(dirname(cli), false);
  const executable = await lstat(cli);
  if (!executable.isFile() || executable.isSymbolicLink() || !(executable.mode & 0o111) ||
      executable.mode & 0o022 || ![0, process.getuid?.()].includes(executable.uid)) refuse();
  await privateDirectory(userData, false);
  await privateDirectory(directory, true);
  const bin = join(directory, 'terminal-bin'); await privateDirectory(bin, true);
  const command = join(bin, app);
  const content = header + `if [ "$#" -ne 0 ]; then\n  printf 'Usage: ${app}\\n' >&2\n  exit 2\nfi\n` +
    `exec ${quote(cli)} --user-data-dir ${quote(userData)} --open-url ${quote(uri)}\n`;
  let previous: { dev: number; ino: number } | undefined;
  try {
    const file = await open(command, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700 || info.nlink !== 1 || info.size > 65536) refuse();
      const prior = await file.readFile('utf8'); if (!prior.startsWith(header)) refuse();
      if (prior === content) return bin;
      previous = { dev: info.dev, ino: info.ino };
    } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(bin, '.' + app + '-' + randomBytes(16).toString('hex'));
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700);
  try {
    await file.writeFile(content); await file.sync(); await file.close();
    let current;
    try { current = await lstat(command); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous ? !current || current.dev !== previous.dev || current.ino !== previous.ino || current.isSymbolicLink() : current) refuse();
    await rename(temporary, command);
  } finally { await file.close(); await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  return bin;
}
