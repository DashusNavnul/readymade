import * as vscode from 'vscode';
import { ConversationStore } from './conversation-store';
import { JsonObject } from './protocol';

/** Plain text projection avoids active ship HTML or a second application shell. */
export class ConversationView implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('Readymade · Pataphor');
  render(snapshot: JsonObject, journal: ConversationStore): void {
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
    this.output.appendLine('Local submission receipts:');
    for (const e of journal.entries) this.output.appendLine(`${e.id} · ${e.destination} · ${e.status}${e.reason ? ' · ' + e.reason : ''}`);
    const candidates = Array.isArray(snapshot.candidates) ? snapshot.candidates as JsonObject[] : [];
    this.output.appendLine('\nShip candidates (observed only):');
    for (const c of candidates) this.output.appendLine(`${String(c.id)} · ${String(c.project)} · ${String(c.stage)}`);
    this.output.show(true);
  }
  dispose(): void { this.output.dispose(); }
}
