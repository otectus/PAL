# PAL desktop and phone feature matrix

Reconciled against source on 2026-11-20 (desktop and mobile 0.1.5, protocol `cere.mobile.v1` 1.1); device roles and the PAL Everywhere rows added on 2026-11-21; providers, tasks, media, documents, accounts, collectors, code, browser, services and phone extras added on 2026-11-23, voice settings on 2026-11-24 (desktop and mobile 2.0.2). Source is the authority: when this file and the code disagree, the code is right and this file is out of date. `tests/feature-matrix.test.ts` checks that every phone operation in `broker/remote/schemas.ts` is listed in the operation index below with its permission, that every F01–F98 row of `mobile/MOBILE_PLAN.md` appears exactly once, and that every test file named here exists.

**Status vocabulary.** *Both*: the same broker operation and semantics on desktop and phone. *Phone adapted*: the same capability with phone-specific presentation. *Phone read*: the phone reads; changes stay on the desktop for the stated reason. *Desktop only*: a deliberate local-administration boundary, with its reason. *Withheld*: the capability exists but is not offered to a phone until the stated condition holds. *Not built*: planned, not implemented; the next action names the work.

**Permissions** are the per-phone grants the desktop issues at pairing (`chat.read`, `chat.write`, `providers.execute`, `providers.api`, `approvals.answer`, `approvals.provider`, `attachments.write`, `capture.preview`, `desktop.control`, `settings.write`, `memory.read`, `memory.write`, `web`) intersected with the desktop's own categories (apps, files, windows, audio, media, timers, capture, scripts, providers). A phone's turn runs under `ordinarySettings` (`broker/execution.ts`): the provider retains its restricted execution mode. If the owner enables automatic CLI approvals, a phone-origin turn with both live `providers.execute` and `approvals.provider` grants can receive automatic answers to provider permission prompts. Pause, revocation and questions still apply.

**State and revisions.** Sessions carry `revision` (metadata), `draftRevision` (text and attachments) and `configRevision` (provider/model/effort/tools); messages carry `revision`; settings carry `settingsRevision`; memory records carry their graph revision; schedules carry `revision`. A phone mutation names the revision it reviewed and is refused with `REVISION_CONFLICT` when it changed. Signed mutations are bound to their exact parameters and command ID (`broker/remote/server.ts`); an unknown outcome is never replayed (`CommandOutcomes.kt`).

## 1. Product surfaces

| Surface | Desktop entry | Phone entry | Broker operations | Permission | State / revision | Tests | Status | Limitation and next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chat, streaming, Stop | `qml/Chat.qml` composer, Stop | Chat screen composer, Stop | `sessions.send`, `sessions.stop`, `sessions.messages`, `message.upsert` events | `chat.write` (send), `chat.read` (stop, read) | `draftRevision` + `configRevision` bound to the signed send; one provider writer | `remote.test.ts` ("provider acceptance followed by lost acknowledgement…", "remote Ollama and Claude sessions…"), `ConnectedDesktopTest.kt` | Both | — |
| Sessions, search, Unread | `qml/SessionList.qml` | Sessions screen, "Search conversations", Load more | `sessions.list` (filter, `withIds`), `sessions.batch`, `sessions.read` | `chat.read` | `revision`; search names every match ID (no silent page cap) | `mobile-conformance.test.ts`, `remote.test.ts` ("phones clear Unread…") | Both | — |
| Drafts, including desktop attachments | Chat composer chips | Composer; "From the desktop draft" strip, Review, Remove; explicit conflict choice | `drafts.put` (`desktopAttachmentIds`), `drafts.get`, `drafts.attachmentPreview`, `sessions.send` (`desktopAttachments`) | `chat.write`; `attachments.write` to send attachments; `capture.preview` to preview images | `draftRevision` covers text and attachment set; the phone retains its reviewed baseline and pending-write fingerprint; send binds each attachment's SHA-256 | `remote.test.ts` ("the phone reviews a desktop draft's attachments…", "session metadata is scoped…"), `ReconciliationTest.kt`, `MobileCapabilitiesTest.kt` | Both | In-flight typing, delayed phone echoes, accepted-send clears and attachment-only revisions converge without losing text or raising a false text conflict. Different desktop text keeps the phone edit and asks which revision to keep. Queued messages carry text only: a draft with desktop attachments waits for an idle turn (explicit hint). |
| Approvals, questions, MCP forms | `qml/ApprovalCard.qml`, completion inbox | Inbox, notification Deny | `approvals.answer`, `approvals.preview`, snapshot/events | `approvals.answer` (+ `approvals.provider` for provider requests) | approval `revision` + `digest`; exactly one winner | `remote.test.ts` ("approval answers retire exactly once…", "changed capture approvals…"), `InteractionStateTest.kt` | Both | Complex MCP forms and unknown provider requests fail closed on both (F28). |
| Child tasks and agents | `qml/AgentCard.qml`, Activity | Activity panel, agents, approvals of descendants | snapshot `agents` (opaque `agentId`), `activity.page` | `chat.read` | agent refs are HMACs, never native thread IDs | `mobile-conformance.test.ts`, `ConversationContentTest.kt` | Both | — |
| Provider creation and configuration | `qml/NewSession.qml`, `qml/SessionModelDialog.qml`, `qml/ModelBrowser.qml` | New conversation, Conversation settings, Hand off | `sessions.create`, `sessions.configure` (omitted options kept), `providers.models` (`listing`, session route); snapshot `providerTraits` (`customModel`, `toolCalling`) | `chat.write`; `providers.execute` (CLI), `providers.api` + provider grant (hosted/compatible API) | `configRevision`; `routeRevision` of a compatible conversation; its connection's origin bound to the grant | `remote.test.ts` ("native remote session configuration…", "hosted API providers run from a phone only…"), `mobile-compatibility.test.ts`, `model-catalog.test.ts`, `ProviderTraitsTest.kt`, `ConversationOptionsTest.kt`, `ModelChoicesTest.kt` | Both (by provider, §3) | AntiGravity is Withheld (§3). A compatible conversation is checked against its own connection before every request; one on an ungranted saved connection is phone-readable only. Typed API model IDs work where the desktop accepts them; an older desktop that cannot report an API conversation's tools blocks model changes from the phone rather than turning tools off. |
| Pin, archive | Session menu | Conversation settings | `sessions.organize` | `chat.write` | `revision` | `remote.test.ts` ("session metadata is scoped, CAS-organized…") | Both | — |
| Folders | `qml/FolderDialog.qml` | Folder name shown on each conversation; full access: Conversation settings → Folder (move, create, rename, delete) | session DTO `folderName`; full access: `owner.folders.*`, `owner.sessions.setFolder` | `chat.read` | folder `revision` | `remote.test.ts` ("session metadata is scoped…"), `owner-parity.test.ts` | Both (full access); Phone read (limited) | Folder names are global across projects and can describe work outside a limited phone's scope, so it cannot list, create or assign folders. |
| Projects | `qml/Projects.qml` | New conversation project choice; full access: Settings › This computer › Projects (name, favorite, what new conversations start with) | snapshot `projects`; full access: `owner.projects.list`, `owner.projects.save` | `chat.read` | project `revision` | `projects.test.ts`, `remote.test.ts`, `owner-parity.test.ts`, `WorkToolsScreenTest.kt` | Both (full access); Phone read (limited) | Choosing which folders a limited phone may use is part of pairing (desktop). |
| Branching | `qml/BranchDialog.qml` | Handoff (reviewed draft of recent messages) | `sessions.handoffPreview`, `sessions.handoffCreate` | `chat.write` | source digest of revisions | `remote.test.ts` ("handoff creates a reviewed draft only…") | Phone adapted | Message-level branch points stay on the desktop; a native Codex fork refuses phone-run sessions in code (`forkCodex` rejects `session.remote`). |
| Export | `qml/ConversationExport.qml`, `qml/DocumentExport.qml` | Copy message (Markdown); full access: Work (export, branch) and a message’s or file’s menu and Work › Library (PDF, Word, web page, Markdown) | full access: `owner.sessions.export`, `workbench.documents.*` | — | — | `ConversationContentTest.kt`, `documents.test.ts`, `MediaScreenTest.kt` | Both (full access); Desktop only (limited) | A desktop path is chosen on the desktop; a phone receives the file itself. |
| Pinned replies (bookmarks) | Message menu "Bookmark" | Star on a message, "Pinned" sheet | `messages.bookmark`, `messages.bookmarks` | `chat.write` / `chat.read` | shared bookmark table; message `revision` unchanged | `remote.test.ts` ("the phone pins and unpins replies…"), `ConformanceTest.kt` | Both | A pin made on the desktop appears on the phone when the conversation's messages reload. |
| One-shot web search | Composer "Search web" | Composer "Search the web" | `sessions.send` `webSearch` | `web` + desktop web search enabled | per message only | `remote.test.ts`, `MobileCapabilitiesTest.kt` | Both | Same 500-character query limit; no hidden provider fallback (refused when unavailable). |
| Personality and assistant identity | `qml/PersonalitySettings.qml` | Settings → Defaults (personality, labelled global); assistant name in composer | `settings.get`, `settings.patch` | `settings.write` | `settingsRevision` | `remote.test.ts` ("the phone reads a conversation's style source…") | Both | The assistant's name and avatar are chosen on the desktop. |
| Date, time and elapsed time | Settings › Application › Time awareness; `qml/ClockView.qml` (palette “Current date and time”, More › Clock and time zone…); `qml/ContextDrawer.qml` | Conversation menu › Clock and time zone; full access: Settings › This computer › Desktop settings | `time.now`, `time.elapsed`, `sessions.timeZone`, `sessions.send` `clientContext`, tools `time_now` and `time_elapsed` | `chat.read`; `chat.write` for a conversation’s zone | message received time and zone; `configRevision` for a conversation’s zone | `time.test.ts`, `temporal-context.test.ts`, `temporal-persistence.test.ts`, `time-mobile.test.ts`, `time-ui.test.ts`, `ClientTimeTest.kt`, `ClockTest.kt` | Both | Renewed for every request PAL composes; once per message for Codex, Claude Code and AntiGravity (no clock tool there). See [time awareness](time-awareness.md). |
| Behavior styles and postures | `qml/SessionBehavior.qml`, `qml/BehaviorProfileEditor.qml` | Conversation settings → Style (source: this conversation, this project, or everywhere) | `sessions.behavior` | `chat.read` | resolved at next turn | `remote.test.ts` ("the phone reads a conversation's style source…") | Phone read | Styles carry tool ceilings; choosing them stays on the desktop. |
| Memory and evidence | `qml/GraphMemoryInspector.qml`, `qml/MemoryDialog.qml` | Settings → Project memory | `memory.*` (index §4) | `memory.read` / `memory.write` + granted memory server | graph revisions; erasure receipts | `remote.test.ts` ("project memory is shared across provider conversations…", "the phone reviews an assertion history…", "phone operations without a dedicated test…"), `CacheIntegrityTest.kt` | Both (typed, scoped) | Representative evaluation is not done (W09; see `docs/memory/implementation-report.md`). |
| Capture | `qml/Desktop.qml` capture card | Desktop → Capture | `captures.*`, `capture.updated` events | `desktop.control` + capture category; `capture.preview`; `attachments.write` to attach | digest of the immutable image | `remote.test.ts` ("a phone-started capture is previewed…") | Both | Satty editing waits for someone at the desktop; the phone says so and can cancel. |
| Desktop controls | `qml/Desktop.qml` | Desktop screen | `desktop.status`, `desktop.apps`, `desktop.windows`, `desktop.execute`, `timers.cancel` | `desktop.control` + category | target revalidated before acting | `desktop-hyprland.test.ts`, `desktop-services.test.ts`, `remote.test.ts`, `review-core.test.ts` | Both | — |
| Workflows, recipes, capsules | `qml/Workflows.qml` | — | — | — | recipe version + revision | `workflows.test.ts` | Desktop only | Recipes run under reviewed authorization tied to the desktop; preparing or saving them from a phone would bypass that review. |
| Result verification | `qml/Workflows.qml` results | Conversation settings → Results and schedules; full access: run a saved check against the reviewed result | `workflows.status`; full access: `owner.results.*` | `chat.read` | provider outcome kept apart from PAL's verification; the check names the result it was reviewed for | `remote.test.ts` ("…results and schedules and can only pause a schedule"), `owner-parity.test.ts` | Both (full access); Phone read (limited) | A limited phone cannot start a check: it runs the desktop's scripts. |
| Schedules | `qml/Workflows.qml` schedules | Results and schedules → Pause | `workflows.status`, `workflows.pauseSchedule` | `chat.read` / `chat.write` | schedule `revision` | `remote.test.ts`, `schedules.test.ts` | Phone read + pause | Turning a schedule on again needs a fresh desktop review (`schedules.ts` refuses re-enabling a paused one). |
| Job, activity and completion status | `qml/CompletionInbox.qml`, `qml/ActivityPanel.qml` | Activity, completion notices, queued count | `activity.page`, `notice` events | `chat.read` | message revisions | `remote.test.ts` ("phones clear Unread, receive scoped completion and timer notices…") | Both (scoped) | A limited phone is not shown background jobs of other projects (indexing, model pulls); full access lists and cancels them (`owner.jobs.*`). |
| Notes vault | `qml/KnowledgeSettings.qml`, `qml/NotesVaultScope.qml` | Phone-started turns use read-only notes tools | provider tools (`core.notesToolsFor`) | desktop vault, chosen folders, `.palignore` and cloud policy | the vault's settings are part of each turn's notes witness | `knowledge.test.ts`, `notes-vault.test.ts` | Phone adapted | Note edits are not offered to phone-started turns; vault path, folders and cloud policy stay on the desktop. |
| Knowledge collections | `qml/KnowledgeCollections.qml` | Bound collections feed phone-started turns; full access: Settings › This computer › Knowledge collections (sources, indexing, try a question) | turn context (`collections.context`); full access: `owner.collections.*` | per-collection cloud consent | collection `revision` | `knowledge.test.ts`, `collection-retrieval.test.ts`, `document-baseline.test.ts` | Both (full access); Phone adapted (limited) | Excerpts name their lines, page or time, mark disagreement and change, and strict answers ask more of a match by words (measured in [evaluation](memory/evaluation.md)). |
| TTS, dictation, transcription, voice commands | `qml/VoiceSettings.qml`, `qml/VoiceInput.qml`, `qml/SpeechServerSettings.qml`, `qml/SpeechCacheSettings.qml` | Voice notes and read-aloud (below); full access: Desktop settings (speak replies, engine, keep spoken audio) | full access: `owner.settings.patch` (`voice`) | — | kept audio belongs to the messages it was made from | `tts.test.ts`, `transcription.test.ts`, `speech-cache.test.ts`, `voice-commands.test.ts`, `pinned-replies.test.ts` | Desktop only (limited) | Replies to phone-started turns are never read aloud on the desktop. Spoken audio is kept only when chosen, never for temporary conversations or voices played through Speech Dispatcher. |
| Health and recovery diagnostics | `qml/Health.qml`, `qml/Recovery.qml` | Desktop → "Unavailable on the desktop"; memory health line; Settings → Connection details (connected or last-seen desktop build, protocol, app version and channel, last synchronization, copyable summary) | `desktop.status` `missing`, `memory.health`; welcome `build`, `protocol` | `desktop.control` / `memory.read` | — | `remote.test.ts`, `desktop.test.ts`, `ConnectionDiagnosticsTest.kt` | Phone read (sanitized) | Error text, endpoints and model names stay on the desktop; the copied summary names no keys, tokens, offers, addresses, IDs or conversation content. |
| Workspace telemetry | `qml/TelemetrySettings.qml`, workspace card | Desktop → Desktop workspace | `desktop.workspace` | `desktop.control` | fresh observations only; unknowns named | `remote.test.ts` ("…reads scoped workspace and memory health") | Phone read (scoped) | Only this project's state; no window titles, commands or outside paths. |
| Pet, motion, appearance | `qml/Pet.qml`, `qml/MotionSettings.qml` | Still status portrait (Settings → On this phone) | `desktop.portrait` | `chat.read` | portrait sheet digest | `remote.test.ts`, `portrait-state.test.ts`, `PortraitStateTest.kt` | Phone adapted | The phone never animates; window roaming and pet placement are desktop behaviors. |
| Credentials, pairing, grants, trust | `qml/RemoteSettings.qml`, `qml/ConnectionsSettings.qml` | Pairing screen (scan, network return, words); Settings → access summary, Reduce access, Pause, Forget; full access: Settings › This computer (access summary, working profile, devices: revoke or limit, lower its own role) | `pair.response` before sign-in (network-return offers only); `permissions.get`, `permissions.reduce`, `permissions.pause`, `devices.self`, `devices.selfRevoke`; `client.features`, `devices.setSelfRole`, `owner.access`, `owner.profile.set`, `owner.devices.*` | any paired phone | `scopeVersion`; one answer per offer | `remote.test.ts` ("mobile permission reduction is revision-bound…", "trusted replacement…", "phone operations without a dedicated test…"), `mobile-compatibility.test.ts`, `PairingReturnTest.kt`, `ui.cpp`, `owner-parity.test.ts` | Phone read + reduce (limited); manage (full access) | A phone can only reduce or pause; enrolment, keys and expanding trust stay on the desktop. During a network-return offer's five minutes the gateway accepts only that offer's signed answer; the owner still compares the words and confirms on the desktop. A phone with full access manages devices and its working profile but can never raise a role or grant; roles are raised on the desktop. |
| Executable editing (saved scripts, tool servers, custom tools) | `qml/ScriptsSettings.qml`, `qml/ToolServers.qml`, `qml/CustomTools.qml` | Run a granted saved script (limited); full access: Settings › This computer › Saved scripts and Tool servers (sign in, import, settle lost requests) | `desktop.execute` `script.run`; `owner.settings.patch` (`scripts`), `owner.extensions.*`, `owner.customTools.credential` | `desktop.control` + scripts + script ID grant | script definition digest | `review-core.test.ts` ("W10 a saved script changed…"), `remote.test.ts` ("partially executed scripts are unknown…"), `owner-parity.test.ts`, `mcp-connections.test.ts` | Both (full access); Desktop only (limited) | A limited phone cannot define what the desktop runs. A phone with full access edits the same typed definitions as the desktop; each change is a signed action. |
| Backup, restore, memory infrastructure | `qml/Recovery.qml`, memory settings | Full access: Settings › This computer › Health and backups | `owner.health`, `owner.backup.status`, `owner.backup.create` | — | — | `memory-migration-backup.test.ts`, `owner-parity.test.ts` | Phone adapted (full access: status and create) | Restore and memory-service administration stay on the desktop: they replace local files and services. |
| Workbench Files and reviewed changes | `qml/Workbench.qml`, `qml/WorkspaceFiles.qml`, `qml/FilePreview.qml`, `qml/ChangeReview.qml` | Full access: Work › Files and Changes (browse, edit as reviewed changes, folder permissions, 30-minute model edit grant). Limited: A result card in the conversation ("Proposed file changes · view this result on the desktop"), without paths; the conversation's Files/Images/Analysis selection and a note before taking it over | session `workbenchFamilies`, `workbenchTakeover`; `sessions.send` `workbenchAcknowledged`; full access: `workbench.roots`, `workbench.files.*`, `workbench.changes.*`, `workbench.updateRoot`, `workbench.grantEdits` | `chat.write` | root `revision`, change set digest + preconditions; the acknowledged selection | `workspace-files.test.ts`, `mobile-compatibility.test.ts`, `ui.cpp`, `owner-parity.test.ts` | Both (full access); Desktop only (limited) | Limited phones: Folder access and reviewed changes bind to desktop paths and the confined helper; a phone-controlled conversation is offered no Workbench tools. Chat continues from the phone (text parity), but only after the phone names which families pause; an older phone is refused with the reason. The desktop's selection is kept and returns when it detaches the phone. |
| Artifacts, images and the image editor | `qml/ArtifactBrowser.qml`, `qml/ImageWorkbench.qml`, `qml/ArtifactCard.qml` | Full access: Work › Library (preview, download, send a file from the phone, draw on an image as a new version) and image generation. Limited: Result cards in the conversation ("Files or images from a tool", "An image, analysis or code run") to view on the desktop; no image bytes, paths or previews | message `desktopOnly`; full access: `transfers.*`, `workbench.artifacts.*`, `workbench.images.*` | `chat.read` | artifact version IDs and hashes; operation `revision` | `workbench-images.test.ts`, `workbench-documents.test.ts`, `mobile-compatibility.test.ts`, `ui.cpp`, `owner-parity.test.ts` | Both (full access); Desktop only (limited) | Limited phones: Image backends, billing acknowledgement and the editor run on the desktop; phones do not receive artifact bytes. Masked edits from a phone use the desktop editor’s saved layer; painting a separate mask on the phone is not built. |
| Durable runs, Code Lab, commands and Git | `qml/RunsPane.qml`, `qml/CodeLab.qml` | Full access: Work › Runs (Code Lab runs, commands, host commands, specialists; cancel) | `workbench.operations.*`, `workbench.codelab.*`, `workbench.commands.run` | — | operation state machine; execution grants | `workbench-codelab.test.ts`, `host-commands.test.ts`, `specialists.test.ts` | Both (full access); Desktop only (limited) | Limited phones: execution needs the desktop sandbox and its approvals. |
| @ references and the project shelf | `qml/Chat.qml` (`qml/ReferencePicker.qml`), `qml/ProjectShelf.qml` | Full access: references in messages and recipe inputs; Work › Shelf | `workbench.references.*`; `sessions.send` `references` | — | file version checked at send; artifact versions immutable | `workbench-references.test.ts`, `workbench-recipes.test.ts`, `ui.cpp`, `owner-parity.test.ts` | Both (full access); Desktop only (limited) | Limited phones send plain text. Full access also has the project shelf (Work › Shelf). |
| Saved connections, review helpers, HTTP tool servers | `qml/NamedConnections.qml`, `qml/ConnectionCheck.qml`, `qml/ConnectionUses.qml`, `qml/LiteLlmBridge.qml`, `qml/ImageConnections.qml`, `qml/ToolServers.qml` | Full access: Settings › This computer (keys and connections, write-only keys; tool servers with sign-in) | `owner.connections.*`, `owner.credentials.set`, `owner.extensions.*` | — | connection `revision`; server binding digest | `connections.test.ts`, `connection-tools.test.ts`, `provider-bridge.test.ts`, `workbench-helpers.test.ts`, `extensions-http.test.ts`, `mobile-compatibility.test.ts`, `mcp-connections.test.ts` | Both (full access); Desktop only (limited) | Keys never travel back to a phone. Checking an account, what uses it and moving that to another are on both screens; installing or removing LiteLLM is on the desktop. Configuration with keys and network policy stays on the desktop. A phone's compatible grant names one origin (the Settings endpoint, or a saved connection chosen when granting) and never widens to other connections; a conversation's catalog and tool/image declarations come from its own connection. |
| Workbench recipes and backups of conversation files | `qml/Workflows.qml`, `qml/Recovery.qml` | Full access: Settings › This computer › Routines (recipe, inputs, reviewed prompt, time or folder trigger) | `owner.recipes.*`, `owner.schedules.*`, `owner.results.*` | — | recipe version + pinned references; backup manifest digests | `workbench-recipes.test.ts`, `workbench-recovery.test.ts`, `routines.test.ts` | Both (full access); Desktop only (limited) | Restoring conversation files stays on the desktop. |
| Device roles and working profiles | `qml/RemoteSettings.qml` (pairing role, Give full access, Limit access, working profile) | Settings › This computer (access, working profile, lower own role) | `client.features`, `devices.setSelfRole`, `owner.access`, `owner.profile.set`, `remote.setRole` (desktop) | role (observer, limited, full access) | `scopeVersion`, `profileRevision`; `until-revoked` lifetime | `owner-parity.test.ts` | Both | Raising a role is desktop-only. A downgrade to a build without roles is not supported (see mobile/SECURITY.md). |
| Terminal | `qml/TerminalPane.qml` (Workbench › Terminal) | Work › Terminal | `terminal.*` | full access | lease epoch + input sequence; screen `base`/`rev` | `owner-parity.test.ts` | Both (full access) | IME and physical-keyboard behavior on real devices is not yet recorded. |
| Host commands | Workbench “Host commands” family | Model families in Work | tool `host_run` | full access (family on) | operation `command.host`; unknown after restart | `host-commands.test.ts` | Both (full access) | — |
| Research investigations | `qml/ResearchPane.qml` | Work › Research | `research.*`, `owner.research.*` | full access | saved searches, source passages, findings and report revisions | `research.test.ts`, `owner-research.test.ts`, `ResearchScreenTest.kt` | Both (full access) | Project-only runs work offline with a local model. Web and mixed runs require web search. Recurring refresh is authorized on desktop. |
| Canvas previews | `qml/CanvasPane.qml` | Work › Canvas | `canvas.*` | full access | snapshot `revision`; annotations bound to it | `canvas.test.ts` | Both (full access) | Needs Chrome or Chromium on the desktop. |
| Scratchpad and Daybook | `qml/NotesPane.qml` | Work › Notes | `owner.notebook.*` | full access | scratchpad `revision` (conflicts, 20 kept) | `notebook.test.ts` | Both (full access) | Offline phone edits are not queued; a conflict is resolved on save. |
| Skills | `qml/SkillsSettings.qml` | Settings › This computer › Skills | `skills.*`, `owner.skills.*` | full access | version review; `skills.revision` | `skills.test.ts` | Both (full access) | — |
| Working setups and specialists | `qml/SetupsSettings.qml` | Settings › This computer › Working setups, Specialists | `setups.*`, `specialists.*`, `owner.setups.*`, `owner.specialists.*`; tools `specialists_run`, `specialists_panel` | full access | setup and specialist `revision`; preview token bound to the conversation | `setups.test.ts`, `specialists.test.ts` | Both (full access) | — |
| Usage and budgets | `qml/UsageSettings.qml` | Settings › This computer › Usage and budget | `usage.*`, `owner.usage.*` | full access | policy `revision` | `usage-ledger.test.ts` | Both (full access) | A local limit is not a provider billing cap. |
| Voice notes, read-aloud and live voice | Desktop dictation and speech; **Live voice** in the composer | Conversation › ⋮ › Voice settings | `voice.transcribe`, `owner.voice.*`, `owner.realtime.*` | full access | — | `voice-notes.test.ts`, `VoiceSettingsTest.kt` | Phone adapted | Local dictation uses whisper.cpp. Owner phones can also select a hosted speech account and start a broker-managed realtime session. Gemini Live reached provider-ready in the live check. Full-duplex microphone and interruption checks on a physical phone remain unverified. |
| Translation and table previews | `qml/DocumentTools.qml`, `qml/TableSummary.qml` (a file’s menu); tool `translate` | Work › Files › Translate, Columns; Work › Library › a file’s actions | `translate.run`, `tables.preview`, `owner.translate`, `owner.tables.preview` | full access | translation provenance (source version, language, glossary) | `translation.test.ts`, `table-preview.test.ts` | Both (full access) | Translation needs a text helper model. |
| Tool server sign-in, import and external writes | `qml/ToolServers.qml` | Settings › This computer › Tool servers | `extensions.oauth*`, `extensions.import*`, `extensions.writes`, `extensions.resolveWrite`, `owner.extensions.*` | full access | sign-in flow bound to device, state and server; write ledger | `mcp-connections.test.ts`, `extensions.test.ts` | Both (full access) | Tool servers sign in through a redirect; a service that refuses the phone redirect is signed in on the desktop. Accounts (below) also sign in with a device code. |
| Collection sources: web pages, uploads, watched folders | `qml/KnowledgeCollections.qml` | Settings › This computer › Knowledge collections | `collections.addUrl`, `collections.addArtifact`, `collections.setWatch`, `owner.collections.*` | full access | collection `revision`; snapshot origin and SHA-256 | `knowledge-sources.test.ts` | Both (full access) | — |
| Routines: folder triggers and authorizers | `qml/Workflows.qml` | Settings › This computer › Routines | `schedules.*`, `owner.schedules.*` (`adopt`) | full access | schedule `revision`; `authorizedBy`; pending changes | `routines.test.ts`, `schedules.test.ts` | Both (full access) | — |
| View desktop | Notice on the desktop | Desktop › View desktop | `view.*` | full access | frame `revision` | `remote-view.test.ts` | Phone adapted | Hyprland and grim are required; pointer and typing need ydotool or wtype (not installed on the reference desktop, so input there is unavailable). |
| Recordings and transcripts | `qml/RecordingPane.qml` (Workbench › Media) | Work › Library › a recording | `workbench.recordings.*` | full access | transcript versions; the recording's hash | `recordings.test.ts`, `recordings-ui.test.ts`, `MediaScreenTest.kt` | Both (full access) | Conversion, clips and playback of some formats need ffmpeg and Qt Multimedia on the desktop. |
| Documents | `qml/DocumentExport.qml`, `qml/DocumentTools.qml` | Work › Library (write one, or from a file); a reply’s menu | `workbench.documents.*`; tool `documents_export` | full access | a new immutable artifact version | `documents.test.ts`, `MediaScreenTest.kt` | Both (full access) | PDF needs the `pal-document` helper. |
| Analysis sessions | `qml/AnalysisSession.qml` | Work › Runs | `workbench.codelab.session*` | full access | cells with their dependencies named | `analysis-session.test.ts`, `WorkToolsScreenTest.kt` | Both (full access) | Inside Code Lab's isolation. |
| Pinned sources and Context | `qml/ContextDrawer.qml` | Conversation settings → Pinned sources | `workbench.references.*` | full access | each pin is authorized again for every message | `pins.test.ts`, `WorkToolsScreenTest.kt` | Both (full access) | — |
| Accounts (GitHub, Google, Microsoft) | `qml/AccountsSettings.qml`, `qml/AccountsPane.qml` | Settings › This computer › Accounts; Work › Accounts | `accounts.*`, `owner.accounts.*`; tools of family `accounts` | full access | account `revision`; every write is a draft a person sends | `accounts.test.ts`, `AccountsScreenTest.kt`, `AccountTextTest.kt` | Both (full access) | The owner registers the app. Not tried against real accounts. Google signs in on the desktop. |
| Workspace history | `qml/CollectorPolicy.qml`, `qml/WorkspaceHistory.qml` | Settings › This computer › Workspace history | `workspace.history`, `workspace.historyErase`, `owner.workspace.*`; tool `workspace_history` | full access | per-record expiry; leaves with its folder | `collectors.test.ts`, `owner-parity.test.ts`, `WorkspaceHistoryTest.kt` | Both (full access) | Off by default. No title, command or text is kept. |
| Code in a project | `qml/CodeContext.qml` (Context) | — | `code.*`; tools `code_find`, `code_context` | desktop; per-project consent and destinations | content hash of each file | `code-context.test.ts` | Desktop only | TypeScript, JavaScript, C++ and QML. Relationships say whether they are certain, possible or ambiguous; nothing is run. Tools are offered to models PAL runs; command-line providers read projects themselves. |
| Browser companion | `qml/BrowserCompanionSettings.qml` | Full access: shown among paired devices, can be narrowed or revoked | `remote.browser*` (desktop); a fixed list of phone operations (`browserMethods`) | observer or limited; never full access | `scopeVersion`; 14-day expiry; keys unknown to the phone's endpoint | `browser-companion.test.ts` | Desktop only (administration) | Off by default and loopback only unless addresses are chosen. `tools/browser-companion-check.ts` runs the page in Chrome or Chromium. |
| Local services | `qml/LocalServices.qml` (Health) | — | `services.*` | desktop | a transient systemd user unit owns what PAL started | `service-manager.test.ts` | Desktop only | Ollama and the memory databases; needs a systemd user session. Nothing PAL did not start is stopped. |
| Finding the desktop again and wake-ups | `qml/RemoteSettings.qml` | Settings › Connection (find); Settings › On this phone (wake-ups) | `wake.*`, `remote.setDiscovery`, `remote.decideWake` (desktop) | any paired phone (asking); the desktop's owner allows | announced ID; wake registration | `reachability.test.ts`, `ReachabilityTest.kt`, `WakePushTest.kt`, `EndpointsTest.kt` | Both | Off by default. An address counts only after it presents the paired key; a hint is empty and encrypted. |
| Tile, widget and launcher shortcuts | — | Quick Settings tile, home-screen widget, shortcuts | — | — | on-device | `ReachabilityTest.kt` | Phone adapted (on-device) | No title is shown and no request can be answered from them. |

## 2. Mobile plan rows F01–F98

Treatments are the plan's (`mobile/MOBILE_PLAN.md` §2). Phone entry names are screens of the Android app (Chat, Sessions, Inbox, Desktop, Settings).

| ID | Capability | Desktop entry | Phone entry | Broker operation | Permission | State / revision | Tests | Status | Limitation / next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F01 | Chat/Sessions/Desktop/Settings layout | `qml/Shell.qml`, `Panel.qml`, `Workspace.qml` | Bottom navigation | — | — | — | `ConversationContentTest.kt` | Phone adapted | — |
| F02 | Connection and policy banners | `qml/Shell.qml` | Connection banner, "Cached · actions unavailable" | welcome, `snapshot.changed` | — | connection generation + cache epoch | `ConnectionPolicyTest.kt`, `InboundFramesTest.kt` | Phone adapted | — |
| F03 | Session list, search, status labels | `qml/SessionList.qml` | Sessions, Search conversations | `sessions.list`, `sessions.batch` | `chat.read` | `revision` | `mobile-conformance.test.ts`, `remote.test.ts` | Both | — |
| F04 | Managed session creation | `qml/NewSession.qml` | New conversation | `sessions.create` | `chat.write` + provider grant | — | `remote.test.ts` | Both | AntiGravity withheld (§3). |
| F05 | Project selection, realpath, trust | `qml/NewSession.qml` | Project chips | `sessions.create` `projectId` | granted projects | canonical path | `remote.test.ts` | Phone adapted | First trust stays on the desktop. |
| F06 | CLI model/effort catalogs | `qml/SessionModelDialog.qml` | Conversation settings → Model | `providers.models` | `chat.read` | session's saved endpoint | `remote.test.ts` | Both | — |
| F07 | Ollama server-pinned models and labels | `qml/NewSession.qml` | Model list | `providers.models` | granted Ollama host | host pinned per session | `remote.test.ts` | Both | — |
| F08 | Idle model/tools configuration | `qml/SessionModelDialog.qml` | Conversation settings | `sessions.configure` | `chat.write` | `configRevision` | `remote.test.ts` | Both | — |
| F09 | CLI history import/resume | `qml/SessionList.qml` history (Codex, Claude) | Sessions → Import desktop history (Codex, Claude Code) | `sessions.history` (`provider`), `sessions.import` | `providers.execute` + `chat.write`; Claude needs restricted mode | single-use ticket | `remote.test.ts` ("phone operations without a dedicated test…") | Both | AntiGravity has no history listing on either device. A Claude conversation imported from the phone runs in restricted mode. |
| F10 | Linked terminal restriction | `qml/Chat.qml` | "Linked terminal session · continue on the PC" | session `mode` | `chat.read` | — | `remote.test.ts` | Both | — |
| F11 | Focus linked terminal | `qml/Chat.qml` "Open terminal" | "Open on desktop" | `sessions.focusTerminal` | `desktop.control` + windows | window revalidated | `remote.test.ts` ("…opens a linked terminal…") | Both | — |
| F12 | Cross-provider handoff | `qml/BranchDialog.qml` | Handoff draft | `sessions.handoffPreview`, `sessions.handoffCreate` | `chat.write` | source digest | `remote.test.ts` | Both | — |
| F13 | Rename, disconnect/resume | Session menu | Conversation settings | `sessions.rename`, `sessions.disconnect` | `chat.write` | `revision` | `remote.test.ts` | Both | — |
| F14 | Streaming and status | `qml/Chat.qml` | Chat timeline | `message.upsert`, session upserts | `chat.read` | message `revision` | `ConversationContentTest.kt`, `fanout.test.ts` | Both | — |
| F15 | Stop and delegated cancellation | Stop | Stop | `sessions.stop` | `chat.read` | — | `remote.test.ts`, `jobs.test.ts` | Both | — |
| F16 | Saved drafts and debounce | Composer | Composer | `drafts.put` | `chat.write` | `draftRevision` | `remote.test.ts`, `ReconciliationTest.kt` | Both | — |
| F17 | Scroll and follow | `qml/Chat.qml` | Chat timeline | — | — | per-phone position | `ConversationContentTest.kt` | Phone adapted (on-device) | — |
| F18 | Image attachments (four) | Composer | Attach → Photo, Screenshot or file, Camera | `attachments.*` | `attachments.write` | SHA-256 + offsets | `remote.test.ts` ("media binary upload validates…"), `CacheIntegrityTest.kt` | Both | — |
| F19 | Markdown rendering | `qml/MessageCard.qml` | Markdown | — | — | — | `ConversationContentTest.kt`, `CitationsTest.kt` | Both | — |
| F20 | Copy and selection | Message menu | Copy | — | — | — | `ConversationContentTest.kt` | Both | — |
| F21 | Links and sources | `qml/MessageCard.qml` | Links, Sources | message `sources` | — | — | `mobile-conformance.test.ts`, `ConformanceTest.kt` | Phone adapted | Desktop file links are not opened on the phone (they name desktop paths). |
| F22 | Activity panel | `qml/ActivityPanel.qml` | Activity | `activity.page` | `chat.read` | continuation cursor | `mobile-conformance.test.ts`, `ConversationContentTest.kt` | Both | — |
| F23 | Global approvals queue | `qml/CompletionInbox.qml` | Inbox | snapshot approvals | `approvals.answer` | approval `revision` | `remote.test.ts` | Both | — |
| F24 | Codex command/file approvals | `qml/ApprovalCard.qml` | Inbox card | `approvals.answer` | `approvals.provider` | digest | `remote.test.ts` | Both | — |
| F25 | Codex extra permissions | `qml/ApprovalCard.qml` | Inbox card | `approvals.answer` | `approvals.provider` | digest | `remote.test.ts` | Both | — |
| F26 | Provider questions | `qml/ApprovalCard.qml` | Inbox card | `approvals.answer` | `approvals.answer` | digest | `remote.test.ts` | Both | — |
| F27 | Primitive MCP elicitation | `qml/ApprovalCard.qml` | Inbox form | `approvals.answer` | `approvals.answer` | digest | `remote.test.ts` | Both | — |
| F28 | Unsupported requests fail closed | `qml/ApprovalCard.qml` | "Answer on the desktop" | — | — | — | `remote.test.ts` | Both (fail closed) | — |
| F29 | Claude permission bridge | `qml/ApprovalCard.qml` | Inbox card | `approvals.answer` | `approvals.provider` | digest | `remote.test.ts` | Both | — |
| F30 | Capture-sharing approval | `qml/ApprovalCard.qml` | Inbox preview | `approvals.preview`, `attachments.read` | `capture.preview` | image digest | `remote.test.ts` ("changed capture approvals stay reviewable…") | Both | — |
| F31 | Requests when the desktop UI is closed | `qml/Pet.qml` bubble | Notifications | notice events | `approvals.answer` | — | `InteractionStateTest.kt` | Phone adapted | Delivery while the screen is off depends on monitoring (W12). |
| F32 | Completion/error/timer notices | Desktop notices | Notifications | `notice` events | `chat.read` | — | `remote.test.ts` ("phones clear Unread, receive scoped completion and timer notices…") | Phone adapted | — |
| F33 | Desktop search/filters/cards | `qml/Desktop.qml` | Desktop screen | `desktop.status` | `desktop.control` | — | `remote.test.ts` | Phone adapted | — |
| F34 | App discovery | `qml/Desktop.qml` | Desktop → Apps | `desktop.apps` | `desktop.control` + apps | — | `remote.test.ts`, `desktop-services.test.ts` | Both | — |
| F35 | Launch app | `qml/Desktop.qml` | Desktop → Launch | `desktop.execute` `apps.launch` | apps | entry revalidated | `desktop-services.test.ts` | Both | — |
| F36 | Open file/folder | `qml/Desktop.qml` | Desktop → Open | `desktop.execute` `files.open` | files | realpath inside project | `desktop-services.test.ts`, `remote.test.ts` | Both | Phone limited to granted projects. |
| F37 | List/focus windows | `qml/Desktop.qml` | Desktop → Windows | `desktop.windows`, `desktop.execute` | windows | address revalidated | `desktop-hyprland.test.ts` | Both | — |
| F38 | Move window, switch workspace | `qml/Desktop.qml` | Desktop → Move, Workspace | `desktop.execute` | windows | — | `desktop-hyprland.test.ts` | Both | — |
| F39 | Volume and mute | `qml/Desktop.qml` | Desktop → Sound | `desktop.execute` `audio.*` | audio | read back | `desktop-services.test.ts` | Both | — |
| F40 | MPRIS status | `qml/Desktop.qml` | Desktop → Media | `desktop.status` | media | player identity | `desktop-services.test.ts` | Both | — |
| F41 | Playback | `qml/Desktop.qml` | Desktop → Media | `desktop.execute` `media.control` | media | exact player | `desktop-services.test.ts` | Both | — |
| F42 | Timers | `qml/Desktop.qml` | Desktop → Timers | `desktop.execute` `timer.start`, `timers.cancel` | timers | project-scoped timers | `remote.test.ts` | Both | The desktop owns firing; the phone mirrors notices. |
| F43 | Capture with grim/Satty | `qml/Desktop.qml` | Desktop → Capture | `captures.start`, `captures.status` | capture | job state | `remote.test.ts` | Both | — |
| F44 | Capture preview/attach/dismiss | `qml/Desktop.qml` | Capture review | `captures.preview`, `captures.attach`, `captures.discard` | `capture.preview`, `attachments.write` | image digest | `remote.test.ts` | Both | — |
| F45 | Run saved scripts | `qml/Desktop.qml` | Desktop → Scripts | `desktop.execute` `script.run` | scripts + ID grant | definition digest | `remote.test.ts`, `review-core.test.ts` | Both | — |
| F46 | Edit saved scripts | `qml/ScriptsSettings.qml` | — | — | — | — | `review-core.test.ts` | Desktop only | Executable editing is local administration. |
| F47 | Provider orchestration | Agent cards | Agents in Activity; Stop | PAL tools in phone turns | `providers.execute` | child inherits phone caps | `remote.test.ts` | Both | — |
| F48 | Ollama tool loops and recovery | `qml/Chat.qml` | Chat | `sessions.send` | `chat.write` | — | `ollama.test.ts`, `remote.test.ts` | Both | — |
| F49 | Permission profiles and categories | `qml/PermissionCenter.qml` | Settings → access summary | `permissions.get` | any | `scopeVersion` | `mobile-conformance.test.ts` | Phone read | — |
| F50 | Change profile/categories | `qml/PermissionCenter.qml` | — | — | — | — | `review-core.test.ts` | Desktop only | Expanding authority is local. |
| F51 | Broad grants list/revoke | `qml/PermissionCenter.qml` | Settings → Reduce access | `permissions.get`, `permissions.reduce` | any | `scopeVersion` | `remote.test.ts` ("mobile permission reduction…") | Phone read + reduce | — |
| F52 | Create/extend grants | `qml/PermissionCenter.qml` | — | — | — | — | `review-core.test.ts` | Desktop only | — |
| F53 | Pause and revocation | `qml/PermissionCenter.qml` | Pause desktop actions, Forget this desktop | `permissions.pause`, `devices.selfRevoke` | any | — | `remote.test.ts` ("phone operations without a dedicated test…") | Both | — |
| F54 | Resume privileges | `qml/PermissionCenter.qml` | — | — | — | — | `power.test.ts` | Desktop only | — |
| F55 | Bypasses | `qml/PermissionCenter.qml` | — | — | — | — | `remote.test.ts` | Desktop only | Only the desktop owner can enable bypasses. The CLI prompt exception described above requires both live grants. |
| F56 | MCP capability token | — | — | — | — | — | `providers.test.ts` | Desktop only | Never leaves the desktop. |
| F57 | Personality | `qml/PersonalitySettings.qml` | Settings → Defaults | `settings.patch` | `settings.write` | `settingsRevision` | `remote.test.ts` | Both | — |
| F58 | Provider availability/models | `qml/ApplicationSettings.qml` | New conversation | snapshot `providers`, `providers.models` | `chat.read` | — | `remote.test.ts` | Both | — |
| F59 | Endpoint and CLI auth editing | `qml/OllamaConnection.qml`, `qml/ApiConnection.qml` | Full access: Settings › This computer › Keys and connections | `owner.connections.*`, `owner.credentials.set` | full access | connection `revision` | `api-providers.test.ts` | Both (full access); Desktop only (limited) | Keys are write-only from a phone. CLI sign-ins stay on the desktop. |
| F60 | Web search enable/provider | `qml/AssistanceSettings.qml` | Settings → Web search provider | `settings.patch` `searchProvider` | `settings.write` | `settingsRevision` | `remote.test.ts` | Phone read + provider choice | Turning web search on widens outbound use: desktop only. |
| F61 | Search web toggle | Composer | Composer | `sessions.send` | `web` | per message | `MobileCapabilitiesTest.kt` | Both | — |
| F62 | Automatic web tools and sources | Chat | Chat sources | tools in turns | `web` | — | `web-trace.test.ts`, `ConformanceTest.kt` | Both | — |
| F63 | Public HTTP reader limits | — | — | broker `web.ts` | — | — | `web-plan.test.ts` | Both (same broker) | — |
| F64 | SearXNG endpoint | `qml/AssistanceSettings.qml` | — | — | — | — | `web-plan.test.ts` | Desktop only | Endpoint editing. |
| F65 | Graph memory scope | `qml/GraphMemoryInspector.qml` | Project memory | `memory.list` | `memory.read` + memory server | project + server scope | `remote.test.ts` ("project memory is shared…") | Both (all providers) | — |
| F66 | Observations, facts, provenance | Inspector | Project memory, "Show history and evidence" | `memory.list`, `memory.timeline` | `memory.read` | graph revision | `remote.test.ts` | Both | `memory.inspect` exists in the protocol but the phone shows evidence through history. |
| F67 | Lists and filters | Inspector | Browse | `memory.list` | `memory.read` | offset pages | `remote.test.ts` | Both | — |
| F68 | Save/edit note | `qml/MemoryDialog.qml` | Remember a fact, Review & save | `memory.save` | `memory.write` | expected revision | `remote.test.ts`, `memory-providers.test.ts` | Both | — |
| F69 | Recall and coverage | Inspector | Recall | `memory.retrieve` | `memory.read` | — | `remote.test.ts` | Both | — |
| F70 | Temporal history | Inspector | Show history and evidence | `memory.timeline` | `memory.read` | — | `remote.test.ts` | Both | — |
| F71 | Correct/resolve conflict | Inspector | Correct, This one is right | `memory.correct`, `memory.resolveConflict` | `memory.write` | expected revision + statement | `remote.test.ts` | Both | Structured new claims from the phone are not offered (notes only). |
| F72 | Identity decisions | Inspector | Same/not same/possible | `memory.identity` | `memory.write` | statement witness | `remote.test.ts` | Both | — |
| F73 | Identity merge/split, task binding | Inspector (identity decisions, undo); Chat header (conversation task) | Project memory → Identity decisions; Conversation settings → Task (full access) | `memory.identity`, `memory.identities`, `memory.identityUndo`; full access: `owner.sessions.tasks`, `owner.sessions.workOn` | `memory.write`; full access for tasks | statement witness; expected revision; task scope enforced | `task-binding.test.ts`, `MemoryTaskTest.kt` | Both | Choosing a conversation's task needs full access. |
| F74 | Episodes | Inspector | Freeze this episode | `memory.freezeEpisode` | `memory.write` | — | `remote.test.ts` | Both (freeze) | Consolidate, archive and topics stay on the desktop inspector. |
| F75 | Forget preview and receipts | Inspector | Preview what will be forgotten, receipts | `memory.forgetPreview`, `memory.forget`, `memory.erasureStatus` | `memory.write` | selection + revision | `remote.test.ts`, `CacheIntegrityTest.kt` | Both | — |
| F76 | Clear project memory | Inspector | Clear this project | `memory.clear` | `memory.write` | project confirmation | `remote.test.ts` | Both | — |
| F77 | Memory diagnostics | `qml/Health.qml` | Memory health line | `memory.health` | `memory.read` | — | `remote.test.ts` | Phone read (sanitized) | — |
| F78 | Model and cloud policy | Memory settings | — | — | — | — | `memory-providers.test.ts` | Desktop only | — |
| F79 | Collector/retention policy | Memory settings | — | — | — | — | `workspace.test.ts` | Desktop only | — |
| F80 | Workspace snapshot | Workspace card | Desktop → Desktop workspace | `desktop.workspace` | `desktop.control` | fresh only | `remote.test.ts` | Phone read (scoped) | — |
| F81 | Hyprland collector | — | — | desktop collectors | — | — | `workspace.test.ts` | Desktop only | Observations never leave the desktop raw. |
| F82 | Fish lifecycle events | — | — | desktop hook | — | — | `workspace.test.ts` | Desktop only | — |
| F83 | Kitty inspection | — | — | desktop endpoint | — | — | `workspace.test.ts` | Desktop only | — |
| F84 | Repository metadata | — | — | desktop roots | — | — | `workspace.test.ts` | Desktop only | — |
| F85 | Editor collector | `qml/CollectorPolicy.qml` (off by default) | — | desktop emitter (`adapters/editor`) | approved folders | expiring observations | `collectors.test.ts` | Desktop only | Path and kind of event only, never text. Real Vim was checked; Neovim's script ran against a stub, because Neovim is not installed here. |
| F86 | Reindex/rebuild | Memory settings | — | — | — | — | `memory-optimization.test.ts` | Desktop only | — |
| F87 | Memory backup/restore | `qml/Recovery.qml` | — | — | — | — | `memory-migration-backup.test.ts` | Desktop only | — |
| F88 | Graph-memory CLI and services | `tools/` | — | — | — | — | `memory-adapters.test.ts` | Desktop only | — |
| F89 | Persistence | — | Encrypted cache | snapshot/reconcile | — | cache epoch | `CacheIntegrityTest.kt`, `ReconciliationTest.kt` | Both (desktop authoritative) | — |
| F90 | Restart behavior | — | Reconcile after reconnect | `commands.status` | — | command ledger | `broker-restart.test.ts`, `shutdown.test.ts` | Both | — |
| F91 | Pet scale/position | `qml/MotionSettings.qml` | — | — | — | — | `ui.cpp` | Desktop only | Window placement. |
| F92 | Roaming/drag/gaze | `qml/Pet.qml` | — | — | — | — | `ui.cpp` | Desktop only | — |
| F93 | Expression from state | `qml/PALPortrait.qml` | Still status portrait | `desktop.portrait` | `chat.read` | sheet digest | `portrait-state.test.ts`, `PortraitStateTest.kt`, `remote.test.ts` | Phone adapted | Static only. |
| F94 | Desktop quiet/motion/cues | `qml/MotionSettings.qml` | — | — | — | — | `ui.cpp` | Desktop only | — |
| F95 | Phone presentation choices | — | Settings → On this phone | — | — | on-device | `PortraitStateTest.kt` | Phone adapted (on-device) | Desktop quiet never suppresses phone approvals. |
| F96 | Autostart and onboarding | `README.md`, installer | — | — | — | — | — | Desktop only | — |
| F97 | Tray quit vs Stop and quit | `qml/Shell.qml` | — | — | — | — | `shutdown.test.ts` | Desktop only | — |
| F98 | Keyboard shortcuts, tooltips | `qml/Shell.qml` | — | — | — | — | `ui.cpp` | Desktop only | Touch equivalents exist for every phone action. |

## 3. Providers

| Provider | Desktop | Phone create | Phone send | Configure | Images | Tools | Import / resume | Tested by | Disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex | managed, linked | yes (`providers.execute`; full access: always) | limited: Codex's restricted sandbox; full access: the desktop's launch policy (`owner-parity.test.ts` PAR-04/PAR-05) | model/effort when idle | yes | native | import (Codex), resume | `providers.test.ts`, `remote.test.ts` | Both |
| Claude Code | managed, linked | yes when `--restricted` is supported (full access: always) | limited: restricted mode; full access: the desktop's launch policy, Bash included | model/effort when idle | yes (copied into a private directory) | native, code-running tools off on phone | import (restricted on phone), resume | `providers.test.ts`, `remote.test.ts` | Both (restricted) |
| Ollama | managed | yes (granted host) | yes, queue while busy | model/tools when idle | per model | PAL tools limited to grants | — | `ollama.test.ts`, `remote.test.ts` | Both |
| OpenAI, Claude, Google APIs | managed | yes with `providers.api` + that provider | yes | model/tools | yes | PAL tools limited to grants | — | `api-providers.test.ts`, `remote.test.ts` ("hosted API providers…") | Both (billed; per-provider grant) |
| Compatible endpoint | managed | yes when the granted origin matches | yes | model/tools | per endpoint declaration | PAL tools | — | `api-providers.test.ts`, `remote.test.ts` | Both (origin-bound) |
| AntiGravity | managed | full access only | full access only, with the desktop launch policy | as on the desktop | no | native | resume | `antigravity.test.ts` | Full access: as on the desktop (the owner path is not yet exercised against a live `agy` session). Limited: withheld, since its headless mode cannot prove restricted execution; reading stays available. |

**CLI compatibility.** [Permissions](PERMISSIONS.md) records the last full validation (Codex 0.162.1, Claude Code 2.1.296, 2026-10-12) and the minimums PAL enforces (Codex 0.158.0, Claude Code 2.1.259). On 2026-10-20 the installed CLIs were Codex 0.163.0, Claude Code 2.1.303, Ollama 0.34.4 and AntiGravity (`agy`) 1.4.3. Two no-cost checks were added and pass on those versions: `node tools/check-codex-protocol.ts` (all 34 app-server methods PAL uses are in the schema the installed binary generates) and `node tools/check-claude-protocol.ts` (PAL's ordinary and restricted print-mode flags are accepted and the stream-json `initialize` handshake succeeds). On 2026-11-24 the installed CLIs were Codex 0.171.0, Claude Code 2.1.331 and AntiGravity 1.5.16. Both checks passed. Of 34 methods the Codex check lists one as retired, `currentTime/read`: a request Codex made of PAL and removed in 0.171.0 (openai/codex#61382), which PAL still answers for older versions. The checks establish names and handshakes, not turn semantics: a live turn per provider (billed for Claude and hosted APIs) remains the owner's choice, and the minimums are not a claim about arbitrary newer releases.

## 4. Phone operation index

Every operation the gateway accepts, regenerated by `node tools/feature-matrix.ts`. *Kind*: read; mutation (no proof) for defensive or organizational changes; signed mutation (per-action key, biometric or device credential unless the phone is trusted). *Android* names the files that call it; *Tests* the files that exercise it.

| Operation | Permission | Kind | Android | Tests |
| --- | --- | --- | --- | --- |
| `sync.open` | chat.read | read | PALRepository | browser-companion.test.ts, mobile-compatibility.test.ts, mobile-conformance.test.ts, owner-parity.test.ts, reachability.test.ts, remote-process.test.ts, remote.test.ts, time-mobile.test.ts, ConnectionDiagnosticsTest.kt, ConformanceTest.kt |
| `sync.ack` | chat.read | read | PALRepository | remote.test.ts |
| `sessions.list` | chat.read | read | MainActivity, PALRepository | mobile-conformance.test.ts, remote-rate-limits.test.ts, remote.test.ts |
| `sessions.get` | chat.read | read | WorkbenchScreen, PALRepository | browser-companion.test.ts, mobile-compatibility.test.ts, mobile-conformance.test.ts, owner-parity.test.ts, remote.test.ts, ConnectedDesktopTest.kt |
| `sessions.batch` | chat.read | read | PALRepository | mobile-conformance.test.ts, ConformanceTest.kt |
| `projects.list` | chat.read | read | — | conversation-defaults.test.ts, mobile-conformance.test.ts, owner-parity.test.ts, projects.test.ts, remote.test.ts, ConnectedDesktopTest.kt |
| `sessions.create` | chat.write | signed mutation | MainActivity, CommandOutcomes | mobile-compatibility.test.ts, mobile-conformance.test.ts, owner-parity.test.ts, remote-process.test.ts, remote-rate-limits.test.ts, remote.test.ts, ConversationSettingsTest.kt |
| `sessions.messages` | chat.read | read | PALRepository | browser-companion.test.ts, mobile-conformance.test.ts, remote.test.ts |
| `sessions.messagePart` | chat.read | read | ConversationMessage, MainActivity, PALRepository | mobile-conformance.test.ts, ConformanceTest.kt |
| `sessions.handoffPreview` | chat.read | read | MainActivity, ParitySheets, WorkbenchScreen | owner-parity.test.ts, remote.test.ts |
| `sessions.handoffCreate` | chat.write | signed mutation | MainActivity, ParitySheets, CommandOutcomes | owner-parity.test.ts, remote.test.ts |
| `sessions.history` | providers.execute | read | MainActivity, ParitySheets | owner-parity.test.ts, remote-rate-limits.test.ts, remote.test.ts |
| `sessions.import` | chat.write | signed mutation | MainActivity, ParitySheets, CommandOutcomes | owner-parity.test.ts, remote.test.ts |
| `sessions.send` | chat.write | signed mutation | MainActivity, CommandOutcomes, MobileCapabilities, PALRepository | browser-companion.test.ts, delegation-pings.test.ts, mobile-compatibility.test.ts, mobile-conformance.test.ts, owner-parity.test.ts, remote-process.test.ts, remote.test.ts, time-mobile.test.ts, ConnectedDesktopTest.kt, DesignStatesTest.kt, VoiceSettingsTest.kt, CommandOutcomesTest.kt, MobileCapabilitiesTest.kt, ReconciliationTest.kt, ProtocolTest.kt |
| `sessions.stop` | chat.read | mutation (no proof) | MainActivity, CommandOutcomes | owner-parity.test.ts, remote.test.ts |
| `sessions.disconnect` | chat.write | mutation (no proof) | ConversationSettingsSheet, CommandOutcomes | remote.test.ts, ConversationSettingsTest.kt |
| `sessions.read` | chat.read | mutation (no proof) | CommandOutcomes, PALRepository | remote.test.ts |
| `sessions.rename` | chat.write | mutation (no proof) | ConversationSettingsSheet, CommandOutcomes | mobile-conformance.test.ts, remote.test.ts, ConversationSettingsTest.kt, CommandOutcomesTest.kt |
| `sessions.organize` | chat.write | mutation (no proof) | ConversationSettingsSheet, CommandOutcomes | remote.test.ts, ConnectedDesktopTest.kt, ConversationSettingsTest.kt |
| `drafts.get` | chat.read | read | — | remote.test.ts |
| `drafts.put` | chat.write | mutation (no proof) | MainActivity, CommandOutcomes, PALRepository | mobile-conformance.test.ts, remote.test.ts, CommandOutcomesTest.kt, MobileCapabilitiesTest.kt |
| `drafts.attachmentPreview` | chat.read | read | PALRepository | mobile-conformance.test.ts, remote.test.ts |
| `messages.bookmark` | chat.write | mutation (no proof) | ConversationMessage, CommandOutcomes, PALRepository | mobile-conformance.test.ts, remote.test.ts, ConformanceTest.kt |
| `messages.bookmarks` | chat.read | read | MainActivity, PALRepository | mobile-conformance.test.ts, remote.test.ts, CrashPathsTest.kt, ConformanceTest.kt |
| `sessions.behavior` | chat.read | read | ConversationSettingsSheet | mobile-conformance.test.ts, remote.test.ts, ConversationSettingsTest.kt |
| `time.now` | chat.read | read | ClockUi | mobile-conformance.test.ts, temporal-context.test.ts, time-mobile.test.ts, ClockTest.kt, ConformanceTest.kt |
| `time.elapsed` | chat.read | read | ClockUi | mobile-conformance.test.ts, temporal-context.test.ts, temporal-persistence.test.ts, time-mobile.test.ts, ClockTest.kt, ConformanceTest.kt |
| `sessions.timeZone` | chat.write | mutation (no proof) | ClockUi | time-mobile.test.ts, ClockTest.kt |
| `workflows.status` | chat.read | read | ConversationSettingsSheet | mobile-conformance.test.ts, remote.test.ts, ConversationSettingsTest.kt |
| `workflows.pauseSchedule` | chat.write | mutation (no proof) | ConversationSettingsSheet, CommandOutcomes | remote.test.ts, ConversationSettingsTest.kt |
| `desktop.portrait` | chat.read | read | MainActivity, PALRepository | remote.test.ts |
| `sessions.focusTerminal` | desktop.control | signed mutation | MainActivity | remote.test.ts |
| `desktop.workspace` | desktop.control | read | DesktopControls | remote.test.ts |
| `memory.health` | memory.read | read | MainActivity | remote.test.ts |
| `providers.models` | chat.read | read | MainActivity, PALRepository | mobile-compatibility.test.ts, owner-parity.test.ts, remote.test.ts, ConversationSettingsTest.kt |
| `sessions.configure` | chat.write | signed mutation | ConversationSettingsSheet, CommandOutcomes | mobile-compatibility.test.ts, remote.test.ts, ConversationSettingsTest.kt |
| `approvals.list` | approvals.answer | read | — | browser-companion.test.ts, mobile-conformance.test.ts, owner-parity.test.ts, remote.test.ts, ConnectedDesktopTest.kt |
| `approvals.get` | approvals.answer | read | — | remote.test.ts |
| `approvals.answer` | approvals.answer | signed mutation | MainActivity, MonitoringService, CommandOutcomes, PALRepository | browser-companion.test.ts, mobile-conformance.test.ts, owner-parity.test.ts, reachability.test.ts, remote-process.test.ts, remote.test.ts, CrashPathsTest.kt, DesignStatesTest.kt, CommandOutcomesTest.kt, ReconciliationTest.kt |
| `approvals.preview` | capture.preview | read | MainActivity, PALRepository | remote.test.ts |
| `attachments.begin` | attachments.write | signed mutation | MainActivity, CommandOutcomes | remote.test.ts |
| `attachments.status` | attachments.write | read | PALRepository | remote.test.ts |
| `attachments.commit` | attachments.write | signed mutation | MainActivity, CommandOutcomes, PALRepository | remote.test.ts |
| `attachments.abort` | attachments.write | mutation (no proof) | CommandOutcomes, PALRepository | remote.test.ts |
| `attachments.read` | capture.preview | read | MainActivity, PALRepository | remote.test.ts |
| `commands.challenge` | any paired phone | read | PALRepository | browser-companion.test.ts, mobile-compatibility.test.ts, mobile-conformance.test.ts, owner-parity.test.ts, remote-process.test.ts, remote-rate-limits.test.ts, remote.test.ts, time-mobile.test.ts |
| `commands.status` | any paired phone | read | PALRepository | mobile-conformance.test.ts, remote-process.test.ts, remote.test.ts |
| `activity.list` | chat.read | read | MainActivity, PALRepository | mobile-conformance.test.ts, remote.test.ts |
| `activity.page` | chat.read | read | PALRepository | mobile-conformance.test.ts, ConformanceTest.kt |
| `permissions.get` | chat.read | read | — | mobile-conformance.test.ts, ConnectedDesktopTest.kt |
| `permissions.pause` | any paired phone | mutation (no proof) | MainActivity, CommandOutcomes | remote.test.ts |
| `permissions.reduce` | any paired phone | mutation (no proof) | MainActivity, CommandOutcomes | remote.test.ts |
| `devices.self` | any paired phone | read | MainActivity | mobile-conformance.test.ts, remote.test.ts, ConnectedDesktopTest.kt |
| `devices.selfRevoke` | any paired phone | mutation (no proof) | CommandOutcomes, PALRepository | browser-companion.test.ts, remote.test.ts |
| `wake.status` | any paired phone | read | PALRepository | reachability.test.ts, ReachabilityTest.kt |
| `wake.register` | any paired phone | mutation (no proof) | Reachability, PALRepository | reachability.test.ts, ReachabilityTest.kt |
| `wake.clear` | any paired phone | mutation (no proof) | PALRepository | reachability.test.ts, ReachabilityTest.kt |
| `desktop.status` | desktop.control | read | DesktopControls | remote.test.ts, ConnectedDesktopTest.kt |
| `desktop.apps` | desktop.control | read | DesktopControls | remote.test.ts |
| `desktop.windows` | desktop.control | read | DesktopControls | remote.test.ts |
| `desktop.execute` | desktop.control | signed mutation | DesktopControls, CommandOutcomes | remote-process.test.ts, remote.test.ts, CommandOutcomesTest.kt |
| `timers.cancel` | desktop.control | signed mutation | DesktopControls, CommandOutcomes | remote.test.ts |
| `captures.start` | desktop.control | signed mutation | DesktopControls, CommandOutcomes | remote.test.ts |
| `captures.status` | desktop.control | read | PALRepository | remote.test.ts |
| `captures.preview` | capture.preview | read | DesktopControls, PALRepository | remote.test.ts |
| `captures.discard` | desktop.control | mutation (no proof) | CommandOutcomes, PALRepository | remote.test.ts |
| `captures.attach` | attachments.write | signed mutation | DesktopControls, CommandOutcomes | remote.test.ts |
| `settings.get` | chat.read | read | LibraryUi, MainActivity | mobile-conformance.test.ts, remote.test.ts, time-mobile.test.ts, ConnectedDesktopTest.kt |
| `settings.patch` | settings.write | signed mutation | MainActivity, CommandOutcomes | remote.test.ts |
| `memory.list` | memory.read | read | LibraryUi, MainActivity | remote.test.ts, review-core.test.ts, ConnectedDesktopTest.kt |
| `memory.retrieve` | memory.read | read | LibraryUi, MainActivity | remote.test.ts |
| `memory.save` | memory.write | signed mutation | MainActivity, ParitySheets, CommandOutcomes | browser-companion.test.ts, memory-providers.test.ts, remote.test.ts, review-core.test.ts |
| `memory.inspect` | memory.read | read | ParitySheets | remote-rate-limits.test.ts |
| `memory.forgetPreview` | memory.write | read | MainActivity, ParitySheets | remote.test.ts |
| `memory.forget` | memory.write | signed mutation | ParitySheets, CommandOutcomes | companion-tools.test.ts, remote.test.ts |
| `memory.clear` | memory.write | signed mutation | MainActivity, ParitySheets, CommandOutcomes | remote.test.ts |
| `memory.erasureStatus` | memory.read | read | MainActivity, PALRepository | remote.test.ts |
| `memory.timeline` | memory.read | read | MainActivity, ParitySheets | remote.test.ts |
| `memory.correct` | memory.write | signed mutation | ParitySheets, CommandOutcomes | remote.test.ts |
| `memory.resolveConflict` | memory.write | signed mutation | ParitySheets, CommandOutcomes | remote.test.ts |
| `memory.identity` | memory.write | signed mutation | ParitySheets, CommandOutcomes | remote.test.ts |
| `memory.identities` | memory.read | read | ParitySheets | — |
| `memory.identityUndo` | memory.write | signed mutation | ParitySheets | — |
| `memory.freezeEpisode` | memory.write | signed mutation | ParitySheets, CommandOutcomes | remote.test.ts |
| `owner.xaiCollections.create` | owner phone | signed mutation | XaiCollectionsDialog | — |
| `owner.xaiCollections.list` | owner phone | read | XaiCollectionsDialog | — |
| `owner.xaiCollections.addDocument` | owner phone | signed mutation | XaiCollectionsDialog | provider-xai-collections.test.ts |
| `owner.xaiCollections.removeDocument` | owner phone | signed mutation | XaiCollectionsDialog | — |
| `owner.xaiCollections.attach` | owner phone | signed mutation | XaiCollectionsDialog | — |
| `owner.xaiCollections.detach` | owner phone | mutation (no proof) | XaiCollectionsDialog | — |
| `owner.xaiCollections.delete` | owner phone | signed mutation | XaiCollectionsDialog | — |
| `client.features` | any paired phone | read | PALRepository | owner-parity.test.ts |
| `devices.setSelfRole` | any paired phone | mutation (no proof) | OwnerSettings | owner-parity.test.ts |
| `owner.access` | owner phone | read | OwnerSettings | — |
| `owner.profile.set` | owner phone | signed mutation | OwnerSettings | owner-parity.test.ts |
| `owner.devices.list` | owner phone | read | OwnerSettings | — |
| `owner.devices.revoke` | owner phone | signed mutation | OwnerSettings | — |
| `owner.devices.setRole` | owner phone | signed mutation | OwnerSettings | — |
| `owner.permissions.get` | owner phone | read | OwnerSettings, WorkbenchScreen | — |
| `owner.permissions.revokeGrant` | owner phone | mutation (no proof) | OwnerExtras | — |
| `owner.power.start` | owner phone | signed mutation | OwnerSettings | owner-parity.test.ts |
| `owner.power.end` | owner phone | mutation (no proof) | OwnerSettings | owner-parity.test.ts |
| `owner.sessions.capabilities` | owner phone | signed mutation | WorkbenchScreen | — |
| `owner.sessions.delete` | owner phone | signed mutation | WorkbenchScreen | — |
| `owner.sessions.branch` | owner phone | signed mutation | WorkbenchScreen | — |
| `owner.sessions.export` | owner phone | read | WorkbenchScreen | — |
| `owner.sessions.setFolder` | owner phone | mutation (no proof) | OwnerExtras | ConversationSettingsTest.kt |
| `owner.folders.list` | owner phone | read | OwnerExtras | ConversationSettingsTest.kt |
| `owner.folders.save` | owner phone | mutation (no proof) | OwnerExtras | — |
| `owner.folders.delete` | owner phone | mutation (no proof) | OwnerExtras | — |
| `workbench.roots` | owner phone | read | OwnerSettings, WorkTools, WorkbenchScreen | owner-parity.test.ts, TerminalClientTest.kt |
| `workbench.addRoot` | owner phone | signed mutation | WorkbenchScreen | owner-parity.test.ts |
| `workbench.conversationRoot` | owner phone | signed mutation | WorkbenchScreen | — |
| `workbench.updateRoot` | owner phone | signed mutation | WorkbenchScreen | — |
| `workbench.removeRoot` | owner phone | mutation (no proof) | WorkbenchScreen | — |
| `workbench.grantEdits` | owner phone | signed mutation | WorkbenchScreen | — |
| `workbench.revokeGrant` | owner phone | mutation (no proof) | WorkbenchScreen | — |
| `workbench.browse` | owner phone | read | WorkbenchScreen | owner-parity.test.ts |
| `workbench.files.list` | owner phone | read | WorkbenchScreen | owner-parity.test.ts |
| `workbench.files.stat` | owner phone | read | — | — |
| `workbench.files.read` | owner phone | read | WorkbenchScreen | — |
| `workbench.files.text` | owner phone | read | WorkbenchScreen | owner-parity.test.ts |
| `workbench.files.find` | owner phone | read | WorkbenchScreen | — |
| `workbench.files.search` | owner phone | read | WorkbenchScreen | — |
| `workbench.changes.list` | owner phone | read | WorkbenchScreen | — |
| `workbench.changes.review` | owner phone | read | WorkbenchScreen | — |
| `workbench.changes.propose` | owner phone | signed mutation | WorkbenchScreen | owner-parity.test.ts |
| `workbench.changes.apply` | owner phone | signed mutation | WorkbenchScreen | — |
| `workbench.changes.decline` | owner phone | mutation (no proof) | WorkbenchScreen | — |
| `workbench.changes.undo` | owner phone | signed mutation | WorkTools, WorkbenchScreen | — |
| `workbench.changes.purge` | owner phone | signed mutation | WorkTools | owner-parity.test.ts |
| `workbench.changes.trash` | owner phone | read | WorkTools | owner-parity.test.ts |
| `workbench.artifacts.list` | owner phone | read | AnalysisSessionUi, TimedMediaDialog, WorkbenchScreen | — |
| `workbench.artifacts.get` | owner phone | read | CodeLabResultExplorer | owner-parity.test.ts |
| `workbench.artifacts.thumbnail` | owner phone | read | CodeLabResultExplorer, WorkbenchScreen | — |
| `workbench.artifacts.update` | owner phone | mutation (no proof) | WorkbenchScreen | — |
| `workbench.artifacts.remove` | owner phone | signed mutation | WorkTools | WorkToolsTest.kt |
| `workbench.artifacts.extract` | owner phone | signed mutation | WorkTools | WorkToolsTest.kt |
| `workbench.artifacts.useInDraft` | owner phone | mutation (no proof) | WorkTools, WorkbenchScreen | — |
| `workbench.artifacts.export` | owner phone | signed mutation | WorkTools | TimedTextTest.kt, WorkToolsTest.kt |
| `workbench.artifacts.bundle` | owner phone | signed mutation | WorkTools | — |
| `workbench.operations.list` | owner phone | read | WorkbenchScreen | — |
| `workbench.operations.get` | owner phone | read | AnalysisSessionUi, MediaUi, WorkbenchScreen | — |
| `workbench.operations.cancel` | owner phone | mutation (no proof) | WorkbenchScreen | — |
| `workbench.operations.retry` | owner phone | signed mutation | WorkTools, WorkbenchScreen | — |
| `workbench.codelab.status` | owner phone | read | WorkbenchScreen | — |
| `workbench.codelab.sample` | owner phone | mutation (no proof) | WorkbenchScreen | — |
| `workbench.codelab.grant` | owner phone | signed mutation | WorkbenchScreen | — |
| `workbench.codelab.revoke` | owner phone | mutation (no proof) | WorkbenchScreen | — |
| `workbench.codelab.preflight` | owner phone | read | WorkbenchScreen | — |
| `workbench.codelab.assist` | owner phone | signed mutation | CodeLabResultExplorer, WorkbenchScreen | — |
| `workbench.codelab.open` | owner phone | read | CodeLabResultExplorer, WorkbenchScreen | owner-codelab.test.ts |
| `workbench.codelab.library` | owner phone | read | WorkbenchScreen | — |
| `workbench.codelab.load` | owner phone | read | WorkbenchScreen | owner-codelab.test.ts |
| `workbench.codelab.export` | owner phone | signed mutation | WorkbenchScreen | — |
| `workbench.codelab.table` | owner phone | read | CodeLabResultExplorer | — |
| `workbench.codelab.exportRows` | owner phone | signed mutation | CodeLabResultExplorer | — |
| `workbench.codelab.schedule` | owner phone | signed mutation | WorkbenchScreen | — |
| `workbench.codelab.remove` | owner phone | mutation (no proof) | WorkbenchScreen | — |
| `workbench.codelab.save` | owner phone | signed mutation | WorkbenchScreen | owner-codelab.test.ts |
| `workbench.codelab.run` | owner phone | signed mutation | WorkbenchScreen | owner-codelab.test.ts |
| `workbench.operations.history` | owner phone | read | WorkbenchScreen | owner-codelab.test.ts |
| `workbench.operations.compare` | owner phone | read | WorkbenchScreen | — |
| `workbench.commands.run` | owner phone | signed mutation | WorkTools, WorkbenchScreen | — |
| `workbench.images.connections` | owner phone | read | WorkTools, WorkbenchScreen | — |
| `workbench.images.capabilities` | owner phone | read | WorkTools, WorkbenchScreen | — |
| `workbench.images.preview` | owner phone | read | WorkTools | — |
| `workbench.images.generate` | owner phone | signed mutation | WorkTools, WorkbenchScreen | WorkToolsTest.kt |
| `workbench.images.transform` | owner phone | signed mutation | WorkTools | WorkToolsTest.kt |
| `workbench.images.saveEdit` | owner phone | signed mutation | WorkbenchScreen | — |
| `workbench.images.mask` | owner phone | signed mutation | WorkTools | WorkToolsTest.kt |
| `workbench.images.sketch` | owner phone | signed mutation | WorkTools, WorkbenchScreen | — |
| `workbench.images.contactSheet` | owner phone | signed mutation | WorkTools | — |
| `workbench.images.inspect` | owner phone | read | WorkTools | WorkToolsTest.kt |
| `workbench.recordings.list` | owner phone | read | MediaUi, WorkbenchScreen | — |
| `workbench.recordings.open` | owner phone | read | MediaUi, WorkTools | TimedTextTest.kt |
| `workbench.recordings.cues` | owner phone | read | MediaUi | — |
| `workbench.recordings.transcribe` | owner phone | signed mutation | MediaUi | — |
| `workbench.recordings.correct` | owner phone | signed mutation | MediaUi | — |
| `workbench.recordings.subtitles` | owner phone | signed mutation | MediaUi | — |
| `workbench.recordings.clip` | owner phone | signed mutation | MediaUi | — |
| `workbench.documents.formats` | owner phone | read | DocumentUi | TimedTextTest.kt |
| `workbench.documents.fill` | owner phone | read | DocumentUi | — |
| `workbench.documents.save` | owner phone | signed mutation | DocumentUi | — |
| `workbench.documents.render` | owner phone | signed mutation | DocumentUi, WorkTools | TimedTextTest.kt |
| `workbench.codelab.session` | owner phone | read | AnalysisSessionUi, WorkbenchScreen | — |
| `workbench.codelab.sessionStart` | owner phone | signed mutation | AnalysisSessionUi | — |
| `workbench.codelab.sessionRun` | owner phone | signed mutation | AnalysisSessionUi | — |
| `workbench.codelab.sessionInterrupt` | owner phone | mutation (no proof) | — | — |
| `workbench.codelab.sessionClear` | owner phone | mutation (no proof) | — | — |
| `workbench.codelab.sessionRestart` | owner phone | signed mutation | — | — |
| `workbench.codelab.sessionStop` | owner phone | mutation (no proof) | — | — |
| `workbench.codelab.sessionNotebook` | owner phone | read | AnalysisSessionUi | — |
| `workbench.references.pins` | owner phone | read | References | ConversationSettingsTest.kt |
| `workbench.references.keep` | owner phone | signed mutation | References | ConversationSettingsTest.kt |
| `workbench.references.unkeep` | owner phone | mutation (no proof) | References | ConversationSettingsTest.kt |
| `workbench.images.ocr` | owner phone | read | WorkTools | WorkToolsTest.kt |
| `workbench.images.analyze` | owner phone | signed mutation | WorkTools | WorkToolsTest.kt |
| `workbench.references.search` | owner phone | read | OwnerSettings, References | ConversationSettingsTest.kt |
| `workbench.references.preview` | owner phone | read | References | — |
| `workbench.shelf` | owner phone | read | WorkTools | — |
| `transfers.download` | owner phone | read | OwnerApi | owner-parity.test.ts |
| `transfers.read` | owner phone | read | PALRepository | owner-parity.test.ts |
| `transfers.upload` | owner phone | signed mutation | OwnerApi | owner-parity.test.ts |
| `transfers.status` | owner phone | read | OwnerApi | owner-parity.test.ts |
| `transfers.commit` | owner phone | mutation (no proof) | OwnerApi | owner-parity.test.ts |
| `transfers.abort` | owner phone | mutation (no proof) | OwnerApi | — |
| `owner.settings.get` | owner phone | read | OwnerExtras, OwnerSettings, WorkbenchScreen | owner-parity.test.ts, DesignStatesTest.kt |
| `owner.settings.patch` | owner phone | signed mutation | OwnerSettings | — |
| `owner.connections.list` | owner phone | read | OwnerSettings, WorkbenchScreen | DesignStatesTest.kt |
| `owner.connections.save` | owner phone | signed mutation | OwnerSettings | — |
| `owner.connections.remove` | owner phone | signed mutation | ConnectionCare, OwnerSettings | — |
| `owner.connections.check` | owner phone | signed mutation | ConnectionCare, OwnerSettings | owner-parity.test.ts |
| `owner.connections.uses` | owner phone | read | ConnectionCare, OwnerSettings | owner-parity.test.ts |
| `owner.connections.modelEndpoints` | owner phone | read | ConversationSettingsSheet, MainActivity, ModelChoices | owner-parity.test.ts, ConversationSettingsTest.kt |
| `owner.connections.reassign` | owner phone | signed mutation | ConnectionCare | owner-parity.test.ts |
| `owner.connections.models` | owner phone | read | OwnerExtras | — |
| `owner.credentials.set` | owner phone | signed mutation | OwnerSettings | owner-parity.test.ts |
| `owner.extensions.status` | owner phone | read | OwnerSettings | — |
| `owner.extensions.restart` | owner phone | mutation (no proof) | OwnerSettings | — |
| `owner.extensions.secret` | owner phone | signed mutation | OwnerExtras | — |
| `owner.extensions.resources` | owner phone | read | OwnerExtras | — |
| `owner.extensions.prompts` | owner phone | read | OwnerExtras | — |
| `owner.extensions.oauthStart` | owner phone | signed mutation | OwnerSettings | — |
| `owner.extensions.oauthComplete` | owner phone | mutation (no proof) | MainActivity | — |
| `owner.extensions.oauthSignOut` | owner phone | signed mutation | OwnerSettings | — |
| `owner.extensions.importPreview` | owner phone | read | OwnerSettings | — |
| `owner.extensions.importApply` | owner phone | signed mutation | OwnerSettings | — |
| `owner.extensions.writes` | owner phone | read | OwnerSettings | — |
| `owner.translate` | owner phone | mutation (no proof) | WorkTools, WorkbenchScreen | WorkToolsTest.kt |
| `owner.collections.addUrl` | owner phone | signed mutation | OwnerSettings | — |
| `owner.collections.addArtifact` | owner phone | signed mutation | WorkTools | WorkToolsTest.kt |
| `owner.collections.setWatch` | owner phone | mutation (no proof) | OwnerSettings | — |
| `owner.tables.preview` | owner phone | read | WorkTools, WorkbenchScreen | WorkToolsTest.kt |
| `owner.voice.status` | owner phone | read | Voice | VoiceSettingsTest.kt |
| `owner.voice.transcribe` | owner phone | read | Voice | VoiceSettingsTest.kt |
| `owner.specialists.list` | owner phone | read | OwnerSettings | — |
| `owner.specialists.save` | owner phone | signed mutation | OwnerSettings | — |
| `owner.specialists.delete` | owner phone | signed mutation | OwnerSettings | — |
| `owner.specialists.setConcurrency` | owner phone | signed mutation | OwnerSettings | — |
| `owner.setups.list` | owner phone | read | OwnerSettings | — |
| `owner.setups.save` | owner phone | signed mutation | OwnerSettings | — |
| `owner.setups.delete` | owner phone | signed mutation | OwnerSettings | — |
| `owner.setups.preview` | owner phone | read | OwnerSettings | — |
| `owner.setups.apply` | owner phone | signed mutation | OwnerSettings | — |
| `owner.setups.start` | owner phone | signed mutation | OwnerSettings | — |
| `owner.extensions.resolveWrite` | owner phone | signed mutation | OwnerSettings | — |
| `owner.workspace.history` | owner phone | read | OwnerExtras | owner-parity.test.ts |
| `owner.workspace.historyErase` | owner phone | signed mutation | OwnerExtras | owner-parity.test.ts |
| `owner.accounts.list` | owner phone | read | AccountsUi, OwnerSettings | — |
| `owner.accounts.save` | owner phone | signed mutation | AccountsUi | — |
| `owner.accounts.remove` | owner phone | signed mutation | AccountsUi | — |
| `owner.accounts.signIn` | owner phone | signed mutation | AccountsUi | — |
| `owner.accounts.flow` | owner phone | read | — | — |
| `owner.accounts.cancel` | owner phone | mutation (no proof) | AccountsUi | — |
| `owner.accounts.signOut` | owner phone | signed mutation | AccountsUi | — |
| `owner.accounts.test` | owner phone | read | AccountsUi | — |
| `owner.accounts.calendars` | owner phone | read | — | — |
| `owner.accounts.agenda` | owner phone | read | — | — |
| `owner.accounts.mailSearch` | owner phone | read | — | — |
| `owner.accounts.mailThread` | owner phone | read | — | — |
| `owner.accounts.driveSearch` | owner phone | read | — | — |
| `owner.accounts.driveList` | owner phone | read | — | — |
| `owner.accounts.githubSearch` | owner phone | read | — | — |
| `owner.accounts.githubRead` | owner phone | read | — | — |
| `owner.accounts.import` | owner phone | signed mutation | AccountsUi | — |
| `owner.accounts.outbox` | owner phone | read | — | — |
| `owner.accounts.draft` | owner phone | signed mutation | AccountsUi | — |
| `owner.accounts.commit` | owner phone | signed mutation | AccountsUi | — |
| `owner.accounts.check` | owner phone | signed mutation | AccountsUi | — |
| `owner.accounts.discard` | owner phone | mutation (no proof) | AccountsUi | — |
| `owner.customTools.credential` | owner phone | signed mutation | OwnerExtras, OwnerSettings | — |
| `owner.schedules.list` | owner phone | read | OwnerSettings | — |
| `owner.schedules.setEnabled` | owner phone | signed mutation | OwnerSettings | — |
| `owner.schedules.delete` | owner phone | signed mutation | OwnerSettings | — |
| `owner.schedules.create` | owner phone | signed mutation | OwnerSettings | — |
| `owner.schedules.adopt` | owner phone | signed mutation | OwnerSettings | — |
| `owner.recipes.list` | owner phone | read | OwnerSettings | owner-parity.test.ts |
| `owner.recipes.prepare` | owner phone | read | OwnerSettings | owner-parity.test.ts |
| `owner.recipes.createDraft` | owner phone | signed mutation | OwnerSettings | owner-parity.test.ts |
| `owner.results.list` | owner phone | read | — | owner-parity.test.ts |
| `owner.results.verify` | owner phone | signed mutation | ConversationSettingsSheet, OwnerExtras | owner-parity.test.ts, ConversationSettingsTest.kt |
| `owner.collections.list` | owner phone | read | OwnerSettings, WorkTools | — |
| `owner.collections.create` | owner phone | signed mutation | OwnerSettings | — |
| `owner.collections.addSource` | owner phone | signed mutation | OwnerSettings | — |
| `owner.collections.removeSource` | owner phone | signed mutation | OwnerSettings | — |
| `owner.collections.bind` | owner phone | signed mutation | OwnerSettings | — |
| `owner.collections.index` | owner phone | signed mutation | OwnerSettings | — |
| `owner.sessions.tasks` | owner phone | read | OwnerExtras | ConversationSettingsTest.kt |
| `owner.sessions.workOn` | owner phone | signed mutation | OwnerExtras | ConversationSettingsTest.kt |
| `owner.collections.update` | owner phone | signed mutation | OwnerSettings | — |
| `owner.collections.search` | owner phone | read | OwnerExtras, OwnerSettings | — |
| `owner.collections.cancel` | owner phone | mutation (no proof) | OwnerSettings | — |
| `owner.collections.delete` | owner phone | signed mutation | OwnerSettings | — |
| `owner.projects.list` | owner phone | read | OwnerExtras | owner-parity.test.ts |
| `owner.projects.save` | owner phone | signed mutation | OwnerExtras | owner-parity.test.ts |
| `owner.models.local` | owner phone | read | OwnerSettings | — |
| `owner.models.pull` | owner phone | signed mutation | OwnerSettings | — |
| `owner.models.delete` | owner phone | signed mutation | OwnerExtras | — |
| `owner.models.cancelPull` | owner phone | mutation (no proof) | OwnerExtras | — |
| `owner.jobs.list` | owner phone | read | OwnerExtras | owner-parity.test.ts |
| `owner.jobs.cancel` | owner phone | mutation (no proof) | OwnerExtras | owner-parity.test.ts |
| `owner.usage.summary` | owner phone | read | OwnerSettings | — |
| `owner.usage.setPolicy` | owner phone | signed mutation | OwnerSettings | — |
| `owner.skills.list` | owner phone | read | OwnerSettings | — |
| `owner.skills.review` | owner phone | read | OwnerSettings | — |
| `owner.skills.importRepository` | owner phone | signed mutation | OwnerSettings | — |
| `owner.skills.importPath` | owner phone | signed mutation | OwnerSettings | — |
| `owner.skills.importArtifact` | owner phone | signed mutation | WorkTools | WorkToolsTest.kt |
| `owner.skills.enable` | owner phone | signed mutation | OwnerSettings | — |
| `owner.skills.disable` | owner phone | mutation (no proof) | OwnerSettings | — |
| `owner.skills.remove` | owner phone | signed mutation | OwnerSettings | — |
| `owner.research.tasks` | owner phone | read | WorkbenchScreen | owner-research.test.ts |
| `owner.media.timed.prepare` | owner phone | mutation (no proof) | MainActivity, TimedMediaDialog | — |
| `owner.media.timed.start` | owner phone | signed mutation | MainActivity, TimedMediaDialog | — |
| `owner.media.timed.poll` | owner phone | mutation (no proof) | WorkbenchScreen | — |
| `owner.media.timed.status` | owner phone | read | — | — |
| `owner.media.timed.cancel` | owner phone | mutation (no proof) | — | — |
| `owner.providerInference.run` | owner phone | signed mutation | ProviderInferenceDialog, WorkbenchScreen | — |
| `owner.providerInference.mistralOcr` | owner phone | signed mutation | ProviderInferenceDialog, WorkbenchScreen | — |
| `owner.providerBridge.status` | owner phone | read | OwnerSettings | — |
| `owner.providerBridge.stop` | owner phone | mutation (no proof) | OwnerSettings | — |
| `owner.providerBridge.chat` | owner phone | signed mutation | OwnerExtras, OwnerSettings | — |
| `owner.providerBridge.embeddings` | owner phone | signed mutation | OwnerExtras | — |
| `owner.originalFiles.upload` | owner phone | signed mutation | WorkbenchScreen | owner-parity.test.ts |
| `owner.originalFiles.remove` | owner phone | signed mutation | WorkbenchScreen | owner-parity.test.ts |
| `owner.originalFiles.list` | owner phone | read | WorkbenchScreen, XaiCollectionsDialog | owner-parity.test.ts |
| `owner.voice.transcribeArtifact` | owner phone | signed mutation | WorkbenchScreen | — |
| `owner.voice.hostedVoices` | owner phone | read | OwnerExtras | — |
| `owner.realtime.start` | owner phone | signed mutation | Voice | VoiceSettingsTest.kt |
| `owner.realtime.offer` | owner phone | read | Voice | — |
| `owner.realtime.playbackComplete` | owner phone | stream (control lease) | Voice | — |
| `owner.realtime.commit` | owner phone | stream (control lease) | Voice | — |
| `owner.realtime.interrupt` | owner phone | stream (control lease) | Voice | — |
| `owner.realtime.stop` | owner phone | mutation (no proof) | Voice | — |
| `owner.research.provider.start` | owner phone | signed mutation | PerplexityResearchJobs | owner-parity.test.ts |
| `owner.research.provider.list` | owner phone | read | PerplexityResearchJobs | owner-parity.test.ts |
| `owner.research.provider.poll` | owner phone | mutation (no proof) | PerplexityResearchJobs | owner-parity.test.ts |
| `owner.research.provider.cancel` | owner phone | signed mutation | PerplexityResearchJobs | owner-parity.test.ts |
| `owner.research.routes` | owner phone | read | WorkbenchScreen | — |
| `owner.research.cancel` | owner phone | mutation (no proof) | WorkbenchScreen | owner-research.test.ts |
| `owner.research.handoff` | owner phone | signed mutation | WorkbenchScreen | owner-research.test.ts |
| `owner.research.sources` | owner phone | read | WorkbenchScreen | — |
| `owner.research.plan` | owner phone | signed mutation | WorkbenchScreen | owner-research.test.ts |
| `owner.research.start` | owner phone | signed mutation | WorkbenchScreen | owner-research.test.ts |
| `owner.research.list` | owner phone | read | — | owner-research.test.ts |
| `owner.research.get` | owner phone | read | WorkbenchScreen | owner-research.test.ts |
| `owner.research.readReport` | owner phone | read | WorkbenchScreen | owner-research.test.ts |
| `owner.research.passage` | owner phone | read | WorkbenchScreen | owner-research.test.ts |
| `owner.research.pause` | owner phone | mutation (no proof) | WorkbenchScreen | owner-research.test.ts |
| `owner.research.stop` | owner phone | mutation (no proof) | WorkbenchScreen | owner-research.test.ts |
| `owner.research.refresh` | owner phone | signed mutation | WorkbenchScreen | owner-research.test.ts |
| `owner.research.continue` | owner phone | signed mutation | WorkbenchScreen | owner-research.test.ts |
| `owner.research.steer` | owner phone | signed mutation | WorkbenchScreen | owner-research.test.ts |
| `owner.research.ask` | owner phone | signed mutation | WorkbenchScreen | owner-research.test.ts |
| `owner.research.update` | owner phone | mutation (no proof) | WorkbenchScreen | owner-research.test.ts |
| `owner.research.export` | owner phone | mutation (no proof) | WorkbenchScreen | owner-research.test.ts |
| `owner.research.note` | owner phone | mutation (no proof) | WorkbenchScreen | owner-research.test.ts |
| `owner.research.exclude` | owner phone | mutation (no proof) | WorkbenchScreen | owner-research.test.ts |
| `owner.research.resynthesize` | owner phone | signed mutation | WorkbenchScreen | owner-research.test.ts |
| `canvas.status` | owner phone | read | WorkbenchScreen | — |
| `canvas.list` | owner phone | read | WorkbenchScreen | — |
| `canvas.open` | owner phone | signed mutation | WorkbenchScreen | canvas.test.ts |
| `canvas.frame` | owner phone | read | WorkbenchScreen | canvas.test.ts |
| `canvas.input` | owner phone | stream (control lease) | WorkbenchScreen | canvas.test.ts |
| `canvas.resize` | owner phone | mutation (no proof) | WorkbenchScreen | — |
| `canvas.reload` | owner phone | mutation (no proof) | WorkbenchScreen | canvas.test.ts |
| `canvas.console` | owner phone | read | WorkbenchScreen | — |
| `canvas.annotate` | owner phone | mutation (no proof) | WorkbenchScreen | canvas.test.ts |
| `canvas.annotations` | owner phone | read | WorkbenchScreen | canvas.test.ts |
| `canvas.screenshot` | owner phone | mutation (no proof) | WorkbenchScreen | canvas.test.ts |
| `canvas.export` | owner phone | mutation (no proof) | WorkbenchScreen | canvas.test.ts |
| `canvas.close` | owner phone | mutation (no proof) | WorkbenchScreen | canvas.test.ts |
| `owner.notebook.scratchpad` | owner phone | read | WorkbenchScreen | — |
| `owner.notebook.save` | owner phone | mutation (no proof) | WorkbenchScreen | — |
| `owner.notebook.day` | owner phone | read | WorkbenchScreen | — |
| `view.start` | owner phone | signed mutation | ViewDesktop | — |
| `view.frame` | owner phone | read | ViewDesktop | — |
| `view.input` | owner phone | stream (control lease) | ViewDesktop | — |
| `view.stop` | owner phone | mutation (no proof) | ViewDesktop | — |
| `owner.health` | owner phone | read | OwnerSettings | — |
| `owner.backup.status` | owner phone | read | OwnerSettings | — |
| `owner.backup.create` | owner phone | signed mutation | OwnerSettings | — |
| `terminal.profiles` | owner phone | read | TerminalScreen | owner-parity.test.ts |
| `terminal.create` | owner phone | signed mutation | TerminalScreen | owner-parity.test.ts, TerminalClientTest.kt |
| `terminal.list` | owner phone | read | TerminalScreen | owner-parity.test.ts |
| `terminal.get` | owner phone | read | — | — |
| `terminal.attach` | owner phone | read | TerminalScreen | — |
| `terminal.acquireControl` | owner phone | signed mutation | TerminalScreen | owner-parity.test.ts |
| `terminal.input` | owner phone | stream (control lease) | TerminalScreen | owner-parity.test.ts |
| `terminal.inputStatus` | owner phone | read | TerminalScreen | owner-parity.test.ts |
| `terminal.resize` | owner phone | stream (control lease) | TerminalScreen | — |
| `terminal.interrupt` | owner phone | mutation (no proof) | TerminalScreen | owner-parity.test.ts |
| `terminal.detach` | owner phone | mutation (no proof) | TerminalScreen | — |
| `terminal.release` | owner phone | mutation (no proof) | TerminalScreen | — |
| `terminal.forget` | owner phone | mutation (no proof) | TerminalScreen | — |
| `terminal.close` | owner phone | mutation (no proof) | TerminalScreen | owner-parity.test.ts |
| `terminal.history` | owner phone | read | TerminalScreen | — |
