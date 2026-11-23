# PAL Mobile refinement

Work started at `322d981` on `design/pal-mobile-refinement`.

| Stage | Progress and decision |
| --- | --- |
| Inventory and audit | Mapped the app from its Gradle modules, Compose routes, capability gates and Android manifest. Captured the original release-equivalent debug UI on an isolated API 35 emulator before the redesign. [Inventory and audit](audit.md) · [Baseline](before/) |
| Shared foundations | Adapted the desktop robot’s pearl and cyan palette for both themes. Kept system typography, Material interaction semantics and the existing dependencies. Constrained reading and form widths independently of the navigation breakpoint. [Design reference](design.md) |
| Reading and composing | Reworked the transcript, Markdown, activity, composer and attachment review. Kept confirmed content and unsent local drafts separate. Preserved stable anchors and made the existing send, stop and uncertain-outcome states explicit. |
| Connection and decisions | Unified connection presentation, made retry contextual, retained pairing and authorization paths, and moved the exact request above its choices. Reworked the settings index, gated work areas and camera overlays. |
| First polish | Compared actual screens and fixture galleries. Adjusted pairing to bring Verify above the keyboard, synchronized status-bar appearance in the theme fixture and strengthened control boundaries. A private broker interruption preserved the partial reply and reconciled it after reconnect. A killed app process restored the selected conversation and draft. |
| Final verification | Rebuild from the combined sources, rerun Android lint, unit and instrumentation checks, review comparable captures and record hardware-only limits. [Validation record](validation.md) |
