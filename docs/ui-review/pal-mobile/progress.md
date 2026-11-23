# PAL Mobile refinement

Work started at `322d981` on `design/pal-mobile-refinement`.

| Stage | Progress and decision |
| --- | --- |
| Inventory and audit | Mapped the app from its Gradle modules, Compose routes, capability gates and Android manifest. Captured the original release-equivalent debug UI on an isolated API 35 emulator before the redesign. [Inventory and audit](audit.md) · [Gallery](gallery.md) |
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
| Lint and build variants | `./gradlew --offline :app:lintDebug :app:lintDev :app:lintRelease :core:data:lintDebug :app:assembleDev :app:assembleRelease` passed. Debug lint recorded 33 warnings and one hint. Release and dev lint each recorded 10 warnings and one hint. All three reports recorded zero errors. [Log](../../../build/pal-mobile-review/checks/composer-lint-build.log) |
| Desktop interoperability contracts | From the repository root, `PAL_TTS_DISABLED=1 node --import ./tests/fixtures/memory-environment.ts --test tests/mobile-*.test.ts` passed all 12 tests. [Log](../../../build/pal-mobile-review/checks/mobile-contract-tests.log) |
| Code and resource review | `git diff --check` passed. The Android manifest, Gradle configuration, data and wire protocol modules match the baseline. The app keeps the original identity, SDK levels, permissions and signing configuration. |
| Emulator and screenshots | The [runtime record](validation.md) identifies which checks used a live disposable broker, which rendered fixture data and which require physical hardware. |

The galleries use test-only conversations. Automatic desktop discovery, arbitrary remote Markdown image downloads, universal per-message delivery receipts, per-request expiration times and a general classification of destructive requests are absent from the existing mobile contract. Unknown outcomes and scope-specific desktop errors stay visible for reconciliation. Destructive choices with known consequences use explicit review.

## Accessibility evidence and limits

- The JVM test checks body, accent and error text on each reading surface, matching ink on filled controls and both enabled control outlines. The lowest sampled text ratios were 4.94:1 in light and 6.41:1 in dark. The lowest enabled outline ratios were 3.16:1 and 3.33:1, respectively. [Contrast measurements](../../../build/pal-mobile-review/checks/contrast.txt)
- The saved accessibility hierarchies for eleven actual emulator views contained 61 enabled click actions. Each exposed a label, either directly or through its descendants, and visible bounds of at least 48 × 48 dp at 420 dpi. This sample covers pairing, chat, the streaming Stop control, navigation, settings and camera denial. [Touch bounds](../../../build/pal-mobile-review/checks/touch-bounds.txt)
- Inline Markdown links share the text line’s hit area. Android and Material control the dimming of disabled actions. These two cases sit outside the enabled-control size and contrast measurements. Desktop-provided content, including ANSI terminal colors and diagnostic messages, retains its original colors or language.
- Keyboard and rotation were exercised on the emulator. At 200% text in landscape, the IME leaves little room for the transcript. The composer takes priority. Actual TalkBack speech, hardware cutouts, physical camera and biometric confirmation still need device validation.

The packaged baseline and delivery debug APKs also match on application ID, version, SDK levels, declared permissions, hardware features, supported screen flags and signing certificate SHA-256. [Package comparison](../../../build/pal-mobile-review/checks/package-comparison.txt)
