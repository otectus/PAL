import test from 'node:test';
import assert from 'node:assert/strict';
import { apiProviders, providerIds, providerLabels, providerTraitSchemas, providerTraits } from '../broker/provider-catalog.ts';
import { apiProviderIds, getProviderDefinition, providerDefinitions, providerImportAliases, providerSupports, resolveProviderDialect, resolveProviderEndpoint, validateProviderOptions } from '../broker/provider-registry.ts';
import { normalizeProviderUsage, providerCitations } from '../broker/provider-codecs/streaming.ts';

test('the typed registry contains every dedicated PAL provider identity exactly once', () => {
  assert.deepEqual(apiProviders, [...apiProviderIds]);
  assert.deepEqual(apiProviders, ['openai','anthropic','google','azure_openai','deepseek','mistral','xai','perplexity','openrouter','huggingface','litellm','forge','edenai','compatible']);
  assert.equal(new Set(providerIds).size, providerIds.length);
  assert.equal(providerLabels.xai, 'Grok (xAI)');
  assert.equal(providerLabels.forge, 'TensorBlock Forge');
  for (const id of apiProviders) {
    const definition = getProviderDefinition(id);
    assert.equal(definition.id, id);
    assert.ok(definition.dialects.includes(definition.dialect));
    assert.ok(definition.variants.some(variant => variant.dialect === definition.dialect));
    assert.equal(providerTraits[id].kind, 'api');
    const wire=JSON.parse(JSON.stringify(providerTraits[id]));
    assert.deepEqual(wire.variants,definition.variants);assert.deepEqual(wire.optionsSchema,definition.optionsSchema);assert.deepEqual(wire.auth,definition.auth);
  }
  assert.equal(providerTraitSchemas.images.type, 'enum');
});

test('import aliases remain separate from stable PAL identities', () => {
  assert.equal(providerImportAliases.deepseek_api, 'deepseek');
  assert.equal(providerImportAliases.mistral_ai, 'mistral');
  assert.equal(providerImportAliases.x_ai, 'xai');
  assert.equal(providerImportAliases.open_router, 'openrouter');
  assert.equal(providerImportAliases.huggingface_api, 'huggingface');
  assert.equal(providerImportAliases.huggingface_router, 'huggingface');
  assert.equal(providerImportAliases.local_ai, 'compatible');
});

test('official defaults retain dedicated endpoints, dialects and explicit account-only endpoints', () => {
  assert.equal(resolveProviderEndpoint('xai'), 'https://api.x.ai/v1/');
  assert.equal(resolveProviderEndpoint('perplexity'), 'https://api.perplexity.ai/v1/');
  assert.equal(resolveProviderEndpoint('openrouter'), 'https://openrouter.ai/api/v1/');
  assert.equal(resolveProviderEndpoint('huggingface', {variant:'router'}), 'https://router.huggingface.co/v1/');
  assert.equal(resolveProviderEndpoint('forge'), 'https://api.forge.tensorblock.co/v1/');
  assert.equal(resolveProviderEndpoint('edenai'), 'https://api.edenai.run/v3/');
  assert.equal(resolveProviderEndpoint('azure_openai', {baseUrl:'https://fixture.openai.azure.com',variant:'v1'}), 'https://fixture.openai.azure.com/openai/v1/');
  assert.throws(() => resolveProviderEndpoint('azure_openai', {variant:'v1'}), /endpoint/);
  assert.throws(() => resolveProviderEndpoint('litellm'), /endpoint/);
  assert.equal(resolveProviderDialect('deepseek'), 'responses');
  assert.equal(resolveProviderDialect('deepseek', {variant:'chat'}), 'chat_completions');
  assert.equal(resolveProviderDialect('perplexity'), 'perplexity_agent');
});

test('provider option schemas validate and normalize without silently accepting vendor fields', () => {
  assert.deepEqual(validateProviderOptions('perplexity', {reasoningEffort:'xhigh',searchDomains:[' example.com ']}), {reasoningEffort:'xhigh',searchDomains:['example.com']});
  assert.throws(() => validateProviderOptions('perplexity', {background:true}), /does not support option/i);
  assert.deepEqual(validateProviderOptions('openrouter', {allowedProviders:['anthropic'],allowFallbacks:false,zeroDataRetention:true}), {allowedProviders:['anthropic'],allowFallbacks:false,zeroDataRetention:true});
  assert.deepEqual(validateProviderOptions('edenai', {qualityCost:7,allowFallbacks:true}), {qualityCost:7,allowFallbacks:true});
  assert.throws(() => validateProviderOptions('xai', {reasoningEffort:'ultra'}), /supported reasoning effort/i);
  assert.throws(() => validateProviderOptions('openai', {top_k:4}), /does not support option/);
  assert.throws(() => validateProviderOptions('edenai', {qualityCost:11}), /range/);
  assert.equal(providerSupports('xai','native-search'), true);
  assert.equal(providerSupports('openrouter','images'), 'model');
  assert.equal(providerSupports('openrouter','images',{modelCapabilities:['images']}), true);
  assert.equal(providerSupports('compatible','local-tools',{connectionCapabilities:[]}), false);
  assert.equal(providerSupports('compatible','local-tools'), 'connection');
  assert.equal(providerDefinitions.huggingface.variants.find(variant => variant.id === 'inference')?.beta, true);
});

test('citation and usage normalization preserves provider provenance, result identity and offsets', () => {
  const sources = providerCitations('perplexity', {output:[{content:[{annotations:[
    {type:'url_citation',id:'web-1',url:'https://example.com/a',title:'A',start_index:3,end_index:7},
    {type:'url_citation',id:'web-2',url:'https://example.com/a',title:'Same URL, distinct result'},
    {type:'url_citation',id:'web-1',url:'https://example.com/a',title:'duplicate'},
  ]}]}]}, 'resp-1');
  assert.equal(sources.length, 2);
  assert.deepEqual(sources[0], {title:'A',url:'https://example.com/a',provider:'perplexity',responseId:'resp-1',resultId:'web-1',sourceType:'web',startOffset:3,endOffset:7,offsetUnit:'unicode-code-point'});
  assert.equal(sources[1].resultId, 'web-2');
  assert.deepEqual(normalizeProviderUsage({input_tokens:10,output_tokens:4,input_tokens_details:{cached_tokens:3},output_tokens_details:{reasoning_tokens:2}},'fixture'), {
    inputTokens:10,outputTokens:4,cachedTokens:3,reasoningTokens:2,audioTokens:undefined,searchCalls:undefined,toolCalls:undefined,source:'fixture',
    upstream:{input_tokens:10,output_tokens:4,input_tokens_details:{cached_tokens:3},output_tokens_details:{reasoning_tokens:2}},
  });
});
