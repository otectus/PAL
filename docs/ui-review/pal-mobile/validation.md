# PAL Mobile UI review validation

This record separates the saved pre-change Android build from the post-change build. The `before/` gallery is complete; `after/` will be populated and this record finalized after the implementation owner hands off the changed source.

## Isolated device

- Android 15 / API 35 `x86_64` disposable AVD, serial `emulator-5604`.
- Private ADB server port `5049`; all installs, package clears, rotations, font-scale changes, permission changes, and captures explicitly selected `emulator-5604`.
- The attached personal Pixel 10 Pro was never selected or modified.
- Display: 1080 x 2400 portrait and 2400 x 1080 landscape. The large-text checks used Android `font_scale=2.0`.

## Before build

- Source: `322d9817f3e508daf92b676e139a1b428b49d9cf` with no tracked Android production changes.
- App: PAL Mobile 2.0.0 / 2000000, SHA-256 `85111d0ef296ca7e6c068e03b2f91e9fddb9d252a0793885248dcfaac23f1a19`.
- Original instrumentation APK: SHA-256 `d101b11bd20801211d7a77d1a238f91b796bf254215465eaca6e95f698c7fe5a`.
- The APKs were copied to `build/pal-mobile-review/before/` before any production UI edit and were reinstalled for the baseline fixture run.

## Before checks actually run

- `:app:assembleDebug :app:assembleDebugAndroidTest`: passed.
- Standalone `AndroidJUnitRunner`: 27 discovered, 22 passed and 5 fixture-argument-only tests skipped by assumption, 0 failed. This covered pairing entry, conversation/activity separation, streaming updates, Latest behavior, composer IME send, multiline drafts, compatibility payloads, links/sources, research navigation, and companion header.
- `node tools/mobile-paired-check.ts --serial emulator-5604 --pairing network --keep-pairing`: passed both explicit tests and all 5 checkpoints. The phone returned its answer, six words matched, pinned TLS connected, one user send produced one fixture Ollama reply, revision-bound pin/archive restored, disconnect/reconnect resynchronized, and the broker recorded exactly one user row.
- `DesignStatesTest -e palCapture true`: passed 1/1 after semantic scene checks and compositor settling. It rendered 28 real-composable fixtures in light and dark themes: connecting, reconnecting, signing in, disconnected, unreachable, repair, locked, unreadable cache, approval, empty, streaming, long history, activity, and failed activity.
- Real UI journeys: fresh pairing, manual offer, invalid offer error, connected and offline chats, Inbox, Work limited-access fallback, Desktop, Settings, scoped Desktop access, chat transcript, Android camera denial, and the in-app camera fallback.
- IME visibility was verified from `dumpsys input_method` (`mInputShown=true`) for pairing, chat, and 200% landscape chat captures. Draft text remained in the composer across the 200%/landscape recreation.

## Before gallery

The curated images are under `before/`:

- `01`–`05`: pairing portrait/manual/IME/200%-text/landscape.
- `07`, `09`–`12`: offline cached transcript and the four reachable shell destinations.
- `13`–`18`: connected Chats, Inbox, Work, Desktop, Settings, and transcript from an isolated live broker.
- `19`–`21`: chat IME, 200%-text landscape, and 200%-text landscape with the IME visibly open.
- `22`–`24`: invalid-offer error, connected scoped Desktop access, and real camera-permission denial fallback.
- `fixture-{light,dark}-*.png`: deterministic real-composable state coverage listed above.

## Limits

- No personal phone, owner profile, owner broker state, physical camera, physical biometrics, TalkBack service, Doze, lock screen, cellular/VPN transition, or hardware cutout was exercised.
- The paired fixture broker offered synthetic Ollama and scoped fixture projects only. It did not exercise hosted providers, real desktop actions, or private desktop data.
- The streaming screenshot is a deterministic real-composable fixture. The paired broker journey validated a streamed fixture reply end to end, but its short reply completed too quickly for a stable shell screenshot.
- The approval screenshot is a deterministic real-composable fixture. The baseline isolated broker did not create a real sensitive owner approval.
- Post-change checks and comparisons remain pending.

## Evidence outside the committed gallery

Machine-readable summaries, semantic XML, IME dumps, APK copies/hashes, and full logs are under `build/pal-mobile-review/before/`. The authoritative paired summary is `build/pal-mobile-review/before/paired-live2/summary.json`; the standalone and design-state outputs are `build/pal-mobile-review/before/logs/instrumentation.txt` and `build/pal-mobile-review/before/logs/design-states-instrumentation-rerun.txt`.
