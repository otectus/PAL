import net from "node:net";
import { chmod, lstat, unlink, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { sameUserPeer, trustedServer } from "../peercred.ts";
import { privateDir } from "../paths.ts";
import { LiveObservationFactory, LiveWorkspaceState } from "./adapters/live.ts";
import { inspectGitCheckout } from "./adapters/workspace.ts";
import { parse } from "./contracts.ts";
const fishParams = z
  .object({
    source: z.literal("fish"),
    source_epoch: z.string().uuid(),
    source_sequence: z.number().int().positive(),
    event: z.enum(["start", "exit", "cwd", "postexec", "posterror", "focus_in", "focus_out"]),
    shell_session_id: z.string().uuid(),
    cwd: z.string().max(4096),
    status: z.number().int().optional(),
    pipeline_status: z.array(z.number().int()).max(64).optional(),
    duration_ms: z.number().int().nonnegative().optional(),
    terminal_binding: z.object({ kind: z.literal("kitty_window_id"), id: z.string().max(64), pid: z.number().int().positive().optional() }).strict().optional(),
  })
  .strict();
/** An editor says which document is open, saved or closed. Its text is never sent and has no field to be sent in. */
const editorParams = z
  .object({
    source: z.literal("editor"),
    source_epoch: z.string().uuid(),
    source_sequence: z.number().int().positive(),
    event: z.enum(["document_opened", "document_focused", "document_saved", "document_closed", "editor_closed"]),
    editor: z.string().regex(/^[A-Za-z0-9 ._-]{1,40}$/),
    pid: z.number().int().positive().optional(),
    path: z.string().min(1).max(4096).optional(),
    content_revision: z.string().max(64).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    terminal_binding: z.object({ kind: z.literal("kitty_window_id"), id: z.string().max(64), pid: z.number().int().positive().optional() }).strict().optional(),
  })
  .strict()
  .refine((p) => p.event === "editor_closed" || !!p.path, "A document event names its path");
const frame = z
  .object({
    protocol_version: z.literal(1),
    request_id: z.string().uuid(),
    method: z.literal("collector.emit"),
    params: z.union([fishParams, editorParams]),
  })
  .strict();
/** The service's fenced view of live state: writes after a collector restart are discarded. */
export type LiveSink = Pick<LiveWorkspaceState, "apply" | "snapshot" | "markSourceUnknown">;
export class CollectorRpc {
  server?: net.Server;
  socket: string;
  live: LiveSink;
  policy: () => Promise<any>;
  sessions = new Map<
    string,
    { factory: LiveObservationFactory; sequence: number; entity: string }
  >();
  constructor(
    runtime: string,
    live: LiveSink,
    policy: () => Promise<any>,
  ) {
    this.socket = join(runtime, "memory.sock");
    this.live = live;
    this.policy = policy;
  }
  async start() {
    // The same owner-private directory chain as the broker runtime.
    privateDir(join(this.socket, ".."));
    try {
      const stat = await lstat(this.socket);
      if (!stat.isSocket() || stat.uid !== process.getuid?.())
        throw new Error("Unsafe collector socket");
      const occupied = await new Promise<boolean>((resolve, reject) => {
        const socket = net.createConnection(this.socket);
        socket.once("connect", () => {
          const trusted = trustedServer(socket);
          socket.destroy();
          trusted ? resolve(true) : reject(new Error("Collector socket belongs to another user"));
        });
        socket.once("error", () => resolve(false));
      });
      if (occupied) throw new Error("Collector socket is already serving");
      await unlink(this.socket);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    this.server = net.createServer((socket) => {
      if (!sameUserPeer(socket)) {
        socket.destroy();
        return;
      }
      socket.setTimeout(1000, () => socket.destroy());
      let buffer = "";
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer) > 65536) {
          socket.destroy();
          return;
        }
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        socket.pause();
        void this.ingest(buffer.slice(0, end)).then(
          (result) => {
            if (!socket.destroyed)
              socket.end(
                JSON.stringify({ protocol_version: 1, result }) + "\n",
              );
          },
          () => socket.destroy(),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socket, () => resolve());
    });
    await chmod(this.socket, 0o600);
  }
  async ingest(text: string) {
    const request = parse(frame, JSON.parse(text)), params = request.params;
    if (params.source === "editor") return this.editor(params);
    const p = params, { policy } = await this.policy();
    if (!policy.enabled || !policy.fish_enabled)
      throw new Error("Fish observation is disabled");
    if (p.source_epoch !== p.shell_session_id)
      throw new Error("Shell epoch mismatch");
    let state = this.sessions.get(p.shell_session_id);
    if (!state) {
      if (this.sessions.size >= 256)
        this.sessions.delete(this.sessions.keys().next().value!);
      state = {
        factory: new LiveObservationFactory(
          "fish",
          10000,
          undefined,
          p.source_epoch,
        ),
        sequence: 0,
        entity: p.shell_session_id,
      };
      this.sessions.set(p.shell_session_id, state);
    }
    if (p.source_sequence <= state.sequence) return { duplicate: true };
    state.sequence = p.source_sequence;
    const cwd = await this.approved(p.cwd, policy.approved_roots);
    const observation = state.factory.observation(
      state.entity,
      p.source_epoch,
      p.event === "exit" ? "SHELL_EXIT" : "SHELL_STATE",
      {
        ...(cwd ? { cwd } : {}),
        event: p.event,
        shellSessionId: p.shell_session_id,
        ...(p.status !== undefined
          ? { status: p.status, pipelineStatus: p.pipeline_status || [] }
          : {}),
        ...(p.duration_ms !== undefined ? { durationMs: p.duration_ms } : {}),
        ...(p.terminal_binding ? { kittyPaneId: p.terminal_binding.id, ...(p.terminal_binding.pid ? { kittyPid: p.terminal_binding.pid } : {}) } : {}),
      },
    );
    this.live.apply(observation);
    if (cwd) {
      try {
        const checkout = await inspectGitCheckout(cwd);
        const repository = new LiveObservationFactory("repository", 60000);
        this.live.apply(
          repository.observation(
            checkout.checkoutId,
            checkout.checkoutId,
            "CHECKOUT_VERIFIED",
            JSON.parse(JSON.stringify(checkout)),
          ),
        );
      } catch {}
    }
    if (p.event === "exit") this.sessions.delete(p.shell_session_id);
    return { generation: this.live.snapshot().generation, durable: false };
  }
  /** A path as it really is, when it lies inside an approved folder; a link that leaves one does not. */
  private async approved(path: string, roots: string[]): Promise<string | undefined> {
    try {
      const real = await realpath(path);
      for (const root of roots) {
        const delta = relative(await realpath(root), real);
        if (delta === "" || (!delta.startsWith("..") && !isAbsolute(delta))) return real;
      }
    } catch { /* it does not exist, or may not be read */ }
    return undefined;
  }
  /** One editor process is one epoch. A document outside the approved folders leaves no trace at all. */
  private async editor(p: z.infer<typeof editorParams>) {
    const { policy } = await this.policy();
    if (!policy.enabled || !policy.editor_enabled) throw new Error("Editor observation is disabled");
    let state = this.sessions.get("editor:" + p.source_epoch);
    if (!state) {
      if (this.sessions.size >= 256) this.sessions.delete(this.sessions.keys().next().value!);
      state = { factory: new LiveObservationFactory("editor", 300_000, undefined, p.source_epoch), sequence: 0, entity: p.source_epoch };
      this.sessions.set("editor:" + p.source_epoch, state);
    }
    if (p.source_sequence <= state.sequence) return { duplicate: true };
    state.sequence = p.source_sequence;
    const path = p.path ? await this.approved(p.path, policy.approved_roots) : undefined;
    if (p.event !== "editor_closed" && !path) return { ignored: "outside_approved_folders", durable: false };
    const identity = { editor: p.editor, ...(p.pid ? { pid: p.pid } : {}), ...(p.terminal_binding ? { kittyPaneId: p.terminal_binding.id, ...(p.terminal_binding.pid ? { kittyPid: p.terminal_binding.pid } : {}) } : {}) };
    // Each editor has one entity: what it shows now. A closed document or editor is said, not forgotten silently.
    this.live.apply(state.factory.observation("editor:" + p.source_epoch, p.source_epoch, p.event.toUpperCase(), {
      ...identity, event: p.event, ...(path ? { path } : {}), ...(p.content_revision ? { contentRevision: p.content_revision } : {}),
    }));
    if (p.event === "editor_closed") this.sessions.delete("editor:" + p.source_epoch);
    return { generation: this.live.snapshot().generation, durable: false };
  }
  async close() {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
      await unlink(this.socket).catch(() => {});
    }
    this.sessions.clear();
    this.live.markSourceUnknown("fish", "collector_stopped");
    this.live.markSourceUnknown("editor", "collector_stopped");
  }
}
