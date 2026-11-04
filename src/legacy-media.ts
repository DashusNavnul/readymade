import { lstatSync } from 'node:fs';
import { isAbsolute, dirname } from 'node:path';
import { createConnection } from 'node:net';
import { asRecord, type JsonObject } from './protocol';

export interface LegacyMediaOwner { readonly socketPath: string; readonly device: number; readonly inode: number; readonly origin?: string; readonly title?: string }
/** Inspects only an explicitly configured existing owner. Never loads or executes a page. */
export class LegacyMedia {
  constructor(private readonly options: { socketPath: string; revealExisting: (owner: LegacyMediaOwner) => Promise<void> }) {}
  private identity(): LegacyMediaOwner | undefined {
    const socketPath = this.options.socketPath;
    if (!isAbsolute(socketPath) || socketPath.includes('\0') || Buffer.byteLength(socketPath) > 103) throw new Error('Supply the existing native owner’s absolute control socket path.');
    try {
      const directory = lstatSync(dirname(socketPath)), socket = lstatSync(socketPath);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0 ||
          !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== process.getuid?.() || (socket.mode & 0o077) !== 0) throw new Error('Existing native control socket must be private and owned by this user.');
      return { socketPath, device: socket.dev, inode: socket.ino };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async inspect(): Promise<LegacyMediaOwner | undefined> {
    const owner = this.identity(); if (!owner) return undefined;
    const response = await new Promise<JsonObject>((resolve, reject) => {
      const connection = createConnection(owner.socketPath), chunks: Buffer[] = []; let bytes = 0, finished = false;
      const finish = (error?: Error, value?: JsonObject) => {
        if (finished) return; finished = true; connection.destroy();
        if (error) reject(error); else resolve(value!);
      };
      connection.setTimeout(3000, () => finish(new Error('Existing native owner did not answer.')));
      connection.on('error', () => finish(new Error('Existing native owner is unavailable.')));
      connection.on('connect', () => {
        try {
          const current = this.identity();
          if (!current || current.device !== owner.device || current.inode !== owner.inode) return finish(new Error('Existing native owner changed.'));
          connection.write(JSON.stringify({ native: 'state' }) + '\n');
        } catch { finish(new Error('Existing native owner changed.')); }
      });
      connection.on('data', chunk => {
        bytes += chunk.length; if (bytes > 262144) return finish(new Error('Existing native state exceeds the metadata limit.'));
        chunks.push(chunk); const data = Buffer.concat(chunks), newline = data.indexOf(10); if (newline < 0) return;
        try { finish(undefined, asRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, newline))))); }
        catch { finish(new Error('Existing native owner returned incompatible state.')); }
      });
      connection.on('end', () => finish(new Error('Existing native owner returned no complete state.')));
    });
    if (response.ok !== true) throw new Error('Existing native owner refused its read-only state.');
    const value = asRecord(response.value), origin = typeof value.origin === 'string' ? value.origin : undefined;
    return Object.freeze({ ...owner, ...(origin ? { origin } : {}), ...(typeof value.title === 'string' ? { title: value.title.slice(0, 512) } : {}) });
  }
  async show(): Promise<void> {
    const owner = await this.inspect(); if (!owner) throw new Error('No existing native owner is running at this configured socket.');
    const current = this.identity();
    if (!current || owner.device !== current.device || owner.inode !== current.inode) throw new Error('Existing native owner changed.');
    await this.options.revealExisting(owner);
  }
}
