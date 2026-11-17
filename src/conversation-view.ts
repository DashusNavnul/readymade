import * as vscode from 'vscode';
import { ConversationStore, type RequestEntry } from './conversation-store';
import { JsonObject } from './protocol';
import {NativeSessionHistory, type NativeHistoryConnection} from './native-session-history';

/** Plain text projection avoids active ship HTML or a second application shell. */
export class ConversationView implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('Readymade · Pataphor');
  private epoch = 0;
  render(snapshot: JsonObject, journal: ConversationStore, native?: NativeHistoryConnection): void {
    const epoch = ++this.epoch;
    const conversation = snapshot.conversation as JsonObject | undefined;
    const entries = Array.isArray(conversation?.entries) ? conversation.entries as JsonObject[] : [];
    this.output.clear();
    this.output.appendLine(`Readymade · ${String(snapshot.ship ?? journal.origin)}`);
    this.output.appendLine('Ship conversation previews. Request acceptance and execution are separate.\n');
    for (const e of entries) {
      this.output.appendLine(`[${String(e.id)} · ${String(e.status)}] ${String(e.request)}`);
      if (typeof e.output === 'string') this.output.appendLine(e.output);
      if (Number(e.outputBytes) > Buffer.byteLength(String(e.output ?? ''))) this.output.appendLine('[output preview truncated by ship]');
      this.output.appendLine('');
    }
    this.output.appendLine('Active local submission receipts (settled receipts may also be retained here):');
    for (const e of journal.entries) this.output.appendLine(`${e.id} · ${e.destination} · ${e.status}${e.reason ? ' · ' + e.reason : ''}`);
    const candidates = Array.isArray(snapshot.candidates) ? snapshot.candidates as JsonObject[] : [];
    this.output.appendLine('\nShip candidates (observed only):');
    for (const c of candidates) this.output.appendLine(`${String(c.id)} · ${String(c.project)} · ${String(c.stage)}`);
    this.output.show(true);
    void this.browse(journal, epoch, native).catch(error => {
      if (this.epoch === epoch && (!native || native.current())) void vscode.window.showErrorMessage('Receipt history unavailable: ' + (error instanceof Error ? error.message : 'Read failed'));
    });
  }
  private detail(journal: ConversationStore, entry: RequestEntry, archive?: string): void {
    this.output.clear();
    this.output.appendLine(`${archive ? 'Archived' : 'Active journal'} receipt · ${journal.origin}`);
    this.output.appendLine('Local historical evidence. Acceptance does not prove execution or deployment.');
    this.output.appendLine(`${entry.id} · ${entry.destination} · ${entry.status} · ${entry.at}`);
    if (archive) this.output.appendLine(`Archive SHA256: ${archive}`);
    this.output.appendLine('\nRequest:\n' + entry.text);
    if (entry.reason) this.output.appendLine('\nRecorded reason:\n' + entry.reason);
    this.output.show(true);
  }
  private async browse(journal: ConversationStore, epoch: number, native?: NativeHistoryConnection): Promise<void> {
    type Choice = vscode.QuickPickItem & {entry?: RequestEntry; archive?: string; next?: boolean; native?: boolean};
    const choice = (entry: RequestEntry, archive?: string): Choice => ({label: entry.id,
      description: `${entry.status} · ${entry.destination} · ${entry.at}`, detail: entry.text, entry, archive});
    const selected = await vscode.window.showQuickPick<Choice>([
      {label: 'Browse archived receipts…', description: 'Read-only local history; no requests sent', next: true},
      ...(native ? [{label: 'Browse native archived sessions…', description: `Read-only history retained on ${native.owner}`, native: true}] : []),
      ...journal.entries.map(entry => choice(entry))
    ], {title: 'Pataphor Submission Receipts', placeHolder: 'Choose an active receipt or open archived history'});
    if (epoch !== this.epoch || !selected) return;
    if (selected.native && native) {await this.browseNative(native, epoch); return;}
    if (selected.entry) {this.detail(journal, selected.entry); return;}
    let number = 0;
    for await (const page of journal.archivePages()) {
      if (epoch !== this.epoch) return;
      number++;
      const choices: Choice[] = page.rows.map(row => choice(row.entry, row.archive));
      if (!page.complete) choices.push({label: 'Read next archive page…', next: true});
      if (!choices.length) {
        void vscode.window.showInformationMessage(number === 1 ? 'No archived receipts for this connection.' : 'End of observed archive directory.'); return;
      }
      // Keep this bounded page open after inspecting a receipt; advance only on an explicit choice.
      while (epoch === this.epoch) {
        const row = await vscode.window.showQuickPick(choices, {title: `Archived Receipts · Page ${number}`,
          placeHolder: `${page.examined} directory entries examined · ${page.complete ? 'end observed' : 'more entries may remain'} · file order, not chronological · reopen for newly saved archives`});
        if (epoch !== this.epoch || !row) return;
        if (row.next) break;
        if (row.entry) this.detail(journal, row.entry, row.archive);
      }
    }
  }
  private async browseNative(connection: NativeHistoryConnection, epoch: number): Promise<void> {
    const current = () => epoch === this.epoch && connection.current();
    const history = new NativeSessionHistory({...connection, current});
    for await (const page of history.pages()) {
      if (!current()) return;
      type Choice = vscode.QuickPickItem & {session?: string; next?: boolean};
      const choices: Choice[] = page.sessionIds.map(session => ({label: session, session}));
      if (page.next !== null) choices.push({label: 'Read next native session page…', next: true});
      if (!choices.length) {void vscode.window.showInformationMessage('No native archived sessions in this ship archive.'); return;}
      while (current()) {
        const selected = await vscode.window.showQuickPick(choices, {title: `Native Archived Sessions · ${connection.owner}`,
          placeHolder: `All projects · ${page.offset + 1}–${page.offset + page.sessionIds.length} · archive revision ${page.head.revision} · index order`});
        if (!current() || !selected) return;
        if (selected.next) break;
        if (!selected.session) return;
        let first = true;
        for await (const detail of history.history(selected.session)) {
          if (!current()) return;
          if (first) {
            this.output.clear();
            this.output.appendLine(`Native archived session · ${detail.owner} · ${detail.session}`);
            this.output.appendLine(`Project: ${detail.project}\nPhase: ${detail.phase}`);
            this.output.appendLine('Read-only retained native history. This does not resume a session or grant actions.');
            this.output.appendLine('\nObjective:\n' + detail.objective);
            this.output.appendLine('\nSummary:\n' + detail.summary + '\n');
            first = false;
          }
          for (const record of detail.records) {
            this.output.appendLine(`[${record.sequence} · ${record.kind} · ${record.id}]\n${record.text}`);
            if (record.file) this.output.appendLine('Retained file evidence:\n' + JSON.stringify(record.file, null, 2));
            if (record.context) this.output.appendLine('Retained request context:\n' + JSON.stringify(record.context, null, 2));
            this.output.appendLine('');
          }
          this.output.appendLine(detail.more ? '[More retained records available below.]' : '[End of retained native history.]');
          this.output.show(true);
          if (!detail.more) break;
          const next = await vscode.window.showQuickPick([{label: 'Read next native history page…', next: true},
            {label: 'Back to archived sessions', next: false}], {title: 'Native Session History', placeHolder: 'Read the next retained page only when selected'});
          if (!current()) return;
          if (!next?.next) break;
        }
      }
    }
  }
  dispose(): void { this.epoch++; this.output.dispose(); }
}
