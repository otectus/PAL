import type { Session, Settings } from './types.ts';
import { deviceRole, ownerSettings, type DeviceRole, type WorkingProfile } from './authority.ts';

// This provenance is broker-owned. It is never taken from a network DTO.
export type RemoteExecution = {
  deviceId: string; projectId: string; scopeVersion: string;
  /** Absent with `lifetime: 'until-revoked'`: an owner phone's authority ends only by revocation. */
  expiresAt?: number; lifetime?: 'until-revoked';
  /** The device role this turn was authorized under. Absent on records from before roles: limited. */
  role?: DeviceRole;
  /** An owner phone's working profile when this turn was accepted (authority.ts). */
  profile?: WorkingProfile; profileRevision?: string;
  caps: string[]; categories: string[]; scriptIds: string[];
  memoryHosts?: string[];
  /** Hosted API providers the device was granted when this execution was authorized. */
  apiProviders?: string[]; apiConnections?: string[];
};
/**
 * The settings a phone-controlled turn runs under. An owner phone gets the desktop's own settings with
 * the bypass switches its working profile resolves to (`currentProfile`: the device's profile now; the
 * narrower applies). A limited phone keeps the scoped view it always had: no bypass switches, and only
 * the categories, grants, scripts and features its pairing granted.
 */
export function ordinarySettings(settings: Settings, execution?: RemoteExecution, currentProfile?: WorkingProfile): Settings {
  if (!execution) return settings;
  if (deviceRole(execution.role) === 'owner') return ownerSettings(settings, execution, currentProfile);
  return { ...settings, bypassCliPermissions: false, bypassComputerPermissions: false,
    categories: settings.categories.filter(c => execution.categories.includes(c) && (c === 'providers' ? execution.caps.includes('providers.execute') : execution.caps.includes('desktop.control'))),
    grants: settings.grants.filter(g => execution.categories.includes(g.category)),
    scripts: settings.scripts.filter(s => execution.scriptIds.includes(s.id)),
    webSearch: { ...settings.webSearch, enabled: settings.webSearch.enabled && execution.caps.includes('web') },
    memory: { ...settings.memory, enabled: settings.memory.enabled && execution.caps.includes('memory.read') },
  };
}
export function busy(session: Session) { return ['starting','working','waiting','stopping'].includes(session.status); }
/** Messages passed here are written for people and may be shown verbatim on a paired phone. */
export function remoteError(code: string, message: string): Error & {code: string; remote: true} { return Object.assign(new Error(message), {code, remote: true as const}); }
