import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {createHash, randomBytes} from 'node:crypto';

const checks = String.raw`
(async () => {
  const api = acquireVsCodeApi();
  const check = (value, name) => {if (!value) throw new Error(name); api.postMessage({checkpoint: name});};
  try {
    check(window.PataphorCM6 && window.PataphorEditor, 'Both scripts loaded');
    const element = document.getElementById('editor');
    const text = '|=  a=@ud\n(add a 1)\n';
    const editor = window.PataphorEditor.attach(element, {value: text, filename: '/lib/example/hoon'});
    const view = window.PataphorCM6.EditorView.findFromDOM(element.querySelector('.cm-content'));
    check(view && editor.value === text, 'Initial Hoon document');
    check(editor.readOnly && view.contentDOM.contentEditable === 'false', 'Read-only DOM');
    let inputs = 0, selections = 0;
    element.addEventListener('input', () => inputs++);
    element.addEventListener('select', () => selections++);
    editor.value = 'one\ntwo\nthree\n';
    check(inputs === 0 && editor.value === 'one\ntwo\nthree\n', 'Programmatic replacement suppresses input');
    editor.setSelection({anchor: 0, head: 3});
    check(editor.getSelection().head === 3 && selections === 0, 'Programmatic selection');
    editor.setSelection({anchor: -1, head: 9999});
    check(editor.getSelection().head === 3, 'Invalid selection refused');
    editor.readOnly = false;
    check(!view.state.readOnly && view.contentDOM.contentEditable === 'true', 'Editable DOM');
    view.dispatch({changes: {from: 0, to: 3, insert: 'first'}, userEvent: 'input.type'});
    check(inputs === 1 && editor.value.startsWith('first\n'), 'Editor transaction emits input');
    view.dispatch({selection: {anchor: 6}});
    check(selections > 0 && editor.getSelection().anchor === 6, 'Editor selection emits select');
    const changed = editor.value;
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {key: 'z', code: 'KeyZ', metaKey: true, ctrlKey: false, bubbles: true, cancelable: true}));
    check(editor.value !== changed && editor.value.startsWith('one\n'), 'Undo keymap restores edit');
    editor.readOnly = true;
    check(view.state.readOnly && view.contentDOM.contentEditable === 'false', 'Read-only restored');
    const languages = ['example.hoon', '/lib/example/hoon', 'example.js', 'example.ts', 'example.json', 'example.css', 'example.txt'];
    for (const language of languages) editor.setLanguage(language);
    editor.revealLine(2);
    check(editor.getSelection().anchor === editor.value.indexOf('\n') + 1, 'Reveal line selection');
    check(element.querySelector('.cm-content') && view.dom.getBoundingClientRect().height > 0, 'Rendered editor');
    const destroyFirst = editor.destroy;
    destroyFirst();
    check(!element.querySelector('.cm-editor'), 'Destroy removes DOM');
    check(!Object.hasOwn(element, 'value') && !Object.hasOwn(element, 'readOnly'), 'Destroy removes accessors');
    const second = window.PataphorEditor.attach(element, {value: 'fresh', filename: 'new.json', readOnly: false});
    destroyFirst();
    check(second.value === 'fresh' && !second.readOnly, 'Remount');
    check(element.querySelectorAll('.cm-editor').length === 1, 'Old destroy cannot remove remounted editor');
    second.destroy();
    api.postMessage({passed: true, languages, inputEvents: inputs, selectionEvents: selections,
      readonlyDOM: true, undoSyntheticKeyboard: true, selection: true, revealLine: true, destroyAndRemount: true,
      userAgent: navigator.userAgent, scope: 'Actual Chromium DOM; programmatic edit and synthetic undo event, not physical typing'});
  } catch (error) {api.postMessage({passed: false, error: String(error), stack: error.stack});}
})();`;

export async function run(): Promise<void> {
  const evidence = process.env.READYMADE_HOST_EVIDENCE!;
  let panel: vscode.WebviewPanel | undefined;
  let recorded = false;
  const checkpoints: string[] = [];
  try {
    const extension = vscode.extensions.getExtension('pataphor.readymade-ship-workspace'); assert.ok(extension);
    assert.ok(process.env.READYMADE_BUILTIN_EXTENSION);
    assert.equal(realpathSync(extension.extensionPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
    const bundlePath = process.env.READYMADE_CODEMIRROR_BUNDLE, adapterPath = process.env.READYMADE_CODEMIRROR_ADAPTER;
    assert.ok(bundlePath && adapterPath, 'Supply the exact candidate bundle and existing adapter');
    const bundle = readFileSync(bundlePath, 'utf8'), adapter = readFileSync(adapterPath, 'utf8');
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    panel = vscode.window.createWebviewPanel('readymade.codemirrorAcceptance', 'Readymade editor acceptance', vscode.ViewColumn.One, {enableScripts: true});
    const nonce = randomBytes(16).toString('hex');
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {subscription.dispose(); reject(new Error('Editor browser test timed out'));}, 30000);
      const subscription = panel!.webview.onDidReceiveMessage(message => {
        if (typeof message.checkpoint === 'string') {checkpoints.push(message.checkpoint); return;}
        clearTimeout(timer); subscription.dispose(); resolve(message);
      });
    });
    const script = (source: string) => `<script nonce="${nonce}">${source.replace(/<\/script/gi, '<\\/script')}</script>`;
    panel.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';"><style>#editor{height:400px}</style></head><body><div id="editor"></div>${script(bundle)}${script(adapter)}${script(checks)}</body></html>`;
    const observed = await result;
    writeFileSync(evidence, JSON.stringify({...observed, checkpoints, editor: vscode.version, bundlePath, adapterPath, bundleSHA256: hash(bundle), adapterSHA256: hash(adapter)}, null, 2), {mode: 0o600});
    recorded = true;
    assert.equal(observed.passed, true, String(observed.error));
  } catch (error) {
    if (!recorded) writeFileSync(evidence, JSON.stringify({passed: false, error: String(error), checkpoints}), {mode: 0o600});
    throw error;
  } finally {panel?.dispose();}
}
