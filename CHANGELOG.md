# Changelog

Notable changes to PAL, the desktop application and its broker, and to PAL Mobile, its Android companion. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The desktop version is set in `package.json` and the phone's in `mobile/android/app/build.gradle.kts`. Development phone builds use `mobile-dev-vX.Y.Z` tags and stable builds use `mobile-vX.Y.Z` tags, whose GitHub release notes come from [docs/mobile/RELEASE-NOTES.md](docs/mobile/RELEASE-NOTES.md); [docs/mobile/RELEASES.md](docs/mobile/RELEASES.md) describes that process.

## [Unreleased]

## [2.0.3] - 2026-11-26

### Added

- **Model lists.** Every place that asks for a model offers a drop-down on the desktop and the phone: the account's own models for that use, the models PAL names where a service lists none, and any ID you type. A list that costs a request is loaded when it is opened.
- **Memory.** **Retry failed work** in the memory inspector, and `pal memory retry`, start failed or waiting extraction, indexing and summaries again at once.

### Fixed

- **Code Lab.** Inspecting an input no longer changes the columns that were chosen. The sample analysis could fail because its Y column moved to the first column. Columns that were not chosen are left to the recipe instead of being set to the first one.
- Scroll bars of bubbles, approvals, notes, personality and other scrolling areas lie along the right edge. They were a short thumb at the top left. A bar that has nothing to scroll is not shown and takes no clicks.
- Settings fields, boxes, sliders and the recipe list no longer lose what has not been saved when PAL's state updates. The image model box can be typed into.
- The Codex protocol check accepts Codex 0.171.0, which no longer asks PAL for the time.
- **Memory.** Forgetting a previewed record (the graph inspector, the phone, or `pal memory forget` with the preview's revision) could fail after the conversation history had already been scrubbed, whenever something else was saved to memory at the same moment, and the forgotten record stayed recallable until PAL restarted. It completes now. A forget that was cut short when memory restarted is finished by the restarted memory, and one whose record no longer exists no longer stops memory from starting.
- **Memory.** Forgotten and expired text no longer stays on disk. The search index kept the words of every forgotten passage, readable from the database file and from every later backup, and the database logs kept the text until PAL closed. Updating removes what earlier forgets left in the index.
- **Memory.** A long message scrubbed by a forget no longer leaves its text in the conversation database. The database is rewritten once when 2.0.3 first starts, which removes what earlier forgets left in its free space; on a large database this adds a few seconds to that start.
- **Memory.** A knowledge collection that cloud models may not read is no longer sent to a hosted embedding provider. Its passages were embedded by Gemini, OpenAI, Voyage or another hosted provider once cloud embedding was allowed. Collections indexed earlier are corrected when PAL starts. Withdrawing the permission while the collection is being indexed stops the indexing; index it again afterwards.
- **Memory.** A failed extraction was never tried again, so messages recorded while the extraction model was unavailable were never extracted. It is now retried after 30 seconds, then after twice as long each time, up to six hours, for at most ten attempts (about four hours). Changing the extraction settings tries such messages again.
- **Memory.** Searching memory while it was busy, for example with housekeeping or another conversation's reply, failed with a timeout, and a reply then got no recalled memory at all. The search now waits, finds what matches the words, and says the result is partial.
- **Memory.** A reply that cites evidence it was not given, such as a marker copied from an older reply, no longer marks memory as degraded or loses the record of what it was given.
- **Memory.** A message is recorded once when its reply went ahead without memory after the eight-second wait. It was recorded twice and looked like two independent sources.
- **Memory.** Forgetting also removes the text from the backup PAL takes before a memory update. The backup keeps its own schema and can still be restored; one that cannot be changed is deleted instead.
- **Memory.** A clear that was cut short is finished after a restart even when the computer's clock had been set back. It could leave the newest memories in place.
- **Memory.** A phone conversation that may not save to memory no longer gets an earlier copy of its own message back as recalled memory.
- **Memory.** Knowledge collections are no longer stored a second time as episode summaries. The copies took places in collection results that were then left out. Copies made earlier are removed.
- **Memory.** Housekeeping that removes expired memories waits while a reply is recalling memory, for ten minutes at most.
- **Memory.** Notes from the memory of very early versions that begin with the word "Assistant", such as "Assistant should answer in French", are imported as yours.

### Documentation

- The README is an overview again. Its detail moved to guides: [using PAL](docs/GUIDE.md), [providers](docs/PROVIDERS.md), [memory](docs/memory/README.md), [permissions](docs/PERMISSIONS.md), [avatars](docs/AVATARS.md) and [development](docs/DEVELOPMENT.md).
- All screenshots were retaken from 2.0.2. The gallery now also shows the Workbench, Research, documents, connected accounts, the model list, the clock, the newer Settings pages and the phone. `tools/screenshots/run.sh --phone` takes the phone images.

## [2.0.2] - 2026-11-24

### Added

- **Providers.** Dedicated Grok (xAI), Perplexity, Azure OpenAI, DeepSeek, Mistral, OpenRouter, Hugging Face, LiteLLM, Forge and Eden AI connections on desktop and Android. Conversations can bind to independent accounts and provider options. The [provider guide](docs/PROVIDERS.md) describes setup and operation-level verification.
- **Provider services.** Perplexity background research, hosted search, native PDF handles, Grok Imagine, timed media jobs, structured inference and OCR, independent hosted speech routes, and realtime voice.
- **Embeddings and imports.** More embedding and vector-store choices, Voyage reranking and Jev evaluation, a previewable Py-GPT account import, and a private database backup before migration.
- **Provider accounts.** Check an account in stages, see everything that uses it, and move that to another account before removing it, on the desktop and the phone. Setups and specialists can name the account they run on.
- **Model lists.** Search and narrow a long list, with context, price and what a model reads in words. For an OpenRouter model, see who serves it and prefer some of them. On the phone a long list no longer draws every model at once.
- **Claude, Gemini and OpenAI.** Claude can read web pages and run code at Anthropic, with the steps listed; Gemini can read pages you name and run code; OpenAI accounts can name an organization and project. Files that a provider’s code makes are kept with the conversation. Prompt caching for Claude is optional.
- **LiteLLM bridge.** PAL can install LiteLLM in a folder of its own, with exact versions and checked files, and remove it again. Replies stream, and tools and reasoning survive several rounds.
- **Time awareness.** The assistant knows the current date, time and time zone, and how long ago earlier messages were. The reading is taken again for every request PAL sends, and a message keeps its own date while it waits in a queue. Choose a fixed zone or a zone for one conversation, open the clock from the command palette or the phone, and see in **Context** what the last request was told. [Details and limits](docs/time-awareness.md).
- **Recordings.** Keep an audio or video file with a conversation and play it beside its time-coded transcript in **Workbench › Media** or on the phone. Search the transcript, correct lines as a new version, ask about the part you picked, make a clip, export SubRip or WebVTT subtitles, and translate them with their times. A time cited in a reply opens the recording there. Playing on the desktop needs `qt6-multimedia`; clips need `ffmpeg`.
- **Documents.** Write one from a template, or export a reply, a file, a conversation or a research report as PDF, Word, a web page or Markdown; on the phone, a reply or a file. The assistant can make one when asked.
- **Analysis sessions.** Python that keeps its variables between cells, inside Code Lab's isolation, with the variables listed and Clear, Restart and Stop. A result says that it can depend on earlier cells, and a notebook made from the session starts clean.
- **Document collections.** Excerpts name their lines, page, sheet or time; the same passage is given once; passages that disagree are marked and both given; a file that changed since it was indexed says so. Try a question to see what a conversation would get, include source code, rerank with Voyage, or rebuild the index.
- **Pinned sources and Context.** Pin files, folders, collections or conversations to a conversation or project: they are read again for every message and left out, with the reason, when the model may not have them. **Context** now names where messages go, the tools, skills and helper calls, and the excerpts and pins a request was given.
- **Phone.** References in messages with a preview of what they add; projects, folders, saved setups, tool-server details, standing grants and running jobs; tables, OCR, masks, contact sheets, ZIP bundles and commands in the Work tab; result verification; and the evidence behind a memory.
- **Tasks and identity in memory.** Choose the project task a conversation works on: what is said there comes first in its memory. Say whether two remembered things are the same or different, with the words that decided it, and undo the decision later, from either screen.
- **Phone, outside the app.** A Quick Settings tile for monitoring, a home-screen widget with the connection and the number of requests waiting, launcher shortcuts, and a conversation added to the home screen. None of them shows a title or answers a request, except a shortcut you name yourself.
- **Finding the desktop again.** Optional and off by default: the desktop announces its protocol version and ID on the local network, and a paired phone can search for it. An address counts only after it presents the key the phone paired with.
- **Wake-ups.** Optional and off by default: a push app you choose on the phone (UnifiedPush) tells it to connect when something waits. You allow the push server on the desktop. A hint is empty, encrypted to that phone, and cannot carry a request or an answer.
- **Accounts.** Connect GitHub, Google and Microsoft with apps you register there: the agenda, mail, files and repositories in **Workbench › Accounts** and on the phone. Keep a message, file or issue as a file of the conversation. Everything written is a draft first, shown in full and sent by its own button, once, even if an answer is lost. Let assistants read an account, or prepare changes for you to send, per project and per kind of model; off until you do. Sign in with a short code, also from the phone. A routine can deliver its result to an address or issue you name. Not tested against real accounts.
- **What PAL may observe.** Two more sources, off by default like the others: documents open in Vim, Neovim or another editor that calls the emitter, and whether the computer is locked. Kitty terminals are told apart by window and process, so a conversation sees the folder of the terminal you are in. While the screen is locked nothing is observed, and after sleep everything is unknown until it is seen again.
- **Workspace history.** Optional and off by default: which files and folders you worked on inside approved folders, and for how long, for a number of days you choose. No title, command or text is kept. Read and erase it under **Memory › Inspector** or on the phone; a folder you remove takes its history with it.
- **Code in a project.** Optional for each project: an index on this computer of what its TypeScript, JavaScript, C++ and QML declares and calls. Find code in **Context** by what it does, see what uses it and how sure that is, and tie the project’s decisions to it. Models on this computer can use it, hosted ones only if you allow it, and switching it off deletes it.
- **Browser companion.** Optional and off by default: conversations of the projects you choose in a web browser, on this computer or another. A browser is paired with a code and six words, reads and can Stop and Deny unless you let it send, never gets full access, and its pairing ends after 14 days unless you renew it on the desktop.
- **Services PAL can run.** Optional: start and stop Ollama or the memory databases from **Health**, with their log. PAL stops only what it started itself; a service someone else started is used and left alone.
- **Speech.** Keep spoken audio of saved conversations so reading it again starts at once and is not paid for twice; it goes with its message. Voice input can use a speech server on this computer that keeps its model loaded.
- **Tables for spreadsheets.** An exported result table can keep cells that look like formulas as text.
- **Notes folder.** Limit the folder to some of its subfolders, and leave notes out with a `.palignore` file.
- **Local models.** Free space where a local Ollama keeps its models, with a warning when it is low.
- **Desktop.** Run a command, restore or delete trashed files, bundle files as ZIP, check a table, translate a file or add it to a collection from its menu; review pinned replies, service manifests and the Jev model list.

### Changed

- References to a subtitle or transcript file give the model its lines with their times.
- A collection match that shares only one ordinary word with the question is marked as weak instead of standing beside real matches.
- Collections with strict answers ask more of a match by words alone.
- When a long conversation no longer fits a small model, what it was opened with keeps a place among the excerpts.
- Delegated tasks ask for the objective, files, constraints, checks and report the other assistant needs.
- Claude models are asked only for what their generation takes. A temperature or thinking budget a model would refuse is named before anything is sent, and reasoning that a changed conversation may no longer carry is left out.
- Token counts include what Claude’s cache held and what Gemini thought, so use and budgets are no longer too low.
- OpenRouter models offer their own reasoning efforts, and a model that takes no tools or does not reason is not asked to.
- Delegated results that wait for a conversation are counted in the session list and under the conversation, on both screens.
- **Voice on the phone.** The voice controls left the chat for **⋮ › Voice settings**, which gives the conversation its space back. While a note is recorded, live voice runs or a reply is read aloud, one line above the composer says so. Live voice is offered only in conversations the desktop can start it for.
- A conversation that has a named account is offered the accounts it can move to. Returning to no account was listed before and always refused.

### Fixed

- **Conversation settings on the phone.** Opening them crashed the app on a phone with full access.
- Other ways the phone app could close itself: two rows with the same key, an answer shaped differently than expected, saved screen state or a copy larger than Android accepts, a link no app opens, and very large pictures. Each is now said or left out.
- A phone sheet swiped away while it was working could leave the app unusable.
- A phone edit of a desktop file was lost when the phone was turned. It now survives with the version it started from.
- While the desktop was busy, the phone dropped answers whenever a routine update arrived in between. It asks again instead.
- On the phone, a new chat with a provider that runs only through a named account starts with that account, and a handoff lists only providers that can take it. Choosing a conversation’s current account again keeps its options.
- In a narrow conversation, as beside the Workbench, search sources, a reply style for one message or live voice could push **Send** out of view. They now move to a line of their own above it.
- The desktop could freeze when a dialog’s text needed one more line beside its scroll bar.
- A conversation’s model dialog listed no models and showed no provider options with Qt 6.12.
- Desktop forms sent what was left empty as a value: a specialist without instructions could not be added, Code Lab could not be asked about a new analysis, and accounts could not be imported without their keys.
- A phone could not connect once the desktop’s model lists together passed a megabyte.
- OpenRouter offered batch-only models for conversations, and its embedding and speech lists were empty.
- The LiteLLM bridge lost tool calls after the first round and could stop the broker with an oversized answer.
- Editing a setup on the desktop dropped its account, and a helper’s account could not be cleared.
- **Graph extraction account** in Settings was refused by the broker. It now applies, and an account in use cannot be removed.
- Realtime voice sessions receive the same instructions and personality as other conversations.
- Checking or cancelling a video or music job from the Runs pane works, and running a command reports why it was refused.
- A file kept in the first moment after PAL started, such as a resumed research report, could fail to be saved.
- A saved script's time limit set on the phone was sixty times too short.
- Lists of providers for branches, tool servers and memory review include every provider.
- A window opened after PAL started was never resolved in the workspace view.
- A model could propose an edit to a private note by writing the note’s full path.

## [2.0.1] - 2026-11-23

### Added

- **Code Lab notebooks.** On desktop or a full-access Android phone, start with the sample or pin versions of your own files. Combine Python and SQL cells, reuse unchanged steps, or share Python variables across cells in a fresh interpreter on each run.
- **Traceable analysis results.** Compare tables by key, see which customers or groups account for a change between periods, and inspect the records behind a chart. Filtering and sorting preserve the original record numbers. Export selected rows, ask the conversation model to explain one, or review a proposed code change before running it.
- **Saved analyses and replay.** Save a successful analysis for other conversations in the same project. Reopen it with the original inputs, substitute new files, or schedule it while the desktop broker is running. Export a ZIP with the code, parameters, input hashes, outputs, and a command to replay it with the original files.
- **Workbench Runs history.** Search by purpose or filename across a conversation or project, follow live output, and reopen a research report. Choose a baseline to see which inputs, code, runtime, or results changed between runs.
- **Image library.** Search conversation and project-shared images by prompt, tag, date, dimensions, or text recognized in a screenshot. Organize images into collections, find others with similar colors and layouts, and trace an edit back to its source version.
- **Image editing and chat.** Choose the exact version to edit and add separate guides for subject, style, or composition. Select a subject or background, make a transparent cutout, expand the canvas, or highlight changed pixels between versions. Select part of a screenshot to read its text locally, ask about it in chat, or draft an issue.
- **Image generation and recipes.** Follow progress, compare candidates, and see configured cost estimates and provider-reported usage in Images. Reuse a prompt or settings, branch from a result, or export a recipe with its optional source images and ComfyUI workflow.
- **Image sets and export.** Save a style kit and regenerate individual assets while keeping their approved versions. Preview icon, documentation, and slide sizes before exporting a ZIP with a contact sheet, source manifest, or originals. Inspect embedded Content Credentials locally with `c2patool`.

### Changed

- The desktop Images pane now opens an empty library with a prompt field and actions to paste, import, or sketch. Library searches include older images and earlier versions, even when they are beyond the first page.
- PAL Mobile gives assistant replies more room and keeps Send, Stop and Retry in the same place. Pairing keeps verification within reach above the keyboard, and the main screens show how to reconnect after an interruption.
- PAL replies in a neutral writing style by default. You can customize it in Personality settings.

### Fixed

- **Run failures.** Code Lab and command runs now show a failure when the process exits with an error. PAL also corrects older runs whose recorded exit status shows they failed. In Code Lab, you can inspect the failed cell and any output files collected before the error.
- **Protected image edits.** A mask stays tied to the version it was drawn on, including after a restart. If PAL cannot preserve pixels outside the mask, it holds the candidate for review before adding it to the library.
- **Mobile scrolling.** New Chat, Activity and Pinned Replies stop at the end of their content, and their handles still dismiss them. Forms keep their scroll position when the keyboard changes the available height.
- **Desktop conversation scrolling.** Vertical wheel and trackpad gestures continue through wide Markdown tables and code blocks. Choosing **Latest messages** takes you to the final reply even as Markdown finishes rendering. Scrolling back to an earlier message keeps it in place while a reply streams.
- The default PAL robot now uses the full companion animation system, including idle motion, six articulated gestures, hover and click reactions, pickup and release, blinking, and twelve expressive portrait frames.

## [2.0.0] - 2026-11-22

### Added

- **Research in the Workbench.** Plan an answer, comparison, fact-check, or literature review using web sources, project files, or both. Edit the plan, set time and source limits, and inspect the cited passages behind each finding. Pause or steer a run, finish it from the evidence already collected, or export the report as Markdown, CSV, BibTeX, or JSON. Full-access phone owners can manage these same runs from the Work tab. Research runs on the desktop.
- **A more useful Activity Log.** The desktop Timeline can be searched and filtered by event type or agent. The Subagents view shows which agents are active, finished, or need attention. Inspect an event and jump back to the latest update. On mobile, expand activity cards, copy their contents, fetch full output for a truncated entry, and load older activity.

### Changed

- **Cere is now PAL, Personal Assistant for Linux.** Desktop and Android share the 2.0.0 version and the cyan-eyed speech-bubble icon in the Linux tray and Android launcher. Desktop upgrades keep existing profiles. An Android update signed with the same key keeps its pairing and encrypted data.
- **Companion artwork.** The white robot is the new default. The previous outfit is available as **PAL (Classic)** among the 24 avatar choices.
- **Mobile header.** The number beneath **PAL** now comes from the installed Android app. Pairing with a desktop still named “Cere” no longer puts that name in the header.

### Fixed

- The desktop restores the companion if its overlay crashes. Reinstalling PAL also keeps the Wayland libraries used by the running workspace and avatar available until they exit.

## [0.1.6] - 2026-11-21

- Desktop memory can review project facts, decisions and preferences with a separately selected model. Settings support Preview, Assisted and Automatic modes, local and remote Ollama, native APIs and saved compatible endpoints.
- Retention pins now keep the evidence needed to recall a memory after its original deadline. The review inbox can forecast expiry, back up and protect a backlog, audit model decisions and undo them. Project memory statements preserve attribution and uncertainty.
- Upgraded profiles start with curation Off. See the [rollout and backlog procedure](docs/memory/operations.md#desktop-016-rollout-and-backlog-preservation) and [measured evaluation](docs/memory/evaluation.md#desktop-016-curation).

## [0.1.5] - 2026-11-20

This desktop release includes the PAL Mobile compatibility work first published in the 0.1.4 development snapshot, plus the redesigned 0.1.5 Android interface and cross-device draft reconciliation. The phone side is published through the separate `mobile-dev-v0.1.5` development channel and updates existing `.debug` development installs. Stable mobile signing and publication remain separate and require the permanent release key and the evidence in [docs/mobile/TESTING.md](docs/mobile/TESTING.md).

### Added

- **Pairing without copying.** Desktop Settings → PAL Mobile lists this computer's Tailscale and local-network addresses and the projects PAL knows, offers grant presets, and shows the pairing QR. The phone sends its signed answer back to the PC by itself, the PC shows the six words, and confirming there finishes the phone. For the QR's five minutes the gateway listens and accepts only that offer's answer; two different answers cancel it. Copying or sharing the answer remains as a fallback.
- **Connection details** on the phone: the connected or last-seen desktop build, protocol, app version and channel, last synchronization, and a copyable summary without keys, addresses, IDs or messages.
- **Typed API model IDs** on the phone, for new conversations, settings and handoffs; an endpoint without a model list is shown as such.
- `tools/mobile-upgrade-check.ts` (in-place update from a previous development snapshot) and `tools/mobile-ui-pairing-check.ts` (an R8 build paired through its own screen); `tools/mobile-paired-check.ts --pairing network`; `tools/mobile-release.ts` accepts `mobile-dev-vX.Y.Z` and writes `mobile-development.json`.
- **Responsive Android navigation and screens.** Phone destinations use a bottom bar or navigation rail as space allows. Chat, sessions, pairing, approvals, Desktop controls, settings and supporting sheets share the desktop palette, grouped surfaces, reachable actions and clearer loading, empty, success and error states. Short landscape windows, the keyboard and large fonts scroll instead of hiding required controls.
- **Adaptive launcher artwork.** Android uses the reviewed cyan PAL “C” and cream diamond as its adaptive foreground, on a navy background, with themed-icon support on Android 13 and later. The launcher treatment was checked on Android 11 and Android 15.

### Changed

- **Named compatible connections and phones (MOB-001).** A conversation is authorized against its own connection's origin and key, before every provider request; a conversation on a saved connection the phone isn't granted can be read but not sent to, configured or listed. A compatible grant can name a chosen saved connection.
- **Desktop tools for API conversations (MOB-003).** The phone sees the stored choice; changing only the model keeps it; compatible endpoints follow their declared tool support.
- **Files, Images and Analysis under phone control (MOB-005).** Continuing such a conversation from the phone first names what pauses; the desktop keeps the selection and restores it when it detaches the phone. Their results appear on the phone as cards to view on the desktop.
- The phone's "Desktop confirmed" step for manual pairing now checks with the desktop before saving the pairing.
- CI retries only plugin resolution before the mobile gates (MOB-007); the paired API 35 job pairs by network return.
- Draft synchronization now distinguishes this phone's own delayed save or accepted-send clear from a genuine desktop edit. New typing survives an in-flight save, attachment-only desktop revisions rebase without a false text conflict, stale acknowledgements cannot erase newer work, and conflict choices apply only to the revision the person reviewed.
- Android's transcript and ancillary sheets use consistent responsive widths, touch targets, headings, progress and confirmation treatment, including phone landscape and large-font layouts.

### Fixed

- Conversation settings on the phone failed for conversations without a style (MOB-002).
- A newly staged phone pairing could lose its keys, leaving "Phone pairing keys are missing" after the desktop confirmed.
- `tools/mobile-release.ts` rejected APKs whose minimum SDK aapt2 reports as `minSdkVersion`.

## [0.1.1] - 2026-11-20

The Workbench: files, images and analysis for Ollama and API conversations, built from `PAL_Workbench_Files_Images_and_API_Expansion_Handoff.md`. The user guide is [docs/WORKBENCH.md](docs/WORKBENCH.md), and [VALIDATION.md](VALIDATION.md) records its checks. This release also carries the work listed below, which was previously unreleased.

Repository remediation adds revision-safe policy commits, cancellable turn preparation, consent-bound private context, journaled collection ingestion, complete bounded operation review, process-group cleanup, byte-bounded desktop hydration, and Android stale-response fencing. Zod is pinned to 4.6.7. See [implementation and remaining gates](docs/remediation-2026-11-17.md); exhaustive audit and release validation are not complete.

The desktop and mobile review, implemented in October 2026 as work packages W01–W16. Finding IDs F01–F18 are the review's; [docs/REVIEW-VALIDATION.md](docs/REVIEW-VALIDATION.md) records the commit, tests and evidence for each, and [docs/FEATURE-MATRIX.md](docs/FEATURE-MATRIX.md) shows what the phone and the desktop each offer. The phone build from this source has not been published; a stable phone release still needs the device gates in [docs/mobile/TESTING.md](docs/mobile/TESTING.md).

### Added

- **Workbench.** Files, Preview, Changes, Images, Runs and Shelf tabs beside the conversation (**Ctrl+Shift+W**). In the compact panel they appear as one sheet. **Files**, **Images** and **Analysis** switches decide what the model is offered; you can always use the Workbench yourself. Temporary and phone-controlled conversations stay text-only.
- **Workspace folders and reviewed changes.** Each conversation can have up to 8 folders with their own permissions and processing destinations. A confined helper (`pal-workspacefs`) refuses `..`, symlinks and paths outside the folder. Browse, search, preview and edit files. Changes are applied only after review, with per-operation results, version checks, a private trash, and an undo that never overwrites a newer edit. Edit permissions can be granted for a set time.
- **Conversation files.** Imports, images, extractions and run outputs are kept as immutable, hashed versions with provenance, thumbnails, pins, project sharing and reviewed exports. Documents are extracted with locations: PDF pages, DOCX paragraphs and tables, XLSX cells, CSV, JSON, XML and HTML. Macros never run and links are never fetched. Recordings transcribed from a file also keep a timestamped WebVTT transcript.
- **Images.** Generation and edits through OpenAI, Google and your own ComfyUI server, as durable jobs. Billing must be acknowledged, and daily budgets apply. A job whose outcome is unknown is never resubmitted. An editor offers crop, annotations, masks, comparison, resize, format conversion, and versions that never change the original. A vision helper, local OCR with Tesseract, and a review helper for narrow document, change-set and research reviews are also available.
- **Code Lab, commands and Git.** Python runs isolated with bubblewrap, without network, on read-only inputs; its outputs become conversation files. Commands in a folder always ask. Git inspection is read-only. The Runs tab shows which limits are enforced on this computer.
- **References with @.** The composer's `@` picker references files, folders, conversation files, project shares, collections and other conversations in the project. Each reference is resolved and authorized at send time, with a preview line before sending. Referenced content travels apart from your words, so a later model that may not receive it loses the content but keeps your message.
- **Project shelf and Workbench recipes.** The Shelf lists what the project has collected. Eight new recipes take typed folder, file, artifact and collection inputs: Explain this project, Review configuration change, Folder cleanup plan, Document briefing, Image asset kit, Screenshot to issue report, Data to report, and Release materials.
- **Saved connections.** More Ollama hosts and OpenAI-compatible endpoints can be kept under names. Each conversation stays on its connection; moving one asks you to confirm the new destination. Per-conversation model controls cover temperature, maximum reply, context window and keep-alive.
- **HTTP tool servers.** MCP servers can be reached over Streamable HTTP, with an origin-bound bearer token and an address policy. Resources and prompt templates are browsed by the user. Image results from tools become conversation files.

- **Mobile protocol 1.1.** The desktop's welcome names the protocol (1.1), the features it offers and its exact build (version, commit and whether the source was modified). The phone uses a new option only when the desktop offers its feature, so with an older desktop those options stay hidden; a version mismatch says which side to update, and drafts stay on the phone. Response and event frames recorded from a real gateway are decoded by the Android tests, and `node tools/mobile-contract.ts --check` fails when `protocol/mobile/v1/CONTRACT.json` leaves out an operation or feature (F17).
- **Screen capture from the phone.** With Desktop control and the capture category, the phone's Desktop tab starts a capture of the desktop display (**Capture now**, or **Capture and edit on the desktop** to finish it in Satty there), previews a reduced copy and attaches exactly that image to one conversation. Nothing reaches a provider until the message is sent.
- **Desktop draft attachments on the phone.** An open conversation lists its desktop draft's attachments by name, kind, size and digest, never a path. The phone previews a text file's opening or a reduced image, keeps or removes each attachment explicitly and sends them exactly as reviewed; an attachment that changed or was not reviewed is refused.
- **Memory for every provider on the phone (F09).** Project memory follows the conversation's project on its granted memory server for Codex, Claude Code, Ollama and API conversations alike, as on the desktop. The phone adds assertion history, corrections, conflict resolution, identity decisions and episode freezing, each revision-bound and witnessed by your own statement, and a memory health line that says when recall may be incomplete while chat keeps working.
- **Pinned replies.** Star a reply on the phone to pin it. Pins are the desktop's bookmarks, and **Pinned replies** lists them across the conversations the phone can see.
- **Style and results views.** A conversation's settings on the phone show which style it uses and whether that is set for the conversation, its project or everywhere, and list its results and schedules, keeping the provider's report apart from PAL's own verification. The phone can pause a schedule, nothing more.
- **Status portrait.** The phone's header shows the desktop avatar's still portrait with the expression for the conversation's state, such as thinking, waiting for you, interrupted or reconnecting. **Settings → On this phone → Show the assistant's portrait** turns it off on that phone.
- **Workspace card and missing desktop programs.** The phone's Desktop tab shows whether the desktop is working in this project right now, from fresh workspace observations while workspace telemetry and memory are on. An **Unavailable on the desktop** panel names the desktop programs that are missing for the controls the phone may use.
- **Open on desktop.** A linked terminal conversation offers **Open on desktop**, which brings its terminal window forward on the desktop (Desktop control with the windows category).
- **Claude Code history import from the phone.** **Import desktop history** offers stopped Claude Code conversations as well as Codex ones; an imported Claude conversation continues in Claude's restricted mode.
- **Hosted APIs from the phone (F10).** OpenAI API, Claude API, Google AI API and the compatible endpoint run from a phone that holds `providers.api` and that provider's grant (desktop **Settings → PAL Mobile**). Requests use the desktop's keys and may be billed. A compatible endpoint is granted by its origin, so changing it needs a new grant. AntiGravity turns still start only on the desktop, and the phone says why.
- **Feature matrix.** [docs/FEATURE-MATRIX.md](docs/FEATURE-MATRIX.md) lists every desktop surface and the mobile plan's rows F01–F98 with the phone's status and the reason for anything that stays on the desktop, plus an operation index generated from the gateway. `tests/feature-matrix.test.ts` keeps it in step with the code.
- **Conversation states and the services gate.** [docs/CONVERSATION-STATES.md](docs/CONVERSATION-STATES.md) defines the states, outcomes and activity words both clients use, and [docs/SERVICES-GATE.md](docs/SERVICES-GATE.md) lists the check behind each secondary desktop service.
- **Health additions.** Health names missing desktop programs and the feature each one affects (**Unavailable until installed**), and says when the previous stop could not confirm that everything PAL was running had finished.
- **Checks for installs and providers.** `node tools/check-install.ts DIR [commit]` checks a staged install against its source. `node tools/check-codex-protocol.ts` and `node tools/check-claude-protocol.ts` check the installed CLIs' methods, flags and handshake without a billed turn. `node tools/mobile-paired-check.ts` pairs an emulator or device with an isolated broker and fails unless every paired test passes.

### Changed

- Backups with content include conversation files and verify their hashes on restore. Folder access, pending changes, runs and grants are never restored. Restores keep this computer's image-backend keys, usage records and saved connections. Forgetting a memory also removes conversation files whose text holds it.
- The Settings Ollama host and compatible endpoint become default named connections, migrated once without moving any key.
- Schedules for conversations that use the Workbench also check its folders, policies, image backends and Code Lab. Any change pauses the schedule.
- The broker identifies itself to Codex, Claude and MCP servers with the version from `package.json`.
- Every avatar's portrait and surface atlases were regenerated with two consistency passes. The first keeps painted details registered to the neutral illustration as the head turns and the arms and legs move (`tools/avatar-appearance.h`). The second keeps expression changes within the face (`tools/portrait-consistency.mjs`).
- New dependency: `@modelcontextprotocol/sdk` 1.32.2, pinned and loaded only for HTTP tool servers. The package lists the Workbench's optional system packages (bubblewrap, ripgrep, poppler, tesseract, numpy, matplotlib).

- **Providers are described in one place.** `broker/provider-catalog.ts` holds each provider's traits (models, effort, images, tools, web search, history import, queueing, billing and how a turn from a phone runs). The desktop and the phone build their controls and explanations from it, in the order the broker sends.
- **Faster avatar startup (F13).** The interface checks the avatar catalog from each atlas's PNG header instead of decoding all twenty atlases at startup. Offscreen on the development machine, building the interface's controller (catalog, avatars and themes) took 8.4–10.0 s with a 783 MiB memory peak before, and 9–13 ms with 42 MiB after. The shown avatar is decoded when it is displayed; artwork that then fails is set aside only after a full load confirms the failure, the next usable avatar is shown with a notice, and chat is unaffected.
- **Ordered, bounded broker shutdown (F02).** On stop, the broker refuses new local and phone changes, lets the phone gateway finish the operations it is running, then stops providers, workers, memory and speech and closes its database last, within ten seconds. The result is saved in `last-shutdown.json`, so a stop that could not confirm its work is never reported as clean.
- **Shared conversation semantics.** Both clients use the same conversation states, outcome words and activity labels, and an approval answered on either one retires exactly once.
- **Phone browsing beyond page limits (F07, F08).** Activity loads older pages, search continues past its first page and names every match, and session loading no longer stops silently after 40 pages. Replies show their sources, and the desktop's **Show memory citations in replies** setting applies to the phone's display and copy.
- **Phone robustness (F06, F11, F12).** The phone bounds inbound frames before keeping them, checks that each screen's read still belongs to the same desktop connection and transcript, makes saves durable and image writes atomic, and reports cache failures. A send that is confirmed late clears only its own text. Losing a network that does not carry the connection no longer ends it.
- **Node 24.22.0 is the minimum** (was 24), the oldest release the full suite was run on (`package.json`, the Arch package). CI pins 26.8.2.
- **Meaningful CI (F01, F14).** `desktop-check` runs the broker, native and interface jobs separately behind one final gate, runs build and test steps as an unprivileged user, uploads reports even when a step fails and lists every skipped test with its reason. `mobile-check` adds a paired job on API 30 and 35 that runs the paired-desktop tests against an isolated broker and fails unless every checkpoint passes; the emulator job alone skipped them.
- **Evidence-gated phone signing (F18).** The release workflow signs only an APK certified by a committed record, `docs/mobile/release-evidence/mobile-vX.Y.Z.json`: the unsigned APK's SHA-256, the signer, the tested commit (later commits may only add records), the desktop build, the device and OS, the tester, a test date at most 45 days old and every required gate. It also checks 16 KiB page alignment, and `mobile-release.json` names the protocol, the source commit and the evidence record.

### Fixed

- **F01:** the backup-denial test failed in CI's root container, which ignores permission bits; it now skips there with its reason, and the failure paths use faults that hold for any user.
- **F02:** test cleanup could close Core before a replacement phone gateway. Gateway close is now idempotent and lets its running operations settle before Core closes, and Core keeps its database open until running changes finish.
- **F03:** delivery to slow desktop interface clients could exceed its memory budget. It is now bounded per client and overall; a client that falls behind receives one `resync` event, or is closed, instead of an unbounded queue.
- **F04:** background indexing left an abort listener behind after each wait for foreground work.
- **F05:** a broker that stayed connected but stopped answering left controls pending indefinitely. The interface now pings the broker every 5 seconds and shows **PAL is not responding** after 15 seconds without an answer: pending requests end once with an explanation and are never resent, drafts stay, and the interface recovers when the broker answers again. Every request also has a 30-minute deadline.
- A Hyprland window action reported "window not found" as success; dispatch now requires Hyprland's `ok`.
- A pinned conversation read replies to phone-started turns aloud on the desktop.
- Restoring a backup could wait 30 seconds for an asynchronous SQLite backup under load; restore staging now uses `VACUUM INTO`.
- Claude Code was described as having no history import although the desktop imports it.

### Removed

- The `MOBILE_HARDWARE_GATES` release variable. Its mutable `passed` value could certify new code; the evidence record replaces it.

### Security

- Agents and approvals name agents by opaque HMAC references instead of native thread IDs (F17).
- A phone's grant for the compatible endpoint is bound to the granted origin, and provider keys never leave the desktop.
- Desktop draft attachments reach the phone as name, kind, size and digest only; their content is shown on request and sent only as reviewed.
- The workspace card, memory health and the list of missing programs leave out window titles, commands, paths outside the project, endpoints, model names and error text.

### Known limitations

- The Workbench's live OpenAI, Google and ComfyUI image paths and its API chat turns were verified with fixtures only; they were not run against the billed services. Small local models need the focused `files_replace_text` tool to make edits.
- Tool servers that need an OAuth sign-in are not supported; use a bearer token. Interactive HTML previews need an optional isolated module that is not included, so HTML files show their source.
- Budgets cover images per day only. There are no call, token or concurrency budgets and no price estimates.

- Device-only gates have not run: biometrics, network moves, desktop sleep and Doze, notifications, TalkBack and large text, camera and picker uploads, behavior without Google Play services, and the upgrade from the published 0.1.3 development build. Process-death fault injection on a device is not built.
- Memory remains experimental (F16): predicate precision is 88.9% against a 95% gate, and a representative evaluation is still needed.
- Phone-side capture cropping and annotation, and identity merge and split, are not built.
