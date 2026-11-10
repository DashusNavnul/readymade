// Build-time only. Existing login credentials and global trust stay untouched.
const {execFileSync} = require('node:child_process');

function selectIdentity(catalog, requested = '', allowAdhoc = false) {
  if (requested && !/^[a-f0-9]{40}$/i.test(requested)) {
    throw new Error('READYMADE_SIGNING_IDENTITY must be an exact certificate SHA-1 fingerprint.');
  }
  const identities = [];
  for (const line of catalog.split('\n')) {
    const match = /^\s*\d+\)\s+([a-f0-9]{40})\s+"(Developer ID Application|Apple Development): ([^"\r\n]+) \(([A-Z0-9]{10})\)"\s*$/i.exec(line);
    if (match) identities.push({identity: match[1].toUpperCase(), kind: match[2], team: match[4]});
  }
  if (requested) {
    const selected = identities.find(item => item.identity === requested.toUpperCase());
    if (!selected) throw new Error('Requested Apple signing identity is missing or invalid; install its certificate and private key first.');
    return selected;
  }
  const distribution = identities.filter(item => item.kind === 'Developer ID Application');
  const candidates = distribution.length ? distribution : identities;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw new Error('Several Apple signing identities are available; set READYMADE_SIGNING_IDENTITY to one exact fingerprint.');
  if (allowAdhoc) return {identity: '-', kind: 'ad-hoc test build', team: null};
  throw new Error('No usable Apple signing identity is installed. Install a Developer ID Application certificate with its private key. Ad-hoc builds cause repeated Keychain approval; READYMADE_ALLOW_ADHOC=1 is only for isolated test builds.');
}

function currentIdentity(env = process.env) {
  if (!env.READYMADE_SIGNING_IDENTITY) {
    if (env.READYMADE_ALLOW_ADHOC === '1') return selectIdentity('', '', true);
    return require('./macos-local-signing.cjs').getLocalSigner();
  }
  const catalog = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
  });
  return selectIdentity(catalog, env.READYMADE_SIGNING_IDENTITY || '', env.READYMADE_ALLOW_ADHOC === '1');
}

function verifyIdentity(target, signer) {
  const args = ['--verify', '--strict'];
  if (signer.identity !== '-') {
    if (!/^[a-f0-9]{40}$/i.test(signer.identity)) throw new Error('Invalid signer fingerprint.');
    args.push('-R', `=certificate leaf = H"${signer.identity}"`);
  }
  execFileSync('/usr/bin/codesign', [...args, target], {stdio: 'pipe', timeout: 30000});
  const shown = require('node:child_process').spawnSync('/usr/bin/codesign', ['--display', '-r-', target], {encoding: 'utf8', timeout: 10000});
  if (shown.status !== 0) throw new Error('Could not read the signed app requirement.');
  const requirement = `${shown.stdout}\n${shown.stderr}`.split('\n').find(line => line.startsWith('designated =>')) || '';
  if (signer.identity !== '-' && (!requirement.includes('designated =>') || /\bcdhash\b/.test(requirement))) throw new Error('The signed app has no stable designated requirement.');
  return requirement;
}

module.exports = {selectIdentity, currentIdentity, verifyIdentity};
if (require.main === module) {
  try {
    const result = process.argv[2] === 'verify'
      ? verifyIdentity(process.argv[3], JSON.parse(process.argv[4])) : currentIdentity();
    process.stdout.write(JSON.stringify(result) + '\n');
  }
  catch (error) { process.stderr.write(`Signing refused: ${error.message}\n`); process.exitCode = 1; }
}
