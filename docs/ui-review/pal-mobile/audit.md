# PAL Mobile inventory and design brief

## Scope

At revision `322d981`, the app is a Kotlin single-activity Android client. Compose Material 3 renders the shell, CommonMark with GFM tables renders messages, CameraX and ZXing read offers, and a pinned connection supplies desktop state. Gradle sets minimum API 30 and target/compile API 37. The manifest permits resizing, free rotation, RTL, optional cameras and sharing multiple images. The shell has bottom navigation on phones, a rail in landscape and wide windows, and a labelled selector at large type. Both system light and dark appearance are implemented.

Source names below refer to `mobile/android/app/src/main/kotlin/dev/otectus/pal/mobile/`. Protocol types live in `:core:protocol`, with pairing, cache, capability checks and reconnection in `:core:data`.

| Entry or journey | Scope and states | Source |
| --- | --- | --- |
| First launch and recovery | Restore encrypted cache, retry while locked, confirm before discarding unreadable data. Scan a signed offer or paste it, give the phone a name, compare six words and confirm on the desktop. Network and manual return, permission refusal, replacement and repair are real paths. Automatic desktop discovery is absent. | MainActivity.kt, ScannerScreen.kt, QrCode.kt |
| Conversation library | Filter current/archived conversations, search local and remote history, load older results, import, hand off, create and select a conversation. Project, provider, model and effort choices depend on desktop grants. | MainActivity.kt, LibraryUi.kt, ParitySheets.kt, ConversationSettingsSheet.kt |
| Reading and replying | Session hydration, streaming, activity, queue/stop according to provider and role, pins, sources, per-session scroll anchors and draft. Gallery, camera and Android image share, local upload and desktop attachment previews. Push-to-talk transcription and spoken replies are capability-gated. Inline rich text supports safe links. Arbitrary inline remote image fetching is absent. | MainActivity.kt, ConversationContent.kt, MarkdownContent.kt, StatusPortrait.kt, Voice.kt |
| Requests | Notification or conversation opens Inbox. Review source session, agent, exact detail or verified image, questions and form fields. The desktop advertises choices and determines whether a positive answer is allowed. No per-request expiry timestamp or generic destructive-action classifier is present. | MainActivity.kt, SensitiveUi.kt, ActionAuth.kt, Notifications.kt |
| Desktop | Choose a project, inspect the workspace, use granted media, timers, apps, windows, files and saved scripts. Owner desktop viewing, screenshots and annotation have separate controls. | DesktopControls.kt, ViewDesktop.kt, Annotate.kt |
| Work | Files, Changes, Library, Runs, Research, Canvas, Notes and Terminal belong to the selected conversation/project. Access and version gates, loading, empty results, conflicts and errors vary by operation. | WorkbenchScreen.kt, TerminalScreen.kt |
| Settings and maintenance | Connection diagnostics and unknown action outcomes, local appearance and alerts, background service, assistant and memory, access reduction, pairing and app checks. Owner settings include devices, profiles, credentials, budgets, models, extensions and maintenance. | MainActivity.kt, LibraryUi.kt, OwnerSettings.kt, ParitySheets.kt, MonitoringService.kt |
| Android lifecycle | The existing store holds drafts, attachments, selected conversation, reading anchor and confirmed desktop data. Saveable Compose state carries navigation and filters. A socket reconnect reconciles desktop state. Android controls the camera, biometrics, picker, keyboard, notification permission and process lifetime. | MainActivity.kt, Navigation.kt, PALRepository.kt, SecureStore.kt |

## Audit

| Severity | Component and source | Effect |
| --- | --- | --- |
| Slows or confuses | ChatScreen and ConversationComposer | Busy-state actions are scattered across the header and composer. The bordered editor and elevated dock compete with the latest reply. Activity and secondary message actions need a consistent reading order. |
| Slows or confuses | ConversationTimeline and MarkdownContent | Reading position depends on list edges and content growth. Independently wrapping table cells and repeated message controls reduce usable width on a narrow phone. |
| Slows or confuses | DesktopControls and LibraryUi | Loss of advertised operations offline looks like a permissions refusal. The header, settings and work surfaces offer different explanations for the same connection. |
| Slows or confuses | ApprovalCard and InboxScreen | Source, exact request and decision are available, but request detail follows a full-width hide button. A pending submission reads the same as an uncertain one. A returning user cannot tell what happens when a request ends elsewhere. |
| Slows or confuses | WorkScreen | Session setup and model access take space above every work tab, even when the user is reading a file in landscape. The offline notice tells the user to reconnect without offering a retry. |
| Slows or confuses | ScannerScreen and AnnotateImage | A white back arrow floats directly over the camera feed. Small annotation swatches and one-line toolbars crowd Undo at large type. |
| Cosmetic | PairingScreen, LibraryConversation, SettingsIndex, Panel | Repeated outlined cards, large tinted panels and borders make passive metadata compete with primary actions. Settings reads like a set of equally urgent buttons. |
| Slows or confuses | Mobile presentation layer | Screen-local measurements and English literals are spread across owner and conversation surfaces. This makes large-text and translation fixes inconsistent. |

## Design direction

The desktop puts the character beside a bounded reading column, uses a cool accent for selection and keeps tools close to their originating conversation. See `qml/Chat.qml`, `qml/MessageCard.qml` and `docs/ui-review/desktop-design.md`. Carry that calm, precise, companionable character to Android with PAL's own portrait and cool ink, a restrained blue accent, quiet section surfaces and amber for decisions. Give titles, readable prose and exact technical content different typographic jobs. Keep the action that resolves an interruption beside its explanation. Use system text scaling and press feedback throughout.

## Evidence and subsequent polish

The original capture includes the actual paired shell, keyboard and Android permission journeys. The test gallery adds deterministic views of conditions that cannot safely be forced on an owner desktop. In the transcript, the dock border and secondary controls draw attention below a short reply. In Settings, the repeated cards make connection details and local preferences look equally urgent. In the original request card, a full-width disclosure sits between the request and its exact target. Compare the [original transcript](before/18-chat-online.png), [settings index](before/17-settings-online.png) and [request](before/fixture-light-approval.png).

The first redesigned pairing capture exposed a separate layout problem. The keyboard covered Verify on the regular portrait phone. The form now requests visibility for the field and its action together. The first redesigned theme fixtures also exposed a status-bar mismatch between the simulated theme and the emulator’s window. The fixture now sets the bar appearance alongside the content theme.
