# PAL desktop design

PAL’s workspace is a reading surface. Keep the companion visible at the edge, give the conversation the central column and let the person bring tools alongside it. Apply the saved avatar’s hue to selection, primary actions and keyboard focus. Use character artwork at its original proportions.

## Audit of the working tree

| Priority, scope and principle | Screen and evidence | Design decision |
| --- | --- | --- |
| High · every conversation · content first | Workspace and compact chat. The populated 1280 px workspace devoted 460 px to an empty file browser. Navigation, the user bubble and the idle composer all had strong outlines. See [Shell](../../qml/Shell.qml), [WorkbenchState](../../qml/WorkbenchState.qml) and [Chat](../../qml/Chat.qml). | Prioritize active work. Open supporting panes on demand, respect saved layouts and reserve the strongest outline for keyboard focus. |
| High · every turn and window switch · predictable and forgiving | In [Chat](../../qml/Chat.qml), secondary actions occupied a second toolbar. A compact/workspace round trip also dropped the selection from an intact draft. [MessageCard](../../qml/MessageCard.qml) lacked per-block copy controls. | Bound the reading measure, keep long lines selectable and keep progress, approvals and recovery actions tied to their originating session. |
| High · appearance and settings navigation · predictable and forgiving | CompanionSettings.qml places Save after 24 large cards. Settings.qml resets the scroll offset on every category change. | Keep selection and commit close together and restore each category’s place. |
| High · disconnect or missing setup · honest state | Desktop.qml calls its broker-backed shelf available during a disconnect. VoiceInput.qml offers Record when the transcription snapshot says unavailable. | Name the unavailable action and its recovery path. Keep local drafts usable. |
| Medium · most settings and action lists · clarity before decoration | CSection.qml frames nearly every settings group. CActionRow.qml repeats an initial or ornamental glyph next to each action. Fields and buttons have different heights. | Group using headings and space. Reserve outlines for interactive boundaries. |
| Medium · shared · one system | Screen QML contains hundreds of direct spacing, control-height and type literals. Avatar palettes already have named status, artwork and surface roles. | Keep the palette catalog authoritative. Consolidate layout metrics and check the token boundary with tests. |

## Surfaces and state

The native Qt Quick application targets Arch Linux with Hyprland. Qt 6.8 is the minimum. Workspace and Panel host Shell. The pet, approval bubble and tray have separate native presentation. The local broker supplies snapshots, request results, session revisions and message deltas through Controller. TranscriptModel updates individual rows. Permission decisions and provider execution remain broker-owned.

| Journey and entry point | How the interface reports state |
| --- | --- |
| Welcome and [New session](../../qml/NewSession.qml) | Welcome waits for the settings acknowledgment. Provider and model choices use advertised capabilities. Missing models, trust decisions and create errors keep the form available. |
| [Sessions](../../qml/SessionList.qml), projects and search | Distinguish an empty library, a filtered list and a pending search. Keyboard selection reveals row actions. Imported history and unavailable providers retain their identities. |
| [Conversation](../../qml/Chat.qml), attachments and voice | Hydration, revision conflict, failed uploads, unconfirmed sends and unavailable capture each have a recovery path. Background sessions keep their own pending inputs. Scrolling away from a stream exposes Latest messages. |
| [Activity](../../qml/ActivityPanel.qml) and [approvals](../../qml/ApprovalCard.qml) | Provider state drives progress and stop controls. Disclosures hold tool detail. Decisions name the request and requester and remain available after a failed reply. |
| [Workbench](../../qml/Workbench.qml) and [desktop](../../qml/Desktop.qml) | Files, changes, artifacts and local jobs have scoped selections. Empty roots explain how to choose a folder. A broker disconnect clears stale control availability. |
| [Settings](../../qml/Settings.qml) and companion | Category offsets survive navigation. Pending avatar edits, concurrent saves and errors stay beside the commit action. Knowledge, voice, pairing and connection setup expose their own readiness. |
| Compact panel, pet, tray and approval bubble | The active surface, output geometry, quiet and motion preferences determine presentation. The approval bubble preserves keyboard focus in the active application. |

## Component rules

Use Adwaita Sans for UI and the system monospace family for code. Metadata, body, conversation, section and page titles form the type hierarchy. Keep reading lines near 70 characters. Use a four-pixel spacing grid, 32 px compact actions and 40 px form controls. Use small corners on nested elements, medium corners on controls and larger corners on dialogs. A flat surface carries a group. Use one brief transition for interactive feedback and respect reduced motion. Make state legible through text and shape as well as color. Keyboard actions use the same visible ring across surfaces.

The fixture produced matching workspace and settings captures and one full-resolution panel per avatar.

[Workspace before](desktop-2026-11/before/workspace-conversation.webp) · [Workspace after](desktop-2026-11/after/workspace-conversation.webp) · [All 24 themes before](desktop-2026-11/before/themes.webp) · [All 24 themes after](desktop-2026-11/after/themes.webp)
