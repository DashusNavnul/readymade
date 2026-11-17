import * as vscode from 'vscode';

/** How often one unchanged text is announced again when the document still does not show it. */
const SAME_TEXT_TRIES = 3;
interface Flight {readonly timer: NodeJS.Timeout; readonly text: string; readonly tries: number}
const lines = (text: string): string => text.replace(/\r\n?/g, '\n');

/**
 * Announces changes of provider-backed documents one at a time.
 *
 * The editor updates such a document by working out a small edit in the background. When three changes to one
 * document overlap it loses track of the middle one: a cancelled update that finishes clears the marker of the
 * update that replaced it, so the next change no longer cancels that one, and the last edit is applied to a text
 * it was not worked out for. The document is left as the new text with part of an older text attached (measured:
 * "insert 1,505 characters at offset 1" applied to a 1,091-character document).
 *
 * So a change is announced only when the previous one has reached the document. Changes that arrive meanwhile
 * need no queue: when the one in flight lands, the newest text is announced if the document does not show it.
 * The same check repairs a document that still came out wrong, a bounded number of times.
 */
export class SettledDocuments implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  /** The content provider's `onDidChange`. */
  readonly onDidChange = this.emitter.event;
  private readonly flights = new Map<string, Flight>();
  private readonly watch: vscode.Disposable;
  private closed = false;
  /**
   * `text`: what a document should show now, or undefined when it is not one of the caller's.
   * `quietMs`: how long to wait for the editor to report a change before looking at the document anyway.
   */
  constructor(private readonly text: (uri: vscode.Uri) => string | undefined, private readonly quietMs = 2000) {
    this.watch = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.contentChanges.length && this.flights.has(event.document.uri.toString())) this.settle(event.document.uri);
    });
  }
  /** The text of this document changed. Call it as often as the text changes. */
  changed(uri: vscode.Uri): void {
    // While one change is on its way, the newest text is picked up when that one lands.
    if (this.closed || this.flights.has(uri.toString())) return;
    this.announce(uri, 0);
  }
  /** Documents with a change on its way to the editor now. */
  get inFlight(): number {return this.flights.size;}
  private announce(uri: vscode.Uri, tries: number): void {
    const key = uri.toString(), text = this.text(uri), shown = vscode.workspace.textDocuments.find(document => document.uri.toString() === key);
    clearTimeout(this.flights.get(key)?.timer); this.flights.delete(key);
    if (text === undefined) return;
    // No editor holds it, so nothing can overlap; the editor asks for the text when it opens the document.
    if (!shown) {this.emitter.fire(uri); return;}
    if (lines(shown.getText()) === lines(text)) return;
    this.flights.set(key, {text, tries, timer: setTimeout(() => this.settle(uri), this.quietMs)});
    this.emitter.fire(uri);
  }
  /** A change reached the document, or none did for a while: announce the newest text unless the document shows it. */
  private settle(uri: vscode.Uri): void {
    const key = uri.toString(), flight = this.flights.get(key);
    if (!flight || this.closed) return;
    const tries = this.text(uri) === flight.text ? flight.tries + 1 : 0;
    if (tries > SAME_TEXT_TRIES) {clearTimeout(flight.timer); this.flights.delete(key); return;}
    this.announce(uri, tries);
  }
  dispose(): void {
    this.closed = true;
    for (const flight of this.flights.values()) clearTimeout(flight.timer);
    this.flights.clear(); this.watch.dispose(); this.emitter.dispose();
  }
}
