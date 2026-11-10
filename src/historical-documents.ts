import * as vscode from 'vscode';

/** Readonly backing bytes; privileged extension model edits are detected on reuse, not silently repaired. */
export class HistoricalDocuments implements vscode.Disposable {
  private readonly documents = new Map<string, string>();
  private bytes = 0;
  private closed = false;
  private readonly events = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly registration: vscode.Disposable;
  constructor(private readonly scheme: string, private readonly resolve?: (uri: vscode.Uri) => string,
    private readonly maxDocuments = 256, private readonly maxBytes = 8 * 1024 * 1024) {
    const denied = (): never => { throw vscode.FileSystemError.NoPermissions('Historical evidence is readonly. Open a draft to edit source.'); };
    this.registration = vscode.workspace.registerFileSystemProvider(scheme, {
      onDidChangeFile: this.events.event, watch: () => new vscode.Disposable(() => {}),
      stat: uri => ({type: vscode.FileType.File, ctime: 0, mtime: 0, size: Buffer.byteLength(this.read(uri)), permissions: vscode.FilePermission.Readonly}),
      readFile: uri => Buffer.from(this.read(uri), 'utf8'),
      readDirectory: uri => { throw vscode.FileSystemError.FileNotADirectory(uri); },
      writeFile: denied, rename: denied, delete: denied, createDirectory: denied,
    }, {isReadonly: true, isCaseSensitive: true});
  }
  retain(uri: vscode.Uri, text: string): vscode.Uri {
    if (this.closed || uri.scheme !== this.scheme) throw vscode.FileSystemError.FileNotFound(uri);
    const key = uri.toString(), prior = this.documents.get(key);
    if (prior !== undefined && prior !== text) throw Error('Historical evidence identity changed.');
    if (prior === undefined) {
      const bytes = Buffer.byteLength(text);
      if (this.documents.size >= this.maxDocuments || this.bytes + bytes > this.maxBytes) throw Error('Historical result capacity reached. Open a new window to inspect more results.');
      this.documents.set(key, text); this.bytes += bytes;
    }
    return uri;
  }
  read(uri: vscode.Uri): string {
    if (this.closed || uri.scheme !== this.scheme) throw vscode.FileSystemError.FileNotFound(uri);
    if (this.resolve) this.retain(uri, this.resolve(uri)); // Revalidate current scope even for retained URIs.
    const text = this.documents.get(uri.toString());
    if (text === undefined) throw vscode.FileSystemError.FileNotFound(uri);
    return text;
  }
  verify(document: vscode.TextDocument, guard: () => void): void {
    guard();
    if (this.read(document.uri) !== document.getText()) throw Error('Historical evidence buffer changed. Reopen a new window to inspect the retained evidence.');
  }
  async open(uri: vscode.Uri, guard: () => void): Promise<vscode.TextDocument> {
    guard(); this.read(uri);
    const document = await vscode.workspace.openTextDocument(uri); this.verify(document, guard); return document;
  }
  dispose(): void { this.closed = true; this.registration.dispose(); this.events.dispose(); this.documents.clear(); this.bytes = 0; }
}
