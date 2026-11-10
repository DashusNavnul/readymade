const test = require('node:test'), assert = require('node:assert/strict');
const {selectIdentity} = require('../packaging/macos-signing.cjs');
const first = 'A'.repeat(40), second = 'B'.repeat(40);
const identity = (sha, kind = 'Developer ID Application') => `  1) ${sha} "${kind}: Readymade (ABCDE12345)"`;

test('Packaging refuses missing, ad-hoc and untrusted identities by default', () => {
  for (const catalog of ['0 valid identities found', '  1) - "Readymade"', `  1) ${first} "Readymade Local Build"`, identity(first) + ' (CSSMERR_TP_CERT_EXPIRED)']) {
    assert.throws(() => selectIdentity(catalog), /No usable Apple/);
  }
  assert.deepEqual(selectIdentity('', '', true), {identity: '-', kind: 'ad-hoc test build', team: null});
});
test('Packaging prefers a unique distribution identity and retains its team', () => {
  const selected = selectIdentity(identity(second, 'Apple Development') + '\n' + identity(first));
  assert.deepEqual(selected, {identity: first, kind: 'Developer ID Application', team: 'ABCDE12345'});
  assert.equal(selectIdentity(identity(second, 'Apple Development')).kind, 'Apple Development');
});
test('Explicit signer fingerprints disambiguate without accepting names or missing keys', () => {
  const catalog = identity(first) + '\n' + identity(second);
  assert.throws(() => selectIdentity(catalog), /Several/);
  assert.equal(selectIdentity(catalog, second.toLowerCase()).identity, second);
  assert.throws(() => selectIdentity(catalog, 'Developer ID Application: Readymade'), /exact certificate/);
  assert.throws(() => selectIdentity('', first, true), /missing or invalid/);
});
