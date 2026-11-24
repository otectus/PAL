/** Stable broker RPC contract for account-bound, non-conversation inference. */
export const providerInferenceMethods = ['providerInference.run', 'providerInference.mistralOcr'] as const;
export type ProviderInferenceMethod = typeof providerInferenceMethods[number];

export const huggingFaceTasks = [
  'feature-extraction', 'sentence-similarity', 'text-classification', 'token-classification', 'zero-shot-classification',
  'question-answering', 'fill-mask', 'summarization', 'translation', 'text-generation',
  'table-question-answering',
  'image-classification', 'object-detection', 'image-segmentation', 'audio-classification', 'automatic-speech-recognition',
  'text-to-image', 'image-to-image', 'text-to-video', 'text-to-speech',
] as const;
export type HuggingFaceTask = typeof huggingFaceTasks[number];

export type InferenceBinding = { connectionId: string; connectionRevision: number };
export type BinaryInferenceInput = { mime: string; data: Buffer };
export type JsonInferenceInput = string | string[] | Record<string, unknown>;
export type HuggingFaceInferenceRequest = InferenceBinding & {
  task: HuggingFaceTask;
  model: string;
  inputs: JsonInferenceInput | BinaryInferenceInput | BinaryInferenceInput[];
  parameters?: Record<string, unknown>;
  /** Required for feature extraction so vector-space behavior is reproducible. */
  pooling?: 'none' | 'mean' | 'cls';
  normalize?: boolean;
};

export type HuggingFaceInferenceResult =
  | { kind: 'json'; task: HuggingFaceTask; model: string; servingProvider: 'hf-inference' | 'dedicated-endpoint'; output: unknown }
  | { kind: 'media'; task: HuggingFaceTask; model: string; servingProvider: 'hf-inference' | 'dedicated-endpoint'; mime: string; bytes: Buffer }
  | { kind: 'embeddings'; task: 'feature-extraction'; model: string; servingProvider: 'hf-inference' | 'dedicated-endpoint'; vectors: number[][]; dimension: number; pooling: 'none' | 'mean' | 'cls'; normalized: boolean };

export type MistralOcrRequest = InferenceBinding & {
  model?: string;
  file: { name: string; mime: string; bytes: Buffer };
  pages?: number[] | string;
  tableFormat?: 'markdown' | 'html';
  includeImages?: boolean;
  includeBlocks?: boolean;
  extractHeader?: boolean;
  extractFooter?: boolean;
  confidence?: 'word' | 'page' | 'block';
};
export type MistralOcrPage = {
  index: number;
  markdown: string;
  header?: string;
  footer?: string;
  dimensions?: { dpi?: number; width?: number; height?: number };
  images: Array<{ id: string; box?: { left: number; top: number; right: number; bottom: number }; mime?: string; data?: string }>;
  tables: unknown[];
  blocks: unknown[];
};
export type MistralOcrResult = {
  kind: 'mistral-ocr';
  model: string;
  source: { name: string; mime: string; bytes: number; sha256: string; originalFile: true };
  pages: MistralOcrPage[];
  documentAnnotation?: unknown;
  usage: { pagesProcessed?: number; documentBytes?: number };
};

export type ProviderInferenceRpcRequest =
  | ({ method: 'providerInference.run' } & Omit<HuggingFaceInferenceRequest, 'inputs'> & { inputs: JsonInferenceInput | { mime: string; base64: string } | Array<{ mime: string; base64: string }> })
  | ({ method: 'providerInference.mistralOcr' } & Omit<MistralOcrRequest, 'file'> & { file: { name: string; mime: string; base64: string } });

