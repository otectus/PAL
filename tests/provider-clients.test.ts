import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = async (path: string) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('desktop provider surfaces consume the broker registry and typed schemas', async () => {
  const [connections, named, bridge, artifacts, workbenchState, projects, session, options, grants, voice, knowledge, chat] = await Promise.all([
    source('qml/ConnectionsSettings.qml'), source('qml/NamedConnections.qml'), source('qml/LiteLlmBridge.qml'), source('qml/ArtifactBrowser.qml'), source('qml/WorkbenchState.qml'), source('qml/Projects.qml'), source('qml/NewSession.qml'), source('qml/ProviderOptionsEditor.qml'),
    source('qml/RemoteSettings.qml'), source('qml/VoiceSettings.qml'), source('qml/KnowledgeSettings.qml'), source('qml/Chat.qml'),
  ]);
  assert.match(connections, /App\.state\.providerOrder/);
  // A list of the broker's is not an Array in Qt 6.12's JavaScript, so its length decides.
  assert.match(named, /selectedVariant\.auth\?\.length/);
  assert.doesNotMatch(named, /Array\.isArray/);
  assert.match(named, /provider:"xai_management"/);
  assert.match(named, /expectedRevision/);
  assert.match(named, /LiteLlmBridge \{/);
  for (const method of ['status', 'stop', 'runtime', 'install', 'remove', 'cancel']) assert.ok(bridge.includes(`providerBridge.${method}`), method);
  assert.match(named, /endpointValue\.authHeader/);
  assert.match(artifacts, /voice\.transcribeArtifact/);
  assert.match(workbenchState, /originalFilesFor/);
  assert.match(projects, /providerTraits/);
  assert.match(session, /providerTrait\.optionsSchema/);
  assert.match(session, /providerOptions:sessionForm\.providerOptions/);
  for (const type of ['boolean', 'number', 'string', 'enum', 'string-list']) assert.match(options, new RegExp(type));
  assert.match(grants, /apiConnections/);
  assert.match(voice, /"openai","xai","google","google_cloud","azure_speech"/);
  for (const provider of ['perplexity', 'voyage', 'azure_openai', 'openrouter', 'litellm', 'xai', 'edenai', 'huggingface']) assert.match(knowledge, new RegExp(provider));
  assert.match(chat, /id:"edenai",label:"Eden AI"/);
  assert.match(chat, /video\/generation_async\/bytedance/);
  assert.match(chat, /xaiCollections\.addDocument/);
  assert.match(chat, /params\.originalFiles=originalFiles\.map\(file=>file\.id\)/);
});

test('Android provider setup is account-scoped and option-schema driven', async () => {
  const [traits, create, settings, owner, timedMedia, collections, workbench, guards] = await Promise.all([
    source('mobile/android/core/data/src/main/kotlin/dev/otectus/pal/mobile/data/ProviderTraits.kt'),
    source('mobile/android/app/src/main/kotlin/dev/otectus/pal/mobile/MainActivity.kt'),
    source('mobile/android/app/src/main/kotlin/dev/otectus/pal/mobile/ConversationSettingsSheet.kt'),
    source('mobile/android/app/src/main/kotlin/dev/otectus/pal/mobile/OwnerSettings.kt'),
    source('mobile/android/app/src/main/kotlin/dev/otectus/pal/mobile/TimedMediaDialog.kt'),
    source('mobile/android/app/src/main/kotlin/dev/otectus/pal/mobile/XaiCollectionsDialog.kt'),
    source('mobile/android/app/src/main/kotlin/dev/otectus/pal/mobile/WorkbenchScreen.kt'),
    source('mobile/android/app/src/main/kotlin/dev/otectus/pal/mobile/UiGuards.kt'),
  ]);
  assert.match(traits, /optionsSchema/);
  assert.match(traits, /providerConnections/);
  assert.match(create, /connectionId/);
  assert.match(create, /ProviderOptions/);
  assert.match(settings, /destinationReviewed|ConfigurationDraft/);
  assert.match(owner, /owner\.connections\.save/);
  assert.match(owner, /expectedRevision/);
  assert.match(owner, /"xai_management"/);
  assert.match(owner, /owner\.providerBridge\.status/);
  assert.match(owner, /put\("authHeader"/);
  assert.match(collections, /owner\.xaiCollections\.addDocument/);
  assert.match(workbench, /owner\.voice\.transcribeArtifact/);
  assert.match(workbench, /owner\.originalFiles\.remove/);
  assert.match(workbench, /expectedSessionRevision/);
  assert.match(workbench, /expectedConnectionRevision/);
  assert.match(workbench, /authenticated\(activity, repository, action/);
  // Another app gets a granted file, never a path.
  assert.match(workbench, /sharedFile\(/);
  assert.match(guards, /FileProvider\.getUriForFile/);
  assert.match(timedMedia, /provider == "edenai"/);
  assert.match(timedMedia, /video\/generation_async\/bytedance/);
});
