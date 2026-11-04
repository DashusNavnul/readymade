import * as vscode from 'vscode';
import { DraftStore } from './draft-store';
import { virtualChildren } from './source-provider';

/** Save persists a private draft only. Candidate submission is an explicit separate command. */
export class DraftProvider implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  constructor(readonly store: DraftStore) {}
  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  stat(uri: vscode.Uri): vscode.FileStat {
    if (uri.scheme !== 'readymade-draft' || uri.authority) throw vscode.FileSystemError.FileNotFound(uri);
    try { const row = this.store.get(uri.toString()); return { type: vscode.FileType.File, ctime: 0, mtime: row.updatedAt, size: Buffer.byteLength(row.text) }; }
    catch {
      if (this.readDirectory(uri).length || uri.path === '/') return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }
  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    if (uri.scheme !== 'readymade-draft' || uri.authority || uri.query || uri.fragment) throw vscode.FileSystemError.FileNotFound(uri);
    return virtualChildren(this.store.list().map(row => new URL(row.uri).pathname), uri.path);
  }
  readFile(uri: vscode.Uri): Uint8Array { try { return Buffer.from(this.store.get(uri.toString()).text, 'utf8'); } catch { throw vscode.FileSystemError.FileNotFound(uri); } }
  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    if (!Buffer.from(text, 'utf8').equals(Buffer.from(content))) throw vscode.FileSystemError.Unavailable('Draft UTF-8 bytes would change.');
    this.store.save(uri.toString(), text); this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }
  delete(): never { throw vscode.FileSystemError.NoPermissions('Retained private drafts and request receipts cannot be deleted through the filesystem.'); }
  rename(): never { return this.delete(); }
  createDirectory(): never { return this.delete(); }
  dispose(): void { this.changes.dispose(); }
}
