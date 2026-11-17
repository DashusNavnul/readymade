/**
 * A plain report: sections of lines, each optionally with one action. Every new native screen is one of these, so
 * they read the same and none of them builds its own HTML. The page states what the ship said; it runs no logic.
 */
export type ReportMark = 'ok' | 'note' | 'warning' | 'problem';
export interface ReportAction {readonly id: string; readonly label: string}
export interface ReportLine {readonly text: string; readonly detail?: string; readonly mark?: ReportMark; readonly action?: ReportAction}
export interface ReportSection {readonly title: string; readonly note?: string; readonly lines: readonly ReportLine[]; readonly empty?: string}
export interface Report {
  readonly title: string; readonly status: string; readonly note?: string;
  readonly sections: readonly ReportSection[]; readonly actions?: readonly ReportAction[];
}
export const REPORT_ACTION = /^[a-z][a-z0-9-]{0,31}(?::[A-Za-z0-9~._-]{1,120})?$/;
const MARKS: Record<ReportMark, string> = {ok: '✓', note: '·', warning: '!', problem: '✕'};
export const escapeHtml = (v: string): string => v.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
const button = (a: ReportAction, busy: boolean): string => {
  if (!REPORT_ACTION.test(a.id)) throw new Error('Invalid report action.');
  return `<button data-action="${escapeHtml(a.id)}"${busy ? ' disabled' : ''}>${escapeHtml(a.label)}</button>`;
};
/** The whole page. Scripts and styles run only under the nonce; nothing is loaded from anywhere. */
export function reportHtml(report: Report, nonce: string, busy = false): string {
  if (!/^[A-Za-z0-9+/=]{16,64}$/.test(nonce)) throw new Error('Invalid nonce.');
  const section = (s: ReportSection): string => `<section><h2>${escapeHtml(s.title)}</h2>${s.note ? `<p>${escapeHtml(s.note)}</p>` : ''}${s.lines.length
    ? '<ul>' + s.lines.map(l => `<li class="${l.mark ?? 'note'}"><span class="mark" aria-hidden="true">${MARKS[l.mark ?? 'note']}</span><div><strong>${escapeHtml(l.text)}</strong>${l.detail ? `<p>${escapeHtml(l.detail)}</p>` : ''}${l.action ? button(l.action, busy) : ''}</div></li>`).join('') + '</ul>'
    : `<p class="empty">${escapeHtml(s.empty ?? 'Nothing here.')}</p>`}</section>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);line-height:1.55;margin:0}main{max-width:820px;margin:auto;padding:32px}h1{font-size:28px;font-weight:500;margin-bottom:4px}h2{font-size:18px;font-weight:500;margin-top:32px}
ul{list-style:none;padding:0}li{display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--vscode-panel-border)}li p,.empty{margin:2px 0 0;color:var(--vscode-descriptionForeground);white-space:pre-wrap}.mark{width:1.4em;text-align:center;font-weight:600}
.warning .mark,.problem .mark{color:var(--vscode-errorForeground)}.ok .mark{color:var(--vscode-testing-iconPassed)}
button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:6px 14px;border-radius:2px;cursor:pointer;margin:6px 8px 0 0}button:disabled{opacity:.5;cursor:default}</style></head><body><main>
<h1>${escapeHtml(report.title)}</h1><p role="status">${escapeHtml(report.status)}</p>${report.note ? `<p>${escapeHtml(report.note)}</p>` : ''}
${[{id: 'again', label: 'Read again'}, ...(report.actions ?? [])].map(a => button(a, busy)).join('')}${report.sections.map(section).join('')}
</main><script nonce="${nonce}">const api=acquireVsCodeApi();document.querySelectorAll('button[data-action]').forEach(b=>b.addEventListener('click',()=>{if(!b.disabled)api.postMessage({action:b.dataset.action});}));</script></body></html>`;
}
/** A report for a page that could not be read: one sentence, and nothing that looks like data. */
export function unreadable(title: string, why: string): Report {
  return {title, status: why, sections: []};
}
