import type {SavedSuggestion} from './remote-suggestion-journal';
import {remoteBundleOutcome, type SavedBundle} from './remote-bundle-suggest';

/**
 * Where one send of a suggestion stands, in words a person can act on.
 *
 * Five things are kept apart, because they call for different next steps:
 *  - `local`     recorded on this computer and never sent (Readymade stopped between the two);
 *  - `unknown`   sent, or possibly sent, and the outcome is not known: never called failed, never called done;
 *  - `recorded`  the owner's ship holds it for review;
 *  - `refused`   the owner's ship refused it and recorded nothing;
 *  - `not-sent`  settled as never having left this computer.
 * A result that could not be read just now is not a sixth state of the send: the view says so beside the row.
 */
export type SendState = 'local' | 'unknown' | 'recorded' | 'refused' | 'not-sent';
/** The one next step offered. Every one of them reads or closes; none sends the suggestion again. */
export type SendAction = 'close-unsent' | 'check' | 'recover' | 'none';
export interface SendStatus {
  readonly state: SendState; readonly label: string; readonly detail: string; readonly action: SendAction;
  /** Is this send resolved, so that its draft may be reconciled into a new draft and sent as a new suggestion? */
  readonly resolved: boolean;
}
export const SEND_ACTIONS: Record<Exclude<SendAction, 'none'>, {label: string; tooltip: string}> = {
  'close-unsent': {label: 'Close as Not Sent', tooltip: 'Marks this suggestion as never sent, which is what its record shows. Nothing is sent. Afterwards its draft can be reconciled into a new draft and sent as a new suggestion.'},
  check: {label: 'Check Result', tooltip: 'Reads the existing result. This does not send your suggestion again.'},
  recover: {label: 'Recover Owner Receipt', tooltip: 'Asks the owner’s ship for its receipt of this exact suggestion. This does not send your suggestion again.'},
};
const KEPT = ' Your draft is kept as it is.';
const WAIT = 'It cannot be sent again or replaced while this is open, because the owner may still receive the original.';
const local: SendStatus = {state: 'local', action: 'close-unsent', resolved: false, label: 'Recorded on this computer — never sent',
  detail: 'Readymade stopped after recording this suggestion and before sending it. Nothing left this computer. It is not sent late, because the shared files may have changed since. Close it as not sent, then reconcile the draft to send a new suggestion.' + KEPT};
function unknown(label: string, how: string, action: SendAction = 'check'): SendStatus {
  return {state: 'unknown', action, resolved: false, label, detail: `${how} ${WAIT}${KEPT}`};
}
const recorded = (label = 'Recorded on owner — awaiting review'): SendStatus => ({state: 'recorded', action: 'none', resolved: true, label,
  detail: 'The owner’s ship holds this suggestion. Nothing is committed until the owner accepts it; their answer arrives as a notice.' + KEPT});
const refusals: Record<string, string> = {'watch-refused': 'It would not open your request; your access or the project may have changed.'};
const lost: Record<string, string> = {'suggest-timeout': 'the owner’s ship did not answer in time', 'watch-refused': 'the owner’s ship would not open the request',
  'poke-refused': 'the owner’s ship rejected the message', 'closed-without-receipt': 'the owner’s ship closed the request without a receipt',
  'invalid-reply': 'the answer could not be verified', 'grant-mismatch': 'the answer named another grant', 'receipt-mismatch': 'the receipt did not match what was sent'};

/** One single-file suggestion. The newest receipt recovery, when there is one, says more than the send record. */
export function suggestionStatus(row: Pick<SavedSuggestion, 'phase' | 'recoveries' | 'reply'>): SendStatus {
  const recovery = row.recoveries?.at(-1)?.phase;
  if (recovery === 'recorded') return recorded('Owner receipt recovered — awaiting review');
  if (!recovery) switch (row.phase) {
    case 'recorded': return recorded();
    case 'refused': return {state: 'refused', action: 'none', resolved: true, label: 'Owner’s ship refused it — nothing was recorded',
      detail: (refusals[row.reply && 'reason' in row.reply ? row.reply.reason : ''] ?? 'The owner’s ship refused this suggestion.') + ' Reconcile the draft onto the current shared files to send a new suggestion.' + KEPT};
    case 'refused-before-submit': return {state: 'not-sent', action: 'none', resolved: true, label: 'Not sent — nothing reached the owner',
      detail: 'This suggestion never left this computer. Reconcile the draft onto the current shared files to send a new suggestion.' + KEPT};
    case 'claimed': return local;
    case 'submitting': return unknown('Sending was interrupted — outcome not known', 'Readymade stopped while sending. The suggestion may or may not have reached your ship. Check Result reads what your ship holds.');
    case 'unknown': return unknown('Sent, or possibly sent — outcome not known', 'No usable answer came back. Check Result reads what your ship holds.');
    case 'watching': return unknown('Sent — waiting for the owner’s ship', 'Your ship is delivering it. Check Result reads where it stands.');
    case 'sent': return unknown('Sent — waiting for the owner’s receipt', 'The owner’s ship has it and has not answered yet. Check Result reads where it stands.');
    case 'uncertain': return unknown('Sent — no receipt from the owner', `Your ship has no receipt: ${lost[row.reply && 'reason' in row.reply ? row.reply.reason : ''] ?? 'no reason was given'}. That is not proof it was not delivered. Check Result reads it again.`);
    case 'missing': case 'expired': return unknown('Your ship no longer holds this send — outcome not known',
      'Your ship keeps a send for a few minutes only. Recover Owner Receipt asks the owner’s ship whether it recorded this exact suggestion.', 'recover');
  }
  switch (recovery) {
    case 'requested': case 'watching': return unknown('Asking the owner for its receipt — no answer yet', 'Check Result reads the answer when it arrives.');
    case 'unknown': return unknown('Asked the owner for its receipt — the answer was lost', 'Check Result reads what your ship holds of the answer.');
    case 'missing': case 'expired': return unknown('The owner was asked; your ship no longer holds the answer', 'Recover Owner Receipt asks once more.', 'recover');
    default: return unknown('The owner’s ship did not confirm a receipt — outcome not known',
      'That is not proof it was not delivered: an owner that holds no receipt and an owner that cannot answer look the same from here. Check Result reads it again.');
  }
}
/** One multi-file suggestion. */
export function bundleStatus(row: Pick<SavedBundle, 'phase' | 'reason'>): SendStatus {
  const words = remoteBundleOutcome(row.phase, row.reason);
  switch (row.phase) {
    case 'recorded': return recorded(words);
    case 'refused': return {state: 'refused', action: 'none', resolved: true, label: words, detail: 'Nothing was recorded on the owner’s ship.' + KEPT};
    case 'refused-before-submit': return {state: 'not-sent', action: 'none', resolved: true, label: words, detail: 'This suggestion never left this computer. Reconcile its drafts onto the current shared files to send a new one.' + KEPT};
    case 'claimed': return {...local, detail: local.detail.replace('reconcile the draft', 'reconcile its drafts')};
    case 'uncertain': return row.reason === 'poke-refused' ? {state: 'refused', action: 'none', resolved: true, label: words, detail: 'The owner’s ship rejected the message; nothing was recorded.' + KEPT}
      : {state: 'unknown', action: 'none', resolved: false, label: `Ended without a result — outcome not known (${lost[row.reason ?? ''] ?? row.reason ?? 'no reason given'})`,
        detail: 'Your ship stopped waiting. That is not proof it was not delivered, and there is nothing more to read. Its drafts are never sent again; to continue, reconcile them into new drafts.' + KEPT};
    case 'submitting': return unknown('Sending was interrupted — outcome not known', 'Readymade stopped while sending. Check Result reads what your ship holds.');
    case 'unknown': return unknown('Sent, or possibly sent — outcome not known', 'No usable answer came back. Check Result reads what your ship holds.');
    case 'missing': return unknown('Your ship no longer holds this send — outcome not known', 'Your ship keeps a send for a few minutes only. Check Result reads it once more.');
    default: return unknown(row.phase === 'sent' ? 'Sent — waiting for the owner’s receipt' : 'Sent — waiting for the owner’s ship', 'Check Result reads where it stands.');
  }
}
