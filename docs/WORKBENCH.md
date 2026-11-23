# The Workbench: files, images and analysis

The Workbench lets an Ollama or API conversation work with real files, images and analysis runs without a coding CLI. You can always use it yourself; three switches decide what the **model** is offered.

The expanded workspace opens the Workbench alongside saved conversations. Use the panel icon in the bottom-right corner of the window or press **Ctrl+Shift+W** to open or close the Workbench. PAL remembers your choice. Drag the divider to resize the pane, or focus the divider and use the arrow keys. Double-click or press **Home** to restore its default width. **Expand Workbench** gives the active pane the main area, and **Restore split view** returns to side-by-side chat.

In a narrow window, the same bottom-right button opens and closes the Workbench sheet. **Chat** returns to the composer. **Panes** folds the list of tools, and the command palette can jump directly to a tool such as **Open Notes** or **Browse project files**.

The tabs are **Files**, **Preview**, **Changes**, **Images**, **Runs**, **Terminal**, **Research**, **Canvas**, **Notes** and **Shelf**.

## What the model may use

**Model access** at the top of the Workbench controls Files, Images, Analysis and Host commands. New conversation also offers the file, image and analysis switches. The switches apply to Ollama and API conversations only. Temporary conversations stay text-only, and a conversation controlled from a phone with limited access is offered no Workbench tools; a phone with full access keeps the conversation's selection. The **Review** and **Plan** postures withhold changes, images and analysis for the turns they apply to.

- **Files** offers reading, searching, file citations, and change *proposals*. Every change waits for your review.
- **Images** offers generation, edits, deterministic transforms, inspection, OCR and image analysis through the backends you set up.
- **Analysis** offers isolated Python runs in Code Lab and commands that you approve each time.
- **Host commands** lets the model run a command as your desktop account, outside Code Lab's sandbox, with your files, keys and network. Each command follows your CLI approval (asked unless the working profile or a power session allows it), runs in its own process group with bounded output, and can be cancelled from Runs. It is never on unless you turn it on.

Small models get a focused set of tools. Advanced tools, such as the review helper, are listed in a small catalog that the model must ask for first.

## Folders and permissions (Files)

Choose a folder with **Choose folder…** or keep a private **conversation workspace**. A conversation can have up to 8 folders. Each folder has its own permissions, set with the sliders button:

- **Create and edit text files**: always through a change you review.
- **Organize**: new folders, copy, move and trash, each set reviewed.
- **Include hidden files in listings and search**: credential files, version-control internals and PAL's own data are never read.
- **Run approved commands here (Analysis)**: lets Analysis commands use the folder as their working directory.
- **Who may process its contents**: models on this computer (the default), also models on your own servers, or also cloud services. A model whose processing location is not allowed cannot read the folder. Earlier excerpts from it are withheld from that model if you switch to it later.

PAL opens files through a small helper (`pal-workspacefs`) that refuses `..`, symlinks and paths outside the folder at the kernel level. If the helper is missing, the Files tab says so and file tools stay off.

**Browse** one folder level at a time. **Filter names** filters what is listed, and **Search contents** searches file text (literal, or **Regex** when `ripgrep` is installed). Results say when a search stopped early and why. **Preview** shows text with line numbers, renders Markdown, and shows the file's version. **Edit** turns the preview into an editor; **Review change** sends your edit to the same review as a model's proposal.

## Reviewing changes

A proposal opens in **Changes** with every operation listed: created, changed, moved, copied, trashed. Text changes include their diffs. **Accept all**, **Accept selected** or **Reject**. PAL checks each file's version before applying. If a file changed after the proposal was made, that operation is refused and nothing is overwritten. Results are shown per operation. A set can end as *applied*, *partially applied*, *failed* or *outcome unknown*.

**Undo…** creates a new review of the inverse operations. It restores from backups or PAL's private trash only where nothing changed since; where something did, the earlier content comes back as a copy beside it, so no newer edit is overwritten. Trashed files are kept privately (up to 512 MiB). A folder's **Edit permission** lets PAL apply small text edits there for a time and a number of operations you choose, without asking each time; moves, trash and commands are never covered. **Revoke** ends it.

## References in the composer (@)

Type **@** in the composer to reference a file or folder from this conversation's workspace, one of its files or images, a file shared with the project, a bound document collection, or another conversation in the same project. Use the arrow keys and Enter or Tab to pick, and Escape to close. A pick becomes a chip; the text keeps only `@name`. Under the chips, PAL shows roughly how much the references add, and any reason one could not be sent, before you send.

References are resolved when you send, never by reading paths out of your text:

- A **file** is read as it is at send time. If it changed after you picked it, the message notes that the current version was used.
- A **folder** contributes a list of its entries (up to 100), not its contents.
- A **document** (PDF, DOCX, XLSX) contributes extracted text with page, sheet and cell locations. An **image** is attached when the model can see images; otherwise the model is told to use the image tools.
- A **conversation** contributes its most recent messages, attributed and bounded. Text from a conversation that ran only on this computer is not sent to a cloud model.

A reference whose processing destination does not allow this conversation's model stops the send before anything is recorded, with the reason. Referenced content travels apart from your words, so a later model that may not receive it loses the content but keeps your message.

## Files the conversation keeps (artifacts)

Images, imports, extractions and Code Lab outputs are kept as **conversation files** (artifacts). Each version is immutable and identified by its content hash. The **Images** tab lists them, with **Images** or **All files** and filters by source.

- **Import…** keeps a private copy of a file and asks which destinations may process it.
- **Save as…** writes a copy anywhere you choose. When the model exports a file into a workspace folder, that is a reviewed change that never overwrites. Exported copies are not kept in sync.
- **Pin** keeps a file on the project **Shelf**. **Share with project** makes it findable from other conversations in the same project. Sharing does not add it to prompts.
- **Remove from conversation** forgets a file here. It can also remove what was made from it (extractions, OCR text, edits saved as new files). The stored copy and its thumbnails are deleted when nothing else uses them. Exported copies elsewhere are untouched.
- Documents are read by extraction: PDF text by page (poppler), DOCX paragraphs and tables, XLSX cells (formulas are shown with their cached values; hidden sheets are left out), CSV, JSON, XML and HTML. Macros never run and external links are never fetched. Scanned pages are reported so you can use OCR on them.
- Recordings imported with **More › Transcribe a recording** also keep a timestamped transcript (WebVTT) as a conversation file.

## Images

Set up backends in **Settings › Connections › Images & analysis**:

- **OpenAI** and **Google** image APIs use the API keys in Settings. They are billed cloud services: the first request from the Workbench asks you to acknowledge billing. By default the assistant asks before each image job it wants to start; you can instead let it start jobs up to a daily number of images. Provider-side limits remain the real spending cap.
- **ComfyUI** uses your own server. Import a workflow in API format, then review the inputs PAL found (prompt, seed, size, image and mask inputs) and the nodes it uses. Workflows with cloud nodes are labeled as such. Missing models and nodes are reported by **Test**.

**Create image** works whatever the chat model can do. Choose the backend, size and the other settings it supports. **Check settings** shows what will be adjusted before anything is sent.

**View and edit** opens the image editor: move, crop (with ratios), arrows, boxes, freehand, labels, a mask brush and eraser, zoom, compare with another version, rotate, flip, resize, format conversion, and opening in another app. Every result is a new version; originals are never changed. **Use mask for an edit** sends the mask with the image. **Keep pixels outside the selection unchanged** composites the result so that only the masked area can change.

Long jobs appear in **Runs** with their state. An image job that was sent but whose result is unknown is never sent again automatically. For ComfyUI, PAL asks the server for the job's status after a restart. **Retry** asks you to confirm when the earlier attempt's outcome is unknown.

Low-memory mode (in the same settings) runs one local GPU job at a time and lets chat go first.

**Work with a specific version.** Select an image and choose **Ask about this**, **Edit this**, or **Use in chat**. An edit has one target. Other images can guide its subject, composition, or style. A saved mask belongs to the exact version it was drawn on. A protected edit that cannot be aligned is held for review. You can preview and explicitly keep the unprotected candidate. Jobs stay visible in Images, with detailed status available in Runs.

**Read and edit a region.** In the editor, choose **Select region** and drag over part of the image. **Read text** runs local Tesseract and highlights recognized lines. Copy the text, ask about the selection, or stage a screenshot issue draft in the composer. **More image tools** includes connected-color selection, transparent cutout, and canvas expansion. Click a subject against a contrasting background, or sample a connected background color, then refine the selection with the brush. You can submit arrows or boxes as a separate guide. When comparing equally sized versions, **Highlight changes** shows which pixels differ.

**Find and reuse images.** The library can show this conversation or the files shared with its project. Search names, tags, prompts, model, dimensions, transparency, dates, and previously recognized text. A search such as `lighthouse last week` also checks earlier versions. **Index image text** reads existing images on this computer. **Find similar** ranks images by their color and layout. From a derived version, **View source** opens the exact input. Project-shared images link to their source conversation when available. Select multiple versions to compare them, make a contact sheet, or open image production.

**Make and deliver a set.** In **Image production**, save a style kit with guidance, hex colors, typography, and optional image references. Share its guides with the project to make them available wherever the kit is used. Give each set member a brief on its own line. Review the destination and candidate count, then generate and approve individual members. A new candidate replaces the approved choice only when you approve it. Under **Export sizes**, preview icon, documentation, or slide sizes and inspect individual outputs at 100%. The ZIP can include a contact sheet, a manifest of source versions and parameters, and exact original files with their embedded credentials.

**Reopen a generation.** From an image with a recorded recipe, reuse its settings or replay it. Portable recipe files support transferring the settings, the ComfyUI graph where applicable, and optional source images to another installation. Choose the destination connection, review mappings and dependencies, then start the imported recipe. Hosted models can return different pixels on subsequent runs. You can set a per-image estimate and currency in the connection settings. The provider determines the actual charge. To inspect embedded signed provenance locally, install `c2patool` and choose **Inspect Content Credentials** in the editor.

## Vision, OCR and the review helper

- The **vision helper** lets a conversation whose model cannot see images ask another model about one image. Its answers are labeled as the helper's.
- **OCR** uses Tesseract on this computer, with the languages you set (for example `eng+deu`).
- The **review helper** is a second model for narrow reviews: summarizing documents, reviewing a pending change set, or summarizing research material. It receives only the inputs chosen for that request, has no tools and changes nothing. Its calls appear in Activity.

Images and files are never sent to a helper whose destination their permissions do not allow.

## Analysis: Code Lab, commands and Git

Open **Workbench › Runs › Code Lab**. If execution is off, the setup action opens **Settings › Connections › Images & analysis**. Try the sample revenue analysis to see a chart and the six records behind it. The desktop uses Python and Bubblewrap. The status panel lists the installed packages and the limits your system enforces. A full-access Android phone uses that same desktop runtime.

**Start with your data.** Open a file in Code Lab from the desktop preview or artifact library, or choose **Use in Code Lab** from the phone’s Library. Inputs are ordered and pinned to immutable versions. The first input is the “before” file in a comparison. Use the input review to inspect fields and worksheets, then choose a recipe or edit the code. The plot recipe lets you choose both axes and keeps excluded records with reasons. The keyed comparison flags duplicate or missing keys. The contribution recipe ranks groups by how much they account for a change between two periods.

**Write an analysis.** Python reads the ordered paths in `/work/inputs.json` and parameters in `/work/parameters.json`. Write result files to `/work/output`. SQLite queries see tables named `input1`, `input2`, and so on. Use `:parameter` for a named value and cast numeric fields when appropriate. The table reader supports CSV, TSV, XLSX, JSON records and JSON Lines. Parquet requires the optional DuckDB Python package. Built-in plots require Matplotlib.

**Use more than one step.** Give each cell a name and choose Python or SQL. Separate processes pass files to later cells through `/work/steps/1/`, `/work/steps/2/`, and so on. SQL can query these tables as `step1_1`, `step1_2`, etc. On a rerun, choose to reuse the unchanged prefix or start clean. **Share Python variables between cells** runs an all-Python notebook in one interpreter. Each run starts fresh. In this mode, use relative paths for cell outputs.

**Inspect and revisit a run.** Runs shows live output, cancellation and failures, including files collected before an error. Open a chart or a table from the result. Table records retain their original numbers when filtered or sorted. Use these numbers and a column name to identify the source of a claim. Search this conversation or its project by purpose or filename, choose an earlier run as the baseline, and compare inputs, code, runtime and outputs. Reopening a Code Lab run restores its method and exact input versions to the editor.

**Ask the conversation model.** With Analysis enabled in an Ollama or managed API conversation, request a plan, an explanation, or a proposed revision. Review the diff before applying it. Running the edited draft is a separate action. Model-initiated code runs show the full program for review, or use a conversation-specific grant of up to ten runs over thirty minutes. You can revoke that grant in Code Lab.

**Reuse the method.** Save a successful run as a named analysis and load it from another conversation in the same project. Replace unavailable inputs before running. A schedule runs while the broker is active, uses the latest authorized input versions, and pauses when its authorization, schema or runtime changes. The result ZIP contains code, parameters, runtime helpers, input hashes, selected output files and a replay command. Supply the original input files in manifest order to replay it on a compatible Linux machine.

Commands in a workspace folder (folder permission **Run commands**) always ask, run isolated with that folder writable, and report the files they changed. Git inspection (status, diff, log) is read-only, with hooks and external diff programs disabled.

If isolation cannot be established, for example because `bubblewrap` is not installed, Code Lab and commands are reported as unavailable instead of running unconfined.

## Project shelf and recipes

The **Shelf** tab lists what this project has collected: shared and pinned files, bound collections, the capsule's accepted decisions and tasks, other conversations and saved recipes. Each item keeps its own storage and rules. **Use in next message** adds a reference; nothing on the shelf enters a prompt by itself.

**Project workflows** includes Workbench recipes with typed inputs (a folder, file, conversation file or collection, picked rather than typed):

- **Explain this project**
- **Review configuration change**
- **Folder cleanup plan**
- **Document briefing**
- **Image asset kit**
- **Screenshot to issue report**
- **Data to report**
- **Release materials**

Each one stages real outputs, such as a change set for review, image or chart files, or a cited briefing. A recipe draft gets the folders you referenced with the same permissions, and sends exactly the references you reviewed. Schedules for conversations that use the Workbench also check its folders and their permissions, the image backends and Code Lab. Any change pauses the schedule for a fresh review.

## Connections and tool servers

**Settings › Connections › Saved connections** keeps more Ollama computers and OpenAI-compatible endpoints under names. Choose one in **New conversation**. A conversation stays on the connection it was created on; moving it to another connection asks you to confirm the new destination. The Ollama and compatible-endpoint settings above remain the defaults for new conversations. Keys are saved per endpoint address in the credentials file, never in settings.

**Settings › AI assistance › Tool servers** adds MCP servers as a program (stdio) or an **HTTP address** (Streamable HTTP):

- Internet servers need HTTPS and must resolve to public addresses.
- Mark a server as on this computer or your network to use plain HTTP or a private address.
- An optional `BEARER_TOKEN` secret is sent only to the server's own address, never across a redirect.
- Enabled HTTP servers offer **Sign in…**. When the server supports OAuth, PAL discovers its sign-in service, registers itself (or uses a client ID you enter), and opens your browser with PKCE; the browser returns to PAL on this computer. Tokens stay in the private secrets file, are used only at this address and stop working if the address changes. **Sign out** removes them. A phone with full access can sign in too; its browser returns to the app.
- **Import from another app…** reads a pasted configuration from Claude Desktop, Cursor, Claude Code (`.mcp.json`), VS Code or Zed, shows each server with its program or address, secrets and warnings, and adds the ones you choose **turned off**. Secret values go to the secrets file; nothing runs until you turn a server on.
- A tool the server does not declare read-only or idempotent is a change to something outside PAL. If its answer is lost, **Changes to check** lists it and PAL will not send the identical request again until you say whether it took effect.

Ready servers show when their tools were last listed. **Resources…** browses and reads a server's resources; **Keep in this conversation** saves one as a file. **Prompts…** fills in a server's prompt template and puts the text in the message box for you to edit. Images returned by tools become conversation files.

## Backups and phones

**Backup and restore** can include conversation files: their records always, and their contents unless you turn that off. A restore checks every file's hash. Files whose contents are missing or altered come back without their contents, and the review tells you how many. Folder access, pending changes, image and analysis runs, budgets in progress and edit grants are never restored. Tools stay paused after a restore, and a backup made before you forgot something brings back no conversation files.

A phone with limited access sees Workbench cards as text in Activity; folders, files, images, runs and Workbench settings stay on the desktop for it. A phone with full access uses the same services from its **Work** tab (files, changes, library and transfers, runs, research, canvas, notes, terminal) and **Settings › This computer**; see [the feature matrix](FEATURE-MATRIX.md) and [phone setup](mobile/SETUP.md#phones-with-full-access).

## Terminal

**Terminal** opens a real terminal on this computer: Bash, Fish, Zsh or sh, chosen explicitly (Bash is Bash even when your login shell is Fish), in a folder you pick, as your account. The broker owns it, so it keeps running when the Workbench closes or a phone disconnects, and its screen can be reopened from the desktop or a phone. One device types at a time. On the phone, **Take control** moves typing from the current controller to your keyboard. **Resume typing** reconnects a phone that already controls the shell. The desktop offers **Take control from the phone** to move typing back. Input is never stored, scrollback keeps the last 10,000 lines, and up to four terminals run at once. Closing one stops its process group and reports anything that would not stop. After PAL restarts, terminals are listed as interrupted.

## Research, Canvas and Notes

**Research** saves investigations in the project library. Ask a question, compare options, check a claim, or review literature. Quick starts with 5 minutes, 12 source attempts and 3 model calls. Thorough starts with 20 minutes, 40 source attempts and 10 calls and can follow leads from its first results. You can change these limits, draft or edit an outline, specify criteria, and choose a brief, timeline or matrix. Parallel research uses part of the Thorough call allowance to review independent questions.

Choose **Public web**, **Project sources**, or **Both**. Public search uses your question, outline and steering text, so leave private details out of these fields on web runs. Selected file, note and collection passages stay out of the public query planner. The conversation’s model receives sources allowed at its processing destination. Notes are available to local models. Reports and exports inherit the restrictions of their source material. Project-only investigations work with web search off. Research uses a saved Ollama or managed API conversation.

For web research you can enter URLs, prefer or limit sites, and request recent results. Date filtering depends on the search provider. A public literature review also searches Crossref when its domain is allowed. Bibliographic records lead to source reads. Thorough can follow reference DOIs. Pages, PDFs, selected files and tables supply cited passages. Failed reads, duplicate content, partial extraction, publication dates when available, and retrieval dates are recorded separately.

Open a report in Research or use **Read** on its conversation card. Select a citation to inspect the saved passage and its location. Findings distinguish a citation from a checked quotation or a model assessment of support. Ask follow-up questions about the saved evidence or continue the investigation to gather more. Excluding a source flags affected findings until you rewrite. Revisions keep their own evidence.

**Pause** saves the remaining work. **Finish now** saves an early report from the collected evidence. **Continue** grants another bounded period of work. Rename, pin, archive and reopen investigations across conversations in the same project. Save a finding to Notes or export a conversation file as Markdown, CSV, BibTeX or JSON. Markdown exports include linked passages so readers can check quotations outside the app. **Refresh** rechecks sources and compares the findings with the previous revision. On desktop, choose a refresh interval to monitor an investigation while the broker is running. Archiving disables its schedule.

**Canvas** shows an HTML or SVG file from a Workbench folder in an isolated browser preview (Chrome or Chromium must be installed). You can click and type in it, read its console, resize it to phone width, take screenshots, export it, and leave notes on an element; a note says which version of the page it was made on. The page cannot reach the network or PAL.

**Notes** opens the current project’s scratchpad. Use **New note** (+) to start a separate note or **Library** to find one across conversations and projects. Open the note’s **…** menu to rename or delete it. Edits autosave with revision checks. **Copy note** copies the whole note to the clipboard. Select a passage to use **Copy selection** instead. The **Daybook** groups conversations, finished runs, research and note edits by local date.

## Skills, working setups and specialists

**Settings › Skills** imports `SKILL.md` packages from a folder, a ZIP or a repository pinned to the commit it resolves to. Importing runs nothing; each version is reviewed once before it is offered, and an update waits for its own review while the reviewed version stays on. Skills never grant permissions.

**Settings › Working setups** combines a model, Workbench families, a style or posture, standing instructions, collections and skills. **Apply to this conversation…** shows exactly what changes and what is missing (a style that does not exist, a skill that is not enabled) before changing anything; **Start a conversation…** creates one with it. Setups never enable a skill or grant a permission, and an exported setup carries names and settings only. The five built-ins are examples: save a copy to change one.

**Specialists** (on the same page) are focused helpers a conversation can ask: a code reviewer, a researcher, a document editor and a visual critic, plus your own with their own model and instructions. They read only what the conversation passes them, have no tools and cannot approve anything; a document editor's edits arrive as a change set for you to review, only for the files it was given. Each run appears in **Runs** and can be cancelled; two run at a time by default (up to four).

## Translation and table previews

A conversation's model can **translate** a text, or a text file or document it can see, into a language, keeping headings, lists and tables, leaving code as it is and applying a glossary you give. A document's translation is a new file linked to its original, which is never changed. A phone opens the same from a file's **Translate** action.

A CSV or TSV file's **Columns** view (on a phone with full access, and through `tables.preview`) shows its rows, each column's inferred type and missing values, a few sample rows and parse problems before you analyze it. Cells that look like formulas stay text.

## Usage and budgets

**Settings › Usage & budgets** shows what each conversation used, from this desktop and your phones: provider-reported tokens where the provider reports them, PAL's estimate where it does not (labeled as an estimate), and unknown where neither exists; subscription CLIs are counted but not priced. A missing price is unknown, never zero. You can set prices, a warning level and a monthly limit for paid API requests; at the limit PAL stops starting new paid turns. A local limit is not a billing cap at the provider.

## Routines on folder changes

A reviewed recipe can run **when files change in a folder** of its conversation's project (Workflows › Schedule). Changes are gathered until the folder has been quiet for the chosen time, then the recipe runs once with the changed names; changes during a run wait for it. A scheduled time can also run once late when PAL was off, if you ask for that. A routine created from a phone is authorized by that phone: revoking it pauses the routine until you resume it here, or **Authorize here** first.

## Optional packages (Arch)

| Package | Used for | When missing |
| --- | --- | --- |
| `gcc` (build time) | the `pal-workspacefs` helper | Files is unavailable |
| `bubblewrap` | Code Lab, commands, PDF reading in isolation | Code Lab and commands are unavailable; PDFs are read without isolation |
| `ripgrep` | regular-expression search | literal search still works |
| `poppler` | PDF text | PDFs report that poppler is needed |
| `tesseract`, `tesseract-data-eng` (and other languages) | OCR | OCR reports it is not installed |
| `python` (with `numpy`, `matplotlib` for charts) | Code Lab | Code Lab is unavailable |
| `ffmpeg`, whisper.cpp | transcription | transcription is unavailable |

No browser engine is required. Interactive HTML previews need an optional isolated preview module that this build does not include, so HTML files show their source and nothing in them runs.
