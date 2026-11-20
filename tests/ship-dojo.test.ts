import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DOJO_OUTPUT_MAX, DojoNotRun, DojoScreen, DrumView, dojoLine, dojoReady, dojoWaiting, runDojoLine, streamEvents, type DojoOpen, type DojoPrints, type DojoTiming} from '../src/ship-dojo';
import type {JsonObject} from '../src/protocol';

// Screen updates recorded from a live ship through %herm (see the fixture's own note).
const recorded = JSON.parse(readFileSync(join(__dirname, '../../tests/fixtures/dojo/blits.json'), 'utf8')) as {
  redraw: unknown; add: {line: string; bell: unknown; echo: unknown; ran: unknown[]}; hello: {line: string; echo: unknown; refused: unknown}; need: {line: string; ran: unknown[]}; long: {line: string; echo: unknown}};
const PROMPT = '~sampel-palnet:dojo> ', WAITING = '~sampel-palnet:dojo< ', MOON = '~bitbet-bolbel-sampel-palnet:dojo> ';
const quick: DojoTiming = {answerMs: 300, quietMs: 40, capMs: 400, pollMs: 5};
const plain = {back: null, fore: null, deco: []};
const printed = (text: string) => ({mor: [{hop: 0}, {wyp: true}, {put: Array.from(text)}, {nel: true}]});
type Fail = 'unknown' | 'refused';
type TextFail = Fail | 'lands';
const fail = (how: Fail): Error => Object.assign(new Error(how), how === 'unknown' ? {code: 'outcomeUnknown'} : {code: 'refused'});

/**
 * A ship's dojo line as %herm serves it, drawn as the ship's terminal draws it (drum's +se-just, written out here
 * on its own): a short prompt stays and the input scrolls beside it; a prompt of 35 % of the width or more scrolls
 * away with it. `edge` is the width the terminal works with (79 on the 80-column ship this was measured on).
 */
function ship(options: {standing?: string; prompt?: string; mute?: boolean; garble?: boolean | 'more' | number | ((typed: string) => string); foreignBell?: boolean | 'cut'; paced?: number; busy?: boolean; edge?: number; failText?: TextFail; failClear?: boolean; failReturn?: Fail; nackReturn?: boolean;
  noise?: 'afterEcho' | 'afterBell' | 'constant'; endAfterReturn?: boolean; throwOpen?: boolean; swallow?: 'stall' | 'quiet'; failBack?: boolean;
  onReturn?: (line: string) => unknown[] | 'refuse' | 'forever' | 'partial' | 'crash'} = {}) {
  const sent: JsonObject[] = [], ranLines: string[] = [], edge = options.edge ?? 79;
  let input = options.standing ?? '', cursor = input.length, off = 0, prompt = options.prompt ?? PROMPT, closed = 0, ended = false, stalled = false, timer: NodeJS.Timeout | undefined;
  let emitLine: ((text: string) => void) | undefined, emitRaw: ((json: unknown) => void) | undefined, endStream: (() => void) | undefined;
  const open: DojoOpen = (onEvent, onEnd) => {
    if (options.throwOpen) throw new Error('authenticationRequired');
    let eventId = 0;
    // `paced`: the events reach the app that many milliseconds apart, as over a slow link, so that it sees the screens in between.
    let due = 0;
    const emit = (event: JsonObject) => {
      if (stalled) return;
      due = options.paced ? Math.max(due, Date.now()) + options.paced : Date.now() + 1;
      setTimeout(() => {if (!closed && !ended) onEvent(event, ++eventId);}, due - Date.now());
    };
    const blit = (json: unknown) => emit({json, id: 1, mark: 'blit', response: 'diff'} as JsonObject);
    emitLine = text => blit({mor: [printed(text), draw()]}); emitRaw = blit; endStream = () => {ended = true; onEnd();};
    const draw = () => {
      if (Math.floor(prompt.length * 100 / edge) >= 35) {
        const at = prompt.length + cursor, from = at <= edge ? 0 : at - edge, parts = [prompt.slice(from), input.slice(Math.max(0, from - prompt.length), Math.max(0, from + edge - prompt.length))];
        return {mor: [{hop: 0}, {wyp: true}, {klr: parts.filter((part, n) => part || n).map(part => ({stye: plain, text: Array.from(part)}))}, {hop: at - from}]};
      }
      const room = edge - prompt.length;
      off = cursor > room + off ? cursor - room : cursor < off ? Math.min(cursor, Math.max(0, off - 1)) : off;
      return {mor: [{hop: 0}, {wyp: true}, {klr: [{stye: plain, text: Array.from(prompt)}, {stye: plain, text: Array.from(input.slice(off, off + room))}]}, {hop: prompt.length + cursor - off}]};
    };
    return {ship: '~sampel-palnet', close: () => {closed++; if (timer) clearInterval(timer); onEnd();}, send: async actions => {
      for (const action of actions as JsonObject[]) {
        const belt = action.action === 'poke' ? ((action.json as JsonObject).belt ?? {}) as JsonObject : {};
        if (Object.hasOwn(belt, 'ret') && options.failReturn) throw fail(options.failReturn);
        if (Array.isArray(belt.txt) && options.failText === 'lands') {input += (belt.txt as string[]).join(''); cursor = input.length; throw fail('unknown');}
        if (Array.isArray(belt.txt) && options.failText) throw fail(options.failText as Fail);
        if (Object.hasOwn(belt, 'mod') && options.failClear) throw fail('unknown');
        if (Object.hasOwn(belt, 'bac') && options.failBack) {if (!input && prompt === WAITING) prompt = PROMPT; throw fail('unknown');}
        sent.push(action);
        if (action.action === 'subscribe') {if (options.mute) continue; emit({ok: 'ok', id: action.id, response: 'subscribe'}); blit(draw()); continue;}
        if (action.action !== 'poke') continue;
        if (Object.hasOwn(belt, 'ret') && options.nackReturn) {emit({err: 'crashed', id: action.id, response: 'poke'}); continue;}
        emit({ok: 'ok', id: action.id, response: 'poke'});
        if (Object.hasOwn(belt, 'mod')) {
          const key = (belt.mod as JsonObject).key;
          if (options.foreignBell === true || options.foreignBell === 'cut' && key === 'k') blit({bel: true});
          if (key === 'e') {cursor = input.length; blit(draw());}
          else if (key === 'a') {cursor = 0; blit(draw());}
          else if (key === 'k') {if (cursor === input.length) blit({bel: true}); else {input = input.slice(0, cursor); blit(draw());}}
          else if (key === 'u') {if (cursor === 0) blit({bel: true}); else {input = input.slice(cursor); cursor = 0; blit(draw());}}
          continue;
        }
        if (Object.hasOwn(belt, 'aro')) {if (options.foreignBell === true) blit({bel: true}); if (belt.aro === 'r' && cursor < input.length) {cursor++; blit(draw());} else blit({bel: true}); continue;}
        if (Object.hasOwn(belt, 'bac')) {if (!input && prompt === WAITING) {prompt = PROMPT; blit(draw());} else blit({bel: true}); continue;}
        if (Array.isArray(belt.txt)) {
          if (options.busy) {blit({mor: [draw(), {bel: true}, printed('dojo: busy (press backspace to abort)'), draw()]}); continue;}
          // `swallow`: the ship takes the text and the app never sees it drawn; with 'stall' nothing at all reaches the app from then on.
          if (options.swallow) {input += (belt.txt as string[]).join(''); cursor = input.length; stalled = options.swallow === 'stall'; continue;}
          const typed = (belt.txt as string[]).join(''), g = options.garble;
          const put = typeof g === 'function' ? g(typed) : typeof g === 'number' ? typed.slice(0, g) + '#' + typed.slice(g + 1)
            : g === 'more' ? typed + typed.slice(-1) : g ? typed.slice(0, -1) + '#' : typed;
          input = input.slice(0, cursor) + put + input.slice(cursor); cursor += put.length; blit(draw());
          if (options.noise === 'afterEcho') blit({mor: [printed('ames: noise'), draw()]});
          continue;
        }
        if (Object.hasOwn(belt, 'ret')) {
          const answer = (options.onReturn ?? ((line: string) => [{mor: [printed('> ' + line), draw()]}, {mor: [printed('4'), draw()]}]))(input);
          if (options.noise === 'constant') timer = setInterval(() => blit({mor: [printed('ames: noise'), draw()]}), 10);
          if (answer === 'refuse') {
            const before = off; cursor = Math.min(6, input.length); const redrawn = draw();
            blit(before === off ? {mor: [{bel: true}, {hop: prompt.length + cursor - off}]} : {mor: [{bel: true}, redrawn]});
            if (options.noise === 'afterBell') blit({mor: [printed('ames: noise'), draw()]});
            continue;
          }
          // The dojo's own handling of the line crashed: it says so, rings no bell, and the line stays on the prompt (as on a live ship).
          if (answer === 'crash') {blit({mor: [printed('dojo: failed to process input'), draw()]}); continue;}
          const ran = input; ranLines.push(ran); input = ''; cursor = 0; off = 0;
          if (answer === 'forever') {let n = 0; timer = setInterval(() => blit({mor: [printed('line ' + ++n), draw()]}), 10); continue;}
          if (answer === 'partial') {blit({mor: [printed('> ' + ran), draw()]}); prompt = WAITING; blit(draw()); continue;}
          for (const each of (options.onReturn ? answer : [{mor: [printed('> ' + ran), draw()]}, {mor: [printed('4'), draw()]}])) blit(each);
          if (options.endAfterReturn) setTimeout(() => {ended = true; onEnd();}, 8);
        }
      }
    }};
  };
  const belts = () => sent.filter(a => a.action === 'poke').map(a => (a.json as JsonObject).belt as JsonObject);
  const count = (key: string) => belts().filter(b => Object.hasOwn(b, key)).length;
  return {open, sent, belts, returns: () => count('ret'), clears: () => count('mod'), backs: () => count('bac'), closed: () => closed, left: () => ({input, prompt}),
    ran: () => ranLines, end: () => endStream?.(), raw: (json: unknown) => emitRaw?.(json), arrows: () => count('aro'), acks: () => sent.filter(a => a.action === 'ack').length, print: (text: string) => emitLine?.(text), deleted: () => sent.filter(a => a.action === 'delete').length};
}
const notRun = (pattern: RegExp) => (error: unknown) => error instanceof DojoNotRun && pattern.test(error.message);

test('a line that starts as dojo input does is a dojo line; words are an instruction', () => {
  for (const line of ['+vats', '|hi ~zod', '(add 2 2)', ':hood +hood/pass', '-read %x', '=a 5', '.^(@ %j /=code=/~zod)', '%foo', '~zod', '`@ux`5', '[1 2]', '@ud', '42', "'cord'", '"tape"', '&noun 5', '!!', '<1 2>', '?=(~ ~)', '_5', '{1 2}'])
    assert.equal(dojoLine(`  ${line}  `), line, line);
  for (const words of ['invite ~sampel-palnet as a contributor', 'open the doctor', 'now', 'our', '', '   ', 'a\nb', '+va\u0007ts'])
    assert.equal(dojoLine(words), undefined, JSON.stringify(words));
  assert.equal(dojoLine('> now'), 'now');
  assert.equal(dojoLine('>our'), 'our');
  assert.equal(dojoLine('>   '), undefined);
});

test('the dojo\'s ready prompt is told from its waiting prompt and from anything else', () => {
  for (const ready of [PROMPT, '~zod:dojo> ', '~sampel-palnet:dojo/landscape> ', '~bitbet-bolbel-sampel-palnet:dojo/=/=/~2020.1.1/lib> ']) {assert.ok(dojoReady(ready), ready); assert.equal(dojoWaiting(ready), false);}
  assert.ok(dojoWaiting(WAITING)); assert.equal(dojoReady(WAITING), false);
  assert.ok(dojoReady('~sampel_palnet:dojo> '), 'a comet is named with an underscore');
  for (const other of ['', '> ', 'Password: ', '~sampel-palnet:chat> ', '~sampel-palnet:dojo> x', 'install? (y/n) ', ' ~sampel-palnet:dojo> ']) {assert.equal(dojoReady(other), false, other); assert.equal(dojoWaiting(other), false, other);}
});

test('the recorded screen updates fold into the line the dojo printed and its result', () => {
  const screen = new DojoScreen();
  screen.apply(recorded.redraw);
  assert.deepEqual([screen.line, screen.input, screen.lines.length], [PROMPT, '', 0]);
  screen.apply(recorded.add.bell); screen.apply(recorded.add.echo);
  assert.deepEqual([screen.line, screen.input, screen.bells, screen.column], [PROMPT + '(add 2 2)', '(add 2 2)', 1, PROMPT.length + 9]);
  for (const each of recorded.add.ran) screen.apply(each);
  assert.deepEqual(screen.lines, ['> (add 2 2)', '4']);
  assert.deepEqual([screen.line, screen.input, screen.unknown], [PROMPT, '', 0]);
  // a line the dojo refuses: a bell, the cursor at the fault, nothing printed, the line left standing
  const refused = new DojoScreen();
  refused.apply(recorded.redraw); refused.apply(recorded.hello.echo); refused.apply(recorded.hello.refused);
  assert.deepEqual([refused.lines.length, refused.bells, refused.line, refused.column - PROMPT.length], [0, 1, PROMPT + 'hello world', 6]);
  // an error is printed like any other line
  const failed = new DojoScreen();
  for (const each of recorded.need.ran) failed.apply(each);
  assert.deepEqual(failed.lines, ['> (need ~)', 'dojo: hoon expression failed']);
});

test('a screen update of an unknown kind is counted, not guessed at; text overwrites at the cursor', () => {
  const screen = new DojoScreen();
  for (const odd of [{zap: true}, 7, null, [1], {put: [1]}, {hop: -1}, {klr: [{text: 'x'}]}, {put: ['a'], nel: true}]) screen.apply(odd);
  assert.equal(screen.unknown, 8);
  assert.deepEqual([screen.line, screen.lines.length], ['', 0]);
  screen.apply({put: Array.from('abcdef')}); screen.apply({hop: 2}); screen.apply({put: ['X', 'Y']});
  assert.deepEqual([screen.line, screen.column, screen.input], ['abXYef', 4, undefined]);
  screen.apply({hop: {x: 8, y: 3}}); screen.apply({put: ['!']}); screen.apply({nel: true}); screen.apply({url: 'https://example.invalid/x'});
  assert.deepEqual(screen.lines, ['abXYef  !', 'https://example.invalid/x']);
  // a line drawn as text, not as prompt and input, does not tell what is typed on it
  screen.apply({mor: [{hop: 0}, {wyp: true}, {put: Array.from(PROMPT)}]});
  assert.equal(screen.input, undefined);
});

test('an event stream is cut into whole events; the unfinished tail waits', () => {
  const first = streamEvents('id: 3\ndata: {"a":1}\n\nid: 4\ndata: {"b"');
  assert.deepEqual(first.events, [{id: 3, data: '{"a":1}'}]);
  const second = streamEvents(first.rest + ':2}\n\n: comment\n\ndata: x\ndata: y\n\n');
  assert.deepEqual(second.events, [{id: 4, data: '{"b":2}'}, {data: 'x\ny'}]);
  assert.equal(second.rest, '');
  assert.deepEqual(streamEvents('id: nope\ndata: z\n\n').events, [{data: 'z'}]);
});

test('a line is typed once on an empty prompt, Return is pressed once, and the output comes back', async () => {
  const s = ship(), said: string[] = [];
  const out = await runDojoLine(s.open, '(add 2 2)', text => said.push(text), {timing: quick});
  assert.equal(out, '> (add 2 2)\n4');
  assert.equal(said.at(-1), '> (add 2 2)\n4');
  assert.deepEqual(s.sent.map(a => a.action).filter(a => a !== 'ack'), ['subscribe', 'poke', 'poke', 'unsubscribe', 'delete']);
  assert.deepEqual(s.belts(), [{txt: Array.from('(add 2 2)')}, {ret: null}]);
  assert.deepEqual([(s.sent[0] as JsonObject).app, (s.sent[0] as JsonObject).path, (s.sent[0] as JsonObject).ship], ['herm', '/session//view', 'sampel-palnet']);
  assert.ok(s.sent.filter(a => a.action === 'poke').every(a => a.app === 'herm' && a.mark === 'herm-task' && (a.json as JsonObject).session === ''));
  assert.equal((s.sent.find(a => a.action === 'unsubscribe') as JsonObject).subscription, (s.sent[0] as JsonObject).id);
  assert.equal(s.closed(), 1);
  const ids = s.sent.map(a => a.id as number);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b)); assert.equal(new Set(ids).size, ids.length);
  // log lines the ship prints between the echo and Return change nothing
  const noisy = ship({noise: 'afterEcho'});
  assert.equal(await runDojoLine(noisy.open, '(add 2 2)', () => undefined, {timing: quick}), '> (add 2 2)\n4');
  assert.equal(noisy.returns(), 1);
});

test('text already standing on the ship\'s dojo line is cleared first, so only what was typed runs', async () => {
  const s = ship({standing: '|exit'});
  assert.equal(await runDojoLine(s.open, '(add 2 2)', () => undefined, {timing: quick}), '> (add 2 2)\n4');
  assert.deepEqual(s.belts(), [{mod: {mod: 'ctl', key: 'e'}}, {mod: {mod: 'ctl', key: 'u'}}, {txt: Array.from('(add 2 2)')}, {ret: null}]);
  // standing text longer than the terminal is wide is cleared whole as well
  const long = ship({standing: 'x'.repeat(200)});
  assert.equal(await runDojoLine(long.open, '(add 2 2)', () => undefined, {timing: quick}), '> (add 2 2)\n4');
});

test('nothing is typed unless the ship\'s terminal is at the dojo\'s ready prompt', async () => {
  const waiting = ship({prompt: WAITING});
  await assert.rejects(runDojoLine(waiting.open, '+vats', () => undefined, {timing: quick}), notRun(/not at a ready dojo prompt \(it shows: ~sampel-palnet:dojo< \).*holds the start of an expression: it is waiting for the rest, or still running it\. Nothing was typed\.$/));
  const asking = ship({prompt: 'install? (y/n) '});
  await assert.rejects(runDojoLine(asking.open, '+vats', () => undefined, {timing: quick}), notRun(/not at a ready dojo prompt \(it shows: install\? \(y\/n\) \)\. Finish or cancel that.*Nothing was typed\.$/));
  for (const s of [waiting, asking]) {assert.deepEqual(s.belts(), [], 'no key at all'); assert.equal(s.deleted(), 1); assert.equal(s.closed(), 1);}
});

test('a line the dojo refuses is reported with the place it stopped, and taken off the prompt again', async () => {
  for (const noise of [undefined, 'afterBell'] as const) {
    const s = ship({onReturn: () => 'refuse', noise});
    const out = await runDojoLine(s.open, 'hello world', () => undefined, {timing: quick});
    assert.equal(out, 'The dojo did not take this line: it cannot read it from character 7 on. Nothing was run.\nhello world\n      ^', String(noise));
    assert.equal(s.returns(), 1);
    assert.deepEqual(s.belts().slice(-2), [{mod: {mod: 'ctl', key: 'e'}}, {mod: {mod: 'ctl', key: 'u'}}]);
    assert.deepEqual(s.left(), {input: '', prompt: PROMPT}, 'the ship\'s line is empty again');
  }
});

test('Return is not pressed when the ship does not show the line as typed', async () => {
  const s = ship({garble: true});
  await assert.rejects(runDojoLine(s.open, '(add 2 2)', () => undefined, {timing: quick}), notRun(/did not show the line as you typed it, so it was not run\.$/));
  assert.equal(s.returns(), 0);
  assert.deepEqual(s.left(), {input: '', prompt: PROMPT}, 'the mistyped text is cleared');
  assert.equal(s.closed(), 1);
  // a busy dojo puts the text back itself and says why: that is passed on at once, and no key is pressed that would abort its work
  // (debug prints that happen to arrive meanwhile are not this line's, and are not passed on as what the dojo said)
  const busy = ship({busy: true}), began = Date.now();
  let chatter: NodeJS.Timeout | undefined;
  const prints: DojoPrints = onPrint => {chatter = setInterval(() => onPrint('someone else\'s print'), 1); return {close: () => clearInterval(chatter)};};
  await assert.rejects(runDojoLine(busy.open, '+vats', () => undefined, {timing: {...quick, answerMs: 5000}, prints}), notRun(/was not run\. It said: dojo: busy \(press backspace to abort\)$/));
  assert.deepEqual([busy.returns(), busy.backs(), busy.clears()], [0, 0, 0]);
  assert.ok(Date.now() - began < 2000, 'not waited out');
});

test('nothing is typed when the ship does not open a terminal view, or the app is not signed in', async () => {
  const s = ship({mute: true});
  await assert.rejects(runDojoLine(s.open, '+vats', () => undefined, {timing: quick}), notRun(/Nothing was typed/));
  assert.deepEqual(s.belts(), []);
  await assert.rejects(runDojoLine(ship({throwOpen: true}).open, '+vats', () => undefined, {timing: quick}), notRun(/not signed in to your ship\. Nothing was typed\.$/));
  for (const bad of ['', 'a\nb', 'x'.repeat(501)]) await assert.rejects(runDojoLine(ship().open, bad, () => undefined, {timing: quick}), DojoNotRun);
  const refused = ship({failText: 'refused'});
  await assert.rejects(runDojoLine(refused.open, '+vats', () => undefined, {timing: quick}), notRun(/did not take the typed line\. Nothing was typed\.$/));
  assert.equal(refused.clears(), 0);
  // typing that got no answer may still reach the ship: the clearing keys are sent whatever the screen shows, and Return is not pressed
  for (const failText of ['unknown', 'lands'] as const) {
    const lost = ship({failText});
    await assert.rejects(runDojoLine(lost.open, '+vats', () => undefined, {timing: quick}), notRun(/no answer while the line was being typed\. Return was not pressed, so it did not run\.$/));
    assert.deepEqual([lost.returns(), lost.clears(), lost.left().input], [0, 2, ''], failText);
  }
  // and when the clearing got no answer either, the person is told the text may stand
  const stuck = ship({failText: 'lands', failClear: true});
  await assert.rejects(runDojoLine(stuck.open, '+vats', () => undefined, {timing: quick}), notRun(/so it did not run\. The text may still stand on its dojo line: clear it in the ship's own terminal before pressing Return there\.$/));
  assert.deepEqual([stuck.returns(), stuck.left().input], [0, '+vats']);
});

test('a Return that got no answer is unknown, said so, and never pressed again; one the ship did not take is not run', async () => {
  const s = ship({failReturn: 'unknown'});
  const out = await runDojoLine(s.open, '(add 2 2)', () => undefined, {timing: quick});
  assert.match(out, /not known whether the line ran\. It was not sent again/);
  assert.equal(s.clears(), 0, 'a line that may have run is not cleared');
  for (const options of [{failReturn: 'refused' as const}, {nackReturn: true}]) {
    const refused = ship(options);
    await assert.rejects(runDojoLine(refused.open, '(add 2 2)', () => undefined, {timing: quick}), notRun(/did not take the Return key, so the line was not run\.$/));
    assert.deepEqual(refused.left(), {input: '', prompt: PROMPT}, 'the typed line is taken off');
    assert.equal(refused.deleted(), 1);
  }
});

test('the terminal\'s view of a line that does not fit is the one recorded from the ship', () => {
  const chars = Array.from(recorded.long.line), screen = new DojoScreen();
  screen.apply(recorded.redraw); screen.apply(recorded.long.echo);
  assert.equal(chars.length, 113);
  const view = new DrumView(PROMPT, screen.column);
  assert.deepEqual([view.edge, view.wide, view.first, view.span], [79, false, 58, 58]);
  assert.deepEqual(view.show(chars, 113), {line: screen.line, column: screen.column});
  assert.equal(screen.line, PROMPT + recorded.long.line.slice(-58));
  // the cursor at the start shows the first window, and the window keeps its place until the cursor leaves it
  assert.deepEqual(view.show(chars, 0), {line: PROMPT + recorded.long.line.slice(0, 58), column: PROMPT.length});
  assert.deepEqual(view.show(chars, 58), {line: PROMPT + recorded.long.line.slice(0, 58), column: 79});
  assert.deepEqual(view.show(chars, 59), {line: PROMPT + recorded.long.line.slice(1, 59), column: 79});
  // a prompt of 35 % of the width or more scrolls away with the input
  const moon = new DrumView(MOON, 79);
  assert.deepEqual([moon.wide, moon.first, moon.span], [true, 79 - MOON.length, 79]);
  assert.deepEqual(moon.show(chars, 113), {line: (MOON + recorded.long.line).slice(-79), column: 79});
  assert.deepEqual(moon.show(chars, 0), {line: (MOON + recorded.long.line).slice(0, 79), column: MOON.length});
});

test('a line longer than the ship\'s terminal is wide is read whole, the cursor moved through it, before Return', async () => {
  const long = recorded.long.line, longer = Array.from({length: 60}, (_, n) => `(add ${n % 10} `).join('') + '1' + ')'.repeat(60);
  assert.equal(longer.length, 481);
  for (const [prompt, line] of [[PROMPT, long], [PROMPT, longer], [MOON, long], [MOON, longer], [MOON, '(add 2 2)']] as const) {
    const s = ship({prompt});
    assert.equal(await runDojoLine(s.open, line, () => undefined, {timing: quick}), `> ${line}\n4`, `${prompt}${line.length}`);
    const keys = s.belts().map(b => Object.hasOwn(b, 'mod') ? 'ctl-' + (b.mod as JsonObject).key : Object.keys(b)[0]);
    if (line.length < 20) {assert.deepEqual(keys, ['txt', 'ret']); continue;}
    assert.deepEqual([keys[0], keys[1], keys.at(-2), keys.at(-1)], ['txt', 'ctl-a', 'ctl-k', 'ret'], 'to the start, through it, cut what follows, then Return');
    assert.deepEqual([...new Set(keys.slice(2, -2))], ['aro'], 'only right arrows in between');
    assert.equal(s.arrows(), line.length, 'one arrow for each character');
    assert.deepEqual(s.ran(), [line]);
    assert.equal(s.returns(), 1);
  }
  // text that differs anywhere, or runs on past the end, is seen before Return: not run, and taken off
  const repeats = 'x'.repeat(58), distinct = Array.from({length: 58}, (_, n) => String.fromCharCode(48 + n)).join(''), twice = `'${'a'.repeat(56)}'`;   // a line whose windows repeat: (W W Z) typed, (W Y Z) on the ship
  type Options = NonNullable<Parameters<typeof ship>[0]>;
  const slow: DojoTiming = {...quick, answerMs: 3000};
  const cases: [string, Options, DojoTiming?][] = [
    ...[0, 30, 44, 50, 57, 58, 59, 78, 79, 100, 116, 240, 479, 480].map((at): [string, Options] => [longer, {garble: at}]),
    [longer, {garble: true}], [longer, {garble: 'more'}], [longer, {garble: typed => typed + ' '}],
    [repeats + repeats + 'z', {garble: typed => typed.slice(0, 58) + 'y'.repeat(58) + typed.slice(116)}],
    [twice + twice, {garble: typed => typed.slice(0, 58) + `'${'b'.repeat(56)}'`}],
    // the end of the line lost while it ends in one long run of a character: every view still matches, but an arrow rings where the line now ends
    ['q' + 'a'.repeat(70), {garble: typed => typed.slice(0, -1)}], ['q' + 'a'.repeat(70), {garble: typed => typed.slice(0, -3)}],
    // a bell from elsewhere during the walk cannot be told from that one: the line is not run
    [longer, {foreignBell: true}],
    // a middle window differs while the first and the last are right; over a slow link the app sees every screen the
    // cursor passes, and one of them equals the one it is headed for
    [repeats + repeats + distinct, {garble: typed => typed.slice(0, 58) + 'y'.repeat(58) + typed.slice(116)}],
    [repeats + repeats + distinct, {garble: typed => typed.slice(0, 58) + 'y'.repeat(58) + typed.slice(116), paced: 4}, slow],   // each screen stays longer than the app's look interval
  ];
  for (const [typed, options, timing] of cases) for (const prompt of options.paced ? [PROMPT] : [PROMPT, MOON]) {
    const wrong = ship({...options, prompt}), name = `${String(options.garble).slice(0, 40)} ${options.foreignBell ?? ''} ${prompt}`;
    await assert.rejects(runDojoLine(wrong.open, typed, () => undefined, {timing: timing ?? quick}), notRun(/did not show the (whole of this )?line as you typed it, so it was not run\.$/), name);
    assert.deepEqual([wrong.returns(), wrong.left().input], [0, ''], name);
  }
  // More of the same text after the end looks no different, and a bell from elsewhere could stand in for the end's
  // own: so what follows the cursor is cut before Return, and the line that runs is the one typed.
  for (const paced of [undefined, 8]) {
    const tailed = 'q' + 'a'.repeat(70), runOn = ship({garble: 'more', foreignBell: 'cut', paced});
    assert.equal(await runDojoLine(runOn.open, tailed, () => undefined, {timing: paced ? {...slow, answerMs: 6000} : quick}), `> ${tailed}\n4`, String(paced));
    assert.deepEqual(runOn.ran(), [tailed], 'not the longer line that stood on the ship');
  }
  // without such a bell the cut is noticed (no bell at the end), and the line is not run
  const cut = ship({garble: 'more'});
  await assert.rejects(runDojoLine(cut.open, 'q' + 'a'.repeat(70), () => undefined, {timing: quick}), notRun(/did not show the whole of this line as you typed it, so it was not run\.$/));
  assert.deepEqual([cut.ran(), cut.left().input], [[], '']);
  // the dojo printed back something else: the person is told to look
  const other = ship({onReturn: () => [{mor: [printed('> |exit'), {mor: [{hop: 0}, {wyp: true}, {klr: [{stye: plain, text: Array.from(PROMPT)}, {stye: plain, text: []}]}, {hop: PROMPT.length}]}]}]});
  assert.equal(await runDojoLine(other.open, long, () => undefined, {timing: quick}), '> |exit\n(The dojo did not print this line back as you typed it. Check above what it ran.)');
  // a long line the dojo cannot read: the place is not claimed, and the line is taken off
  const unread = ship({onReturn: () => 'refuse'});
  assert.equal(await runDojoLine(unread.open, long, () => undefined, {timing: quick}), 'The dojo did not take this line: it cannot read it. Nothing was run.');
  assert.deepEqual(unread.left(), {input: '', prompt: PROMPT});
});

test('the start of a longer expression is cancelled with one Backspace, and the dojo is left ready', async () => {
  const s = ship({onReturn: () => 'partial'});
  const out = await runDojoLine(s.open, '|=  a=@', () => undefined, {timing: quick});
  assert.equal(out, 'The dojo took this line as the start of a longer expression and waited for the rest. Readymade types one line at a time, so nothing was run, and the unfinished expression was cancelled.');
  assert.deepEqual([s.returns(), s.backs(), s.clears()], [1, 1, 0]);
  assert.deepEqual(s.left(), {input: '', prompt: PROMPT});
});

test('a ship that never goes quiet still has a refused line taken off and an unfinished expression cancelled', async () => {
  const refused = ship({onReturn: () => 'refuse', noise: 'constant'});
  assert.match(await runDojoLine(refused.open, 'hello world', () => undefined, {timing: {...quick, capMs: 150}}), /^The dojo did not take this line: it cannot read it from character 7 on\. Nothing was run\./);
  assert.deepEqual(refused.left(), {input: '', prompt: PROMPT});
  const partial = ship({onReturn: () => 'partial', noise: 'constant'});
  assert.match(await runDojoLine(partial.open, '|=  a=@', () => undefined, {timing: {...quick, capMs: 150}}), /nothing was run, and the unfinished expression was cancelled\.$/);
  assert.deepEqual([partial.backs(), partial.left().prompt], [1, PROMPT]);
});

test('listening stops at the limit while the ship keeps printing, when the stream ends, and long output keeps its end', async () => {
  const s = ship({onReturn: () => 'forever'});
  const out = await runDojoLine(s.open, '+vats', () => undefined, {timing: {...quick, capMs: 150}});
  assert.match(out, /^line 1\n/); assert.match(out, /\(Stopped listening after 0 seconds\. Your ship may still be working/);
  assert.match(out, /\(Your ship has not shown this line as taken, so it is not known whether it ran\. It was sent once\.\)/, 'this stand-in never prints the line back');
  const cut = ship({endAfterReturn: true});
  assert.match(await runDojoLine(cut.open, '(add 2 2)', () => undefined, {timing: {...quick, quietMs: 200}}), /\(The connection to your ship ended while listening\. The line was sent once\.\)$/);
  assert.deepEqual([cut.returns(), cut.deleted(), cut.closed()], [1, 1, 1], 'the channel is still deleted after its stream ended');
  const rows = Array.from({length: 400}, (_, n) => printed(`row ${n} ` + 'x'.repeat(40)));
  const long = ship({onReturn: line => [printed('> ' + line), ...rows, {mor: [{hop: 0}, {wyp: true}, {klr: [{stye: plain, text: Array.from(PROMPT)}, {stye: plain, text: []}]}, {hop: PROMPT.length}]}]});
  const tail = await runDojoLine(long.open, '+vats', () => undefined, {timing: quick});
  assert.ok(tail.length <= DOJO_OUTPUT_MAX); assert.match(tail, /^\(earlier output not shown\)\nrow \d+ /); assert.match(tail, /row 399 x+$/);
});

test('a line whose working out crashes in the dojo is said not to have run, at once, and is taken off the prompt', async () => {
  const s = ship({onReturn: () => 'crash'}), began = Date.now();
  const out = await runDojoLine(s.open, '.^(@ %gx /=nosuch=/x/noun)', () => undefined, {timing: {...quick, capMs: 5000}});
  assert.equal(out, 'dojo: failed to process input\n(The dojo could not work this line out, so nothing was run, and the line was taken off its prompt again.)');
  assert.ok(Date.now() - began < 2000, 'not waited out');
  assert.deepEqual([s.returns(), s.ran(), s.left()], [1, [], {input: '', prompt: PROMPT}]);
  // a line that ran and printed those same words is not mistaken for one: the dojo printed it back and its prompt is empty
  const echoed = ship({onReturn: line => [printed('> ' + line), printed('dojo: failed to process input'), {mor: [{hop: 0}, {wyp: true}, {klr: [{stye: plain, text: Array.from(PROMPT)}, {stye: plain, text: []}]}, {hop: PROMPT.length}]}]});
  assert.equal(await runDojoLine(echoed.open, "'dojo: failed to process input'", () => undefined, {timing: quick}), "> 'dojo: failed to process input'\ndojo: failed to process input");
  assert.equal(echoed.clears(), 0);
});

test('text the ship took and never showed is cleared by keys, and counted as cleared only when the ship says so', async () => {
  const quiet = ship({swallow: 'quiet'});
  await assert.rejects(runDojoLine(quiet.open, '|hi ~zod', () => undefined, {timing: quick}), notRun(/did not show the line as you typed it, so it was not run\.$/));
  assert.deepEqual([quiet.returns(), quiet.clears(), quiet.left()], [0, 2, {input: '', prompt: PROMPT}]);
  const stall = ship({swallow: 'stall'});
  await assert.rejects(runDojoLine(stall.open, '|hi ~zod', () => undefined, {timing: quick}), notRun(/so it was not run\. The text may still stand on its dojo line/));
  assert.deepEqual([stall.returns(), stall.clears()], [0, 2], 'the clearing keys were sent although the screen showed a bare prompt');
});

test('a cancelling Backspace that got no answer leaves the waiting prompt unknown, not asserted', async () => {
  const s = ship({onReturn: () => 'partial', failBack: true});
  const out = await runDojoLine(s.open, '(add 2', () => undefined, {timing: quick});
  assert.match(out, /so nothing was run\. Your ship's dojo may still be waiting for the rest: if it is, press Backspace/);
  assert.equal(s.backs(), 0, 'the one Backspace was not sent again');
});

test('a ship cannot make the screen model grow without bound or overflow the stack', () => {
  const screen = new DojoScreen();
  let deep: unknown = {bel: true};
  for (let n = 0; n < 5000; n++) deep = {mor: [deep]};
  screen.apply(deep); assert.deepEqual([screen.bells, screen.unknown], [0, 1], 'nesting past eight levels is not followed');
  screen.apply({mor: [{mor: [{mor: [{bel: true}]}]}]}); assert.equal(screen.bells, 1, 'the nesting a ship really sends is');
  for (let n = 0; n < 3000; n++) screen.apply({mor: [{hop: 100000}, {put: ['x']}, {nel: true}]});
  assert.ok(screen.lines.every(line => line.length <= 4096) && screen.lines.length <= 2000);
  screen.apply({mor: [{hop: 4000}, {put: Array.from('y'.repeat(500))}]});
  assert.equal(Array.from(screen.line).length, 4096); assert.equal(screen.column, 4096);
});

test('debug prints are shown beside the dojo\'s own lines, a repeated one counted; those from before Return are not this line\'s', async () => {
  let print: (text: string) => void = () => undefined, closed = 0;
  const prints: DojoPrints = onPrint => {print = onPrint; return {close: () => {closed++;}};};
  const s = ship({onReturn: line => {
    setTimeout(() => {print('gall: %sleeper dozing, dropping %blit'); print('%probe'); print('gall: noise'); print('gall: noise'); print('gall: %sleeper dozing, dropping %logs'); print('gall: %gone dead, got %blit'); print('gall: got old %logs for %again'); print('gall: noise'); print('two\nlines\n');}, 4);
    return [{mor: [printed('> ' + line), {mor: [{hop: 0}, {wyp: true}, {klr: [{stye: plain, text: Array.from(PROMPT)}, {stye: plain, text: []}]}, {hop: PROMPT.length}]}]}];
  }});
  const early = setInterval(() => {if (s.returns() === 0) print('before the line');}, 1);
  try {assert.equal(await runDojoLine(s.open, '~&(%probe 7)', () => undefined, {timing: quick, prints}), '> ~&(%probe 7)\n%probe\ngall: noise (×3)\ntwo\nlines');}
  finally {clearInterval(early);}
  assert.equal(closed, 1, 'the stream of prints is closed with the channel');
  // a ship that does not serve them: the line runs without
  const none = ship();
  assert.equal(await runDojoLine(none.open, '(add 2 2)', () => undefined, {timing: quick, prints: () => {throw new Error('no such stream');}}), '> (add 2 2)\n4');
});

test('what the ship prints after the first answer is still reported while followed, and the channel is left when that stops', async () => {
  const stop = new AbortController(), said: string[] = [];
  let later: (text: string) => void = () => undefined;
  const prints: DojoPrints = onPrint => {later = onPrint; return {close: () => undefined};};
  const s = ship();
  const first = await runDojoLine(s.open, '(add 2 2)', text => said.push(text), {timing: quick, prints, follow: {ms: 5000, signal: stop.signal}});
  assert.equal(first, '> (add 2 2)\n4');
  assert.deepEqual([s.deleted(), s.closed()], [0, 0], 'still listening');
  later('hi ~sampel-palnet successful');
  for (let i = 0; i < 200 && said.at(-1) !== '> (add 2 2)\n4\nhi ~sampel-palnet successful'; i++) await new Promise(done => setTimeout(done, 5));
  assert.equal(said.at(-1), '> (add 2 2)\n4\nhi ~sampel-palnet successful');
  const keys = s.belts().length;
  stop.abort();
  for (let i = 0; i < 200 && s.closed() === 0; i++) await new Promise(done => setTimeout(done, 5));
  assert.deepEqual([s.deleted(), s.closed(), s.belts().length], [1, 1, keys], 'left once, and no key was pressed while following');
  const count = said.length; later('after it stopped'); await new Promise(done => setTimeout(done, 40));
  assert.equal(said.length, count, 'nothing is reported after it stopped');
  // the time given runs out by itself
  const timed = ship();
  await runDojoLine(timed.open, '(add 2 2)', () => undefined, {timing: quick, follow: {ms: 60, signal: new AbortController().signal}});
  for (let i = 0; i < 200 && timed.closed() === 0; i++) await new Promise(done => setTimeout(done, 5));
  assert.deepEqual([timed.deleted(), timed.closed()], [1, 1]);
  // a line that did not run is not followed
  const refused = ship({onReturn: () => 'refuse'});
  await runDojoLine(refused.open, 'hello world', () => undefined, {timing: quick, follow: {ms: 5000, signal: new AbortController().signal}});
  assert.deepEqual([refused.deleted(), refused.closed()], [1, 1]);
});

test('debug prints do not count as the terminal being busy: a refused line is still dealt with at once', async () => {
  let chatter: NodeJS.Timeout | undefined;
  const prints: DojoPrints = onPrint => {chatter = setInterval(() => onPrint('print ' + Date.now()), 1); return {close: () => clearInterval(chatter)};};
  const s = ship({onReturn: () => 'refuse'}), began = Date.now();
  assert.match(await runDojoLine(s.open, 'hello world', () => undefined, {timing: {...quick, capMs: 5000}, prints}), /^The dojo did not take this line: it cannot read it from character 7 on/);
  assert.ok(Date.now() - began < 2000, 'not held until the limit');
  assert.deepEqual(s.left(), {input: '', prompt: PROMPT});
});

test('following: what the dojo waits at stays said, events are acknowledged, a ship that keeps printing is followed, and a stream that ends is said', async () => {
  const wait = async (done: () => boolean) => {for (let i = 0; i < 400 && !done(); i++) await new Promise(next => setTimeout(next, 5)); assert.ok(done(), 'waited two seconds');};
  // a generator that asks a question leaves another prompt: the notice is still there in later reports
  const question = {mor: [{hop: 0}, {wyp: true}, {klr: [{stye: plain, text: Array.from('install? (y/n) ')}, {stye: plain, text: []}]}, {hop: 15}]};
  const asking = ship({onReturn: line => [{mor: [printed('> ' + line), question]}]});
  const stop = new AbortController(), said: string[] = [];
  const first = await runDojoLine(asking.open, '+ask', text => said.push(text), {timing: quick, follow: {ms: 5000, signal: stop.signal}});
  assert.equal(first, '> +ask\n(The dojo now waits at: install? (y/n)  Answer it in your ship\'s own terminal.)');
  const answeredAt = said.length;
  asking.raw({mor: [printed('a later line'), question]}); await wait(() => said.length > answeredAt);
  assert.ok(said.slice(answeredAt).every(text => text.includes('a later line') && text.includes('(The dojo now waits at: install? (y/n) ')), JSON.stringify(said.slice(answeredAt)));
  stop.abort(); await wait(() => asking.closed() === 1);
  // sixty more lines while following: acknowledged as they come
  const busy = ship(), on = new AbortController(), told: string[] = [];
  await runDojoLine(busy.open, '(add 2 2)', text => told.push(text), {timing: quick, follow: {ms: 5000, signal: on.signal}});
  const before = busy.acks();
  for (let n = 0; n < 60; n++) busy.print('later ' + n);
  await wait(() => !!told.at(-1)?.endsWith('later 59'));
  assert.ok(busy.acks() > before, 'acknowledged while following');
  // the stream ends while following: said once, and the channel is left
  busy.end(); await wait(() => busy.closed() === 1);
  assert.match(told.at(-1)!, /later 59\n\(Your ship stopped sending terminal output here; what it prints from now on is in its own terminal\.\)$/);
  assert.equal(busy.deleted(), 1);
  // a ship still printing at the limit is answered without "stopped listening", and followed
  const forever = ship({onReturn: () => 'forever'}), going = new AbortController(), more: string[] = [];
  const out = await runDojoLine(forever.open, '+vats', text => more.push(text), {timing: {...quick, capMs: 120}, follow: {ms: 5000, signal: going.signal}});
  assert.match(out, /^line 1\n/); assert.doesNotMatch(out, /Stopped listening/);
  const lines = out.split('\n').length; await wait(() => (more.at(-1)?.split('\n').length ?? 0) > lines + 3);
  going.abort(); await wait(() => forever.closed() === 1);
  // a caller whose report throws does not leave the channel open
  const thrower = ship(), until = new AbortController(); let calls = 0;
  await runDojoLine(thrower.open, '(add 2 2)', () => {if (++calls > 1) throw new Error('gone');}, {timing: quick, follow: {ms: 5000, signal: until.signal}});
  thrower.print('later'); await wait(() => thrower.closed() === 1);
  assert.equal(thrower.deleted(), 1);
});

test('the screen keeps its last 2,000 lines, counts those let go, and still counts a repeated print across that', () => {
  const screen = new DojoScreen();
  for (let n = 0; n < 1999; n++) screen.apply(printed('line ' + n));
  screen.log('print'); screen.log('print');
  assert.deepEqual([screen.lines.length, screen.dropped, screen.lines.at(-1)], [2000, 0, 'print (×2)']);
  screen.log('other'); screen.log('other'); screen.log('other');
  assert.deepEqual([screen.lines.length, screen.dropped, screen.lines.at(-2), screen.lines.at(-1)], [2000, 1, 'print (×2)', 'other (×3)']);
  screen.apply(printed('between')); screen.log('other');
  assert.deepEqual([screen.dropped, screen.lines.slice(-3)], [3, ['other (×3)', 'between', 'other']]);
  assert.equal(screen.lines[0], 'line 3');
});

