import * as fs from 'node:fs';
import {join} from 'node:path';
import {digest} from './source-store';

/** Local copies of opened evidence, never current ship state or execution authority. */
export class CheckDocumentJournal {
  constructor(readonly directory: string) {}
  private check(info: fs.Stats, directory = false): void {
    if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile() && info.nlink === 1) ||
        (info.mode & 0o077) || process.getuid && info.uid !== process.getuid()) throw new Error('Check evidence storage must be private and owned.');
  }
  private file(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid check document identity.');
    return join(this.directory, `${key}.json`);
  }
  recent(): {key: string; text: string}[] {
    try { this.check(fs.lstatSync(this.directory), true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const files = fs.readdirSync(this.directory);
    if (files.length > 4096 || files.some(file => !/^[a-f0-9]{64}\.json$/.test(file))) throw new Error('Check archive inventory is invalid or exceeds 4096 documents.');
    const sorted = files.map(file => {
      const info = fs.lstatSync(join(this.directory, file)); this.check(info);
      return {key: file.slice(0, -5), time: info.mtimeMs};
    }).sort((a, b) => b.time - a.time || a.key.localeCompare(b.key));
    return sorted.slice(0, 64).map(({key}) => {
      const text = this.read(key); if (text === undefined) throw new Error('Saved check disappeared. Open the list again.');
      return {key, text};
    });
  }
  read(key: string): string | undefined {
    const file = this.file(key);
    try { this.check(fs.lstatSync(this.directory), true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    try {
      const info = fs.fstatSync(fd); this.check(info);
      if (info.size > 1048576) throw new Error('Check document exceeds the 1 MiB storage limit.');
      const text = fs.readFileSync(fd, 'utf8');
      if (Buffer.byteLength(text) > 1048576 || digest(text) !== key) throw new Error('Stored check document does not match its identity.');
      return text;
    } finally { fs.closeSync(fd); }
  }
  retain(text: string): string {
    if (Buffer.byteLength(text) > 1048576) throw new Error('Check document exceeds the 1 MiB storage limit.');
    const key = digest(text), file = this.file(key);
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700}); this.check(fs.lstatSync(this.directory), true);
    if (this.read(key) !== undefined) return key;
    let fd: number;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && this.read(key) === text) return key;
      throw error;
    }
    // An incomplete write remains a visible integrity failure, never replaced silently.
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const directory = fs.openSync(this.directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    return key;
  }
}
