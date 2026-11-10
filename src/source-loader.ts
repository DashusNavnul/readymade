import {PageCancelledError, PagePendingError, PageSizeError, SourcePager} from './source-pager';
import {sameBasis, sourceBasis, type SourceBasis, type SourceDescriptor, type SourceProgress, SourceStore} from './source-store';

export interface FileLoadOptions {
  active(): boolean;
  progress(value: SourceProgress | undefined): void;
}

/** One user-requested file load; every page still passes the durable native pager. */
export class SourceLoader {
  private busy = false;
  constructor(private readonly store: SourceStore, private readonly pager: SourcePager,
    private readonly wait = () => new Promise<void>(resolve => setTimeout(resolve, 1000))) {}

  async load(session: string, source: SourceBasis, path: string, project: string | undefined,
    options: FileLoadOptions): Promise<SourceDescriptor | undefined> {
    if (this.busy) throw new Error('A file is already loading. Cancel it before opening another ship file.');
    this.busy = true;
    try {
      const basis = sourceBasis(source), deadline = Date.now() + 600_000;
      let previous = -1, unchanged = 0;
      for (let step = 0; step < 1024 && Date.now() < deadline; step++) {
        if (!options.active()) return;
        await this.store.refresh(session);
        if (!options.active()) return;
        const matches = (row: {session: string; path: string; source: SourceBasis}) => row.session === session && row.path === path && sameBasis(row.source, basis);
        const progress = this.store.progress().find(matches);
        options.progress(progress);
        const complete = this.store.sources().find(matches);
        if (complete) return complete;
        const next = progress?.next ?? 1;
        unchanged = next === previous ? unchanged + 1 : 0; previous = next;
        if (unchanged >= 20) throw new PagePendingError('The file read is still pending. Open it again to observe the result; unknown requests will not be resent.');
        try {
          if (!progress || next === 1) await this.pager.start(session, basis, path, project, 200, options.active);
          else await this.pager.next(progress.key, project, options.active);
        } catch (error) {
          if (error instanceof PageCancelledError) return;
          if (error instanceof PageSizeError) continue;
          // Calling the pager again only observes a held intent. It cannot
          // submit it again without an exact retained size refusal.
          if (!(error instanceof PagePendingError)) throw error;
        }
        const now = this.store.progress().find(matches);
        if ((!now || now.next === next) && options.active()) await this.wait();
      }
      throw new Error('File loading reached its bounded limit. Open the file again to continue from retained pages.');
    } finally {this.busy = false;}
  }
}
