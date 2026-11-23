/** Durable image recipes. Replaying one creates a new operation; it never resumes the old operation. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { privateDir } from '../paths.ts';
import type { ProcessingRoute } from '../tools/contracts.ts';
import type { ImageRequest } from './contracts.ts';
import type { ComfyWorkflow } from './backends/comfyui.ts';

export type WorkflowDependencyCheck = { checkedAt: number; version: string; missingNodes: string[]; missingModels: string[] };
export type ImageRecipeV1 = {
  schema: 1;
  recipeId: string;
  digest: string;
  sessionId: string;
  createdAt: number;
  request: ImageRequest;
  backend: {
    connectionId: string;
    connectionRevision: number;
    kind: 'openai' | 'google' | 'comfyui';
    model: string;
    route: ProcessingRoute;
    origin?: string;
    serverRoute?: ProcessingRoute;
    targetedInterrupt?: boolean;
    billed: boolean;
    cost: { kind: 'provider-account' | 'own-server'; note: string; amount?: number; currency?: string; source?: 'configured estimate' };
  };
  output: { destination: 'conversation-artifacts'; count: number; format: ImageRequest['format'] };
  workflow?: {
    workflow: ComfyWorkflow;
    graph: Record<string, unknown>;
    snapshotDigest: string;
    dependencies: WorkflowDependencyCheck;
  };
};

export type ImageRecipeDraft = Omit<ImageRecipeV1, 'recipeId' | 'digest' | 'createdAt'>;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f-]{36}$/;
const asDraft = (recipe: ImageRecipeV1): ImageRecipeDraft => { const { digest: _digest, recipeId: _recipeId, createdAt: _createdAt, ...draft } = recipe; return draft; };

export class ImageRecipeStore {
  directory: string;
  constructor(storeDirectory: string) { this.directory = privateDir(join(storeDirectory, 'media', 'recipes')); }
  async ensure() { await mkdir(this.directory, { recursive: true }); }
  graphDigest(graph: unknown) { return sha256(JSON.stringify(graph)); }
  draftDigest(draft: ImageRecipeDraft) { return sha256(JSON.stringify(draft)); }
  async create(draft: ImageRecipeDraft): Promise<ImageRecipeV1> {
    const recipeId = randomUUID(), createdAt = Date.now();
    const record = { ...draft, recipeId, createdAt } as Omit<ImageRecipeV1, 'digest'>;
    const recipe: ImageRecipeV1 = { ...record, digest: this.draftDigest(draft) };
    const temporary = join(this.directory, `.${recipeId}.tmp`), target = join(this.directory, `${recipeId}.json`);
    await writeFile(temporary, JSON.stringify(recipe), { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
    return recipe;
  }
  async get(recipeId: unknown): Promise<ImageRecipeV1> {
    if (typeof recipeId !== 'string' || !uuid.test(recipeId)) throw new Error('Unknown image recipe');
    let recipe: ImageRecipeV1;
    try { recipe = JSON.parse(await readFile(join(this.directory, `${recipeId}.json`), 'utf8')); }
    catch { throw new Error('That image recipe is missing or unreadable'); }
    if (recipe?.schema !== 1 || recipe.recipeId !== recipeId || recipe.digest !== this.draftDigest(asDraft(recipe))) throw new Error('That image recipe no longer matches its record');
    if (recipe.workflow && recipe.workflow.snapshotDigest !== this.graphDigest(recipe.workflow.graph)) throw new Error('That image recipe’s workflow snapshot no longer matches its record');
    return recipe;
  }
  async remove(recipeId: string) { if (uuid.test(recipeId)) await rm(join(this.directory, `${recipeId}.json`), { force: true }); }
  async removeSession(sessionId: string) {
    for (const name of await readdir(this.directory).catch(() => [] as string[])) {
      if (!uuid.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) continue;
      try { const recipe = JSON.parse(await readFile(join(this.directory, name), 'utf8')); if (recipe.sessionId === sessionId) await rm(join(this.directory, name), { force: true }); } catch { /* recovery handles damaged files separately */ }
    }
  }
  async collectSessions(valid: Set<string>) {
    for (const name of await readdir(this.directory).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) { if (/^\.[0-9a-f-]{36}\.tmp$/.test(name)) await rm(join(this.directory, name), { force: true }); continue; }
      try { const recipe = JSON.parse(await readFile(join(this.directory, name), 'utf8')); if (typeof recipe.sessionId !== 'string' || !valid.has(recipe.sessionId)) await rm(join(this.directory, name), { force: true }); }
      catch { await rm(join(this.directory, name), { force: true }); }
    }
  }
}

/** Synchronous erasure hook for `working-erasure.ts`, whose transcript transaction is synchronous.
 * An affected recipe is removed rather than rewritten because changing prompt/input metadata would make
 * its digest and replay witness misleading. Unaffected recipes in the conversation remain usable. */
export function eraseImageRecipeCopies(storeDirectory: string, sessionId: string, matches: (text: string) => boolean) {
  const directory = join(storeDirectory, 'media', 'recipes');
  let names: string[]; try { names = readdirSync(directory); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    try {
      const text = readFileSync(path, 'utf8'), recipe = JSON.parse(text);
      if (recipe.sessionId === sessionId && matches(text)) unlinkSync(path);
    } catch { /* startup recovery removes malformed leftovers */ }
  }
}
