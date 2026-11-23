# PAL Mobile refinement

Work started at `322d981` on `design/pal-mobile-refinement`.

| Stage | Progress and decision |
| --- | --- |
| Inventory and audit | Mapped the app from its Gradle modules, Compose routes, capability gates and Android manifest. Captured the original release-equivalent debug UI on an isolated API 35 emulator before the redesign. [Inventory and audit](audit.md) · [Baseline](before/) |
| Shared foundations | Adapted the desktop robot’s pearl and cyan palette for both themes. Kept system typography, Material interaction semantics and the existing dependencies. Constrained reading and form widths independently of the navigation breakpoint. [Design reference](design.md) |
| Reading and composing | Reworked the transcript, Markdown, activity, composer and attachment review. Kept confirmed content and unsent local drafts separate. Preserved stable anchors and made the existing send, stop and uncertain-outcome states explicit. |
| Connection and decisions | Unified connection presentation, made retry contextual, retained pairing and authorization paths, and moved the exact request above its choices. Reworked the settings index, gated work areas and camera overlays. |
| First polish | Compared actual screens and fixture galleries. Adjusted pairing to bring Verify above the keyboard, synchronized status-bar appearance in the theme fixture and strengthened control boundaries. A private broker interruption preserved the partial reply and reconciled it after reconnect. A killed app process restored the selected conversation and draft. |
| Final verification | Built the combined sources, ran lint and JVM checks, reviewed the galleries, and corrected the composer position, timeline announcements and posture label. The final emulator checks exercise the same sources. [Validation record](validation.md) |

## Build and compatibility checks

The final checks used Java 17, the repository Gradle wrapper, the installed Android SDK and the existing offline dependency cache. Run the Gradle commands from `mobile/android/`.

| Verification | Command and outcome |
| --- | --- |
| Automated JVM tests and debug build | `./gradlew --offline :core:protocol:test :core:data:testDebugUnitTest :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest` passed. The XML reports contain 28 protocol, 78 data and 19 app tests, all passing. [Log](../../../build/pal-mobile-review/checks/composer-apk.log) |
| Lint and build variants | `./gradlew --offline :app:lintDebug :app:lintDev :app:lintRelease :core:data:lintDebug :app:assembleDev :app:assembleRelease` checks both distributable variants as well as debug lint. [Log](../../../build/pal-mobile-review/checks/composer-lint-build.log) |
| Desktop interoperability contracts | From the repository root, `PAL_TTS_DISABLED=1 node --import ./tests/fixtures/memory-environment.ts --test tests/mobile-*.test.ts` passed all 12 tests. [Log](../../../build/pal-mobile-review/checks/mobile-contract-tests.log) |
| Code and resource review | `git diff --check` passed. The Android manifest, Gradle configuration, data and wire protocol modules match the baseline. The app keeps the original identity, SDK levels, permissions and signing configuration. |
| Emulator and screenshots | The [runtime record](validation.md) identifies which checks used a live disposable broker, which rendered fixture data and which require physical hardware. |

The galleries use test-only conversations. Automatic desktop discovery, arbitrary remote Markdown image downloads, universal per-message delivery receipts, per-request expiration times and a general classification of destructive requests are absent from the existing mobile contract. Unknown outcomes and scope-specific desktop errors stay visible for reconciliation. Destructive choices with known consequences use explicit review.
