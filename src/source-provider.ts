import * as vscode from 'vscode';
import { SourceStore } from './source-store';

export function virtualChildren(paths: readonly string[], parent: string): [string, vscode.FileType][] {
  const prefix = parent.replace(/\/$/, '') + '/', entries = new Map<string, vscode.FileType>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const remaining = path.slice(prefix.length), name = remaining.split('/')[0];
    if (name) entries.set(name, remaining.includes('/') ? vscode.FileType.Directory : vscode.FileType.File);
  }
  return [...entries];
}
/** Immutable canonical projection: every mutation is denied independently of registration options. */
export class SourceProvider implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  constructor(readonly store: SourceStore) {}
  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  stat(uri: vscode.Uri): vscode.FileStat {
    if (uri.scheme !== 'urbit-source' || uri.authority) throw vscode.FileSystemError.FileNotFound(uri);
    try { const source = this.store.openSnapshot(uri.toString()); return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: source.byteLength, permissions: vscode.FilePermission.Readonly }; }
    catch {
      if (this.readDirectory(uri).length || uri.path === '/') return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0, permissions: vscode.FilePermission.Readonly };
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }
  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    if (uri.scheme !== 'urbit-source' || uri.authority || uri.query || uri.fragment) throw vscode.FileSystemError.FileNotFound(uri);
    return virtualChildren(this.store.sources().map(row => `/${row.key}${row.path}`), uri.path);
  }
  readFile(uri: vscode.Uri): Uint8Array { try { return this.store.bytes(uri.toString()); } catch { throw vscode.FileSystemError.FileNotFound(uri); } }
  writeFile(): never { throw vscode.FileSystemError.NoPermissions('Canonical ship sources are immutable. Create a private draft and prepare a candidate explicitly.'); }
  delete(): never { return this.writeFile(); }
  rename(): never { return this.writeFile(); }
  createDirectory(): never { return this.writeFile(); }
  dispose(): void { this.changes.dispose(); }
}
