import type {JsonObject} from './protocol';

/**
 * The command line on Home as a dojo. A line that begins as dojo input does is typed into the ship's own dojo, the
 * default terminal session, through the ship's web-terminal agent (%herm), exactly as its Landscape Terminal types
 * it, and what the dojo prints is shown under the line. It is never sent to the assistant, and the assistant can
 * never produce one: only what the person typed themselves reaches the dojo.
 *
 * Measured on a live ship (2026-11-19): %herm redraws the prompt line when a view opens; typed text is echoed as
 * prompt and input; Return on a line that does not parse rings the bell, moves the cursor to the fault and runs
 * nothing, leaving the line in place; a line that parses is printed back, then its result, then an empty prompt.
 * A line longer than the ship's terminal is wide (58 characters fitted beside the prompt at 80 columns) is shown
 * only by its end; when it runs the dojo prints it back whole. A line that is the start of a longer expression
 * is printed back and the prompt changes from `> ` to `< `; one Backspace on that empty line cancels it.
 * Debug prints (~&) go to the ship's own console only, as they do for the Landscape Terminal. The dojo marks no
 * end of a command, so listening stops once it has printed something and been quiet for `quietMs` (or at `capMs`);
 * what a slow command prints later is in the ship's own terminal.
 */
export const DOJO_OUTPUT_MAX = 8000;
const SIGILS = new Set(Array.from('|+:-=.%(~`[@*!<\'"^&;/$#?_,{'));
/**
 * The dojo line a person typed, or undefined when the text is an instruction for the assistant. Dojo input starts
 * with a sign or a digit; an instruction starts with a letter. A leading `>` sends the rest to the dojo as typed,
 * for an expression that starts with a letter (`> now`).
 */
export function dojoLine(text: string): string | undefined {
  const typed = text.trim();
  if (!typed || /[\u0000-\u001f\u007f]/u.test(typed)) return undefined;
  if (typed.startsWith('>')) return typed.slice(1).trim() || undefined;
  return SIGILS.has(typed[0]!) || /^[0-9]/.test(typed) ? typed : undefined;
}

/** The ship's terminal line as its screen updates (blits) leave it, and the lines that scrolled above it. */
export class DojoScreen {
  line = ''; column = 0; bells = 0; unknown = 0;
  readonly lines: string[] = [];
  /** What stands after the prompt, when the ship drew the line as prompt and input; undefined when it drew it another way. */
  input?: string;
  apply(blit: unknown): void {
    if (!blit || typeof blit !== 'object' || Array.isArray(blit)) {this.unknown++; return;}
    const entries = Object.entries(blit as Record<string, unknown>);
    if (entries.length !== 1) {this.unknown++; return;}
    const [kind, value] = entries[0]!;
    if (kind === 'mor' && Array.isArray(value)) {for (const each of value) this.apply(each); return;}
    if (kind === 'hop') {
      const to = typeof value === 'number' ? value : value && typeof value === 'object' ? (value as Record<string, unknown>).x : undefined;
      if (typeof to === 'number' && Number.isSafeInteger(to) && to >= 0 && to <= 100000) this.column = to; else this.unknown++;
      return;
    }
    if (kind === 'wyp') {this.line = ''; this.input = undefined; return;}
    if (kind === 'nel') {this.push(this.line); this.line = ''; this.column = 0; this.input = undefined; return;}
    if (kind === 'bel') {this.bells++; return;}
    if (kind === 'clr') return;
    if (kind === 'put' && chars(value) !== undefined) {this.write(chars(value)!); this.input = undefined; return;}
    if (kind === 'klr' && Array.isArray(value)) {
      const parts = value.map(part => part && typeof part === 'object' ? chars((part as Record<string, unknown>).text) : undefined);
      if (parts.some(part => part === undefined)) {this.unknown++; return;}
      const whole = this.column === 0 && this.line === '';
      this.write(parts.join('')); this.input = whole && parts.length === 2 ? parts[1] : undefined;
      return;
    }
    if (kind === 'url' && typeof value === 'string') {this.push(value); return;}
    if (kind === 'sag' || kind === 'sav') {this.push('(The ship offered a file to save. Readymade Home does not save files from the dojo.)'); return;}
    this.unknown++;
  }
  private write(text: string): void {
    const before = Array.from(this.line), add = Array.from(text);
    while (before.length < this.column) before.push(' ');
    before.splice(this.column, add.length, ...add);
    this.line = before.join(''); this.column += add.length;
  }
  private push(line: string): void {this.lines.push(line); if (this.lines.length > 2000) this.lines.splice(0, this.lines.length - 2000);}
}
function chars(value: unknown): string | undefined {
  return Array.isArray(value) && value.every(each => typeof each === 'string') ? (value as string[]).join('') : undefined;
}

/** Splits what has arrived of an event stream into its complete events; `rest` is the unfinished tail. */
export function streamEvents(buffer: string): {events: {id?: number; data: string}[]; rest: string} {
  const events: {id?: number; data: string}[] = [];
  let at: number;
  while ((at = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, at).split('\n'); buffer = buffer.slice(at + 2);
    const data = block.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    const id = block.find(line => line.startsWith('id:'))?.slice(3).trim();
    if (data) events.push({data, ...(id !== undefined && /^[0-9]{1,15}$/.test(id) ? {id: Number(id)} : {})});
  }
  return {events, rest: buffer};
}

/**
 * One channel on the ship: actions out, events in. `send` rejects with `code: 'outcomeUnknown'` when it cannot be
 * told whether the ship took the actions; any other rejection means the ship took none of them.
 */
export interface DojoChannel {readonly ship: string; send(actions: unknown[]): Promise<void>; close(): void}
export type DojoOpen = (onEvent: (event: JsonObject, id?: number) => void, onEnd: () => void) => DojoChannel;
export interface DojoTiming {readonly answerMs: number; readonly quietMs: number; readonly capMs: number; readonly pollMs: number}
export const DOJO_TIMING: DojoTiming = Object.freeze({answerMs: 8000, quietMs: 1200, capMs: 30000, pollMs: 40});
/** Why a line was not run. The line did not run on the ship when this is thrown. */
export class DojoNotRun extends Error {constructor(message: string) {super(message); this.name = 'DojoNotRun';}}

const tail = (text: string): string => {
  if (text.length <= DOJO_OUTPUT_MAX) return text;
  const cut = text.slice(text.length - DOJO_OUTPUT_MAX + 40), line = cut.indexOf('\n');
  return '(earlier output not shown)\n' + (line >= 0 ? cut.slice(line + 1) : cut);
};
const unknown = (error: unknown): boolean => !!error && typeof error === 'object' && (error as {code?: unknown}).code === 'outcomeUnknown';
/**
 * The dojo's own prompt with nothing pending (`~ship:dojo> `, with a desk or path when it has changed directory; a
 * comet's name is shortened with an underscore), and the one it shows while it holds the start of an expression.
 * A dojo that is busy running a command shows the same prompts, and says so only when something is typed.
 */
export const dojoReady = (prompt: string): boolean => /^~[a-z_^-]{3,}:dojo\S*> $/u.test(prompt);
export const dojoWaiting = (prompt: string): boolean => /^~[a-z_^-]{3,}:dojo\S*< $/u.test(prompt);
const STANDS = ' The text may still stand on its dojo line: clear it in the ship\'s own terminal before pressing Return there.';
const short = (text: string): string => text.length > 120 ? text.slice(0, 120) + '…' : text;

/**
 * Types one line into the ship's dojo and returns what it printed. `report` is given the output so far as it
 * arrives. The line is typed only when the ship shows the dojo's ready prompt with nothing standing on it (a busy
 * dojo shows it too, and then puts the text back itself and says so), and Return is pressed
 * once, only after the ship has shown the line as typed: all of it when it fits the ship's terminal, otherwise its
 * end, which is all the ship shows (what the dojo then prints back is compared with what was typed). A line that
 * was typed and did not run is taken off the prompt again. Nothing is ever typed twice.
 */
export async function runDojoLine(open: DojoOpen, line: string, report: (text: string) => void, timing: DojoTiming = DOJO_TIMING): Promise<string> {
  if (!line || line.length > 500 || /[\u0000-\u001f\u007f]/u.test(line)) throw new DojoNotRun('A dojo line here is one line of up to 500 characters.');
  const screen = new DojoScreen(), answers = new Map<number, string | true>();
  let ended = false, last = 0, heard = Date.now(), next = 0, acked = 0, watching = 0, standing = false;
  let channel: DojoChannel;
  try {
    channel = open((event, id) => {
      heard = Date.now(); if (id !== undefined && id > last) last = id;
      if (event.response === 'diff') screen.apply(event.json);
      else if (typeof event.id === 'number' && (event.response === 'poke' || event.response === 'subscribe'))
        answers.set(event.id, typeof event.err === 'string' ? event.err || 'refused' : true);
      else if (event.response === 'quit') ended = true;
    }, () => {ended = true;});
  } catch {throw new DojoNotRun('Readymade is not signed in to your ship. Nothing was typed.');}
  const ship = channel.ship.replace(/^~/, '');
  const poke = (belt: unknown) => ({action: 'poke', ship, app: 'herm', mark: 'herm-task', json: {session: '', belt}});
  /** Sends the actions, numbered in the order they go, after an acknowledgement of the events read so far. `ids` is filled before the wait. */
  const send = (actions: object[], ids: number[] = []): Promise<void> => {
    const all = [...(last > acked ? [{action: 'ack', 'event-id': acked = last}] : []), ...actions].map(each => ({id: ++next, ...each}));
    ids.push(...all.slice(all.length - actions.length).map(each => each.id));
    return channel.send(all);
  };
  const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  /** Waits until `done()`; false when the time ran out or the channel ended first. */
  const until = async (done: () => boolean, ms: number): Promise<boolean> => {
    const stop = Date.now() + ms;
    while (!done()) {if (ended || Date.now() >= stop) return done(); await sleep(timing.pollMs);}
    return true;
  };
  const refused = (ids: number[]): boolean => ids.some(id => typeof answers.get(id) === 'string');
  const clear = [{mod: {mod: 'ctl', key: 'e'}}, {mod: {mod: 'ctl', key: 'u'}}];
  let prompt = '';
  /**
   * Takes typed text off the dojo's line again; true when the ship then showed its bare prompt. `late`: the typing
   * itself got no answer, so the text may reach the ship after what the screen shows now; the clearing keys are then
   * always sent, since the ship takes them after the text if it takes the text at all.
   */
  const takeOff = async (late = false): Promise<boolean> => {
    standing = false;
    const isBare = () => screen.line === prompt && screen.input === '';
    if (!late && isBare()) return true;
    try {await send(clear.map(poke));} catch {return false;}
    return until(isBare, timing.answerMs / 2);
  };
  const notRun = async (message: string, late = false): Promise<DojoNotRun> => new DojoNotRun(message + (await takeOff(late) ? '' : STANDS));
  try {
    const watch: number[] = [];
    try {await send([{action: 'subscribe', ship, app: 'herm', path: '/session//view'}], watch);} catch {throw new DojoNotRun('Your ship did not open a terminal session. Nothing was typed.');}
    if (!await until(() => answers.has(watch[0]!), timing.answerMs)) throw new DojoNotRun('Your ship did not answer in time. Nothing was typed.');
    if (answers.get(watch[0]!) !== true) throw new DojoNotRun('Your ship has no web terminal service (%herm) to type into. Nothing was typed.');
    watching = watch[0]!;
    await until(() => screen.line !== '', timing.answerMs / 4);
    // What stands after the prompt is known only when the ship drew the line as prompt and input.
    const bare = (): string | undefined => screen.input === undefined ? undefined : screen.line.slice(0, screen.line.length - screen.input.length);
    const at = bare();
    if (at === undefined || !dojoReady(at)) {
      const waits = at !== undefined && dojoWaiting(at) ? ' The dojo holds the start of an expression: it is waiting for the rest, or still running it.' : '';
      throw new DojoNotRun(`Your ship's terminal is not at a ready dojo prompt (it shows: ${short(screen.line) || 'nothing'}). Finish or cancel that in the ship's own terminal first.${waits} Nothing was typed.`);
    }
    if (screen.input !== '') {
      // Text typed in the ship's own terminal and never sent stands on the line: it is cleared so that only this line runs.
      try {await send(clear.map(poke));} catch {throw new DojoNotRun('Your ship gave no answer while its dojo line was being emptied. Nothing was typed.');}
      if (!await until(() => screen.input === '' && screen.line === at, timing.answerMs / 2)) throw new DojoNotRun('The dojo line on your ship could not be emptied. Nothing was typed.');
    }
    prompt = at;
    const want = prompt + line, said = screen.lines.length, rung = screen.bells, text: number[] = [];
    standing = true;
    try {await send([poke({txt: Array.from(line)})], text);}
    catch (error) {
      if (!unknown(error)) {standing = false; throw new DojoNotRun('Your ship did not take the typed line. Nothing was typed.');}
      throw await notRun('Your ship gave no answer while the line was being typed. Return was not pressed, so it did not run.', true);
    }
    // The ship shows the whole line when it fits its terminal. A longer line is shown by its end only: beside the
    // prompt (short prompts), or with the prompt scrolled off too (long prompts, from the ship's source).
    const whole = () => screen.line === want;
    const ending = (): boolean => {
      const cursorLast = screen.column === Array.from(screen.line).length;
      if (screen.line.startsWith(prompt)) {const seen = screen.line.slice(prompt.length); return cursorLast && seen.length >= 20 && seen.length < line.length && line.endsWith(seen);}
      return cursorLast && screen.line.length >= 40 && screen.line.length < want.length && want.endsWith(screen.line);
    };
    // A dojo that is busy puts the text back itself, rings the bell and prints why: no need to wait out the time.
    const putBack = () => screen.bells > rung && screen.lines.length > said && screen.line === prompt && screen.input === '';
    await until(() => whole() || ending() || refused(text) || putBack(), timing.answerMs);
    if (!whole() && !ending()) {
      const told = screen.lines.slice(said).join(' / ');
      throw await notRun('The dojo on your ship did not show the line as you typed it, so it was not run.' + (told ? ` It said: ${short(told)}` : ''));
    }
    const partly = !whole(), bells = screen.bells, shown = screen.lines.length, enter: number[] = [];
    standing = false;
    try {await send([poke({ret: null})], enter);}
    catch (error) {
      if (unknown(error)) return 'No answer came back from your ship, so it is not known whether the line ran. It was not sent again. Look at the ship\'s own terminal.';
      throw await notRun('Your ship did not take the Return key, so the line was not run.');
    }
    const output = () => screen.lines.slice(shown).join('\n');
    const began = Date.now(); let reported = '';
    for (;;) {
      await sleep(timing.pollMs);
      const quiet = Date.now() - heard, now = output();
      if (now !== reported) {reported = now; report(tail(now));}
      if (refused(enter)) throw await notRun('Your ship did not take the Return key, so the line was not run.');
      const note = (screen.unknown ? `\n(${screen.unknown} screen update${screen.unknown === 1 ? '' : 's'} of a kind this version does not know ${screen.unknown === 1 ? 'was' : 'were'} not shown.)` : '')
        + (partly && !screen.lines.slice(shown).includes('> ' + line) ? '\n(This line is longer than your ship\'s terminal is wide, so only its end could be checked before Return, and the dojo did not print it back as typed. Check above what it ran.)' : '');
      const capped = Date.now() - began >= timing.capMs;
      // Return was taken, the bell rang and text still stands: the dojo could not read the line and ran nothing.
      if (answers.get(enter[0]!) === true && screen.bells > bells && screen.input !== '' && (capped || ended || quiet >= Math.min(timing.quietMs, 250))) {
        const fault = whole() ? Math.max(0, Math.min(Array.from(line).length, screen.column - Array.from(prompt).length)) : undefined;
        const off = await takeOff();
        return (fault === undefined ? 'The dojo did not take this line: it cannot read it. Nothing was run.'
          : `The dojo did not take this line: it cannot read it from character ${fault + 1} on. Nothing was run.\n${line}\n${' '.repeat(fault)}^`) + (off ? '' : '\n' + STANDS.trim());
      }
      if (screen.lines.length > shown && screen.input === '' && dojoWaiting(screen.line) && (capped || ended || quiet >= timing.quietMs)) {
        // The line was the start of a longer expression. One Backspace on the empty line cancels it (measured).
        let back = false;
        if (!ended) try {await send([poke({bac: null})]); back = await until(() => dojoReady(screen.line) && screen.input === '', timing.answerMs / 2);} catch { /* said below */ }
        return 'The dojo took this line as the start of a longer expression and waited for the rest. Readymade types one line at a time, so nothing was run'
          + (back ? ', and the unfinished expression was cancelled.' : '. Your ship\'s dojo is still waiting for the rest: press Backspace on its empty line in the ship\'s own terminal to cancel it.');
      }
      if (screen.lines.length > shown && screen.input === '' && quiet >= timing.quietMs)
        return tail(now + note + (dojoReady(screen.line) ? '' : `\n(The dojo now waits at: ${short(screen.line)} Answer it in your ship's own terminal.)`));
      if (ended) return tail(now + note + '\n(The connection to your ship ended while listening. The line was sent once.)');
      if (capped)
        return tail(now + note + `\n(Stopped listening after ${Math.round(timing.capMs / 1000)} seconds. Your ship may still be working; anything more appears in its own terminal.)`);
    }
  } finally {
    // A backstop only: every path above that leaves typed text standing takes it off itself.
    const leave = [...(standing ? clear.map(poke) : []), ...(watching ? [{action: 'unsubscribe', subscription: watching}] : []), {action: 'delete'}];
    await send(leave).catch(() => undefined);
    channel.close();
  }
}
