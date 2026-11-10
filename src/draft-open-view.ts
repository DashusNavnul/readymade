import * as vscode from 'vscode';
import type {DraftStore} from './draft-store';

/** Explicit access to this computer's private drafts, without ship authority. */
export async function openSavedDraft(drafts: DraftStore, active: () => boolean, id?: string): Promise<void> {
  if (!active()) return;
  let selected = id;
  if (!selected) {
    const choices = drafts.list().map(row => ({
      label: row.snapshot.path,
      description: `${row.snapshot.ship} · ${row.snapshot.source.desk} · retained revision ${row.snapshot.source.number}`,
      detail: `${row.snapshot.origin} · source owner ${row.snapshot.source.owner} · session ${row.snapshot.session}` +
        (row.pending ? ' · Request retained; opening does not resend it' : ' · Local draft'),
      id: row.id,
    }));
    if (!choices.length) { await vscode.window.showInformationMessage('No saved local drafts on this computer.'); return; }
    selected = (await vscode.window.showQuickPick(choices, {title: 'Open saved local draft',
      placeHolder: 'Choose a retained draft. This does not connect or change the selected project.', matchOnDescription: true, matchOnDetail: true}))?.id;
  }
  if (!selected || !active()) return;
  const row = drafts.get(selected);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(row.uri));
  if (!active()) return;
  await vscode.window.showTextDocument(document, {preview: false});
}
