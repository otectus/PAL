/**
 * View desktop (PAL Everywhere §8.5): an owner phone watches this computer's screen and, where the system allows
 * it, points, clicks and types. It is for genuine desktop-GUI tasks; PAL's own screens have native phone versions.
 *
 * Viewing is deliberate and visible: it starts and ends by an explicit action, the desktop shows a notice both times,
 * and frames are still images taken on request (adaptive to slow connections), never a recording. Input needs a
 * Wayland input tool on this computer (ydotool with its daemon for the pointer, wtype for text); without one the
 * view stays read-only and says why. Coordinates map to the display the frame was taken from, so a click lands
 * where the person tapped. Nothing here bypasses a locked session, a portal prompt or a powered-off computer, and
 * viewing never authorizes a model to use the desktop.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { Core } from './core.ts';
import { remoteError } from './execution.ts';

const run = promisify(execFile);
type Monitor = { name: string; x: number; y: number; width: number; height: number; scale: number; focused: boolean; disabled?: boolean };
type View = { id: string; deviceId: string; deviceName: string; started: number; output: string; revision: number; monitor?: Monitor };

const tool = (name: string) => ['/usr/bin/', '/usr/local/bin/', '/bin/'].map(dir => dir + name).find(existsSync);

export class RemoteView {
  core: Core;
  private views = new Map<string, View>();
  constructor(core: Core) { this.core = core; }
  /** What input this computer allows: a pointer through ydotool, text through wtype or ydotool. */
  input() {
    const ydotool = tool('ydotool'), wtype = tool('wtype');
    return { pointer: !!ydotool, text: !!(wtype || ydotool),
      ...(ydotool ? {} : { reason: 'Pointer control needs ydotool (and its ydotoold service) on this computer. Viewing still works.' }) };
  }
  private async monitors(): Promise<Monitor[]> {
    const value = JSON.parse((await run('hyprctl', ['-j', 'monitors'], { timeout: 3000 })).stdout);
    return (value as Monitor[]).filter(m => !m.disabled);
  }
  private owned(id: string, deviceId: string) { const view = this.views.get(id); if (!view || view.deviceId !== deviceId) throw remoteError('INVALID_ARGUMENT', 'This view ended. Start it again.'); return view; }
  async start(deviceId: string, deviceName: string, output?: string) {
    if (!tool('grim')) throw remoteError('DEPENDENCY_MISSING', 'Viewing the desktop needs grim installed on this computer.');
    let monitors: Monitor[];
    try { monitors = await this.monitors(); } catch { throw remoteError('DESKTOP_UNAVAILABLE', 'The desktop session could not be reached (Hyprland is not answering). It may be locked or not running.'); }
    const monitor = monitors.find(m => m.name === output) || monitors.find(m => m.focused) || monitors[0];
    if (!monitor) throw remoteError('DESKTOP_UNAVAILABLE', 'No active display to show.');
    for (const [id, view] of this.views) if (view.deviceId === deviceId) this.views.delete(id);
    const view: View = { id: randomUUID(), deviceId, deviceName, started: Date.now(), output: monitor.name, revision: 0, monitor };
    this.views.set(view.id, view);
    this.core.emit('notice', { kind: 'remote-view', text: `${deviceName} is viewing this desktop` });
    this.core.store.activity({ action: 'remote.view', device: deviceName, status: 'started' });
    return { viewId: view.id, output: monitor.name, outputs: monitors.map(m => ({ name: m.name, width: m.width, height: m.height, focused: m.focused })), input: this.input() };
  }
  /** One still frame of the chosen display, reduced to at most `maxWidth` pixels wide. */
  async frame(id: string, deviceId: string, maxWidth = 1280) {
    const view = this.owned(id, deviceId);
    const monitor = (await this.monitors()).find(m => m.name === view.output);
    if (!monitor) throw remoteError('DESKTOP_UNAVAILABLE', 'That display is no longer connected.');
    view.monitor = monitor;
    const { stdout } = await run('grim', ['-o', view.output, '-'], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, timeout: 10_000 }).catch(() => { throw remoteError('DESKTOP_UNAVAILABLE', 'The display could not be captured (the session may be locked).'); });
    const image = sharp(stdout as Buffer), meta = await image.metadata();
    const width = Math.min(Math.max(320, Math.round(maxWidth)), meta.width || maxWidth);
    const jpeg = await image.resize({ width, withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
    view.revision++;
    return { viewId: id, revision: view.revision, output: view.output, width, height: Math.round(width * (meta.height || 1) / (meta.width || 1)), data: 'data:image/jpeg;base64,' + jpeg.toString('base64') };
  }
  /** Input at a point of the last frame (0–1), or text; refused with the reason when this computer allows none. */
  async send(id: string, deviceId: string, p: { kind: 'click' | 'move' | 'type' | 'key'; x?: number; y?: number; text?: string; key?: string; frameRevision?: number },authorize?:()=>void) {
    const view = this.owned(id, deviceId), monitor = view.monitor, available = this.input();
    if (p.frameRevision !== undefined && p.frameRevision !== view.revision) throw remoteError('REVISION_CONFLICT', 'The screen changed since that frame. Look at the new one and tap again.');
    if(authorize){
      const now=(await this.monitors()).find(m=>m.name===view.output);
      if(!monitor||!now||['x','y','width','height','scale','transform'].some(k=>now[k as keyof Monitor]!==monitor[k as keyof Monitor]))throw remoteError('REVISION_CONFLICT','Display geometry changed. Request a new screenshot.');
      authorize();
    }
    if (p.kind === 'type') {
      const text = String(p.text || '').slice(0, 2000);
      if (tool('wtype')) await run('wtype', ['--', text], { timeout: 10_000 });
      else if (tool('ydotool')) await run('ydotool', ['type', '--', text], { timeout: 10_000 });
      else throw remoteError('DEPENDENCY_MISSING', 'Typing into the desktop needs wtype or ydotool on this computer.');
      return { sent: true };
    }
    if (p.kind === 'key') {
      const keys: Record<string, string> = { Enter: '28:1 28:0', Escape: '1:1 1:0', Tab: '15:1 15:0', Backspace: '14:1 14:0' };
      if (!keys[p.key || '']) throw remoteError('INVALID_ARGUMENT', 'Choose Enter, Escape, Tab or Backspace.');
      if (tool('ydotool')) await run('ydotool', ['key', ...keys[p.key!].split(' ')], { timeout: 5000 });
      else if (tool('wtype')) await run('wtype', ['-k', p.key === 'Enter' ? 'Return' : p.key!], { timeout: 5000 });
      else throw remoteError('DEPENDENCY_MISSING', 'Keys need wtype or ydotool on this computer.');
      return { sent: true };
    }
    if (!available.pointer || !monitor) throw remoteError('DEPENDENCY_MISSING', available.reason || 'Pointer control is not available.');
    const x = Math.round(monitor.x + Math.max(0, Math.min(1, p.x ?? 0.5)) * monitor.width / (monitor.scale || 1)), y = Math.round(monitor.y + Math.max(0, Math.min(1, p.y ?? 0.5)) * monitor.height / (monitor.scale || 1));
    await run('ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)], { timeout: 5000 });
    authorize?.();
    if (p.kind === 'click') await run('ydotool', ['click', '0xC0'], { timeout: 5000 });
    return { sent: true, x, y };
  }
  stop(id: string, deviceId: string) {
    const view = this.views.get(id);
    if (view && view.deviceId === deviceId) {
      this.views.delete(id);
      this.core.emit('notice', { kind: 'remote-view', text: `${view.deviceName} stopped viewing this desktop` });
      this.core.store.activity({ action: 'remote.view', device: view.deviceName, status: 'stopped', durationMs: Date.now() - view.started });
    }
    return true;
  }
  /** Revocation and shutdown end every view of a device. */
  end(deviceId?: string) { for (const [id, view] of this.views) if (!deviceId || view.deviceId === deviceId) this.stop(id, view.deviceId); }
}
