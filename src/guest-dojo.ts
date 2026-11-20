import {DojoNotRun} from './ship-dojo';

/**
 * A dojo line for a guest ship, typed on Home as `~guest> line` while connected to the ship that hosts it.
 *
 * A guest ship lives inside its host's %bach agent and has no web interface of its own, so it is reached through
 * the host's dojo, with three lines of the host's own (measured on a live host, 2026-11-19):
 *   - how much the guest's terminal holds so far, how it ends, and whether the host has that guest at all;
 *   - `:bach &bach-action [%dojo ~guest 'line']`, which types the line into the guest's dojo and presses Return;
 *   - what the guest's terminal gained since, read as one number (the text's bytes) so that no pretty-printer
 *     layout stands between the guest's words and what is shown.
 * The host keeps a guest's terminal as plain text with every redraw of its prompt in it: `~guest:dojo> line> line`,
 * then one prompt before each line the guest printed. A line the guest's dojo cannot read is typed and not
 * printed back; one that starts a longer expression leaves a `< ` prompt, which an empty line cancels.
 */
export interface GuestLine {readonly guest: string; readonly line: string}
/** Bytes of the guest's terminal read by one host line, so that the answer fits what a dojo line may return. */
export const GUEST_CHUNK = 2800, GUEST_CHUNKS = 4;
/** Bytes of the end of the guest's terminal read with the count: enough for its prompt and the longest line that can be left standing after it. */
export const GUEST_TAIL = 640;
const SHIP = /^~[a-z]{3,}(?:--?[a-z]{3,})*$/u, PRINTABLE = /^[ -~]+$/u;

/** `~guest> line`, or undefined for anything else. The ship name is checked for shape only; the host says whether it has it. */
export function guestLine(text: string): GuestLine | undefined {
  const found = /^(~[a-z-]+)>(.*)$/u.exec(text.trim());
  if (!found || !SHIP.test(found[1]!)) return undefined;
  const line = found[2]!.trim();
  return line ? {guest: found[1]!, line} : undefined;
}
const dotted = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/gu, '.');
const terminal = (guest: string): string => `.^(@t %gx /=bach=/dojo/${guest}/noun)`;
const named = (guest: string): string => {if (!SHIP.test(guest)) throw new DojoNotRun('That is not a ship name.'); return guest;};

/** The host line that says whether the host has this guest, how long the guest's terminal text is, and how it ends. */
export function guestCountLine(guest: string): string {
  return `=+(t=${terminal(named(guest))} =+(n=(met 3 t) [(~(has in (silt .^((list @p) %gx /=bach=/ships/noun))) ${guest}) n \`@ux\`(cut 3 [(sub n (min n ${GUEST_TAIL})) ${GUEST_TAIL}] t)]))`;
}
/** The host line that types `line` into the guest's dojo. The line travels inside a Hoon cord, so it is plain printable text with `'` and `\` escaped; `line` may be empty, which the guest's dojo takes as cancelling an unfinished expression. */
export function guestSendLine(guest: string, line: string): string {
  if (line && !PRINTABLE.test(line)) throw new DojoNotRun('A line for a guest ship can hold plain keyboard characters only. Nothing was sent.');
  const sent = `:bach &bach-action [%dojo ${named(guest)} '${line.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}']`;
  if (sent.length > 500) throw new DojoNotRun(`A line for this guest ship can be up to ${500 - (sent.length - line.length)} characters here, fewer if it has quotes or backslashes. Nothing was sent.`);
  return sent;
}
/** The host line that reads up to one chunk of the guest's terminal from byte `from`, with the terminal's whole length. */
export function guestReadLine(guest: string, from: number): string {
  if (!Number.isSafeInteger(from) || from < 0) throw new DojoNotRun('The guest ship\'s terminal could not be read.');
  return `=+(t=${terminal(named(guest))} [(met 3 t) \`@ux\`(cut 3 [${dotted(from)} ${dotted(GUEST_CHUNK)}] t)])`;
}
/** What the host's dojo printed after echoing the line, on one line: its printer lays a wide value out over several (measured: `[ 5.094`, the number, `]`). */
const printed = (output: string): string => {
  const lines = output.split('\n'); let echo = -1;
  lines.forEach((line, at) => {if (line.startsWith('> ')) echo = at;});
  return lines.slice(echo + 1).map(line => line.trim()).filter(Boolean).join(' ');
};
const count = (text: string): number | undefined => {
  if (!/^(0|[1-9][0-9]{0,2}(\.[0-9]{3})*)$/u.test(text)) return undefined;
  const value = Number(text.replaceAll('.', ''));
  return Number.isSafeInteger(value) ? value : undefined;
};
const HEX = /^(0|[1-9a-f][0-9a-f]{0,3}(\.[0-9a-f]{4})*)$/u;
/** The bytes a `@ux` number stands for: the number's lowest byte is the text's first character. */
const bytesOf = (dotted: string): Buffer => {
  const hex = dotted.replaceAll('.', '');
  return hex === '0' ? Buffer.alloc(0) : Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex').reverse();
};
/** What the count line printed (`tail`: the end of the guest's terminal), or undefined when the host did not answer it as a host of guests does. */
export function guestCount(output: string): {readonly hosted: boolean; readonly length: number; readonly tail: string} | undefined {
  const found = /^\[ ?%\.([yn]) ([0-9.]+) 0x([0-9a-f.]+) ?\]$/u.exec(printed(output)), length = found ? count(found[2]!) : undefined;
  if (!found || length === undefined || !HEX.test(found[3]!)) return undefined;
  return {hosted: found[1] === 'y', length, tail: bytesOf(found[3]!).toString('utf8')};
}
/**
 * Whether the guest's dojo holds the start of an unfinished expression, from the end of its terminal: the last
 * prompt drawn there is then the `< ` one, and a line typed now would be taken as that expression's next part.
 * `ready`: the last prompt is the `> ` one. Text may stand after it, left by a line the dojo could not read
 * (measured on a live host: `…:dojo> (add 2`); the host clears that itself before it types. `unknown`: no prompt
 * in what was read.
 */
export function guestPrompt(tail: string, guest: string): 'ready' | 'waiting' | 'unknown' {
  const last = [...tail.matchAll(new RegExp(`${named(guest)}:dojo\\S*([<>]) `, 'gu'))].at(-1);
  return !last ? 'unknown' : last[1] === '>' ? 'ready' : 'waiting';
}
/** What a read line printed: the terminal's whole length and the chunk's bytes (a character may straddle two chunks, so text is made of them only once all are in). */
export function guestRead(output: string): {readonly length: number; readonly bytes: Buffer} | undefined {
  const found = /^\[ ?([0-9.]+) 0x([0-9a-f.]+) ?\]$/u.exec(printed(output)), length = found ? count(found[1]!) : undefined;
  if (!found || length === undefined || !HEX.test(found[2]!)) return undefined;
  return {length, bytes: bytesOf(found[2]!)};
}
/**
 * What the guest's dojo did with the line, from the text its terminal gained. `ran`: the dojo printed the line
 * back, so it took it. `waiting`: its prompt is now the `< ` one. `text`: what it printed after that, the prompt
 * it redraws at the start of each line taken off.
 */
export function guestAnswer(gained: string, guest: string, line: string): {readonly ran: boolean; readonly waiting: boolean; readonly text: string} {
  // a ship name is `~`, letters and hyphens: nothing in it needs escaping in a pattern
  const prompt = `${named(guest)}:dojo\\S*[<>] `;
  const waiting = new RegExp(`${guest}:dojo\\S*< $`, 'u').test(gained);
  const echo = `> ${line}\n`, at = gained.indexOf(echo);
  if (at < 0) return {ran: false, waiting, text: ''};
  const lines = gained.slice(at + echo.length).split('\n').map(each => each.replace(new RegExp(`^(?:${prompt})+`, 'u'), ''));
  return {ran: true, waiting, text: lines.join('\n').replace(/\n+$/u, '')};
}

/**
 * Types one line into a guest ship's dojo through its host and returns what the guest printed. `host` runs one
 * line in the host's dojo and returns its output (see `runDojoLine`), and may throw `DojoNotRun`. The line is sent
 * to the guest once; a guest the host does not have, or a host with no guests, gets nothing sent.
 */
export async function runGuestLine(host: (line: string) => Promise<string>, guest: string, line: string, report: (text: string) => void, pauseMs = 1000): Promise<string> {
  const send = guestSendLine(guest, line);
  let before = guestCount(await host(guestCountLine(guest)));
  if (!before) throw new DojoNotRun('The ship you are connected to did not answer as a host of guest ships does (its %bach agent). Nothing was sent.');
  if (!before.hosted) throw new DojoNotRun(`The ship you are connected to hosts no guest ship ${guest}. Nothing was sent.`);
  // At a waiting prompt the line would be taken as the next part of an expression the guest already holds, and run
  // as part of that: an empty line cancels the held expression first, as it does after a line of this app's own
  // leaves one, and the line goes only once the ready prompt is back.
  let note = '';
  if (guestPrompt(before.tail, guest) === 'waiting') {
    report(`${guest}'s dojo shows the prompt of an unfinished expression. Sending an empty line to cancel that first…`);
    const unsent = `${guest}'s dojo shows the prompt of an unfinished expression.`, look = ' Your line was not sent. Look at its terminal on its host.';
    let cancel: string;
    try {cancel = await host(guestSendLine(guest, ''));}
    catch (error) {if (!(error instanceof DojoNotRun)) throw error; throw new DojoNotRun(`${unsent} The empty line that would cancel it did not go: ${error.message}${look}`);}
    // From here an empty line may have reached the guest: every way out says so.
    if (!cancel.split('\n').some(each => each.trim() === '>=')) throw new DojoNotRun(`${unsent} An empty line was sent to cancel it, and the host did not confirm handing it over.${look}`);
    let after: ReturnType<typeof guestCount>;
    try {after = guestCount(await host(guestCountLine(guest)));}
    catch (error) {if (!(error instanceof DojoNotRun)) throw error; throw new DojoNotRun(`${unsent} An empty line was sent to cancel it, and the guest's terminal could not be read after that.${look}`);}
    if (!after || !after.hosted || guestPrompt(after.tail, guest) !== 'ready')
      throw new DojoNotRun(`${unsent} An empty line was sent to cancel it, and its terminal does not show the ready prompt since.${look}`);
    before = after;
    // What is known is what the terminal showed: text left on a ready prompt can read like the waiting prompt too.
    note = `\n(${guest}'s terminal showed the prompt of an unfinished expression; an empty line was sent first to cancel it.)`;
  }
  const start = before.length;
  report(`Typing into ${guest}'s dojo through its host…`);
  // The host's dojo prints the line back and then `>=` once it has handed it to %bach. Anything else it says
  // (it could not tell whether the line ran, or %bach refused it) is passed on as it stands.
  let sent: string;
  try {sent = await host(send);}
  catch (error) {if (!(error instanceof DojoNotRun) || !note) throw error; throw new DojoNotRun(error.message + note);}
  const handed = sent.split('\n').map(each => each.trim());
  if (!handed.includes('>=')) {
    const said = handed.filter(each => each && each !== `> ${send}`).join(' ').slice(0, 300);
    return `The host did not confirm handing the line to ${guest}, so it is not known whether it ran there. It was not sent again.${said ? ` The host said: ${said}` : ''}${note}`;
  }
  // From here the line has been sent: whatever fails next, that stays true and is said.
  const unread = `The line was sent to ${guest} once, but its terminal could not be read back through the host. Look at it there.${note}`;
  const read = async (): Promise<{text: string; more: boolean} | undefined> => {
    const parts: Buffer[] = []; let at = start;
    for (let chunk = 0; chunk < GUEST_CHUNKS; chunk++) {
      let got: ReturnType<typeof guestRead>;
      try {got = guestRead(await host(guestReadLine(guest, at)));} catch (error) {if (error instanceof DojoNotRun) return undefined; throw error;}
      if (!got) return undefined;
      parts.push(got.bytes); at += got.bytes.length;
      if (at >= got.length || !got.bytes.length) return {text: Buffer.concat(parts).toString('utf8'), more: false};
    }
    return {text: Buffer.concat(parts).toString('utf8'), more: true};
  };
  let gained = await read();
  if (!gained) return unread;
  let answer = guestAnswer(gained.text, guest, line);
  if (!answer.ran) {
    // A guest that is slow to take the line: one more look, a moment later.
    await new Promise<void>(done => setTimeout(done, pauseMs));
    gained = await read() ?? gained; answer = guestAnswer(gained.text, guest, line);
  }
  if (answer.ran && answer.waiting) {
    // The line was the start of a longer expression. An empty line makes the guest's dojo drop it.
    let dropped = false;
    try {
      const cancel = await host(guestSendLine(guest, ''));
      const after = cancel.split('\n').some(each => each.trim() === '>=') ? await read() : undefined;
      dropped = !!after && !after.more && !guestAnswer(after.text, guest, line).waiting;
    } catch (error) {if (!(error instanceof DojoNotRun)) throw error;}
    return `${guest}'s dojo took this line as the start of a longer expression and waited for the rest. One line at a time goes to a guest, so nothing was run`
      + (dropped ? ', and the unfinished expression was cancelled.' : '. Its dojo may still be waiting for the rest: look at it on its host.') + note;
  }
  if (!answer.ran) return `${guest}'s dojo has not printed the line back, so as far as its terminal shows it did not take it: it cannot read it, or it is busy and may run it yet.` + note;
  return `> ${line}${answer.text ? '\n' + answer.text : ''}${gained.more ? '\n(The guest ship printed more than is shown here; whether its dojo now waits for more input is not known.)' : ''}${note}`;
}
