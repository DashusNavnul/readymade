import * as vscode from 'vscode';
import {RemoteDraftStore} from './remote-draft-store';
import {virtualChildren} from './source-provider';

/** Register draft scheme writable and original scheme read-only; Save is local only. */
export class RemoteDraftProvider implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  constructor(readonly store: RemoteDraftStore) {}
  private original(uri: vscode.Uri): boolean {
    if (!['readymade-remote-draft', 'readymade-remote-original'].includes(uri.scheme) || uri.authority || uri.query || uri.fragment) throw vscode.FileSystemError.FileNotFound(uri);
    return uri.scheme === 'readymade-remote-original';
  }
  watch(): vscode.Disposable {return new vscode.Disposable(() => undefined);}
  stat(uri: vscode.Uri): vscode.FileStat {
    const original = this.original(uri);
    try {const r = this.store.get(uri.toString()); return {type: vscode.FileType.File, ctime: 0, mtime: original ? 0 : r.updatedAt,
      size: this.readFile(uri).byteLength, ...(original ? {permissions: vscode.FilePermission.Readonly} : {})};}
    catch {if (uri.path === '/' || this.readDirectory(uri).length) return {type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0}; throw vscode.FileSystemError.FileNotFound(uri);}
  }
  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const original = this.original(uri);
    return virtualChildren(this.store.list().map(r => new URL(original ? r.originalUri : r.uri).pathname), uri.path);
  }
  readFile(uri: vscode.Uri): Uint8Array {
    const original = this.original(uri);
    try {const r = this.store.get(uri.toString()); return Buffer.from(original ? r.observation.files.find(f => f.path === r.path)!.text : r.text);}
    catch {throw vscode.FileSystemError.FileNotFound(uri);}
  }
  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    if (this.original(uri)) throw vscode.FileSystemError.NoPermissions('Observed original source is read-only.');
    const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(content);
    if (!Buffer.from(text).equals(Buffer.from(content))) throw vscode.FileSystemError.Unavailable('Draft bytes would change.');
    this.store.save(uri.toString(), text); this.changes.fire([{type: vscode.FileChangeType.Changed, uri}]);
  }
  delete(): never {throw vscode.FileSystemError.NoPermissions('Remote drafts and original observations are retained.');}
  rename(): never {return this.delete();}
  createDirectory(): never {return this.delete();}
  dispose(): void {this.changes.dispose();}
}
