/**
 * Model tools for Canvas (PAL Everywhere §13.1): open a page of the workspace in the isolated preview, look at it,
 * inspect the DOM, click and type, and read the console, all inside that one preview. Offered with Files.
 */
import { z } from 'zod';
import { completed, failed, type ToolResultV1 } from './tools/contracts.ts';
import type { Workbench } from './workbench.ts';

export function registerCanvasTools(workbench: Workbench) {
  const { registry } = workbench, canvas = () => workbench.core.canvas;
  const guard = (run: (context: any, args: any) => Promise<ToolResultV1>) => async (context: any, args: any) => { try { return await run(context, args); } catch (error: any) { if (context.signal?.aborted) throw error; return failed('failed', String(error?.message || error).slice(0, 400), 'explicit'); } };
  const available = (session: any) => workbench.filesAvailable(session, 'read') || (canvas().browserPath() ? '' : 'Canvas needs Chromium or Chrome on this computer');
  const id = z.string().uuid();
  registry.register({
    name: 'canvas_open', family: 'files', effects: { read: true },
    description: 'Open an .html file of a workspace folder in PAL’s isolated preview browser (no network, no access to anything else). Returns the preview ID; then use canvas_view, canvas_inspect, canvas_click, canvas_type.',
    input: z.strictObject({ path: z.string().min(1).max(4096), rootId: z.string().max(200).optional(), width: z.int().min(240).max(2560).optional(), height: z.int().min(240).max(2560).optional() }), available,
    run: guard(async ({ sessionId }, args) => {
      const root = args.rootId ? workbench.roots.get(sessionId, args.rootId) : workbench.roots.primary(sessionId);
      if (!root) return failed('no_root', 'No workspace folder is chosen', 'never');
      const preview = await canvas().open({ sessionId, rootId: root.id, path: args.path, width: args.width, height: args.height });
      return completed(`Opened ${args.path} in the preview (revision ${preview.revision}).`, preview);
    }),
  });
  registry.register({
    name: 'canvas_view', family: 'files', effects: { read: true },
    description: 'Screenshot the current preview as an image artifact the user also sees, with the latest console messages.',
    input: z.strictObject({ id }), available,
    run: guard(async ({ sessionId }, args) => {
      const version = await canvas().screenshot(args.id, sessionId);
      return { ...completed(`Screenshot of the preview: ${version.name}.`, { artifactId: version.artifactId, versionId: version.versionId, console: canvas().console(args.id, sessionId).slice(-20) }), artifacts: [{ artifactId: version.artifactId, versionId: version.versionId, purpose: 'canvas-screenshot' }] } as ToolResultV1;
    }),
  });
  registry.register({
    name: 'canvas_inspect', family: 'files', effects: { read: true },
    description: 'Read the preview’s DOM: the whole page, or one element by CSS selector (bounded HTML, text and box), plus recent console messages.',
    input: z.strictObject({ id, selector: z.string().max(500).optional() }), available,
    run: guard(async ({ sessionId }, args) => completed('Preview DOM read.', await canvas().inspect(args.id, args.selector, sessionId))),
  });
  registry.register({
    name: 'canvas_click', family: 'files', effects: { read: true },
    description: 'Click an element of the preview by CSS selector, as a user would.',
    input: z.strictObject({ id, selector: z.string().min(1).max(500) }), available,
    run: guard(async ({ sessionId }, args) => completed(`Clicked ${args.selector}.`, await canvas().clickSelector(args.id, args.selector, sessionId))),
  });
  registry.register({
    name: 'canvas_type', family: 'files', effects: { read: true },
    description: 'Type text into the preview, optionally clicking an element (selector) first; key may be Enter, Tab, Backspace, Escape or an arrow key.',
    input: z.strictObject({ id, selector: z.string().max(500).optional(), text: z.string().max(10_000).optional(), key: z.string().max(20).optional() }), available,
    run: guard(async ({ sessionId }, args) => {
      if (args.selector) await canvas().clickSelector(args.id, args.selector, sessionId);
      if (args.text) await canvas().input(args.id, { kind: 'type', text: args.text }, sessionId);
      if (args.key) await canvas().input(args.id, { kind: 'key', key: args.key }, sessionId);
      return completed('Typed into the preview.', { console: canvas().console(args.id, sessionId).slice(-10) });
    }),
  });
}
