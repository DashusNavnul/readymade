import { asRecord, validUnicode } from './protocol';
import type { ProjectSharingCommand } from './ship-client';

const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const ship = (v: unknown): v is string => typeof v === 'string' && v.length <= 128 && /^~(?:[a-z]{3}|[a-z]{6}(?:-[a-z]{6}){0,3}(?:--[a-z]{6}(?:-[a-z]{6}){3})?)$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(v) && v.replace(/\./g, '').length <= 66;
const desk = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9-]{1,63}$/.test(v);
const project = (v: unknown): v is string => typeof v === 'string' && validUnicode(v) && Buffer.byteLength(v) > 0 && Buffer.byteLength(v) <= 128 && !/[\u0000-\u001f\u007f:]/u.test(v);
const generation = (v: unknown): v is string => typeof v === 'string' && v.length <= 26 && /^[1-9][0-9]{0,2}(?:\.[0-9]{3})*$/.test(v) && BigInt(v.replace(/\./g, '')) <= 18446744073709551615n;
function paths(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 8 && new Set(value).size === value.length &&
    value.every(p => typeof p === 'string' && /^\/(?:app|lib|ted)\/(?:[a-z0-9-]{1,63}\/){1,6}hoon$/.test(p));
}
function exact(value: object, names: string[]): boolean {return Object.keys(value).length === names.length && names.every(n => Object.hasOwn(value, n));}
export function sharingCommand(value: unknown): ProjectSharingCommand {
  const r = asRecord(value), fields = ['request', 'owner', 'project', 'peer', 'expected', 'operation'];
  if (!uuid(r.request) || !ship(r.owner) || !project(r.project) || !ship(r.peer) || !hash(r.expected)) throw new Error('Invalid sharing request identity.');
  const base = {request: r.request, owner: r.owner, project: r.project, peer: r.peer, expected: r.expected};
  if (r.operation === 'revoke' && exact(r, [...fields, 'generation']) && generation(r.generation)) return {...base, operation: 'revoke', generation: r.generation};
  if (r.operation === 'grant' && exact(r, [...fields, 'desk', 'paths', 'permission']) && desk(r.desk) && typeof r.paths === 'string' && Buffer.byteLength(r.paths) <= 4096 && paths(r.paths.split('\n')) &&
      (r.permission === 'view' || r.permission === 'suggest' || r.permission === 'view-suggest')) return {...base, operation: 'grant', desk: r.desk, paths: r.paths, permission: r.permission};
  throw new Error('Invalid sharing selection.');
}
export interface SharingView {
  owner: string; project: string; peer: string; expected: string; member: boolean; baseDesk: string; workingDesk: string | null;
  grant: {generation: string; desk: string; paths: string[]; view: boolean; suggest: boolean; revoked: boolean} | null;
}
export function sharingView(value: unknown): SharingView {
  const r = asRecord(value);
  if (!exact(r, ['schema', 'owner', 'project', 'peer', 'expected', 'member', 'baseDesk', 'workingDesk', 'grant']) || r.schema !== 'readymade-project-sharing-view-v1' ||
      !ship(r.owner) || !project(r.project) || !ship(r.peer) || !hash(r.expected) || typeof r.member !== 'boolean' || !desk(r.baseDesk) || !(r.workingDesk === null || desk(r.workingDesk))) throw new Error('Invalid sharing observation.');
  let grant: SharingView['grant'] = null;
  if (r.grant !== null) {
    const g = asRecord(r.grant);
    if (!exact(g, ['generation', 'desk', 'paths', 'view', 'suggest', 'revoked']) || !generation(g.generation) || !desk(g.desk) || !paths(g.paths) ||
        typeof g.view !== 'boolean' || typeof g.suggest !== 'boolean' || typeof g.revoked !== 'boolean' || !(g.view || g.suggest)) throw new Error('Invalid retained sharing grant.');
    grant = {generation: g.generation, desk: g.desk, paths: [...g.paths], view: g.view, suggest: g.suggest, revoked: g.revoked};
  }
  return {owner: r.owner, project: r.project, peer: r.peer, expected: r.expected, member: r.member, baseDesk: r.baseDesk, workingDesk: r.workingDesk, grant};
}
export function sharingResult(value: unknown, command: ProjectSharingCommand) {
  const r = asRecord(value);
  if (!exact(r, ['schema', 'request', 'owner', 'project', 'peer', 'operation', 'intent', 'status']) || r.schema !== 'readymade-project-sharing-result-v1' ||
      r.request !== command.request || r.owner !== command.owner || r.project !== command.project || r.peer !== command.peer || r.operation !== command.operation || !hash(r.intent) ||
      !['unconfirmed', 'confirmed', 'revoked', 'superseded', 'unavailable'].includes(String(r.status))) throw new Error('Sharing result does not match the retained request.');
  return {request: command.request, digest: r.intent, status: String(r.status)};
}

/** Refusals the owner's ship issues before it records a grant: nobody could ever read the desk or a file through it. */
export const SHARING_UNREADABLE: Readonly<Record<string, string>> = Object.freeze({
  'sharing-desk-not-private': 'Other ships can already read that desk, so your ship does not share its files privately. Choose the project’s private work desk. Nothing was shared.',
  'sharing-desk-missing': 'That desk is not on your ship. Nothing was shared.',
  'sharing-file-missing': 'One of those files is not on that desk. Check each path (for example /lib/example/hoon). Nothing was shared.',
  'sharing-path-not-private': 'Other ships can already read one of those files, so your ship does not share it privately. Nothing was shared.'});
/** The plain sentence for one of those refusals, exactly as the ship words it; anything else is not one. */
export function sharingRefusal(status: number, body: unknown): string | undefined {
  if (status !== 409 || body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const r = body as Record<string, unknown>;
  return Object.keys(r).length === 2 && r.status === 'refused' && typeof r.message === 'string' && Object.hasOwn(SHARING_UNREADABLE, r.message) ? SHARING_UNREADABLE[r.message] : undefined;
}
