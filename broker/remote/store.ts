import { randomUUID } from 'node:crypto';
import type { Store } from '../store.ts';
import { digest } from './crypto.ts';
import { remoteError } from '../execution.ts';
import { deviceRole, lapsed, type DeviceRole, type WorkingProfile } from '../authority.ts';

export type Project = {id:string;name:string;path:string;revision?:string};
export type Device = {/** A paired web browser (browser.ts): its keys work only there. Absent for a phone. */surface?:'browser';id:string;name:string;connectionKey:string;actionKey:string;keyVersion:number;scopeVersion:string;
  actionAuthentication?:'biometric'|'trusted-device';replacesDeviceId?:string;replacementPending?:boolean;
  /**
   * What this phone may control (authority.ts): observer, limited (every phone paired before roles) or owner.
   * Authentication (keys, signing mode) is separate and unchanged by a role change.
   */
  role?:DeviceRole;
  /** 'until-revoked': no expiry (owner phones by default); otherwise `expiresAt` applies. */
  lifetime?:'until-revoked';
  /** An owner phone's working profile and its revision (changes never disconnect the phone). */
  profile?:WorkingProfile;profileRevision?:string;
  /**
   * Transient, never stored: the role this connection negotiated. An owner phone acts as an owner only after
   * its client declared `owner.policy.v1`; an older client keeps the limited behaviour it understands.
   */
  connectionRole?:DeviceRole;
  createdAt:number;expiresAt?:number;revokedAt?:number;lastSeen?:number;projects:Project[];caps:string[];categories:string[];scriptIds:string[];ollamaHosts:string[];
  /** Hosted API providers this phone may run (with the providers.api grant); the compatible endpoint is bound to the origin granted. */
  apiProviders?:string[];apiConnections?:string[];apiRouteGrants?:Record<string,string>;compatibleEndpoint?:string;
  /** The phone that promoted or approved this one, when an owner phone enrolled it. */
  enrolledBy?:string;
  /** How this phone asked to be woken, and whether the owner allowed it (wake.ts). */
  wake?:import('./wake.ts').WakeRegistration};
export type RemoteConfig = {enabled:boolean;addresses:string[];port:number;name:string;
  /** Announce the gateway on the local network, so a paired phone can find its address. Off unless chosen. */
  discovery?:boolean;
  /** A08: the browser companion's own listener (browser.ts). Off unless chosen; no addresses means this computer only. */
  browser?:{enabled:boolean;addresses:string[];port:number;proxy?:string}};
export class RemoteStore {
  store: Store; epoch=randomUUID();
  constructor(store: Store) {
    this.store=store;
    const version = store.get('remoteSchema',0);
    // Version 2 adds device roles. An older binary refuses it instead of reading an owner record as a scoped one.
    if (version>2) throw new Error('Unsupported remote database version');
    store.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS remote_devices(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_pair_offers(id TEXT PRIMARY KEY,data TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_commands(device TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,method TEXT NOT NULL,data TEXT NOT NULL,time INTEGER NOT NULL,PRIMARY KEY(device,id));
      CREATE TABLE IF NOT EXISTS remote_journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,device TEXT NOT NULL,time INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS remote_journal_device ON remote_journal(device,seq);
      CREATE TABLE IF NOT EXISTS remote_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,time INTEGER NOT NULL,data TEXT NOT NULL);
      COMMIT;`);
    if (version<2) this.migrateRoles();
    store.set('remoteSchema',2);
    if (!store.get('remoteLineage','')) store.set('remoteLineage',randomUUID());
    if (!store.get('remoteCursorKey','')) store.set('remoteCursorKey',randomUUID()+randomUUID());
    for (const row of store.db.prepare('SELECT device,id,data FROM remote_commands').all()) {
      const value=JSON.parse(String(row.data));
      if (['accepted','running'].includes(value.status)) this.finish(String(row.device),String(row.id),{status:'unknown',error:{code:'OUTCOME_UNKNOWN',message:'The broker restarted; this operation will not be replayed.'}});
    }
    this.prune();
  }
  /**
   * Schema 1 → 2: every existing phone becomes an explicit limited device with identical scopes, expiry and
   * signing mode. Trusted-device signing stays a signing choice; it never implies owner authority.
   */
  private migrateRoles() {
    const db=this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of db.prepare('SELECT id,data FROM remote_devices').all()) {
        const device=JSON.parse(String(row.data));
        if (device.role===undefined) {device.role='limited';db.prepare('UPDATE remote_devices SET data=? WHERE id=?').run(JSON.stringify(device),String(row.id));}
      }
      db.prepare('INSERT INTO remote_audit(time,data) VALUES (?,?)').run(Date.now(),JSON.stringify({operation:'schema.roles',decision:'migrated'}));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  config(): RemoteConfig {
    const config=this.store.get('remoteConfig',{enabled:false,addresses:[],port:8443,name:'PAL'});
    if(this.store.get<number>('pal.remoteNameMigration',0)<1){if(config.name==='Cere'){config.name='PAL';this.store.set('remoteConfig',config);}this.store.set('pal.remoteNameMigration',1);}
    return config;
  }
  configure(config: RemoteConfig) { this.store.set('remoteConfig',config); }
  devices(): Device[] { return this.store.db.prepare('SELECT data FROM remote_devices').all().map(r=>JSON.parse(String(r.data))); }
  device(id: string): Device | undefined { const r=this.store.db.prepare('SELECT data FROM remote_devices WHERE id=?').get(id);return r?JSON.parse(String(r.data)):undefined; }
  live(id: string) { const d=this.device(id); return d && !d.revokedAt && !lapsed(d) ? d : undefined; }
  /** The connection's transient role is never stored. */
  saveDevice(d: Device) { const {connectionRole:_transient,...stored}=d;this.store.db.prepare('INSERT OR REPLACE INTO remote_devices VALUES (?,?)').run(d.id,JSON.stringify(stored)); }
  /** The role this device acts under on a connection: owner only once its client negotiated owner policy. */
  static effectiveRole(device: Pick<Device,'role'|'connectionRole'>): DeviceRole {
    const stored=deviceRole(device.role);
    return stored==='owner'&&device.connectionRole!=='owner'?'limited':stored;
  }
  audit(event: {deviceId?:string;operation:string;commandId?:string;argsDigest?:string;decision:string;scope?:string;authSessionId?:string;sessionId?:string;projectId?:string;turnId?:string;scopeVersion?:string;policyRevision?:string}) {
    this.store.db.prepare('INSERT INTO remote_audit(time,data) VALUES (?,?)').run(Date.now(),JSON.stringify(event));
  }
  prior(deviceId:string,commandId:string,method:string,params:unknown) {
    const row=this.store.db.prepare('SELECT digest,method,data FROM remote_commands WHERE device=? AND id=?').get(deviceId,commandId);
    if (!row)return undefined;
    if(row.digest!==digest(params)||row.method!==method)throw remoteError('IDEMPOTENCY_CONFLICT','This command ID belongs to another operation.');
    return this.visible(deviceId,JSON.parse(String(row.data)));
  }
  accept(deviceId:string,commandId:string,method:string,params:unknown) {
    const result={commandId,status:'accepted',scopeVersion:this.live(deviceId)?.scopeVersion};
    this.store.db.prepare('INSERT INTO remote_commands VALUES (?,?,?,?,?,?)').run(deviceId,commandId,digest(params),method,JSON.stringify(result),Date.now());
    this.audit({deviceId,commandId,operation:method,argsDigest:digest(params),decision:'accepted'});
    return result;
  }
  finish(deviceId:string,commandId:string,value:unknown) {
    const row=this.store.db.prepare('SELECT data FROM remote_commands WHERE device=? AND id=?').get(deviceId,commandId);
    const scopeVersion=row?JSON.parse(String(row.data)).scopeVersion:undefined;
    this.store.db.prepare('UPDATE remote_commands SET data=? WHERE device=? AND id=?').run(JSON.stringify({commandId,...value as object,scopeVersion}),deviceId,commandId);
  }
  status(deviceId:string,commandId:string) {
    const row=this.store.db.prepare('SELECT data FROM remote_commands WHERE device=? AND id=?').get(deviceId,commandId);
    return row?this.visible(deviceId,JSON.parse(String(row.data))):{commandId,status:'unknown',error:{code:'OUTCOME_UNKNOWN',message:'No retained acceptance record. Review before trying a new command.'}};
  }
  private visible(deviceId:string,value:any) {
    const {scopeVersion,...result}=value,current=this.live(deviceId);
    // Preserve deduplication while withholding all old result/error payloads after any grant change.
    if(!scopeVersion||!current||scopeVersion!==current.scopeVersion)return {commandId:value.commandId,status:value.status==='failed'?'failed':value.status,redacted:true,...(value.status==='failed'?{error:{code:'SCOPE_CHANGED',message:'The outcome belongs to an earlier device grant.'}}:{})};
    return result;
  }
  journal(deviceId:string,data:unknown) {
    // Journal invalidations and message references, not erased transcript bodies.
    return Number(this.store.db.prepare('INSERT INTO remote_journal(device,time,data) VALUES (?,?,?)').run(deviceId,Date.now(),JSON.stringify(data)).lastInsertRowid);
  }
  highWater(deviceId:string) { return Number(this.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM remote_journal WHERE device=?').get(deviceId)!.seq); }
  prune() {
    const db=this.store.db,now=Date.now();
    db.prepare('DELETE FROM remote_pair_offers WHERE expires<?').run(now);
    db.prepare('DELETE FROM remote_journal WHERE time<?').run(now-86400000);
    db.exec('DELETE FROM remote_journal WHERE seq NOT IN (SELECT seq FROM remote_journal ORDER BY seq DESC LIMIT 10000)');
    // Keep ID tombstones after 30 days, preventing accidental reuse after retention.
    db.prepare("UPDATE remote_commands SET data=json_object('commandId',id,'status','unknown') WHERE time<?").run(now-30*86400000);
    db.prepare('DELETE FROM remote_audit WHERE time<?').run(now-90*86400000);
  }
}
