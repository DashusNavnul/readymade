/* Copyright (c) Microsoft Corporation. All rights reserved. MIT License.
 * Minimal proposed browser declarations from microsoft/vscode 1.144.0,
 * 2c33b50b16c472efe58357d1d2a8a5414bc23fbf, src/vscode-dts/vscode.proposed.browser.d.ts.
 * Matching browser APIs are present in the pinned 1.143.1-based host.
 * This declaration does not grant API access; only the exact bundled extension is enabled.
 */
import 'vscode';
declare module 'vscode' {
  export interface BrowserTab {
    readonly url: string; readonly title: string; readonly icon: IconPath;
    startCDPSession(): Thenable<BrowserCDPSession>;
    close(): Thenable<void>;
  }
  export interface BrowserCDPSession {
    readonly onDidReceiveMessage: Event<unknown>;
    readonly onDidClose: Event<void>;
    sendMessage(message: unknown): Thenable<void>;
    close(): Thenable<void>;
  }
  export interface BrowserTabShowOptions { viewColumn?: ViewColumn; preserveFocus?: boolean; background?: boolean }
  export namespace window {
    export const browserTabs: readonly BrowserTab[];
    export const activeBrowserTab: BrowserTab | undefined;
    export const onDidOpenBrowserTab: Event<BrowserTab>;
    export const onDidCloseBrowserTab: Event<BrowserTab>;
    export const onDidChangeActiveBrowserTab: Event<BrowserTab | undefined>;
    export const onDidChangeBrowserTabState: Event<BrowserTab>;
    export function openBrowserTab(url: string, options?: BrowserTabShowOptions): Thenable<BrowserTab>;
  }
}
