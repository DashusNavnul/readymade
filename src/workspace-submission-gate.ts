import * as fs from 'node:fs';
import {join} from 'node:path';
import {digest, originOf} from './source-store';
import type {WorkspaceRequestRow} from './workspace-request-store';

/** An immutable claim shared by all windows using this profile. Never delete to retry. */
export class WorkspaceSubmissionGate {
  constructor(readonly directory: string, readonly origin: string, readonly owner: string) {
    if (originOf(origin) !== origin || !/^~[a-z-]{3,127}$/.test(owner)) throw new Error('Invalid shared request binding.');
  }
  claim(row: WorkspaceRequestRow): void {
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    const info = fs.lstatSync(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        process.getuid && info.uid !== process.getuid()) throw new Error('Shared request claims must be private and owned.');
    // Digest changes must not create another slot for the same native request.
    const key = digest(JSON.stringify([this.origin, this.owner, row.requester, row.nonce]));
    const file = join(this.directory, key + '.claim.json');
    let fd: number;
    try {fd = fs.openSync(file, 'wx', 0o600);}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('This shared request was already claimed. Check its native outcome; do not submit again.');
      throw error;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({version: 1, origin: this.origin, owner: this.owner, request: row}));
      fs.fsyncSync(fd);
    } finally {fs.closeSync(fd);}
    const directory = fs.openSync(this.directory, fs.constants.O_RDONLY);
    try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
  }
}
