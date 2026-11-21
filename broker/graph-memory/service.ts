import { extractionChunk, relocateWitness } from "./extraction-chunks.ts";
import { TaskConnectionResolver, TaskModelRouter } from './task-router.ts';
import { taskProviderAdapters } from './task-providers.ts';
import { bindingSchema, type TaskModelBinding } from './task-models.ts';
import { ReviewInference, errorCode } from './review-inference.ts';
import { profileSchema, type Profile } from './assessment.ts';
import type { ChatConnection } from '../connections.ts';
import { join, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { GraphMemory, pointId } from "./client.ts";
import { Neo4jGraphRepository } from "./adapters/neo4j.ts";
import { QdrantVectorRepository } from "./adapters/qdrant.ts";
import { ApiExtractionAdapter, RoutedExtractionAdapter, googleEmbeddings } from './adapters/api.ts';
import { ProviderCredentials } from '../credentials.ts';
import { OllamaExtractionAdapter, ExtractionPolicyError } from "./adapters/ollama.ts";
import { LiveWorkspaceState } from "./adapters/live.ts";
import { HyprlandCollector } from "./adapters/hyprland.ts";
import { KittyCollector } from "./adapters/kitty.ts";
import {
  FilesystemMetadataCollector,
  RepositoryCollector,
} from "./adapters/workspace.ts";
import type {
  LiveCollector,
  LiveObservation,
  VectorArtifactMetadata,
} from "./adapters/contracts.ts";
import { ollamaJson, ollamaHost, isCloudModel } from "../ollama.ts";
import { createHash } from "node:crypto";
import { fail } from "./contracts.ts";
import { CollectorRpc } from "./collector-rpc.ts";
import { defaultExtractionModel } from "./models.ts";
import { embeddingPrompts } from "./prompts.ts";
import { extractionProposals } from "./proposals.ts";
import { paths } from "../paths.ts";

type Row = Record<string, any>;
export interface MemoryConfiguration {
  enabled: boolean;
  paused: boolean;
  host: string;
  embedding_model: string;
  extraction_model: string;
  embedding_provider?: 'ollama' | 'google';
  allow_cloud_embedding?: boolean;
  extraction_provider?: 'ollama' | 'google' | 'anthropic';
  allow_cloud_extraction: boolean;
  allow_cloud_memory: boolean;
}
export class MemoryService {
  canonical: GraphMemory;
  configuration: MemoryConfiguration = {
    enabled: false,
    paused: false,
    host: "http://127.0.0.1:11434",
    embedding_model: "nomic-embed-text",
    extraction_model: defaultExtractionModel,
    allow_cloud_extraction: true,
    allow_cloud_memory: false,
  };
  live = new LiveWorkspaceState();
  collectors: LiveCollector[] = [];
  collectorRpc?: CollectorRpc;
  graph?: Neo4jGraphRepository;
  vectors = new Map<string, QdrantVectorRepository>();
  extractor?: OllamaExtractionAdapter | ApiExtractionAdapter | RoutedExtractionAdapter;
  credentials: ProviderCredentials;
  timer: NodeJS.Timeout;
  busy = false;
  recoveryFrozen = false;
  closed = false;
  foreground = 0;
  review:ReviewInference;
  reviewSettings:{profile:Profile,revision:number}={profile:profileSchema.parse({}),revision:0};
  readConnection:(id:string)=>ChatConnection=()=>{throw new Error('Saved connection unavailable');};
  reviewController=new AbortController();
  reviewWork?:Promise<void>;
  retentionWork?:Promise<void>;
  nextScan=0;
  workRound=0;
  lastMaintenance = 0;
  controller = new AbortController();
  notify: (event: Row) => void;
  lastError = "";
  /** Why the last housekeeping tick stopped early; the next tick retries. */
  maintenanceError = "";
  /** Why background embedding last failed; it tries again a minute later. */
  embeddingError = "";
  embeddingRetryAt = 0;
  /** Each server's embedding space for the configured model, with its vector size. */
  spaces = new Map<string, { model: string; at: number; dimension: number; fingerprint: string }>();
  /** Set once no vector stored as JSON text remains to repack. */
  vectorsPacked = false;
  /** Collector generation: callbacks from a stopped generation are discarded. */
  collectorGeneration = 0;
  /** Current collector policy with resolved approved roots, used to filter every live read. */
  livePolicy: { policy: Row; roots: string[] } = { policy: { enabled: false }, roots: [] };
  constructor(directory: string, notify: (event: Row) => void = () => {}) {
    this.notify = notify;
    this.credentials = new ProviderCredentials(join(directory, 'credentials'));
    this.canonical = new GraphMemory(directory, (event) => {
      // Expired retention does not cancel extraction or projection in flight; an erasure or
      // policy change does, since their stale epoch would reject the work anyway.
      if (event.type === "invalidate" && event.cause !== "expiration") {
        this.controller.abort(new Error("Memory context invalidated"));
        this.controller = new AbortController();
      }
      notify(event);
    });
    const resolver=new TaskConnectionResolver({credentials:this.credentials,readConnection:id=>this.readConnection(id),defaultOllamaHost:()=>this.configuration.host});
    this.review=new ReviewInference(this.canonical,new TaskModelRouter({resolver,adapters:taskProviderAdapters()}));
    this.timer = setInterval(() => {
      void this.maintain();
    }, 1000);
    this.timer.unref();
  }
  routeManifest(profile:Profile){
    const entries:string[]=[];
    const visit=(binding:TaskModelBinding)=>{
      try{entries.push(this.review.router.resolve(binding).fingerprint);}
      catch{entries.push('unavailable:'+binding.connectionRef);}
      binding.fallbackBindings?.forEach(visit);
    };
    for(const b of [profile.reviewModel,...Object.values(profile.overrides)])if(b)visit(b);
    return JSON.stringify(entries);
  }
  usesBinding(ref:string){
    const {reviewModel,overrides}=this.reviewSettings.profile;
    const matches=(b:TaskModelBinding):boolean=>b.connectionRef===ref||!!b.fallbackBindings?.some(matches);
    return [reviewModel,...Object.values(overrides)].some(b=>b&&matches(b));
  }
  async bindingChanged(ref:string){
    if(!this.usesBinding(ref))return;
    this.reviewController.abort();this.reviewController=new AbortController();
    this.extractor=undefined;
    const settings=await this.canonical.call('curation_binding_changed',{manifest:this.routeManifest(this.reviewSettings.profile)});
    if(settings.revision>=this.reviewSettings.revision)this.reviewSettings=settings;
    this.nextScan=0;
    await this.canonical.call('extraction_reconcile',{include_denied:true});
  }
  async configure(p: MemoryConfiguration) {
    const changed = JSON.stringify(this.configuration) !== JSON.stringify(p);
    const extractionChanged = ["host", "extraction_model", "extraction_provider", "allow_cloud_extraction"].some(
      (key) => (this.configuration as any)[key] !== (p as any)[key],
    );
    const settings=await this.canonical.call("curation_settings");
    if(settings.revision>=this.reviewSettings.revision)this.reviewSettings=settings;
    this.configuration = { ...p };
    if(this.reviewSettings.profile.reviewModel||Object.keys(this.reviewSettings.profile.overrides).length){
      const reconciled=await this.canonical.call('curation_route_snapshot',{revision:this.reviewSettings.revision,manifest:this.routeManifest(this.reviewSettings.profile)});
      if(reconciled.revision>=this.reviewSettings.revision)this.reviewSettings=reconciled;
    }
    if (!changed) return;
    this.controller.abort(new Error("Memory configuration changed"));
    this.controller = new AbortController();
    this.reviewController.abort();this.reviewController=new AbortController();
    this.extractor = undefined;
    // A new server or embedding model starts a new space; background embedding begins at once.
    this.spaces.clear();
    this.embeddingRetryAt = 0;
    const current = await this.canonical.call("policy_get");
    if (
      current.policy.enabled !== p.enabled ||
      current.policy.allow_cloud_memory !== p.allow_cloud_memory
    )
      await this.canonical.call("policy_update", {
        policy: {
          enabled: p.enabled,
          allow_cloud_memory: p.allow_cloud_memory,
        },
      });
    // Runs denied under the previous extraction route are re-evaluated at dispatch.
    if (extractionChanged)
      await this.canonical.call("extraction_reconcile", { include_denied: true });
    await this.startCollectors();
  }
  async startCollectors() {
    const generation = ++this.collectorGeneration;
    await this.collectorRpc?.close();
    this.collectorRpc = undefined;
    for (const c of this.collectors) await c.stop();
    this.collectors = [];
    const { policy } = await this.canonical.call("policy_get");
    const roots = (
      await Promise.all(
        (policy.approved_roots as string[]).map((root) => realpath(root).catch(() => "")),
      )
    ).filter(Boolean);
    // Configuration and canonical policy must both allow collection; otherwise nothing survives.
    const enabled = !this.recoveryFrozen && this.configuration.enabled && !this.configuration.paused && policy.enabled;
    this.livePolicy = { policy: enabled ? policy : { ...policy, enabled: false }, roots };
    // Revocation takes effect before any new collector starts: revoked sources, roots
    // and titles leave the live state immediately.
    this.live.redact((o) => this.permitted(o));
    this.notify({ type: "workspace", generation: this.live.snapshot().generation });
    if (!enabled || generation !== this.collectorGeneration) return;
    const accept = (o: LiveObservation) => {
      if (generation !== this.collectorGeneration || this.closed) return false;
      const permitted = this.permitted(o);
      if (!permitted) return false;
      this.live.apply(permitted);
      this.notify({
        type: "workspace",
        generation: this.live.snapshot().generation,
      });
      return true;
    };
    if (policy.fish_enabled) {
      this.collectorRpc = new CollectorRpc(
        process.env.CERE_RUNTIME_DIR
          ? join(paths().runtime, "memory")
          : join(process.env.XDG_RUNTIME_DIR || paths().runtime, "cere-memory"),
        {
          apply: accept,
          snapshot: () => this.live.snapshot(),
          markSourceUnknown: (source, reason) =>
            generation === this.collectorGeneration ? this.live.markSourceUnknown(source, reason) : 0,
        },
        () => this.canonical.call("policy_get"),
      );
      try {
        await this.collectorRpc.start();
      } catch {
        this.lastError = "COLLECTOR_UNAVAILABLE";
      }
    }
    if (policy.hyprland_enabled)
      this.collectors.push(
        new HyprlandCollector({
          captureTitles: policy.capture_titles,
          titleApplicationAllowlist: policy.title_applications,
        }),
      );
    if (policy.kitty_enabled && process.env.CERE_KITTY_INSPECT_ENDPOINT)
      this.collectors.push(
        new KittyCollector({
          endpoint: process.env.CERE_KITTY_INSPECT_ENDPOINT,
          instanceId: process.env.CERE_KITTY_INSTANCE_ID || randomUUID(),
          approvedCwdRoots: policy.approved_roots,
        }),
      );
    if (policy.filesystem_enabled)
      this.collectors.push(
        new FilesystemMetadataCollector({
          approvedRoots: policy.approved_roots,
        }),
      );
    if (policy.approved_roots.length)
      this.collectors.push(new RepositoryCollector(policy.approved_roots));
    for (const c of this.collectors)
      try {
        await c.start((o) => void accept(o));
      } catch {
        this.lastError = "COLLECTOR_UNAVAILABLE";
      }
  }
  /**
   * Applies the current collector policy to one live observation: the kept
   * observation, a copy with revoked properties removed, or null when its source,
   * root or collector is no longer approved. Freshness is never authorization.
   */
  permitted(o: LiveObservation): LiveObservation | null {
    const { policy, roots } = this.livePolicy;
    if (!policy.enabled) return null;
    const within = (path: unknown) =>
      typeof path === "string" &&
      roots.some((root) => {
        const delta = relative(root, path);
        return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
      });
    const properties: Record<string, any> = { ...o.properties };
    const enabled: Record<string, boolean> = {
      hyprland: policy.hyprland_enabled,
      fish: policy.fish_enabled,
      kitty: policy.kitty_enabled,
      filesystem: policy.filesystem_enabled,
      repository: roots.length > 0,
      editor: false,
    };
    if (!enabled[o.source]) return null;
    if (o.source === "hyprland" && "title" in properties &&
      !(policy.capture_titles && (policy.title_applications || []).includes(String(properties.appClass))))
      delete properties.title;
    if ((o.source === "fish" || o.source === "kitty") && "cwd" in properties && !within(properties.cwd))
      delete properties.cwd;
    if (o.source === "filesystem" && o.freshness !== "unknown" && !(within(properties.path) && within(properties.root)))
      return null;
    if (o.source === "repository" && o.freshness !== "unknown") {
      const checkout = properties.checkoutRoot;
      const overlaps = within(checkout) || (typeof checkout === "string" && roots.some((root) => {
        const delta = relative(checkout, root);
        return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
      }));
      if (!overlaps) return null;
    }
    return { ...o, properties };
  }
  /**
   * Production embedding identity. The route is validated from current /tags and
   * /show metadata before any memory text is embedded: cloud-backed embedding
   * models are refused, so local-only sources never leave through indexing. A
   * user-configured remote Ollama server remains supported; it is not cloud.
   */
  async identity(host: string, signal: AbortSignal, model = this.configuration.embedding_model) {
    if (this.configuration.embedding_provider === 'google') {
      if (!this.configuration.allow_cloud_embedding) fail('POLICY_DENIED', 'Enable cloud memory embeddings before using Gemini');
      const digest = createHash('sha256').update(JSON.stringify(['google-embedding-route-v1', model])).digest('hex');
      return { key: JSON.stringify(['google-api', model, digest, 'unit', 'Cosine', 'retrieval-tasks-v1', 'codepoint-chunks-480-v1']), digest };
    }
    const tags = await ollamaJson(host, "tags", undefined, signal);
    const m = tags.models?.find((m: Row) =>
      [model, model + ":latest"].includes(m.name || m.model),
    );
    if (!m?.digest)
      fail("BACKEND_UNAVAILABLE", "Embedding model digest is unavailable");
    const shown = await ollamaJson(host, "show", { model: m.model || m.name }, signal).catch((error: any) => {
      signal.throwIfAborted();
      fail("BACKEND_UNAVAILABLE", `Embedding model metadata is unavailable: ${String(error?.message || error).slice(0, 200)}`);
    });
    if (isCloudModel(model, m, shown))
      fail("POLICY_DENIED", "Memory embedding requires a local model; cloud-backed embedding models are not used");
    if (Array.isArray(shown?.capabilities) && shown.capabilities.length && !shown.capabilities.includes("embedding"))
      fail("BACKEND_UNAVAILABLE", "Configured memory model does not advertise embedding capability");
    const key = JSON.stringify([
      ollamaHost(host),
      model,
      m.digest,
      "unit",
      "Cosine",
      embeddingPrompts(model).id,
      "codepoint-chunks-480-v1",
    ]);
    return { key, digest: m.digest };
  }
  async embed(
    host: string,
    texts: string[],
    kind: "query" | "document",
    signal: AbortSignal,
    model = this.configuration.embedding_model,
  ) {
    const cloud = this.configuration.embedding_provider === 'google';
    if (cloud && !this.configuration.allow_cloud_embedding) fail('POLICY_DENIED', 'Enable cloud memory embeddings before using Gemini');
    const prompts = embeddingPrompts(model),
      prefix = kind === "query" ? prompts.query : prompts.document;
    const chunks = texts.map((t) => {
      const points = Array.from(t),
        out: string[] = [];
      for (let i = 0; i < points.length; i += 480)
        out.push(points.slice(i, i + 480).join(""));
      return out;
    });
    const flat = chunks.flat(),
      vectors: number[][] = [];
    for (let i = 0; i < flat.length; i += 16) {
      const result = cloud ? { embeddings: await googleEmbeddings({ key: () => this.credentials.key('google') }, model, flat.slice(i, i + 16), kind, signal) } : await ollamaJson(
        host,
        "embed",
        {
          model,
          input: flat.slice(i, i + 16).map((t) => prefix + t),
          truncate: false,
          keep_alive: "5m",
        },
        signal,
      );
      if (
        !Array.isArray(result.embeddings) ||
        result.embeddings.length !== flat.slice(i, i + 16).length
      )
        fail("BACKEND_UNAVAILABLE", "Embedding response count mismatch");
      for (const v of result.embeddings) {
        if (
          !Array.isArray(v) ||
          !v.length ||
          v.length > 16384 ||
          v.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n))
        )
          fail("BACKEND_UNAVAILABLE", "Invalid embedding");
        const norm = Math.hypot(...v);
        if (!norm) fail("BACKEND_UNAVAILABLE", "Empty embedding");
        vectors.push(v.map((n) => n / norm));
      }
    }
    if (!vectors.length || vectors.some((v) => v.length !== vectors[0].length))
      fail("BACKEND_UNAVAILABLE", "Inconsistent embedding dimensions");
    let at = 0;
    return chunks.map((parts) => {
      const sum = Array(vectors[0].length).fill(0);
      for (const part of parts) {
        const v = vectors[at++];
        v.forEach((n, i) => (sum[i] += n * Array.from(part).length));
      }
      const norm = Math.hypot(...sum);
      return sum.map((n) => n / norm);
    });
  }
  fingerprint(identity: { key: string }, dimension: number) {
    return createHash("sha256")
      .update(identity.key + ":" + dimension)
      .digest("hex");
  }
  async vectorRepo(fingerprint: string, dimension: number, signal?: AbortSignal) {
    let repo = this.vectors.get(fingerprint);
    if (!repo) {
      repo = new QdrantVectorRepository({
        endpoint: process.env.CERE_QDRANT_URL || "http://127.0.0.1:6333",
        apiKey: await this.secret("qdrant"),
        collectionPrefix: "cere_" + fingerprint.slice(0, 12),
        dimension,
        distance: "Cosine",
        requestTimeoutMs: 1000,
      });
      await repo.initialize(signal);
      await this.canonical.call("embedding_space", { fingerprint, dimension }, signal);
      this.vectors.set(fingerprint, repo);
    }
    return repo;
  }
  async secret(kind: string) {
    const path = process.env.CERE_MEMORY_CREDENTIALS_FILE;
    if (path) {
      const { stat } = await import("node:fs/promises");
      const s = await stat(path);
      if (s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0)
        fail("POLICY_DENIED", "Memory credentials file must be private");
      const values = JSON.parse(await readFile(path, "utf8"));
      return String(values[kind] || "");
    }
    return kind === "graph"
      ? process.env.CERE_NEO4J_PASSWORD || ""
      : process.env.CERE_QDRANT_API_KEY || "";
  }
  async graphRepo() {
    if (!this.graph) {
      this.graph = new Neo4jGraphRepository({
        uri: process.env.CERE_NEO4J_URI || "bolt://127.0.0.1:7687",
        username: process.env.CERE_NEO4J_USER || "neo4j",
        password: await this.secret("graph"),
        connectionTimeoutMs: 1000,
        maxTransactionRetryTimeMs: 0,
      });
      try {
        await this.graph.initialize();
      } catch (e) {
        await this.graph.close();
        this.graph = undefined;
        throw e;
      }
    }
    return this.graph;
  }
  /** One projection job; true when a job was applied, false when none was due or the backend failed. */
  async project(backend: "graph" | "vector"): Promise<boolean> {
    const job = await this.canonical.call("claim_job", { backend });
    if (!job) return false;
    return this.projectJob(backend, job);
  }
  async projectJob(backend: "graph" | "vector", job: Row): Promise<boolean> {
    try {
      const data = await this.canonical.call("projection_data", { id: job.id });
      if (backend === "graph") {
        const { artifacts, owner_id, ...mutation } = data;
        const graph = await this.graphRepo();
        await graph.apply({ ...mutation, generation: Number(data.generation) });
        if (data.deletedIds.length)
          await graph.eraseAllGenerations(data.deletedIds, data.erasureEpoch);
      } else {
        const signal = AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(15000),
        ]);
        // Physical purge needs only Qdrant and the persisted embedding spaces; it never
        // waits on an embedding model. The job is acknowledged only after every
        // generation's deletion and every publication in it succeeded.
        if (data.deletedIds.length) {
          for (const space of await this.canonical.call("embedding_spaces"))
            await this.vectorRepo(space.fingerprint, space.dimension, signal);
          for (const repo of this.vectors.values())
            await repo.deleteByArtifacts(data.deletedIds, data.erasureEpoch, signal);
        }
        const byHost = new Map<string, Row[]>();
        for (const artifact of data.artifacts) {
          if (this.configuration.embedding_provider === 'google' && artifact.sensitivity !== 'cloud_allowed') continue;
          const host = artifact.embedding_host || this.configuration.host;
          const group = byHost.get(host) || [];
          group.push(artifact);
          byHost.set(host, group);
        }
        // A projection job can contain many artifacts after rebuild. Probe a route once
        // per host and embed bounded batches instead of issuing one model request per row.
        for (const [host, artifacts] of byHost) {
          const identity = await this.identity(host, signal);
          for (let offset = 0; offset < artifacts.length; offset += 64) {
            const batch = artifacts.slice(offset, offset + 64);
            const vectors = await this.embed(
              host,
              batch.map((artifact) => artifact.text),
              "document",
              signal,
            );
            for (let index = 0; index < batch.length; index++) {
              const artifact = batch[index],
                vector = vectors[index],
                fingerprint = this.fingerprint(identity, vector.length),
                generation = Number(data.generation),
                point = pointId(
                  artifact.id,
                  artifact.content_revision,
                  fingerprint,
                  generation,
                ),
                repo = await this.vectorRepo(fingerprint, vector.length, signal),
                record = {
                  artifact_id: artifact.id,
                  content_revision: artifact.content_revision,
                  erasure_epoch: artifact.erasure_epoch,
                  fingerprint,
                  generation: data.generation,
                  point_id: point,
                  vector,
                },
                metadata: VectorArtifactMetadata = {
                  ownerId: data.owner_id,
                  scopeId: artifact.scope_id,
                  artifactKind: artifact.kind,
                  artifactId: artifact.id,
                  contentRevision: artifact.content_revision,
                  embeddingFingerprint: fingerprint,
                  generation,
                  sensitivity: artifact.sensitivity,
                  validFromUs: null,
                  validToUs: null,
                  sourceGeneration: artifact.source_generation,
                  erasureEpoch: data.erasureEpoch,
                  expiresAtUs: artifact.expires_us,
                };
              // Recheck canonical eligibility immediately before the remote write.
              await this.canonical.call("embedding_save", record);
              await repo.publish({ pointId: point, vector, metadata });
              try {
                // A changed/erased artifact cannot leave a usable late point behind.
                await this.canonical.call("embedding_save", record);
              } catch (e) {
                await repo.retire([point]);
                throw e;
              }
            }
          }
        }
      }
      await this.canonical.call("finish_job", { id: job.id });
      return true;
    } catch {
      await this.canonical.call("finish_job", {
        id: job.id,
        error: "BACKEND_UNAVAILABLE",
      });
      return false;
    }
  }
  /**
   * M09: what switching the embedding model would change, measured before it is applied. Each model's
   * vectors live in their own fingerprinted space; nothing is mixed, and the old space is kept.
   */
  async embeddingImpact(host: string, candidate: string, signal: AbortSignal) {
    const counts = await this.canonical.call("embedding_impact", {}, signal);
    const describe = async (model: string) => {
      const identity = await this.identity(host, signal, model), [probe] = await this.embed(host, ["Cere memory embedding probe"], "document", signal, model);
      const fingerprint = this.fingerprint(identity, probe.length);
      return { model, fingerprint, dimension: probe.length, records: counts.spaces.find((space: Row) => space.fingerprint === fingerprint)?.records || 0 };
    };
    let current: Row;
    try { current = await describe(this.configuration.embedding_model); } catch (error: any) { signal.throwIfAborted(); current = { model: this.configuration.embedding_model, error: String(error?.message || error).slice(0, 300) }; }
    const next = await describe(candidate);
    return { artifacts: counts.artifacts, current, next, unchanged: current.fingerprint === next.fingerprint, missing: Math.max(0, counts.artifacts - next.records),
      spaces: counts.spaces.length };
  }
  /** The configured model's embedding space on one server, measured again after five minutes. */
  async space(host: string, signal: AbortSignal) {
    const model = this.configuration.embedding_model, cached = this.spaces.get(host);
    if (cached && cached.model === model && Date.now() - cached.at < 300000) return cached;
    const identity = await this.identity(host, signal);
    const [probe] = await this.embed(host, ["Cere memory embedding probe"], "document", signal);
    const space = { model, at: Date.now(), dimension: probe.length, fingerprint: this.fingerprint(identity, probe.length) };
    this.spaces.set(host, space);
    return space;
  }
  /**
   * Embeds stored memories that have no vector in the configured server's current space, a small
   * batch per idle tick. Semantic recall then covers the whole store without a vector projection,
   * and a change of embedding model or prompts re-embeds it in the background. Never throws: a
   * failure is reported in health and retried a minute later.
   */
  async embedBacklog(): Promise<boolean> {
    if (Date.now() < this.embeddingRetryAt) return false;
    const host = ollamaHost(this.configuration.host),
      signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)]);
    try {
      const space = await this.space(host, signal);
      const batch: Row[] = await this.canonical.call("vector_backlog", { host, fingerprint: space.fingerprint, limit: 16, cloud: this.configuration.embedding_provider === 'google' });
      if (!batch.length) return false;
      const vectors = await this.embed(host, batch.map((a) => a.text), "document", signal);
      for (const [index, a] of batch.entries()) {
        if (vectors[index].length !== space.dimension) fail("BACKEND_UNAVAILABLE", "Embedding dimension changed");
        // A memory changed or forgotten meanwhile is skipped; the backlog offers its new revision.
        await this.canonical
          .call("embedding_save", {
            artifact_id: a.id,
            content_revision: a.content_revision,
            erasure_epoch: a.erasure_epoch,
            fingerprint: space.fingerprint,
            generation: "1",
            point_id: pointId(a.id, a.content_revision, space.fingerprint, 1),
            vector: vectors[index],
          })
          .catch((error: any) => {
            if (error?.code !== "SOURCE_CHANGED") throw error;
          });
      }
      this.embeddingError = "";
      return true;
    } catch (error: any) {
      this.embeddingError = String(error?.code || "EMBEDDING_UNAVAILABLE");
      this.embeddingRetryAt = Date.now() + 60000;
      this.spaces.delete(host);
      return false;
    }
  }
  async extraction() {
    if (!this.configuration.extraction_model && !this.reviewSettings.profile.overrides.extract) return;
    const run = await this.canonical.call("extraction_next");
    if (!run) return;
    try {
      const extractionHost=run.embedding_host||this.configuration.host;
      if(this.extractor instanceof OllamaExtractionAdapter && this.extractor.config.endpoint!==extractionHost)this.extractor=undefined;
      const provider = this.configuration.extraction_provider || 'ollama';
      const override=this.reviewSettings.profile.overrides.extract;
      if(override)this.extractor=new RoutedExtractionAdapter(this.review.router,override,this.configuration.allow_cloud_extraction);
      this.extractor ??= provider !== 'ollama' ? new ApiExtractionAdapter({ provider, model: this.configuration.extraction_model, allowCloud: this.configuration.allow_cloud_extraction }, { key: () => this.credentials.key(provider) }) : new OllamaExtractionAdapter({
        endpoint: extractionHost,
        model: this.configuration.extraction_model,
        allowCloud: this.configuration.allow_cloud_extraction,
        timeoutMs: 45000,
        probeTimeoutMs: 30000,
      });
      const chunk=extractionChunk(run.text,run.covered_codepoints||0);
      const fence=override?AbortSignal.any([this.controller.signal,this.reviewController.signal]):this.controller.signal;
      const result = await this.extractor.extract(
        {
          sourceRecordId: run.observation_id,
          sourceRevision: run.source_revision,
          sourceRole: run.role,
          modelRoute: run.sensitivity,
          text: chunk.text,
        },
        fence,
      );
      const proposals=extractionProposals(result,run.observation_id);
      for(const proposal of proposals){
        proposal.witness=relocateWitness(run.text,chunk,proposal.witness);
        if(proposal.additional_witnesses)proposal.additional_witnesses=proposal.additional_witnesses.map((w:any)=>relocateWitness(run.text,chunk,w));
      }
      if(result.taskRoute)await this.review.router.recheck(result.taskRoute,fence);
      fence.throwIfAborted();
      await this.canonical.call('apply_extraction',{id:run.id,proposals,coverage:{start:chunk.start,end:chunk.end,total:chunk.total},
        identity:{model:result.model,digest:result.modelDigest,endpoint:result.endpointClass,...(result.taskRoute?{route:result.taskRoute.fingerprint,connection:result.taskRoute.connectionRef,output_mode:result.outputMode}:{})},
        prompt_version:result.promptVersion,parser_version:result.parserVersion},fence);
    } catch (error) {
      // Route and consent denials are terminal until configuration changes; they are not outages.
      const denied = error instanceof ExtractionPolicyError ? error.code : ['LOCAL_ONLY_ROUTE','CLOUD_TASK_DISABLED','UNKNOWN_PROCESSING'].includes((error as any)?.code)?(error as any).code:undefined;
      await this.canonical
        .call("extraction_result", denied ? { id: run.id, denied } : {
          id: run.id,
          error: "MODEL_UNAVAILABLE_OR_INVALID",
        })
        .catch(() => {});
      this.lastError = denied ? "EXTRACTION_DENIED" : "EXTRACTION_RETRYABLE";
    }
  }
  // Housekeeping owns its own timer slot: projection timeouts and model loads
  // cannot keep an authorized review grace sweep waiting behind inference.
  scheduleRetention(){
    if(this.retentionWork||Date.now()-this.lastMaintenance<60000)return;
    this.lastMaintenance=Date.now();
    this.retentionWork=this.canonical.call('maintenance').then(()=>{this.maintenanceError='';},e=>{
      this.maintenanceError=e.code||'MAINTENANCE_FAILED';
    }).finally(()=>{this.retentionWork=undefined;});
  }
  scheduleReview(){
    const pf=this.reviewSettings.profile;
    if(this.reviewWork||this.foreground||pf.mode==='off')return;
    const generation=this.reviewController.signal;
    const guard=AbortSignal.any([generation,this.controller.signal]);
    this.reviewWork=(async()=>{
      if(Date.now()>=this.nextScan){
        this.nextScan=Date.now()+30000;
        await this.canonical.call('curation_scan',{},guard);
      }
      const summaryTurn=pf.consolidation&&pf.mode==='automatic'&&this.workRound%4===0;
      if(summaryTurn&&await this.review.synthesize(this.reviewSettings,guard))return;
      await this.review.process(guard);
    })().catch(e=>{if(!guard.aborted)this.lastError=errorCode(e);}).finally(()=>{this.reviewWork=undefined;});
  }
  static readonly projectionBatch = 50;
  static readonly projectionBudgetMs = 400;
  async maintain() {
    if(!this.recoveryFrozen&&!this.closed&&this.configuration.enabled&&!this.configuration.paused)this.scheduleRetention();
    if (
      this.busy ||
      this.recoveryFrozen ||
      this.closed ||
      !this.configuration.enabled ||
      this.configuration.paused ||
      this.foreground
    )
      return;
    this.busy = true;
    try {
      // A bounded batch per tick: a backlog drains in minutes instead of one job per second,
      // and a backend that fails or runs dry ends the batch early.
      const deadline = Date.now() + MemoryService.projectionBudgetMs;
      for (let n = 0; n < MemoryService.projectionBatch && Date.now() < deadline && !this.foreground && !this.closed; n++) {
        const applied = await Promise.allSettled([this.project("graph"), this.project("vector")]);
        if (!applied.some((result) => result.status === "fulfilled" && result.value === true)) break;
      }
      if(!this.foreground){
        this.workRound++;
        if(this.reviewSettings.profile.mode!=='off' && this.workRound%2===0)this.scheduleReview();
        else if(!this.reviewWork)await this.extraction();
        if(!this.reviewWork)await this.embedBacklog();
      }
      if (!this.foreground && !this.vectorsPacked)
        this.vectorsPacked = (await this.canonical.call("vector_upgrade")).upgraded === 0;

    } catch (error: any) {
      // A tick runs from a timer; a rejection here would end the broker. A stopped or restarted
      // worker, or expiry that ran out of budget, is retried by the next tick.
      this.maintenanceError = String(error?.code || "MAINTENANCE_FAILED");
    } finally {
      this.busy = false;
    }
  }
  /** Reserve the current memory profile before recovery starts reading or replacing it. */
  async freezeForRecovery(){
    if(this.busy||this.reviewWork||this.retentionWork)throw new Error('Wait for memory maintenance to finish before restoring');
    this.recoveryFrozen=true;this.collectorGeneration++;
    this.controller.abort(new Error('Memory paused for recovery'));
    await this.collectorRpc?.close();this.collectorRpc=undefined;
    for(const collector of this.collectors)await collector.stop();this.collectors=[];
  }
  async resumeAfterRecovery(){
    if(!this.recoveryFrozen)return;
    this.recoveryFrozen=false;this.controller=new AbortController();await this.startCollectors();
  }
  async retrieve(p: Row, signal?: AbortSignal, deep=false) {
    const time = performance.now(),
      policy = await this.canonical.call("policy_get"),
      deadline = deep?this.reviewSettings.profile.deepRecallMs:policy.policy.deadline_ms;
    const guard = AbortSignal.any([
      ...(signal ? [signal] : []),
      this.controller.signal,
      AbortSignal.timeout(deadline),
    ]);
    let semantic: Row[] = [],
      coverage: string[] = [],
      semanticFloor: number | null = null;
    const {host: _host,...seedQuery}=p;
    // Inherited scopes are authorized for every retrieval route, not only lexical recall.
    const scopeIds: string[] = await this.canonical.call("effective_scopes", { scope_id: p.scope_id }, guard);
    const graphPromise=(async()=>{
      if(!this.graph)return [];
      const seedPacket=await this.canonical.call('retrieve',seedQuery,guard),seeds=[...new Set<string>(seedPacket.assertions.flatMap((a:Row)=>[a.subject_id,a.object_entity_id].filter(Boolean)))];
      if(!seeds.length)return [];
      const projection=seedPacket.snapshot.projections.find((v:Row)=>v.backend==='graph');
      const expanded=await this.graph.expand({seedIds:seeds,generation:Number(projection?.generation||1),scopeIds,depth:3,deadline:guard});
      return this.canonical.call('graph_pointers',{scope_id:p.scope_id,seeds,nodes:expanded.nodes,edges:expanded.edges,known_revision:seedQuery.known_revision,world_at_us:seedQuery.world_at_us,model_route:seedQuery.model_route});
    })().catch(()=>{coverage.push('graph_degraded');return [];});
    try {
      const host = p.host || this.configuration.host,
        identity = await this.identity(host, guard),
        [vector] = await this.embed(host, [p.text], "query", guard),
        fingerprint = this.fingerprint(identity, vector.length);
      const pending = await this.canonical.call("pending_artifacts", {
        scope_id: p.scope_id,
        fingerprint, cloud: this.configuration.embedding_provider === 'google',
      }, guard);
      if (pending.length) {
        const vectors = await this.embed(
          host,
          pending.map((a: Row) => a.text),
          "document",
          guard,
        );
        for (let i = 0; i < pending.length; i++) {
          const a = pending[i];
          if (vectors[i].length !== vector.length)
            throw new Error("Embedding dimension changed");
          await this.canonical.call("embedding_save", {
            artifact_id: a.id,
            content_revision: a.content_revision,
            erasure_epoch: a.erasure_epoch,
            fingerprint,
            generation: "1",
            point_id: pointId(a.id, a.content_revision, fingerprint, 1),
            vector: vectors[i],
          });
        }
      }
      // Preserve the durable overlay before optional projection setup/query can
      // exhaust the deadline. An unavailable projection must not discard local hits.
      const overlay = await this.canonical.call("embedding_search", {
        scope_id: p.scope_id,
        fingerprint,
        vector,
      }, guard);
      semantic = overlay.hits;
      // Automatic recall keeps a semantic match only above this query's own similarity floor.
      if (p.relevance_floor === true) semanticFloor = overlay.floor;
      try {
        const health = await this.canonical.call("health", {}, guard);
        // Collection preparation shares the retrieval deadline; expiry degrades to canonical recall.
        const repo = await this.vectorRepo(fingerprint, vector.length, guard);
        const generation = Number(
          health.projections.find((b: Row) => b.backend === "vector")
            ?.generation || 1,
        );
        const hits = await repo.query({
          vector,
          ownerId: health.owner_id,
          scopeIds,
          embeddingFingerprint: fingerprint,
          generation,
          currentErasureEpoch: health.erasure_epoch,
          nowUs: Date.now() * 1000,
          deadline: guard,
        });
        semantic = [...hits.map((h) => ({ ...h.metadata, score: h.score })), ...semantic];
      } catch {
        coverage.push("semantic_projection_unavailable");
      }
    } catch (error: any) {
      signal?.throwIfAborted();
      coverage.push(error?.code === "POLICY_DENIED" ? "semantic_route_denied" : "semantic_degraded");
    }
    const { host, ...query } = p;
    const graphIds=await graphPromise;
    // Setup that outlived the deadline must not keep the foreground waiting on stragglers.
    if (guard.aborted && !signal?.aborted && !coverage.includes("deadline_partial")) coverage.push("deadline_partial");
    const settings=this.reviewSettings,rank=settings.profile.mode==='automatic'&&settings.profile.rerank&&!!settings.profile.reviewModel;
    let result = await this.canonical.call(
      "retrieve",
      {
        ...query,
        review_pool:rank,
        semantic_ids: semantic,
        graph_ids:graphIds,
        backend_coverage: coverage,
        ...(semanticFloor !== null ? { semantic_floor: semanticFloor } : {}),
        deadline_ms: Math.max(25, deadline - (performance.now() - time)),
      },
      signal,
    );
    const rankingStarted=performance.now();
    const prior=settings.profile.mode==='automatic'&&settings.profile.valuePrior?'assessed-value-x0.10-v1':undefined;
    result.metrics.ranking={strategy:'baseline',formula:'rrf-v1',prior,latency_ms:0};
    if(rank&&result.review_pool?.length>1&&!guard.aborted){
      let strategy='baseline',ordered:string[]=[],fingerprint:string|undefined,usage;
      try{
        const ranked=await this.review.rerank(query,result,settings,policy.policy.allow_cloud_memory===true && p.model_route==='cloud',
          AbortSignal.any([guard,AbortSignal.timeout(deep?deadline:settings.profile.rerankMs),this.reviewController.signal]));
        if(ranked){ordered=ranked.ids;fingerprint=ranked.route;usage=ranked.usage;strategy='model';}
      }catch(e){strategy='fallback_'+errorCode(e);}
      // Reranking never grants access. Re-run baseline hydration even after failure
      // so a concurrent forget, correction or route change cannot reuse stale text.
      result=await this.canonical.call('retrieve',{...query,semantic_ids:semantic,graph_ids:graphIds,backend_coverage:coverage,
        ...(semanticFloor!==null?{semantic_floor:semanticFloor}:{}),review_order:ordered,review_revision:settings.revision,deadline_ms:Math.max(25,deadline-(performance.now()-time))},signal);
      result.metrics.ranking={strategy,formula:'rrf-v1',prior,route:fingerprint,usage,latency_ms:Math.round(performance.now()-rankingStarted)};
    }
    delete result.review_pool;
    const epochs = await this.canonical.call("health");
    if (
      epochs.policy_epoch !== result.snapshot.policy_epoch ||
      epochs.erasure_epoch !== result.snapshot.erasure_epoch
    )
      fail("SOURCE_CHANGED", "Memory changed during retrieval");
    await this.canonical.call("validate_packet", {
      snapshot_revision: result.snapshot.revision,
      policy_epoch: result.snapshot.policy_epoch,
      erasure_epoch: result.snapshot.erasure_epoch,
      record_ids: [
        ...result.assertions.map((a: Row) => a.version_id),
        ...result.conflicts.map((a: Row) => a.version_id),
        ...result.results.map((a: Row) => a.artifact_id),
      ],
    });
    result.workspace = p.model_route === 'cloud' && !policy.policy.allow_cloud_memory ? {generation:0,current:{freshness:'unknown'},unknown:['cloud_workspace_denied'],observations:[]} : this.workspace();
    result.snapshot.live_generation = result.workspace.generation;
    return result;
  }
  /** Live state filtered against the current collector policy at every read. */
  liveSnapshot() {
    const snapshot = this.live.snapshot();
    return {
      generation: snapshot.generation,
      observations: snapshot.observations.flatMap((o) => {
        const kept = this.permitted(o);
        return kept ? [kept] : [];
      }),
    };
  }
  workspace() {
    const snapshot = this.liveSnapshot(),
      fresh = snapshot.observations.filter((o) => o.freshness === "fresh");
    const focus = fresh.find((o) => o.kind === "WINDOW_FOCUS"),
      address = focus?.properties.address;
    const window = address
      ? fresh.find(
          (o) =>
            o.source === "hyprland" &&
            o.properties.address === address &&
            !o.kind.endsWith("CLOSED"),
        )
      : undefined;
    const panes = fresh.filter(
      (o) =>
        o.kind === "TERMINAL_PANE" &&
        o.properties.osWindowFocused &&
        o.properties.tabActive &&
        o.properties.paneFocused,
    );
    let pane =
      window &&
      /kitty/i.test(String(window.properties.appClass)) &&
      panes.length === 1
        ? panes[0]
        : undefined;
    const shells = pane
      ? fresh.filter(
          (o) =>
            o.kind === "SHELL_STATE" &&
            o.properties.kittyPaneId === pane!.properties.paneId,
        )
      : [];
    const shell = shells.length === 1 ? shells[0] : undefined,
      cwd = shell?.properties.cwd || pane?.properties.cwd;
    const checkouts = cwd
      ? fresh.filter(
          (o) =>
            o.source === "repository" &&
            typeof o.properties.checkoutRoot === "string" &&
            (() => {
              const delta = relative(o.properties.checkoutRoot, String(cwd));
              return (
                delta === "" || (!delta.startsWith("..") && !isAbsolute(delta))
              );
            })(),
        )
      : [];
    return {
      ...snapshot,
      current: {
        window: window || null,
        pane: pane || null,
        shell: shell || null,
        cwd: cwd || null,
        checkout: checkouts.length === 1 ? checkouts[0] : null,
        freshness: window ? "fresh" : "unknown",
      },
      unknown: [
        ...(!window ? ["focused_window"] : []),
        ...(!pane ? ["terminal_pane"] : []),
        ...(!cwd ? ["working_directory"] : []),
        ...(checkouts.length !== 1 ? ["verified_checkout"] : []),
      ],
    };
  }
  async call(method: string, p: Row = {}, signal?: AbortSignal): Promise<any> {
    if(method==='curation_cancel'){
      const result=await this.canonical.call(method,p,signal);
      if(result.cancelled)this.review.cancel(p.job_id);
      return result;
    }
    if(method==='curation_configure'){
      const profile=profileSchema.parse({...this.reviewSettings.profile,...p.profile});
      const settings=await this.canonical.call(method,{...p,manifest:this.routeManifest(profile)},signal);
      this.reviewController.abort();this.reviewController=new AbortController();
      this.reviewSettings=settings;this.nextScan=0;this.extractor=undefined;
      await this.canonical.call('extraction_reconcile',{include_denied:true});
      return settings;
    }
    if(method==='models_probe'){
      const binding=bindingSchema.parse(p.binding||this.reviewSettings.profile.reviewModel);
      const settings=this.reviewSettings,guard=AbortSignal.any([AbortSignal.timeout(settings.profile.timeoutMs),this.reviewController.signal,...(signal?[signal]:[])]);
      const probe=await this.review.router.probe(binding,'cloud_allowed',settings.profile.allowCloudCuration,guard,
        async(route,input)=>{await this.canonical.call('curation_reserve',{task:'probe',config_revision:settings.revision,input,output:route.maxOutputTokens,route:route.fingerprint},guard);});
      await this.canonical.call('curation_evaluation_record',{fingerprint:probe.route.fingerprint,dataset:'capability-probe',result:{...probe,qualified:false}});
      return probe;
    }
    if(method==='models_evaluate')return this.review.evaluate(p,this.reviewSettings,AbortSignal.any([this.reviewController.signal,...(signal?[signal]:[])]));
    if(method==='curation_apply'){
      const producer=await this.canonical.call('curation_producer',p,signal);
      for(const identity of Object.values(producer))await this.review.router.recheck(identity as any,signal);
    }
    if(method==='curation_run'&&!p.dry_run && (!this.configuration.enabled||this.configuration.paused))fail('POLICY_DENIED','Memory activity is paused');
    if (method === "configure") return this.configure(p as MemoryConfiguration);
    if (method === "retrieve" || method === "deep_recall") return this.retrieve(p,signal,method==="deep_recall");
    if (method === "workspace") return this.workspace();
    if (method === "embedding_impact_check") return this.embeddingImpact(p.host, p.model, signal!);
    if (method === "foreground") {
      if(p.active){this.reviewController.abort();this.reviewController=new AbortController();}
      this.foreground = Math.max(0, this.foreground + (p.active ? 1 : -1));
      return { foreground: this.foreground };
    }
    if (method === "health" || method === "doctor")
      return {
        ...(await this.canonical.call("health")),
        curation:{mode:this.reviewSettings.profile.mode,revision:this.reviewSettings.revision,model:this.reviewSettings.profile.reviewModel?.modelId,
          allow_cloud_curation:this.reviewSettings.profile.allowCloudCuration,busy:!!this.reviewWork},
        extraction_model: this.reviewSettings.profile.overrides.extract?.modelId||this.configuration.extraction_model,
        extraction_provider: this.configuration.extraction_provider || 'ollama',
        embedding_model: this.configuration.embedding_model,
        embedding_provider: this.configuration.embedding_provider || 'ollama',
        extraction_error: this.lastError,
        embedding_error: this.embeddingError,
        maintenance_error: this.maintenanceError,
        workspace: this.liveSnapshot(),
        collectors: this.collectors.length,
      };
    const result = await this.canonical.call(method, p, signal);
    if (method === "policy_update") await this.startCollectors();
    return result;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.reviewController.abort();
    await this.collectorRpc?.close();
    this.controller.abort(new Error("Memory service closed"));
    for (const c of this.collectors) await c.stop();
    while (this.busy) await new Promise((r) => setTimeout(r, 10));
    await Promise.allSettled([
      this.graph?.close(),
      ...[...this.vectors.values()].map((v) => v.close()),
    ]);
    await Promise.allSettled([this.reviewWork,this.retentionWork]);
    await this.canonical.close();
  }
}
