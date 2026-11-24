/** Stable, secret-free contract for PAL's optional local LiteLLM subprocess bridge. */
export const providerBridgeMethods = ['providerBridge.status', 'providerBridge.chat', 'providerBridge.embeddings', 'providerBridge.stop', 'providerBridge.runtime', 'providerBridge.install', 'providerBridge.remove', 'providerBridge.cancel'] as const;
export type ProviderBridgeMethod = typeof providerBridgeMethods[number];

export type BridgeBinding = { connectionId: string; connectionRevision: number };
export type BridgeMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; name?: string; toolCallId?: string;
  /** What an assistant message asked for, the reasoning it has to carry with that, and a person's pictures. */
  toolCalls?: { id: string; name: string; arguments: string }[]; state?: Record<string, unknown>; images?: { mime: string; data: string }[] };
export type BridgeChatRequest = BridgeBinding & {
  model: string;
  messages: BridgeMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: 'text' | 'json';
  tools?: Array<{ name: string; description?: string; parameters: Record<string, unknown> }>;
};
export type BridgeEmbeddingRequest = BridgeBinding & { model: string; input: string[]; dimensions?: number };
export type BridgeStatus = { available: boolean; running: boolean; version?: string; error?: string };

/** Secrets are resolved inside the broker and sent only over the account-isolated stdio channel. */
export type BridgeAccount = {
  id: string;
  revision: number;
  apiKey: () => string;
  baseUrl?: string;
};
