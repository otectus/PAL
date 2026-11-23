/**
 * The desktop side of the operations an owner phone gains (owner-schemas.ts). Every operation maps to one
 * named desktop service method: the gateway never forwards an arbitrary Core method, and each operation's
 * schema, kind and feature are fixed in owner-schemas.ts.
 *
 * An owner phone is the desktop owner on another screen, so these operations use the same services, checks
 * and revisions the desktop uses: a file edit goes through the change engine with its preconditions, an image
 * request through the media service and its budget, a schedule through its reviewed envelope. What changes is
 * attribution (the gateway audit log names the device and command) and transport (bytes move as verified
 * transfers, never as desktop paths the phone cannot open).
 */
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { remoteError } from '../execution.ts';
import { deviceRole, effectiveAccess, workingProfile } from '../authority.ts';
import { settingsFamilies, type SettingsFamily } from './owner-schemas.ts';
import type { Router } from './router.ts';
import type { Device } from './store.ts';

/** Hooks the gateway provides for device administration (it owns sockets and revocation). */
export type OwnerAdmin = {
  devices(): Device[];
  setProfile(params: unknown): Device;
  setRole(params: unknown): Promise<Device>;
  revoke(id: string): Promise<void>;
};

const strip = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

export class OwnerOps {
  router: Router;
  admin?: OwnerAdmin;
  constructor(router: Router) { this.router = router; }
  get core() { return this.router.core; }

  /** A conversation this phone may use, for an operation that names one. */
  private session(device: Device, id: string) { return this.router.session(device, id); }
  /** The desktop method, run exactly as the desktop's own client runs it. */
  private rpc(method: string, params: Record<string, unknown> = {}) { return this.core.rpc(method, params); }
  private owned(sessionId: string, changeSetId: string) {
    const review = this.core.workbench.changes.review(changeSetId);
    if (review.sessionId !== sessionId) throw remoteError('SCOPE_DENIED', 'That change belongs to another conversation.');
    return review;
  }
  private operation(sessionId: string, operationId: string) {
    const operation = this.core.workbench.operations.get(operationId);
    if (operation.sessionId !== sessionId) throw remoteError('SCOPE_DENIED', 'That run belongs to another conversation.');
    return operation;
  }
  private authorizeAnalysis(device: Device, sessionId: string, analysisId?: string) {
    this.session(device, sessionId);
    if (!analysisId) return;
    const entry = this.core.workbench.analyses.list(sessionId).find(row => row.id === analysisId);
    if (!entry) throw remoteError('SCOPE_DENIED', 'That saved analysis is unavailable to this device.');
    this.session(device, entry.sourceSessionId);
  }
  /** Resolve a research ID through the canonical service before authorizing the run's conversation. */
  private async researchRun(device: Device, id: string) {
    const run: any = await this.rpc('research.get', { id });
    this.session(device, run.sessionId);
    return run;
  }
  /** Project lists can include investigations started from another conversation in the same project. */
  private researchRows(device: Device, value: any) {
    if (!Array.isArray(value)) return [];
    return value.filter(run => {
      if (!run || typeof run.sessionId !== 'string') return false;
      try { this.session(device, run.sessionId); return true; } catch { return false; }
    });
  }
  /** Keep a run safely below the authenticated phone frame; passage bodies are fetched one at a time. */
  private researchDto(run: any) {
    if (!run || typeof run !== 'object') return run;
    const { reportText: _reportText, pending: _pending, pendingQueries: _pendingQueries, processed: _processed, ...rest } = run;
    const dto: any = {
      ...rest,
      evidence: Array.isArray(run.evidence) ? run.evidence.map((source: any) => {
        const { excerpt: _excerpt, snippet: _snippet, passages: rawPassages, ...metadata } = source || {};
        return { ...metadata, passages: Array.isArray(rawPassages) ? rawPassages.map((passage: any) => ({ id: passage?.id, location: passage?.location })) : [] };
      }) : [],
      findings: Array.isArray(run.findings) ? run.findings.slice(0, 200).map((finding: any) => ({ ...finding, text: String(finding?.text || '').slice(0, 2_000), citations: Array.isArray(finding?.citations) ? finding.citations.slice(0, 24) : [] })) : [],
      activity: Array.isArray(run.activity) ? run.activity.slice(-150) : [],
    };
    // A pathological generated table must not crowd out source IDs and findings needed to request detail.
    if (Buffer.byteLength(JSON.stringify(dto), 'utf8') > 850_000 && dto.table) dto.table = { columns: Array.isArray(dto.table.columns) ? dto.table.columns : [], rows: [], truncated: true };
    if (Buffer.byteLength(JSON.stringify(dto), 'utf8') > 850_000) dto.findings = dto.findings.slice(0, 100);
    if (Buffer.byteLength(JSON.stringify(dto), 'utf8') > 850_000) dto.activity = dto.activity.slice(-50);
    if (Buffer.byteLength(JSON.stringify(dto), 'utf8') > 850_000) throw remoteError('INVALID_ARGUMENT', 'This research run is too large for the phone. Open it on the desktop.');
    return dto;
  }
  /** Legacy clients requested full runs from list; keep newest complete DTOs that fit one response frame. */
  private researchLegacyList(runs: any[]) {
    const visible: any[] = [];
    let bytes = 2;
    for (const run of runs) {
      const dto = this.researchDto(run), next = Buffer.byteLength(JSON.stringify(dto), 'utf8') + (visible.length ? 1 : 0);
      if (bytes + next > 850_000) break;
      visible.push(dto); bytes += next;
    }
    return visible;
  }
  private deviceDto(device: Device, self: string) {
    const { connectionKey: _c, actionKey: _a, connectionRole: _r, ...rest } = device;
    return { id: rest.id, name: rest.name, role: deviceRole(rest.role), self: rest.id === self, lifetime: rest.lifetime || 'expires', expiresAt: rest.lifetime === 'until-revoked' ? null : rest.expiresAt ?? null,
      revoked: !!rest.revokedAt, lastSeen: rest.lastSeen || null, createdAt: rest.createdAt, actionAuthentication: rest.actionAuthentication || 'biometric', scopeVersion: rest.scopeVersion,
      workingProfile: deviceRole(rest.role) === 'owner' ? workingProfile(rest.profile) : null, projects: deviceRole(rest.role) === 'owner' ? null : rest.projects.map(project => ({ id: project.id, name: project.name, path: project.path })) };
  }
  /** Settings without anything secret (keys live in the credential store, never in settings). */
  private settingsView() {
    const { homePositions: _h, position: _p, roamArea: _r, ...settings } = this.core.settings as any;
    return settings;
  }

  async dispatch(device: Device, method: string, p: any): Promise<any> {
    if (!this.router.owner(device)) throw remoteError('SCOPE_DENIED', 'This needs a phone with full access to this desktop.');
    try { return await this.run(device, method, p); }
    catch (error: any) {
      if (error?.remote === true) throw error;
      // An owner needs the desktop's actual reason to fix a problem; it is shown as written for the owner.
      const code = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'INVALID_ARGUMENT';
      throw remoteError(code, strip(String(error?.message || error || 'The desktop could not complete this.')).slice(0, 400) || 'The desktop could not complete this.');
    }
  }

  private async run(device: Device, method: string, p: any): Promise<any> {
    switch (method) {
      // ── Access, devices, profile ─────────────────────────────────────────────────────────────
      case 'owner.access': return { ...this.router.permissions(device), device: this.deviceDto(device, device.id) };
      case 'owner.profile.set': {
        const next = this.admin!.setProfile({ id: device.id, profile: p.profile, expectedProfileRevision: p.expectedProfileRevision });
        return { workingProfile: workingProfile(next.profile), profileRevision: next.profileRevision, access: effectiveAccess(this.core.settings, next) };
      }
      case 'owner.devices.list': return this.admin!.devices().filter(d => !d.revokedAt).map(d => this.deviceDto(d, device.id));
      case 'owner.devices.revoke': {
        const target = this.admin!.devices().find(d => d.id === p.deviceId && !d.revokedAt);
        if (!target) throw remoteError('INVALID_ARGUMENT', 'That device is not paired.');
        if (target.id === device.id) { setImmediate(() => void this.admin!.revoke(device.id)); return true; }
        await this.admin!.revoke(target.id); return true;
      }
      case 'owner.devices.setRole': {
        // A phone narrows another phone's access; raising any phone to owner stays a desktop decision.
        const target = this.admin!.devices().find(d => d.id === p.deviceId && !d.revokedAt);
        if (!target) throw remoteError('INVALID_ARGUMENT', 'That device is not paired.');
        if (target.scopeVersion !== p.expectedScopeVersion) throw remoteError('REVISION_CONFLICT', 'That phone’s access changed. Review it again.');
        const next = await this.admin!.setRole({ id: target.id, role: p.role, confirmed: true });
        return this.deviceDto(next, device.id);
      }

      // ── Permissions and power ────────────────────────────────────────────────────────────────
      case 'owner.permissions.get': { if (p.sessionId) this.session(device, p.sessionId); return this.rpc('permissions.inspect', p.sessionId ? { sessionId: p.sessionId } : {}); }
      case 'owner.permissions.revokeGrant': return this.rpc('permissions.revoke', { category: p.category, cwd: p.cwd });
      case 'owner.power.start': { for (const id of p.sessionIds) this.session(device, id); return this.rpc('power.start', { sessionIds: p.sessionIds, minutes: p.minutes, cli: p.cli, computer: p.computer }); }
      case 'owner.power.end': return this.rpc('power.end', { id: p.id });

      // ── Conversations ────────────────────────────────────────────────────────────────────────
      case 'owner.sessions.capabilities': { this.session(device, p.sessionId); const s = await this.rpc('session.capabilities', { id: p.sessionId, capabilities: p.capabilities, expectedConfigRevision: p.expectedConfigRevision }); return this.router.sessionDto(device, s as any, false); }
      case 'owner.sessions.delete': {
        const s = this.session(device, p.sessionId);
        if ((s.revision || '0') !== p.expectedRevision) throw remoteError('REVISION_CONFLICT', 'This conversation changed. Review it again.');
        return this.rpc('session.delete', { id: s.id, confirmed: true });
      }
      case 'owner.sessions.branch': {
        const s = this.session(device, p.sessionId);
        const branch: any = await this.rpc('session.branch', { id: s.id, text: p.text, trusted: true, ...(p.provider ? { provider: p.provider } : {}), ...(p.model !== undefined ? { model: p.model } : {}) });
        return this.router.sessionDto(device, this.core.store.session(branch.id), true);
      }
      case 'owner.sessions.export': { const s = this.session(device, p.sessionId); return this.rpc('session.export', { id: s.id, format: 'markdown', ...(p.includeActivity ? { includeActivity: true } : {}) }); }
      case 'owner.sessions.setFolder': { const s = this.session(device, p.sessionId); return this.router.sessionDto(device, await this.rpc('session.organize', { id: s.id, expectedRevision: p.expectedRevision, folderId: p.folderId }) as any, false); }
      case 'owner.folders.list': return this.core.store.folders();
      case 'owner.folders.save': return this.rpc('folders.save', { ...(p.id ? { id: p.id, expectedRevision: p.expectedRevision } : {}), name: p.name });
      case 'owner.folders.delete': return this.rpc('folders.delete', { id: p.id, expectedRevision: p.expectedRevision });

      // ── Workbench: folders and files ─────────────────────────────────────────────────────────
      case 'workbench.roots': this.session(device, p.sessionId); return this.rpc('workspace.roots', { sessionId: p.sessionId });
      case 'workbench.addRoot': this.session(device, p.sessionId); return this.rpc('workspace.addRoot', { sessionId: p.sessionId, path: p.path, ...(p.policy ? { policy: p.policy } : {}), ...(p.primary !== undefined ? { primary: p.primary } : {}) });
      case 'workbench.conversationRoot': this.session(device, p.sessionId); return this.rpc('workspace.conversationRoot', { sessionId: p.sessionId, ...(p.policy ? { policy: p.policy } : {}) });
      case 'workbench.updateRoot': this.session(device, p.sessionId); return this.rpc('workspace.updateRoot', { sessionId: p.sessionId, rootId: p.rootId, policy: p.policy, expectedRevision: p.expectedRevision, ...(p.primary !== undefined ? { primary: p.primary } : {}) });
      case 'workbench.removeRoot': this.session(device, p.sessionId); return this.rpc('workspace.removeRoot', { sessionId: p.sessionId, rootId: p.rootId });
      case 'workbench.grantEdits': this.session(device, p.sessionId); return this.rpc('workspace.grantEdits', { sessionId: p.sessionId, rootId: p.rootId, minutes: p.minutes, ...(p.maxOperations ? { maxOperations: p.maxOperations } : {}), ...(p.maxBytes ? { maxBytes: p.maxBytes } : {}), ...(p.paths ? { paths: p.paths } : {}) });
      case 'workbench.revokeGrant': {
        this.session(device, p.sessionId);
        if (!this.core.workbench.activeGrants(p.sessionId).some(grant => grant.id === p.id)) throw remoteError('INVALID_ARGUMENT', 'That edit permission already ended.');
        return this.rpc('workspace.revokeGrant', { id: p.id });
      }
      case 'workbench.browse': return this.browse(p.path, p.hidden === true);
      case 'workbench.files.list': this.session(device, p.sessionId); return this.rpc('files.list', { sessionId: p.sessionId, rootId: p.rootId, path: p.path, ...(p.cursor ? { cursor: p.cursor } : {}), ...(p.limit ? { limit: p.limit } : {}), ...(p.hidden !== undefined ? { hidden: p.hidden } : {}) });
      case 'workbench.files.stat': this.session(device, p.sessionId); return this.rpc('files.stat', { sessionId: p.sessionId, rootId: p.rootId, path: p.path });
      case 'workbench.files.read': this.session(device, p.sessionId); return this.rpc('files.read', { sessionId: p.sessionId, rootId: p.rootId, path: p.path, ...(p.startLine ? { startLine: p.startLine } : {}), ...(p.lineCount ? { lineCount: p.lineCount } : {}) });
      case 'workbench.files.text': this.session(device, p.sessionId); return this.rpc('files.text', { sessionId: p.sessionId, rootId: p.rootId, path: p.path });
      case 'workbench.files.find': this.session(device, p.sessionId); return this.rpc('files.find', { sessionId: p.sessionId, rootId: p.rootId, path: p.path, pattern: p.pattern, ...(p.cursor ? { cursor: p.cursor } : {}) });
      case 'workbench.files.search': this.session(device, p.sessionId); return this.rpc('files.search', { sessionId: p.sessionId, rootId: p.rootId, path: p.path, query: p.query, ...(p.mode ? { mode: p.mode } : {}), ...(p.caseSensitive !== undefined ? { caseSensitive: p.caseSensitive } : {}), ...(p.cursor ? { cursor: p.cursor } : {}) });

      // ── Workbench: reviewed changes ──────────────────────────────────────────────────────────
      case 'workbench.changes.list': this.session(device, p.sessionId); return this.rpc('changes.list', { sessionId: p.sessionId });
      case 'workbench.changes.review': this.session(device, p.sessionId); this.owned(p.sessionId, p.changeSetId); return this.rpc('changes.review', { id: p.changeSetId });
      case 'workbench.changes.propose': {
        this.session(device, p.sessionId);
        // The owner's own edit: the same change engine and preconditions, and no second "allow what you just did".
        const review: any = await this.rpc('changes.propose', { sessionId: p.sessionId, operations: p.operations, reason: p.reason || 'Edited from PAL Mobile' });
        if (p.apply !== true) return review;
        const applied = await this.rpc('changes.apply', { id: review.id, digest: review.digest });
        return { review, applied };
      }
      case 'workbench.changes.apply': this.session(device, p.sessionId); this.owned(p.sessionId, p.changeSetId); return this.rpc('changes.apply', { id: p.changeSetId, digest: p.digest, ...(p.operations ? { operations: p.operations } : {}) });
      case 'workbench.changes.decline': this.session(device, p.sessionId); this.owned(p.sessionId, p.changeSetId); return this.rpc('changes.decline', { id: p.changeSetId });
      case 'workbench.changes.undo': this.session(device, p.sessionId); this.owned(p.sessionId, p.changeSetId); return this.rpc('changes.undo', { id: p.changeSetId });
      case 'workbench.changes.trash': this.session(device, p.sessionId); return this.rpc('changes.trash', { sessionId: p.sessionId });

      // ── Workbench: artifacts ─────────────────────────────────────────────────────────────────
      case 'workbench.artifacts.list': { this.session(device, p.sessionId); const { sessionId, ...rest } = p; return this.rpc('artifacts.list', { sessionId, ...rest }); }
      case 'workbench.artifacts.get': this.session(device, p.sessionId); return this.rpc('artifacts.get', { sessionId: p.sessionId, artifactId: p.artifactId });
      case 'workbench.artifacts.thumbnail': this.session(device, p.sessionId); return this.rpc('artifacts.thumbnail', { sessionId: p.sessionId, artifactId: p.artifactId, ...(p.versionId ? { versionId: p.versionId } : {}), ...(p.size ? { size: p.size } : {}) });
      case 'workbench.artifacts.update': { this.session(device, p.sessionId); const { sessionId, artifactId, ...changes } = p; return this.rpc('artifacts.update', { sessionId, artifactId, ...changes }); }
      case 'workbench.artifacts.remove': this.session(device, p.sessionId); return this.rpc('artifacts.remove', { sessionId: p.sessionId, artifactId: p.artifactId, ...(p.scope ? { scope: p.scope } : {}) });
      case 'workbench.artifacts.extract': this.session(device, p.sessionId); return this.rpc('artifacts.extract', { sessionId: p.sessionId, artifactId: p.artifactId, ...(p.versionId ? { versionId: p.versionId } : {}), ...(p.options ? { options: p.options } : {}) });
      case 'workbench.artifacts.useInDraft': this.session(device, p.sessionId); return this.rpc('artifacts.useInDraft', { sessionId: p.sessionId, artifactId: p.artifactId, ...(p.versionId ? { versionId: p.versionId } : {}) });
      case 'workbench.artifacts.export': this.session(device, p.sessionId); return this.rpc('artifacts.export', { sessionId: p.sessionId, artifactId: p.artifactId, versionId: p.versionId, rootId: p.rootId, path: p.path });
      case 'workbench.artifacts.bundle': this.session(device, p.sessionId); return this.rpc('artifacts.bundle', { sessionId: p.sessionId, items: p.items, ...(p.name ? { name: p.name } : {}) });

      // ── Workbench: runs, Code Lab, commands ──────────────────────────────────────────────────
      case 'workbench.operations.list': { this.session(device, p.sessionId); const { sessionId, ...rest } = p; return this.rpc('operations.list', { sessionId, ...rest }); }
      case 'workbench.operations.get': {
        this.session(device, p.sessionId);
        if (this.core.research.library.has(p.operationId)) {
          if (this.core.research.get(p.operationId).sessionId !== p.sessionId) throw remoteError('SCOPE_DENIED', 'That investigation belongs to another conversation');
        } else this.operation(p.sessionId, p.operationId);
        return this.rpc('operations.get', { id: p.operationId });
      }
      case 'workbench.operations.cancel': this.session(device, p.sessionId); this.operation(p.sessionId, p.operationId); return this.rpc('operations.cancel', { id: p.operationId });
      case 'workbench.operations.retry': this.session(device, p.sessionId); this.operation(p.sessionId, p.operationId); return this.rpc('operations.retry', { id: p.operationId, ...(p.confirmed ? { confirmed: true } : {}) });
      case 'workbench.codelab.status': if (p.sessionId) this.session(device, p.sessionId); return this.rpc('codelab.status', { sessionId: p.sessionId });
      case 'workbench.codelab.sample': this.session(device, p.sessionId); return this.rpc('codelab.sample', { sessionId: p.sessionId });
      case 'workbench.codelab.grant': this.session(device, p.sessionId); return this.rpc('codelab.grant', { sessionId: p.sessionId, minutes: p.minutes, maxRuns: p.maxRuns });
      case 'workbench.codelab.revoke': this.session(device, p.sessionId); return this.rpc('codelab.revoke', { sessionId: p.sessionId, id: p.id });
      case 'workbench.codelab.preflight': this.authorizeAnalysis(device, p.sessionId, p.analysisId); return this.rpc('codelab.preflight', p);
      case 'workbench.codelab.assist': this.authorizeAnalysis(device, p.sessionId, p.analysisId); return this.rpc('codelab.assist', p);
      case 'workbench.codelab.open': this.session(device, p.sessionId); this.operation(p.sessionId, p.operationId); return this.rpc('codelab.open', { sessionId: p.sessionId, operationId: p.operationId });
      case 'workbench.codelab.save': this.session(device, p.sessionId); this.operation(p.sessionId, p.operationId); return this.rpc('codelab.save', { sessionId: p.sessionId, operationId: p.operationId, name: p.name });
      case 'workbench.codelab.library': {
        this.session(device, p.sessionId);
        const rows = await this.rpc('codelab.library', { sessionId: p.sessionId });
        // Saved analyses are project-visible only when their originating conversation is visible too.
        return Array.isArray(rows) ? rows.filter(row => { try { return row && typeof row.sourceSessionId === 'string' && !!this.session(device, row.sourceSessionId); } catch { return false; } }) : rows;
      }
      case 'workbench.codelab.load': {
        this.authorizeAnalysis(device, p.sessionId, p.id);
        return this.rpc('codelab.load', { sessionId: p.sessionId, id: p.id });
      }
      case 'workbench.codelab.export': this.session(device, p.sessionId); this.operation(p.sessionId, p.operationId); return this.rpc('codelab.export', { sessionId: p.sessionId, operationId: p.operationId, ...(p.outputs ? { outputs: p.outputs } : {}) });
      case 'workbench.codelab.table': this.session(device, p.sessionId); await this.rpc('artifacts.get', { sessionId: p.sessionId, artifactId: p.artifactId }); return this.rpc('codelab.table', { sessionId: p.sessionId, artifactId: p.artifactId, versionId: p.versionId, ...(p.query ? { query: p.query } : {}), ...(p.sort ? { sort: p.sort } : {}), ...(p.direction ? { direction: p.direction } : {}), ...(p.offset !== undefined ? { offset: p.offset } : {}), ...(p.limit ? { limit: p.limit } : {}) });
      case 'workbench.codelab.exportRows': this.session(device, p.sessionId); await this.rpc('artifacts.get', { sessionId: p.sessionId, artifactId: p.artifactId }); return this.rpc('codelab.exportRows', { sessionId: p.sessionId, artifactId: p.artifactId, versionId: p.versionId, ...(p.query ? { query: p.query } : {}), ...(p.sort ? { sort: p.sort } : {}), ...(p.direction ? { direction: p.direction } : {}), ...(p.rows ? { rows: p.rows } : {}) });
      case 'workbench.codelab.schedule': {
        this.authorizeAnalysis(device, p.sessionId, p.id);
        return this.rpc('codelab.schedule', { sessionId: p.sessionId, id: p.id, days: p.days, authorizerDeviceId: device.id });
      }
      case 'workbench.codelab.remove': {
        this.authorizeAnalysis(device, p.sessionId, p.id);
        return this.rpc('codelab.remove', { sessionId: p.sessionId, id: p.id });
      }
      case 'workbench.codelab.run':
        this.authorizeAnalysis(device, p.sessionId, p.analysisId);
        return this.rpc('codelab.run', { ...p, purpose: p.purpose || 'Run from PAL Mobile' });
      case 'workbench.operations.history': {
        const session = this.session(device, p.sessionId);
        if (p.project && p.project !== this.router.projectFor(device, session.cwd).id)
          throw remoteError('SCOPE_DENIED', 'History is limited to this conversation’s granted project.');
        const allowed = this.core.workbench.analyses.projectSessions(session.id).filter(id => {
          try { this.session(device, id); return true; } catch { return false; }
        });
        return this.rpc('operations.history', { ...p, project: !!p.project, allowedSessions: allowed });
      }
      case 'workbench.operations.compare': {
        this.session(device, p.sessionId);
        const left = this.core.workbench.operations.get(p.left), right = this.core.workbench.operations.get(p.right);
        this.session(device, left.sessionId); this.session(device, right.sessionId);
        return this.rpc('operations.compare', { sessionId: p.sessionId, left: p.left, right: p.right, ...(p.key ? { key: p.key } : {}), ...(p.mode ? { mode: p.mode } : {}) });
      }
      case 'workbench.commands.run': this.session(device, p.sessionId); return this.rpc('commands.run', { sessionId: p.sessionId, rootId: p.rootId, argv: p.argv, ...(p.cwd ? { cwd: p.cwd } : {}), network: p.network === true, ...(p.timeoutSeconds ? { timeoutSeconds: p.timeoutSeconds } : {}) });

      // ── Workbench: images ────────────────────────────────────────────────────────────────────
      case 'workbench.images.connections': return this.rpc('images.connections');
      case 'workbench.images.capabilities': return this.rpc('images.capabilities', { connectionId: p.connectionId, ...(p.workflowId ? { workflowId: p.workflowId } : {}) });
      case 'workbench.images.preview': this.session(device, p.sessionId); return this.rpc('images.preview', { sessionId: p.sessionId, connectionId: p.connectionId, ...(p.workflowId ? { workflowId: p.workflowId } : {}), request: p.request });
      case 'workbench.images.generate': {
        this.session(device, p.sessionId);
        return this.rpc('images.generate', { sessionId: p.sessionId, connectionId: p.connectionId, ...(p.workflowId ? { workflowId: p.workflowId } : {}), request: p.request, ...(p.acknowledgeBilling ? { acknowledgeBilling: true } : {}) });
      }
      case 'workbench.images.transform': this.session(device, p.sessionId); return this.rpc('images.transform', { sessionId: p.sessionId, artifactId: p.artifactId, ...(p.versionId ? { versionId: p.versionId } : {}), steps: p.steps });
      case 'workbench.images.saveEdit': {
        this.session(device, p.sessionId);
        const layer = p.layerTransferId ? (await this.router.transfers.staged(device, p.layerTransferId, 'layer')).toString('base64') : p.layer;
        const result = await this.rpc('images.saveEdit', { sessionId: p.sessionId, artifactId: p.artifactId, ...(p.versionId ? { versionId: p.versionId } : {}), layer, ...(p.recipe ? { recipe: p.recipe } : {}) });
        if (p.layerTransferId) await this.router.transfers.consume(device, p.layerTransferId);
        return result;
      }
      case 'workbench.images.mask': {
        this.session(device, p.sessionId);
        const mask = p.maskTransferId ? (await this.router.transfers.staged(device, p.maskTransferId, 'mask')).toString('base64') : p.mask;
        const result = await this.rpc('images.mask', { sessionId: p.sessionId, artifactId: p.artifactId, ...(p.versionId ? { versionId: p.versionId } : {}), mask });
        if (p.maskTransferId) await this.router.transfers.consume(device, p.maskTransferId);
        return result;
      }
      case 'workbench.images.sketch': this.session(device, p.sessionId); return this.rpc('images.sketch', { sessionId: p.sessionId, width: p.width, height: p.height, ...(p.background ? { background: p.background } : {}) });
      case 'workbench.images.contactSheet': this.session(device, p.sessionId); return this.rpc('images.contactSheet', { sessionId: p.sessionId, items: p.items });
      case 'workbench.images.inspect': this.session(device, p.sessionId); return this.rpc('images.inspect', { sessionId: p.sessionId, artifactId: p.artifactId, ...(p.versionId ? { versionId: p.versionId } : {}) });
      case 'workbench.images.ocr': this.session(device, p.sessionId); return this.rpc('images.ocr', { sessionId: p.sessionId, artifactId: p.artifactId, ...(p.versionId ? { versionId: p.versionId } : {}), ...(p.region ? { region: p.region } : {}) });
      case 'workbench.images.analyze': this.session(device, p.sessionId); return this.rpc('images.analyze', { sessionId: p.sessionId, artifactId: p.artifactId, ...(p.versionId ? { versionId: p.versionId } : {}), ...(p.question ? { question: p.question } : {}), ...(p.region ? { region: p.region } : {}) });
      case 'workbench.references.search': this.session(device, p.sessionId); return this.rpc('references.search', { sessionId: p.sessionId, query: p.query });
      case 'workbench.references.preview': this.session(device, p.sessionId); return this.rpc('references.preview', { sessionId: p.sessionId, references: p.references, ...(p.text ? { text: p.text } : {}) });
      case 'workbench.shelf': this.session(device, p.sessionId); return this.rpc('shelf.get', { sessionId: p.sessionId });

      // ── Transfers ────────────────────────────────────────────────────────────────────────────
      case 'transfers.download': this.session(device, p.sessionId); return this.router.transfers.download(device, p);
      case 'transfers.read': return this.router.transfers.read(device, p);
      case 'transfers.upload': this.session(device, p.sessionId); return this.router.transfers.upload(device, p);
      case 'transfers.status': return this.router.transfers.status(device, p.transferId);
      case 'transfers.commit': return this.router.transfers.commit(device, p);
      case 'transfers.abort': return this.router.transfers.abort(device, p.transferId);

      // ── Administration ───────────────────────────────────────────────────────────────────────
      case 'owner.settings.get': {
        const credentials = this.core.credentials.status();
        return { revision: this.core.store.get('settingsRevision', '0'), settings: this.settingsView(), families: settingsFamilies,
          credentials: Object.fromEntries(Object.entries(credentials).map(([provider, value]: [string, any]) => [provider, { configured: !!value.configured, source: value.source, ...(value.boundTo ? { boundTo: value.boundTo } : {}) }])) };
      }
      case 'owner.settings.patch': {
        const allowed = settingsFamilies[p.family as SettingsFamily] as readonly string[];
        const extra = Object.keys(p.values).filter(key => !allowed.includes(key));
        if (extra.length) throw remoteError('INVALID_ARGUMENT', `These settings are not part of ${p.family}: ${extra.slice(0, 5).join(', ')}.`);
        if (!Object.keys(p.values).length) throw remoteError('INVALID_ARGUMENT', 'Choose a setting to change.');
        await this.core.updateSettings({ expectedRevision: p.expectedRevision, ...p.values });
        return { revision: this.core.store.get('settingsRevision', '0'), settings: this.settingsView() };
      }
      case 'owner.connections.list': return this.rpc('connections.list');
      case 'owner.connections.save': return this.rpc('connections.save', p);
      case 'owner.connections.remove': return this.rpc('connections.remove', { id: p.id });
      case 'owner.connections.models': return this.rpc('connections.models', { id: p.id });
      case 'owner.credentials.set': {
        const key = p.key ?? '';
        const status: any = p.provider === 'elevenlabs' ? await this.rpc('elevenlabs.credentials', { key }) : await this.rpc('provider.credentials', { provider: p.provider, key, ...(p.connectionId ? { connectionId: p.connectionId } : {}) });
        // Only whether a key is configured comes back; the key itself never does.
        return { provider: p.provider, configured: !!status?.configured, source: status?.source || (key ? 'saved' : 'missing') };
      }
      case 'owner.extensions.status': return this.rpc('extensions.status');
      case 'owner.extensions.restart': return this.rpc('extensions.restart', { id: p.id });
      case 'owner.extensions.secret': { await this.rpc('extensions.secret', { id: p.id, name: p.name, value: p.value ?? '' }); return { id: p.id, name: p.name, configured: !!p.value }; }
      case 'owner.extensions.resources': return this.rpc('extensions.resources', { id: p.id, ...(p.cursor ? { cursor: p.cursor } : {}) });
      case 'owner.extensions.prompts': return this.rpc('extensions.prompts', { id: p.id });
      case 'owner.extensions.oauthStart': return this.core.oauth.start({ id: p.id, ...(p.clientId ? { clientId: p.clientId } : {}), ...(p.clientSecret ? { clientSecret: p.clientSecret } : {}) }, { id: device.id, name: device.name.slice(0, 48) });
      case 'owner.extensions.oauthComplete': return this.core.oauth.complete({ state: p.state, ...(p.code ? { code: p.code } : {}), ...(p.error ? { error: p.error } : {}) }, device.id);
      case 'owner.extensions.oauthSignOut': return this.core.oauth.signOut(p.id);
      case 'owner.extensions.importPreview': return this.core.extensions.importPreview({ text: p.text });
      case 'owner.extensions.importApply': return this.core.extensions.importApply({ token: p.token, names: p.names });
      case 'owner.extensions.writes': return this.core.extensions.writeReviews();
      case 'owner.translate': this.session(device, p.sessionId); return this.core.translation.run({ sessionId: p.sessionId, targetLanguage: p.targetLanguage, ...(p.text ? { text: p.text } : {}), ...(p.input ? { input: p.input } : {}), ...(p.glossary ? { glossary: p.glossary } : {}) }, AbortSignal.timeout(10 * 60_000));
      case 'owner.collections.addUrl': return this.core.collections.addUrl({ id: p.id, url: p.url });
      case 'owner.collections.addArtifact': this.session(device, p.sessionId); return this.core.collections.addArtifact({ id: p.id, sessionId: p.sessionId, artifactId: p.artifactId, ...(p.versionId ? { versionId: p.versionId } : {}) });
      case 'owner.collections.setWatch': return this.core.collections.setWatch({ id: p.id, watch: p.watch });
      case 'owner.tables.preview': this.session(device, p.sessionId); return this.rpc('tables.preview', p);
      case 'owner.voice.status': { const status: any = this.core.transcription.status(); return { available: status.state !== 'unavailable', state: status.state, engine: 'whisper.cpp' }; }
      case 'owner.voice.transcribe': this.session(device, p.sessionId); return this.core.voiceNote({ sessionId: p.sessionId, mime: p.mime, audio: p.audio });
      case 'owner.specialists.list': return this.core.specialists.list();
      case 'owner.specialists.save': return this.core.specialists.save({ specialist: p.specialist, ...(p.expectedRevision ? { expectedRevision: p.expectedRevision } : {}) });
      case 'owner.specialists.delete': return this.core.specialists.remove({ id: p.id });
      case 'owner.specialists.setConcurrency': return this.core.specialists.setConcurrency({ concurrency: p.concurrency });
      case 'owner.setups.list': return this.core.setups.list();
      case 'owner.setups.save': return this.core.setups.save({ setup: p.setup, ...(p.expectedRevision ? { expectedRevision: p.expectedRevision } : {}) });
      case 'owner.setups.delete': return this.core.setups.remove({ id: p.id });
      case 'owner.setups.preview': this.session(device, p.sessionId); return this.core.setups.preview({ setupId: p.setupId, sessionId: p.sessionId });
      case 'owner.setups.apply': { const applied = await this.core.setups.apply({ token: p.token }); return { applied: applied.applied, session: this.router.sessionDto(device, applied.session, true) }; }
      case 'owner.setups.start': { const started = await this.core.setups.start({ setupId: p.setupId, expectedSetupRevision: p.expectedSetupRevision, cwd: p.cwd, ...(p.provider ? { provider: p.provider } : {}), ...(p.model ? { model: p.model } : {}) }); return { ...started, session: this.router.sessionDto(device, started.session, true) }; }
      case 'owner.extensions.resolveWrite': return this.core.extensions.resolveWrite({ id: p.id, outcome: p.outcome }, device.name.slice(0, 48));
      case 'owner.customTools.credential': { await this.rpc('customTools.credential', { id: p.id, value: p.value ?? '' }); return { id: p.id, configured: !!p.value }; }
      case 'owner.schedules.list': return this.rpc('schedules.list');
      // The phone that signs a routine's creation or resumption is recorded as its authorizer (PAL Everywhere §17.1).
      case 'owner.schedules.setEnabled': return this.core.schedules.setEnabled({ id: p.id, enabled: p.enabled }, { kind: 'device', deviceId: device.id, name: device.name.slice(0, 48) });
      case 'owner.schedules.adopt': return this.core.schedules.adopt({ id: p.id });
      case 'owner.schedules.delete': return this.rpc('schedules.delete', { id: p.id });
      case 'owner.schedules.create': return this.core.schedules.create({ label: p.label, when: p.when, previewToken: p.previewToken, unattended: true, ...(p.missed ? { missed: p.missed } : {}) }, { kind: 'device', deviceId: device.id, name: device.name.slice(0, 48) });
      case 'owner.recipes.list': return this.rpc('recipes.list');
      case 'owner.recipes.prepare': this.session(device, p.sessionId); return this.rpc('recipes.prepare', { sessionId: p.sessionId, recipeId: p.recipeId, ...(p.version ? { version: p.version } : {}), ...(p.inputs ? { inputs: p.inputs } : {}) });
      case 'owner.recipes.createDraft': { const created: any = await this.rpc('recipes.createDraft', { previewToken: p.previewToken, reviewed: true }); return created?.id ? this.router.sessionDto(device, this.core.store.session(created.id), true) : created; }
      case 'owner.results.list': { if (p.sessionId) this.session(device, p.sessionId); return this.rpc('results.list', { ...(p.sessionId ? { sessionId: p.sessionId } : {}), ...(p.limit ? { limit: p.limit } : {}) }); }
      case 'owner.results.verify': this.session(device, p.sessionId); return this.rpc('results.runVerification', { sessionId: p.sessionId, scriptId: p.scriptId, expectedScript: p.expectedScript, reviewed: true });
      case 'owner.collections.list': return this.rpc('collections.list', p.sessionId ? { sessionId: this.session(device, p.sessionId).id } : {});
      case 'owner.collections.create': return this.rpc('collections.create', { name: p.name, ...(p.grounding ? { grounding: p.grounding } : {}), ...(p.allowCloud !== undefined ? { allowCloud: p.allowCloud } : {}) });
      case 'owner.collections.addSource': return this.rpc('collections.addSource', { id: p.id, expectedRevision: p.expectedRevision, path: p.path });
      case 'owner.collections.removeSource': return this.rpc('collections.removeSource', { id: p.id, expectedRevision: p.expectedRevision, path: p.path });
      case 'owner.collections.bind': { if (p.sessionId) this.session(device, p.sessionId); return this.rpc('collections.bind', { id: p.id, target: p.target, ...(p.sessionId ? { sessionId: p.sessionId } : {}), bound: p.bound }); }
      case 'owner.collections.index': return this.rpc('collections.index', { id: p.id });
      case 'owner.collections.cancel': return this.rpc('collections.cancel');
      case 'owner.collections.delete': return this.rpc('collections.delete', { id: p.id, expectedRevision: p.expectedRevision, confirmed: true });
      case 'owner.projects.save': return this.rpc('projects.save', p);
      case 'owner.models.local': return this.rpc('models.local');
      case 'owner.models.pull': return this.rpc('models.pull', { model: p.model });
      case 'owner.models.delete': return this.rpc('models.delete', { model: p.model, confirmed: true });
      case 'owner.models.cancelPull': return this.rpc('models.cancelPull');
      case 'owner.jobs.cancel': return this.rpc('jobs.cancel', { id: p.id });
      case 'owner.usage.summary': { if (p.sessionId) this.session(device, p.sessionId); return this.core.usage.summary({ days: p.days, ...(p.sessionId ? { sessionId: p.sessionId } : {}) }); }
      case 'owner.usage.setPolicy': return this.core.usage.setPolicy(p);
      case 'owner.skills.list': return this.rpc('skills.list');
      case 'owner.skills.review': return this.rpc('skills.review', { versionId: p.versionId });
      case 'owner.skills.importRepository': return this.rpc('skills.importRepository', { url: p.url, ...(p.ref ? { ref: p.ref } : {}) });
      case 'owner.skills.importPath': {
        const info = await stat(p.path).catch(() => { throw remoteError('INVALID_ARGUMENT', 'That path does not exist on the desktop.'); });
        return this.rpc(info.isDirectory() ? 'skills.importFolder' : 'skills.importArchive', { path: p.path });
      }
      case 'owner.skills.importArtifact': {
        // A ZIP the phone uploaded (transfers) and the desktop verified, read from the artifact store.
        this.session(device, p.sessionId);
        const { version, data } = await this.core.workbench.artifacts.bytes(p.sessionId, p.artifactId, p.versionId);
        return this.core.skills.importArchive(data, `artifact:${version.artifactId}/${version.versionId}`);
      }
      case 'owner.skills.enable': return this.rpc('skills.enable', { versionId: p.versionId, expectedRevision: p.expectedRevision, ...(p.invocation ? { invocation: p.invocation } : {}), ...(p.scope ? { scope: p.scope } : {}), ...(p.project ? { project: p.project } : {}) });
      case 'owner.skills.disable': return this.rpc('skills.disable', { versionId: p.versionId });
      case 'owner.skills.remove': return this.rpc('skills.remove', { skillId: p.skillId });
      case 'owner.research.sources': this.session(device, p.sessionId); return this.rpc('research.sources', p);
      case 'owner.research.plan': this.session(device, p.sessionId); return this.rpc('research.plan', p);
      case 'owner.research.start': this.session(device, p.sessionId); return this.rpc('research.start', p);
      case 'owner.research.list': {
        if (p.sessionId) this.session(device, p.sessionId);
        const rows = await this.rpc('research.list', { ...(p.sessionId ? { sessionId: p.sessionId } : {}), ...(p.project === true ? { project: true } : {}) });
        const visible = this.researchRows(device, rows);
        return p.project === true ? visible : this.researchLegacyList(visible);
      }
      case 'owner.research.get': return this.researchDto(await this.researchRun(device, p.id));
      case 'owner.research.readReport': {
        await this.researchRun(device, p.id);
        const report: any = await this.rpc('research.readReport', p);
        return { text: String(report?.text || '') };
      }
      case 'owner.research.passage': {
        const run: any = await this.researchRun(device, p.id);
        const view: any = p.versionId ? await this.rpc('research.readReport', { id: p.id, versionId: p.versionId }) : run;
        const source = (view?.evidence || []).find((entry: any) => Array.isArray(entry?.passages) && entry.passages.some((passage: any) => passage?.id === p.passageId));
        const passage = source?.passages.find((entry: any) => entry?.id === p.passageId);
        if (!source || !passage) throw remoteError('INVALID_ARGUMENT', 'That cited passage is not part of this report version.');
        return { id: passage.id, text: String(passage.text || ''), location: String(passage.location || ''), sourceId: source.id, title: String(source.title || ''), ...(p.versionId ? { versionId: p.versionId } : {}) };
      }
      case 'owner.research.pause': await this.researchRun(device, p.id); return this.rpc('research.pause', { id: p.id });
      case 'owner.research.stop': await this.researchRun(device, p.id); return this.rpc('research.stop', { id: p.id });
      case 'owner.research.refresh': await this.researchRun(device, p.id); return this.rpc('research.refresh', { id: p.id });
      case 'owner.research.continue': await this.researchRun(device, p.id); return this.rpc('research.continue', p);
      case 'owner.research.steer': await this.researchRun(device, p.id); return this.rpc('research.steer', p);
      case 'owner.research.ask': await this.researchRun(device, p.id); return this.rpc('research.ask', p);
      case 'owner.research.update': {
        await this.researchRun(device, p.id);
        // Starting a recurring monitor requires durable delegated authority. A one-shot phone action proof is
        // intentionally insufficient, so phones can turn monitoring off but cannot create a recurring task.
        if (typeof p.monitorDays === 'number' && p.monitorDays > 0) throw remoteError('SCOPE_DENIED', 'Start recurring research monitoring on the desktop so its durable authorization can be reviewed.');
        return this.rpc('research.update', p);
      }
      case 'owner.research.export': await this.researchRun(device, p.id); return this.rpc('research.export', p);
      case 'owner.research.note': await this.researchRun(device, p.id); return this.rpc('research.note', p);
      case 'owner.research.exclude': await this.researchRun(device, p.id); return this.rpc('research.exclude', { id: p.id, evidenceId: p.evidenceId });
      case 'owner.research.resynthesize': await this.researchRun(device, p.id); return this.rpc('research.resynthesize', { id: p.id });
      case 'owner.notebook.scratchpad': return this.core.notebook.scratchpad(p.project);
      case 'owner.notebook.save': return this.core.notebook.save(p.project, p.text, p.expectedRevision, device.name.slice(0, 48));
      case 'owner.notebook.day': return this.core.notebook.day(p.date, p.offsetMinutes);
      case 'view.start': return this.core.remoteView.start(device.id, device.name.slice(0, 48), p.output);
      case 'view.frame': return this.core.remoteView.frame(p.viewId, device.id, p.maxWidth);
      case 'view.input': return this.core.remoteView.send(p.viewId, device.id, p);
      case 'view.stop': return this.core.remoteView.stop(p.viewId, device.id);
      case 'owner.health': return this.rpc('health.inspect');
      case 'owner.backup.status': return this.rpc('recovery.status');
      case 'owner.backup.create':
        if (p.includeMemory) throw remoteError('INVALID_ARGUMENT', 'To include memory, review a content backup on the desktop.');
        return this.rpc('recovery.backup');
      default: {
        if (method.startsWith('canvas.')) { if (p.sessionId) this.session(device, p.sessionId); return this.rpc(method, p); }
        if (method.startsWith('terminal.')) return this.router.terminals.dispatch(device, method, p);
        throw remoteError('INVALID_ARGUMENT', 'Unknown owner operation.');
      }
    }
  }

  /**
   * The owner's own view of a desktop folder, for choosing what a conversation may use: names, kinds and sizes
   * only, at most 500 entries, never file contents. Choosing a folder is the person's act; nothing here feeds a
   * model or indexes anything.
   */
  private async browse(path: string | undefined, hidden: boolean) {
    const target = await realpath(path || homedir()).catch(() => { throw remoteError('INVALID_ARGUMENT', 'That folder does not exist on the desktop.'); });
    const info = await stat(target);
    if (!info.isDirectory()) throw remoteError('INVALID_ARGUMENT', 'Choose a folder.');
    const entries = (await readdir(target, { withFileTypes: true }).catch(() => { throw remoteError('INVALID_ARGUMENT', 'The desktop account cannot read that folder.'); }))
      .filter(entry => hidden || !entry.name.startsWith('.'))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const items = await Promise.all(entries.slice(0, 500).map(async entry => {
      const full = join(target, entry.name);
      const kind = entry.isDirectory() ? 'folder' : entry.isSymbolicLink() ? 'link' : entry.isFile() ? 'file' : 'other';
      let size: number | null = null;
      if (kind === 'file') size = await stat(full).then(s => s.size, () => null);
      return { name: entry.name, path: full, kind, size };
    }));
    const parent = target === '/' ? null : join(target, '..');
    return { path: target, parent, home: homedir(), items, truncated: entries.length > 500 };
  }
}
