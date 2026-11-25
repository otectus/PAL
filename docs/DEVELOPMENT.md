# Developing PAL

## Run from this workspace

```sh
./tools/run.sh
```

Use `./tools/run.sh --show` to open the expanded workspace immediately. The tray opens the workspace, shows or hides the companion, and pauses or resumes AI actions. Its two quit options let you stop sessions or leave them running. Only one interface instance runs per runtime directory.

In Dolphin, right-click the background of a local folder (or one folder) and choose **Start PAL Conversation Here**. The installer adds this menu action; it opens **Start a conversation** with the project folder filled in. Review your provider and settings, then open the conversation. The command-line equivalent is `pal --new-conversation /path/to/folder`.

Build the application first (see the [README](../README.md#install)). Generated binaries, local dependency bundles, user state, and credentials are not included in the repository. If `.local-deps` is present locally, `tools/run.sh` configures its library paths.

## Checks

The full test suite passed on Node 24.22.0 and 26.11.1 on October 20, 2026, and on 26.8.2 (which CI pins in `.node-version`) and 26.13.1 on November 24, 2026.

```sh
tools/test-virtual-desktop.sh npm test
tools/test-virtual-desktop.sh npm run typecheck
tools/test-virtual-desktop.sh npm run build
tools/test-virtual-desktop.sh ctest --test-dir build --output-on-failure
tools/test-virtual-desktop.sh env QT_QPA_PLATFORM=offscreen:configfile=$PWD/tests/fixtures/offscreen-scales.json QT_QUICK_BACKEND=software ./build/pal-ui-check
```

`ctest` runs the geometry registration, motion, avatar (GPU and software), avatar catalog and QML component tests; the QML tests need `QML_XHR_ALLOW_FILE_READ=1`, which CTest sets. The wrapper requires Bubblewrap, Hyprland, a headless-capable Cage exposing xdg-shell version 6, and a GPU render node. Set `PAL_CAGE_BINARY` for a project-local Cage build; the [validation record](../VALIDATION.md) includes the setup used here. It isolates every command from the working desktop and configures locally extracted Qt dependencies when present. Offscreen UI runs use virtual outputs at several scales. Use `tools/test-virtual-desktop.sh ./build/pal-ui-check SLOT` for compositor checks, including layer-shell placement and pointer interactions. The `workbenchAcceptance` slot drives the Workbench end to end: browsing, preview and editing, a reviewed change and its undo, images and the editor, runs, the shelf, the `@` picker, and the compact sheet. Pointer events go to a private Wayland seat, without physical input devices. Services such as Spotify and Satty need fixtures inside that private session; never redirect checks to the working desktop. Captures from `/tmp/pal-ui-evidence` are retained in the wrapper's evidence directory under `tmp/pal-ui-evidence`. After a full catalog run, `env PAL_TEST_AVATAR=witty` before `./build/pal-ui-check` limits avatar loops for focused artwork rechecks; pointer checks also retain their PAL baseline.

After `cmake --build build --target pal pal-screenshots`, `tools/screenshots/run.sh` regenerates the documentation images in [`screenshots/`](../screenshots/README.md) from a scripted demo profile. It renders offscreen inside private user, mount, process, host-name and network namespaces, so it uses no real PAL profile, compositor, provider account or network. Name capture slots, such as `settingsPages`, to retake only those images; `PAL_SCREENSHOTS_DIR` and `PAL_BUILD_DIR` choose the folders, and `PAL_SCREENSHOTS_DEBUG` keeps a picture of a slot that failed. `ANDROID_SERIAL=emulator-5554 tools/screenshots/run.sh --phone` takes the phone images from an Android emulator, which is paired with the same demo profile and whose PAL Mobile data is cleared first. It accepts only an emulator.

After `python3 tools/install-user.py --prefix DIR` (which touches no session), `node tools/check-install.ts DIR [commit]` confirms the staged install has every broker, QML, asset, protocol and shell-hook file, the runtime packages, native modules, speech engine, launchers, service unit and a clean build identity.

`tools/live-check.ts` runs real provider calls in a temporary project, including a named harmless printf script, approval, another turn, and a process disconnect/resume. It consumes normal CLI usage. Run it only with isolated `PAL_STATE_DIR` and `PAL_RUNTIME_DIR` values. `tools/probe-providers.ts` is a smaller no-tool connectivity check.

`node tools/check-ollama.ts MODEL [codex|claude]` exercises real Ollama conversation, recall after disconnect, an approved saved `printf` command, and optional provider delegation. It creates its own isolated broker/project, uses normal provider usage, and prints the evidence directory containing `report.json`, `broker.log`, and the test database. Only the known test command and exact test delegation are approved. Backend tests and native UI checks use local Ollama fixtures with no inference usage.

`node tools/check-knowledge.ts [MODEL]` checks real `nomic-embed-text` recall, restart persistence, public search, and source reading in a temporary project. Supplying a model also tests native search/memory tools and the use of recalled context, with synthetic facts only. `MODEL --memory-only` or `MODEL --web-only` repeats just that model tool check. The script prints its private evidence directory. `build/pal-ui-check searchAndMemory` exercises settings, the embedding check, memory editing, explicit search with a plain chat model, and source links against local fixtures. Production HTML-parser dependencies are bundled with installed PAL.
