import {asRecord, validUnicode} from './protocol';
import {dateAtom} from './editing-activity';
import {remoteShip} from './remote-project-view';

export type InvitationCommand = {request: string; authority: string; project: string} & (
  {operation: 'invite-member'; target: string; role: 'maintainer' | 'contributor' | 'observer' | 'model'; expiresAt: string; nonce: string} |
  {operation: 'join' | 'decline-invitation' | 'revoke-invitation' | 'expire-invitation'; invitation: string} |
  {operation: 'leave'});
export const invitationUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export const invitationHash = (v: unknown): v is string => typeof v === 'string' && /^0x[1-9a-f][0-9a-f]{0,3}(?:\.[0-9a-f]{4})*$/.test(v) && v.replaceAll('.', '').length <= 66;
export const invitationProject = (v: unknown): v is string => typeof v === 'string' && validUnicode(v) && Buffer.byteLength(v) > 0 && Buffer.byteLength(v) <= 128 && !/[\u0000-\u001f\u007f:]/u.test(v);
const date = (v: unknown): v is string => {try {return typeof v === 'string' && v.length <= 128 && dateAtom(v) > 0n;} catch {return false;}};
const role = (v: unknown): v is string => typeof v === 'string' && ['operator', 'maintainer', 'contributor', 'observer', 'model'].includes(v);
const exact = (r: object, fields: string[]) => Object.keys(r).length === fields.length && fields.every(f => Object.hasOwn(r, f));
function requireValue(ok: unknown): asserts ok {if (!ok) throw new Error('Invalid project invitation observation or command.');}
export function invitationCommand(value: unknown): InvitationCommand {
  const r = asRecord(value), base = ['request', 'authority', 'project', 'operation'];
  requireValue(invitationUuid(r.request) && remoteShip(r.authority) && invitationProject(r.project));
  if (r.operation === 'invite-member') {
    requireValue(exact(r, [...base, 'target', 'role', 'expiresAt', 'nonce']) && remoteShip(r.target) && role(r.role) && r.role !== 'operator' && date(r.expiresAt) && invitationHash(r.nonce));
  } else if (r.operation === 'leave') requireValue(exact(r, base));
  else requireValue(exact(r, [...base, 'invitation']) && ['join', 'decline-invitation', 'revoke-invitation', 'expire-invitation'].includes(String(r.operation)) && invitationHash(r.invitation));
  return Object.freeze({...r}) as InvitationCommand;
}
export interface InvitationResult {request: string; authority: string; project: string; operation: InvitationCommand['operation']; digest: string; status: 'prepared' | 'submitted' | 'unknown' | 'accepted' | 'refused'; permissionGranted: false; outcome: string | null}
export function invitationResult(value: unknown, command?: InvitationCommand): InvitationResult {
  const r = asRecord(value);
  requireValue(exact(r, ['schema', 'request', 'authority', 'project', 'operation', 'digest', 'status', 'permissionGranted', 'outcome']) && r.schema === 'readymade-project-invitation-result-v1' && invitationUuid(r.request) && remoteShip(r.authority) && invitationProject(r.project) && invitationHash(r.digest) && r.permissionGranted === false);
  const outcomes: Record<string, string> = {'invite-member': 'project-invited', join: 'project-joined', 'decline-invitation': 'invitation-declined', 'revoke-invitation': 'invitation-revoked', 'expire-invitation': 'invitation-expired', leave: 'project-left'};
  requireValue(typeof r.operation === 'string' && Object.hasOwn(outcomes, r.operation));
  requireValue(r.status === 'accepted' ? r.outcome === outcomes[r.operation] : r.status === 'refused' ? r.outcome === 'native-refused' : ['prepared', 'submitted', 'unknown'].includes(String(r.status)) && r.outcome === null);
  if (command) requireValue(['request', 'authority', 'project', 'operation'].every(k => r[k] === command[k as keyof InvitationCommand]));
  return Object.freeze({...r}) as unknown as InvitationResult;
}
export interface InvitationRow {id: string; target: string; role: string; issuedBy: string; expiresAt: string; expired: boolean}
export interface MemberRow {ship: string; role: string; joinedAt: string}
export interface InvitationPage {project: string; authority: string; kind: 'members' | 'invitations'; inviteUntil: string; catalog: string; offset: number; total: number; next: number | null; rows: (InvitationRow | MemberRow)[]}
function page(r: ReturnType<typeof asRecord>, rows: unknown[], offset: number, catalog?: string, limit = 4096): void {
  requireValue(invitationHash(r.catalog) && (!catalog || r.catalog === catalog) && Number.isSafeInteger(offset) && offset >= 0 && r.offset === offset && (offset === 0 || !!catalog) && Number.isSafeInteger(r.total) && Number(r.total) >= 0 && Number(r.total) <= limit && rows.length <= 64 && offset + rows.length <= Number(r.total));
  requireValue(rows.length === Math.min(64, Number(r.total) - offset) && r.next === (offset + rows.length === r.total ? null : offset + rows.length));
}
export function invitationMembers(value: unknown, project: string, authority: string, kind: 'members' | 'invitations', offset = 0, catalog?: string): InvitationPage {
  const r = asRecord(value);
  requireValue(exact(r, ['schema', 'project', 'authority', 'permissionGranted', 'inviteUntil', 'kind', 'catalog', 'offset', 'total', 'next', 'rows']) && r.schema === 'readymade-project-members-v1' && r.project === project && r.authority === authority && remoteShip(authority) && invitationProject(project) && r.kind === kind && r.permissionGranted === false && date(r.inviteUntil) && Array.isArray(r.rows));
  page(r, r.rows, offset, catalog);
  const ids = new Set<string>();
  for (const value of r.rows) {
    const row = asRecord(value);
    requireValue(role(row.role));
    if (kind === 'members') requireValue(exact(row, ['ship', 'role', 'joinedAt']) && remoteShip(row.ship) && date(row.joinedAt));
    else requireValue(exact(row, ['id', 'target', 'role', 'issuedBy', 'expiresAt', 'expired']) && invitationHash(row.id) && remoteShip(row.target) && remoteShip(row.issuedBy) && date(row.expiresAt) && typeof row.expired === 'boolean');
    const id = String(kind === 'members' ? row.ship : row.id); requireValue(!ids.has(id)); ids.add(id);
  }
  return r as unknown as InvitationPage;
}
export interface InvitationCatalog {owner: string; catalog: string; offset: number; total: number; next: number | null; requests: InvitationResult[]}
export function invitationCatalog(value: unknown, owner: string, offset = 0, catalog?: string): InvitationCatalog {
  const r = asRecord(value);
  requireValue(exact(r, ['schema', 'owner', 'permissionGranted', 'catalog', 'offset', 'total', 'next', 'requests']) && r.schema === 'readymade-project-invitation-catalog-v1' && r.owner === owner && remoteShip(owner) && r.permissionGranted === false && Array.isArray(r.requests));
  page(r, r.requests, offset, catalog, 512);
  const requests = r.requests.map(v => invitationResult(v)); requireValue(new Set(requests.map(v => v.request)).size === requests.length);
  return {...r, requests} as unknown as InvitationCatalog;
}
