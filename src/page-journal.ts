import * as fs from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {PageJournal} from './source-pager';

/** Private append-only revisions. Exclusive creation arbitrates competing windows. */
export class DurablePageJournal implements PageJournal {
  private readonly observed = new Map<string, number>();
  constructor(readonly directory: string, private readonly legacy?: Pick<PageJournal, 'get'>) {}
  private check(info: fs.Stats, directory = false): void {
    if (!(directory ? info.isDirectory() : info.isFile()) || info.isSymbolicLink() ||
        process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new Error('Page journal must be private and owned.');
  }
  private folder(key: string): string {
    if (!/^readymade\.(?:page|directory):[a-f0-9]{64}(?::[1-9][0-9]*)?$/.test(key)) throw new Error('Invalid page journal key.');
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700}); this.check(fs.lstatSync(this.directory), true);
    const folder = join(this.directory, createHash('sha256').update(key).digest('hex'));
    fs.mkdirSync(folder, {recursive: true, mode: 0o700}); this.check(fs.lstatSync(folder), true);
    return folder;
  }
  get<T>(key: string): T | undefined {
    const folder = this.folder(key), files = fs.readdirSync(folder);
    if (files.length > 4096 || files.some(file => !/^[1-9][0-9]*\.json$/.test(file))) throw new Error('Invalid page journal revisions.');
    const revisions = files.map(file => Number(file.slice(0, -5))).sort((a, b) => a - b);
    if (revisions.some((revision, index) => revision !== index + 1)) throw new Error('Missing page journal revision.');
    const revision = revisions.at(-1) ?? 0;
    this.observed.set(key, revision);
    if (!revision) {
      const value = this.legacy?.get<T>(key);
      if (value !== undefined) this.append(key, value);
      return value;
    }
    const fd = fs.openSync(join(folder, `${revision}.json`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd); this.check(stat);
      if (stat.size > 4194304) throw new Error('Page journal value too large.');
      const row = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (row.key !== key || row.revision !== revision || !Object.hasOwn(row, 'value')) throw new Error('Page journal identity changed.');
      return row.value as T;
    } finally {fs.closeSync(fd);}
  }
  private append(key: string, value: unknown): void {
    const prior = this.observed.get(key);
    if (prior === undefined || prior >= 4096 || value === undefined) throw new Error('Read the retained page intent before updating.');
    const folder = this.folder(key), revision = prior + 1, text = JSON.stringify({key, revision, value});
    if (Buffer.byteLength(text) > 4194304) throw new Error('Page journal value too large.');
    // An incomplete file after a crash deliberately blocks recovery and replay.
    const fd = fs.openSync(join(folder, `${revision}.json`), 'wx', 0o600);
    try {fs.writeFileSync(fd, text); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    for (const path of [folder, this.directory]) {
      const directory = fs.openSync(path, fs.constants.O_RDONLY);
      try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
    }
    this.observed.set(key, revision);
  }
  async update(key: string, value: unknown): Promise<void> {this.append(key, value);}
}
