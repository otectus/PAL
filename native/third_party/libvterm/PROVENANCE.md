# libvterm 0.3.3 (vendored)

- Upstream: https://www.leonerd.org.uk/code/libvterm/ (Paul Evans), release tarball `libvterm-0.3.3.tar.gz`
- Tarball SHA-256: `09156f43dd2128bd347cbeebe50d9a571d32c64e0cf18d211197946aff7226e0` (downloaded 2026-11-21)
- License: MIT (`LICENSE`, unchanged)
- Contents: `include/` and `src/` exactly as released (generated `src/encoding/*.inc` and `src/fullwidth.inc` included);
  tests, tools and the Makefile are omitted. No local modifications.
- Used by `native/terminal/pal-terminal.c`, the broker's PTY worker (PAL terminals). PAL renders the screen
  itself; libvterm is only the escape-sequence parser and screen model.
