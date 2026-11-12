import * as fs from 'node:fs';
import { join } from 'node:path';
import { asRecord, isUx, validUnicode } from './protocol';
import { digest, originOf } from './source-store';
import { reviewGeneration, reviewPolicy, reviewPolicyCommand, reviewProvider, type ReviewPolicyChange } from './review-policy';
import type { ShipClient } from './ship-client';

type Client = Pick<ShipClient, 'origin' | 'codingState' | 'configureReviewPolicy'> & {assertIdle?(): void};
export interface ReviewPolicyIntent {
  version: 1; origin: string; owner: string; session: string; project: string; change: ReviewPolicyChange;
}
function validate(value: unknown): ReviewPolicyIntent {
  const r = asRecord(value), c = asRecord(r.change);
  if (r.version !== 1 || typeof r.origin !== 'string' || originOf(r.origin) !== r.origin ||
      typeof r.owner !== 'string' || !/^~[a-z-]{1,127}$/.test(r.owner) || !isUx(r.session) || r.session === '0x0' ||
      typeof r.project !== 'string' || !r.project || !validUnicode(r.project) || Buffer.byteLength(r.project) > 128)
    throw new Error('Invalid retained review policy intent.');
  return {version: 1, origin: r.origin, owner: r.owner, session: r.session, project: r.project,
    change: {previous: reviewGeneration(c.previous), ...(c.provider === undefined ? {} : {provider: reviewProvider(c.provider)})}};
}
/** One immutable intent per project generation, including across different sessions/windows. */
export class ReviewPolicyJournal {
  constructor(readonly directory: string) {}
  private privateInfo(info: fs.Stats, directory = false): void {
    if (!(directory ? info.isDirectory() : info.isFile()) || info.isSymbolicLink() ||
        process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new Error('Review policy journal must be private and owned.');
  }
  private key(i: ReviewPolicyIntent): string {return digest(JSON.stringify([i.origin, i.owner, i.project, i.change.previous]));}
  entries(): ReviewPolicyIntent[] {
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700}); this.privateInfo(fs.lstatSync(this.directory), true);
    const files = fs.readdirSync(this.directory).filter(f => f.endsWith('.intent.json'));
    if (files.length > 4096) throw new Error('Review policy journal capacity reached.');
    return files.map(file => {
      const fd = fs.openSync(join(this.directory, file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd); this.privateInfo(stat);
        if (stat.size > 32768) throw new Error('Review policy intent exceeds its limit.');
        const intent = validate(JSON.parse(fs.readFileSync(fd, 'utf8')));
        if (file !== this.key(intent) + '.intent.json') throw new Error('Review policy intent identity changed.');
        return intent;
      } finally {fs.closeSync(fd);}
    });
  }
  async configure(client: Client, supplied: ReviewPolicyIntent, consent: boolean) {
    const intent = validate(supplied);
    if (consent !== true) throw new Error('Explicit review policy confirmation is required.');
    if (client.origin !== intent.origin) throw new Error('Review policy origin changed.');
    const entries = this.entries();
    if (entries.length >= 4096 || entries.some(i => this.key(i) === this.key(intent))) throw new Error('Observe the retained policy change; it will not be submitted again.');
    const state = await client.codingState(intent.session);
    if (state.owner !== intent.owner) throw new Error('Review policy owner changed.');
    reviewPolicyCommand(state, intent.session, intent.project, intent.change, true);
    const data = JSON.stringify(intent);
    if (Buffer.byteLength(data) > 32768) throw new Error('Review policy intent exceeds its limit.');
    // A client that could not send now would leave a recorded intent that was never sent and is never sent again.
    client.assertIdle?.();
    const fd = fs.openSync(join(this.directory, this.key(intent) + '.intent.json'), 'wx', 0o600);
    try {fs.writeFileSync(fd, data); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    const directory = fs.openSync(this.directory, fs.constants.O_RDONLY);
    try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
    await client.configureReviewPolicy(intent, intent.change, true);
    return this.recover(client, intent);
  }
  async recover(client: Client, supplied: ReviewPolicyIntent) {
    const intent = validate(supplied), retained = this.entries().find(i => this.key(i) === this.key(intent));
    if (client.origin !== intent.origin || JSON.stringify(retained) !== JSON.stringify(intent)) throw new Error('Retained review policy context changed.');
    const state = await client.codingState(intent.session);
    if (state.owner !== intent.owner) throw new Error('Review policy owner changed.');
    return {intent, observed: reviewPolicy(state, intent.session, intent.project),
      notice: 'Current policy is not a delivery receipt. This observation never resubmits the retained change.'};
  }
}
