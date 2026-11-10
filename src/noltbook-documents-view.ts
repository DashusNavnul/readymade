import * as vscode from 'vscode';
import {createHash} from 'node:crypto';
import {HistoricalDocuments} from './historical-documents';
import {mergeDraft} from './draft-merge';
import type {ShipClient} from './ship-client';
import type {MediaTreeRow} from './media-workbench';
import {NoltbookDocumentClient} from './noltbook-document-client';
import {documentBody, documentSaveIntent, type DocumentSnapshot, type DocumentSaveIntent, type DocumentSaveResult} from './noltbook-documents';
import {NoltbookDocumentStore, type DocumentDraft} from './noltbook-document-store';

const uri = (id: string) => vscode.Uri.from({scheme: 'readymade-document', path: `/${id}/document.md`});
/** Editor working copies. Ordinary Save is local; Publish is the only native write. */
export class NoltbookDocumentsView implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly registrations: vscode.Disposable[] = [];
  private readonly previews = new HistoricalDocuments('readymade-document-history', undefined, 64, 64 * 1_048_576);
  private readonly admitted = new Map<string, string>();
  private bound?: {client: ShipClient; transport: NoltbookDocumentClient};
  private opening?: Promise<NonNullable<NoltbookDocumentsView['bound']>>;
  private controlledEdit?: {document: vscode.TextDocument; version: number; body: string};
  confirmReconciliation = async (): Promise<boolean> => (await vscode.window.showQuickPick(['Apply Merged Copy', 'Keep My Copy'], {title: 'Apply reconciliation locally?', placeHolder: 'Retain your original copy and adopt this shared revision. Publish remains separate.'})) === 'Apply Merged Copy';
  private busy = false;
  private closed = false;
  private notice = 'Open a shared Noltbook document. Save keeps a private copy; Publish shares it.';
  constructor(readonly store: NoltbookDocumentStore, private readonly current: () => ShipClient | undefined, private readonly changed: () => void,
    private readonly navigate?: (client: ShipClient, peer: string, url: string) => Promise<unknown>) {
    this.registrations.push(vscode.workspace.registerFileSystemProvider('readymade-document', this, {isCaseSensitive: true}),
      this.previews, vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.scheme !== 'readymade-document' || !event.contentChanges.length) return;
        const controlled = this.controlledEdit;
        if (controlled?.document === event.document && event.document.version === controlled.version && event.document.getText() === controlled.body) return;
        try {this.store.save(this.key(event.document.uri), event.document.getText()); this.changed();}
        catch (error) {this.notice = `Private document backup failed: ${String(error)}`; this.changed();}
      }));
  }
  private key(value: vscode.Uri): string {
    const match = /^\/([a-f0-9]{64})\/document\.md$/.exec(value.path);
    if (value.scheme !== 'readymade-document' || value.authority || value.query || value.fragment || !match) throw vscode.FileSystemError.FileNotFound(value);
    return match[1];
  }
  private selected(id?: string): DocumentDraft {
    return this.store.get(id ?? this.key(vscode.window.activeTextEditor?.document.uri ?? vscode.Uri.parse('missing:/')));
  }
  private active(b: NonNullable<NoltbookDocumentsView['bound']>): boolean {return !this.closed && this.bound === b && this.current() === b.client;}
  private dirty(id: string): boolean {return vscode.workspace.textDocuments.some(d => d.uri.toString() === uri(id).toString() && d.isDirty);}
  private async connection(): Promise<NonNullable<NoltbookDocumentsView['bound']>> {
    if (this.closed) throw new Error('Document editor is closed.');
    const client = this.current(); if (!client) throw new Error('Connect to Noltbook first.');
    if (this.opening) return this.opening;
    if (this.bound?.client === client) return this.bound;
    this.opening = (async () => {
      if (this.bound) await this.bound.transport.close();
      this.admitted.clear();
      const transport = new NoltbookDocumentClient(client, update => {
        if (!this.bound || this.bound.transport !== transport || !this.active(this.bound)) return;
        try {
          const id = this.admitted.get(update.noteId); if (!id) return;
          const row = this.store.get(id);
          this.store.observe(row.id, {...row.remote, ...update}, this.dirty(row.id)); this.changes.fire([{type: vscode.FileChangeType.Changed, uri: uri(row.id)}]);
          this.notice = 'Shared document updated. Local edits are preserved; compare before publishing.'; this.changed();
        } catch (error) {this.notice = String(error); this.changed();}
      }, () => {if (this.bound?.transport === transport) {this.bound = undefined; this.notice = 'Document updates disconnected. Open a document to reconnect; pending saves are not resent.'; this.changed();}});
      const bound = {client, transport}; this.bound = bound;
      try {await transport.start(); if (!this.active(bound)) throw new Error('Document connection changed.'); return bound;}
      catch (error) {await transport.close(); if (this.bound === bound) this.bound = undefined; throw error;}
    })();
    try {return await this.opening;} finally {this.opening = undefined;}
  }
  private assertBinding(b: NonNullable<NoltbookDocumentsView['bound']>, row: DocumentDraft, fresh: DocumentSnapshot): void {
    const old = row.snapshot;
    if (!this.active(b) || fresh.origin !== old.origin || fresh.peer !== old.peer || fresh.host !== old.host || fresh.noteId !== old.noteId) throw new Error('Document identity or connection changed.');
  }
  async open(id?: string): Promise<void> {
    if (id) {
      const document = await vscode.workspace.openTextDocument(uri(this.store.get(id).id));
      const editor = await vscode.window.showTextDocument(document, {preview: false, preserveFocus: false});
      // Target the returned editor's existing group, not a potentially stale active group.
      const column = editor.viewColumn, groups = vscode.window.tabGroups.all;
      const ordinal = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];
      const focus = column && column <= 8 ? ordinal[column - 1] : column === groups.at(-1)?.viewColumn ? 'Last' : undefined;
      if (!column || !focus || !groups.some(group => group.viewColumn === column)) throw new Error('Document editor group changed. Open your copy again.');
      await vscode.commands.executeCommand(`workbench.action.focus${focus}EditorGroup`);
      const focused = await vscode.window.showTextDocument(document, {viewColumn: column, preview: false, preserveFocus: false});
      const group = vscode.window.tabGroups.activeTabGroup, input = group.activeTab?.input;
      if (vscode.window.activeTextEditor !== focused || focused.document !== document || focused.viewColumn !== column ||
          group.viewColumn !== column || !(input instanceof vscode.TabInputText) || input.uri.toString() !== document.uri.toString()) throw new Error('Document focus changed. Open your copy again.');
      return;
    }
    const b = await this.connection(), notes = await b.transport.notes();
    if (!this.active(b)) throw new Error('Document connection changed.');
    const note = await vscode.window.showQuickPick(notes.map(n => ({label: n.name || 'Untitled document', description: n.host, note: n})), {title: 'Open Shared Noltbook Document'});
    if (!note || !this.active(b)) return;
    const fresh = await b.transport.open(note.note.id, note.note.host, () => this.active(b)); if (!this.active(b) || fresh.host !== note.note.host) throw new Error('Document identity changed.');
    const existing = this.store.list().find(r => r.snapshot.origin === fresh.origin && r.snapshot.peer === fresh.peer && r.snapshot.host === fresh.host && r.snapshot.noteId === fresh.noteId);
    const row = this.store.open(fresh, !!existing && this.dirty(existing.id), note.note.name); this.admitted.set(fresh.noteId, row.id); await this.open(row.id); this.changed();
  }
  private async refresh(id: string): Promise<{b: NonNullable<NoltbookDocumentsView['bound']>; row: DocumentDraft}> {
    const row = this.store.get(id), b = await this.connection(), fresh = await b.transport.read(row.snapshot.noteId);
    this.assertBinding(b, row, fresh); this.store.observe(id, fresh, this.dirty(id)); this.admitted.set(fresh.noteId, id);
    this.changes.fire([{type: vscode.FileChangeType.Changed, uri: uri(id)}]); this.changed(); return {b, row: this.store.get(id)};
  }
  private async settle(b: NonNullable<NoltbookDocumentsView['bound']>, row: DocumentDraft, command: DocumentSaveIntent, result: DocumentSaveResult): Promise<void> {
    const receipt = b.transport.receipt(command); let fresh: DocumentSnapshot | undefined, unavailable = false;
    if (['saved', 'no-change'].includes(result.result)) {
      try {fresh = await b.transport.read(row.snapshot.noteId);}
      catch (error) {if (!receipt) throw error; unavailable = true;}
    }
    if (!this.active(b)) throw new Error('Document connection changed. Check the retained request again.');
    if (fresh) this.assertBinding(b, row, fresh);
    this.store.settle(row.id, result, fresh, receipt);
    if (fresh) this.admitted.set(fresh.noteId, row.id);
    this.notice = `${receipt ? 'Native receipt recorded' : 'Document save'}: ${result.result}.` +
      (unavailable ? ' Current shared version unavailable; compare before publishing again.' :
        fresh && fresh.revision !== result.revision ? ' The shared document has newer changes; compare before publishing again.' : '');
  }
  async publish(id?: string): Promise<void> {
    if (this.busy) throw new Error('Wait for the current document operation.');
    const selected = this.selected(id); if (selected.pending) throw new Error('Check the retained save first. It cannot be resent.');
    const document = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri(selected.id).toString());
    if (document) this.store.save(selected.id, document.getText());
    this.busy = true; this.changed();
    try {
      const {b, row} = await this.refresh(selected.id);
      if (row.snapshot.revision !== row.remote.revision || !row.remote.canEdit) throw new Error('Document changed or is read-only. Compare with Shared Version first.');
      const capability = await b.transport.capabilities();
      if (!this.active(b)) throw new Error('Document connection changed.');
      const command = documentSaveIntent({...row.snapshot, canEdit: row.remote.canEdit}, row.body, undefined, capability ? 'receipted-v1' : undefined);
      const result = await b.transport.save(command, async () => {
        if (!this.active(b)) throw new Error('Document connection changed.'); this.store.begin(row.id, command); this.changed();
      });
      await this.settle(b, row, command, result);
    } finally {this.busy = false; this.changed();}
  }
  async check(id?: string): Promise<void> {
    if (this.busy) throw new Error('Wait for the current document operation.');
    const selected = this.selected(id); this.busy = true;
    try {
      const {b, row} = selected.pending?.protocol ? {b: await this.connection(), row: this.store.get(selected.id)} : await this.refresh(selected.id);
      if (!row.pending) {this.notice = 'Current shared revision observed. No save was sent.'; return;}
      const result = await b.transport.check(row.pending);
      await this.settle(b, row, row.pending, result);
    } finally {this.busy = false; this.changed();}
  }
  private preview(body: string): vscode.Uri {
    const value = vscode.Uri.from({scheme: 'readymade-document-history', path: '/' + createHash('sha256').update(body).digest('hex') + '.md'});
    return this.previews.retain(value, documentBody(body));
  }
  async compare(id?: string): Promise<void> {
    const {b, row} = await this.refresh(this.selected(id).id);
    const guard = () => {
      const current = this.store.get(row.id);
      if (!this.active(b) || JSON.stringify(current.snapshot) !== JSON.stringify(row.snapshot) ||
          JSON.stringify(current.pending) !== JSON.stringify(row.pending)) throw new Error('Document or connection changed. Compare again.');
    };
    const left = await this.previews.open(this.preview(row.remote.body), guard);
    await vscode.commands.executeCommand('vscode.diff', left.uri, uri(row.id), 'Shared Version ↔ My Document');
    this.previews.verify(left, guard);
    if (row.pending) return;
    const choice = await vscode.window.showInformationMessage('Resolve differences in your document on the right. Use this shared revision as the base for your next explicit Publish?', 'Use Shared Revision');
    this.previews.verify(left, guard);
    if (choice !== 'Use Shared Revision') return;
    const fresh = await b.transport.read(row.snapshot.noteId); this.assertBinding(b, row, fresh);
    this.previews.verify(left, guard);
    if (fresh.revision !== row.remote.revision || fresh.body !== row.remote.body) throw new Error('Shared document changed again. Compare again before publishing.');
    this.store.observe(row.id, fresh, true); this.store.rebase(row.id); this.changed();
  }
  async reconcile(id?: string): Promise<void> {
    if (this.busy) throw new Error('Wait for the current document operation.');
    let row = this.selected(id);
    this.busy = true; this.changed();
    try {
      const copies = row.reconciliations ?? [];
      const choice = await vscode.window.showQuickPick([
        {label: 'Reconcile with Shared Version', copy: -1},
        ...copies.map((copy, index) => ({label: `Open Previous Local Copy ${index + 1}`, description: `Original base revision ${copy.snapshot.revision}`, copy: index})),
      ], {title: 'Reconcile Shared Document'});
      if (!choice) return;
      if (choice.copy >= 0) {
        const guard = () => {if (this.closed) throw new Error('Document editor is closed.');};
        const copy = await this.previews.open(this.preview(copies[choice.copy].body), guard);
        await vscode.window.showTextDocument(copy, {preview: false}); this.previews.verify(copy, guard); return;
      }
      if (row.pending) throw new Error('Check the retained save before reconciling.');
      if (copies.length >= 8) throw new Error('Eight original copies are retained. Reconciliation capacity reached.');
      const document = await vscode.workspace.openTextDocument(uri(row.id));
      const editor = await vscode.window.showTextDocument(document, {preview: false});
      const local = document.getText(), version = document.version;
      this.store.save(row.id, local); row = this.store.get(row.id);
      if (row.pending || (row.reconciliations?.length ?? 0) >= 8) throw new Error('Save pending or reconciliation capacity reached.');
      const b = await this.connection(), cookies = b.client.browserCookies(b.client.origin);
      if (!this.active(b) || b.client.origin !== row.snapshot.origin || cookies.length !== 1 || cookies[0].name !== 'urbauth-' + row.snapshot.peer) throw new Error('Document identity or connection changed.');
      const fresh = await b.transport.read(row.snapshot.noteId); this.assertBinding(b, row, fresh);
      if (!fresh.canEdit) throw new Error('Shared document is read-only.');
      const merged = mergeDraft(row.snapshot.body, local, fresh.body);
      const unchanged = () => !document.isClosed && document.version === version && document.getText() === local &&
        JSON.stringify(this.store.get(row.id)) === JSON.stringify(row) && this.active(b);
      const guard = () => {if (!unchanged()) throw new Error('Document changed during reconciliation.');};
      guard();
      if (merged.kind === 'conflict') {
        const shared = await this.previews.open(this.preview(fresh.body), guard);
        await vscode.commands.executeCommand('vscode.diff', shared.uri, uri(row.id), 'Overlapping Changes · Shared Version ↔ My Document', {preview: false});
        this.previews.verify(shared, guard);
        this.notice = 'Changes overlap. Your original text and base are unchanged. Resolve in your copy, then Compare with Shared Version → Use Shared Revision.';
        return;
      }
      const before = await this.previews.open(this.preview(local), guard), after = await this.previews.open(this.preview(merged.text), guard);
      const verify = () => {this.previews.verify(before, guard); this.previews.verify(after, guard);};
      verify();
      await vscode.commands.executeCommand('vscode.diff', before.uri, after.uri, 'Reconcile Preview · My Original ↔ Merged Copy', {preview: false});
      verify();
      const apply = await this.confirmReconciliation();
      verify();
      if (!apply) return;
      const latest = await b.transport.read(row.snapshot.noteId); this.assertBinding(b, row, latest);
      verify();
      if (!unchanged() || !latest.canEdit || latest.revision !== fresh.revision || latest.body !== fresh.body) throw new Error('Document changed. Reconcile again before applying.');
      const target = await vscode.window.showTextDocument(document, {preview: false});
      verify();
      if (!unchanged() || target.document !== editor.document) throw new Error('Document changed before applying reconciliation.');
      row = this.store.prepareReconciliation(row.id, row);
      this.controlledEdit = {document, version: version + 1, body: merged.text};
      if (local !== merged.text) {
        const applied = await target.edit(edit => edit.replace(new vscode.Range(document.positionAt(0), document.positionAt(local.length)), merged.text), {undoStopBefore: true, undoStopAfter: true});
        if (!applied || document.version !== version + 1 || document.getText() !== merged.text) throw new Error('Document changed while applying. Your original base is retained; inspect your dirty copy.');
      }
      const stillActive = () => {if (!this.active(b)) throw new Error('Document connection changed.');};
      this.previews.verify(before, stillActive); this.previews.verify(after, stillActive);
      if (!this.active(b) || document.isClosed || JSON.stringify(this.store.get(row.id)) !== JSON.stringify(row)) throw new Error('Context changed while applying. The original base is retained; inspect your dirty copy.');
      this.store.reconcile(row.id, row, latest, merged.text);
      this.notice = 'Reconciled locally. Original copy retained in Reconcile; Publish is separate.';
    } catch (error) {
      this.notice = `Reconciliation not completed: ${String(error)} Your editor text remains available. Publish was not sent.`;
      throw error;
    } finally {this.controlledEdit = undefined; this.busy = false; this.changed();}
  }
  async openInNoltbook(id?: string): Promise<void> {
    if (!this.navigate) throw new Error('Embedded Noltbook navigation is unavailable.');
    const row = this.selected(id), b = await this.connection();
    const cookies = b.client.browserCookies(b.client.origin);
    if (!this.active(b) || b.client.origin !== row.snapshot.origin || cookies.length !== 1 ||
        cookies[0].name !== 'urbauth-' + row.snapshot.peer) throw new Error('Document identity or connection changed.');
    const fresh = await b.transport.read(row.snapshot.noteId);
    this.assertBinding(b, row, fresh);
    // Admission is a fresh native read, not a local draft or cached membership.
    // Do not observe/rebase here: navigation must preserve the working copy.
    await this.navigate(b.client, fresh.peer, fresh.origin + '/apps/noltbook/?note=' + encodeURIComponent(fresh.noteId));
  }
  async history(id?: string): Promise<void> {
    const {b, row} = await this.refresh(this.selected(id).id), history = await b.transport.history(row.snapshot.noteId);
    if (!this.active(b)) throw new Error('Document connection changed.');
    if (!history.entries.length) {void vscode.window.showInformationMessage(history.isHost === false ? 'Version history is available on the document host.' : 'No retained document versions.'); return;}
    const selected = await vscode.window.showQuickPick(history.entries.map(entry => ({label: `Revision ${entry.revision}`, description: entry.savedBy, entry})), {title: 'Shared Document History'});
    if (selected && this.active(b)) {
      const guard = () => {if (!this.active(b)) throw new Error('Document connection changed.');};
      const historical = await this.previews.open(this.preview(selected.entry.body), guard);
      await vscode.commands.executeCommand('vscode.diff', historical.uri, uri(row.id), `Revision ${selected.entry.revision} ↔ My Document`); this.previews.verify(historical, guard);
    }
  }
  async restore(id?: string): Promise<void> {
    if (this.busy) throw new Error('Wait for the current document operation.');
    const row = this.selected(id);
    if (row.pending) throw new Error('Check the retained save before restoring a version.');
    this.busy = true; this.changed();
    try {
      const document = await vscode.workspace.openTextDocument(uri(row.id));
      const editor = await vscode.window.showTextDocument(document, {preview: false});
      const version = document.version, body = document.getText();
      const b = await this.connection(), fresh = await b.transport.read(row.snapshot.noteId);
      this.assertBinding(b, row, fresh);
      const history = await b.transport.history(row.snapshot.noteId);
      if (!this.active(b)) throw new Error('Document connection changed.');
      if (!history.entries.length) {void vscode.window.showInformationMessage(history.isHost === false ? 'Version history is available on the document host.' : 'No retained document versions.'); return;}
      const selected = await vscode.window.showQuickPick(history.entries.map(entry => ({label: `Revision ${entry.revision}`, description: entry.savedBy, entry})), {title: 'Restore Document Version', placeHolder: 'Restore into your local copy. Publish remains a separate action.'});
      if (!selected) return;
      if (body !== row.snapshot.body) {
        const choice = await vscode.window.showQuickPick(['Restore into My Copy', 'Keep Current Copy'], {title: 'Replace local edits with the selected version?', placeHolder: 'You can undo this replacement. Nothing will be published.'});
        if (choice !== 'Restore into My Copy') return;
      }
      const current = this.store.get(row.id);
      if (!this.active(b) || document.isClosed || document.version !== version || document.getText() !== body ||
          current.pending || JSON.stringify(current.snapshot) !== JSON.stringify(row.snapshot)) throw new Error('Document or connection changed. Choose the version again.');
      if (selected.entry.body === body) return;
      const applied = await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(0), document.positionAt(body.length)), selected.entry.body), {undoStopBefore: true, undoStopAfter: true});
      if (!applied) throw new Error('Document changed before restoration. No version was restored.');
      this.notice = `Revision ${selected.entry.revision} restored into your local copy. Undo reverses it; Publish is separate.`;
    } finally {this.busy = false; this.changed();}
  }
  rows(): MediaTreeRow[] {
    return [{id: 'shared-documents', label: 'Shared Documents', icon: 'notebook', tooltip: this.notice, children: [
      {label: 'Open Shared Document…', command: {command: 'readymade.openDocument', title: 'Open Shared Document'}},
      {label: this.busy ? 'Document operation in progress…' : this.notice},
      ...this.store.list().map(row => ({label: row.title || 'Untitled document', description: row.pending ? 'Save outcome pending' : row.body !== row.snapshot.body ? 'Local edits' : `Revision ${row.snapshot.revision}`, children: [
        {label: 'Open My Copy', command: {command: 'readymade.openDocument', title: 'Open My Copy', arguments: [row.id]}},
        ...[['Open in Noltbook', 'openDocumentInNoltbook'], ['Publish Document', 'publishDocument'], ['Check Shared Version', 'checkDocument'], ['Compare with Shared Version', 'compareDocument'], ['Reconcile Shared Document…', 'reconcileDocument'], ['Version History', 'documentHistory'], ['Restore Document Version…', 'restoreDocumentVersion']].map(([label, command]) => ({label, command: {command: 'readymade.' + command, title: label, arguments: [row.id]}}))]}))]}];
  }
  watch(): vscode.Disposable {return {dispose() {}};}
  stat(value: vscode.Uri): vscode.FileStat {const row = this.store.get(this.key(value)); return {type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: Buffer.byteLength(row.body)};}
  readDirectory(): [string, vscode.FileType][] {return [];}
  readFile(value: vscode.Uri): Uint8Array {return Buffer.from(this.store.get(this.key(value)).body);}
  writeFile(value: vscode.Uri, content: Uint8Array): void {this.store.save(this.key(value), new TextDecoder('utf-8', {fatal: true}).decode(content)); this.changed();}
  delete(): never {throw vscode.FileSystemError.NoPermissions('Retained document drafts cannot be deleted here.');}
  rename(): never {return this.delete();}
  createDirectory(): never {return this.delete();}
  dispose(): void {this.closed = true; void this.bound?.transport.close(); this.registrations.forEach(r => r.dispose()); this.changes.dispose();}
}
