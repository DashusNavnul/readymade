import {lstat, opendir, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import * as path from 'node:path';

export interface StorageReading {
  readonly id: string; readonly title: string; readonly roots: readonly string[];
  readonly status: 'complete' | 'partial' | 'unknown'; readonly files: number;
  readonly allocatedBytes: number | null; readonly logicalBytes: number;
  readonly note: string;
}
export interface StorageScope {readonly id: string; readonly title: string; readonly roots: readonly string[]; readonly note: string}
const journals = ['requests', 'file-pages', 'answer-decisions', 'check-documents', 'evaluations', 'code-reviews', 'candidate-documents',
  'review-policies', 'project-sharing', 'project-invitations', 'noltbook-documents', 'remote-drafts', 'remote-suggestions', 'drafts',
  'workspace-imports', 'shared-request-claims', 'workspace-returns', 'composer-drafts'];

/** Only known application paths. Never discover directories by searching the home folder. */
export function storageScopes(pier: string | undefined, storage: string | undefined, home = homedir()): StorageScope[] {
  return [
    {id: 'ship', title: 'Ship snapshots and event logs', roots: pier ? [path.join(pier, '.urb/chk'), path.join(pier, '.urb/log')] : [],
      note: 'Live ship data. Preserve it; exported desks and backups elsewhere are outside this count.'},
    {id: 'evidence', title: 'Installation evidence', roots: storage ? [path.join(storage, 'backend-install')] : [],
      note: 'Includes build checks, saved-state evidence and recovery records. Preserve it.'},
    {id: 'journals', title: 'Drafts and request journals', roots: storage ? journals.map(name => path.join(storage, name)) : [],
      note: 'This Readymade profile, across its ships. Includes unsent work and unresolved requests; preserve it.'},
    {id: 'builds', title: 'Rebuildable package cache', roots: ['codeoss-package', 'runtime', 'pills'].map(name => path.join(home, '.cache/readymade', name)),
      note: 'Downloaded editor, runtime and boot-pill cache. Check whether it is in use before any cleanup; installed apps are excluded.'},
  ];
}

/** Metadata only; no file is opened or read. Each scope gets a bounded, asynchronous walk. */
export async function measureStorage(scope: StorageScope, limits: {entries?: number; milliseconds?: number; depth?: number} = {}): Promise<StorageReading> {
  const limit = (value: number | undefined, fallback: number, min: number, max: number) => Number.isSafeInteger(value) ? Math.max(min, Math.min(value!, max)) : fallback;
  const maxEntries = limit(limits.entries, 2048, 1, 4096), milliseconds = limit(limits.milliseconds, 350, 1, 1500), deadline = performance.now() + milliseconds;
  const maxDepth = limit(limits.depth, 8, 0, 12);
  let files = 0, entries = 0, logicalBytes = 0, allocatedBytes = 0, knownAllocation = true, partial = false, observed = false;
  const reasons = new Set<string>(), inodes = new Set<string>();
  const incomplete = (reason: string) => {partial = true; reasons.add(reason);};
  const bounded = () => {
    if (entries >= maxEntries || performance.now() >= deadline) {incomplete('scan limit reached'); return false;}
    return true;
  };
  const walk = async (file: string, depth: number): Promise<void> => {
    if (!bounded()) return;
    entries++;
    try {
      const info = await lstat(file);
      if (performance.now() >= deadline) {incomplete('scan limit reached'); return;}
      if (info.isSymbolicLink()) {incomplete('linked paths skipped'); return;}
      // Reject symlinks in ancestors too, including a replaced directory during the walk.
      if (await realpath(file) !== file) {incomplete('linked paths skipped'); return;}
      if (performance.now() >= deadline) {incomplete('scan limit reached'); return;}
      observed = true;
      if (info.isFile()) {
        const identity = `${info.dev}:${info.ino}`;
        if (inodes.has(identity)) return; inodes.add(identity);
        if (!Number.isSafeInteger(info.size) || info.size < 0) {incomplete('file size unavailable'); return;}
        if (!Number.isSafeInteger(logicalBytes + info.size)) {incomplete('file size total exceeds precision'); return;}
        files++; logicalBytes += info.size;
        if (Number.isSafeInteger(info.blocks) && info.blocks >= 0) allocatedBytes += info.blocks * 512;
        else knownAllocation = false;
        if (!Number.isSafeInteger(allocatedBytes)) knownAllocation = false;
        return;
      }
      if (!info.isDirectory()) return;
      if (depth >= maxDepth) {incomplete('depth limit reached'); return;}
      const directory = await opendir(file, {bufferSize: 32});
      try {
        if (await realpath(file) !== file) {incomplete('directory changed'); return;}
        for await (const entry of directory) {
          if (!bounded()) break;
          await walk(path.join(file, entry.name), depth + 1);
        }
      } finally {
        // for-await closes on completion/break; also close if the pre-iteration check failed.
        await directory.close().catch(() => {});
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {if (depth === 0) observed = true; else incomplete('files changed during scan');}
      else incomplete('some paths could not be measured');
    }
  };
  const scan = async () => {
    for (const root of scope.roots) {
      if (!path.isAbsolute(root) || path.resolve(root) !== root) {incomplete('invalid path skipped'); continue;}
      await walk(root, 0);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([scan(), new Promise<void>(resolve => {timer = setTimeout(() => {incomplete('scan limit reached'); resolve();}, milliseconds);})]);
  clearTimeout(timer);
  const status = !scope.roots.length || !observed ? 'unknown' : partial ? 'partial' : 'complete';
  return {id: scope.id, title: scope.title, roots: [...scope.roots], status, files,
    allocatedBytes: knownAllocation ? allocatedBytes : null, logicalBytes,
    note: scope.note + (reasons.size ? ' ' + [...reasons].join('; ') + '.' : '')};
}

export async function storageInventory(pier?: string, storage?: string): Promise<StorageReading[]> {
  const rows: StorageReading[] = [];
  for (const scope of storageScopes(pier, storage)) rows.push(await measureStorage(scope));
  return rows;
}

export function storageSize(row: StorageReading): string {
  if (row.status === 'unknown') return 'Not measured';
  if (row.allocatedBytes === null) return 'Allocated size unavailable';
  const bytes = row.allocatedBytes, unit = bytes >= 1024 ** 3 ? 'GiB' : 'MiB', divisor = unit === 'GiB' ? 1024 ** 3 : 1024 ** 2;
  return `${row.status === 'partial' ? 'At least ' : ''}${(bytes / divisor).toFixed(1)} ${unit} allocated · ${row.files.toLocaleString()} files${row.status === 'partial' ? ' counted; partial scan' : ''}`;
}
