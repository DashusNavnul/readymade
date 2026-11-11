import assert from 'node:assert/strict';
import test from 'node:test';
import {installChoice, loomOf, shipRank} from '../src/install-choice';

test('a ship name states its rank; anything else has none', () => {
  assert.equal(shipRank('~zod'), 'galaxy'); assert.equal(shipRank('~marzod'), 'star'); assert.equal(shipRank('~sampel-palnet'), 'planet');
  assert.equal(shipRank('~doznec-salfun-sampel-palnet'), 'moon');
  assert.equal(shipRank('~sampel-palnet-sampel-palnet--sampel-palnet-sampel-palnet'), 'comet');
  for (const bad of ['zod', '~Zod', '~sampel-palnet ', '~sampe', '~a-b', '~sampel-palnet-sampel', '']) assert.equal(shipRank(bad), undefined, bad);
});
test('the loom exponent is read from the running command line, and only from there', () => {
  assert.equal(loomOf('/x/vere work --snap-dir /p --loom 33 --toss 0'), 33); assert.equal(loomOf('/x/vere --loom 31'), 31);
  assert.equal(loomOf('/x/vere work --snap-dir /p'), undefined); assert.equal(loomOf('/x/vere --loomy 33'), undefined); assert.equal(loomOf('/x/vere --loom=33'), undefined);
});
test('full install is offered only to a planet or larger with enough memory; everything else gets the collaboration service', () => {
  assert.deepEqual([installChoice('~sampel-palnet', 33).recommended, installChoice('~sampel-palnet', 33).fullPossible], ['full', true]);
  assert.equal(installChoice('~marzod', 34).recommended, 'full'); assert.equal(installChoice('~zod', 33).recommended, 'full');
  const small = installChoice('~sampel-palnet', 31); assert.deepEqual([small.recommended, small.fullPossible], ['guest', false]); assert.match(small.reason, /--loom 31.*--loom 33/);
  const unknown = installChoice('~sampel-palnet', undefined); assert.deepEqual([unknown.recommended, unknown.fullPossible], ['guest', false]); assert.match(unknown.reason, /no --loom given/);
  const moon = installChoice('~doznec-salfun-sampel-palnet', 33); assert.deepEqual([moon.recommended, moon.fullPossible], ['guest', true]); assert.match(moon.reason, /is a moon/);
  assert.deepEqual([installChoice('~doznec-salfun-sampel-palnet', 31).fullPossible], [false]);
  assert.equal(installChoice('~sampel-palnet-sampel-palnet--sampel-palnet-sampel-palnet', 33).recommended, 'guest');
  assert.throws(() => installChoice('zod', 33), /Invalid/);
});
