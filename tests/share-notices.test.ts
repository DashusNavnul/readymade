import test from 'node:test';
import assert from 'node:assert/strict';
import {shareNotices, shareNoticeText, shareNoticesUnseen, shareNoticeLines, SHARE_NOTICE_KINDS, SHARE_NOTICES_MAX} from '../src/share-notices';
import {catchUpDigest} from '../src/catch-up';

const peer = '~nec';
const notice = (patch: object = {}) => ({at: '~2026.11.12..02.00.00', owner: '~zod', project: 'shared', session: '0x5e55.2002', kind: 'stopped', ...patch});
const list = (notices: unknown[] = [notice()], patch: object = {}) => ({schema: 'readymade-share-notices-v1', peer, observedAt: '~2026.11.12..03.00.00', notices, ...patch});

test('share notices decode strictly: this ship’s own list, from other ships, bounded', () => {
  const seen = shareNotices(list(SHARE_NOTICE_KINDS.map((kind, i) => notice({kind, at: `~2026.11.12..02.00.0${i + 1}`, session: i > 1 ? '0x0' : '0x11'}))), peer);
  assert.deepEqual(seen.notices.map(n => n.kind), [...SHARE_NOTICE_KINDS]); assert.equal(seen.peer, peer);
  assert.ok(Object.isFrozen(seen) && Object.isFrozen(seen.notices) && Object.isFrozen(seen.notices[0]));
  assert.equal(shareNotices(list([]), peer).notices.length, 0);
  for (const bad of [list([notice()], {schema: 'readymade-share-notices-v2'}), list([notice()], {peer: '~bud'}), list([notice({owner: peer})]), list([notice({owner: 'zod'})]),
    list([notice({kind: 'granted'})]), list([notice({session: '0x05'})]), list([notice({session: 5})]), list([notice({project: 'bad:project'})]), list([notice({project: ''})]),
    list([notice({at: 'yesterday'})]), list([notice({extra: 1})]), list([notice()], {extra: 1}), list([notice()], {observedAt: 0}), list('none' as unknown as unknown[]),
    list(Array.from({length: SHARE_NOTICES_MAX + 1}, () => notice()))]) assert.throws(() => shareNotices(bad, peer));
  assert.throws(() => shareNotices(list(), 'nec'));
});

test('each notice is one plain sentence that names the owner and the project', () => {
  const text = (patch: object) => shareNoticeText(shareNotices(list([notice(patch)]), peer).notices[0]);
  assert.equal(text({}), '~zod stopped sharing session 0x5e55.2002 of shared with you.');
  assert.equal(text({kind: 'expired'}), 'The time limit ran out on session 0x5e55.2002 of shared, shared by ~zod. It is no longer shared with you.');
  assert.equal(text({kind: 'removed', session: '0x0'}), '~zod removed you from shared. Its shared files and sessions are closed to you.');
  assert.equal(text({kind: 'sharing-off', session: '0x0'}), '~zod turned off session sharing for shared. None of its sessions is shared with you now.');
  assert.equal(text({session: '0x0'}), '~zod stopped sharing a session of shared with you.');
});

test('only notices newer than the last one shown are new, and an unreadable mark shows everything', () => {
  const held = shareNotices(list([notice({at: '~2026.11.12..02.00.03'}), notice({at: '~2026.11.12..02.00.02', kind: 'expired'}), notice({at: '~2026.11.12..02.00.01'})]), peer);
  assert.equal(shareNoticesUnseen(held, undefined).length, 3); assert.equal(shareNoticesUnseen(held, 'nonsense').length, 3); assert.equal(shareNoticesUnseen(held, 7).length, 3);
  assert.deepEqual(shareNoticesUnseen(held, '~2026.11.12..02.00.01').map(n => n.at), ['~2026.11.12..02.00.03', '~2026.11.12..02.00.02']);
  assert.equal(shareNoticesUnseen(held, '~2026.11.12..02.00.03').length, 0); assert.equal(shareNoticesUnseen(held, '~2026.11.13').length, 0);
});

test('Catch Me Up lists the shares other owners ended, and omits the section when there are none', () => {
  const held = shareNotices(list([notice({kind: 'expired'})]), peer), lines = shareNoticeLines(held);
  assert.deepEqual(lines, [{day: '2026-11-12', text: 'The time limit ran out on session 0x5e55.2002 of shared, shared by ~zod. It is no longer shared with you.'}]);
  const base = {ship: peer, activity: [], activityPartial: false, conversation: [], candidates: [], sessions: []};
  const withNotices = catchUpDigest({...base, notices: lines});
  assert.match(withNotices, /Shares that other owners ended:\n- 2026-11-12: The time limit ran out on session 0x5e55\.2002 of shared/);
  assert.doesNotMatch(catchUpDigest({...base, notices: []}), /Shares that other owners ended/); assert.doesNotMatch(catchUpDigest(base), /Shares that other owners ended/);
});
