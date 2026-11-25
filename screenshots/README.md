# Screenshots

These images come from PAL's real interface, captured by
[`tools/screenshots/run.sh`](../tools/screenshots/run.sh) with a scripted demo profile:

- The QML interface and broker are the ones in this repository, rendered offscreen with Qt's software
  renderer at 1× scale.
- Conversations, projects and folders are seeded demo content. Codex, Claude Code, AntiGravity and
  Ollama are local scripted fixtures, so replies show what the interface does, not real model output.
  Connected accounts and OpenRouter's model list are local stand-ins; the models and prices in that list
  are made up. Windows, volume and media playback on the Desktop page are simulated.
- Code Lab, the change review, the image tools and the transcript player are the real services, working
  on demo files.
- Desktop scenes draw PAL's own windows (pet, compact panel and bubbles) at their real positions over a
  generated wallpaper, with drop shadows added. The avatar, theme and gesture strips place several
  captures side by side on the same wallpaper. The other images are single-window captures.
- The phone images are the 2.0.2 debug app on an Android 15 emulator, paired with full access to the same
  demo profile.

## Regenerate

```sh
cmake --build build --target pal pal-screenshots
tools/screenshots/run.sh
```

The run takes about six minutes and overwrites the images in this folder; set `PAL_SCREENSHOTS_DIR`
to write elsewhere. It needs a build configured with tests (the default), unprivileged user namespaces
(`unshare`), `setpriv` from util-linux, `ip` from iproute2, `curl` and `python3`; Code Lab's pictures also need
Bubblewrap and Matplotlib, and are skipped without them. Everything runs in private user, mount, process,
host-name and network namespaces with `/home/demo` as the home folder. It reads nothing from your PAL profile, compositor,
media players or provider accounts, and it cannot reach the network.

To retake some images, name their slots from
[`tools/screenshots/capture.cpp`](../tools/screenshots/capture.cpp), for example
`tools/screenshots/run.sh settingsPages`. Slots that reuse earlier conversations need those slots as
well, for example `compactPanel themesAndAvatars`.

The phone images come from an Android emulator with the debug app and its test APK installed
(`:app:installDebug :app:installDebugAndroidTest`) and `adb` on `PATH`:

```sh
ANDROID_SERIAL=emulator-5554 tools/screenshots/run.sh --phone
```

It pairs that app with the demo desktop, so the app's data on the emulator is cleared first; connected phones
are refused. This run uses the computer's own network instead of a private one, to reach the emulator.

## On the desktop

<table>
<tr>
<td width="50%" valign="top"><a href="desktop-companion.png"><img src="desktop-companion.png" alt="PAL standing on the desktop beside her compact panel, which shows a Codex conversation about a flaky login test"></a><br><b>Desktop companion.</b> PAL beside her compact panel after a Codex run tracked down a flaky test.</td>
<td width="50%" valign="top"><a href="desktop-approval-bubble.png"><img src="desktop-approval-bubble.png" alt="A bubble beside PAL listing two permission requests: a file change with its diff and a deploy command"></a><br><b>Approvals beside the pet.</b> With every PAL window closed, a file change and a deploy command wait in a bubble that names each provider, session and project.<br><br><a href="desktop-reply-bubble.png"><img src="desktop-reply-bubble.png" alt="A bubble beside PAL showing the latest reply from a pinned conversation"></a><br><b>Pinned replies.</b> The latest reply from a pinned Ollama conversation appears beside PAL.</td>
</tr>
</table>

<table>
<tr>
<td width="33%" valign="top"><a href="compact-conversation.png"><img src="compact-conversation.png" alt="The compact panel showing a conversation"></a><br><b>Compact panel.</b> Header portrait, navigation, the conversation, Activity and the composer.</td>
<td width="33%" valign="top"><a href="compact-approval.png"><img src="compact-approval.png" alt="A command approval card in the compact panel"></a><br><b>Approval in the compact panel.</b> The command, folder and reason, with Allow once, Decline and Cancel turn.</td>
<td width="33%" valign="top"><a href="compact-desktop.png"><img src="compact-desktop.png" alt="The Desktop page in the compact panel"></a><br><b>Desktop controls.</b> Quick actions, output volume and Spotify playback in the compact panel.</td>
</tr>
</table>

## Avatars and themes

<a href="avatars.png"><img src="avatars.png" alt="The PAL robot and the other 23 companion avatars standing side by side"></a>

**Companion avatars.** The default PAL robot and the 23 other selectable appearances in their reference poses.

<a href="themes.png"><img src="themes.png" alt="The compact panel in each avatar's color theme"></a>

**Matching themes.** Saving an avatar recolors the panels, menus, conversation cards and portrait frame.

<a href="gestures.png"><img src="gestures.png" alt="PAL (Classic) in six gestures with their expression badges"></a>

**Gestures with PAL (Classic).** Wave, thinking, open-hand presentation, celebration, timid blush and the pickup flail, each
with its expression badge.

## Conversations

<table>
<tr>
<td width="50%" valign="top"><a href="workspace-conversation.png"><img src="workspace-conversation.png" alt="The expanded workspace showing a Claude Code release plan with a table"></a><br><b>Workspace.</b> A Claude Code release plan with a table.</td>
<td width="50%" valign="top"><a href="workspace-activity.png"><img src="workspace-activity.png" alt="The Activity panel listing two working subagents and test output"></a><br><b>Activity.</b> Two Codex subagents still at work after the reply, with the tool trail below.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="workspace-question.png"><img src="workspace-question.png" alt="A Codex question form with selected options"></a><br><b>Questions.</b> The first of three Codex questions, with option descriptions and room for another answer.</td>
<td width="50%" valign="top"><a href="workspace-web-sources.png"><img src="workspace-web-sources.png" alt="An Ollama reply with two web source buttons"></a><br><b>Web sources.</b> An Ollama reply with source buttons, in a pinned conversation.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="new-session.png"><img src="new-session.png" alt="The Start a conversation dialog"></a><br><b>New session.</b> Provider, project folder, model, effort, trust and temporary conversations.</td>
<td width="50%" valign="top"><a href="handoff.png"><img src="handoff.png" alt="The handoff review dialog with an editable draft"></a><br><b>Handoff.</b> Review the draft that would continue this work with another provider. Nothing is sent until you submit it.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="context-drawer.png"><img src="context-drawer.png" alt="The Conversation context dialog"></a><br><b>Context.</b> Where messages go, a rough token estimate and what the latest turn was given.</td>
<td width="50%" valign="top"><a href="completion-inbox.png"><img src="completion-inbox.png" alt="The completion inbox listing four finished runs"></a><br><b>Completion inbox.</b> Finished runs from every conversation.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="model-browser.png"><img src="model-browser.png" alt="A searchable model list in the New session dialog"></a><br><b>Model list.</b> Search and narrow a long list, with context and price. These models are made up.</td>
<td width="50%" valign="top"><a href="clock.png"><img src="clock.png" alt="The Date and time view of a conversation"></a><br><b>Date and time.</b> What the next message is told, and the conversation’s own times.</td>
</tr>
</table>

## Workbench

<table>
<tr>
<td width="50%" valign="top"><a href="workbench-files.png"><img src="workbench-files.png" alt="The Files pane listing a project folder beside a conversation"></a><br><b>Files.</b> A project folder beside the conversation that works in it.</td>
<td width="50%" valign="top"><a href="workbench-preview.png"><img src="workbench-preview.png" alt="A TypeScript file in the Preview pane"></a><br><b>Preview.</b> A file with its line numbers and version.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="workbench-changes.png"><img src="workbench-changes.png" alt="A change set with one changed file and its diff"></a><br><b>Changes.</b> An edit waits for review, with its diff.</td>
<td width="50%" valign="top"><a href="reference-picker.png"><img src="reference-picker.png" alt="The reference picker above the composer"></a><br><b>References.</b> Typing @ offers files, folders and more.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="workbench-images.png"><img src="workbench-images.png" alt="The Images pane with four pictures"></a><br><b>Images.</b> Pictures the conversation keeps.</td>
<td width="50%" valign="top"><a href="image-editor.png"><img src="image-editor.png" alt="The image editor with its tools below a screenshot"></a><br><b>Image editor.</b> Crop, annotate, mask, compare and read text.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="workbench-code-lab.png"><img src="workbench-code-lab.png" alt="Code Lab with a recipe, column choices and Python code"></a><br><b>Code Lab.</b> The sample analysis, with its columns and code.</td>
<td width="50%" valign="top"><a href="workbench-runs.png"><img src="workbench-runs.png" alt="Run history with a finished analysis, its table and its chart"></a><br><b>Runs.</b> The finished analysis with its table and chart.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="workbench-media.png"><img src="workbench-media.png" alt="A recording with playback controls and a time-coded transcript"></a><br><b>Media.</b> A recording beside its transcript.</td>
<td width="50%" valign="top"><a href="workbench-notes.png"><img src="workbench-notes.png" alt="A note about offline drafts in the Notes pane"></a><br><b>Notes.</b> A project note.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="workbench-shelf.png"><img src="workbench-shelf.png" alt="The project Shelf with conversations and recipes"></a><br><b>Shelf.</b> Other conversations and the sixteen built-in recipes.</td>
<td width="50%" valign="top"><a href="workbench-accounts.png"><img src="workbench-accounts.png" alt="An agenda in the Accounts pane"></a><br><b>Accounts.</b> The agenda of a connected calendar.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="workbench-mail.png"><img src="workbench-mail.png" alt="Mail threads in the Accounts pane"></a><br><b>Mail.</b> Threads of a connected mailbox.</td>
<td width="50%" valign="top"><a href="document-writing.png"><img src="document-writing.png" alt="The Write a document dialog with a decision record template"></a><br><b>Documents.</b> A decision record from its template.</td>
</tr>
</table>

## Research

<table>
<tr>
<td width="50%" valign="top"><a href="research-new.png"><img src="research-new.png" alt="The Start a research run form"></a><br><b>New run.</b> A question answered from chosen project sources.</td>
<td width="50%" valign="top"><a href="research-report.png"><img src="research-report.png" alt="A research report whose sentences cite saved passages"></a><br><b>Report.</b> Every sentence cites its passage.</td>
</tr>
</table>

## Organizing work

<table>
<tr>
<td width="50%" valign="top"><a href="sessions.png"><img src="sessions.png" alt="The Sessions page"></a><br><b>Sessions.</b> Filters, folders, pins and row actions.</td>
<td width="50%" valign="top"><a href="projects.png"><img src="projects.png" alt="The Projects page"></a><br><b>Projects.</b> Favorites, unread counts and per-project defaults.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="command-palette.png"><img src="command-palette.png" alt="The command palette showing favorites and recent destinations"></a><br><b>Command palette (Ctrl+K).</b> Favorites and recent destinations.</td>
<td width="50%" valign="top"><a href="command-palette-search.png"><img src="command-palette-search.png" alt="Command palette results for the word release"></a><br><b>Palette search.</b> Transcripts, sessions and open windows in one list.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="workflows.png"><img src="workflows.png" alt="The Project workflows dialog showing a project capsule"></a><br><b>Project workflows.</b> A project capsule with goal, decisions, constraints, questions and next steps.</td>
<td width="50%" valign="top"><a href="permissions.png"><img src="permissions.png" alt="The Permission Center"></a><br><b>Permission Center.</b> Power sessions, leases and PAL actions for the selected session.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="desktop.png"><img src="desktop.png" alt="The Desktop page with volume, media playback and a focus timer"></a><br><b>Desktop.</b> Quick actions, volume, media playback and a running focus timer.</td>
<td width="50%" valign="top"><a href="desktop-apps.png"><img src="desktop-apps.png" alt="Open windows with their workspaces on the Desktop page"></a><br><b>Windows and workspaces.</b> Focus open windows or move them to another workspace.</td>
</tr>
</table>

## Memory

<table>
<tr>
<td width="50%" valign="top"><a href="settings-knowledge.png"><img src="settings-knowledge.png" alt="Knowledge settings for web search and memory"></a><br><b>Knowledge.</b> Web search and memory settings.</td>
<td width="50%" valign="top"><a href="memory.png"><img src="memory.png" alt="The Project memory dialog listing four saved facts"></a><br><b>Project memory.</b> Saved facts with Evidence, Edit and Forget.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="memory-review.png"><img src="memory-review.png" alt="Project memory review showing a proposed decision and its supporting passage"></a><br><b>Memory review.</b> A decision proposed from a reply, with its supporting passage and the review choices.</td>
<td width="50%" valign="top"><a href="memory-inspector.png"><img src="memory-inspector.png" alt="The graph memory inspector showing memory health"></a><br><b>Graph memory inspector.</b> Health, workspace, policy, evidence search and structured corrections.</td>
</tr>
</table>

## Settings

<table>
<tr>
<td width="50%" valign="top"><a href="settings-companion.png"><img src="settings-companion.png" alt="Companion settings with avatar cards"></a><br><b>Companion.</b> Avatar and colors.</td>
<td width="50%" valign="top"><a href="settings-personality.png"><img src="settings-personality.png" alt="Personality settings"></a><br><b>Personality.</b> Name and conversation style.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="settings-voice.png"><img src="settings-voice.png" alt="Voice settings"></a><br><b>Voice.</b> Automatic speech for each provider, local voices and voice adjustments.</td>
<td width="50%" valign="top"><a href="settings-motion.png"><img src="settings-motion.png" alt="Motion and expressions settings with a preview of PAL"></a><br><b>Motion & expressions.</b> Idle energy and the motion preview.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="settings-connections.png"><img src="settings-connections.png" alt="Connections settings"></a><br><b>Connections.</b> The Ollama server and the command-line providers.</td>
<td width="50%" valign="top"><a href="settings-assistance.png"><img src="settings-assistance.png" alt="AI assistance settings"></a><br><b>AI assistance.</b> Permission switches and desktop categories.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="settings-scripts.png"><img src="settings-scripts.png" alt="Saved scripts settings"></a><br><b>Saved scripts.</b> Executables PAL may run after review.</td>
<td width="50%" valign="top"><a href="settings-mobile.png"><img src="settings-mobile.png" alt="PAL Mobile settings"></a><br><b>PAL Mobile.</b> Where the phone reaches this computer, and pairing by QR with the phone's answer sent back over the network.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="settings-telemetry.png"><img src="settings-telemetry.png" alt="Workspace telemetry settings"></a><br><b>Workspace telemetry.</b> Opt-in shell and file activity for chosen workspaces.</td>
<td width="50%" valign="top"><a href="settings-application.png"><img src="settings-application.png" alt="Application settings"></a><br><b>Application.</b> Shortcut, maintenance and quitting.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="settings-skills.png"><img src="settings-skills.png" alt="Skills settings with one enabled skill and one waiting for review"></a><br><b>Skills.</b> One skill on, one waiting for review.</td>
<td width="50%" valign="top"><a href="settings-setups.png"><img src="settings-setups.png" alt="Working setups settings with the built-in examples"></a><br><b>Working setups.</b> The built-in examples, applied after you see what changes.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="settings-usage.png"><img src="settings-usage.png" alt="Usage and budgets settings with totals by provider and project"></a><br><b>Usage & budgets.</b> Requests and tokens by provider, model and project.</td>
<td width="50%" valign="top"><a href="settings-accounts.png"><img src="settings-accounts.png" alt="Connected accounts in Connections settings"></a><br><b>Connected accounts.</b> GitHub and Google through apps you register.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="settings-images.png"><img src="settings-images.png" alt="Images and analysis settings"></a><br><b>Images & analysis.</b> Image backends, the vision and review helpers, and Code Lab.</td>
<td></td>
</tr>
<tr>
<td width="50%" valign="top"><a href="settings-search.png"><img src="settings-search.png" alt="Settings search results for the word voice"></a><br><b>Find a setting.</b> Search across every category.</td>
<td width="50%" valign="top"><a href="health.png"><img src="health.png" alt="The Health and recovery dialog"></a><br><b>Health and recovery.</b> The API providers show network problems here because the demo profile has no network access and no API keys.</td>
</tr>
</table>

## PAL Mobile

<table>
<tr>
<td width="33%" valign="top"><a href="mobile-chats.png"><img src="mobile-chats.png" alt="The conversation list on the phone"></a><br><b>Chats.</b> Conversations with their project, provider and model.</td>
<td width="33%" valign="top"><a href="mobile-conversation.png"><img src="mobile-conversation.png" alt="A conversation on the phone"></a><br><b>Conversation.</b> The release plan, continued from the desktop.</td>
<td width="33%" valign="top"><a href="mobile-inbox.png"><img src="mobile-inbox.png" alt="A command waiting in the phone’s Inbox"></a><br><b>Inbox.</b> A command with its project and the exact request.</td>
</tr>
<tr>
<td width="33%" valign="top"><a href="mobile-work.png"><img src="mobile-work.png" alt="The Work tab with a project folder"></a><br><b>Work.</b> A project folder with full access.</td>
<td width="33%" valign="top"><a href="mobile-voice.png"><img src="mobile-voice.png" alt="Voice settings in a conversation"></a><br><b>Voice settings.</b> Talk and read replies, from the conversation menu.</td>
<td width="33%" valign="top"><a href="mobile-computer.png"><img src="mobile-computer.png" alt="Settings, This computer"></a><br><b>This computer.</b> Desktop settings on a phone with full access.</td>
</tr>
</table>
