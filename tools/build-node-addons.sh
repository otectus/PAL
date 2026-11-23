#!/usr/bin/env bash
# Builds only the native pieces the broker tests load (the two Node-API modules for same-user peer
# credentials and the telemetry watcher, and the terminal worker) into build/, without Qt or CMake.
# The full desktop build produces the same files.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
node_root=$(dirname -- "$(dirname -- "$(command -v node)")")
headers=
for candidate in "$node_root/include/node" /usr/include/node; do
  [[ -f $candidate/node_api.h ]] && { headers=$candidate; break; }
done
[[ -n $headers ]] || { echo "Node-API headers not found next to $(command -v node) or in /usr/include/node" >&2; exit 1; }
mkdir -p build
for addon in peercred telemetry; do
  "${CXX:-g++}" -std=c++20 -O2 -shared -fPIC -I"$headers" "native/$addon.cpp" -o "build/pal-$addon.node"
done
# The shell integration tests send telemetry through the installed native reporter.
"${CXX:-g++}" -std=c++20 -O2 native/report.cpp -o build/pal-report
# The terminal worker the terminal tests start (C only, with the vendored libvterm).
"${CC:-cc}" -std=c11 -O2 -Inative/third_party/libvterm/include -Inative/third_party/libvterm/src native/terminal/pal-terminal.c native/third_party/libvterm/src/*.c -lutil -o build/pal-terminal
echo "Built build/pal-peercred.node, build/pal-telemetry.node, build/pal-report (against $headers) and build/pal-terminal"
