'use strict';
// Installed in an isolated profile as an ordinary extension. Development and
// extension-test windows disable normal backup paths and cannot prove hot exit.
const vscode = require('vscode'), fs = require('node:fs'), assert = require('node:assert/strict');
const path = require('node:path');
const root = path.dirname(path.dirname(__dirname));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const save = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
module.exports.activate = async function () {
  try {
    const extension = vscode.extensions.getExtension('pataphor.readymade-ship-workspace');
    assert.ok(extension); assert.equal(fs.realpathSync(extension.extensionPath), fs.realpathSync(config.extension));
    const api = await extension.activate(); assert.equal(api.client, undefined);
    const hotExit = vscode.workspace.getConfiguration('files').get('hotExit'); assert.equal(hotExit, 'onExit');
    if (config.stage === 'write') {
      assert.equal(api.drafts.list().length, 0);
      const row = api.drafts.create(config.snapshot);
      const editor = await vscode.window.showTextDocument(vscode.Uri.parse(row.uri), {preview: false});
      const expected = row.text + '\n:: unsaved restart test — λ 🙂\n';
      assert.equal(await editor.edit(edit => edit.replace(new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)), expected)), true);
      assert.equal(editor.document.isDirty, true); assert.equal(editor.document.getText(), expected);
      assert.deepEqual(api.drafts.get(row.id), row);
      save('before.json', {uri: row.uri, row, expected, hotExit, pid: process.pid, stage: 'unsaved'});
      await new Promise(resolve => setTimeout(resolve, 2500));
    } else {
      assert.equal(config.stage, 'read');
      const before = JSON.parse(fs.readFileSync(path.join(root, 'before.json'), 'utf8'));
      assert.deepEqual(api.drafts.get(before.uri), before.row);
      const savedRow = api.tree.rows.find(row => row.id === 'saved-drafts');
      assert.equal(savedRow?.command?.command, 'readymade.openSavedDraft');
      const project = api.selectedProject, session = api.selectedSession;
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({content: ''}));
      const opened = vscode.commands.executeCommand('readymade.openSavedDraft');
      let deadline;
      try {
        await Promise.race([Promise.all([opened, (async () => {
          await new Promise(resolve => setTimeout(resolve, 300));
          await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        })()]), new Promise((_, reject) => {deadline = setTimeout(() => reject(new Error('Saved draft picker did not finish')), 10000);})]);
      } finally {clearTimeout(deadline);}
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor); assert.equal(editor.document.uri.toString(), before.uri);
      assert.equal(api.selectedProject, project); assert.equal(api.selectedSession, session);
      assert.equal(editor.document.getText(), before.expected);
      assert.equal(editor.document.isDirty, true);
      assert.deepEqual(api.drafts.get(before.uri), before.row);
      assert.notEqual(process.pid, before.pid); assert.equal(api.client, undefined);
      save('result.json', {passed: true, uri: before.uri, exactUnsavedText: true, dirty: true,
        savedJournalUnchanged: true, sourceBindingUnchanged: true, offline: true, savedDraftPicker: true,
        disconnectedWorkspaceEntry: true, projectAndSessionUnchanged: true,
        previousPid: before.pid, currentPid: process.pid, hotExit});
    }
  } catch (error) { save('failure-' + config.stage + '.json', {passed: false, message: error.message, stack: error.stack}); }
  await vscode.commands.executeCommand('workbench.action.quit');
};
