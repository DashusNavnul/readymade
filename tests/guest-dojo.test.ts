import assert from 'node:assert/strict';
import test from 'node:test';
import {GUEST_CHUNK, GUEST_TAIL, guestAnswer, guestCount, guestCountLine, guestLine, guestPrompt, guestRead, guestReadLine, guestSendLine, runGuestLine} from '../src/guest-dojo';
import {DojoNotRun} from '../src/ship-dojo';

const GUEST = '~sampel-palnet-binzod-wanzod', PROMPT = GUEST + ':dojo> ', WAITING = GUEST + ':dojo< ';
const notRun = (pattern: RegExp) => (error: unknown) => error instanceof DojoNotRun && pattern.test(error.message);
/** A cord as the host's dojo prints it when cast to @ux: the text's bytes as one number, lowest byte first. */
const asNumber = (text: string | Buffer): string => {
  const hex = Buffer.from(typeof text === 'string' ? Buffer.from(text, 'utf8') : text).reverse().toString('hex').replace(/^0+/u, '') || '0';
  const head = hex.length % 4 || 4;
  return '0x' + [hex.slice(0, head), ...(hex.slice(head).match(/.{4}/gu) ?? [])].join('.');
};

test('`~guest> line` names a guest ship and its line; anything else is not a guest line', () => {
  assert.deepEqual(guestLine('  ~sampel-palnet> (add 2 2)  '), {guest: '~sampel-palnet', line: '(add 2 2)'});
  assert.deepEqual(guestLine(GUEST + '>+vats'), {guest: GUEST, line: '+vats'});
  assert.deepEqual(guestLine('~zod> > now'), {guest: '~zod', line: '> now'});
  assert.deepEqual(guestLine('~sampel-palnet--binzod-wanzod> x'), {guest: '~sampel-palnet--binzod-wanzod', line: 'x'}, 'a comet\'s name has a double hyphen');
  for (const other of ['~sampel-palnet', '~sampel-palnet>', '~sampel-palnet>   ', '~Sampel> x', '~sa> x', '~sampel---palnet> x', '~sampel-> x', 'sampel-palnet> x', '> ~zod', '(gth ~zod ~nec)', '~zod', '~[1 2]', '~2026.1.1> x', ''])
    assert.equal(guestLine(other), undefined, other);
});

test('the three host lines are exact, and a line cannot break out of the cord that carries it', () => {
  assert.equal(guestCountLine('~sampel-palnet'), '=+(t=.^(@t %gx /=bach=/dojo/~sampel-palnet/noun) =+(n=(met 3 t) [(~(has in (silt .^((list @p) %gx /=bach=/ships/noun))) ~sampel-palnet) n `@ux`(cut 3 [(sub n (min n 640)) 640] t)]))');
  assert.equal(GUEST_TAIL, 640); assert.ok(guestCountLine('~sampel-palnet-binzod-wanzod').length < 500, 'a host dojo line may be 500 characters');
  assert.equal(guestSendLine('~sampel-palnet', '(add 2 2)'), ':bach &bach-action [%dojo ~sampel-palnet \'(add 2 2)\']');
  assert.equal(guestSendLine('~sampel-palnet', ''), ':bach &bach-action [%dojo ~sampel-palnet \'\']');
  assert.equal(guestSendLine('~zod', `'] [%nuke ~zod] 'a\\`), `:bach &bach-action [%dojo ~zod '\\'] [%nuke ~zod] \\'a\\\\']`);
  assert.equal(guestReadLine('~sampel-palnet', 3760), '=+(t=.^(@t %gx /=bach=/dojo/~sampel-palnet/noun) [(met 3 t) `@ux`(cut 3 [3.760 2.800] t)])');
  assert.equal(guestReadLine('~zod', 1234567), '=+(t=.^(@t %gx /=bach=/dojo/~zod/noun) [(met 3 t) `@ux`(cut 3 [1.234.567 2.800] t)])');
  assert.equal(GUEST_CHUNK, 2800);
  for (const bad of ['line\nbreak', 'tab\there', 'café', 'x'.repeat(480)]) assert.throws(() => guestSendLine('~zod', bad), DojoNotRun, bad);
  assert.throws(() => guestSendLine('~zod', 'x'.repeat(480)), notRun(/can be up to 466 characters here/));
  assert.equal(guestSendLine('~zod', 'x'.repeat(466)).length, 500);
  for (const name of ['~zod\'] ', '~Zod', 'zod', '~zod/..', '']) {
    assert.throws(() => guestCountLine(name), DojoNotRun); assert.throws(() => guestSendLine(name, 'x'), DojoNotRun); assert.throws(() => guestReadLine(name, 0), DojoNotRun);
  }
  for (const from of [-1, 1.5, Number.NaN]) assert.throws(() => guestReadLine('~zod', from), DojoNotRun);
});

test('the host\'s answers are read strictly; anything else is not an answer', () => {
  assert.deepEqual(guestCount(`> =+(t=…\n[%.y 3.760 ${asNumber('4\n' + PROMPT)}]`), {hosted: true, length: 3760, tail: '4\n' + PROMPT});
  assert.deepEqual(guestCount('> x\n[%.n 0 0x0]\n'), {hosted: false, length: 0, tail: ''});
  for (const other of ['', 'dojo: hoon expression failed', '[%.y 3.760]', '[%.y 03.760 0x0]', '[%.y 3760.1 0x0]', '[%.y -1 0x0]', '[%.y 3.76 0x0]', '[& 3.760 0x0]', '[%.y 3.760 0x061]', '[%.y 3.760 61]']) assert.equal(guestCount(other), undefined, other);
  const text = PROMPT + '(add 2 2)> (add 2 2)\n' + PROMPT + '4\n' + PROMPT;
  const read = (output: string) => {const got = guestRead(output); return got && {length: got.length, text: got.bytes.toString('utf8')};};
  assert.deepEqual(read(`> =+(t=…\n[3.947 ${asNumber(text)}]`), {length: 3947, text});
  assert.deepEqual(read('[3.760 0x0]'), {length: 3760, text: ''});
  // a wide value is laid out over several lines by the host's printer (as recorded)
  assert.deepEqual(read(`> =+(t=…\n[ 5.094\n  ${asNumber(text)}\n]`), {length: 5094, text});
  assert.deepEqual(guestCount(`> =+(t=…\n[ %.y\n  3.760\n  ${asNumber(PROMPT)}\n]`), {hosted: true, length: 3760, tail: PROMPT});
  // an answer is what follows the echoed line, whole: stray lines before or after make it no answer
  assert.equal(guestRead(`[3.947 0x61]\n[1 0x62]`), undefined); assert.equal(guestCount('[%.y 1 0x61]\nnoise'), undefined);
  assert.deepEqual(read(`[12 ${asNumber('café \n')}]`), {length: 12, text: 'café \n'});
  assert.equal(guestRead(`[12 ${asNumber('café \n')}]`)!.bytes.length, 7);
  assert.equal(asNumber('a'), '0x61'); assert.equal(asNumber('ab'), '0x6261'); assert.equal(asNumber('abc'), '0x63.6261');
  for (const other of ['', '[3.947 61]', '[3.947 0x061]', '[3.947 0x12345]', '[3.947 0xzz]', '3.947 0x61', '[%.y 0x61]']) assert.equal(guestRead(other), undefined, other);
});

test('what the guest\'s terminal gained says whether its dojo took the line, what it printed, and whether it waits', () => {
  // as recorded from a live host (ship name replaced): the prompt is redrawn before every line
  const ran = PROMPT + '(turn (gulf 1 3) |=(a=@ (mul a a)))> (turn (gulf 1 3) |=(a=@ (mul a a)))\n' + PROMPT + '~[1 4 9]\n' + PROMPT;
  assert.deepEqual(guestAnswer(ran, GUEST, '(turn (gulf 1 3) |=(a=@ (mul a a)))'), {ran: true, waiting: false, text: '~[1 4 9]'});
  // a line the guest's dojo cannot read is typed and never printed back
  assert.deepEqual(guestAnswer(PROMPT + PROMPT + 'hello world', GUEST, 'hello world'), {ran: false, waiting: false, text: ''});
  assert.deepEqual(guestAnswer('', GUEST, '(add 2 2)'), {ran: false, waiting: false, text: ''});
  // several lines of output, and a directory in the prompt
  const dir = GUEST + ':dojo/landscape> ';
  assert.deepEqual(guestAnswer(dir + '+x> +x\n' + dir + 'one\n' + dir + 'two\n' + dir, GUEST, '+x'), {ran: true, waiting: false, text: 'one\ntwo'});
  // the start of a longer expression: printed back, and the prompt is now the waiting one
  assert.deepEqual(guestAnswer(PROMPT + '|=  a=@> |=  a=@\n' + PROMPT + WAITING, GUEST, '|=  a=@'), {ran: true, waiting: true, text: ''});
  // another guest's prompt in the output is left alone
  assert.equal(guestAnswer(PROMPT + 'x> x\n' + PROMPT + '~zod:dojo> hi\n' + PROMPT, GUEST, 'x').text, '~zod:dojo> hi');
  // the guest's own prompt inside the line, or inside what it printed, is text like any other
  const quoting = `"${PROMPT}"`;
  assert.deepEqual(guestAnswer(PROMPT + quoting + '> ' + quoting + '\n' + PROMPT + quoting + '\n' + PROMPT, GUEST, quoting), {ran: true, waiting: false, text: quoting});
});

test('how a guest\'s terminal ends says whether its dojo holds an unfinished expression', () => {
  // as measured on a live host: an idle guest's terminal ends with its prompt
  assert.equal(guestPrompt('  /desk/bill:             ~[%hood %dojo]\n::\n' + PROMPT, GUEST), 'ready');
  assert.equal(guestPrompt(PROMPT + '4\n' + GUEST + ':dojo/landscape> ', GUEST), 'ready', 'a directory in the prompt');
  // as measured: a line the dojo could not read stays after the prompt, and the host clears it before the next
  assert.equal(guestPrompt(PROMPT + PROMPT + '(add 2', GUEST), 'ready');
  assert.equal(guestPrompt(PROMPT + '(add 2> (add 2\n' + PROMPT + WAITING, GUEST), 'waiting');
  assert.equal(guestPrompt(WAITING + '2', GUEST), 'waiting', 'text typed at the waiting prompt and not taken');
  assert.equal(guestPrompt(WAITING + '> \n' + PROMPT, GUEST), 'ready', 'cancelled since');
  for (const other of ['', 'x'.repeat(640), '~zod:dojo< ', PROMPT.trimEnd()]) assert.equal(guestPrompt(other, GUEST), 'unknown', JSON.stringify(other));
  assert.throws(() => guestPrompt(PROMPT, '~zod.*'), DojoNotRun);
});

/** The text a Hoon cord holds, read the way the host's parser reads `'…'`: a backslash takes the next character, a quote ends it. */
function cord(hostLine: string): string {
  const open = hostLine.indexOf('\''); assert.ok(open > 0 && hostLine.startsWith(':bach &bach-action [%dojo ~'), hostLine);
  let text = '', at = open + 1;
  for (;; at++) {
    const here = hostLine[at]; assert.ok(here !== undefined, 'the cord never ends: ' + hostLine);
    if (here === '\'') break;
    if (here === '\\') {const next = hostLine[++at]; assert.ok(next === '\\' || next === '\'', `an escape the host would read otherwise: \\${next}`); text += next; continue;}
    text += here;
  }
  assert.equal(hostLine.slice(at), '\']', 'nothing but the closing bracket follows the cord: ' + hostLine);
  return text;
}
/** A host whose dojo answers the three lines as the real one does, for one guest. */
function host(options: {hosted?: boolean; noBach?: boolean; answer?: (line: string) => string; unreadable?: boolean | 'throws'; slowBy?: number; unconfirmed?: string; held?: string; deaf?: boolean; ends?: string; flaky?: 'recount' | 'send' | 'cancel'} = {}) {
  const lines: string[] = [], received: string[] = [];
  // `held`: the guest's dojo already holds the start of an expression, typed by someone before; `deaf`: it does not let go of it; `ends`: how its terminal ends instead of at the prompt.
  let terminal = 'x'.repeat(40) + '\n' + (options.held !== undefined ? PROMPT + options.held + '> ' + options.held + '\n' + PROMPT + WAITING : options.ends ?? PROMPT), waiting = options.held !== undefined, readsSinceSend = 0;
  const dotted = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/gu, '.');
  const run = async (line: string): Promise<string> => {
    lines.push(line);
    if (line.startsWith('=+(t=') && line.includes('(~(has in')) {
      if (options.flaky === 'recount' && received.includes('')) throw new DojoNotRun('Your ship did not answer in time. Nothing was typed.');
      const all = Buffer.from(terminal, 'utf8');
      return options.noBach ? `> ${line}\ndojo: hoon expression failed` : `> ${line}\n[%.${options.hosted === false ? 'n' : 'y'} ${dotted(all.length)} ${asNumber(all.subarray(Math.max(0, all.length - GUEST_TAIL)))}]`;
    }
    if (line.startsWith(':bach &bach-action')) {
      const typed = cord(line);
      if (options.flaky === 'cancel' && typed === '' || options.flaky === 'send' && typed !== '') throw new DojoNotRun('Your ship did not answer in time. Nothing was typed.');
      received.push(typed);
      readsSinceSend = 0;
      if (typed === '') {if (waiting && !options.deaf) {waiting = false; terminal += '> \n' + PROMPT;} return `> ${line}\n>=`;}
      if (options.unconfirmed !== undefined) return options.unconfirmed;
      const said = (options.answer ?? (() => '4'))(typed);
      if (said === 'REFUSE') terminal += PROMPT + typed;
      else if (said === 'PARTIAL') {waiting = true; terminal += PROMPT + typed + '> ' + typed + '\n' + PROMPT + WAITING;}
      // a guest that still holds the start of an expression takes the line as its next part: printed back indented, and the whole then runs
      else if (waiting) {waiting = false; terminal += typed + '  ' + typed + '\n' + PROMPT + 'ran with what was held\n' + PROMPT;}
      else terminal += PROMPT + typed + '> ' + typed + '\n' + said.split('\n').map(each => PROMPT + each + '\n').join('') + PROMPT;
      return `> ${line}\n>=`;
    }
    const read = /\[\(met 3 t\) `@ux`\(cut 3 \[([0-9.]+) ([0-9.]+)\] t\)\]\)$/u.exec(line);
    assert.ok(read, 'a line this host does not know: ' + line);
    if (options.unreadable === 'throws') throw new DojoNotRun('Your ship did not answer in time. Nothing was typed.');
    if (options.unreadable) return `> ${line}\ndojo: hoon expression failed`;
    const all = Buffer.from(terminal, 'utf8'), from = Number(read[1]!.replaceAll('.', '')), size = Number(read[2]!.replaceAll('.', ''));
    const visible = options.slowBy && readsSinceSend++ < options.slowBy ? all.subarray(0, 41 + PROMPT.length) : all;
    return `> ${line}\n[${String(visible.length).replace(/\B(?=(\d{3})+(?!\d))/gu, '.')} ${asNumber(visible.subarray(from, from + size))}]`;
  };
  return {run, lines, received, sends: () => lines.filter(line => line.startsWith(':bach')).length, terminal: () => terminal, waiting: () => waiting};
}

test('a line goes to the guest once, through three lines on its host, and the guest\'s answer comes back', async () => {
  const h = host({answer: line => line === '(add 2 2)' ? '4' : 'one\ntwo'}), said: string[] = [];
  assert.equal(await runGuestLine(h.run, GUEST, '(add 2 2)', text => said.push(text), 5), '> (add 2 2)\n4');
  assert.deepEqual(h.lines.map(line => line.slice(0, 12)), ['=+(t=.^(@t %', ':bach &bach-', '=+(t=.^(@t %']);
  assert.equal(h.lines[1], `:bach &bach-action [%dojo ${GUEST} '(add 2 2)']`);
  assert.deepEqual(said, [`Typing into ${GUEST}'s dojo through its host…`]);
  assert.equal(await runGuestLine(h.run, GUEST, `'it''s'`, () => undefined, 5), `> 'it''s'\none\ntwo`);
  assert.equal(h.sends(), 2);
});

test('the guest receives exactly the line typed, whatever quotes and backslashes it holds', async () => {
  const tricky = [`'`, `\\`, `''`, `'''`, `\\41`, `\\/`, `\\'`, `a\\`, `'] [%nuke ~zod] '`, `\\\\'\\`, `it's a "test" {1 2} \\0a`, `caf'e\\\\`];
  const h = host({answer: () => 'ok'});
  for (const line of tricky) assert.equal(await runGuestLine(h.run, GUEST, line, () => undefined, 5), `> ${line}\nok`, JSON.stringify(line));
  assert.deepEqual(h.received, tricky);
  // text spanning chunks is put together before it is read as characters
  const wide = host({answer: () => 'é'.repeat(3000)});
  assert.equal(await runGuestLine(wide.run, GUEST, '+x', () => undefined, 5), '> +x\n' + 'é'.repeat(3000));
});

test('nothing is sent to a guest the host does not have, or through a ship that hosts none', async () => {
  const none = host({hosted: false});
  await assert.rejects(runGuestLine(none.run, GUEST, '(add 2 2)', () => undefined, 5), notRun(new RegExp(`hosts no guest ship ${GUEST}\\. Nothing was sent\\.$`)));
  const plain = host({noBach: true});
  await assert.rejects(runGuestLine(plain.run, GUEST, '(add 2 2)', () => undefined, 5), notRun(/did not answer as a host of guest ships does \(its %bach agent\)\. Nothing was sent\.$/));
  for (const h of [none, plain]) {assert.equal(h.sends(), 0); assert.equal(h.lines.length, 1);}
  await assert.rejects(runGuestLine(host().run, GUEST, 'café', () => undefined, 5), notRun(/plain keyboard characters only/));
  const failing = async (): Promise<string> => {throw new DojoNotRun('Your ship did not answer in time. Nothing was typed.');};
  await assert.rejects(runGuestLine(failing, GUEST, 'x', () => undefined, 5), notRun(/did not answer in time/));
});

test('a line the guest cannot read is said to be not taken; a slow guest is looked at once more; the line is never sent twice', async () => {
  const refused = host({answer: () => 'REFUSE'});
  assert.equal(await runGuestLine(refused.run, GUEST, 'hello world', () => undefined, 5), `${GUEST}'s dojo has not printed the line back, so as far as its terminal shows it did not take it: it cannot read it, or it is busy and may run it yet.`);
  assert.equal(refused.sends(), 1);
  const slow = host({slowBy: 1});
  assert.equal(await runGuestLine(slow.run, GUEST, '(add 2 2)', () => undefined, 5), '> (add 2 2)\n4');
  assert.equal(slow.sends(), 1);
  // once the line is sent, a read that fails or throws never turns into "nothing was typed"
  for (const unreadable of [true, 'throws'] as const) {
    const blind = host({unreadable});
    assert.equal(await runGuestLine(blind.run, GUEST, '(add 2 2)', () => undefined, 5), `The line was sent to ${GUEST} once, but its terminal could not be read back through the host. Look at it there.`);
    assert.equal(blind.sends(), 1);
  }
  // the host's dojo did not confirm the hand-over: said as unknown, with the host's words, and nothing more is sent
  const lost = host({unconfirmed: 'No answer came back from your ship, so it is not known whether the line ran. It was not sent again.'});
  assert.equal(await runGuestLine(lost.run, GUEST, '(add 2 2)', () => undefined, 5), `The host did not confirm handing the line to ${GUEST}, so it is not known whether it ran there. It was not sent again. The host said: No answer came back from your ship, so it is not known whether the line ran. It was not sent again.`);
  assert.deepEqual([lost.sends(), lost.lines.length], [1, 2]);
});

test('the start of a longer expression is cancelled on the guest with an empty line', async () => {
  const h = host({answer: () => 'PARTIAL'});
  assert.equal(await runGuestLine(h.run, GUEST, '|=  a=@', () => undefined, 5),
    `${GUEST}'s dojo took this line as the start of a longer expression and waited for the rest. One line at a time goes to a guest, so nothing was run, and the unfinished expression was cancelled.`);
  assert.deepEqual([h.sends(), h.lines.filter(line => line.endsWith(`[%dojo ${GUEST} '']`)).length, h.waiting()], [2, 1, false]);
});

test('a held expression on the guest is cancelled before the line is typed; text left on its prompt is no reason to refuse', async () => {
  // someone left `(add 2` unfinished on the guest: typing `2)` now would run `(add 2 2)` and be reported as not taken
  const h = host({held: '(add 2', answer: () => '4'}), said: string[] = [];
  assert.equal(await runGuestLine(h.run, GUEST, '(add 1 1)', text => said.push(text), 5), `> (add 1 1)\n4\n(${GUEST}'s terminal showed the prompt of an unfinished expression; an empty line was sent first to cancel it.)`);
  assert.deepEqual(h.received, ['', '(add 1 1)'], 'the cancelling empty line, then the line, once each');
  assert.deepEqual(said, [`${GUEST}'s dojo shows the prompt of an unfinished expression. Sending an empty line to cancel that first…`, `Typing into ${GUEST}'s dojo through its host…`]);
  assert.doesNotMatch(h.terminal(), /ran with what was held/);
  // a guest that does not let go of it gets the cancelling line and never the typed one
  const deaf = host({held: '(add 2', deaf: true});
  await assert.rejects(runGuestLine(deaf.run, GUEST, '2)', () => undefined, 5), notRun(/An empty line was sent to cancel it, and its terminal does not show the ready prompt since\. Your line was not sent\./));
  assert.deepEqual(deaf.received, ['']);
  // once the empty line may have gone, every way out says so; when it did not go, that is said instead
  const blind = host({held: '(add 2', flaky: 'recount'});
  await assert.rejects(runGuestLine(blind.run, GUEST, '2)', () => undefined, 5), notRun(/An empty line was sent to cancel it, and the guest's terminal could not be read after that\. Your line was not sent\./));
  assert.deepEqual(blind.received, ['']);
  const dropped = host({held: '(add 2', flaky: 'send'});
  await assert.rejects(runGuestLine(dropped.run, GUEST, '2)', () => undefined, 5), notRun(/^Your ship did not answer in time\. Nothing was typed\.\n\(.*an empty line was sent first to cancel it\.\)$/));
  const stuck = host({held: '(add 2', flaky: 'cancel'});
  await assert.rejects(runGuestLine(stuck.run, GUEST, '2)', () => undefined, 5), notRun(/The empty line that would cancel it did not go: Your ship did not answer in time\. Nothing was typed\. Your line was not sent\./));
  assert.deepEqual(stuck.received, []);
  const lost = host({held: '(add 2', unconfirmed: 'No answer came back from your ship.'});
  assert.match(await runGuestLine(lost.run, GUEST, '2)', () => undefined, 5), /^The host did not confirm handing the line .* It was not sent again\. The host said: No answer came back from your ship\.\n\(.*an empty line was sent first to cancel it\.\)$/);
  // text left standing on the ready prompt, or a terminal read mid-print: the host clears the line itself, so the line goes as before
  for (const ends of [PROMPT + PROMPT + '(add 2', PROMPT + '+long-job> +long-job\nworking']) {
    const left = host({ends, answer: () => '4'});
    assert.equal(await runGuestLine(left.run, GUEST, '(add 2 2)', () => undefined, 5), '> (add 2 2)\n4');
    assert.deepEqual(left.received, ['(add 2 2)']);
  }
});

test('a long answer is read in chunks, and what is beyond four of them is said to be missing', async () => {
  const rows = Array.from({length: 120}, (_, n) => `row ${n} ` + 'y'.repeat(40)).join('\n');
  const h = host({answer: () => rows});
  const out = await runGuestLine(h.run, GUEST, '+x', () => undefined, 5);
  assert.equal(out, '> +x\n' + rows);
  assert.ok(h.lines.filter(line => line.endsWith('] t)])')).length > 2, 'more than one chunk');
  const huge = host({answer: () => Array.from({length: 400}, (_, n) => `row ${n} ` + 'y'.repeat(40)).join('\n')});
  const cut = await runGuestLine(huge.run, GUEST, '+x', () => undefined, 5);
  assert.match(cut, /^> \+x\nrow 0 y+\n/); assert.match(cut, /\n\(The guest ship printed more than is shown here; whether its dojo now waits for more input is not known\.\)$/);
  assert.equal(huge.lines.filter(line => line.endsWith('] t)])')).length, 4);
});
