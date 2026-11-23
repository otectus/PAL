/**
 * Who is acting, and with what authority (PAL Everywhere, handoff §5–6).
 *
 * Authentication proves which phone sent an action (broker/remote). Authority is a separate question,
 * answered here so the desktop and the phone get the same decision for the same operation:
 *
 * - `observer` phones read their conversations and may Stop or Deny; nothing else.
 * - `limited` phones keep the scoped grants every phone had before roles existed: granted projects,
 *   capabilities and categories, restricted provider launch, no Workbench, no power sessions.
 * - `owner` phones carry the desktop owner's own authority. The owner chooses this once, on the desktop,
 *   when pairing or by promoting a phone; afterwards the phone works without further desktop visits.
 *
 * A conversation's `remote` field is the authorization snapshot of the phone that controls it now. A
 * limited snapshot is sticky (desktop involvement never silently widens it). An owner snapshot is
 * desktop-equivalent; when the desktop sends the next turn, control returns to the desktop and the
 * phone stays recorded in `remoteOrigin` for attribution.
 *
 * Working profiles decide what PAL may do automatically for an owner phone's model actions. They never
 * widen the device's ceiling, and an accepted turn keeps the narrower of the profile it started with and
 * the profile in force now, so authority is never acquired halfway through a run.
 */
import type { Session, Settings } from './types.ts';
import type { RemoteExecution } from './execution.ts';

export const deviceRoles = ['observer', 'limited', 'owner'] as const;
export type DeviceRole = (typeof deviceRoles)[number];
export const workingProfiles = ['desktop', 'review', 'automatic'] as const;
export type WorkingProfile = (typeof workingProfiles)[number];
export const workingProfileLabels: Record<WorkingProfile, string> = {
  desktop: 'Use my desktop choices',
  review: 'Review changes',
  automatic: 'Work automatically',
};
/** Capabilities an observer phone may hold: reading, and the reductions (Stop, Deny) that come with them. */
export const observerCaps = ['chat.read', 'approvals.answer', 'memory.read'] as const;

export type Principal = { kind: 'local-owner' } | { kind: 'device'; deviceId: string; role: DeviceRole };

/** A stored role. Records written before roles existed are limited devices; nothing is inferred upward. */
export function deviceRole(value: unknown): DeviceRole {
  return value === 'owner' || value === 'observer' ? value : 'limited';
}
export function workingProfile(value: unknown): WorkingProfile {
  return value === 'review' || value === 'automatic' ? value : 'desktop';
}

/** The role of whoever controls this conversation now: the desktop, or the phone that sent its last turn. */
export function controllerRole(session: Pick<Session, 'remote'>): 'desktop' | DeviceRole {
  return session.remote ? deviceRole(session.remote.role) : 'desktop';
}
/** Desktop-equivalent authority: the desktop itself, or an owner phone. */
export function ownerControlled(session: Pick<Session, 'remote'>): boolean {
  const role = controllerRole(session);
  return role === 'desktop' || role === 'owner';
}
/** A limited or observer phone controls this conversation, so the restricted mobile boundary applies. */
export function limitedControlled(session: Pick<Session, 'remote'>): boolean {
  return !ownerControlled(session);
}

/**
 * Whether an authorization record (a device or a turn's execution snapshot) has lapsed. A record that
 * lasts until revoked has no expiry at all: nothing serializes Infinity or invents a far-future date.
 */
export function lapsed(record: { expiresAt?: number | null; lifetime?: string }, now = Date.now()): boolean {
  if (record.lifetime === 'until-revoked') return false;
  return typeof record.expiresAt !== 'number' || record.expiresAt <= now;
}

/** The bypass switches a working profile resolves to, from the desktop's own switches. */
export function profileBypass(profile: WorkingProfile, settings: Pick<Settings, 'bypassCliPermissions' | 'bypassComputerPermissions'>) {
  if (profile === 'review') return { cli: false, computer: false };
  if (profile === 'automatic') return { cli: true, computer: true };
  return { cli: settings.bypassCliPermissions === true, computer: settings.bypassComputerPermissions === true };
}

/**
 * Settings for an owner phone's turn: the desktop's own settings with the bypass switches the working
 * profile resolves to. `current` is the device's profile now; the narrower of the two applies.
 */
export function ownerSettings(settings: Settings, execution: Pick<RemoteExecution, 'profile'>, current?: WorkingProfile): Settings {
  const started = profileBypass(workingProfile(execution.profile), settings);
  const now = current === undefined ? started : profileBypass(current, settings);
  return { ...settings, bypassCliPermissions: started.cli && now.cli, bypassComputerPermissions: started.computer && now.computer };
}

export type AccessReason = { capability: string; code: string; detail: string };
/**
 * What a principal may do now, and why: the explanation both clients show. Broker-derived only; a client
 * can request a profile but never supplies this object.
 */
export type EffectiveAccess = {
  role: 'desktop' | DeviceRole;
  profileId: WorkingProfile;
  profileLabel: string;
  profileRevision: string;
  execution: 'isolated' | 'desktop-account';
  approvalMode: 'review' | 'automatic' | 'inherit';
  lifetime: 'expires' | 'until-revoked';
  expiresAt?: number;
  paused: boolean;
  /** One literal line, for example "Host access · desktop account · Use my desktop choices". */
  summary: string;
  reasons: AccessReason[];
};

/**
 * Describes the effective policy of the desktop owner or a phone. `device` is the stored device record for a
 * phone principal; absent means the desktop itself.
 */
export function effectiveAccess(settings: Settings, device?: { role?: unknown; profile?: unknown; profileRevision?: string; lifetime?: string; expiresAt?: number; caps?: string[] }): EffectiveAccess {
  const role = device ? deviceRole(device.role) : 'desktop';
  const profile = device ? workingProfile(device.profile) : 'desktop';
  const ownerLike = role === 'desktop' || role === 'owner';
  const bypass = profileBypass(profile, settings);
  const reasons: AccessReason[] = [];
  if (settings.paused) reasons.push({ capability: 'all', code: 'paused', detail: 'Desktop actions are paused (Permissions → Pause).' });
  if (role === 'limited') reasons.push({ capability: 'workbench', code: 'limited-device', detail: 'This phone has limited access: Files, Images, Analysis, terminals and power sessions stay on the desktop or an owner phone.' });
  if (role === 'observer') reasons.push({ capability: 'all', code: 'observer-device', detail: 'This phone observes: it reads conversations and can Stop or Deny.' });
  if (ownerLike && !bypass.cli) reasons.push({ capability: 'providers', code: profile === 'review' ? 'profile-review' : 'desktop-review', detail: profile === 'review' ? 'The Review changes profile asks before provider commands and edits.' : 'Provider permission requests are reviewed (Permissions → automatic CLI approval is off).' });
  if (ownerLike && !bypass.computer) reasons.push({ capability: 'computer', code: profile === 'review' ? 'profile-review' : 'desktop-review', detail: 'Desktop actions requested by a model are reviewed before they run.' });
  const approvalMode = !ownerLike ? 'review' : profile === 'desktop' ? 'inherit' : profile;
  const execution = ownerLike ? 'desktop-account' : 'isolated';
  const lifetime = device?.lifetime === 'until-revoked' ? 'until-revoked' : 'expires';
  const summary = role === 'observer' ? 'Read only · Stop and Deny'
    : role === 'limited' ? 'Limited access · granted projects and actions'
      : `Host access · desktop account · ${workingProfileLabels[profile]}`;
  return { role, profileId: profile, profileLabel: workingProfileLabels[profile], profileRevision: device?.profileRevision || '0', execution, approvalMode,
    lifetime, ...(lifetime === 'expires' && typeof device?.expiresAt === 'number' ? { expiresAt: device.expiresAt } : {}), paused: settings.paused === true, summary, reasons };
}
