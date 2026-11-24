import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProviderUsage, providerTokens } from '../broker/provider-codecs/streaming.ts';
import { taskOutput } from '../broker/provider-completion.ts';

test('what a request read and wrote is counted whole, whichever way its provider counts', () => {
  // Claude counts what its cache held apart from the input; a delta that names only the output changes only that.
  assert.deepEqual(providerTokens({ input_tokens: 12, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 500, output_tokens: 80 }), { inputTokens: 40_512, outputTokens: 80 });
  assert.deepEqual(providerTokens({ output_tokens: 80 }), { inputTokens: undefined, outputTokens: 80 });
  // A gateway that already counts its cache in is not counted twice.
  assert.deepEqual(providerTokens({ prompt_tokens: 40_512, completion_tokens: 80, cache_read_input_tokens: 40_000 }), { inputTokens: 40_512, outputTokens: 80 });
  assert.deepEqual(providerTokens({ input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 9 }), { inputTokens: 100, outputTokens: 9 });
  // Gemini counts thinking, and what its own tools read, apart.
  assert.deepEqual(providerTokens({ promptTokenCount: 100, toolUsePromptTokenCount: 50, candidatesTokenCount: 20, thoughtsTokenCount: 300, cachedContentTokenCount: 10 }), { inputTokens: 150, outputTokens: 320 });
  assert.deepEqual(providerTokens({ promptTokenCount: 100, thoughtsTokenCount: 5 }), { inputTokens: 100, outputTokens: 5 });
  for (const odd of [undefined, null, 'x', {}, { input_tokens: -1, output_tokens: 1.5 }, { prompt_tokens: '12' }]) assert.deepEqual(Object.values(providerTokens(odd)).filter(value => value !== undefined), []);
});
test('the parts of the count are kept beside it', () => {
  const claude = normalizeProviderUsage({ input_tokens: 12, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0, output_tokens: 80, server_tool_use: { web_search_requests: 2 } }, 'Claude API')!;
  assert.deepEqual([claude.inputTokens, claude.cachedTokens, claude.outputTokens, claude.searchCalls], [40_012, 40_000, 80, 2]);
  const gemini = normalizeProviderUsage({ promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 300 }, 'Google AI API')!; assert.deepEqual([gemini.outputTokens, gemini.reasoningTokens], [320, 300]);
  assert.equal(normalizeProviderUsage({ prompt_tokens: 30, completion_tokens: 4, prompt_cache_hit_tokens: 20 }, 'DeepSeek')!.cachedTokens, 20);
  assert.equal(normalizeProviderUsage({ prompt_tokens: 'many' }, 'x'), undefined);
  assert.deepEqual(taskOutput({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'a' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 40 } }).usage, { inputTokens: 10, outputTokens: 42 });
});
