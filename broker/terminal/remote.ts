/**
 * Terminals from an owner phone (terminal.v1). The phone runs this computer's shell through the broker's
 * terminal service, exactly as the desktop's Terminal pane does: same screen, same control lease rules, same
 * process. Watching is per device and never takes control; typing needs a lease acquired by a signed action,
 * after which each input frame travels on the authenticated connection with its lease, epoch and sequence.
 */
import { remoteError } from '../execution.ts';
import type { Router } from '../remote/router.ts';
import type { Device } from '../remote/store.ts';
import type { TerminalPrincipal, TerminalService } from './service.ts';

export class TerminalOps {
  router: Router;
  /** Devices watching each terminal's screen. */
  watchers = new Map<string, Set<string>>();
  /** Sends an event to a device's connected owner sessions (set by the gateway). */
  send?: (deviceId: string, name: string, data: unknown, screen?: boolean) => void;
  /** Every device with a connected owner session (set by the gateway). */
  owners?: () => string[];
  constructor(router: Router) {
    this.router = router;
    const service = this.service;
    service.on('screen', (id: string, data: unknown) => { for (const deviceId of this.watchers.get(id) || []) this.send?.(deviceId, 'terminal.screen', data, true); });
    service.on('scroll', (id: string, data: unknown) => { for (const deviceId of this.watchers.get(id) || []) this.send?.(deviceId, 'terminal.scroll', data); });
    service.on('bell', (id: string) => { for (const deviceId of this.watchers.get(id) || []) this.send?.(deviceId, 'terminal.bell', { id }); });
    service.on('state', (_id: string, dto: unknown) => { for (const deviceId of this.owners?.() || []) this.send?.(deviceId, 'terminal.state', dto); });
    service.on('removed', (id: string) => { this.watchers.delete(id); for (const deviceId of this.owners?.() || []) this.send?.(deviceId, 'terminal.removed', { id }); });
  }
  get service(): TerminalService { return this.router.core.terminals; }
  principal(device: Device): TerminalPrincipal { return { kind: 'device', deviceId: device.id, name: device.name.slice(0, 48) }; }
  private watch(deviceId: string, id: string) { const set = this.watchers.get(id) ?? new Set(); set.add(deviceId); this.watchers.set(id, set); }

  async dispatch(device: Device, method: string, p: any): Promise<any> {
    if (!this.router.owner(device)) throw remoteError('SCOPE_DENIED', 'Terminals need a phone with full access to this desktop.');
    const who = this.principal(device);
    switch (method) {
      case 'terminal.profiles': return this.service.profiles();
      case 'terminal.create': {
        let cwd = p.cwd;
        if (p.sessionId) cwd ??= this.router.session(device, p.sessionId).cwd;
        const created = this.service.create(who, { shell: p.shell, cwd, sessionId: p.sessionId, title: p.title, rows: p.rows, cols: p.cols });
        this.watch(device.id, created.terminal.id);
        return { ...created, ...this.service.snapshot(created.terminal.id) };
      }
      case 'terminal.list': return this.service.list();
      case 'terminal.get': return this.service.dto(this.service.get(p.terminalId));
      case 'terminal.attach': { const snapshot = this.service.snapshot(p.terminalId); this.watch(device.id, p.terminalId); return snapshot; }
      case 'terminal.acquireControl': { const result = this.service.acquire(who, p.terminalId, p.expectedControllerRevision, { rows: p.rows, cols: p.cols }); this.watch(device.id, p.terminalId); return result; }
      case 'terminal.input': return this.service.input(who, p.terminalId, p.leaseId, p.epoch, p.sequence, p.events);
      case 'terminal.inputStatus': return this.service.inputStatus(who, p.terminalId, p.leaseId, p.epoch);
      case 'terminal.resize': return this.service.resize(who, p.terminalId, p.leaseId, p.rows, p.cols);
      case 'terminal.interrupt': return this.service.interrupt(p.terminalId);
      case 'terminal.detach': this.watchers.get(p.terminalId)?.delete(device.id); return true;
      case 'terminal.release': return this.service.release(who, p.terminalId);
      case 'terminal.close': return this.service.close(p.terminalId);
      case 'terminal.forget': return this.service.forget(p.terminalId);
      case 'terminal.history': return this.service.history(p.terminalId, p.before, p.limit);
      default: throw remoteError('INVALID_ARGUMENT', 'Unknown terminal operation.');
    }
  }
  /** A connection closed: it stops watching (the shells keep running). */
  disconnected(deviceId: string, stillConnected: boolean) { if (!stillConnected) for (const set of this.watchers.values()) set.delete(deviceId); }
  async revoked(deviceId: string) { for (const set of this.watchers.values()) set.delete(deviceId); await this.service.revoked(deviceId); }
}
