import * as vscode from 'vscode';
import type {DraftStore} from './draft-store';
import type {ShipClient} from './ship-client';
import type {SourceLoader} from './source-loader';
import {sourceBasis, sameBasis, type SourceStore} from './source-store';

export async function reconcileDraftView(deps: {drafts: DraftStore; sources: SourceStore; loader: SourceLoader;
  client: ShipClient; project: string; active(): boolean; changed(): void}): Promise<void> {
  const document = vscode.window.activeTextEditor?.document;
  if (!document || document.uri.scheme !== 'readymade-draft') throw new Error('Open the draft you want to reconcile first.');
  const old = deps.drafts.get(document.uri.toString()), version = document.version, text = document.getText();
  if (old.snapshot.origin !== deps.client.origin) throw new Error('Draft belongs to another ship.');
  if (old.pending) throw new Error('Observe the retained candidate intent before reconciling this draft.');
  const active = () => deps.active() && !document.isClosed && document.version === version;
  const check = () => {if (!active()) throw new Error('Draft or workspace changed while reading. Reconcile again with the current buffer.');};
  check();
  const state = await deps.client.codingState(old.snapshot.session); check();
  const sessions = state.sessions.filter(row => row.id === old.snapshot.session);
  if (!state.ready || state.owner !== old.snapshot.ship || state.session !== old.snapshot.session ||
      sessions.length !== 1 || sessions[0].project !== deps.project) throw new Error('Draft session is outside the current project.');
  const basis = sourceBasis(sessions[0].source);
  if (basis.id === old.snapshot.source.id) throw new Error('The source is unchanged. Continue editing this draft.');
  let source = deps.sources.sources().find(row => row.session === old.snapshot.session && row.path === old.snapshot.path &&
    row.ship === old.snapshot.ship && row.source.id === basis.id && sameBasis(row.source, basis));
  if (!source) source = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
    title: 'Reading current source for reconciliation', cancellable: true}, (progress, token) =>
    deps.loader.load(old.snapshot.session, basis, old.snapshot.path, deps.project, {
      active: () => active() && !token.isCancellationRequested,
      progress: value => progress.report({message: value ? `${value.lines}/${value.total} lines` : 'Reading source…'}),
    }));
  check(); if (!source) return;
  const observed = await deps.client.codingState(old.snapshot.session); check();
  const result = deps.drafts.reconcile(old.id, deps.sources.openSnapshot(source), text, observed, deps.project);
  if (result.kind === 'conflict') {
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.parse(source.uri), document.uri,
      `${old.snapshot.path} · Current source ↔ your draft`, {preview: false});
    check();
    const choice = await vscode.window.showWarningMessage(`${result.conflicts.length} overlapping edit(s). Both versions are preserved. Create a resolution draft from current source, then copy and edit the original changes you want to keep.`, 'Create Resolution Draft');
    if (choice !== 'Create Resolution Draft') return;
    check();
    const fresh = await deps.client.codingState(old.snapshot.session); check();
    // Seed the explicit resolution buffer with current source, retaining all
    // remote changes. The original unsaved document remains the comparison.
    const resolved = deps.drafts.reconcile(old.id, deps.sources.openSnapshot(source), old.snapshot.text, fresh, deps.project);
    if (resolved.kind !== 'merged') throw new Error('Resolution source could not be retained.');
    deps.changed();
    if (!deps.active()) return;
    await vscode.commands.executeCommand('vscode.diff', document.uri, vscode.Uri.parse(resolved.draft.uri),
      `${old.snapshot.path} · Original edits ↔ resolution draft`, {preview: false});
    if (deps.active()) void vscode.window.showInformationMessage('Edit the resolution draft on the right, save it, then prepare its candidate. The original draft remains preserved.');
    return;
  }
  deps.changed();
  const mergedDocument = await vscode.workspace.openTextDocument(vscode.Uri.parse(result.draft.uri));
  if (!deps.active()) return;
  await vscode.window.showTextDocument(mergedDocument);
  if (deps.active()) void vscode.window.showInformationMessage('Reconciled into a separate draft on the current source. Your original draft is preserved; nothing was submitted.');
}
