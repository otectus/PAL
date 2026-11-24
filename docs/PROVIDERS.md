# Providers in PAL 2.0.2

Open **Settings → Connections**, choose the provider, add a named account, and enter its credentials. Test the connection and refresh its models. In **New conversation**, choose the provider, account and model. A custom model or Azure deployment ID can be entered for catalogs that do not list it. Use the conversation's model settings to change the account or its advanced options. Choose Grok (xAI) or Perplexity directly in either client.

| Provider | Account setup | Selection |
| --- | --- | --- |
| OpenAI | API key, with an organization and project if the key needs them | Responses model ID |
| Claude API | Anthropic key | Messages model ID |
| Google Gemini | Gemini API key, or a named Vertex account with Application Default Credentials and its project/location endpoint | Gemini model ID |
| Azure OpenAI | Named resource endpoint, deployment and API key or Entra identity | v1 or versioned deployment endpoint |
| DeepSeek | DeepSeek API key | Chat or Responses variant and model |
| Mistral | Mistral API key | Chat or Responses model. OCR uses a separate Workbench request |
| Grok (xAI) | xAI API key | Grok model. Web Search and X Search are independent choices |
| Perplexity | Perplexity API key | Choose **Quick answer** (fast), **Research** (high), another effort preset, or enter an explicit Agent model ID. Open the Research pane for a background job |
| OpenRouter | OpenRouter key | Qualified upstream model ID from its searchable list, allowed/preferred providers, fallback and retention settings |
| Hugging Face | HF token, router or managed inference endpoint | Router model or task-compatible inference model |
| LiteLLM | Gateway URL and its own key, or the local bridge and the downstream provider's key | Proxy model alias or bridge model |
| Forge | Operator-supplied endpoint and key | Deployment's advertised model or explicit ID |
| Eden AI | Eden key | V3 provider/model and routing settings |
| Ollama | Local server, reviewed remote host or direct cloud account | Native Ollama model |
| Compatible / local models | Server URL, optional bearer or approved API-key header, processing location and capability declarations | Server's model ID |

Named account keys stay in PAL's private credential store and apply to their reviewed endpoint. A missing key on one account does not inherit another account's key. Default accounts accept standard environment variables, including `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `AZURE_OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, `PERPLEXITY_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, `LITELLM_API_KEY`, `FORGE_API_KEY`, `EDENAI_API_KEY` and `OLLAMA_API_KEY`. CLI sign-ins remain independent.

## Looking after accounts

- **Check.** **Check…** on an account looks in stages: what is set up, whether the service accepts the credential, and whether its models load. These cost nothing. What a service does not let PAL find out for free is shown as not known. Trying a model (a reply, streaming, a tool call, an image, a structured reply) sends short requests that can be billed, and only when you start it. For a compatible server you can keep what was found as its declaration.
- **Remove.** **Remove…** lists everything that depends on an account. Move its conversations and settings to another account of the same provider first. A conversation keeps its readable history and sends it to the new account with its next message. What only the old account could read is left behind. An account is removed once nothing uses it.
- **Choose a model.** **Browse…** beside a long model list searches and narrows it, and shows what the catalog states: context, price, what a model reads, and the day its provider stops serving it. For an OpenRouter model, **Who serves it** lists the upstream providers with their prices and lets you prefer some of them. That request is free and names only the model.
- **Setups and specialists** name the account they run on. A setup whose account is missing says so instead of using another one.

## Using the services

- **Research and search.** A Perplexity background request retains its provider job ID, status and sources. Reopen the conversation to inspect it. If the connection drops during submission before a handle returns, inspect the account before submitting again. In Search settings, Perplexity retrieves raw results. Grok Web/X Search, Claude web search and Gemini grounding run within a model request. Google Custom Search needs an existing account, API key and search-engine ID. Its published shutdown date is January 1, 2027. Choose another engine for new setups. [Google Custom Search overview](https://developers.google.com/custom-search/v1/overview)
- **Files and media.** Workbench ordinarily sends extracted content according to the artifact's processing policy. Uploading an original PDF is a separate action. Attach the resulting handle to a message on the same account. Remove the remote copy when finished or check its provider expiration. Deleting a conversation attempts to remove its remote originals. The local broker method `originalFiles.pendingCleanup` lists receipts for unresolved deletions. Retry with `originalFiles.remove` using the receipt’s session and handle IDs. Images uses the selected generation backend and can bind to a named provider account. Timed media jobs retain the model, prompt, source versions and provider handle. Their validated outputs become conversation files.
- **Voice.** In Voice settings choose transcription and speech output independently. Local transcription, Piper and IndexTTS stay available. Google Cloud Speech uses Cloud credentials. Gemini speech uses the Gemini model route. Azure Speech uses its resource key and region. Realtime conversations negotiate a separate live model and stream audio through the broker. Stop playback or interrupt from the active client.
- **Knowledge.** Bind embeddings separately from the conversation model. Voyage needs its own key for embeddings or reranking. Select an embedding model, dimensions and, where applicable, pooling. A changed embedding space needs a new index. Choose cloud processing explicitly before sending eligible memory. Jev/TypeSafe takes named structured questions and returns model probabilities or scores. A score cannot authorize an action.
- **Vector stores.** Qdrant is the existing default. Set `PAL_VECTOR_BACKEND` to `simple`, `chroma`, `elasticsearch`, `pinecone` or `redis` to select another projection. For a server, configure `PAL_VECTOR_URL` and the service credential in `PAL_VECTOR_API_KEY`. External servers require TLS and `PAL_VECTOR_CLOUD=1`. Chroma accepts `PAL_VECTOR_TENANT` and `PAL_VECTOR_DATABASE`. Set `PAL_VECTOR_NAMESPACE` to isolate PAL's projection. Redis requires the Search vector commands. The simple store uses SQLite under PAL's memory directory.
- **Mobile.** An owner can manage the desktop's accounts through the paired broker. For a limited device, grant the project and the specific account in **Settings → PAL Mobile**. Updating an account or its credential can require reviewing the grant again. A conversation can remain readable even when the device cannot send.

When the OpenAI or Claude account offers computer use, enable **Reviewed desktop actions** and the conversation's desktop tools. PAL shows the proposed input, asks before using the display, and previews each screenshot before sharing it. Clicking, pointer movement, text entry and individual Enter, Escape, Tab and Backspace keys use the existing Wayland desktop input path. The remote display must remain available and keep the same geometry.

## Hosted files, speech and media

- **PDFs and inference.** In **Workbench → Images**, choose a file and open **Provider actions…**; on the phone, choose the file in **Work → Library**. A saved OpenAI, Anthropic, Gemini Developer or xAI conversation can upload a PDF, attach the reviewed provider copy to a message, or delete it. For Mistral OCR or Hugging Face tasks, choose a named account and approve the displayed input. Results appear as conversation artifacts.
- **Grok collections.** A Grok API key works for inference and original files. Add a separate xAI Management key to the same named account to create collections, manage documents and attach a collection. Turn on collection search in the conversation options. [xAI collections and approvals](providers/xai-collections.md)
- **OpenAI Responses.** To search existing account data, enter the vector-store IDs in the conversation options. Hosted code runs in a provider container. Use the reply JSON Schema field to request a structured final response.
- **Audio files.** From a saved conversation, select a Workbench WAV, permit cloud processing and choose a transcription service. Google Cloud long recordings require an existing, authorized `gs://` object containing the same audio. OpenAI Whisper supports word and segment timestamps. Mistral Voxtral supports segment timestamps. For Gemini two-speaker synthesis, configure two distinct speaker names and voices and write each turn on its own line as `Speaker: words`. [Google Cloud asynchronous recognition](https://cloud.google.com/speech-to-text/docs/async-recognize) · [Mistral file transcription](https://docs.mistral.ai/studio/audio/speech-to-text/transcribe-files) · [Mistral speech generation](https://docs.mistral.ai/studio/audio/text-to-speech/generate-speech)
- **Azure and OpenRouter.** Select a named Azure OpenAI v1 deployment for realtime, speech, or images. The image model field takes its deployment name. An OpenRouter voice or image model takes the full upstream slug. The image service supports a reference image when the selected upstream model accepts one. [Azure realtime](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-websockets) · [Azure images](https://learn.microsoft.com/en-us/azure/foundry/reference/rest/images-create-image) · [OpenRouter images](https://openrouter.ai/blog/tutorials/image-generation/) · [OpenRouter speech](https://openrouter.ai/blog/announcements/announcing-audio-apis/)
- **Claude.** Web search, web page reading and code execution run at Anthropic when you turn them on in the conversation options; each step is listed under the reply. PAL asks each Claude generation only for what it takes: a thinking budget and a temperature where they are accepted, a reasoning effort or **Think before answering** on the models that decide by themselves. Current models read their reasoning back only behind exactly the text it was made with. When something before it changed, PAL leaves that reasoning out and keeps the text and tool results. Prompt caching is optional.
- **Gemini.** Google Search, reading the web pages you name, and code execution can be turned on together. Gemini 3 and later run them beside PAL's tools. Earlier models accept one or the other, and PAL says so before sending.
- **Files a provider's code makes** are kept with the conversation: from Claude's and OpenAI's containers and as Gemini's figures, at most 16 files of a reply, 32 MiB each and 64 MiB together. They are not kept in a temporary conversation.

## The LiteLLM bridge

A LiteLLM account of the kind **Managed local bridge** runs LiteLLM on this computer, one process for each account, with only that account's credential. Model names are LiteLLM's own, such as `anthropic/claude-sonnet-5`.

Open **Bridge…** on the account. PAL can keep LiteLLM in a folder of its own (`$XDG_DATA_HOME/pal/litellm`, normally `~/.local/share/pal/litellm`): it downloads the versions recorded in `tools/litellm-lock.txt` from PyPI, about 80 MB, and every file has to match its recorded hash. This needs Python 3.11 to 3.14 on 64-bit Linux. System Python is not changed, and **Remove…** deletes the folder again. `PAL_LITELLM_PYTHON` names an environment of your own and comes first; without either, the system's Python is used if it has LiteLLM. An environment of your own needs LiteLLM's `mcp` part before models can use tools (`pip install 'litellm[mcp]'`).

Replies stream, tools keep their calls and results together, and reasoning that a provider needs back is kept for the account that made it. **Start and test** loads LiteLLM without sending anything. PAL starts LiteLLM with its own price list, so it does not fetch one.

## Migration and recovery

On the first upgrade of an existing profile, PAL creates `migration-backups/pre-provider-v2.sqlite` beneath the broker's data directory and records provider schema version 2 in SQLite. The backup is owner-readable. Existing OpenAI, Anthropic and Gemini default references use the existing private credentials. Conversation and named connection IDs retain their identities.

To restore the pre-upgrade database, exit PAL and its broker, make a private copy of the current profile, and restore the snapshot as the profile's database using the SQLite backup command. Keep the matching private credentials, external memory erasure registry and artifact storage. Start the intended application version after restoration. Database recovery cannot undo requests accepted by a provider.

The local broker methods `connections.importPreview` and `connections.importApply` accept Py-GPT configuration JSON as data. Apply the returned preview digest after reviewing the mapped accounts, duplicates, legacy notices and unmapped fields. Keys are excluded by default. The optional credential import previews each target account and requires separate confirmation. [Py-GPT import procedure](providers/import.md)

Bing Search and OpenAI Sora/Videos imports retain a migration notice. Choose another supported service for new work.

## Diagnostics and verification

An HTTP 401 or 403 calls for checking the selected account, scope and deployment access. A 404 may mean a catalog entry is unavailable for inference. Refresh the catalog or enter a current model ID. For Azure, verify the deployment name and API version. For a local bridge, open **Bridge…** on its account: it names the Python it uses and what LiteLLM answered. A submitted request with an unknown outcome can still be billed.

See the [operation coverage ledger](providers/coverage.json), [live account observations](providers/live-2026-11-23.json) and [validation report](providers/2.0.2-validation.md) for the specific operations exercised.

## Extending PAL with a service manifest

Service manifest version 1 describes an adapter that the user installs and reviews as a PAL extension server. A manifest binds each operation to the installed server's UUID and exact MCP tool name. Configure credentials in the extension's private secret fields. Manifest fields describe options exposed by the adapter.

```json
{
  "version": 1,
  "id": "local-search",
  "label": "Local document search",
  "fields": [{"id":"language","label":"Language","type":"text"}],
  "operations": [{"operation":"search","serverId":"90ea7c23-e4df-4fea-ab1b-32ad95344975","tool":"search_documents"}]
}
```

Review and save manifests under **Settings › AI assistance › Service manifests**. A client of the broker can do the same: send the object to `providerManifests.preview` and `providerManifests.save` with `{manifest, expectedRevision: null}` for a new entry. For updates use the revision from `providerManifests.list`. Invoke through `providerManifests.invoke` with the manifest ID, revision, operation, conversation ID in `sessionId`, and a tool argument object in `args`. The broker checks the installed server, enabled tool, conversation permissions and approval before execution. Supported operation names are `inference`, `speech.transcribe`, `speech.synthesize`, `embed`, `search`, `storage.upsert`, `storage.query` and `storage.delete`. Remove an entry with `providerManifests.remove` and its ID and revision.
