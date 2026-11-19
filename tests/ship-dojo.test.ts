import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DOJO_OUTPUT_MAX, DojoNotRun, DojoScreen, dojoLine, dojoReady, dojoWaiting, runDojoLine, streamEvents, type DojoOpen, type DojoTiming} from '../src/ship-dojo';
import type {JsonObject} from '../src/protocol';

// Screen updates recorded from a live ship through %herm (see the fixture's own note).
const recorded = JSON.parse(readFileSync(join(__dirname, '../../tests/fixtures/dojo/blits.json'), 'utf8')) as {
  redraw: unknown; add: {line: string; bell: unknown; echo: unknown; ran: unknown[]}; hello: {line: string; echo: unknown; refused: unknown}; need: {line: string; ran: unknown[]}};
const PROMPT = '~sampel-palnet:dojo> ', WAITING = '~sampel-palnet:dojo< ';
const quick: DojoTiming = {answerMs: 300, quietMs: 40, capMs: 400, pollMs: 5};
const plain = {back: null, fore: null, deco: []};
const printed = (text: string) => ({mor: [{hop: 0}, {wyp: true}, {put: Array.from(text)}, {nel: true}]});
type Fail = 'unknown' | 'refused';
type TextFail = Fail | 'lands';
const fail = (how: Fail): Error => Object.assign(new Error(how), how === 'unknown' ? {code: 'outcomeUnknown'} : {code: 'refused'});

/**
 * A ship's dojo line as %herm serves it, drawn as the ship's terminal draws it (drum, short prompt): the prompt,
 * then as much of the input as fits its width, scrolled so that the cursor shows.
 */
function ship(options: {standing?: string; prompt?: string; mute?: boolean; garble?: boolean; busy?: boolean; width?: number; failText?: TextFail; failClear?: boolean; failReturn?: Fail; nackReturn?: boolean;
  noise?: 'afterEcho' | 'afterBell' | 'constant'; endAfterReturn?: boolean; throwOpen?: boolean;
  onReturn?: (line: string) => unknown[] | 'refuse' | 'forever' | 'partial'} = {}) {
  const sent: JsonObject[] = [], width = options.width ?? 80;
  let input = options.standing ?? '', cursor = input.length, off = 0, prompt = options.prompt ?? PROMPT, closed = 0, ended = false, timer: NodeJS.Timeout | undefined;
  const open: DojoOpen = (onEvent, onEnd) => {
    if (options.throwOpen) throw new Error('authenticationRequired');
    let eventId = 0;
    const emit = (event: JsonObject) => setTimeout(() => {if (!closed && !ended) onEvent(event, ++eventId);}, 1);
    const blit = (json: unknown) => emit({json, id: 1, mark: 'blit', response: 'diff'} as JsonObject);
    const draw = () => {
      const room = width - prompt.length;
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
        sent.push(action);
        if (action.action === 'subscribe') {if (options.mute) continue; emit({ok: 'ok', id: action.id, response: 'subscribe'}); blit(draw()); continue;}
        if (action.action !== 'poke') continue;
        if (Object.hasOwn(belt, 'ret') && options.nackReturn) {emit({err: 'crashed', id: action.id, response: 'poke'}); continue;}
        emit({ok: 'ok', id: action.id, response: 'poke'});
        if (Object.hasOwn(belt, 'mod')) {
          const key = (belt.mod as JsonObject).key;
          if (key === 'e') {cursor = input.length; blit(draw());}
          else if (key === 'u') {if (cursor === 0) blit({bel: true}); else {input = input.slice(cursor); cursor = 0; blit(draw());}}
          continue;
        }
        if (Object.hasOwn(belt, 'bac')) {if (!input && prompt === WAITING) {prompt = PROMPT; blit(draw());} else blit({bel: true}); continue;}
        if (Array.isArray(belt.txt)) {
          if (options.busy) {blit({mor: [draw(), {bel: true}, printed('dojo: busy (press backspace to abort)'), draw()]}); continue;}
          const typed = (belt.txt as string[]).join(''), put = options.garble ? typed.slice(0, -1) + '#' : typed;
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
          const ran = input; input = ''; cursor = 0; off = 0;
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
    deleted: () => sent.filter(a => a.action === 'delete').length};
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
  const out = await runDojoLine(s.open, '(add 2 2)', text => said.push(text), quick);
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
  assert.equal(await runDojoLine(noisy.open, '(add 2 2)', () => undefined, quick), '> (add 2 2)\n4');
  assert.equal(noisy.returns(), 1);
});

test('text already standing on the ship\'s dojo line is cleared first, so only what was typed runs', async () => {
  const s = ship({standing: '|exit'});
  assert.equal(await runDojoLine(s.open, '(add 2 2)', () => undefined, quick), '> (add 2 2)\n4');
  assert.deepEqual(s.belts(), [{mod: {mod: 'ctl', key: 'e'}}, {mod: {mod: 'ctl', key: 'u'}}, {txt: Array.from('(add 2 2)')}, {ret: null}]);
  // standing text longer than the terminal is wide is cleared whole as well
  const long = ship({standing: 'x'.repeat(200)});
  assert.equal(await runDojoLine(long.open, '(add 2 2)', () => undefined, quick), '> (add 2 2)\n4');
});

test('nothing is typed unless the ship\'s terminal is at the dojo\'s ready prompt', async () => {
  const waiting = ship({prompt: WAITING});
  await assert.rejects(runDojoLine(waiting.open, '+vats', () => undefined, quick), notRun(/not at a ready dojo prompt \(it shows: ~sampel-palnet:dojo< \).*holds the start of an expression: it is waiting for the rest, or still running it\. Nothing was typed\.$/));
  const asking = ship({prompt: 'install? (y/n) '});
  await assert.rejects(runDojoLine(asking.open, '+vats', () => undefined, quick), notRun(/not at a ready dojo prompt \(it shows: install\? \(y\/n\) \)\. Finish or cancel that.*Nothing was typed\.$/));
  for (const s of [waiting, asking]) {assert.deepEqual(s.belts(), [], 'no key at all'); assert.equal(s.deleted(), 1); assert.equal(s.closed(), 1);}
});

test('a line the dojo refuses is reported with the place it stopped, and taken off the prompt again', async () => {
  for (const noise of [undefined, 'afterBell'] as const) {
    const s = ship({onReturn: () => 'refuse', noise});
    const out = await runDojoLine(s.open, 'hello world', () => undefined, quick);
    assert.equal(out, 'The dojo did not take this line: it cannot read it from character 7 on. Nothing was run.\nhello world\n      ^', String(noise));
    assert.equal(s.returns(), 1);
    assert.deepEqual(s.belts().slice(-2), [{mod: {mod: 'ctl', key: 'e'}}, {mod: {mod: 'ctl', key: 'u'}}]);
    assert.deepEqual(s.left(), {input: '', prompt: PROMPT}, 'the ship\'s line is empty again');
  }
});

test('Return is not pressed when the ship does not show the line as typed', async () => {
  const s = ship({garble: true});
  await assert.rejects(runDojoLine(s.open, '(add 2 2)', () => undefined, quick), notRun(/did not show the line as you typed it, so it was not run\.$/));
  assert.equal(s.returns(), 0);
  assert.deepEqual(s.left(), {input: '', prompt: PROMPT}, 'the mistyped text is cleared');
  assert.equal(s.closed(), 1);
  // a busy dojo puts the text back itself and says why: that is passed on at once, and no key is pressed that would abort its work
  const busy = ship({busy: true}), began = Date.now();
  await assert.rejects(runDojoLine(busy.open, '+vats', () => undefined, {...quick, answerMs: 5000}), notRun(/was not run\. It said: dojo: busy \(press backspace to abort\)$/));
  assert.deepEqual([busy.returns(), busy.backs(), busy.clears()], [0, 0, 0]);
  assert.ok(Date.now() - began < 2000, 'not waited out');
});

test('nothing is typed when the ship does not open a terminal view, or the app is not signed in', async () => {
  const s = ship({mute: true});
  await assert.rejects(runDojoLine(s.open, '+vats', () => undefined, quick), notRun(/Nothing was typed/));
  assert.deepEqual(s.belts(), []);
  await assert.rejects(runDojoLine(ship({throwOpen: true}).open, '+vats', () => undefined, quick), notRun(/not signed in to your ship\. Nothing was typed\.$/));
  for (const bad of ['', 'a\nb', 'x'.repeat(501)]) await assert.rejects(runDojoLine(ship().open, bad, () => undefined, quick), DojoNotRun);
  const refused = ship({failText: 'refused'});
  await assert.rejects(runDojoLine(refused.open, '+vats', () => undefined, quick), notRun(/did not take the typed line\. Nothing was typed\.$/));
  assert.equal(refused.clears(), 0);
  // typing that got no answer may still reach the ship: the clearing keys are sent whatever the screen shows, and Return is not pressed
  for (const failText of ['unknown', 'lands'] as const) {
    const lost = ship({failText});
    await assert.rejects(runDojoLine(lost.open, '+vats', () => undefined, quick), notRun(/no answer while the line was being typed\. Return was not pressed, so it did not run\.$/));
    assert.deepEqual([lost.returns(), lost.clears(), lost.left().input], [0, 2, ''], failText);
  }
  // and when the clearing got no answer either, the person is told the text may stand
  const stuck = ship({failText: 'lands', failClear: true});
  await assert.rejects(runDojoLine(stuck.open, '+vats', () => undefined, quick), notRun(/so it did not run\. The text may still stand on its dojo line: clear it in the ship's own terminal before pressing Return there\.$/));
  assert.deepEqual([stuck.returns(), stuck.left().input], [0, '+vats']);
});

test('a Return that got no answer is unknown, said so, and never pressed again; one the ship did not take is not run', async () => {
  const s = ship({failReturn: 'unknown'});
  const out = await runDojoLine(s.open, '(add 2 2)', () => undefined, quick);
  assert.match(out, /not known whether the line ran\. It was not sent again/);
  assert.equal(s.clears(), 0, 'a line that may have run is not cleared');
  for (const options of [{failReturn: 'refused' as const}, {nackReturn: true}]) {
    const refused = ship(options);
    await assert.rejects(runDojoLine(refused.open, '(add 2 2)', () => undefined, quick), notRun(/did not take the Return key, so the line was not run\.$/));
    assert.deepEqual(refused.left(), {input: '', prompt: PROMPT}, 'the typed line is taken off');
    assert.equal(refused.deleted(), 1);
  }
});

test('a line longer than the ship\'s terminal is wide runs once its end is shown, and what the dojo printed back is compared', async () => {
  const long = '(add 1 '.repeat(14) + '1' + ')'.repeat(14);
  assert.equal(long.length, 113);
  const s = ship();
  assert.equal(await runDojoLine(s.open, long, () => undefined, quick), `> ${long}\n4`);
  assert.equal(s.returns(), 1);
  // the dojo printed back something else: the person is told to look
  const other = ship({onReturn: () => [{mor: [printed('> |exit'), {mor: [{hop: 0}, {wyp: true}, {klr: [{stye: plain, text: Array.from(PROMPT)}, {stye: plain, text: []}]}, {hop: PROMPT.length}]}]}]});
  assert.match(await runDojoLine(other.open, long, () => undefined, quick), /^> \|exit\n\(This line is longer than your ship's terminal is wide, so only its end could be checked before Return, and the dojo did not print it back as typed\. Check above what it ran\.\)$/);
  // the end the ship shows is not the end that was typed: not run, and taken off
  const wrong = ship({garble: true});
  await assert.rejects(runDojoLine(wrong.open, long, () => undefined, quick), notRun(/did not show the line as you typed it/));
  assert.deepEqual([wrong.returns(), wrong.left().input], [0, '']);
  // a long line the dojo cannot read: the place is not claimed, and the line is taken off
  const unread = ship({onReturn: () => 'refuse'});
  assert.equal(await runDojoLine(unread.open, long, () => undefined, quick), 'The dojo did not take this line: it cannot read it. Nothing was run.');
  assert.deepEqual(unread.left(), {input: '', prompt: PROMPT});
});

test('the start of a longer expression is cancelled with one Backspace, and the dojo is left ready', async () => {
  const s = ship({onReturn: () => 'partial'});
  const out = await runDojoLine(s.open, '|=  a=@', () => undefined, quick);
  assert.equal(out, 'The dojo took this line as the start of a longer expression and waited for the rest. Readymade types one line at a time, so nothing was run, and the unfinished expression was cancelled.');
  assert.deepEqual([s.returns(), s.backs(), s.clears()], [1, 1, 0]);
  assert.deepEqual(s.left(), {input: '', prompt: PROMPT});
});

test('a ship that never goes quiet still has a refused line taken off and an unfinished expression cancelled', async () => {
  const refused = ship({onReturn: () => 'refuse', noise: 'constant'});
  assert.match(await runDojoLine(refused.open, 'hello world', () => undefined, {...quick, capMs: 150}), /^The dojo did not take this line: it cannot read it from character 7 on\. Nothing was run\./);
  assert.deepEqual(refused.left(), {input: '', prompt: PROMPT});
  const partial = ship({onReturn: () => 'partial', noise: 'constant'});
  assert.match(await runDojoLine(partial.open, '|=  a=@', () => undefined, {...quick, capMs: 150}), /nothing was run, and the unfinished expression was cancelled\.$/);
  assert.deepEqual([partial.backs(), partial.left().prompt], [1, PROMPT]);
});

test('listening stops at the limit while the ship keeps printing, when the stream ends, and long output keeps its end', async () => {
  const s = ship({onReturn: () => 'forever'});
  const out = await runDojoLine(s.open, '+vats', () => undefined, {...quick, capMs: 150});
  assert.match(out, /^line 1\n/); assert.match(out, /\(Stopped listening after 0 seconds\. Your ship may still be working/);
  const cut = ship({endAfterReturn: true});
  assert.match(await runDojoLine(cut.open, '(add 2 2)', () => undefined, {...quick, quietMs: 200}), /\(The connection to your ship ended while listening\. The line was sent once\.\)$/);
  assert.deepEqual([cut.returns(), cut.deleted(), cut.closed()], [1, 1, 1], 'the channel is still deleted after its stream ended');
  const rows = Array.from({length: 400}, (_, n) => printed(`row ${n} ` + 'x'.repeat(40)));
  const long = ship({onReturn: () => [...rows, {mor: [{hop: 0}, {wyp: true}, {klr: [{stye: plain, text: Array.from(PROMPT)}, {stye: plain, text: []}]}, {hop: PROMPT.length}]}]});
  const tail = await runDojoLine(long.open, '+vats', () => undefined, quick);
  assert.ok(tail.length <= DOJO_OUTPUT_MAX); assert.match(tail, /^\(earlier output not shown\)\nrow \d+ /); assert.match(tail, /row 399 x+$/);
});
