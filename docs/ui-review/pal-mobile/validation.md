# PAL Mobile UI review validation

## Device and build provenance

- All Android work used the disposable Android 15 / API 35 `x86_64` AVD `emulator-5604` through private ADB server port `5049`. The attached personal Pixel 10 Pro was never selected or modified.
- Baseline source was `322d9817f3e508daf92b676e139a1b428b49d9cf`; app SHA-256 `85111d0ef296ca7e6c068e03b2f91e9fddb9d252a0793885248dcfaac23f1a19`.
- Final delivery app is PAL Mobile 2.0.0 / 2000000, SHA-256 `bfb21203396f479b5575542e972875b24d0f4f99eabd90adf6eec260cf15625c`; final test APK SHA-256 `2110b3e5ad62b38620936b6c6cd062dfa5d26c09aecaa8a36b45618b4f9463f7`. Final capture and validation date: 2026-11-23.
- Pairing, offline, transcript/composer, large-text, scoped-access, camera, supplemental, and all 46 fixture captures were refreshed on the final delivery APK. Unchanged online shell captures `13`–`17` remain from candidate `0789755e59b560bae9531a0b5cc1e2e0e14e3ae86e6b34d1d284e4929085557e`; their final-build destinations were also traversed semantically during the later paired runs.

## Checks actually run

- Baseline builds passed. Baseline standalone instrumentation: 27 discovered, 22 passed, 5 explicit paired-fixture skips, 0 failed. Baseline paired gate: 5/5 checkpoints passed.
- Final clean-state `AndroidJUnitRunner`: 34 discovered, 28 passed, 6 explicit fixture-argument skips, 0 failed. It includes exact posture punctuation/scroll visibility, growing-status timeline follow, completion announcement, pairing/IME entry, compatibility, Markdown, and conversation behavior tests.
- Final focused release gate: `ConversationTimelineRegressionTest`, `CompatibilityScreensTest`, and `PairingSmokeTest`, 13/13 passed, including the single-target Send/Stop position and non-repeatable pending Stop assertion.
- Delivery paired network-return gate: both explicit tests passed and all 5 checkpoints were reached. SAS matched; the phone completed pairing, returned the fixture reply, the broker recorded exactly one user row, revision-bound pin/archive restored, and disconnect/reconnect resynchronized.
- Final `DesignStatesTest -e palCapture true`: 1/1 passed and emitted 46 settled screenshots (23 real-composable scenes in both themes).
- Reduced-motion smoke: Android window, transition, and animator scales were set to zero; fresh pairing retained Scan and manual-offer actions, then scales were restored.

## Runtime journeys and gallery inventory

`before/` contains 50 PNGs. `after/` contains 75 PNGs, and every baseline filename has a direct after counterpart:

- `01`–`03`: fresh pairing, manual offer, and real IME with `Verify offer` visible above the keyboard (`mInputShown=true`).
- `04`–`05`: 200%-font pairing in portrait and landscape. `07`, `09`–`12`: cached transcript and the four shell tabs after the real broker reached Offline at 56 seconds; reopening the chat initiated a visible Reconnecting transition.
- `13`–`18`: connected Chats, Inbox, Work limited-access fallback, scoped Desktop, Settings, and the real paired transcript.
- `19`–`21`: chat IME plus 200%-font landscape with and without the real IME; the draft survived recreation.
- `22`–`24`: invalid offer, the online Settings → Desktop access grant list, and real chat-attachment camera denial with the draft preserved.
- `25-reduced-motion-pairing.png`: the no-animation-scale pairing smoke.
- `26`–`27`: a real partial streamed row with the trailing Stop target and the settled interrupted result.
- `fixture-{light,dark}-*.png`: 46 final scenes covering connection/recovery states, approval, empty/streaming/long history, activity/failure, owner settings, rich Markdown, and link/question/submitting/unconfirmed/offline requests.
- `supplemental-*`: online New conversation, conversation settings/model sheet, Settings connection diagnostics, and the separate pairing-scanner camera-denial fallback.

Semantic XML and IME dumps are under `build/pal-mobile-review/after/live/`; full runner logs are under `build/pal-mobile-review/after/logs/`. Final paired summaries are under `build/pal-mobile-review/after/{final-chat-live,supplemental-live}/`; the attachment-denial run used an otherwise identical disposable grant plus `attachments.write` under `camera-attachment-live/`.

## Adverse and lifecycle evidence

- On preview app `d9f2acba3cb3d5f3063ae82fc7a4a3ba196f0f793184db60d3749aca8bf8a712`, a real streamed fixture answer was interrupted after the partial row `Hello from Ollama.` appeared. After timeout the app showed Offline while retaining the row. Resuming the broker reconnected in about 3 seconds and reconciled the same row to `Hello from Ollama. Your conversation is ready.` Evidence: `build/pal-mobile-review/polish/{logs/stream-loss-recovery.txt,screens/stream-*.png,stream-*.xml}`.
- A separate actual broker freeze/reconnect retained an unsent draft and returned to Connected in about 3 seconds. `am kill` after backgrounding a draft killed the process; cold launch restored the selected conversation and draft.
- On final delivery, `queue-validation-hold` exposed the partial `Hello from Ollama.` row and the same fixed trailing target changed from Send to the accessible `Stop response`. Tapping it settled the session to `Interrupted` / `Response interrupted`; a second tap produced no repeated stop action. Evidence: `26-streaming-stop-light.png`, `27-stream-stopped-light.png`, and `build/pal-mobile-review/after/live/stop-result.xml`.
- Small-phone (720 x 1280 at 320 dpi), tablet/rail (1600 x 2560 at 320 dpi), `en-XA`, `ar-XB` with forced RTL, 200% font, portrait/landscape recreation, scoped Desktop access, and Android camera-denial fallback were exercised. The small-phone IME retained a usable composer, though little transcript/header content remained visible.
- `gfxinfo` reported zero frames, but SurfaceFlinger exposed 126 presentation intervals after a live transcript scroll: 16.665 ms mean, 35.081 ms max, 14 over 20 ms, and 2 over 33.34 ms at a 16.666666 ms refresh interval. This is a narrow headless-emulator sample, not a physical-device frame-rate claim. Raw timestamps: `build/pal-mobile-review/after/logs/surfaceflinger-latency-full.txt`.

## Scope and limits

- The delivery paired result is real network/TLS/SAS behavior against a disposable broker and synthetic Ollama/project fixture. It does not use owner data, hosted providers, private desktop actions, or a personal desktop profile.
- Approval, request variations, richer Markdown, owner-settings index, monitoring-off, and replacement states are deterministic real-composable fixtures beyond the isolated broker's grant; the broker did not create a real sensitive owner approval.
- No personal phone, physical camera, physical biometrics, TalkBack service, Doze, lock screen, cellular/VPN transition, or hardware cutout was exercised. Camera validation covers Android denial and app fallback, not successful physical capture.
- The full mid-stream network loss and restoration run used the preview build. The final APK separately passed the live paired reconnect check and the mid-stream Stop check.
