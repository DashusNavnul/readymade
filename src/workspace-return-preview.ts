import type {WorkspaceReturnPreview, WorkspaceReturnReply} from './workspace-return-store';
import type {WorkspaceRequestDetail} from './workspace-request-store';

/** Plain text keeps the exact disclosure visible without interpreting message markup. */
export function workspaceReturnDocument(p:WorkspaceReturnPreview|WorkspaceReturnReply, request:WorkspaceRequestDetail):string {
  const status=p.status==='preview'?'Preview — nothing sent':p.status==='posted'?'Shared — canonical group message observed':'Delivery unconfirmed — check the result; do not resend';
  return [
    'Share result with original group', status, '',
    `Conversation: ${p.note}`, `Hosted by: ${p.noteHost}`,
    `Audience (${p.audience.length}): ${p.audience.join(', ')}`,
    `Reply to: ${p.author} · message ${p.eid} · revision ${p.messageRevision}`,
    `Project: ${p.project}`, `Coding session: ${p.session}`, '',
    'ORIGINAL REQUEST', String(request.text), '',
    'OWNER-WRITTEN SUMMARY', p.summary,
    'This summary is written by the owner; it is not a native check result.', '',
    'SOURCE AND NATIVE COMPLETION REFERENCES',
    `Original source: %${p.sourceDesk} · revision ${p.sourceRevision}`,
    `Source root: ${p.sourceRoot}`, `Source commit: ${p.sourceCommit}`,
    `Request: ${p.requestDigest}`, `Native request: ${p.nativeRequest}`,
    `Submission receipt: ${p.submissionEvidence}`,
    `Completed instruction: ${p.instruction}`, `Completion judgment: ${p.judgment}`,
    'Evidence references:', ...p.evidence.map(id=>`  ${id}`),
    ...(p.schema==='readymade-workspace-return-v2'&&p.report?[
      '', 'FULL NATIVE FILE AND CHECK REPORT',
      `Result source: %${p.report.resultSource.desk} · revision ${p.report.resultSource.revision}`,
      `Result digest: ${p.report.resultDigest}`,
      ...p.report.changes.map(c=>`${c.kind} ${c.path} · revisions ${c.beforeSource.revision} → ${c.afterSource.revision} · candidate ${c.candidate}`),
      ...p.report.checks.map(c=>`${c.diagnostic.passed?'PASS':'FAIL'} ${c.diagnostic.name} · tool ${c.tool} · %${c.diagnostic.source.desk} revision ${c.diagnostic.source.revision}`),
      'The exact message below includes complete changed-file contents and check diagnostics. Absent files are distinct from empty files.',
    ]:['These are native references, not changed-file diffs or check reports.', 'Check results and changed-file details are not included in this message.']), '',
    'DISCLOSURE RECEIPT', `Audience snapshot: ${p.membership}`,
    `Preview: ${p.previewDigest}`, `Message content hash: ${p.payloadDigest}`,
    ...(p.status==='posted'?[`Posted message: ${p.postedEid}`]:[]), '',
    p.status==='preview'?'Review the full message below before choosing Share once.':
      p.status==='posted'?'The original attempt was observed. No resend is needed.':'Use Check shared result to observe this attempt. Never resend an unknown outcome.',
    '', 'EXACT MESSAGE TEXT', '────────────────────────────────────────', p.text,
  ].join('\n');
}
