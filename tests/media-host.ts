import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { writeFileSync, realpathSync } from 'node:fs';
import { MediaController } from '../src/media-controller';
import type { ReadymadeWorkspace } from '../src/extension';
import type { JsonObject } from '../src/protocol';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let n = 0; n < 300; n++) { if (await check()) return; await wait(50); }
  throw new Error('Timed out: ' + label);
}
class CDP {
  private count = 0;
  private readonly pending = new Map<number, { resolve(value: JsonObject): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private readonly events: vscode.Disposable;
  private sessionId?: string;
  constructor(private readonly channel: vscode.BrowserCDPSession) {
    this.events = channel.onDidReceiveMessage(message => {
      const row = message as { id?: number; error?: unknown; result?: JsonObject };
      if (typeof row.id !== 'number') return;
      const item = this.pending.get(row.id); if (!item) return;
      this.pending.delete(row.id); clearTimeout(item.timer);
      if (row.error) item.reject(new Error('CDP request refused')); else item.resolve(row.result ?? {});
    });
  }
  async request(method: string, params: JsonObject = {}, target = this.sessionId): Promise<JsonObject> {
    const id = ++this.count;
    const reply = new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP response expired: ' + method)); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
    });
    await this.channel.sendMessage({ id, method, params, ...(target ? { sessionId: target } : {}) }); return reply;
  }
  async attach(url: string): Promise<void> {
    const result = await this.request('Target.getTargets');
    const targets = result.targetInfos as { type: string; url: string; targetId: string }[];
    const target = targets.find(t => t.type === 'page' && t.url === url); assert.ok(target, 'Managed page CDP target');
    const attached = await this.request('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    this.sessionId = String(attached.sessionId);
  }
  async evaluate(expression: string): Promise<unknown> {
    const reply = await this.request('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (reply.exceptionDetails) throw new Error('Managed page evaluation failed');
    return (reply.result as JsonObject).value;
  }
  async close(): Promise<void> { this.events.dispose(); await this.channel.close(); }
}
export async function run(): Promise<void> {
  const evidence = process.env.READYMADE_MEDIA_EVIDENCE; assert.ok(evidence);
  let controller: MediaController<vscode.BrowserTab> | undefined;
  let channel: CDP | undefined;
  let nativeName: string | undefined;
  const bootstrapDiagnostics: JsonObject[] = [];
  let foreignLeaks = 0, foreignRequests = 0, requests = 0, pageLoads = 0;
  const foreign = createServer((request, response) => { foreignRequests++; if (request.headers.cookie?.includes('urbauth-')) foreignLeaks++; response.end(''); });
  foreign.listen(0, '127.0.0.1'); await once(foreign, 'listening');
  const foreignAddress = foreign.address(); assert.ok(foreignAddress && typeof foreignAddress !== 'string');
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.method, 'GET');
    if (!request.url?.startsWith('/apps/')) { response.writeHead(204); response.end(); return; }
    pageLoads++;
    if (!request.headers.cookie?.includes('urbauth-~zod=fixture-browser-cookie')) { response.writeHead(401); response.end('no browser login'); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><title>Retained fixture</title><canvas id="canvas" width="8" height="8"></canvas><a id="note" href="/apps/noltbook/?note=fixture%20note#room=alpha" target="_blank">Note</a><img src="http://127.0.0.1:${foreignAddress.port}/leak"><script>window.identity=crypto.randomUUID();window.fixtureTrack=document.getElementById('canvas').captureStream(1).getVideoTracks()[0];</script>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const extension = vscode.extensions.getExtension<ReadymadeWorkspace>('pataphor.readymade-ship-workspace'); assert.ok(extension);
    if (process.env.READYMADE_BUILTIN_EXTENSION) assert.equal(realpathSync(extension.extensionUri.fsPath), realpathSync(process.env.READYMADE_BUILTIN_EXTENSION));
    const api = await extension.activate();
    assert.ok(extension.packageJSON.contributes.viewsContainers.activitybar.some((view: { id: string }) => view.id === 'readymade'));
    assert.equal(extension.packageJSON.contributes.views.readymade[0].id, 'readymade.workspace');
    await vscode.commands.executeCommand('workbench.view.extension.readymade');
    await vscode.commands.executeCommand('readymade.workspace.focus');
    assert.ok(api.media.rows().some(row => row.command?.command === 'readymade.glurff'));
    assert.ok(api.media.rows().some(row => row.command?.command === 'readymade.noltbook'));
    const hostStatus = await api.media.bridge.request('status');
    assert.equal(typeof hostStatus.nativeName, 'string'); nativeName = hostStatus.nativeName as string;
    if (process.env.READYMADE_BUILTIN_EXTENSION) assert.equal(nativeName, 'Readymade Workspace', 'Production native Keychain namespace');
    const { NativeMediaBrowser } = await import(join(extension.extensionUri.fsPath, 'dist/src/media-browser.js')) as typeof import('../src/media-browser');
    const browser = new NativeMediaBrowser(api.media.bridge);
    const tabs: vscode.BrowserTab[] = [];
    const events: JsonObject[] = [];
    const progress = (stage: string, error?: unknown) => { events.push({ stage, error: error instanceof Error ? error.message : undefined }); writeFileSync(evidence + '.progress.json', JSON.stringify(events, null, 2), { mode: 0o600 }); };
    controller = new MediaController({
      client: { origin, signIn: async () => { throw new Error('Fixture must not prompt or sign in'); }, browserCookies: () => [{ name: 'urbauth-~zod', value: 'fixture-browser-cookie' }] },
      bridge: { request: async (op, payload) => {
        progress('bridge-' + op);
        try { const result = await api.media.bridge.request(op, payload); progress('bridge-' + op + '-done'); return result; }
        catch (error) {
          if (op === 'bind') {
            try {
              const status = await api.media.bridge.request('status');
              const diagnostic = { stage: 'bind-bootstrap-status', bootstrapViews: status.bootstrapViews ?? [] };
              bootstrapDiagnostics.push(diagnostic); events.push(diagnostic); progress('bind-bootstrap-status-recorded');
            } catch { progress('bind-bootstrap-status-unavailable'); }
          }
          progress('bridge-' + op + '-failed', error); throw error;
        }
      } },
      browser: { open: async url => {
        progress('browser-open');
        try {
          const tab = await browser.open(url); tabs.push(tab);
          const safeURL = /^about:blank(?:#readymade-[a-f0-9]{32})?$/.test(tab.url) ? tab.url : '[not a bootstrap URL]';
          const status = await api.media.bridge.request('status');
          const diagnostic: JsonObject = { stage: 'browser-opened-bootstrap', tabURL: safeURL, expectedURL: url,
            active: browser.isActive(tab), bootstrapViews: status.bootstrapViews ?? [] };
          bootstrapDiagnostics.push(diagnostic); events.push(diagnostic); progress('browser-opened'); return tab;
        } catch (error) { progress('browser-open-failed', error); throw error; }
      },
        reveal: tab => browser.reveal(tab), close: tab => browser.close(tab), isClosed: tab => browser.isClosed(tab), isActive: tab => browser.isActive(tab), retained: url => browser.retained(url) }
    });
    api.media.controller = controller;
    let opened = await controller.open('glurff');
    if (opened.phase !== 'bound' || !opened.ready) {
      progress('initial-binding-observation', opened.fault);
      opened = await controller.observe(opened.bindingId);
    }
    assert.equal(opened.phase, 'bound', opened.fault); assert.equal(opened.ready, true);
    await until(() => controller!.state().some(row => row.bindingId === opened.bindingId && row.title === 'Retained fixture'), 'Browser metadata after native navigation');
    const originalController = api.media.controller;
    try {
      api.media.controller = controller;
      const row = api.media.rows().find(row => row.id === 'open-apps')?.children?.[0];
      assert.equal(row?.bindingId, opened.bindingId);
      assert.equal(row?.label, 'Retained fixture');
      await vscode.commands.executeCommand('readymade.mediaObserve', row);
      assert.equal(controller.state()[0]?.ready, true, 'Native row action targets its retained app without a picker');
    } finally { api.media.controller = originalController; }
    await until(() => browser.isActive(tabs[0]), 'Initial managed browser focus');
    const companionGroups = vscode.window.tabGroups.all.length;
    channel = new CDP(await tabs[0].startCDPSession()); await channel.attach(origin + '/apps/glurff/');
    if (process.env.READYMADE_REAL_CAPTURE === '1') {
      const audio = process.env.READYMADE_REAL_AUDIO === '1';
      await channel.evaluate(`(() => {
        window.captureProof = { pending: true };
        navigator.mediaDevices.getUserMedia({ video: true, audio: ${audio} }).then(async stream => {
          window.realCapture = stream;
          const deadline = setTimeout(() => stream.getTracks().forEach(t => t.stop()), 15000);
          let sender, receiver, audioContext;
          try {
            const video = document.createElement('video'); video.muted = true; video.srcObject = stream;
            document.body.appendChild(video); await video.play();
            let peerProof;
            const decodedAudio = { samples: 0, peak: 0 };
            if (${audio}) {
              sender = new RTCPeerConnection({ iceServers: [] });
              receiver = new RTCPeerConnection({ iceServers: [] });
              audioContext = new AudioContext();
              await audioContext.resume();
              receiver.ontrack = event => {
                if (event.track.kind !== 'audio') return;
                const source = audioContext.createMediaStreamSource(new MediaStream([event.track]));
                const sink = audioContext.createScriptProcessor(2048, 1, 1);
                sink.onaudioprocess = block => {
                  const samples = block.inputBuffer.getChannelData(0);
                  decodedAudio.samples += samples.length;
                  for (const value of samples) decodedAudio.peak = Math.max(decodedAudio.peak, Math.abs(value));
                  block.outputBuffer.getChannelData(0).fill(0);
                };
                source.connect(sink); sink.connect(audioContext.destination);
                window.audioTestSink = {source, sink};
              };
              sender.onicecandidate = event => { if (event.candidate) receiver.addIceCandidate(event.candidate).catch(() => {}); };
              receiver.onicecandidate = event => { if (event.candidate) sender.addIceCandidate(event.candidate).catch(() => {}); };
              stream.getTracks().forEach(track => sender.addTrack(track, stream));
              await sender.setLocalDescription(await sender.createOffer());
              await receiver.setRemoteDescription(sender.localDescription);
              await receiver.setLocalDescription(await receiver.createAnswer());
              await sender.setRemoteDescription(receiver.localDescription);
              const start = Date.now();
              while (receiver.connectionState !== 'connected' && Date.now() - start < 7000)
                await new Promise(resolve => setTimeout(resolve, 100));
              await new Promise(resolve => setTimeout(resolve, 2500));
              const inbound = [];
              (await receiver.getStats()).forEach(report => {
                if (report.type === 'inbound-rtp') inbound.push({kind:report.kind, packetsReceived:report.packetsReceived,
                  bytesReceived:report.bytesReceived, framesDecoded:report.framesDecoded,
                  totalSamplesReceived:report.totalSamplesReceived, totalAudioEnergy:report.totalAudioEnergy});
              });
              peerProof = {scope:'same-machine WebRTC transport; not Glurff signaling or a remote participant',
                sender:sender.connectionState, receiver:receiver.connectionState, audioContext:audioContext.state, decodedAudio, inbound};
              sender.close(); receiver.close();
              peerProof.closed = sender.connectionState === 'closed' && receiver.connectionState === 'closed';
            } else await new Promise(resolve => setTimeout(resolve, 2500));
            const tracks = stream.getTracks().map(t => ({ kind: t.kind, state: t.readyState, muted: t.muted }));
            const frames = video.getVideoPlaybackQuality().totalVideoFrames;
            stream.getTracks().forEach(t => t.stop());
            window.captureProof = { pending: false, tracks, frames, peerProof, width: video.videoWidth, height: video.videoHeight,
              stopped: stream.getTracks().every(t => t.readyState === 'ended') };
            video.srcObject = null; video.remove();
          } catch (error) { window.captureProof = { pending: false, error: error.name, message: error.message }; }
          finally { clearTimeout(deadline); sender?.close(); receiver?.close(); if (audioContext) await audioContext.close(); stream.getTracks().forEach(t => t.stop()); }
        }, error => { window.captureProof = { pending: false, error: error.name, message: error.message }; });
        return true;
      })()`);
      let capture: JsonObject = { pending: true };
      for (let n = 0; n < 120 && capture.pending; n++) {
        await wait(1000); capture = await channel.evaluate('window.captureProof') as JsonObject;
      }
      writeFileSync(evidence + '.capture.json', JSON.stringify(capture, null, 2), { mode: 0o600 });
      assert.equal(capture.pending, false, 'Camera/microphone permission is still waiting');
      assert.equal(capture.error, undefined, 'Real capture failed: ' + String(capture.error));
      assert.ok(Number(capture.frames) > 0, 'Camera delivered no video frames');
      assert.equal(capture.stopped, true, 'Camera/microphone tracks must stop');
      if (audio) {
        const peer = capture.peerProof as JsonObject;
        assert.equal(peer.sender, 'connected'); assert.equal(peer.receiver, 'connected');
        assert.equal(peer.closed, true);
        const inbound = peer.inbound as JsonObject[];
        assert.ok(inbound.some(row => row.kind === 'audio' && Number(row.packetsReceived) > 0), 'Remote peer received no audio packets');
        assert.ok(Number((peer.decodedAudio as JsonObject).samples) > 0, 'Remote audio sink received no samples');
        assert.ok(Number((peer.decodedAudio as JsonObject).peak) > 0, 'Remote microphone audio was entirely silent');
        assert.ok(inbound.some(row => row.kind === 'video' && Number(row.framesDecoded) > 0), 'Remote peer decoded no camera frames');
      }
    }
    const before = await channel.evaluate('({identity:window.identity,track:window.fixtureTrack.id,state:window.fixtureTrack.readyState,cookie:document.cookie})') as JsonObject;
    assert.equal(before.state, 'live'); assert.equal(before.cookie, '', 'Imported cookie must be HttpOnly');
    if (process.env.READYMADE_WINDOW_MOVE === '1') {
      await vscode.commands.executeCommand('workbench.action.focusWindow');
      await until(() => vscode.window.state.focused, 'Native workspace foreground focus');
      const doc = await vscode.workspace.openTextDocument({content: 'Window movement fixture'});
      await vscode.window.showTextDocument(doc, {viewColumn: vscode.ViewColumn.One});
      const mainGroup = vscode.window.tabGroups.activeTabGroup;
      await controller.reveal(opened.bindingId);
      const bindingBefore = await api.media.bridge.request('observe', {bindingId: opened.bindingId});
      const loads = pageLoads;
      const nativeWindows = (await api.media.bridge.request('status')).nativeWindowCount;
      assert.equal(typeof nativeWindows, 'number');
      const windowState = (stage: string) => {
        events.push({stage, closed:browser.isClosed(tabs[0]), active:browser.isActive(tabs[0]),
          groups:vscode.window.tabGroups.all.map(group => ({main:group===mainGroup, active:group===vscode.window.tabGroups.activeTabGroup,
            column:group.viewColumn, tabs:group.tabs.map(tab => ({active:tab===group.activeTab,preview:tab.isPreview,pinned:tab.isPinned,knownInput:tab.input!==undefined}))}))});
        progress(stage);
      };
      windowState('before-floating');
      const priorEditor = vscode.window.tabGroups.activeTabGroup.activeTab;
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      await until(async () => Number((await api.media.bridge.request('status')).nativeWindowCount) === Number(nativeWindows) + 1, 'Native floating window created');
      await until(() => !vscode.window.tabGroups.all.some(group => group.tabs.includes(priorEditor!)), 'App moved to a new editor group');
      await controller.reveal(opened.bindingId);
      assert.equal(browser.isActive(tabs[0]), true);
      windowState('after-floating');
      const floating = await channel.evaluate('({identity:window.identity,track:window.fixtureTrack.id,state:window.fixtureTrack.readyState})') as JsonObject;
      assert.equal(floating.identity, before.identity); assert.equal(floating.track, before.track); assert.equal(floating.state, 'live');
      await vscode.commands.executeCommand('workbench.action.switchToMainWindow');
      windowState('after-show-code');
      await until(() => vscode.window.tabGroups.activeTabGroup === mainGroup && !browser.isActive(tabs[0]), 'Code focused in main window before app shortcut');
      windowState('after-main-code-focus');
      await controller.reveal(opened.bindingId);
      assert.equal(browser.isActive(tabs[0]), true);
      const bindingFloating = await api.media.bridge.request('observe', {bindingId: opened.bindingId});
      assert.equal(bindingFloating.id, bindingBefore.id); assert.equal(bindingFloating.ready, true);
      await vscode.commands.executeCommand('workbench.action.moveEditorToFirstGroup');
      await until(() => vscode.window.tabGroups.activeTabGroup === mainGroup, 'App docked into main window group');
      await controller.reveal(opened.bindingId);
      assert.equal(browser.isActive(tabs[0]), true);
      const docked = await channel.evaluate('({identity:window.identity,track:window.fixtureTrack.id,state:window.fixtureTrack.readyState})') as JsonObject;
      assert.equal(docked.identity, before.identity); assert.equal(docked.track, before.track); assert.equal(docked.state, 'live');
      await until(async () => (await api.media.bridge.request('status')).nativeWindowCount === nativeWindows, 'Floating window closed after docking');
      assert.equal(pageLoads, loads);
      writeFileSync(evidence, JSON.stringify({passed:true,nativeWindowMove:true,docked:true,sameDocument:true,sameWebContents:true,
        liveTrackPreserved:true,noReload:true,shortcutReveal:true,hardwareCapture:false,liveWorldOrCall:false},null,2),{mode:0o600});
      return;
    }

    const codeDocument = await vscode.workspace.openTextDocument({ content: 'Editor remains native beside retained media.' });
    await vscode.window.showTextDocument(codeDocument, {viewColumn: vscode.ViewColumn.One});
    const reveals = pageLoads;
    await controller.reveal(opened.bindingId);
    await until(() => browser.isActive(tabs[0]), 'Retained managed browser focus');
    await vscode.commands.executeCommand('readymade.returnCode');
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), codeDocument.uri.toString());
    await controller.reveal(opened.bindingId);
    const after = await channel.evaluate('({identity:window.identity,track:window.fixtureTrack.id,state:window.fixtureTrack.readyState})') as JsonObject;
    assert.equal(after.identity, before.identity); assert.equal(after.track, before.track); assert.equal(after.state, 'live'); assert.equal(pageLoads, reveals, 'Reveal reloaded a page');
    await channel.evaluate("document.getElementById('note').click()");
    await until(() => controller!.state().some(s => s.kind === 'noltbook' && s.ready), 'Noltbook handoff');
    assert.ok(controller.state().some(s => s.url === origin + '/apps/noltbook/?note=fixture%20note#room=alpha'));
    const firstNote = controller.state().find(s => s.kind === 'noltbook')!;
    const secondNote = await controller.open('noltbook', origin + '/apps/noltbook/?note=fixture%20note#room=beta');
    assert.notEqual(secondNote.bindingId, firstNote.bindingId);
    const count = pageLoads; await controller.reveal(firstNote.bindingId);
    await until(() => browser.isActive(tabs[1]), 'Exact retained note browser focus');
    assert.equal(pageLoads, count, 'Same-query/different-fragment reveal navigated');
    const resumed = await vscode.commands.executeCommand('readymade.noltbook') as {bindingId: string};
    assert.equal(resumed.bindingId, firstNote.bindingId, 'App shortcut resumes the last active note');
    assert.equal(pageLoads, count, 'App shortcut reloaded the note');
    assert.equal(vscode.window.tabGroups.all.length, companionGroups, 'App handoff created extra editor groups');
    const noteChannel = new CDP(await tabs[1].startCDPSession());
    try {
      await noteChannel.attach(firstNote.url);
      await noteChannel.evaluate("window.open('/apps/glurff/', '_blank'); true");
      await until(() => browser.isActive(tabs[0]), 'Noltbook returns to retained Glurff');
      assert.equal(pageLoads, count, 'Reverse handoff reloaded an app');
      assert.equal(tabs.length, 3, 'Reverse handoff created a duplicate Glurff');
    } finally { await noteChannel.close(); }

    await until(() => foreignRequests > 0, 'Foreign-port credential fence'); assert.equal(foreignLeaks, 0);
    const observed = await api.media.bridge.request('observe', { bindingId: opened.bindingId }); assert.equal(observed.origin, origin); assert.equal(observed.ready, true);
    await channel.close(); channel = undefined;
    await controller.reveal(opened.bindingId);
    await until(() => browser.isActive(tabs[0]), 'Browser focus before normal editor close');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await until(() => browser.isClosed(tabs[0]), 'Normal editor X closes its browser tab');
    await until(async () => {
      const state = await api.media.bridge.request('observe', { bindingId: opened.bindingId });
      return state.exists === false && state.pending === false;
    }, 'Closed native binding cleanup');
    assert.ok(controller.state().some(state => state.bindingId === opened.bindingId), 'Closed UI record should remain until explicit Open');
    assert.equal(controller.state().find(state => state.bindingId === opened.bindingId)?.closed, true);
    try {
      api.media.controller = controller;
      assert.ok(!api.media.rows().find(row => row.id === 'open-apps')?.children?.some(row => row.bindingId === opened.bindingId), 'Closed tabs must leave Open apps');
    } finally { api.media.controller = originalController; }
    let reopened = await controller.open('glurff');
    await until(async () => { reopened = await controller!.observe(reopened.bindingId); return reopened.phase === 'bound' && reopened.ready; }, 'Reopened Glurff binding settles');
    assert.notEqual(reopened.bindingId, opened.bindingId); assert.equal(tabs.length, 4);
    assert.equal(controller.state().some(state => state.bindingId === opened.bindingId), false);
    await until(() => browser.isActive(tabs[3]), 'Reopened browser receives focus');
    assert.ok(!browser.isClosed(tabs[1]) && !browser.isClosed(tabs[2]), 'Normal X disturbed retained note owners');
    channel = new CDP(await tabs[3].startCDPSession()); await channel.attach(origin + '/apps/glurff/');
    const fresh = await channel.evaluate('({identity:window.identity,track:window.fixtureTrack.id,state:window.fixtureTrack.readyState})') as JsonObject;
    assert.notEqual(fresh.identity, before.identity); assert.notEqual(fresh.track, before.track); assert.equal(fresh.state, 'live');
    await channel.close(); channel = undefined;
    await controller.reveal(firstNote.bindingId);
    await until(() => browser.isActive(tabs[1]), 'Note browser focus before normal X and disconnect');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await until(() => browser.isClosed(tabs[1]), 'Normal editor X closes retained note browser');
    await until(async () => {
      const state = await api.media.bridge.request('observe', { bindingId: firstNote.bindingId });
      return state.exists === false && state.pending === false;
    }, 'Closed note native binding cleanup');
    assert.ok(controller.state().some(state => state.bindingId === firstNote.bindingId), 'Disconnect must include the already-closed note record');
    assert.ok(api.media.rows().some(row => row.id === 'landscape' && row.command?.command === 'readymade.landscape'));
    const landscape = await vscode.commands.executeCommand('readymade.landscape') as {bindingId: string; ready: boolean};
    await until(async () => { const state = await controller!.observe(landscape.bindingId); return state.phase === 'bound' && state.ready; }, 'Landscape binding settles');
    assert.equal(tabs.length, 5);
    const landscapeLoads = pageLoads;
    const retainedLandscape = await vscode.commands.executeCommand('readymade.landscape') as {bindingId: string};
    assert.equal(retainedLandscape.bindingId, landscape.bindingId);
    assert.equal(pageLoads, landscapeLoads, 'Landscape shortcut reloaded its retained page');
    assert.ok(!browser.isClosed(tabs[2]) && !browser.isClosed(tabs[3]), 'Landscape disturbed Glurff or Noltbook');
    const landscapeChannel = new CDP(await tabs[4].startCDPSession());
    try {
      await landscapeChannel.attach(origin + '/apps/landscape/');
      await landscapeChannel.evaluate("location.href='/apps/glurff/'; true");
      await until(() => browser.isActive(tabs[3]), 'Landscape opens retained Glurff');
      assert.equal(pageLoads, landscapeLoads, 'Landscape handoff navigated an existing app');
      assert.equal(tabs.length, 5);
    } finally { await landscapeChannel.close(); }
    await controller.disconnect(); assert.equal(controller.state().length, 0); controller = undefined;
    await until(() => browser.isClosed(tabs[2]) && browser.isClosed(tabs[3]) && browser.isClosed(tabs[4]), 'Disconnect closes remaining owned browser siblings');
    writeFileSync(evidence, JSON.stringify({ passed: true, host: vscode.version, nativeName, at: new Date().toISOString(), bidirectionalAppHandoff: true, sharedCompanionGroup: true, resumeCurrentNote: true, returnToCode: true, nativeUrbitSidebar: true, retainedAppRowActions: true, authenticatedPrivateTabs: true, httpOnlyCookie: true,
      foreignPortCookieLeaks: foreignLeaks, retainedDocumentAndTrack: true, revealWithoutReload: true, noltbookHandoff: true, exactNoteAndFragment: true,
      landscapeTile: true, landscapeReuseWithoutReload: true, landscapeHandoff: true,
      duplicateQueryDifferentFragment: true, activeBrowserFocus: true, normalEditorCloseThenReopen: true, normalEditorCloseThenDisconnect: true,
      ownedDisconnect: true, hardwareCapture: process.env.READYMADE_REAL_CAPTURE === '1', liveWorldOrCall: false, requests, bootstrapDiagnostics }, null, 2), { mode: 0o600 });
  } catch (error) {
    writeFileSync(evidence, JSON.stringify({ passed: false, nativeName, error: error instanceof Error ? error.message : String(error), bootstrapDiagnostics }, null, 2), { mode: 0o600 }); throw error;
  } finally {
    try { await channel?.close(); } catch {}
    try { await controller?.disconnect(); } catch {}
    server.closeAllConnections(); foreign.closeAllConnections();
    await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => foreign.close(() => r()))]);
  }
}
