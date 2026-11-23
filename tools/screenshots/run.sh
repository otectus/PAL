#!/usr/bin/env bash
# Regenerates the documentation screenshots in screenshots/ from a scripted demo profile.
#
#   tools/screenshots/run.sh [slot ...]
#
# Everything runs offscreen inside private user, mount, process and network namespaces. /home is
# replaced by a tmpfs holding /home/demo (projects, applications and shims for hyprctl, wpctl and
# busctl) with your own home bound back in, so paths read like a real desktop while nothing touches
# your PAL profile, compositor, media players, notifications, provider accounts or the network.
# Providers are scripted fixtures; the Ollama fixture answers on the default 127.0.0.1:11434.
# Name capture slots (see tools/screenshots/capture.cpp) to retake only those images.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
build=${PAL_BUILD_DIR:-$root/build}
out=${PAL_SCREENSHOTS_DIR:-$root/screenshots}
if [[ ${1-} != --inside ]]; then
  [[ -x $build/pal-screenshots && -x $build/pal ]] || { echo "Build first: cmake --build build --target pal pal-screenshots" >&2; exit 1; }
  mkdir -p "$out"
  exec unshare --user --map-current-user --mount --pid --fork --mount-proc --net --keep-caps "$0" --inside "$@"
fi
shift
ip link set lo up
user_home=$HOME
real=$(mktemp -d "${TMPDIR:-/tmp}/pal-screenshots.XXXXXX")
mount --rbind /home "$real"
mount -t tmpfs -o mode=755 tmpfs /home
mkdir -p "$user_home"
mount --rbind "$real${user_home#/home}" "$user_home"
umount -l "$real" && rmdir "$real"

demo=/home/demo
fixture=$root/tools/screenshots/fixture.mjs
mkdir -p "$demo"/{.local/bin,.local/share/applications,.local/share/system,.cache,.run} "$demo"/Projects/{aurora-web,lumen,tidepool,dotfiles}
chmod 700 "$demo/.run"
for role in codex claude agy hyprctl busctl wpctl; do printf '#!/bin/sh\nexec node %q %s "$@"\n' "$fixture" "$role" > "$demo/.local/bin/$role"; done
printf '#!/bin/sh\nexec node %q check "$@"\n' "$fixture" > "$demo/.local/bin/demo-check"
for quiet in notify-send gtk-launch xdg-open satty grim; do printf '#!/bin/sh\nexit 0\n' > "$demo/.local/bin/$quiet"; done
chmod +x "$demo"/.local/bin/*
while IFS='|' read -r id name; do
  printf '[Desktop Entry]\nType=Application\nName=%s\nExec=true\n' "$name" > "$demo/.local/share/applications/$id.desktop"
done <<'APPS'
firefox|Firefox
kitty|kitty
spotify|Spotify
org.gnome.Nautilus|Files
code|Visual Studio Code
obsidian|Obsidian
org.gimp.GIMP|GIMP
steam|Steam
APPS
printf '{\n  "name": "aurora-web",\n  "private": true\n}\n' > "$demo/Projects/aurora-web/package.json"

# One environment for every process: nothing inherits the compositor, session bus or provider keys.
common=(HOME="$demo" USER=demo LOGNAME=demo LANG=en_US.UTF-8 TZ="${TZ:-America/New_York}"
  PATH="$demo/.local/bin:/usr/local/bin:/usr/bin" XDG_RUNTIME_DIR="$demo/.run" XDG_CACHE_HOME="$demo/.cache"
  XDG_DATA_HOME="$demo/.local/share" XDG_DATA_DIRS="$demo/.local/share/system" DBUS_SESSION_BUS_ADDRESS="unix:path=$demo/.run/no-bus"
  PAL_STATE_DIR="$demo/.local/state/pal" PAL_RUNTIME_DIR="$demo/.run/pal" PAL_TTS_DISABLED=1
  PAL_CODEX_BIN="$demo/.local/bin/codex" PAL_CLAUDE_BIN="$demo/.local/bin/claude" PAL_ANTIGRAVITY_BIN="$demo/.local/bin/agy")
pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true' EXIT

env -i "${common[@]}" node "$fixture" ollama > "$demo/.run/ollama" &
pids+=($!)
for _ in $(seq 50); do [[ -s $demo/.run/ollama ]] && break; sleep 0.1; done
env -i "${common[@]}" node "$root/tools/screenshots/seed.ts" "$demo" > /dev/null
env -i "${common[@]}" node "$root/broker/main.ts" > "$demo/.run/broker.log" 2>&1 &
pids+=($!)
for _ in $(seq 100); do [[ -S $demo/.run/pal/broker.sock ]] && break; sleep 0.1; done

status=0
env -i "${common[@]}" PAL_SCREENSHOTS_DIR="$out" PAL_HOST_EXEC="$build/pal" \
  QT_QPA_PLATFORM="offscreen:configfile=$root/tools/screenshots/screens.json" QT_QUICK_BACKEND=software QT_QUICK_CONTROLS_STYLE=Basic \
  "$build/pal-screenshots" "$@" || status=$?
[[ $status -eq 0 ]] || { echo "Capture failed ($status). Broker log:" >&2; tail -n 40 "$demo/.run/broker.log" >&2; }
exit $status
