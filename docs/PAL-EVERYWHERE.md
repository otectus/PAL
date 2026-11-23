# PAL Everywhere: decisions, inventory and evidence

This records the architecture decisions, the restriction inventory and the verification map for the PAL Everywhere expansion (`PAL_Everywhere_Feature_Expansion_and_Mobile_Parity_Handoff.md`). It is unreleased work on the `ui-overhaul` branch over `dd82dae` (desktop 0.1.6); the code is the authority where this file and the source disagree. User-facing behavior is described in [WORKBENCH.md](WORKBENCH.md), [mobile/SETUP.md](mobile/SETUP.md#phones-with-full-access), [mobile/SECURITY.md](mobile/SECURITY.md#device-roles-pal-everywhere), [mobile/PROTOCOL.md](mobile/PROTOCOL.md#device-roles-and-owner-parity-pal-everywhere-11-additions) and the rows added to [FEATURE-MATRIX.md](FEATURE-MATRIX.md).

## Decisions

1. **Authority is a device role, decided on the desktop.** `broker/authority.ts` defines observer, limited and owner roles and working profiles. Gates that used to ask "is this session remote?" now ask whether a *limited* phone controls it (`limitedControlled`) or whether its controller has the desktop's authority (`ownerControlled`). An owner phone's conversation keeps its Workbench families and the desktop launch policy (`effectivePolicy: 'desktop'`); a limited phone's provenance stays sticky as before.
2. **Owner authority is per connection.** A device stored as owner acts as one only after its client declares `owner.policy.v1` (`client.features`); `RemoteStore.effectiveRole` uses the connection's role. Older apps keep limited semantics and the Workbench takeover path. Trusted signing and role are independent.
3. **Migration narrows, never widens.** Remote store schema 2 marks every existing device `role: 'limited'` with unchanged grants and expiry (audited as `schema.roles`); a newer schema is refused. Owner lifetime is `until-revoked`. Promotion keeps keys, signing mode and project IDs; demotion gives a 90-day expiry and returns the phone's conversations to the desktop.
4. **Owner operations are typed, not forwarded.** `broker/remote/owner-schemas.ts` declares each operation's schema, feature and kind (read, mutation, signed, stream); `broker/remote/owner.ts` maps it to a named desktop service with session-scope checks. The gateway enforces descriptors before dispatch; there is no generic RPC.
5. **Working profiles resolve approvals, not tool availability.** *Use my desktop choices*, *Review changes* and *Work automatically* decide CLI and computer approvals; a turn uses the narrower of its starting profile and the current one (`ownerSettings`).
6. **The terminal is a broker-owned PTY with its own emulator.** A small C worker (`native/terminal/pal-terminal.c`) runs `forkpty` and vendored libvterm 0.3.3 (MIT, `native/third_party/libvterm/PROVENANCE.md`), speaking JSON lines. The broker (`broker/terminal/service.ts`) owns sessions, one controller lease with epochs, sequenced input without replay, snapshots and bounded scrollback. A native addon (node-pty) was not added: the worker keeps PTY handling out of the broker process and needs no Node ABI rebuilds.
7. **Host execution is a separate, explicit family.** `host` runs commands as the desktop account only when the conversation selected it; approvals use the CLI approval kind, so working profiles and power sessions apply (`hostCommand` in `broker/execution/codelab.ts`, tool `host_run`). Isolated Code Lab runs never fall back to the host.
8. **Bytes move as verified transfers.** `broker/remote/transfers.ts` uses binary frames (UUID, offset, data); uploads commit by size and SHA-256 into one artifact version.
9. **New capabilities extend existing services.** Usage ledger (`usage_records`), skills (content-addressed versions, one review), research runs (evidence ledger), Canvas (headless Chrome over CDP with loopback isolation), Scratchpad/Daybook (indexes, not memory), setups (preview of real changes), specialists (helpers as child operations), translation (helper model, linked artifacts), table previews, collection snapshots, routines with folder triggers. Ollama and API users get them without Codex or Claude.
10. **Connections follow the MCP authorization specification through the pinned SDK** (`@modelcontextprotocol/sdk` 1.32.2): discovery, dynamic registration, PKCE S256, resource indicators, refresh. Tokens are desktop-only and origin-bound. Phones use a private-use redirect bound to their flow.
11. **External effects are reconciled, not replayed.** Non-read-only, non-idempotent tool calls are recorded; a lost answer blocks an identical request until a person resolves it.
12. **Voice is push-to-talk plus read-aloud.** The desktop's whisper.cpp transcribes phone notes (audio deleted afterwards); the phone speaks replies with Android's engine, so audio plays only where the person listens.

## Deviations and work not built

These handoff items are **not implemented**; they are not counted as delivered:

- Native realtime voice adapters and voice activity detection (§16.1); a live camera or screen frame stream and "ask about this region" (§16.2); time-coded media playback with transcript selection on the phone (§16.3).
- OAuth device flow; native GitHub, calendar, email and drive adapters (§14.2). Those services are reachable through MCP servers with the new sign-in, but no integration was tested against a real account.
- Hybrid lexical/semantic retrieval changes and their evaluation corpus (§11.2); the richer Context explanation and pinned references (§11.3).
- The P2 browser workspace (§13.2); persistent analysis kernels, PDF/DOCX export and phone-painted masks (§15); contact sheets and batch variants from the phone.
- An AntiGravity session on an owner phone is allowed by schema and router but was not exercised against a live `agy`.
- No physical Android device, GrapheneOS, network-change or audio evidence was produced; the APK is a build artifact only.

## Restriction inventory

Every former `session.remote` restriction now names which role it applies to. Files using `ownerControlled`/`limitedControlled` (count of uses): `broker/core.ts` (12), `broker/power.ts` (6), `broker/remote/router.ts` (4), `broker/workbench.ts` (3), `broker/orchestration.ts` (3), and 2 each in `broker/workspace/roots.ts`, `broker/workflows.ts`, `broker/tools/contracts.ts`, `broker/send-queue.ts`, `broker/schedules.ts`, `broker/media/service.ts`, `broker/extensions.ts`, `broker/branching.ts`. Remaining direct `session.remote` checks are provenance, ownership, speech suppression for phone turns, and grant checks (`providers.execute`, `memory.write`), which owner devices hold.

| Restriction (before) | Now | Test |
| --- | --- | --- |
| Workbench families off for any phone-controlled conversation | off for limited phones; kept for owner connections | `owner-parity.test.ts` PAR-01, `mobile-compatibility.test.ts` |
| Restricted Codex/Claude launch for phone turns | limited only; owners launch with the desktop policy | `owner-parity.test.ts` PAR-04/PAR-05 |
| Power sessions refused for phone conversations | owner phones start them; children inherit the parent snapshot | `owner-parity.test.ts` PAR-06 |
| Desktop takeover needed to continue a Workbench conversation | owner clients continue directly; older clients keep takeover | `owner-parity.test.ts` SYN-03 |
| Phone cannot edit files, run code, open terminals, manage settings | owner operations through typed services | `owner-parity.test.ts`, `host-commands.test.ts`, feature tests below |
| Schedules paused when a phone controls the conversation | paused only for limited phones | `workbench-recipes.test.ts` M7, `routines.test.ts` |

## Verification map

| Area | Tests |
| --- | --- |
| Roles, migration, negotiation, profiles, power, revocation, observer, file edits, transfers, terminal | `tests/owner-parity.test.ts` |
| Host commands, usage ledger, skills, research, Canvas, notebook, View desktop | `tests/host-commands.test.ts`, `tests/usage-ledger.test.ts`, `tests/skills.test.ts`, `tests/research.test.ts`, `tests/canvas.test.ts`, `tests/notebook.test.ts`, `tests/remote-view.test.ts` |
| Routines, connections, setups, specialists, voice, translation, collection sources, tables | `tests/routines.test.ts`, `tests/mcp-connections.test.ts`, `tests/setups.test.ts`, `tests/specialists.test.ts`, `tests/voice-notes.test.ts`, `tests/translation.test.ts`, `tests/knowledge-sources.test.ts`, `tests/table-preview.test.ts` |
| Protocol contract and operation index | `tools/mobile-contract.ts --check`, `tests/mobile-conformance.test.ts`, `tests/feature-matrix.test.ts` |
| Android terminal client | `mobile/android/core/data/src/test/kotlin/dev/otectus/pal/mobile/data/TerminalClientTest.kt` |
