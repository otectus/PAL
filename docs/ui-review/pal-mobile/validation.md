# PAL Mobile UI review validation

## Device and build provenance

- All Android work used the disposable Android 15 / API 35 `x86_64` AVD `emulator-5604` through private ADB server port `5049`. The attached personal Pixel 10 Pro was never selected or modified.
- Baseline source was `322d9817f3e508daf92b676e139a1b428b49d9cf`; app SHA-256 `85111d0ef296ca7e6c068e03b2f91e9fddb9d252a0793885248dcfaac23f1a19`.
- Delivery app is PAL Mobile 2.0.0 / 2000000, SHA-256 `e30baebf4692a9ec64da4f75603fb3cadb277819834e09f105086f792fc9c40b`; delivery test APK SHA-256 `08dc4e983dee8a80ac5e7825eaafc0d41dd305fec583c42c56d68ca236a05604`.
- The final composition gallery was rendered from app `e11fc8091655d64abc4297c10e0e9f147faed9db53dc3d814fa308b907300129`; delivery differs only in localized transfer-integrity and unnamed-phone wording. The unchanged live shell gallery was captured on candidate `0789755e59b560bae9531a0b5cc1e2e0e14e3ae86e6b34d1d284e4929085557e`; the pairing gallery was refreshed on composition-equivalent predecessor `9412b3635eca1256ffa6155983155a93aec1b7405c52d8ef77f0fe3406ddf3a8`.

## Checks actually run

- Baseline builds passed. Baseline standalone instrumentation: 27 discovered, 22 passed, 5 explicit paired-fixture skips, 0 failed. Baseline paired gate: 5/5 checkpoints passed.
- Delivery clean-state `AndroidJUnitRunner`: 33 discovered, 27 passed, 6 explicit fixture-argument skips, 0 failed. It includes exact posture punctuation/scroll visibility, growing-status timeline follow, completion announcement, pairing/IME entry, compatibility, Markdown, and conversation behavior tests.
- Focused release gate on the composition-final APK: `ConversationTimelineRegressionTest`, `CompatibilityScreensTest`, and `PairingSmokeTest`, 12/12 passed.
- Delivery paired network-return gate: both explicit tests passed and all 5 checkpoints were reached. SAS matched; the phone completed pairing, returned the fixture reply, the broker recorded exactly one user row, revision-bound pin/archive restored, and disconnect/reconnect resynchronized.
- Final `DesignStatesTest -e palCapture true`: 1/1 passed and emitted 46 settled screenshots (23 real-composable scenes in both themes).
- Reduced-motion smoke: Android window, transition, and animator scales were set to zero; fresh pairing retained Scan and manual-offer actions, then scales were restored.

## Runtime journeys and gallery inventory

`before/` contains 50 PNGs. `after/` contains:

- `01`–`03`: fresh pairing, manual offer, and real IME with `Verify offer` visible above the keyboard (`mInputShown=true`).
- `13`–`18`: connected Chats, Inbox, Work limited-access fallback, scoped Desktop, Settings, and the real paired transcript.
- `19`–`21`: chat IME plus 200%-font landscape with and without the real IME; the draft survived recreation.
- `25-reduced-motion-pairing.png`: the no-animation-scale pairing smoke.
- `fixture-{light,dark}-*.png`: 46 final scenes covering connection/recovery states, approval, empty/streaming/long history, activity/failure, owner settings, rich Markdown, and link/question/submitting/unconfirmed/offline requests.

Semantic XML and IME dumps are under `build/pal-mobile-review/after/live/`; full runner logs are under `build/pal-mobile-review/after/logs/`; delivery paired evidence is under `build/pal-mobile-review/after/paired-delivery/`.

## Adverse and lifecycle evidence

- On preview app `d9f2acba3cb3d5f3063ae82fc7a4a3ba196f0f793184db60d3749aca8bf8a712`, a real streamed fixture answer was interrupted after the partial row `Hello from Ollama.` appeared. After timeout the app showed Offline while retaining the row. Resuming the broker reconnected in about 3 seconds and reconciled the same row to `Hello from Ollama. Your conversation is ready.` Evidence: `build/pal-mobile-review/polish/{logs/stream-loss-recovery.txt,screens/stream-*.png,stream-*.xml}`.
- A separate actual broker freeze/reconnect retained an unsent draft and returned to Connected in about 3 seconds. `am kill` after backgrounding a draft killed the process; cold launch restored the selected conversation and draft.
- Small-phone (720 x 1280 at 320 dpi), tablet/rail (1600 x 2560 at 320 dpi), `en-XA`, `ar-XB` with forced RTL, 200% font, portrait/landscape recreation, scoped Desktop access, and Android camera-denial fallback were exercised. The small-phone IME retained a usable composer, though little transcript/header content remained visible.
- Headless-emulator `gfxinfo` reported zero rendered frames, so no frame-performance claim is made.

## Scope and limits

- The delivery paired result is real network/TLS/SAS behavior against a disposable broker and synthetic Ollama/project fixture. It does not use owner data, hosted providers, private desktop actions, or a personal desktop profile.
- Approval, request variations, richer Markdown, owner-settings index, monitoring-off, and replacement states are deterministic real-composable fixtures beyond the isolated broker's grant; the broker did not create a real sensitive owner approval.
- No personal phone, physical camera, physical biometrics, TalkBack service, Doze, lock screen, cellular/VPN transition, or hardware cutout was exercised. Camera validation covers Android denial and app fallback, not successful physical capture.
- The long stream-loss reproduction is from the preview build. Final delivery independently passed clean instrumentation and the paired/reconnect gate, but the long interruption was not repeated after the wording-only delivery rebuild.
