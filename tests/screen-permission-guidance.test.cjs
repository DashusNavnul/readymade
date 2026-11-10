'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {confirmCapture} = require('../platform/media-session.cjs');
function fixture(status, response) {
  const opened = [], shown = [], reads = [];
  const electron = {
    BrowserWindow: {fromWebContents: () => null},
    systemPreferences: {getMediaAccessStatus: kind => { reads.push(kind); if (status instanceof Error) throw status; return status; }},
    dialog: {showMessageBox: async options => { shown.push(options); return response; }},
    shell: {openExternal: async url => { opened.push(url); }}
  };
  return {electron, opened, shown, reads};
}
const request = {securityOrigin: 'https://ship.example', audioRequested: true};
const capabilities = {nativePicker: true, loopback: true};
test('denied screen access offers normal Settings navigation without selecting a source or granting capture', async () => {
  const f = fixture('denied', {response: 2, checkboxChecked: true});
  assert.equal(await confirmCapture(f.electron, request, {}, capabilities), null);
  assert.deepEqual(f.reads, ['screen']);
  assert.deepEqual(f.opened, ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
  assert.deepEqual(f.shown[0].buttons, ['Cancel', 'Choose screen or window', 'Open Screen Recording Settings']);
  assert.match(f.shown[0].detail, /currently reports.*denied/);
  assert.equal(f.shown[0].defaultId, 0); assert.equal(f.shown[0].cancelId, 0);
  assert.equal(f.shown[0].checkboxChecked, false);
});
test('permission guidance preserves explicit picker choice and audio consent even when system status is denied', async () => {
  for (const checked of [false, true]) {
    const f = fixture('denied', {response: 1, checkboxChecked: checked});
    assert.deepEqual(await confirmCapture(f.electron, request, {}, capabilities), {audio: checked});
    assert.deepEqual(f.opened, []);
  }
  const f = fixture('denied', {response: 0});
  assert.equal(await confirmCapture(f.electron, request, {}, capabilities), null);
  assert.deepEqual(f.opened, []);
});
test('granted, unknown and unreadable system state never invent denial or offer unavailable Settings action', async () => {
  for (const status of ['granted', 'not-determined', 'restricted', new Error('unsupported')]) {
    const f = fixture(status, {response: 2});
    assert.equal(await confirmCapture(f.electron, request, {}, capabilities), null);
    assert.deepEqual(f.shown[0].buttons, ['Cancel', 'Choose screen or window']);
    assert.equal(f.shown[0].detail, undefined); assert.deepEqual(f.opened, []);
  }
  const f = fixture('denied', {response: 1, checkboxChecked: true});
  assert.deepEqual(await confirmCapture(f.electron, request, {}, {nativePicker: false, loopback: false}), {audio: false});
  assert.deepEqual(f.reads, []); assert.deepEqual(f.opened, []);
});
