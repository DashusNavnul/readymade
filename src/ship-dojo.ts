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
 * only in part, around the cursor (`DrumView`); it is read in full before Return by moving the cursor through it.
 * A line that is the start of a longer expression is printed back and the prompt changes from `> ` to `< `; one
 * Backspace on that empty line cancels it. Debug prints (~&) do not pass through the terminal: the runtime serves
 * them as a stream of their own to a signed-in client, which is read beside it. The dojo marks no end of a command,
 * so the first answer is given once it has printed something and been quiet for `quietMs` (or at `capMs`), and
 * what the ship prints after that is still shown while the caller asks to `follow`.
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
  /** Lines that were longer than is kept and were cut. */
  cut = 0;
  /** A line to look out for among those that scroll above, and whether it has been seen: looked for as each line arrives, so that no amount of output after it can hide it. */
  expect?: string; seen = false;
  /** The lines that scrolled above the line, the newest last; only the last 2,000 are kept, and `dropped` counts those let go. */
  readonly lines: string[] = [];
  dropped = 0;
  /** What stands after the prompt, when the ship drew the line as prompt and input; undefined when it drew it another way. */
  input?: string;
  /** A ship's screen updates are untrusted: nesting, the cursor's column and a line's length are bounded here, the number of lines in `push`. */
  apply(blit: unknown, depth = 0): void {
    if (!blit || typeof blit !== 'object' || Array.isArray(blit) || depth > 8) {this.unknown++; return;}
    const entries = Object.entries(blit as Record<string, unknown>);
    if (entries.length !== 1) {this.unknown++; return;}
    const [kind, value] = entries[0]!;
    if (kind === 'mor' && Array.isArray(value)) {for (const each of value) this.apply(each, depth + 1); return;}
    if (kind === 'hop') {
      const to = typeof value === 'number' ? value : value && typeof value === 'object' ? (value as Record<string, unknown>).x : undefined;
      if (typeof to === 'number' && Number.isSafeInteger(to) && to >= 0 && to <= COLUMN_LIMIT) this.column = to; else this.unknown++;
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
    if (before.length > LINE_LIMIT) {before.length = LINE_LIMIT; this.cut++;}
    this.line = before.join(''); this.column = Math.min(LINE_LIMIT, this.column + add.length);
  }
  private held = 0;
  private push(line: string): void {
    if (this.expect !== undefined && line === this.expect) this.seen = true;
    if (line.length > LINE_LIMIT) {line = line.slice(0, LINE_LIMIT); this.cut++;}
    this.lines.push(line); this.held += line.length;
    // At most 2,000 lines and KEPT_LIMIT characters are kept; the oldest go first, and `dropped` counts them.
    let over = Math.max(0, this.lines.length - 2000), held = this.held;
    for (let n = 0; n < over; n++) held -= this.lines[n]!.length;
    while (held > KEPT_LIMIT && over < this.lines.length - 1) held -= this.lines[over++]!.length;
    if (over) {this.lines.splice(0, over); this.held = held; this.dropped += over; if (this.logged) this.logged.at -= over;}
  }
  private logged?: {text: string; count: number; at: number};
  /** A debug print from the runtime's own stream. The same print again straight after is counted, not repeated. */
  log(text: string): void {
    if (text.length > LINE_LIMIT) {text = text.slice(0, LINE_LIMIT); this.cut++;}
    const again = this.logged;
    if (again && again.text === text && again.at === this.lines.length - 1) {
      const counted = `${text} (×${++again.count})`;
      this.held += counted.length - this.lines[again.at]!.length; this.lines[again.at] = counted; return;
    }
    this.push(text); this.logged = {text, count: 1, at: this.lines.length - 1};
  }
}
/**
 * Bounds on what a ship can make the screen model hold. A line: the dojo prints a large number as one line however
 * wide (a guest ship's terminal is read back as numbers of some 7,000 characters, measured), so a line may be far
 * wider than any terminal. The cursor's column is the terminal's own and stays small. And all lines kept, together.
 */
const LINE_LIMIT = 65536, COLUMN_LIMIT = 4096, KEPT_LIMIT = 2000000;
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
 * How the ship's terminal shows an input line that may not fit its width (drum's +se-just), for a prompt and the
 * width it works with. A short prompt stays and the input scrolls beside it, keeping its place until the cursor
 * leaves the window; a prompt that takes 35 % or more of the width scrolls away with the input. `show` must be
 * called once for each place the cursor comes to rest, in order, as the terminal redraws at each.
 */
export class DrumView {
  private off = 0;
  private readonly prompt: string[];
  constructor(prompt: string, readonly edge: number) {this.prompt = Array.from(prompt);}
  /** The prompt scrolls away too. */
  get wide(): boolean {return Math.floor(this.prompt.length * 100 / this.edge) >= 35;}
  /** How much of the input is in view with the cursor at its start, and how much further each next window reaches. */
  get first(): number {return this.edge - this.prompt.length;}
  get span(): number {return this.wide ? this.edge : this.edge - this.prompt.length;}
  show(input: string[], cursor: number): {line: string; column: number} {
    const pol = this.prompt.length;
    if (this.wide) {
      const at = pol + cursor, off = at <= this.edge ? 0 : at - this.edge;
      return {line: [...this.prompt, ...input].slice(off, off + this.edge).join(''), column: at - off};
    }
    const room = this.edge - pol;
    this.off = cursor > room + this.off ? cursor - room : cursor < this.off ? Math.min(cursor, this.off - 1) : this.off;
    return {line: [...this.prompt, ...input.slice(this.off, this.off + room)].join(''), column: pol + cursor - this.off};
  }
}

/**
 * One channel on the ship: actions out, events in. `send` rejects with `code: 'outcomeUnknown'` when it cannot be
 * told whether the ship took the actions; any other rejection means the ship took none of them.
 */
export interface DojoChannel {readonly ship: string; send(actions: unknown[]): Promise<void>; close(): void}
export type DojoOpen = (onEvent: (event: JsonObject, id?: number) => void, onEnd: () => void) => DojoChannel;
/** The runtime's stream of debug prints, when the ship serves it; each call of `onPrint` is one print, which may have several lines. */
export type DojoPrints = (onPrint: (text: string) => void, onEnd: () => void) => {close(): void};
export interface DojoTiming {readonly answerMs: number; readonly quietMs: number; readonly capMs: number; readonly pollMs: number}
export const DOJO_TIMING: DojoTiming = Object.freeze({answerMs: 8000, quietMs: 1200, capMs: 30000, pollMs: 40});
/** After the first answer, what the ship prints is still reported for `ms`, or until `signal` aborts. */
export interface DojoFollow {readonly ms: number; readonly signal: AbortSignal}
export interface DojoOptions {readonly timing?: DojoTiming; readonly prints?: DojoPrints; readonly follow?: DojoFollow}
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
/**
 * What Gall prints each time terminal output reaches an agent that no longer listens for it: one that is asleep
 * ("dozing, dropping"), removed ("dead, got"), or restarted since it began listening ("got old ... for"). The
 * terminal driver keeps such a listener for good, so a ship with one prints several of these for every line its
 * terminal shows (measured, all three wordings). The terminal's own output causes them, never a command, so they
 * are left out of what a line is shown to have printed.
 */
const TERMINAL_ECHO = /^gall: (%[a-z0-9-]+ (dozing, dropping|dead, got) %(blit|logs)|got old %(blit|logs) for %[a-z0-9-]+)$/u;
/** What the dojo prints when its own handling of a line crashes (`+he-self` in app/dojo.hoon). */
const FAILED = 'dojo: failed to process input';
const STANDS = ' The text may still stand on its dojo line: clear it in the ship\'s own terminal before pressing Return there.';
const short = (text: string): string => text.length > 120 ? text.slice(0, 120) + '…' : text;

/**
 * Types one line into the ship's dojo and returns what it printed. `report` is given the output so far as it
 * arrives, and goes on being given it after the answer while `options.follow` lasts. The line is typed only when
 * the ship shows the dojo's ready prompt with nothing standing on it (a busy dojo shows it too, and then puts the
 * text back itself and says so). Return is pressed once, only after the ship has shown the whole line as typed:
 * at once when it fits the ship's terminal, otherwise window by window, the cursor moved through it. A line that
 * was typed and did not run is taken off the prompt again. Nothing is ever typed twice. The only keys sent are the
 * text, Return, ctl-a, ctl-e, ctl-k, ctl-u, right arrows, and one Backspace on a `< ` prompt this line itself
 * produced. Ctl-d, which quits the ship from an empty dojo line, is never sent.
 */
export async function runDojoLine(open: DojoOpen, line: string, report: (text: string) => void, options: DojoOptions = {}): Promise<string> {
  const timing = options.timing ?? DOJO_TIMING, follow = options.follow;
  if (!line || line.length > 500 || /[\u0000-\u001f\u007f]/u.test(line)) throw new DojoNotRun('A dojo line here is one line of up to 500 characters.');
  const screen = new DojoScreen(), answers = new Map<number, string | true>();
  let ended = false, last = 0, heard = Date.now(), next = 0, acked = 0, ackedAt = Date.now(), watching = 0, standing = false, pressed = false, handed = false;
  let channel: DojoChannel, prints: {close(): void} | undefined;
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
    if (all.length) ackedAt = Date.now();
    ids.push(...all.slice(all.length - actions.length).map(each => each.id));
    return all.length ? channel.send(all) : Promise.resolve();
  };
  /**
   * The ship ends a subscription that has 50 events unacknowledged when the last acknowledgement is 30 seconds
   * old, however quiet it was in between. So a long listen acknowledges as it goes: at 20 events waiting, and
   * every 10 seconds whether or not anything is waiting, which also sends again one that got no answer.
   */
  const keepUp = async (): Promise<void> => {
    if (!last || last - acked < 20 && Date.now() - ackedAt < 10000) return;
    ackedAt = Date.now(); acked = last;
    await channel.send([{id: ++next, action: 'ack', 'event-id': last}]).catch(() => undefined);
  };
  const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  /** Waits until `done()`; false when the time ran out or the channel ended first. */
  const until = async (done: () => boolean, ms: number): Promise<boolean> => {
    const stop = Date.now() + ms;
    while (!done()) {if (ended || Date.now() >= stop) return done(); await sleep(timing.pollMs);}
    return true;
  };
  const refused = (ids: number[]): boolean => ids.some(id => typeof answers.get(id) === 'string');
  const ctl = (key: string) => ({mod: {mod: 'ctl', key}}), clear = [ctl('e'), ctl('u')];
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
    // The bare prompt counts only once the ship has taken both keys: a screen that stopped updating shows it too.
    const ids: number[] = [];
    try {await send(clear.map(poke), ids);} catch {return false;}
    return until(() => refused(ids) || ids.every(id => answers.get(id) === true) && isBare(), timing.answerMs / 2).then(() => ids.every(id => answers.get(id) === true) && isBare());
  };
  const notRun = async (message: string, late = false): Promise<DojoNotRun> => new DojoNotRun(message + (await takeOff(late) ? '' : STANDS));
  const leave = async (): Promise<void> => {
    prints?.close();
    // The clearing keys here are a backstop only: every path that leaves typed text standing takes it off itself.
    // The channel is deleted in a request of its own, after the view is left: the ship prints a notice on its
    // console for anything it still had to send to a channel that is gone.
    if (standing || watching) await send([...(standing ? clear.map(poke) : []), ...(watching ? [{action: 'unsubscribe', subscription: watching}] : [])]).catch(() => undefined);
    await send([{action: 'delete'}]).catch(() => undefined);
    channel.close();
  };
  try {
    const watch: number[] = [];
    try {await send([{action: 'subscribe', ship, app: 'herm', path: '/session//view'}], watch);} catch {throw new DojoNotRun('Your ship did not open a terminal session. Nothing was typed.');}
    if (!await until(() => answers.has(watch[0]!), timing.answerMs)) throw new DojoNotRun('Your ship did not answer in time. Nothing was typed.');
    if (answers.get(watch[0]!) !== true) throw new DojoNotRun('Your ship has no web terminal service (%herm) to type into. Nothing was typed.');
    watching = watch[0]!;
    // Debug prints are read from before Return, so none of this line's are missed; those from before it are not shown.
    try {
      prints = options.prints?.(text => {
        if (!pressed) return;
        // Prints do not count as the terminal being busy: whether a line ran, was refused or waits is read from the terminal alone.
        for (const each of text.split('\n')) if (each.trim() && !TERMINAL_ECHO.test(each)) screen.log(each);
      }, () => undefined);
    } catch { /* a ship that does not serve them: the line runs without */ }
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
    const chars = Array.from(line), pol = Array.from(prompt).length;
    const want = prompt + line, said = screen.lines.length, rung = screen.bells, text: number[] = [];
    standing = true;
    try {await send([poke({txt: chars})], text);}
    catch (error) {
      if (!unknown(error)) {standing = false; throw new DojoNotRun('Your ship did not take the typed line. Nothing was typed.');}
      throw await notRun('Your ship gave no answer while the line was being typed. Return was not pressed, so it did not run.', true);
    }
    const whole = () => screen.line === want;
    /** The view of a line that does not fit the ship's terminal, the cursor at its end, when the screen shows exactly that: the cursor then stands at the terminal's edge. */
    const scrolled = (): DrumView | undefined => {
      const edge = screen.column;
      if (edge < 20 || edge >= pol + chars.length) return undefined;
      const view = new DrumView(prompt, edge);
      if (view.first < 1 && !view.wide) return undefined;
      const end = view.show(chars, chars.length);
      return screen.line === end.line && screen.column === end.column ? view : undefined;
    };
    // A dojo that is busy puts the text back itself, rings the bell and prints why: no need to wait out the time.
    const putBack = () => screen.bells > rung && screen.lines.length > said && screen.line === prompt && screen.input === '';
    await until(() => whole() || !!scrolled() || refused(text) || putBack(), timing.answerMs);
    const view = whole() ? undefined : scrolled();
    if (!whole() && !view) {
      const told = screen.lines.slice(said).join(' / ');
      // A busy dojo that put the text back itself has said so: no key is sent to it. Otherwise the ship took the text
      // and never showed it: it may be on the line all the same, so the clearing keys go whatever the screen shows.
      throw await notRun('The dojo on your ship did not show the line as you typed it, so it was not run.' + (told ? ` It said: ${short(told)}` : ''), !putBack());
    }
    if (view) {
      // The line does not fit the ship's terminal. It is read whole by putting the cursor at its start and moving
      // it right a window at a time to the place where the line should end: each view must be exactly the one
      // this line would give.
      // A view counts only once every key of the batch has been taken: a view the cursor passes on its way may
      // equal the one it is headed for, when the line repeats itself.
      // And no bell may ring meanwhile: a right arrow rings only where the line ends, which would be short of
      // where this one should.
      const key = async (belts: unknown[], shows: {line: string; column: number}): Promise<boolean> => {
        const ids: number[] = [], rang = screen.bells;
        try {await send(belts.map(poke), ids);} catch {return false;}
        const there = () => ids.every(id => answers.get(id) === true) && screen.line === shows.line && screen.column === shows.column;
        return until(() => refused(ids) || screen.bells > rang || there(), timing.answerMs).then(() => !refused(ids) && screen.bells === rang && there());
      };
      let cursor = 0, read = await key([ctl('a')], view.show(chars, 0));
      const windows: number[] = [];
      for (let target = view.first + view.span; target < chars.length; target += view.span) windows.push(target);
      for (const target of [...windows, chars.length]) {
        if (!read) break;
        const arrows: unknown[] = []; let shows = {line: '', column: 0};
        while (cursor < target) {shows = view.show(chars, ++cursor); arrows.push({aro: 'r'});}
        read = await key(arrows, shows);
      }
      if (read) {
        // Nothing shown tells a line's end from more of the same text beyond it. So what stands after the cursor
        // is cut (ctl-k, drum's +ta-ctl): at the end of the line that only rings the terminal's bell, and the line
        // that runs is in either case the one read above. No bell means text that was not typed here stood after
        // it: it is gone now, and the line is not run.
        const rang = screen.bells, cut: number[] = [];
        try {await send([poke(ctl('k'))], cut);} catch {read = false;}
        read = read && await until(() => refused(cut) || answers.get(cut[0]!) === true && screen.bells > rang, timing.answerMs) && !refused(cut) && screen.bells > rang;
      }
      if (!read) throw await notRun('Your ship\'s terminal did not show the whole of this line as you typed it, so it was not run.');
    }
    const bells = screen.bells, shown = screen.lines.length, enter: number[] = [];
    // A dojo that takes a line prints it back first. It is looked for as each line arrives, not when this next looks.
    screen.expect = '> ' + line; screen.seen = false;
    standing = false; pressed = true;
    try {await send([poke({ret: null})], enter);}
    catch (error) {
      if (unknown(error)) return 'No answer came back from your ship, so it is not known whether the line ran. It was not sent again. Look at the ship\'s own terminal.';
      pressed = false;
      throw await notRun('Your ship did not take the Return key, so the line was not run.');
    }
    const since = () => screen.lines.slice(Math.max(0, shown - screen.dropped));
    const output = () => since().join('\n');
    const notes = (): string => {
      const back = screen.seen;
      return (screen.unknown ? `\n(${screen.unknown} screen update${screen.unknown === 1 ? '' : 's'} of a kind this version does not know ${screen.unknown === 1 ? 'was' : 'were'} not shown.)` : '')
        + (screen.cut ? `\n(${screen.cut} line${screen.cut === 1 ? '' : 's'} too long to keep whole ${screen.cut === 1 ? 'was' : 'were'} cut short.)` : '')
        + (view && !back ? '\n(The dojo did not print this line back as you typed it. Check above what it ran.)' : '')
        // A dojo that takes a line prints it back first. Until it has, nothing shows that the line ran.
        + (!view && !back ? '\n(Your ship has not shown this line as taken, so it is not known whether it ran. It was sent once.)' : '')
        + (screen.input === '' && !dojoReady(screen.line) && !dojoWaiting(screen.line) ? `\n(The dojo now waits at: ${short(screen.line)} Answer it in your ship's own terminal.)` : '');
    };
    /** An answer after which the ship may print more: while the caller follows, that is still reported, and the channel is left only then. */
    const answer = (first: string): string => {
      if (!follow || ended || follow.signal.aborted) return first;
      handed = true;
      void (async () => {
        const stop = Date.now() + follow.ms; let told = first;
        try {
          while (!ended && !follow.signal.aborted && Date.now() < stop) {
            await sleep(timing.pollMs * 3); await keepUp();
            const now = tail(output() + notes());
            if (now !== told && !follow.signal.aborted) {told = now; report(now);}
          }
          if (ended && !follow.signal.aborted) report(tail(output() + notes() + '\n(Your ship stopped sending terminal output here; what it prints from now on is in its own terminal.)'));
        } catch { /* a caller that can no longer take reports: following stops */ } finally {await leave();}
      })();
      return first;
    };
    const began = Date.now(); let reported = '';
    for (;;) {
      await sleep(timing.pollMs); await keepUp();
      const quiet = Date.now() - heard, now = output();
      if (now !== reported) {reported = now; report(tail(now));}
      if (refused(enter)) {pressed = false; throw await notRun('Your ship did not take the Return key, so the line was not run.');}
      const capped = Date.now() - began >= timing.capMs;
      // Return was taken, the bell rang and text still stands: the dojo could not read the line and ran nothing.
      if (answers.get(enter[0]!) === true && screen.bells > bells && screen.input !== '' && (capped || ended || quiet >= Math.min(timing.quietMs, 250))) {
        const fault = whole() ? Math.max(0, Math.min(chars.length, screen.column - pol)) : undefined;
        const off = await takeOff();
        return (fault === undefined ? 'The dojo did not take this line: it cannot read it. Nothing was run.'
          : `The dojo did not take this line: it cannot read it from character ${fault + 1} on. Nothing was run.\n${line}\n${' '.repeat(fault)}^`) + (off ? '' : '\n' + STANDS.trim());
      }
      // Return was taken and the dojo said it could not process the input, with no bell and the text still standing:
      // working the line out crashed (a read the ship cannot answer does this; measured on a live ship, which then
      // waited here for the full time). The ship undoes all of a crashed event, so nothing ran.
      if (answers.get(enter[0]!) === true && !screen.seen && screen.input !== '' && since().includes(FAILED) && (capped || ended || quiet >= timing.quietMs)) {
        const off = await takeOff(true);
        return tail(now + '\n(The dojo could not work this line out, so nothing was run' + (off ? ', and the line was taken off its prompt again.)' : '.)' + STANDS));
      }
      if (screen.lines.length + screen.dropped > shown && screen.input === '' && dojoWaiting(screen.line) && (capped || ended || quiet >= timing.quietMs)) {
        // The line was the start of a longer expression. One Backspace on the empty line cancels it (measured).
        let back = false;
        if (!ended) try {await send([poke({bac: null})]); back = await until(() => dojoReady(screen.line) && screen.input === '', timing.answerMs / 2);} catch { /* said below */ }
        return 'The dojo took this line as the start of a longer expression and waited for the rest. Readymade types one line at a time, so nothing was run'
          + (back ? ', and the unfinished expression was cancelled.' : '. Your ship\'s dojo may still be waiting for the rest: if it is, press Backspace on its empty line in the ship\'s own terminal to cancel it.');
      }
      if (screen.lines.length + screen.dropped > shown && screen.input === '' && quiet >= timing.quietMs) return answer(tail(now + notes()));
      if (ended) return tail(now + notes() + '\n(The connection to your ship ended while listening. The line was sent once.)');
      if (capped) {
        const more = answer(tail(now + notes()));
        return handed ? more : tail(now + notes() + `\n(Stopped listening after ${Math.round(timing.capMs / 1000)} seconds. Your ship may still be working; anything more appears in its own terminal.)`);
      }
    }
  } finally {
    if (!handed) await leave();
  }
}
