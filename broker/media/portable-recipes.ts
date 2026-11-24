/** Portable image recipe envelope. Imported metadata is never trusted as authorization or capability evidence. */
import { createHash } from 'node:crypto';
import canonicalizeModule from 'canonicalize';
import type { ProcessingRoute } from '../tools/contracts.ts';
import type { ImageOperation, ImageReferenceRole } from './contracts.ts';

export const portableRecipeLimits = { jsonBytes: 140 * 1024 * 1024, assetBytes: 100 * 1024 * 1024, aggregateAssetBytes: 100 * 1024 * 1024, inputs: 16 };
export type PortableInput = {
  inputId: string;
  role: ImageReferenceRole | 'mask';
  artifactId: string;
  versionId: string;
  sha256: string;
  mime: string;
  name: string;
  bytes: number;
  asset?: { encoding: 'base64'; data: string };
};
export type PortableImageRecipeV1 = {
  kind: 'pal.image-recipe';
  schema: 1;
  digest: string;
  exportedAt: number;
  request: {
    operation: ImageOperation;
    prompt: string;
    negativePrompt?: string;
    size?: string;
    aspectRatio?: string;
    imageSize?: string;
    format: 'png' | 'jpeg' | 'webp';
    background?: 'transparent' | 'opaque' | 'auto';
    quality?: string;
    count: number;
    seed?: number;
    protectOutside?: boolean;
    partials?: boolean;
    maskFeather?: number;
  };
  inputs: PortableInput[];
  backend: { kind: 'openai' | 'google' | 'xai' | 'azure_openai' | 'openrouter' | 'comfyui'; model: string; route: ProcessingRoute; billed: boolean; cost: { kind: 'provider-account' | 'own-server'; note: string; amount?: number; currency?: string; source?: 'configured estimate' } };
  output: { destination: 'conversation-artifacts'; count: number; format: 'png' | 'jpeg' | 'webp' };
  workflow?: { name: string; graph: Record<string, unknown>; sourceDigest: string };
};
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonicalize = canonicalizeModule as unknown as (value: unknown) => string | undefined;
const canonical = (value: unknown) => canonicalize(value) || '';
export const portableDigest = (value: Omit<PortableImageRecipeV1, 'digest'>) => sha256(canonical(value));

export function parsePortableRecipe(value: unknown): PortableImageRecipeV1 {
  const text = typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : JSON.stringify(value);
  if (Buffer.byteLength(text) > portableRecipeLimits.jsonBytes) throw new Error('Image recipe files are limited to 140 MiB including embedded assets');
  let recipe: any; try { recipe = JSON.parse(text); } catch { throw new Error('This is not valid image recipe JSON'); }
  if (recipe?.kind !== 'pal.image-recipe' || recipe?.schema !== 1 || typeof recipe.digest !== 'string') throw new Error('This is not a PAL image recipe version 1');
  const { digest, ...unsigned } = recipe;
  if (digest !== portableDigest(unsigned)) throw new Error('The portable image recipe no longer matches its digest');
  if (!Array.isArray(recipe.inputs) || recipe.inputs.length > portableRecipeLimits.inputs + 1) throw new Error('A portable image recipe has too many inputs');
  let aggregate = 0; const ids = new Set<string>();
  for (const input of recipe.inputs) {
    if (!input || typeof input.inputId !== 'string' || !/^[a-z0-9-]{1,40}$/.test(input.inputId) || !/^[0-9a-f]{64}$/.test(input.sha256) || !Number.isInteger(input.bytes) || input.bytes < 0 || input.bytes > portableRecipeLimits.assetBytes) throw new Error('A portable image recipe input is invalid');
    if (ids.has(input.inputId)) throw new Error('A portable image recipe repeats an input ID'); ids.add(input.inputId);
    if (typeof input.name !== 'string' || input.name.length > 200 || typeof input.mime !== 'string' || input.mime.length > 100 || typeof input.artifactId !== 'string' || input.artifactId.length > 80 || typeof input.versionId !== 'string' || input.versionId.length > 80) throw new Error('A portable image recipe input label is invalid');
    if (!['target', 'edit-base', 'subject', 'composition', 'style', 'mask'].includes(input.role)) throw new Error('A portable image recipe has an unknown input role');
    if (input.asset) {
      if (input.asset.encoding !== 'base64' || typeof input.asset.data !== 'string') throw new Error('A portable image recipe asset is invalid');
      const bytes = Buffer.from(input.asset.data, 'base64'); aggregate += bytes.length;
      if (bytes.length !== input.bytes || sha256(bytes) !== input.sha256) throw new Error(`Embedded asset ${input.inputId} does not match its hash`);
    }
  }
  if (aggregate > portableRecipeLimits.aggregateAssetBytes) throw new Error('Embedded recipe assets exceed 100 MiB');
  if (!recipe.request || typeof recipe.request.prompt !== 'string' || !recipe.request.prompt.trim() || recipe.request.prompt.length > 8000 || !['generate', 'edit', 'masked-edit', 'extend', 'reference'].includes(recipe.request.operation)
    || !['png', 'jpeg', 'webp'].includes(recipe.request.format) || !Number.isInteger(recipe.request.count) || recipe.request.count < 1 || recipe.request.count > 4
    || !['openai', 'google', 'xai','azure_openai','openrouter', 'comfyui'].includes(recipe.backend?.kind)) throw new Error('The portable image recipe is incomplete or out of bounds');
  if (recipe.inputs.filter((input: any) => input.role === 'mask').length > 1 || recipe.inputs.filter((input: any) => input.role === 'target' || input.role === 'edit-base').length > 1) throw new Error('A portable image recipe has ambiguous target or mask inputs');
  return recipe;
}
