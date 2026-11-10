import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ShipClient } from './ship-client';
import type { DraftStore } from './draft-store';
import type { MediaTreeRow } from './media-workbench';
import { sameBasis, sourceBasis } from './source-store';
import { activityCommand, type ActivityCommand, type ActivityReply } from './editing-activity';

export interface ActivityFile {origin: string; actor: string; owner: string; project: string; ship: string; desk: string; path: string}
export type ActivityViewClient = Pick<ShipClient, 'origin' | 'snapshot' | 'activitySubmit' | 'activityResult'>;
interface Binding {client: ActivityViewClient; origin: string; actor: string; owner: string; project: string}
interface Options {
  now?: () => number; schedule?: (callback: () => void, ms: number) => vscode.Disposable;
  delay?: (ms: number) => Promise<void>; focused?: () => boolean; activeUri?: () => string | undefined; listen?: boolean;
}
type Ready = Extract<ActivityReply, {status: 'ready'}>;
interface Run {binding: Binding; guard: {owned: () => boolean; release: () => void}; epoch?: string; sequence?: string; published: boolean; unknown: boolean; sent: number; file: string}
class Refused extends Error {}
const nextSequence = (value?: string | null) => (BigInt(value?.replaceAll('.', '') || '0') + 1n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Exclusive local publisher guard, not a grant. Never reclaim another process's lock. */
function publisherLock(directory: string, binding: Binding): Run['guard'] {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const info = fs.lstatSync(directory), uid = process.getuid?.();
  if (!info.isDirectory() || info.isSymbolicLink() || uid !== undefined && (info.uid !== uid || (info.mode & 0o077))) throw new Error('Activity lock directory must be private and owned by you.');
  const key = createHash('sha256').update(JSON.stringify([binding.origin, binding.actor, binding.owner, binding.project])).digest('hex');
  const file = join(directory, key + '.lock'), nonce = randomUUID();
  let fd: number;
  try {fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);}
  catch {throw new Error(`Another window owns activity sharing. Stop sharing there first. If it crashed, close that publisher before manually removing ${file}`);}
  const identity = fs.fstatSync(fd);
  try {fs.writeFileSync(fd, JSON.stringify({nonce, pid: process.pid}));} finally {fs.closeSync(fd);}
  const owned = () => {
    try {
      const current = fs.lstatSync(file);
      if (!current.isFile() || current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev || current.size > 1024) return false;
      const read = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(read);
        return opened.ino === identity.ino && opened.dev === identity.dev && JSON.parse(fs.readFileSync(read, 'utf8')).nonce === nonce;
      } finally {fs.closeSync(read);}
    } catch {return false;}
  };
  return {owned, release: () => {if (owned()) {try {fs.unlinkSync(file);} catch { /* Already removed. */ }}}};
}

/** Presentation-only activity adapter. Consent is per window and never restored. */
export class EditingActivityView implements vscode.Disposable {
  private readonly now: () => number;
  private readonly schedule: NonNullable<Options['schedule']>;
  private readonly delay: NonNullable<Options['delay']>;
  private readonly focused: NonNullable<Options['focused']>;
  private readonly activeUri: NonNullable<Options['activeUri']>;
  private readonly listeners: vscode.Disposable[] = [];
  private timer?: vscode.Disposable;
  private expiryTimer?: vscode.Disposable;
  private run?: Run;
  private task?: Promise<void>;
  private stopping?: Promise<void>;
  private generation = 0;
  private disposed = false;
  private notice = 'Sharing is off. Open a project draft to share its filename.';
  private observed?: {binding: Binding; reply: Ready; expires: number};
  constructor(private readonly drafts: DraftStore, private readonly current: () => {client?: ActivityViewClient; project?: string},
    private readonly changed: () => void, private readonly lockDirectory: string, options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((callback, ms) => {const timer = setTimeout(callback, ms); return {dispose: () => clearTimeout(timer)};});
    this.delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.focused = options.focused ?? (() => vscode.window.state.focused);
    this.activeUri = options.activeUri ?? (() => vscode.window.activeTextEditor?.document.uri.toString());
    if (options.listen !== false) {
      const tick = () => {void this.tick().catch(() => undefined);};
      this.listeners.push(vscode.window.onDidChangeActiveTextEditor(tick), vscode.workspace.onDidChangeTextDocument(tick), vscode.window.onDidChangeWindowState(tick));
    }
  }
  private notify(): void {if (!this.disposed) this.changed();}
  private matches(b: Binding): boolean {
    const c = this.current();
    return !this.disposed && c.client === b.client && c.client.origin === b.origin && c.client.snapshot?.owner === b.actor && c.project === b.project;
  }
  private eligible(): {binding: Binding; desk: string; path: string} {
    const {client, project} = this.current(), uri = this.activeUri();
    if (this.disposed || vscode.workspace.isTrusted === false || !client?.snapshot?.ready || !project || !uri) throw new Error('Open a trusted Readymade project draft first.');
    const draft = this.drafts.get(uri), s = draft.snapshot, sessions = client.snapshot.sessions.filter(row => row.id === s.session);
    if (s.origin !== client.origin || s.ship !== client.snapshot.owner || sessions.length !== 1 || sessions[0].project !== project ||
        !sameBasis(s.source, sessions[0].source) || sourceBasis(sessions[0].source).id !== s.source.id) throw new Error('Draft does not match the current project source. Refresh and reopen its current draft.');
    const binding = {client, origin: client.origin, actor: s.ship, owner: s.source.owner, project};
    return {binding, desk: s.source.desk, path: s.path};
  }
  private async exchange(b: Binding, command: ActivityCommand): Promise<Ready> {
    let deadline: vscode.Disposable | undefined, canceled = false;
    const until = this.now() + 10_000;
    const check = () => {if (canceled || this.now() >= until) throw new Error('Activity outcome unknown after 10 seconds.');};
    const work = async () => {
      let reply = await b.client.activitySubmit(activityCommand(command));
      check();
      const selector = {owner: command.owner, project: command.project, request: reply.request};
      for (let count = 0; reply.status === 'pending' && count < 40; count++) {
        if (count) await this.delay(250);
        check();
        reply = await b.client.activityResult(selector, command);
        check();
      }
      if (reply.status === 'refused') throw new Refused(`Activity refused: ${reply.reason}`);
      if (reply.status !== 'ready') throw new Error('Activity outcome unknown. Sharing is off; no write will be retried.');
      return reply;
    };
    try {return await Promise.race([work(), new Promise<never>((_, reject) => {deadline = this.schedule(() => {canceled = true; reject(new Error('Activity outcome unknown after 10 seconds.'));}, 10_000);})]);}
    finally {canceled = true; deadline?.dispose();}
  }
  private show(b: Binding, reply: Ready): void {
    this.observed = {binding: b, reply, expires: this.now() + 30_000};
    this.expiryTimer?.dispose();
    this.expiryTimer = this.schedule(() => this.notify(), 30_000);
  }
  private arm(): void {
    this.timer?.dispose();
    if (this.run && !this.disposed) this.timer = this.schedule(() => {void this.tick().catch(() => undefined);}, Math.max(1, 9000 - (this.now() - this.run.sent)));
  }
  private async publish(run: Run): Promise<void> {
    const file = this.eligible();
    if (this.run !== run || !this.matches(run.binding) || !this.focused() || file.binding.owner !== run.binding.owner) throw new Error('Activity context changed. Share explicitly in the new project.');
    if (!run.guard.owned()) throw new Error('Activity publisher lock was lost. Sharing is off.');
    const command = activityCommand({owner: run.binding.owner, project: run.binding.project, operation: 'update', epoch: run.epoch,
      sequence: nextSequence(run.sequence), desk: file.desk, path: file.path});
    run.published = true; run.unknown = true; run.sent = this.now();
    try {
      const reply = await this.exchange(run.binding, command);
      run.unknown = false; run.sequence = reply.selfSequence ?? undefined; run.file = JSON.stringify([file.desk, file.path]);
      if (this.run === run && this.matches(run.binding)) {this.show(run.binding, reply); this.notice = 'Sharing the active project filename. No file contents are sent.';}
    } catch (error) {if (error instanceof Refused) run.unknown = false; throw error;}
  }
  async share(): Promise<void> {
    if (this.run || this.task || this.stopping) throw new Error('Activity is already running or settling.');
    const file = this.eligible();
    if (!this.focused()) throw new Error('Focus this window before sharing activity.');
    const run: Run = {binding: file.binding, guard: publisherLock(this.lockDirectory, file.binding), published: false, unknown: false, sent: this.now(), file: ''};
    this.run = run; const generation = this.generation;
    const work = async () => {
      const reply = await this.exchange(run.binding, {owner: run.binding.owner, project: run.binding.project, operation: 'query'});
      run.epoch = reply.epoch; run.sequence = reply.selfSequence ?? undefined;
      if (this.generation !== generation || this.run !== run) throw new Error('Activity context changed before sharing.');
      await this.publish(run);
    };
    this.task = work();
    try {await this.task; this.arm();}
    catch (error) {
      if (this.run === run) {this.run = undefined; if (!run.unknown) run.guard.release(); this.notice = String(error instanceof Error ? error.message : error) + (run.unknown ? ' Publisher lock retained; native activity expires within 30 seconds.' : '');}
      throw error;
    } finally {this.task = undefined; this.notify();}
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const run = this.run, pending = this.task;
    this.run = undefined; this.generation++; this.timer?.dispose(); this.timer = undefined;
    if (!run) return;
    this.stopping = (async () => {
      await pending?.catch(() => undefined);
      try {
        if (run.unknown) throw new Error('Activity outcome unknown; publisher lock retained. Native activity expires within 30 seconds.');
        if (run.published && run.epoch) {
          if (!run.guard.owned()) throw new Error('Activity publisher lock was lost; no further write sent.');
          run.unknown = true;
          try {await this.exchange(run.binding, {owner: run.binding.owner, project: run.binding.project, operation: 'stop', epoch: run.epoch, sequence: nextSequence(run.sequence)}); run.unknown = false;}
          catch (error) {if (error instanceof Refused) run.unknown = false; throw error;}
        }
        this.notice = 'Sharing is off.';
      } catch (error) {this.notice = String(error instanceof Error ? error.message : error);}
      finally {if (!run.unknown) run.guard.release(); this.notify();}
    })();
    try {await this.stopping;} finally {this.stopping = undefined;}
  }
  async contextChanged(): Promise<void> {this.observed = undefined; this.expiryTimer?.dispose(); await this.stop(); this.notify();}
  async refresh(): Promise<void> {
    if (this.task || this.stopping) throw new Error('Wait for the current activity request.');
    let binding: Binding;
    try {binding = this.eligible().binding;} catch (error) {if (!this.observed || !this.matches(this.observed.binding)) throw error; binding = this.observed.binding;}
    const generation = this.generation, run = this.run;
    this.task = (async () => {
      const reply = await this.exchange(binding, {owner: binding.owner, project: binding.project, operation: 'query'});
      if (generation !== this.generation || !this.matches(binding)) return;
      if (run && (run.epoch !== reply.epoch || (run.sequence ?? null) !== reply.selfSequence)) throw new Error('Activity sequence changed in another publisher. Sharing is off.');
      this.show(binding, reply);
    })();
    let failure: unknown;
    try {await this.task;} catch (error) {failure = error; this.notice = String(error instanceof Error ? error.message : error);}
    finally {this.task = undefined;}
    if (failure) {await this.stop(); this.notify(); throw failure;}
    this.arm(); this.notify();
  }
  async tick(): Promise<void> {
    const run = this.run;
    if (!run) return;
    let file: ReturnType<EditingActivityView['eligible']>;
    try {file = this.eligible();} catch {await this.stop(); return;}
    if (!this.focused() || !this.matches(run.binding) || file.binding.owner !== run.binding.owner) {await this.stop(); return;}
    if (this.task || this.stopping) return;
    if (this.now() - run.sent < 9000 && JSON.stringify([file.desk, file.path]) === run.file) {this.arm(); return;}
    this.task = this.publish(run);
    let failure: unknown;
    try {await this.task;} catch (error) {failure = error; this.notice = String(error instanceof Error ? error.message : error);}
    finally {this.task = undefined;}
    if (failure) {await this.stop();} else this.arm();
    this.notify();
  }
  async openFile(ship: string, open: (file: ActivityFile, active: () => boolean) => Promise<void>): Promise<void> {
    if (this.task || this.stopping) throw new Error('Wait for the current activity request.');
    const observed = this.observed, generation = this.generation;
    if (!observed || !this.matches(observed.binding) || this.now() >= observed.expires) throw new Error('Refresh project activity before opening a collaborator’s file.');
    const prior = observed.reply.rows.find(row => row.ship === ship);
    if (!prior) throw new Error('That collaborator is not in the current activity observation.');
    const active = () => generation === this.generation && this.matches(observed.binding);
    let reply: Ready;
    this.task = (async () => {reply = await this.exchange(observed.binding, {owner: observed.binding.owner, project: observed.binding.project, operation: 'query'});})();
    try {await this.task;} finally {this.task = undefined; this.arm();}
    if (!active()) throw new Error('Project changed while checking activity.');
    const current = reply!.rows.find(row => row.ship === ship);
    this.show(observed.binding, reply!); this.notify();
    if (!current || current.desk !== prior.desk || current.path !== prior.path) throw new Error('The collaborator moved or stopped sharing. Choose their current activity again.');
    await open({origin: observed.binding.origin, actor: observed.binding.actor, owner: observed.binding.owner, project: observed.binding.project, ship, desk: current.desk, path: current.path}, active);
  }
  rows(): MediaTreeRow[] {
    const children: MediaTreeRow[] = [{label: this.notice},
      {label: 'Share activity', command: {command: 'readymade.shareActivity', title: 'Share activity'}},
      {label: 'Stop sharing', command: {command: 'readymade.stopActivity', title: 'Stop sharing'}},
      {label: 'Refresh activity', command: {command: 'readymade.refreshActivity', title: 'Refresh activity'}}];
    if (this.observed && this.matches(this.observed.binding) && this.now() < this.observed.expires) {
      for (const row of this.observed.reply.rows) children.push({label: row.ship, description: `%${row.desk}${row.path}`, tooltip: 'Open this file after checking current activity and your source permissions.', command: {command: 'readymade.openActivityFile', title: 'Open collaborator file', arguments: [row.ship]}});
    }
    return [{id: 'project-activity', label: 'Project Activity', description: this.run ? 'Sharing' : 'Off', icon: 'pulse', children}];
  }
  dispose(): void {void this.stop(); this.disposed = true; this.listeners.forEach(listener => listener.dispose()); this.timer?.dispose(); this.expiryTimer?.dispose();}
}
