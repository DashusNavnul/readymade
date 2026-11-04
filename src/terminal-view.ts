import * as vscode from 'vscode';
import { ShipTerminalSession } from './terminal-session';
import { HistoricalTerminalFilter } from './terminal-filter';

export class ShipTerminalView implements vscode.Pseudoterminal {
  private readonly writes = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writes.event;
  private readonly filter = new HistoricalTerminalFilter();
  private disposed = false; private opened = false;
  constructor(readonly session: ShipTerminalSession) {
    session.onOutput = output => {
      if (this.disposed) return;
      if (output.reset) { this.filter.reset(); this.writes.fire('\x1bc'); }
      const text = this.filter.feed(output.data, output.historical);
      if (text) this.writes.fire(text);
    };
  }
  open(_dimensions?: vscode.TerminalDimensions): void {
    if (this.disposed || this.opened) return;
    this.opened = true;
    this.writes.fire('Readymade ship terminal — observe only. Use Attach and Take Control to type.\r\n');
    void this.session.observe().catch(() => this.message(this.session.notice));
  }
  close(): void {
    if (this.disposed) return;
    this.disposed = true; this.session.close(); this.filter.reset(); this.writes.dispose();
  }
  handleInput(data: string): void {
    if (this.disposed || !this.session.canInput) return;
    void this.session.input(data).catch(() => this.message(this.session.notice));
  }
  setDimensions(dimensions: vscode.TerminalDimensions): void {
    if (this.disposed || !this.session.canInput) return;
    void this.session.resize(dimensions.rows, dimensions.columns).catch(() => this.message(this.session.notice));
  }
  private message(text: string): void { if (!this.disposed) this.writes.fire('\r\n[Readymade] ' + text + '\r\n'); }
}
