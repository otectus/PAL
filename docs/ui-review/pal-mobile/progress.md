# PAL Mobile refinement

Branch `design/pal-mobile-refinement` starts at `322d981`. The artwork, Android identity, negotiated operations, encrypted store and signed-action paths are compatibility constraints.

| Stage | Decision or remaining work |
| --- | --- |
| Inventory | Map the complete Compose shell and gated destinations against the Kotlin models. See the audit. |
| Baseline | Capture the original APK on an isolated emulator with test data. Keep device setup and any account data on the attached personal phone untouched. |
| Foundations | Use the PAL palette and existing artwork, system text scaling, measured reading widths and Material interaction semantics. Consolidate metrics and localize app-authored UI. |
| Core journeys | Prioritize reading and composing, honest offline recovery, then exact-request review. Keep actions gated by the desktop. |
| Verification | Build APKs, run lint, unit and instrumentation tests, compare matched captures, exercise interruptions and document gaps. |
