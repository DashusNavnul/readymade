import * as vscode from 'vscode';
import { DirectoryStore, type DirectoryListing } from './directory-store';
import type { ShipClient } from './ship-client';
import type { MediaTreeRow } from './media-workbench';
import type { PageJournal } from './source-pager';
import { validPath } from './source-store';

/** Native tree presentation. Expanding an already listed folder never sends a tool. */
export class DirectoryView {
  private store?: DirectoryStore;
  private client?: ShipClient;
  private listing?: DirectoryListing;
  constructor(private readonly journal: PageJournal, private readonly project: () => string | undefined,
    private readonly changed: () => void) {}
  connect(client: ShipClient): void { this.client = client; this.store = new DirectoryStore(client, this.journal); this.listing = undefined; }
  async open(session?: string, directory?: string): Promise<void> {
    const client = this.client, store = this.store, project = this.project();
    if (!client || !store || !project) throw new Error('Connect and choose a project first.');
    const state = await client.codingState();
    const choices = state.sessions.filter(s => s.project === project && typeof s.id === 'string');
    const selected = session ?? (await vscode.window.showQuickPick(choices.map(s => ({label: String(s.id), description: project})), {title: 'Browse ship session files'}))?.label;
    if (!selected) return;
    if (!choices.some(s => s.id === selected)) throw new Error('Session is outside the selected project.');
    const target = directory ?? (session ? '/' : await vscode.window.showInputBox({
      title: 'Browse ship directory', value: '/',
      prompt: 'Use / for all source files, or a Clay directory such as /lib to narrow the listing.',
      validateInput: value => value === '/' || validPath(value) ? undefined : 'Enter / or an absolute Clay directory without empty or relative segments.'
    }));
    if (target === undefined) return;
    if (this.client !== client || this.store !== store || this.project() !== project) throw new Error('Connection or project changed while choosing a directory. Browse again.');
    const listing = await store.open(selected, project, target);
    if (this.client !== client || this.store !== store || this.project() !== project) return;
    this.listing = listing; this.changed();
    if (this.listing.next === 0 && !this.listing.pending && !this.listing.refusal) await this.next();
  }
  async refresh(): Promise<void> {
    const held = this.current(), store = this.store!;
    const listing = await store.refresh(held.binding);
    this.publish(store, held, listing);
  }
  async next(): Promise<void> {
    const held = this.current(), store = this.store!;
    let listing: DirectoryListing | undefined;
    try {
      listing = await store.next(held.binding);
    }
    finally {
      // Restore the pre-send marker even when delivery failed. No POST occurs here.
      if (!listing || listing.pending) listing = await store.refresh(held.binding);
      this.publish(store, held, listing);
    }
  }
  private publish(store: DirectoryStore, held: DirectoryListing, listing: DirectoryListing): void {
    if (this.store !== store || this.listing !== held || this.project() !== held.binding.project) return;
    this.listing = listing; this.changed();
  }
  rows(): MediaTreeRow[] {
    const browse = {label: 'Browse ship files…', command: {command: 'readymade.browseFiles', title: 'Browse files'}};
    const held = this.listing;
    if (!held || held.binding.project !== this.project() || held.binding.origin !== this.client?.origin) {
      return [{id: 'ship-files', label: 'Ship Files', icon: 'files', children: [browse]}];
    }
    const children: MediaTreeRow[] = [browse,
      {label: 'Refresh listing', command: {command: 'readymade.refreshFiles', title: 'Refresh listing'}}];
    if (held.pending) children.push({label: 'Waiting for retained result', description: 'Refresh to observe; no automatic resend'});
    else if (held.next !== null) children.push({label: held.refusal ? 'Retry listing' : 'Load more files', command: {command: 'readymade.moreFiles', title: 'Load directory page'}});
    if (held.refusal) children.push({label: `Refused: ${held.refusal.reason}`, tooltip: held.refusal.detail});
    const roots = new Map<string, MediaTreeRow>();
    for (const file of held.entries) {
      const parts = file.path.slice(1).split('/'); let rows = children, prefix = '';
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]; prefix += '/' + part;
        if (i === parts.length - 1) {
          rows.push({label: part, icon: 'file-code', description: file.blob, tooltip: file.path,
            command: {command: 'readymade.readFile', title: 'Read file', arguments: [file.path, held.binding.session, held.binding.source]}});
        } else {
          let folder = roots.get(prefix);
          if (!folder) { folder = {label: part, icon: 'folder', children: []}; roots.set(prefix, folder); rows.push(folder); }
          rows = folder.children!;
        }
      }
    }
    if (!held.entries.length && held.next === null) children.push({label: 'No files in this directory'});
    return [{id: 'ship-files', label: 'Ship Files', icon: 'files', description: `${held.entries.length}${held.next === null ? '' : '+'} · %${held.binding.source.desk}`, children}];
  }
  private current(): DirectoryListing {
    if (!this.store || !this.listing || this.listing.binding.project !== this.project() || this.listing.binding.origin !== this.client?.origin) throw new Error('Browse the selected project first.');
    return this.listing;
  }
}
